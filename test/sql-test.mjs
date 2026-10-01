// Şemayı gerçek Postgres (PGlite) üzerinde dener. Supabase'e özel parçalar taklit edilir.
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import fs from 'node:fs';

const db = new PGlite({ extensions: { pgcrypto } });
const prelude = `
create role anon; create role authenticated; create role service_role;
create schema auth; create schema net; create schema extensions;
create extension pgcrypto;
create table auth.users (instance_id uuid, id uuid primary key, aud text, role text, email text unique, encrypted_password text,
  email_confirmed_at timestamptz, raw_app_meta_data jsonb, raw_user_meta_data jsonb default '{}', created_at timestamptz, updated_at timestamptz,
  confirmation_token text, email_change text, email_change_token_new text, recovery_token text);
create table auth.identities (id uuid primary key, user_id uuid references auth.users, provider_id text, identity_data jsonb, provider text,
  last_sign_in_at timestamptz, created_at timestamptz, updated_at timestamptz);
create table public.__ctx (uid uuid, role text);
insert into public.__ctx values (null, 'authenticated');
create function auth.uid() returns uuid language sql as 'select uid from public.__ctx';
create function auth.role() returns text language sql as 'select role from public.__ctx';
create table net.calls (url text, body jsonb, headers jsonb);
create function net.http_post(url text, body jsonb default '{}', params jsonb default '{}',
  headers jsonb default '{}', timeout_milliseconds int default 5000) returns bigint
  language sql as 'insert into net.calls values (url, body, headers) returning 1::bigint';
`;
let schema = fs.readFileSync(new URL('../supabase/schema.sql', import.meta.url), 'utf8')
  .replace(/create extension if not exists pg_net[^;]*;/, '');

await db.exec(prelude);
await db.exec(schema);

const as = (uid, role = 'authenticated') => db.query('update __ctx set uid=$1, role=$2', [uid, role]);
const q = async (sql, p = []) => (await db.query(sql, p)).rows;
const ok = (c, m) => { if (!c) { console.error('HATA:', m); process.exit(1); } console.log('✓', m); };
const fails = async (fn, m) => { try { await fn(); console.error('HATA (hata bekleniyordu):', m); process.exit(1); } catch (e) { console.log('✓', m, '→', e.message.split('\n')[0]); } };

ok((await q('select needs_setup() n'))[0].n === true, 'boş sistemde kurulum gerekli');
await fails(() => q(`insert into auth.users(id,email) values (gen_random_uuid(),'x@y.com')`), 'dışarıdan kayıt (signup) engellendi');
await fails(() => q(`select setup_first_admin('Ümit','123456')`), 'Türkçe karakterli kullanıcı adı reddedildi');
await q(`select setup_first_admin('umut','sifre123','Umut Uzun')`);
await fails(() => q(`select setup_first_admin('baska','sifre123')`), 'ikinci kez kurulum yapılamaz');
const A = (await q(`select id from auth.users where email='umut@market.local'`))[0].id;
ok((await q(`select encrypted_password = crypt('sifre123', encrypted_password) ok from auth.users where id=$1`, [A]))[0].ok, 'şifre doğru şifrelendi (bcrypt)');
ok((await q(`select count(*)::int n from auth.identities where user_id=$1`, [A]))[0].n === 1, 'giriş kimliği kaydı oluştu');
await as(A);
const S = (await q(`select create_user('eleman1','123456','Ali') id`))[0].id;
await fails(() => q(`select create_user('eleman1','123456')`), 'aynı kullanıcı adı iki kez açılamaz');
const roles = await q('select id, role, full_name from profiles order by role');
ok(roles.find(r => r.id === A).role === 'admin' && roles.find(r => r.id === S).role === 'staff' && roles.find(r => r.id === S).full_name === 'Ali', 'ilk kullanıcı admin, ikinci eleman');
await q(`select reset_password($1,'yeni999')`, [S]);
ok((await q(`select encrypted_password = crypt('yeni999', encrypted_password) ok from auth.users where id=$1`, [S]))[0].ok, 'yönetici şifre değiştirdi');
await fails(() => q(`select set_user_active($1,false)`, [A]), 'yönetici kendini pasif yapamaz');
await as(S);
await fails(() => q(`select create_user('eleman2','123456')`), 'eleman kullanıcı açamaz');

await as(A);
await q(`insert into app_settings values ('n8n_webhook_url','https://n8n.example/webhook/x'),('n8n_secret','gizli')`);
const [code] = await q('select next_own_barcode() c');
ok(/^200\d{10}$/.test(code.c), 'kendi barkodu üretildi ' + code.c);
// bilinen EAN-13: 869000000001? kontrol hanesi testi: 4006381333931
ok((await q(`select ean13_check('400638133393') c`))[0].c === 1, 'EAN-13 kontrol hanesi doğru');

