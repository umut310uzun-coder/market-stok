-- =====================================================================
--  MARKET STOK & SATIŞ  —  Supabase veritabanı şeması
--  Supabase > SQL Editor > New query  içine yapıştırıp RUN deyin.
--  Tek seferde çalışır. Tekrar çalıştırmak gerekirse önce tabloları silin.
-- =====================================================================

create extension if not exists pg_net with schema extensions;

-- ---------- KULLANICILAR (admin = patron/ana telefon/PC, staff = eleman)
create table if not exists public.profiles (
  id          uuid primary key references auth.users on delete cascade,
  full_name   text,
  role        text not null default 'staff' check (role in ('admin','staff')),
  active      boolean not null default true,
  created_at  timestamptz not null default now()
);

-- ---------- ÜRÜNLER
create table if not exists public.products (
  id              bigint generated always as identity primary key,
  barcode         text unique not null,
  name            text not null,
  brand           text,
  category        text,
  unit            text not null default 'adet',
  price           numeric(12,2) not null default 0,     -- satış fiyatı (KDV dahil)
  cost            numeric(12,4),                        -- son alış maliyeti (KDV dahil)
  stock           numeric(12,3) not null default 0,
  min_stock       numeric(12,3) not null default 5,     -- bunun altına düşünce uyarı
  image_url       text,
  is_own_barcode  boolean not null default false,       -- barkodu biz mi ürettik
  active          boolean not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index if not exists products_name_idx on public.products (lower(name));

-- ---------- TEDARİKÇİ KODU EŞLEŞTİRME (faturadaki kod -> bizim ürün)
create table if not exists public.supplier_codes (
  supplier_vkn   text not null,
  supplier_code  text not null,
  product_id     bigint not null references public.products on delete cascade,
  multiplier     numeric(12,3) not null default 1,      -- 1 koli = kaç adet
  primary key (supplier_vkn, supplier_code)
);

-- ---------- FATURALAR (e-fatura ile gelen alışlar)
create table if not exists public.invoices (
  id             bigint generated always as identity primary key,
  uuid           text unique,
  invoice_no     text,
  supplier_vkn   text,
  supplier_name  text,
  invoice_date   date,
  total          numeric(14,2),
  created_by     uuid default auth.uid(),
  created_at     timestamptz not null default now()
);

-- ---------- SATIŞLAR
create table if not exists public.sales (
  id          bigint generated always as identity primary key,
  created_at  timestamptz not null default now(),
  user_id     uuid default auth.uid() references auth.users,
  total       numeric(12,2) not null default 0,
  item_count  int not null default 0,
  payment     text not null default 'nakit',
  cancelled   boolean not null default false
);
create index if not exists sales_created_idx on public.sales (created_at desc);

create table if not exists public.sale_items (
  id          bigint generated always as identity primary key,
  sale_id     bigint not null references public.sales on delete cascade,
  product_id  bigint not null references public.products,
  qty         numeric(12,3) not null,
  unit_price  numeric(12,2) not null,
  line_total  numeric(12,2) not null
);
create index if not exists sale_items_sale_idx on public.sale_items (sale_id);

-- ---------- STOK HAREKETLERİ (her giriş/çıkışın kaydı)
create table if not exists public.stock_movements (
  id          bigint generated always as identity primary key,
  created_at  timestamptz not null default now(),
  product_id  bigint not null references public.products on delete cascade,
  change      numeric(12,3) not null,
  type        text not null check (type in ('satis','fatura','sayim','iptal','toplu')),
  ref_id      bigint,
  note        text,
  user_id     uuid default auth.uid()
);
create index if not exists stock_mov_product_idx on public.stock_movements (product_id, created_at desc);

-- ---------- AYARLAR (n8n webhook adresi vb.)
create table if not exists public.app_settings (
  key    text primary key,
  value  text
);

create sequence if not exists public.own_barcode_seq start 1;

-- =====================================================================
--  YARDIMCI FONKSİYONLAR
-- =====================================================================
create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles where id = auth.uid() and role = 'admin' and active);
$$;

create or replace function public.is_member() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles where id = auth.uid() and active);
$$;

