// E-fatura PDF okuyucu (bağımlılıksız; metni pdf.js çıkarır).
//
// Aynı dosya iki yerde kullanılır — değiştirirsen ikisini birlikte güncelle:
//   market-stok/efatura-pdf.js            (tarayıcı, Fatura ekranı)
//   asena-telefon/beyin/bridge/efatura-pdf.mjs   (ASENA)
//
// e-Fatura PDF'inin görünümü faturayı kesen firmanın şablonuna göre değişir; bu
// yüzden sütun başlıklarına güvenilmez. Her satırdaki sayılardan
// "miktar × birim fiyat (− iskonto) = tutar" tutan üçlü aranır, KDV oranı
// "tutar × oran = KDV tutarı" ile doğrulanır. Sonunda kalemlerin toplamı
// faturadaki "Mal Hizmet Toplam Tutarı" ile karşılaştırılır: tutuyorsa
// `kontrol.dogru = true`. Tutmuyorsa rakamlar mutlaka elle kontrol edilmeli.

const BIRIMLER = [
  [/^(adet|ad|adt|ade|c62|niu|h87|pcs|pc|tane)\.?$/i, 'adet', 'C62'],
  [/^(metre|mt|mtr|m)\.?$/i, 'metre', 'MTR'],
  [/^(kg|kilogram|kgm)\.?$/i, 'kg', 'KGM'],
  [/^(gr|gram|grm)\.?$/i, 'gr', 'GRM'],
  [/^(lt|litre|ltr)\.?$/i, 'lt', 'LTR'],
  [/^(paket|pk|pkt|pa)\.?$/i, 'paket', 'PA'],
  [/^(koli|kl|ct|cs)\.?$/i, 'koli', 'CT'],
  [/^(kutu|bx)\.?$/i, 'kutu', 'BX'],
  [/^(takım|takim|set)\.?$/i, 'set', 'SET'],
  [/^(top|rulo)\.?$/i, 'top', 'C62'],
  [/^(çift|cift|pr)\.?$/i, 'çift', 'PR'],
  [/^(m2|m²|mtk)\.?$/i, 'm2', 'MTK'],
];
const birimBul = (w) => {
  const k = String(w || '').trim().toLocaleLowerCase('tr-TR');
  for (const [re, ad, kod] of BIRIMLER) if (re.test(k)) return { ad, kod };
  return null;
};
const KDV_ORANLARI = [0, 1, 8, 10, 18, 20];
const isBarcode = (s) => /^(\d{8}|\d{12,14})$/.test(s || '');
const yuvarla = (x, h = 2) => Math.round(x * 10 ** h) / 10 ** h;

/** "1.234,56" / "1,234.56" / "12,5" / "1.500" → olası sayı değerleri. */
export function sayiAdaylari(s) {
  s = String(s).replace(/[₺\s]/g, '').replace(/(TL|TRY)$/i, '');
  if (!/^-?\d[\d.,]*$/.test(s) || /[.,]$/.test(s)) return [];
  const nokta = (s.match(/\./g) || []).length;
  const virgul = (s.match(/,/g) || []).length;
  const n = (x) => Number(x);
  if (!nokta && !virgul) return [n(s)];
  if (nokta && virgul) {
    return s.lastIndexOf(',') > s.lastIndexOf('.') ? [n(s.replace(/\./g, '').replace(',', '.'))] : [n(s.replace(/,/g, ''))];
  }
  if (virgul) return virgul === 1 ? [n(s.replace(',', '.'))] : [n(s.replace(/,/g, ''))];
  if (nokta > 1) return [n(s.replace(/\./g, ''))];
  const [a, b] = s.split('.');
  // "1.500": Türkçede binlik (1500), İngilizcede ondalık (1,5). İkisini de dene.
  if (b.length === 3 && a !== '0' && a !== '-0') return [n(a + b), n(s)];
  return [n(s)];
}

