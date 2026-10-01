import { JSDOM } from 'jsdom';
import fs from 'node:fs';
const site = new URL('../', import.meta.url);
const read = f => fs.readFileSync(new URL(f, site), 'utf8');
const html = read('index.html').replace(/<script[^>]*><\/script>/g, '');
const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'https://market.test/', pretendToBeVisual: true });
const w = dom.window;
const errors = [];
w.addEventListener('error', e => errors.push(e.message));
w.confirm = () => true; w.print = () => { w.__printed = true; }; w.open = () => {};
w.HTMLCanvasElement.prototype.getContext = () => null;
w.eval(fs.readFileSync(new URL('./mock-supabase.js', import.meta.url), 'utf8'));
const bundle = read('efatura.js').replace(/^export /gm, '') + '\n' + read('app.js').replace(/^import .*$/m, '');
w.eval(`(async()=>{try{${bundle}}catch(e){window.__err=e.stack}})();`);
w.document.dispatchEvent(new w.Event('DOMContentLoaded'));
w.dispatchEvent(new w.Event('DOMContentLoaded'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const $ = s => w.document.querySelector(s);
const ok = (c, m) => { if (!c) { console.error('HATA:', m, errors, w.__err); process.exit(1); } console.log('✓', m); };
await sleep(300);
ok($('nav.bottom') && $$('nav.bottom button').length === 5, 'yönetici girişi: 5 sekme');
function $$(s){ return [...w.document.querySelectorAll(s)]; }

// SATIŞ: barkod yaz → ürün kartı → sepete
const inp = $('.scanbox .code'); inp.value = '8690504000028';
inp.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter' })); await sleep(100);
ok($('.price')?.textContent.includes('35,50'), 'barkod okutunca fiyat göründü: ' + $('.price')?.textContent);
$('#lpCart').click(); await sleep(50);
$('#lpCart').click(); await sleep(50);
ok($$('.cline').length === 1 && $('.cline .qty').value === '2', 'aynı ürün iki kez → 2 adet');
ok($('#cartTotal').textContent.includes('71,00'), 'sepet toplam 71 TL');
inp.value = '999'; inp.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter' })); await sleep(100);
ok($('#lastProd').textContent.includes('Kayıtlı değil'), 'bilinmeyen barkod uyarısı');
$('#payCash').click(); await sleep(150);
ok(w.__db.products.find(p => p.id === 2).stock === 4 && $$('.cline').length === 0, 'satış: stok 6→4, sepet boşaldı');

// ÜRÜNLER
$('nav.bottom button[data-v=urunler]').click(); await sleep(150);
ok($$('#pList .litem').length === 3, 'ürün listesi 3 ürün');
$('.chip[data-f=out]').click(); await sleep(20);
ok($$('#pList .litem').length === 1, 'biten filtresi 1 ürün');
$('.chip[data-f=all]').click();
$('#pNew').click(); await sleep(50);
const f = $('.modal form');
$('#fGen').click(); await sleep(50);
ok(f.elements.namedItem('barcode').value === '2000000000022', 'barkod üret çalıştı');
const E=n=>f.elements.namedItem(n); E('name').value='Yumurta 30lu'; E('price').value='149,90'; E('stock').value='12';
f.dispatchEvent(new w.Event('submit', { cancelable: true })); await sleep(150);
const yeni = w.__db.products.find(p => p.name === 'Yumurta 30lu');
ok(yeni && yeni.price === 149.9 && yeni.stock === 12 && yeni.is_own_barcode, 'yeni ürün kaydı (149,90 TL, stok 12, kendi barkodu)');
ok(!$('.modal'), 'form kapandı');
$('#pLabels').click(); await sleep(30);
$('#lPrint').click(); await sleep(400);
ok($$('#printArea .label').length === 4 && w.__printed, 'etiket yazdırma 4 etiket');

// CSV
const csv = '﻿Barkod;Ürün Adı;Fiyat;Stok;Min Stok\n111;Çay 1kg;"250,00";10;3\n';
// importCsv'yi doğrudan dosya ile tetikle
const file = new w.File([csv], 'u.csv', { type: 'text/csv' });
const ci = $('#pCsv'); Object.defineProperty(ci, 'files', { value: [file], configurable: true });
ci.dispatchEvent(new w.Event('change')); await sleep(200);
const imp = w.__rpc.find(r => r[0] === 'import_products');
ok(imp && imp[1].p_rows[0].price === '250' && imp[1].p_rows[0].stock === '10' && imp[1].p_rows[0].min_stock === '3' && imp[1].p_rows[0].name === 'Çay 1kg', 'CSV okuma (; ayraç, Türkçe sayı)');

// FATURA
$('nav.bottom button[data-v=fatura]').click(); await sleep(100);
const xf = new w.File([fs.readFileSync(new URL('./ornek-efatura.xml', import.meta.url), 'utf8')], 'f.xml', { type: 'text/xml' });
const fi = $('#invFile'); Object.defineProperty(fi, 'files', { value: [xf], configurable: true });
fi.dispatchEvent(new w.Event('change')); await sleep(300);
ok($$('.iline').length === 2, 'fatura 2 kalem gösterildi');
ok($$('.iline')[0].textContent.includes('Süt 1L') && $$('.iline')[0].querySelector('[data-k=mult]').value === '12', 'tedarikçi kodundan otomatik eşleşme + koli çarpanı 12');
ok($('.iapply').disabled, '2. kalem eşleşmeden onay kapalı');
const skip = $$('.iline')[1].querySelector('[data-k=skip]'); skip.checked = true;
skip.dispatchEvent(new w.Event('change', { bubbles: true })); await sleep(20);
ok(!$('.iapply').disabled, 'atlayınca onay açıldı');
const before = w.__db.products.find(p => p.id === 2).stock;
$('.iapply').click(); await sleep(150);
ok(w.__db.products.find(p => p.id === 2).stock === before + 24, 'fatura onay: +24 adet süt');
ok($('.okbox'), 'fatura işlendi mesajı');

// SAYIM
$('nav.bottom button[data-v=sayim]').click(); await sleep(50);
const si = $('.scanbox .code'); si.value = '8690504000011'; si.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter' })); await sleep(100);
$('#cntQty').value = '5'; $('#cntAdd').click(); await sleep(100);
ok(w.__db.products.find(p => p.id === 1).stock === 25, 'sayım +5 → 25');

// RAPOR & AYARLAR
$('nav.bottom button[data-v=rapor]').click(); await sleep(150);
ok($$('.stat').length === 4 && $$('details.sale').length === 1, 'rapor: 4 kutu, 1 satış');
$('#btnSet').click(); await sleep(150);
ok($('#sUrl') && $$('#sUsers .litem').length === 2, 'ayarlar ve kullanıcı listesi');
const nf = $('#nuForm'); nf.elements.namedItem('nu_name').value='Ayşe'; nf.elements.namedItem('nu_user').value='eleman2'; nf.elements.namedItem('nu_pass').value='123456';
nf.dispatchEvent(new w.Event('submit', { cancelable: true })); await sleep(200);
ok(w.__rpc.some(r => r[0] === 'create_user' && r[1].p_username === 'eleman2') && $$('#sUsers .litem').length === 3, 'ayarlardan yeni eleman açıldı');
// fiyatsız ürün sepete eklenmemeli
$('nav.bottom button[data-v=satis]').click(); await sleep(50);
w.__db.products.push({id:77,barcode:'2000000009999',name:'Fiyatsız ürün',price:0,stock:3,min_stock:1,unit:'adet',active:true});
const ci2 = $('.scanbox .code'); ci2.value='2000000009999'; ci2.dispatchEvent(new w.KeyboardEvent('keydown',{key:'Enter'})); await sleep(100);
$('#lpCart').click(); await sleep(50);
ok($$('.cline').length === 0 && $('#lastProd').textContent.includes('Fiyat yok'), 'fiyatsız ürün satılamıyor');
$('#btnSet').click(); await sleep(150);
ok($$('.rule').length === 1, 'marka kuralları görünüyor');
$('#sRecalc').click(); await sleep(150);
ok(w.__rpc.some(r => r[0]==='recalc_prices'), 'fiyatlar yeniden hesaplandı');
ok(errors.length === 0 && !w.__err, 'tarayıcıda hata yok');
console.log('\nARAYÜZ TESTLERİ GEÇTİ');
process.exit(0);
