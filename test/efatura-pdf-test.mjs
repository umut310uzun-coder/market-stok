// PDF fatura okuyucuyu 3 farklı şablonla dener (A: GİB standart, B: kodlu + çok sayfa + karışık KDV, C: metre + ₺).
// Çalıştırma: npm i pdfjs-dist@4 && node test/efatura-pdf-test.mjs
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import fs from 'node:fs';
import { pdfSayfalari, parsePdfInvoice } from '../efatura-pdf.js';

const ok = (c, m) => { if (!c) { console.error('HATA:', m); process.exit(1); } console.log('✓', m); };
const oku = async (ad) => parsePdfInvoice(await pdfSayfalari(pdfjs, new Uint8Array(fs.readFileSync(new URL(`./ornek-fatura-${ad}.pdf`, import.meta.url)))));

const A = await oku('A');
ok(A.header.invoice_no === 'GEA2026000001234' && A.header.invoice_date === '2026-10-05', 'A: fatura no + tarih');
ok(A.header.uuid === '3f2a9c1e-77b0-4d2a-9e51-0a1b2c3d4e5f', 'A: ETTN');
ok(A.header.supplier_vkn === '4560012345' && A.header.buyer_vkn === '12345678901', 'A: satıcı/alıcı VKN');
ok(A.header.supplier_name.startsWith('GÜNSAN'), 'A: satıcı adı');
ok(A.lines.length === 4 && A.kontrol.dogru, 'A: 4 kalem, toplam tuttu');
ok(A.lines[0].qty === 50 && A.lines[0].discount === 212.5 && A.lines[0].unit_cost === 45.9, 'A: iskontolu KDV dahil maliyet 45,90');
ok(A.lines[3].qty === 1500, 'A: 1.500 adet binlik ayraçlı okundu');

const B = await oku('B');
ok(B.lines.length === 34 && B.kontrol.dogru, 'B: 2 sayfa 34 kalem, toplam tuttu');
ok(B.lines[0].supplier_code === 'CT-5100' && B.lines[0].unit_name === 'koli' && B.lines[0].vat === 10, 'B: kod, KOLİ, %10 KDV');
ok(B.lines[0].name.includes('MODEL 0'), 'B: alt satıra kayan ad birleşti');

const C = await oku('C');
ok(C.lines.length === 3 && C.kontrol.dogru, 'C: 3 kalem, toplam tuttu');
ok(C.lines[1].qty === 250.5 && C.lines[1].unit_name === 'metre', 'C: 250,5 metre');
console.log('\nPDF FATURA OKUYUCU TESTİ GEÇTİ');