/** pdf.js ile sayfaların metin parçalarını konumlarıyla al. */
export async function pdfSayfalari(pdfjs, data) {
  const doc = await pdfjs.getDocument({ data, isEvalSupported: false, useSystemFonts: true, disableFontFace: true }).promise;
  const sayfalar = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const vp = page.getViewport({ scale: 1 });
    const tc = await page.getTextContent();
    sayfalar.push({
      genislik: vp.width,
      yukseklik: vp.height,
      parcalar: tc.items
        .filter((it) => it.str && it.str.trim())
        .map((it) => ({
          str: it.str,
          x: it.transform[4],
          y: vp.height - it.transform[5],
          w: it.width || 0,
          h: Math.abs(it.transform[3]) || it.height || 8,
        })),
    });
  }
  await doc.destroy?.();
  return sayfalar;
}

/** Parçaları satırlara, satırları hücrelere böl. */
function satirlaraBol(sayfalar) {
  const satirlar = [];
  sayfalar.forEach((sp, si) => {
    const pp = [...sp.parcalar].sort((a, b) => a.y - b.y || a.x - b.x);
    const gruplar = [];
    for (const p of pp) {
      const g = gruplar[gruplar.length - 1];
      if (g && Math.abs(p.y - g.y) <= Math.max(2, Math.min(g.h, p.h) * 0.45)) g.pp.push(p);
      else gruplar.push({ y: p.y, h: p.h, pp: [p] });
    }
    for (const g of gruplar) {
      g.pp.sort((a, b) => a.x - b.x);
      const hucreler = [];
      for (const p of g.pp) {
        const c = hucreler[hucreler.length - 1];
        const bosluk = c ? p.x - c.x1 : Infinity;
        if (c && bosluk <= p.h * 0.9) {
          c.metin += (bosluk > p.h * 0.12 && !/\s$/.test(c.metin) && !/^\s/.test(p.str) ? ' ' : '') + p.str;
          c.x1 = Math.max(c.x1, p.x + p.w);
        } else hucreler.push({ metin: p.str, x0: p.x, x1: p.x + p.w });
      }
      for (const c of hucreler) c.metin = c.metin.replace(/\s+/g, ' ').trim()
      const temiz = hucreler.filter((c) => c.metin)
      if (temiz.length) satirlar.push({ sayfa: si, y: g.y, h: g.h, genislik: sp.genislik, hucreler: temiz, metin: temiz.map((c) => c.metin).join('  ') });
    }
  });
  return satirlar;
}

/** Bir satırı kelimelere ayır: sayı mı, yüzde mi, birim mi. */
function kelimeler(satir) {
  const out = [];
  satir.hucreler.forEach((c, ci) => {
    const ws = c.metin.split(' ');
    for (let i = 0; i < ws.length; i++) {
      let w = ws[i];
      let yuzde = false;
      if (w === '%' && i + 1 < ws.length) { w = ws[++i]; yuzde = true; }
      if (/^%/.test(w)) { w = w.slice(1); yuzde = true; }
      if (/%$/.test(w)) { w = w.slice(0, -1); yuzde = true; }
      const temiz = w.replace(/^[(]|[)]$/g, '').replace(/(TL|TRY|₺)$/i, '');
      const vals = sayiAdaylari(temiz).filter((v) => Number.isFinite(v));
      out.push({ ci, ham: ws[i], w, vals, yuzde, sayi: vals.length > 0 && /\d/.test(temiz) });
    }
  });
  for (let i = 0; i < out.length; i++) {
    const s = out[i + 1];
    if (out[i].sayi && s && !s.sayi) {
      const b = birimBul(s.w);
      if (b) { out[i].birim = b; s.birimKelimesi = true; }
    }
    if (out[i].sayi && s && /^(TL|TRY|₺)$/i.test(s.w)) { out[i].para = true; s.paraKelimesi = true; }
  }
  return out;
}