-- Yeni kullanıcı açılınca profil oluştur. İLK kullanıcı otomatik admin olur.
-- Dışarıdan kayıt (signup) KAPALI: kullanıcı sadece uygulamanın içinden açılabilir.
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if coalesce(current_setting('market.allow_signup', true), '') <> '1' then
    raise exception 'Kayıt kapalı. Kullanıcıyı uygulamadaki Ayarlar ekranından yönetici açar.';
  end if;
  insert into public.profiles (id, full_name, role)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'full_name', split_part(new.email, '@', 1)),
    case when exists (select 1 from public.profiles) then 'staff' else 'admin' end
  );
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- =====================================================================
--  SATIŞ  (eleman + admin)  — fiyat sunucudan alınır, stok düşer
--  p_items: [{"product_id": 1, "qty": 2}, ...]
-- =====================================================================
create or replace function public.make_sale(p_items jsonb, p_payment text default 'nakit')
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_sale_id bigint;
  v_total   numeric := 0;
  v_count   int := 0;
  v_qty     numeric;
  v_line    numeric;
  v_warn    jsonb := '[]'::jsonb;
  it        jsonb;
  p         public.products%rowtype;
begin
  if not public.is_member() then raise exception 'Yetkisiz kullanıcı'; end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'Sepet boş';
  end if;

  insert into public.sales (user_id, payment)
  values (auth.uid(), coalesce(nullif(p_payment, ''), 'nakit'))
  returning id into v_sale_id;

  for it in select * from jsonb_array_elements(p_items) loop
    v_qty := (it->>'qty')::numeric;
    if v_qty is null or v_qty <= 0 then raise exception 'Geçersiz adet'; end if;

    select * into p from public.products where id = (it->>'product_id')::bigint for update;
    if not found then raise exception 'Ürün bulunamadı (id %)', it->>'product_id'; end if;

    v_line := round(p.price * v_qty, 2);
    insert into public.sale_items (sale_id, product_id, qty, unit_price, line_total)
    values (v_sale_id, p.id, v_qty, p.price, v_line);

    update public.products set stock = stock - v_qty, updated_at = now() where id = p.id;
    insert into public.stock_movements (product_id, change, type, ref_id, user_id)
    values (p.id, -v_qty, 'satis', v_sale_id, auth.uid());

    if p.stock - v_qty < 0 then
      v_warn := v_warn || jsonb_build_object('name', p.name, 'stock', p.stock - v_qty);
    end if;
    v_total := v_total + v_line;
    v_count := v_count + 1;
  end loop;

  update public.sales set total = v_total, item_count = v_count where id = v_sale_id;
  return jsonb_build_object('sale_id', v_sale_id, 'total', v_total, 'negative', v_warn);
end $$;

-- Satış iptali (sadece admin) — stok geri eklenir
create or replace function public.cancel_sale(p_sale_id bigint)
returns void language plpgsql security definer set search_path = public as $$
declare r record;
begin
  if not public.is_admin() then raise exception 'Sadece yönetici iptal edebilir'; end if;
  if exists (select 1 from public.sales where id = p_sale_id and cancelled) then
    raise exception 'Bu satış zaten iptal edilmiş';
  end if;
  if not exists (select 1 from public.sales where id = p_sale_id) then
    raise exception 'Satış bulunamadı';
  end if;
  for r in select product_id, qty from public.sale_items where sale_id = p_sale_id loop
    update public.products set stock = stock + r.qty, updated_at = now() where id = r.product_id;
    insert into public.stock_movements (product_id, change, type, ref_id)
    values (r.product_id, r.qty, 'iptal', p_sale_id);
  end loop;
  update public.sales set cancelled = true where id = p_sale_id;
end $$;

-- =====================================================================
--  E-FATURA İLE STOK GİRİŞİ (sadece admin)
--  p_header: {"uuid","invoice_no","supplier_vkn","supplier_name","invoice_date","total"}
--  p_lines : [{"product_id","qty","unit_cost","supplier_code","multiplier"}]
--            qty = faturadaki miktar, multiplier = 1 koli kaç adet
-- =====================================================================
create or replace function public.apply_invoice(p_header jsonb, p_lines jsonb)
returns bigint language plpgsql security definer set search_path = public as $$
declare
  v_inv  bigint;
  v_mult numeric;
  v_qty  numeric;
  v_vkn  text := nullif(p_header->>'supplier_vkn', '');
  it     jsonb;
