// Fatura okuyucuyu örnek UBL-TR XML ile dener
import { DOMParser } from '@xmldom/xmldom';
import fs from 'node:fs';
import { parseUBL } from '../efatura.js';

const xml = fs.readFileSync(new URL('./ornek-efatura.xml', import.meta.url), 'utf8');
const { header, lines } = parseUBL(xml, DOMParser);
const ok = (c, m) => { if (!c) { console.error('HATA:', m); process.exit(1); } console.log('✓', m); };

ok(header.invoice_no === 'ABC2026000000123', 'fatura no');
ok(header.supplier_vkn === '1234567890', 'tedarikçi VKN (MERSIS atlandı)');
ok(header.supplier_name === 'ÖRNEK GIDA TOPTAN A.Ş.', 'tedarikçi adı');
ok(header.total === 1249.33, 'fatura toplamı');
ok(lines.length === 2, '2 kalem');
ok(lines[0].unit_name === 'koli' && lines[0].qty === 2, '1. kalem 2 koli');
ok(lines[0].barcode === '' && lines[0].supplier_code === 'SUT01', '1. kalem barkodsuz, tedarikçi kodu SUT01');
ok(Math.abs(lines[0].unit_cost - 336.67) < 0.01, '1. kalem iskontolu + %1 KDV dahil koli maliyeti ≈ 336,67 → ' + lines[0].unit_cost);
ok(lines[1].barcode === '8690504000042', '2. kalem barkodu bulundu');
ok(lines[1].unit_cost === 24, '2. kalem 20 TL + %20 KDV = 24');
console.log('\nFATURA OKUYUCU TESTİ GEÇTİ');