/** Satırda miktar × fiyat (− iskonto) = tutar tutan en iyi üçlüyü bul. */
function satirCoz(ks) {
  const nums = ks.map((k, i) => ({ ...k, i })).filter((k) => k.sayi);
  if (nums.length < 3) return null;
  let en = null;
  const ilkSayi = nums[0];
  for (let a = 0; a < nums.length; a++) {
    const q = nums[a];
    if (q.yuzde) continue;
    for (let b = a + 1; b < nums.length; b++) {
      const p = nums[b];
      if (p.yuzde) continue;
      for (let c = b + 1; c < nums.length; c++) {
        const t = nums[c];
        if (t.yuzde) continue;
        for (const qv of q.vals) for (const pv of p.vals) for (const tv of t.vals) {
          if (!(qv > 0 && pv > 0 && tv > 0)) continue;
          const tol = Math.max(0.02, qv * 0.005 + tv * 0.0005);
          const base = qv * pv;
          let isk = null;
          if (Math.abs(base - tv) <= tol) isk = { tutar: 0 };
          else {
            for (let d = b + 1; d < c && !isk; d++) {
              const x = nums[d];
              for (const xv of x.vals) {
                if (xv > 0 && xv < 100 && Math.abs(base * (1 - xv / 100) - tv) <= tol) isk = { oran: xv, tutar: yuvarla(base - tv) };
                else if (!x.yuzde && xv > 0 && Math.abs(base - xv - tv) <= tol) isk = { tutar: xv };
                if (isk) break;
              }
            }
          }
          if (!isk) continue;
          let puan = 0;
          if (q.birim) puan += 4;
          if (q === ilkSayi && !q.birim && ks[0] === q && Number.isInteger(qv) && nums.length > 3) puan -= 4;
          if (isk.tutar === 0) puan += 1;
          if (tv < pv && qv >= 1) puan -= 3;
          // KDV: tutar × oran ≈ başka bir sayı (oran %'li ya da %'siz yazılmış olabilir).
          let kdv = null;
          let kdvEsles = false;
          for (const r of nums) {
            if (r.i <= p.i || r === t) continue;
            for (const rv of r.vals) {
              if (!KDV_ORANLARI.includes(rv) || !Number.isInteger(rv)) continue;
              const beklenen = (tv * rv) / 100;
              const v = nums.find((x) => x !== r && x !== t && x !== p && !x.yuzde && x.i > p.i && x.vals.some((y) => Math.abs(y - beklenen) <= 0.02 + tv * 0.0005));
              if (v && (rv > 0 || !kdvEsles)) {
                if (!kdvEsles || rv > 0) kdv = rv;
                kdvEsles = true;
              } else if (!kdvEsles && r.yuzde) kdv = rv;
            }
          }
          if (kdvEsles) puan += 3;
          else if (kdv != null) puan += 1;
          // Tutar genelde sağdaki son tutarlardan biri.
          const sagda = nums.filter((x) => x.i > t.i && !x.yuzde).length;
          if (sagda <= 2) puan += 1;
          if (!en || puan > en.puan) en = { puan, q, p, t, qv, pv, tv, isk, kdv };
        }
      }
    }
  }
  return en;
}

function tarihCevir(s) {
  const m = String(s || '').match(/(\d{1,2})[-./](\d{1,2})[-./](\d{4})/);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  const m2 = String(s || '').match(/(\d{4})-(\d{2})-(\d{2})/);
  return m2 ? m2[0] : '';
}

const TOPLAM_RE = /mal\s*hizmet\s*toplam|toplam\s*iskonto|vergiler\s*dahil|hesaplanan\s*k\.?\s*d\.?\s*v|ödenecek\s*tutar|odenecek\s*tutar|k\.?d\.?v\.?\s*matrah|genel\s*toplam|ara\s*toplam|toplam\s*tutar/i;
const BASLIK_RE = /miktar/i;
const ADRES_RE = /e-?fatura|e-?arşiv|e-?arsiv|adres|tel\b|telefon|faks|fax|web|www\.|e-?posta|mail|@|vergi\s*dairesi|vkn|tckn|mersis|ticaret\s*sicil|sicil\s*no|sayın|sayin|^\s*no\s*:|mah\.|mahalle|cad\.|sok\.|bulvar|kat\s*:|posta\s*kodu|ülke|türkiye|turkiye|ettn|senaryo|fatura\s*(tipi|no|tarihi)|sayfa\s*\d/i;