begin
  if not public.is_admin() then raise exception 'Sadece yönetici fatura işleyebilir'; end if;

  if nullif(p_header->>'uuid', '') is not null
     and exists (select 1 from public.invoices where uuid = p_header->>'uuid') then
    raise exception 'Bu fatura daha önce stoğa işlendi (%)', p_header->>'invoice_no';
  end if;

  insert into public.invoices (uuid, invoice_no, supplier_vkn, supplier_name, invoice_date, total)
  values (nullif(p_header->>'uuid', ''), p_header->>'invoice_no', v_vkn, p_header->>'supplier_name',
          nullif(p_header->>'invoice_date', '')::date, nullif(p_header->>'total', '')::numeric)
  returning id into v_inv;

  for it in select * from jsonb_array_elements(p_lines) loop
    v_mult := coalesce(nullif(it->>'multiplier', '')::numeric, 1);
    if v_mult <= 0 then v_mult := 1; end if;
    v_qty := (it->>'qty')::numeric * v_mult;

    update public.products
       set stock = stock + v_qty,
           cost = coalesce(nullif(it->>'unit_cost', '')::numeric / v_mult, cost),
           updated_at = now()
     where id = (it->>'product_id')::bigint;
    if not found then raise exception 'Ürün bulunamadı (id %)', it->>'product_id'; end if;

    insert into public.stock_movements (product_id, change, type, ref_id, note)
    values ((it->>'product_id')::bigint, v_qty, 'fatura', v_inv, p_header->>'invoice_no');

    if v_vkn is not null and nullif(it->>'supplier_code', '') is not null then
      insert into public.supplier_codes (supplier_vkn, supplier_code, product_id, multiplier)
      values (v_vkn, it->>'supplier_code', (it->>'product_id')::bigint, v_mult)
      on conflict (supplier_vkn, supplier_code)
      do update set product_id = excluded.product_id, multiplier = excluded.multiplier;
    end if;
  end loop;

  return v_inv;
end $$;

-- =====================================================================
--  SAYIM / STOK DÜZELTME (sadece admin) — stoğu verilen sayıya eşitler
-- =====================================================================
create or replace function public.set_stock(p_product_id bigint, p_new_stock numeric, p_note text default null)
returns numeric language plpgsql security definer set search_path = public as $$
declare v_old numeric;
begin
  if not public.is_admin() then raise exception 'Sadece yönetici stok düzeltebilir'; end if;
  select stock into v_old from public.products where id = p_product_id for update;
  if not found then raise exception 'Ürün bulunamadı'; end if;
  if v_old = p_new_stock then return v_old; end if;
  update public.products set stock = p_new_stock, updated_at = now() where id = p_product_id;
  insert into public.stock_movements (product_id, change, type, note)
  values (p_product_id, p_new_stock - v_old, 'sayim', p_note);
  return p_new_stock;
end $$;

