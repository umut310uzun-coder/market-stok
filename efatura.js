// E-fatura (UBL-TR) XML okuyucu.
// GİB portalı / entegratörden indirilen .xml veya .zip dosyalarını okur.

const UNIT_NAMES = {
  C62: 'adet', NIU: 'adet', H87: 'adet', KGM: 'kg', GRM: 'gr', LTR: 'lt', MLT: 'ml',
  BX: 'kutu', PA: 'paket', PK: 'paket', CT: 'koli', CS: 'koli', MTR: 'metre', SET: 'set',
  PR: 'çift', DZN: 'düzine', BG: 'torba', BO: 'şişe', CA: 'teneke',
};

const isBarcode = (s) => /^(\d{8}|\d{12,14})$/.test(s || '');

export function parseUBL(xmlText, DOMParserImpl = globalThis.DOMParser) {
  const doc = new DOMParserImpl().parseFromString(xmlText, 'application/xml');
  const all = (el, name) => Array.from(el.getElementsByTagNameNS('*', name));
  const kids = (el, name) =>
    el ? Array.from(el.childNodes).filter((n) => n.nodeType === 1 && n.localName === name) : [];
  const child = (el, name) => kids(el, name)[0] || null;
  const path = (el, ...names) => names.reduce((e, n) => child(e, n), el);
  const txt = (e) => (e && e.textContent ? e.textContent.trim() : '');
  const numOf = (e) => {
    const v = parseFloat(txt(e));
    return Number.isFinite(v) ? v : 0;
  };

  const inv = all(doc, 'Invoice')[0];
  if (!inv) throw new Error('Bu dosya e-fatura (UBL) değil');

  // --- Tedarikçi
  const party = path(inv, 'AccountingSupplierParty', 'Party');
  let vkn = '';
  for (const pi of kids(party, 'PartyIdentification')) {
    const id = child(pi, 'ID');
    const scheme = id && id.getAttribute('schemeID');
    if (scheme === 'VKN' || scheme === 'TCKN') { vkn = txt(id); break; }
  }
  let supplierName = txt(path(party, 'PartyName', 'Name'));
  if (!supplierName) {
    const person = child(party, 'Person');
    supplierName = [txt(child(person, 'FirstName')), txt(child(person, 'FamilyName'))].join(' ').trim();
  }

  const header = {
    uuid: txt(child(inv, 'UUID')),
    invoice_no: txt(child(inv, 'ID')),
    invoice_date: txt(child(inv, 'IssueDate')),
    type: txt(child(inv, 'InvoiceTypeCode')),
    supplier_vkn: vkn,
    supplier_name: supplierName,
    total: numOf(path(inv, 'LegalMonetaryTotal', 'PayableAmount')),
    currency: txt(child(inv, 'DocumentCurrencyCode')) || 'TRY',
  };

  // --- Kalemler
  const lines = kids(inv, 'InvoiceLine').map((line, i) => {
    const qtyEl = child(line, 'InvoicedQuantity');
    const qty = numOf(qtyEl);
    const unitCode = qtyEl ? qtyEl.getAttribute('unitCode') || '' : '';
    const item = child(line, 'Item');

    const codes = {
      standard: txt(path(item, 'StandardItemIdentification', 'ID')),
      manufacturer: txt(path(item, 'ManufacturersItemIdentification', 'ID')),
      seller: txt(path(item, 'SellersItemIdentification', 'ID')),
      buyer: txt(path(item, 'BuyersItemIdentification', 'ID')),
    };
    const barcode = [codes.standard, codes.manufacturer, codes.seller, codes.buyer].find(isBarcode) || '';
    const supplierCode = codes.seller || codes.standard || codes.manufacturer || barcode || '';

    // KDV oranı: TaxTypeCode 0015 = KDV
    let vat = 0;
    for (const st of all(line, 'TaxSubtotal')) {
      const code = txt(path(st, 'TaxCategory', 'TaxScheme', 'TaxTypeCode'));
      const pct = parseFloat(txt(child(st, 'Percent')));
      if (Number.isFinite(pct) && (code === '0015' || code === '' || vat === 0)) {
        vat = pct;
        if (code === '0015') break;
      }
    }

    const lineNet = numOf(child(line, 'LineExtensionAmount')); // iskonto sonrası, KDV hariç
    const unitPrice = numOf(path(line, 'Price', 'PriceAmount'));
    const unitNet = qty > 0 && lineNet > 0 ? lineNet / qty : unitPrice;
    const unitCost = Math.round(unitNet * (1 + vat / 100) * 10000) / 10000; // KDV dahil birim maliyet

    return {
      line_no: i + 1,
      name: txt(child(item, 'Name')) || txt(child(item, 'Description')) || `Kalem ${i + 1}`,
      brand: txt(child(item, 'BrandName')),
      qty,
      unit_code: unitCode,
      unit_name: UNIT_NAMES[unitCode] || unitCode || 'adet',
      barcode,
      supplier_code: supplierCode,
      vat,
      unit_cost: unitCost,
      line_total: Math.round(lineNet * (1 + vat / 100) * 100) / 100,
    };
  });

  return { header, lines };
}

// Tarayıcıda: seçilen dosyalardan XML metinlerini çıkar (.zip içindekiler dahil)
export async function readInvoiceFiles(fileList) {
  const out = [];
  for (const file of fileList) {
    const name = file.name.toLowerCase();
    if (name.endsWith('.zip')) {
      if (!window.JSZip) throw new Error('ZIP okuyucu yüklenemedi (internet?)');
      const zip = await window.JSZip.loadAsync(file);
      for (const entry of Object.values(zip.files)) {
        if (!entry.dir && entry.name.toLowerCase().endsWith('.xml')) {
          out.push({ fileName: entry.name, xml: await entry.async('string') });
        }
      }
    } else if (name.endsWith('.xml')) {
      out.push({ fileName: file.name, xml: await file.text() });
    } else {
      throw new Error(`${file.name}: sadece .xml veya .zip yükleyin (PDF okunamaz)`);
    }
  }
  return out;
}