const imp = await q(`select import_products($1::jsonb) r`, [JSON.stringify([
  { barcode: '8690504000011', name: 'Ekmek', price: '10', stock: '20', min_stock: '5' },
  { barcode: '8690504000028', name: 'Süt 1L', price: '35.5', stock: '6', min_stock: '5' },
])]);
ok(imp[0].r.eklenen === 2, 'toplu yükleme 2 ürün ekledi');
const prods = await q('select id, barcode, stock from products order by id');

await as(S);
// Gerçek RLS testi: Supabase gibi "authenticated" rolüne geç
await db.exec(`grant usage on schema public, auth, net to authenticated;
  grant all on all tables in schema public to authenticated;
  grant usage on all sequences in schema public to authenticated;
  grant select on public.__ctx, net.calls to authenticated;`);
await db.exec('set role authenticated');
const upd = await q(`update products set price = 1 returning id`);
ok(upd.length === 0, 'eleman fiyat değiştiremez (RLS)');
ok((await q('select count(*)::int n from products'))[0].n === 2, 'eleman ürünleri görebilir');
ok((await q('select count(*)::int n from app_settings'))[0].n === 0, 'eleman ayarları (webhook şifresi) göremez');
await fails(() => q(`insert into products(barcode,name) values ('1','x')`), 'eleman ürün ekleyemez');

const sale = await q(`select make_sale($1::jsonb,'kart') r`, [JSON.stringify([
  { product_id: prods[1].id, qty: 2 }, { product_id: prods[0].id, qty: 1 }])]);
ok(Number(sale[0].r.total) === 81, 'satış toplamı sunucuda hesaplandı (2×35.5 + 10 = 81)');
const after = await q('select stock from products where id=$1', [prods[1].id]);
ok(Number(after[0].stock) === 4, 'süt stoğu 6 → 4');
const calls = await q('select body from net.calls');
ok(calls.length === 1 && calls[0].body.durum === 'azaldi' && calls[0].body.urun === 'Süt 1L', 'min stok altına inince n8n çağrıldı (azaldi)');

await fails(() => q(`select make_sale('[]'::jsonb)`), 'boş sepet reddedildi');
await fails(() => q(`select apply_invoice('{}'::jsonb,'[]'::jsonb)`), 'eleman fatura işleyemez');
await fails(() => q(`select daily_report()`), 'eleman raporu göremez');

await q(`select make_sale($1::jsonb) r`, [JSON.stringify([{ product_id: prods[1].id, qty: 4 }])]);
const c2 = await q('select body from net.calls');
ok(c2.length === 2 && c2[1].body.durum === 'bitti', 'stok 0 olunca "bitti" bildirimi');

await db.exec('reset role');
await as(A);
const hdr = { uuid: 'ABC-123', invoice_no: 'GIB2026000000001', supplier_vkn: '1234567890', supplier_name: 'Toptancı A.Ş.', invoice_date: '2026-10-01', total: '1000' };
await q(`select apply_invoice($1::jsonb,$2::jsonb)`, [JSON.stringify(hdr), JSON.stringify([
  { product_id: prods[1].id, qty: 2, unit_cost: 360, supplier_code: 'SUT01', multiplier: 12 }])]);
const s3 = await q('select stock, cost from products where id=$1', [prods[1].id]);
ok(Number(s3[0].stock) === 24 && Number(s3[0].cost) === 30, 'fatura: 2 koli × 12 = 24 adet eklendi, birim maliyet 30');
ok((await q(`select * from supplier_codes`)).length === 1, 'tedarikçi kodu hatırlandı');
await fails(() => q(`select apply_invoice($1::jsonb,'[]'::jsonb)`, [JSON.stringify(hdr)]), 'aynı fatura iki kez işlenemez');

const firstSale = sale[0].r.sale_id;
await q('select cancel_sale($1)', [firstSale]);
ok(Number((await q('select stock from products where id=$1', [prods[0].id]))[0].stock) === 20, 'satış iptali stoğu geri ekledi');
await fails(() => q('select cancel_sale($1)', [firstSale]), 'iptal edilmiş satış tekrar iptal edilemez');

await q('select set_stock($1, 50, $2)', [prods[0].id, 'sayım']);
ok(Number((await q('select stock from products where id=$1', [prods[0].id]))[0].stock) === 50, 'sayım stoğu 50 yaptı');

const rep = (await q('select daily_report() r'))[0].r;
ok(rep.satis_adedi === 1 && Number(rep.ciro) === 142, 'günlük rapor (iptal hariç): 1 satış, 142 TL');
await as(null, 'service_role');
ok((await q('select daily_report() r'))[0].r.tarih, 'n8n service key ile rapor alınabiliyor');

const mv = await q('select type, count(*)::int n from stock_movements group by type order by type');
console.log('stok hareketleri:', mv.map(m => `${m.type}=${m.n}`).join(', '));
console.log('\nTÜM SQL TESTLERİ GEÇTİ');