/** Sayfalardan e-fatura başlığı ve kalemleri çıkar. */
export function parsePdfInvoice(sayfalar) {
  const satirlar = satirlaraBol(sayfalar);
  const tumMetin = satirlar.map((s) => s.metin).join('\n');
  if (!satirlar.length) throw new Error('PDF\'te okunabilir yazı yok (taranmış resim olabilir).');
  const uyarilar = [];

  // ---------------- başlık
  const uuid = (tumMetin.match(/ETTN\s*:?\s*([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i) ||
    tumMetin.match(/\b([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/i) || [])[1]?.toLowerCase() || '';
  const no = (tumMetin.match(/Fatura\s*No\s*:?\s*([A-Z0-9ÇĞİÖŞÜ]{3}\d{13})\b/i) || tumMetin.match(/\b([A-Z0-9]{3}20\d{11})\b/) || [])[1] || '';
  const tarih = tarihCevir((tumMetin.match(/Fatura\s*Tarihi\s*:?\s*([0-9]{1,2}[-./][0-9]{1,2}[-./][0-9]{4}|\d{4}-\d{2}-\d{2})/i) || [])[1]);
  const tip = ((tumMetin.match(/Fatura\s*Tipi\s*:?\s*([A-ZÇĞİÖŞÜ]+)/i) || [])[1] || '').toLocaleUpperCase('tr-TR').replace('İ', 'I');

  // VKN/TCKN: SAYIN'dan öncekiler satıcı, sonrakiler alıcı.
  const sayinIdx = satirlar.findIndex((s) => /\bSAYIN\b/i.test(s.metin));
  const kimlikler = [];
  satirlar.forEach((s, i) => {
    const re = /(?:\bVKN\b|\bTCKN\b|V\.K\.N\.?|T\.C\.K\.N\.?|Vergi\s*(?:Kimlik\s*)?(?:No|Numaras[ıi])|T\.?C\.?\s*Kimlik\s*No|Vergi\s*Dairesi)\s*[:.]?\s*(?:[A-ZÇĞİÖŞÜa-zçğıöşü .]*?)\s*(\d{10,11})\b/gi;
    for (const m of s.metin.matchAll(re)) kimlikler.push({ i, vkn: m[1] });
  });
  const saticiK = (sayinIdx >= 0 ? kimlikler.filter((k) => k.i < sayinIdx) : kimlikler)[0] || null;
  const aliciK = (sayinIdx >= 0 ? kimlikler.filter((k) => k.i >= sayinIdx) : kimlikler.slice(1))[0] || null;

  const adBul = (bas, son) => {
    for (let i = Math.max(0, bas); i < Math.min(son, satirlar.length); i++) {
      const s = satirlar[i];
      if (s.sayfa !== satirlar[Math.max(0, bas)].sayfa) break;
      const c = s.hucreler.find((h) => h.x0 < s.genislik * 0.55) || null;
      if (!c) continue;
      const m = c.metin.replace(/^SAYIN\s*:?\s*/i, '').trim();
      if (m.length >= 3 && /[A-Za-zÇĞİÖŞÜçğıöşü]{3}/.test(m) && !ADRES_RE.test(m) && !/^\d/.test(m)) return m;
    }
    return '';
  };
  const saticiAd = adBul(0, saticiK ? saticiK.i + 1 : sayinIdx >= 0 ? sayinIdx : 8);
  const aliciAd = sayinIdx >= 0 ? adBul(sayinIdx, (aliciK ? aliciK.i : sayinIdx + 6) + 1) : '';

  // Toplamlar: etiketin olduğu satırdaki en sağdaki sayı.
  const deger = (re) => {
    for (const s of satirlar) {
      if (!re.test(s.metin)) continue;
      const ks = kelimeler(s).filter((k) => k.sayi && !k.yuzde);
      if (ks.length) return ks[ks.length - 1].vals[0];
    }
    return null;
  };
  const toplamlar = {
    mal_hizmet: deger(/mal\s*hizmet\s*toplam/i),
    iskonto: deger(/toplam\s*iskonto/i),
    kdv_dahil: deger(/vergiler\s*dahil\s*toplam/i),
    odenecek: deger(/ödenecek\s*tutar|odenecek\s*tutar/i),
  };
  const kdvOranlari = [...new Set([...tumMetin.matchAll(/hesaplanan\s*k\.?\s*d\.?\s*v\.?\s*(?:\(|\s)\s*%?\s*(\d{1,2})(?:[.,]0+)?\s*%?/gi)].map((m) => Number(m[1])))].filter((x) => KDV_ORANLARI.includes(x));

  // ---------------- kalemler
  let bolgede = false;
  let baslikVar = false;
  let kodSutunu = null;
  const adaylar = [];
  const yaziSatirlari = [];
  for (const s of satirlar) {
    if (BASLIK_RE.test(s.metin) && /(fiyat|tutar|toplam|kdv)/i.test(s.metin) && !/\d{2,}[.,]\d{2}/.test(s.metin)) {
      bolgede = true;
      baslikVar = true;
      const k = s.hucreler.find((h) => /kod/i.test(h.metin));
      if (k) kodSutunu = (k.x0 + k.x1) / 2;
      continue;
    }
    if (TOPLAM_RE.test(s.metin)) { bolgede = false; continue; }
    if (baslikVar && !bolgede) continue;
    const ks = kelimeler(s);
    const coz = satirCoz(ks);
    if (coz) adaylar.push({ s, ks, coz });
    else if (bolgede && /[A-Za-zÇĞİÖŞÜçğıöşü]{2}/.test(s.metin) && !/sayfa\s*\d|^\s*\d+\s*\/\s*\d+\s*$/i.test(s.metin)) yaziSatirlari.push(s);
  }
  if (!baslikVar) uyarilar.push('Kalem tablosunun başlığı (Miktar…) bulunamadı; bütün sayfa tarandı.');

  const kalemler = adaylar.map(({ s, ks, coz }) => {
    const qi = coz.q.i;
    // Ad: miktardan önceki yazılar (baştaki sıra no hariç).
    let sol = ks.slice(0, qi).filter((k) => !k.birimKelimesi && !k.paraKelimesi);
    if (sol.length && sol[0].sayi && Number.isInteger(sol[0].vals[0]) && sol[0].vals[0] < 1000 && sol[0].w.length <= 3) sol = sol.slice(1);
    const hucreGruplari = [];
    for (const k of sol) {
      const g = hucreGruplari[hucreGruplari.length - 1];
      if (g && g.ci === k.ci) g.ws.push(k.ham);
      else hucreGruplari.push({ ci: k.ci, ws: [k.ham] });
    }
    let kod = '';
    let adParcalari = hucreGruplari.map((g) => g.ws.join(' '));
    if (hucreGruplari.length > 1) {
      let kodGi = -1;
      if (kodSutunu != null) {
        let enYakin = Infinity;
        hucreGruplari.forEach((g, gi) => {
          const c = s.hucreler[g.ci];
          const d = Math.abs((c.x0 + c.x1) / 2 - kodSutunu);
          if (d < enYakin) { enYakin = d; kodGi = gi; }
        });
      } else {
        kodGi = hucreGruplari.findIndex((g) => g.ws.length === 1 && /\d/.test(g.ws[0]) && /^[A-Za-z0-9ÇĞİÖŞÜçğıöşü._/-]{3,30}$/.test(g.ws[0]));
      }
      if (kodGi >= 0) {
        kod = adParcalari[kodGi];
        adParcalari = adParcalari.filter((_, i) => i !== kodGi);
      }
    }
    const kdv = coz.kdv != null ? coz.kdv : kdvOranlari.length === 1 ? kdvOranlari[0] : null;
    return {
      y: s.y,
      sayfa: s.sayfa,
      ad: adParcalari.join(' ').trim(),
      kod,
      miktar: coz.qv,
      birim: coz.q.birim || null,
      birim_fiyat: coz.pv,
      iskonto: coz.isk.tutar || 0,
      iskonto_orani: coz.isk.oran ?? null,
      kdv,
      tutar: coz.tv,
      guven: coz.puan,
    };
  });

  // Alt satıra kayan ürün adlarını en yakın kaleme ekle.
  for (const ys of yaziSatirlari) {
    let en = null;
    for (const k of kalemler) {
      if (k.sayfa !== ys.sayfa) continue;
      const d = Math.abs(k.y - ys.y);
      if (d <= ys.h * 3.2 && (!en || d < en.d)) en = { k, d };
    }
    if (!en) continue;
    const parca = ys.hucreler.filter((h) => !/^[\d.,%\s]+$/.test(h.metin)).map((h) => h.metin).join(' ');
    if (!parca) continue;
    en.k.ad = ys.y < en.k.y ? `${parca} ${en.k.ad}`.trim() : `${en.k.ad} ${parca}`.trim();
  }

  const lines = kalemler.map((k, i) => {
    let barcode = '';
    for (const w of `${k.kod} ${k.ad}`.split(/\s+/)) if (isBarcode(w)) { barcode = w; break; }
    const vat = k.kdv ?? 20;
    const net = k.tutar;
    const unitCost = Math.round((net / k.miktar) * (1 + vat / 100) * 10000) / 10000;
    return {
      line_no: i + 1,
      name: k.ad || `Kalem ${i + 1}`,
      brand: '',
      qty: k.miktar,
      unit_code: k.birim?.kod || '',
      unit_name: k.birim?.ad || 'adet',
      barcode,
      supplier_code: k.kod || barcode || '',
      vat,
      vat_bulundu: k.kdv != null,
      unit_price: k.birim_fiyat,
      discount: k.iskonto,
      net_total: net,
      unit_cost: unitCost,
      line_total: yuvarla(net * (1 + vat / 100)),
    };
  });

  // ---------------- kontrol
  const netToplam = yuvarla(lines.reduce((a, l) => a + l.net_total, 0));
  const kdvliToplam = yuvarla(lines.reduce((a, l) => a + l.line_total, 0));
  let dogru = false;
  if (!lines.length) uyarilar.push('Hiç kalem bulunamadı.');
  if (toplamlar.mal_hizmet != null && lines.length) {
    const fark = Math.abs(netToplam - toplamlar.mal_hizmet);
    if (fark <= Math.max(0.05, lines.length * 0.01)) dogru = true;
    else uyarilar.push(`Kalemlerin toplamı ${netToplam} ama faturada Mal Hizmet Toplam ${toplamlar.mal_hizmet}. Eksik ya da yanlış okunan kalem var.`);
  } else if (lines.length) uyarilar.push('Faturada "Mal Hizmet Toplam Tutarı" bulunamadı; toplam kontrol edilemedi.');
  if (toplamlar.kdv_dahil != null && lines.length && Math.abs(kdvliToplam - toplamlar.kdv_dahil) > Math.max(0.5, lines.length * 0.02)) {
    uyarilar.push(`KDV dahil toplam tutmuyor (${kdvliToplam} / faturada ${toplamlar.kdv_dahil}). KDV oranlarını kontrol et.`);
    dogru = false;
  }
  if (lines.some((l) => !l.vat_bulundu)) uyarilar.push('Bazı kalemlerde KDV oranı okunamadı, %20 varsayıldı.');
  if (!uuid) uyarilar.push('ETTN bulunamadı; aynı faturanın iki kez işlenmesine karşı fatura no + VKN kullanılacak.');
  if (!no) uyarilar.push('Fatura numarası bulunamadı.');
  if (!saticiK) uyarilar.push('Satıcı VKN/TCKN bulunamadı.');

  const total = toplamlar.odenecek ?? toplamlar.kdv_dahil ?? kdvliToplam;
  return {
    header: {
      uuid,
      invoice_no: no,
      invoice_date: tarih,
      type: tip,
      supplier_vkn: saticiK?.vkn || '',
      supplier_name: saticiAd,
      buyer_vkn: aliciK?.vkn || '',
      buyer_name: aliciAd,
      total,
      currency: 'TRY',
      kaynak: 'pdf',
    },
    lines,
    kontrol: { dogru, uyarilar, toplamlar, kalem_net_toplam: netToplam, kalem_kdvli_toplam: kdvliToplam, kdv_oranlari: kdvOranlari },
    metin: tumMetin,
  };
}