-- =====================================================================
--  TOPLU ÜRÜN YÜKLEME (Excel/CSV'den) — barkod varsa günceller
--  p_rows: [{"barcode","name","price","stock","min_stock","unit","category"}]
-- =====================================================================
create or replace function public.import_products(p_rows jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  it jsonb; v_id bigint; v_old numeric; v_new numeric;
  v_ins int := 0; v_upd int := 0;
begin
  if not public.is_admin() then raise exception 'Sadece yönetici'; end if;
  for it in select * from jsonb_array_elements(p_rows) loop
    if nullif(trim(it->>'barcode'), '') is null or nullif(trim(it->>'name'), '') is null then continue; end if;
    select id, stock into v_id, v_old from public.products where barcode = trim(it->>'barcode');
    if v_id is null then
      insert into public.products (barcode, name, price, min_stock, unit, category)
      values (trim(it->>'barcode'), trim(it->>'name'),
              coalesce(nullif(it->>'price', '')::numeric, 0),
              coalesce(nullif(it->>'min_stock', '')::numeric, 5),
              coalesce(nullif(it->>'unit', ''), 'adet'),
              nullif(it->>'category', ''))
      returning id into v_id;
      v_old := 0; v_ins := v_ins + 1;
    else
      update public.products set
        name = trim(it->>'name'),
        price = coalesce(nullif(it->>'price', '')::numeric, price),
        min_stock = coalesce(nullif(it->>'min_stock', '')::numeric, min_stock),
        unit = coalesce(nullif(it->>'unit', ''), unit),
        category = coalesce(nullif(it->>'category', ''), category),
        updated_at = now()
      where id = v_id;
      v_upd := v_upd + 1;
    end if;
    v_new := nullif(it->>'stock', '')::numeric;
    if v_new is not null and v_new <> v_old then
      update public.products set stock = v_new where id = v_id;
      insert into public.stock_movements (product_id, change, type, note)
      values (v_id, v_new - v_old, 'toplu', 'Toplu yükleme');
    end if;
    v_id := null;
  end loop;
  return jsonb_build_object('eklenen', v_ins, 'guncellenen', v_upd);
end $$;

-- =====================================================================
--  KENDİ BARKODUMUZ — 200 ile başlayan EAN-13 (mağaza içi kullanım)
-- =====================================================================
create or replace function public.ean13_check(p12 text) returns int
language plpgsql immutable set search_path = public as $$
declare s int := 0; i int;
begin
  for i in 1..12 loop
    s := s + substr(p12, i, 1)::int * (case when i % 2 = 0 then 3 else 1 end);
  end loop;
  return (10 - s % 10) % 10;
end $$;

create or replace function public.next_own_barcode() returns text
language plpgsql security definer set search_path = public as $$
declare v12 text; v_code text;
begin
  if not public.is_admin() then raise exception 'Sadece yönetici'; end if;
  loop
    v12 := '200' || lpad(nextval('public.own_barcode_seq')::text, 9, '0');
    v_code := v12 || public.ean13_check(v12)::text;
    exit when not exists (select 1 from public.products where barcode = v_code);
  end loop;
  return v_code;
end $$;

-- =====================================================================
--  GÜNLÜK RAPOR (admin veya n8n service key ile)
-- =====================================================================
create or replace function public.daily_report(p_date date default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_day date := coalesce(p_date, (now() at time zone 'Europe/Istanbul')::date);
  v jsonb;
begin
  if not (public.is_admin() or coalesce(auth.role(), '') = 'service_role') then
    raise exception 'Yetkisiz';
  end if;

  with s as (
    select * from public.sales
    where not cancelled and (created_at at time zone 'Europe/Istanbul')::date = v_day
  )
  select jsonb_build_object(
    'tarih', v_day,
    'ciro', coalesce((select sum(total) from s), 0),
    'satis_adedi', (select count(*) from s),
    'nakit', coalesce((select sum(total) from s where payment = 'nakit'), 0),
    'kart', coalesce((select sum(total) from s where payment = 'kart'), 0),
    'en_cok_satan', coalesce((
      select jsonb_agg(t order by t.tutar desc) from (
        select p.name as urun, sum(si.qty) as adet, sum(si.line_total) as tutar
        from public.sale_items si join s on s.id = si.sale_id
        join public.products p on p.id = si.product_id
        group by p.name order by sum(si.line_total) desc limit 10) t), '[]'::jsonb),
    'azalan', coalesce((
      select jsonb_agg(t order by t.stok) from (
        select name as urun, stock as stok, min_stock as min_stok, unit as birim
        from public.products p where active and stock <= min_stock
          and exists (select 1 from public.stock_movements m where m.product_id = p.id)  -- katalogdan gelip hiç stoklanmamışları sayma
        order by stock limit 50) t), '[]'::jsonb)
  ) into v;
  return v;
end $$;

-- =====================================================================
--  DÜŞÜK STOK UYARISI → n8n webhook → Telegram
-- =====================================================================
create or replace function public.notify_low_stock() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_url text; v_secret text; v_status text;
begin
  if new.stock <= 0 and old.stock > 0 then
    v_status := 'bitti';
  elsif new.stock <= new.min_stock and old.stock > new.min_stock then
    v_status := 'azaldi';
  else
    return new;
  end if;

  select value into v_url from public.app_settings where key = 'n8n_webhook_url';
  if coalesce(v_url, '') = '' then return new; end if;
  select value into v_secret from public.app_settings where key = 'n8n_secret';

  perform net.http_post(
    url     := v_url,
    body    := jsonb_build_object('durum', v_status, 'urun', new.name, 'barkod', new.barcode,
                                  'stok', new.stock, 'min_stok', new.min_stock, 'birim', new.unit),
    headers := jsonb_build_object('Content-Type', 'application/json',
                                  'x-market-secret', coalesce(v_secret, ''))
  );
  return new;
end $$;

drop trigger if exists trg_low_stock on public.products;
create trigger trg_low_stock
  after update of stock on public.products
  for each row execute function public.notify_low_stock();

-- Ayarlar ekranındaki "Test bildirimi" butonu için
create or replace function public.test_notify() returns void
language plpgsql security definer set search_path = public as $$
declare v_url text; v_secret text;
begin
  if not public.is_admin() then raise exception 'Sadece yönetici'; end if;
  select value into v_url from public.app_settings where key = 'n8n_webhook_url';
  if coalesce(v_url, '') = '' then raise exception 'Önce n8n webhook adresini kaydedin'; end if;
  select value into v_secret from public.app_settings where key = 'n8n_secret';
  perform net.http_post(
    url     := v_url,
    body    := jsonb_build_object('durum', 'test', 'urun', 'Test bildirimi', 'barkod', '-',
                                  'stok', 0, 'min_stok', 0, 'birim', ''),
    headers := jsonb_build_object('Content-Type', 'application/json',
                                  'x-market-secret', coalesce(v_secret, ''))
  );
end $$;

-- =====================================================================
--  GÜVENLİK (RLS) — eleman sadece okur ve satış yapar, fiyat değiştiremez
-- =====================================================================
alter table public.profiles        enable row level security;
alter table public.products        enable row level security;
alter table public.supplier_codes  enable row level security;
alter table public.invoices        enable row level security;
alter table public.sales           enable row level security;
alter table public.sale_items      enable row level security;
alter table public.stock_movements enable row level security;
alter table public.app_settings    enable row level security;

drop policy if exists profiles_sel on public.profiles;
create policy profiles_sel on public.profiles for select to authenticated
  using (id = auth.uid() or public.is_admin());
drop policy if exists profiles_upd on public.profiles;
create policy profiles_upd on public.profiles for update to authenticated
  using (public.is_admin()) with check (public.is_admin());

drop policy if exists products_sel on public.products;
create policy products_sel on public.products for select to authenticated using (public.is_member());
drop policy if exists products_ins on public.products;
create policy products_ins on public.products for insert to authenticated with check (public.is_admin());
drop policy if exists products_upd on public.products;
create policy products_upd on public.products for update to authenticated
  using (public.is_admin()) with check (public.is_admin());
drop policy if exists products_del on public.products;
create policy products_del on public.products for delete to authenticated using (public.is_admin());

drop policy if exists sales_sel on public.sales;
create policy sales_sel on public.sales for select to authenticated
  using (public.is_admin() or user_id = auth.uid());
drop policy if exists sale_items_sel on public.sale_items;
create policy sale_items_sel on public.sale_items for select to authenticated
  using (public.is_admin() or exists (select 1 from public.sales s where s.id = sale_id and s.user_id = auth.uid()));

drop policy if exists supcodes_all on public.supplier_codes;
create policy supcodes_all on public.supplier_codes for all to authenticated
  using (public.is_admin()) with check (public.is_admin());
drop policy if exists invoices_all on public.invoices;
create policy invoices_all on public.invoices for all to authenticated
  using (public.is_admin()) with check (public.is_admin());
drop policy if exists movements_sel on public.stock_movements;
create policy movements_sel on public.stock_movements for select to authenticated using (public.is_admin());
drop policy if exists settings_all on public.app_settings;
create policy settings_all on public.app_settings for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- Fonksiyon yetkileri
revoke execute on function public.make_sale(jsonb, text)          from public, anon;
revoke execute on function public.cancel_sale(bigint)             from public, anon;
revoke execute on function public.apply_invoice(jsonb, jsonb)     from public, anon;
revoke execute on function public.set_stock(bigint, numeric, text) from public, anon;
revoke execute on function public.import_products(jsonb)          from public, anon;
revoke execute on function public.next_own_barcode()              from public, anon;
revoke execute on function public.daily_report(date)              from public, anon;
revoke execute on function public.test_notify()                   from public, anon;

grant execute on function public.make_sale(jsonb, text)           to authenticated;
grant execute on function public.cancel_sale(bigint)              to authenticated;
grant execute on function public.apply_invoice(jsonb, jsonb)      to authenticated;
grant execute on function public.set_stock(bigint, numeric, text) to authenticated;
grant execute on function public.import_products(jsonb)           to authenticated;
grant execute on function public.next_own_barcode()               to authenticated;
grant execute on function public.daily_report(date)               to authenticated, service_role;
grant execute on function public.test_notify()                    to authenticated;

-- =====================================================================
--  KULLANICI YÖNETİMİ (uygulamanın içinden)
--  Kullanıcı adı "eleman1" → arka planda eleman1@market.local
-- =====================================================================
create or replace function public._create_auth_user(p_username text, p_password text, p_full_name text)
returns uuid language plpgsql security definer set search_path = public, extensions, auth as $$
declare
  v_id    uuid := gen_random_uuid();
  v_user  text := lower(trim(coalesce(p_username, '')));
  v_email text;
begin
  if v_user !~ '^[a-z0-9._-]{3,30}$' then
    raise exception 'Kullanıcı adı 3-30 karakter olmalı; sadece İngilizce harf, rakam, nokta, tire (Türkçe karakter yok)';
  end if;
  if length(coalesce(p_password, '')) < 6 then raise exception 'Şifre en az 6 karakter olmalı'; end if;
  v_email := v_user || '@market.local';
  if exists (select 1 from auth.users where email = v_email) then raise exception 'Bu kullanıcı adı zaten var'; end if;

  perform set_config('market.allow_signup', '1', true);
  insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
                          raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
                          confirmation_token, email_change, email_change_token_new, recovery_token)
  values ('00000000-0000-0000-0000-000000000000', v_id, 'authenticated', 'authenticated', v_email,
          crypt(p_password, gen_salt('bf')), now(),
          '{"provider":"email","providers":["email"]}'::jsonb,
          jsonb_build_object('full_name', coalesce(nullif(trim(p_full_name), ''), v_user)),
          now(), now(), '', '', '', '');
  insert into auth.identities (id, user_id, provider_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
  values (gen_random_uuid(), v_id, v_id::text,
          jsonb_build_object('sub', v_id::text, 'email', v_email, 'email_verified', true),
          'email', now(), now(), now());
  perform set_config('market.allow_signup', '0', true);
  return v_id;
end $$;

-- Kurulum gerekiyor mu? (hiç kullanıcı yoksa evet)
create or replace function public.needs_setup() returns boolean
language sql stable security definer set search_path = public as $$
  select not exists (select 1 from public.profiles);
$$;

-- İlk yönetici hesabı — sadece hiç kullanıcı yokken çalışır
create or replace function public.setup_first_admin(p_username text, p_password text, p_full_name text default null)
returns void language plpgsql security definer set search_path = public as $$
begin
  lock table public.profiles in exclusive mode;
  if exists (select 1 from public.profiles) then raise exception 'Kurulum zaten yapılmış'; end if;
  perform public._create_auth_user(p_username, p_password, p_full_name);
end $$;

-- Yönetici yeni kullanıcı açar
create or replace function public.create_user(p_username text, p_password text, p_full_name text default null, p_role text default 'staff')
returns uuid language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  if not public.is_admin() then raise exception 'Sadece yönetici kullanıcı açabilir'; end if;
  v_id := public._create_auth_user(p_username, p_password, p_full_name);
  if p_role = 'admin' then update public.profiles set role = 'admin' where id = v_id; end if;
  return v_id;
end $$;

create or replace function public.reset_password(p_user_id uuid, p_password text)
returns void language plpgsql security definer set search_path = public, extensions, auth as $$
begin
  if not public.is_admin() then raise exception 'Sadece yönetici'; end if;
  if length(coalesce(p_password, '')) < 6 then raise exception 'Şifre en az 6 karakter olmalı'; end if;
  update auth.users set encrypted_password = crypt(p_password, gen_salt('bf')), updated_at = now() where id = p_user_id;
  if not found then raise exception 'Kullanıcı bulunamadı'; end if;
end $$;

-- Kullanıcıyı pasif/aktif yap (satış geçmişi silinmesin diye silmek yerine)
create or replace function public.set_user_active(p_user_id uuid, p_active boolean)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Sadece yönetici'; end if;
  if p_user_id = auth.uid() then raise exception 'Kendinizi pasif yapamazsınız'; end if;
  update public.profiles set active = p_active where id = p_user_id;
end $$;

revoke execute on function public._create_auth_user(text, text, text) from public, anon, authenticated;
revoke execute on function public.needs_setup()                        from public;
revoke execute on function public.setup_first_admin(text, text, text)  from public;
revoke execute on function public.create_user(text, text, text, text)  from public, anon;
revoke execute on function public.reset_password(uuid, text)           from public, anon;
revoke execute on function public.set_user_active(uuid, boolean)       from public, anon;
grant execute on function public.needs_setup()                       to anon, authenticated;
grant execute on function public.setup_first_admin(text, text, text) to anon, authenticated;
grant execute on function public.create_user(text, text, text, text) to authenticated;
grant execute on function public.reset_password(uuid, text)          to authenticated;
grant execute on function public.set_user_active(uuid, boolean)      to authenticated;
-- Tetikleyici fonksiyonları dışarıdan çağrılamasın
revoke execute on function public.handle_new_user()  from public, anon, authenticated;
revoke execute on function public.notify_low_stock() from public, anon, authenticated;
