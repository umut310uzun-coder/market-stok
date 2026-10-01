-- =====================================================================
--  EK: Marka fiyat listeleri, iskonto/kâr kuralları, döviz kuru
--  (KURULUM-TEK-ADIM.sql'den SONRA çalıştırılır)
-- =====================================================================
alter table public.products add column if not exists product_code  text;            -- üretici ürün kodu
alter table public.products add column if not exists list_price    numeric(14,4);   -- üreticinin liste fiyatı (KDV hariç)
alter table public.products add column if not exists list_currency text not null default 'TL';
alter table public.products add column if not exists price_auto    boolean not null default true; -- fiyat kuraldan hesaplansın mı
create unique index if not exists products_brand_code_uq on public.products (brand, product_code)
  where product_code is not null;
create index if not exists products_code_idx on public.products (lower(product_code));

-- Marka kuralları: satış = liste × kur × (1 − iskonto) × (1 + KDV) × (1 + kâr)
create table if not exists public.brand_rules (
  brand     text primary key,
  discount  numeric(6,2) not null default 0,   -- %
  vat       numeric(6,2) not null default 20,  -- %
  markup    numeric(6,2),                      -- % (boşsa satış fiyatı hesaplanmaz)
  note      text,
  updated_at timestamptz not null default now()
);
alter table public.brand_rules enable row level security;
drop policy if exists brand_rules_sel on public.brand_rules;
create policy brand_rules_sel on public.brand_rules for select to authenticated using (public.is_member());
drop policy if exists brand_rules_all on public.brand_rules;
create policy brand_rules_all on public.brand_rules for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- Fiyatları kurallara göre yeniden hesapla (tek marka veya hepsi)
create or replace function public.recalc_prices(p_brand text default null)
returns int language plpgsql security definer set search_path = public as $$
declare
  v_usd numeric := coalesce((select nullif(value,'')::numeric from public.app_settings where key = 'usd_rate'), 0);
  v_eur numeric := coalesce((select nullif(value,'')::numeric from public.app_settings where key = 'eur_rate'), 0);
  v_n   int;
begin
  if not (public.is_admin() or coalesce(auth.role(), '') = 'service_role' or auth.uid() is null) then
    raise exception 'Sadece yönetici';
  end if;
  with calc as (
    select p.id,
           p.list_price * case p.list_currency when 'USD' then v_usd when 'EUR' then v_eur else 1 end
             * (1 - r.discount / 100) * (1 + r.vat / 100) as cost_tl,
           r.markup
    from public.products p join public.brand_rules r on r.brand = p.brand
    where p.list_price is not null and p.list_price > 0 and p.price_auto
      and (p_brand is null or p.brand = p_brand)
  )
  update public.products p
     set cost  = round(c.cost_tl, 4),
         price = case when c.markup is null or c.cost_tl = 0 then p.price
                      else round(c.cost_tl * (1 + c.markup / 100), 2) end,
         updated_at = now()
    from calc c
   where p.id = c.id;
  get diagnostics v_n = row_count;
  return v_n;
end $$;
revoke execute on function public.recalc_prices(text) from public, anon;
grant execute on function public.recalc_prices(text) to authenticated;
