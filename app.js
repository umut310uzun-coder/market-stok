// =====================================================================
//  MARKET STOK & SATIŞ — telefon/PC uygulaması (Android + iOS + PC)
// =====================================================================
import { parseUBL, readInvoiceFiles } from './efatura.js';

// ---------------------------------------------------------------- yardımcılar
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const h = (html) => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; };
const tl = (n) => Number(n || 0).toLocaleString('tr-TR', { style: 'currency', currency: 'TRY' });
const num = (n) => Number(n || 0).toLocaleString('tr-TR', { maximumFractionDigits: 3 });
const toNum = (v) => {
  let s = String(v ?? '').trim().replace(/\s|₺|TL/gi, '');
  if (!s) return null;
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};
const todayStr = () => new Date(Date.now() + 3 * 3600e3).toISOString().slice(0, 10); // Türkiye UTC+3
const errMsg = (e) => (e && (e.message || e.error_description || e.details)) || String(e);

function toast(msg, type = 'ok', ms = 3200) {
  const t = h(`<div class="toast ${type}">${esc(msg)}</div>`);
  $('#toasts').append(t);
  setTimeout(() => t.classList.add('hide'), ms);
  setTimeout(() => t.remove(), ms + 400);
}

let audioCtx;
function feedback(ok = true) {
  try { navigator.vibrate && navigator.vibrate(ok ? 60 : [80, 60, 80]); } catch {}
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const o = audioCtx.createOscillator(), g = audioCtx.createGain();
    o.frequency.value = ok ? 1500 : 300; g.gain.value = 0.08;
    o.connect(g); g.connect(audioCtx.destination); o.start(); o.stop(audioCtx.currentTime + (ok ? 0.08 : 0.25));
  } catch {}
}

async function busy(btn, fn) {
  if (btn.disabled) return;
  const old = btn.innerHTML; btn.disabled = true; btn.innerHTML = '⏳';
  try { return await fn(); }
  catch (e) { toast(errMsg(e), 'err', 5000); }
  finally { btn.disabled = false; btn.innerHTML = old; }
}

// ---------------------------------------------------------------- durum
const S = {
  sb: null, cfg: null, user: null, profile: null, isAdmin: false,
  cart: [], scanner: null, scanSlot: null, scanOnStop: null,
  products: null, // önbellek (admin ekranları)
};

const CFG_KEY = 'market_cfg';
function loadCfg() {
  const c = window.MARKET_CONFIG || {};
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(CFG_KEY) || '{}'); } catch {}
  return {
    url: c.SUPABASE_URL || saved.url || '',
    key: c.SUPABASE_ANON_KEY || saved.key || '',
    name: saved.name || c.MARKET_NAME || 'Uzun Elektrik',
    fromFile: !!(c.SUPABASE_URL && c.SUPABASE_ANON_KEY),
  };
}
function saveCfg(patch) {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(CFG_KEY) || '{}'); } catch {}
  localStorage.setItem(CFG_KEY, JSON.stringify({ ...saved, ...patch }));
}

// ---------------------------------------------------------------- barkod okuyucu (kamera)
async function openScanner(slot, onCode, onStop) {
  await stopScanner();
  slot.innerHTML = '<div id="reader"></div>';
  const F = window.Html5QrcodeSupportedFormats;
  const sc = new window.Html5Qrcode('reader', {
    formatsToSupport: [F.EAN_13, F.EAN_8, F.UPC_A, F.UPC_E, F.CODE_128, F.CODE_39, F.ITF, F.QR_CODE],
    experimentalFeatures: { useBarCodeDetectorIfSupported: true },
    verbose: false,
  });
  S.scanner = sc; S.scanSlot = slot; S.scanOnStop = onStop || null;
  let last = '', lastT = 0;
  try {
    await sc.start(
      { facingMode: 'environment' },
      { fps: 12, qrbox: (w, hh) => ({ width: Math.floor(Math.min(w * 0.9, 380)), height: Math.floor(Math.min(hh * 0.55, 170)) }) },
      (text) => {
        const now = Date.now();
        if (text === last && now - lastT < 2000) return; // aynı barkodu art arda okumasın
        last = text; lastT = now;
        feedback(true);
        onCode(String(text).trim());
      },
      () => {}
    );
  } catch (e) {
    S.scanner = null; slot.innerHTML = '';
    onStop && onStop();
    toast('Kamera açılamadı. Adres https olmalı ve kamera izni verilmeli. (' + errMsg(e) + ')', 'err', 6000);
  }
}

async function stopScanner() {
  const sc = S.scanner, slot = S.scanSlot, cb = S.scanOnStop;
  S.scanner = null; S.scanSlot = null; S.scanOnStop = null;
  if (sc) { try { await sc.stop(); } catch {} try { sc.clear(); } catch {} }
  if (slot) slot.innerHTML = '';
  cb && cb();
}

// Kamera + elle yazma kutusu. PC'de USB barkod okuyucu da bu kutuya yazar.
function scanBox(onCode, placeholder = 'Barkod okut / yaz') {
  const el = h(`<div class="scanbox">
    <div class="scan-slot"></div>
    <div class="row">
      <button class="btn primary cam">📷 Kamera</button>
      <input class="inp code" inputmode="numeric" placeholder="${esc(placeholder)}" autocomplete="off" enterkeyhint="search">
      <button class="btn go">Ara</button>
    </div></div>`);
  const slot = $('.scan-slot', el), cam = $('.cam', el), inp = $('.code', el);
  const submit = () => { const v = inp.value.trim(); if (v) { inp.value = ''; onCode(v); } };
  inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } });
  $('.go', el).onclick = submit;
  const reset = () => { cam.textContent = '📷 Kamera'; };
  cam.onclick = async () => {
    if (S.scanner && S.scanSlot === slot) { await stopScanner(); return; }
    cam.textContent = '⏹ Kapat';
    await openScanner(slot, onCode, reset);
  };
  return el;
}

// ---------------------------------------------------------------- veri yardımcıları
function barcodeVariants(code) {
  const v = new Set([code]);
  if (/^\d{12}$/.test(code)) v.add('0' + code);          // UPC-A ↔ EAN-13
  if (/^0\d{12}$/.test(code)) v.add(code.slice(1));
  return [...v];
}

async function findByBarcode(code) {
  const { data, error } = await S.sb.from('products').select('*').in('barcode', barcodeVariants(code)).limit(1);
  if (error) throw error;
  return data[0] || null;
}

async function loadAllProducts(force = false) {
  if (S.products && !force) return S.products;
  const all = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await S.sb.from('products').select('*').order('name').range(from, from + 999);
    if (error) throw error;
    all.push(...data);
    if (data.length < 1000) break;
  }
  S.products = all;
  return all;
}
const invalidateProducts = () => { S.products = null; };

function stockBadge(p) {
  const st = Number(p.stock), min = Number(p.min_stock);
  const cls = st <= 0 ? 'red' : st <= min ? 'orange' : 'green';
  return `<span class="badge ${cls}">${num(st)} ${esc(p.unit)}</span>`;
}
const thumb = (p, cls = 'thumb') =>
  p.image_url ? `<img class="${cls}" src="${esc(p.image_url)}" alt="" loading="lazy" onerror="this.style.visibility='hidden'">` : `<div class="${cls} noimg">📦</div>`;

// İnternetten ürün bilgisi (Open Food Facts ailesi — ücretsiz, anahtar gerekmez)
async function lookupOnline(code) {
  const bases = ['https://world.openfoodfacts.org', 'https://world.openproductsfacts.org', 'https://world.openbeautyfacts.org'];
  const fields = 'product_name,product_name_tr,generic_name,brands,quantity,image_front_small_url,image_front_url,image_url,categories';
  for (const b of bases) {
    try {
      const r = await fetch(`${b}/api/v2/product/${encodeURIComponent(code)}.json?fields=${fields}`);
      if (!r.ok) continue;
      const j = await r.json();
      if (j.status === 1 && j.product) {
        const p = j.product;
        let name = (p.product_name_tr || p.product_name || p.generic_name || '').trim();
        if (p.quantity && !name.toLowerCase().includes(String(p.quantity).toLowerCase())) name = `${name} ${p.quantity}`.trim();
        return {
          name,
          brand: (p.brands || '').split(',')[0].trim(),
          image: p.image_front_small_url || p.image_front_url || p.image_url || '',
          category: ((p.categories || '').split(',').pop() || '').trim(),
        };
      }
    } catch {}
  }
  return null;
}

function resizeImage(file, max = 320) {
  return new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => {
      const s = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * s); c.height = Math.round(img.height * s);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(img.src);
      res(c.toDataURL('image/jpeg', 0.75));
    };
    img.onerror = rej;
    img.src = URL.createObjectURL(file);
  });
}

// ---------------------------------------------------------------- pencere (modal)
function modal(title, body, { onClose, wide } = {}) {
  const m = h(`<div class="modal"><div class="sheet ${wide ? 'wide' : ''}">
    <div class="sheet-h"><b>${esc(title)}</b><button class="x" aria-label="Kapat">✕</button></div>
    <div class="sheet-b"></div></div></div>`);
  $('.sheet-b', m).append(body);
  const close = async () => {
    if (S.scanSlot && m.contains(S.scanSlot)) await stopScanner();
    m.remove(); onClose && onClose();
  };
  $('.x', m).onclick = close;
  m.addEventListener('click', (e) => { if (e.target === m) close(); });
  document.body.append(m);
  return { el: m, close };
}

// =====================================================================
//  AÇILIŞ / GİRİŞ
// =====================================================================
async function boot() {
  S.cfg = loadCfg();
  document.title = S.cfg.name;
  if (!S.cfg.url || !S.cfg.key) return renderSetup();
  try {
    S.sb = window.supabase.createClient(S.cfg.url, S.cfg.key, { auth: { persistSession: true, autoRefreshToken: true } });
  } catch (e) { toast('Bağlantı ayarı hatalı: ' + errMsg(e), 'err'); return renderSetup(); }
  const { data: { session } } = await S.sb.auth.getSession();
  if (!session) return renderLogin();
  await afterLogin(session.user);
}

function renderSetup() {
  $('#app').innerHTML = '';
  const el = h(`<div class="center"><div class="card login">
    <h2>🛒 İlk kurulum</h2>
    <p class="muted">Supabase panelinden <b>Project Settings → API</b> sayfasındaki bilgileri girin. Bu ekran her telefonda bir kez çıkar.</p>
    <label>Market adı<input class="inp" id="cName" value="${esc(S.cfg.name)}"></label>
    <label>Project URL<input class="inp" id="cUrl" placeholder="https://xxxx.supabase.co" value="${esc(S.cfg.url)}"></label>
    <label>anon / publishable key<textarea class="inp" id="cKey" rows="3">${esc(S.cfg.key)}</textarea></label>
    <button class="btn primary big" id="cSave">Kaydet</button></div></div>`);
  $('#app').append(el);
  $('#cSave').onclick = () => {
    const url = $('#cUrl').value.trim().replace(/\/+$/, ''), key = $('#cKey').value.trim();
    if (!/^https:\/\//.test(url) || key.length < 20) return toast('URL https:// ile başlamalı, key eksiksiz olmalı', 'err');
    saveCfg({ url, key, name: $('#cName').value.trim() || 'Market' });
    boot();
  };
}

async function renderLogin() {
  $('#app').innerHTML = '<div class="center muted">Bağlanıyor…</div>';
  try {
    const { data: needs, error } = await S.sb.rpc('needs_setup');
    if (error) throw error;
    if (needs) return renderFirstAdmin();
  } catch (e) {
    $('#app').innerHTML = '';
    $('#app').append(h(`<div class="center"><div class="card err login">Sunucuya bağlanılamadı: ${esc(errMsg(e))}
      <button class="btn" onclick="location.reload()">Tekrar dene</button></div></div>`));
    return;
  }
  $('#app').innerHTML = '';
  const el = h(`<div class="center"><form class="card login">
    <h2>🛒 ${esc(S.cfg.name)}</h2>
    <label>Kullanıcı adı veya e-posta<input class="inp" id="lUser" autocomplete="username" autocapitalize="none" required></label>
    <label>Şifre<input class="inp" id="lPass" type="password" autocomplete="current-password" required></label>
    <button class="btn primary big" type="submit">Giriş</button>
    <button class="btn ghost small" type="button" id="lCfg">Bağlantı ayarları</button></form></div>`);
  $('#app').append(el);
  if (S.cfg.fromFile) $('#lCfg').remove(); else $('#lCfg').onclick = renderSetup;
  el.querySelector('form').onsubmit = async (e) => {
    e.preventDefault();
    const btn = e.submitter || $('button[type=submit]', el);
    await busy(btn, async () => {
      let u = $('#lUser').value.trim().toLowerCase();
      if (!u.includes('@')) u += '@market.local';
      const { data, error } = await S.sb.auth.signInWithPassword({ email: u, password: $('#lPass').value });
      if (error) throw new Error(error.message.includes('Invalid') ? 'Kullanıcı adı veya şifre yanlış' : error.message);
      await afterLogin(data.user);
    });
  };
}

function renderFirstAdmin() {
  $('#app').innerHTML = '';
  const el = h(`<div class="center"><form class="card login">
    <h2>👋 Hoş geldiniz</h2>
    <p class="muted small">Sistemde henüz kullanıcı yok. Önce <b>yönetici (patron)</b> hesabınızı oluşturun. Elemanları sonra Ayarlar ekranından eklersiniz.</p>
    <label>Adınız<input class="inp" id="fa_name" required></label>
    <label>Kullanıcı adı <span class="small">(Türkçe karakter yok, örn: umut)</span><input class="inp" id="fa_user" autocapitalize="none" autocomplete="username" required></label>
    <label>Şifre (en az 6)<input class="inp" id="fa_pass" type="password" autocomplete="new-password" required></label>
    <label>Şifre tekrar<input class="inp" id="fa_pass2" type="password" autocomplete="new-password" required></label>
    <button class="btn primary big" type="submit">Hesabı oluştur ve gir</button></form></div>`);
  $('#app').append(el);
  el.querySelector('form').onsubmit = async (e) => {
    e.preventDefault();
    await busy($('button[type=submit]', el), async () => {
      const u = $('#fa_user').value.trim().toLowerCase(), p = $('#fa_pass').value;
      if (p !== $('#fa_pass2').value) throw new Error('Şifreler aynı değil');
      const { error } = await S.sb.rpc('setup_first_admin', { p_username: u, p_password: p, p_full_name: $('#fa_name').value.trim() });
      if (error) throw error;
      const { data, error: e2 } = await S.sb.auth.signInWithPassword({ email: u + '@market.local', password: p });
      if (e2) throw e2;
      toast('Yönetici hesabı oluşturuldu ✓');
      await afterLogin(data.user);
    });
  };
}

async function afterLogin(user) {
  S.user = user;
  const { data, error } = await S.sb.from('profiles').select('*').eq('id', user.id).maybeSingle();
  if (error || !data) {
    toast('Kullanıcı profili bulunamadı. Veritabanı kurulumu (schema.sql) yapıldı mı?', 'err', 6000);
    await S.sb.auth.signOut();
    return renderLogin();
  }
  if (data.active === false) {
    toast('Bu kullanıcı pasif yapılmış. Yöneticiye başvurun.', 'err', 6000);
    await S.sb.auth.signOut();
    return renderLogin();
  }
  S.profile = data;
  S.isAdmin = data.role === 'admin';
  try { S.cart = JSON.parse(localStorage.getItem('cart') || '[]'); } catch { S.cart = []; }
  renderShell();
  go('satis');
}

async function logout() {
  await stopScanner();
  await S.sb.auth.signOut();
  S.profile = null; S.products = null;
  renderLogin();
}

// =====================================================================
//  ANA ÇERÇEVE
// =====================================================================
const NAV = [
  { id: 'satis', ic: '🛒', t: 'Satış' },
  { id: 'urunler', ic: '📦', t: 'Ürünler', admin: true },
  { id: 'fatura', ic: '🧾', t: 'Fatura', admin: true },
  { id: 'sayim', ic: '🔢', t: 'Sayım', admin: true },
  { id: 'rapor', ic: '📊', t: 'Rapor', admin: true },
];

function renderShell() {
  const items = NAV.filter((n) => !n.admin || S.isAdmin);
  $('#app').innerHTML = `
    <header class="top"><b>${esc(S.cfg.name)}</b>
      <span class="muted small">${esc(S.profile.full_name || '')}${S.isAdmin ? ' · yönetici' : ''}</span>
      <span class="sp"></span>
      ${S.isAdmin ? '<button class="btn ghost small" id="btnSet">⚙️</button>' : ''}
      <button class="btn ghost small" id="btnOut">Çıkış</button></header>
    <main id="view"></main>
    ${items.length > 1 ? `<nav class="bottom">${items.map((n) => `<button data-v="${n.id}"><span>${n.ic}</span>${n.t}</button>`).join('')}</nav>` : ''}`;
  $('#btnOut').onclick = logout;
  if (S.isAdmin) $('#btnSet').onclick = () => go('ayarlar');
  $$('nav.bottom button').forEach((b) => (b.onclick = () => go(b.dataset.v)));
}

const VIEWS = {};
async function go(v) {
  await stopScanner();
  $$('nav.bottom button').forEach((b) => b.classList.toggle('on', b.dataset.v === v));
  const view = $('#view');
  view.innerHTML = '';
  view.scrollTop = 0;
  try { await VIEWS[v](view); } catch (e) { view.append(h(`<div class="card err">${esc(errMsg(e))}</div>`)); }
}

// =====================================================================
//  SATIŞ / FİYAT GÖRME
// =====================================================================
const saveCart = () => localStorage.setItem('cart', JSON.stringify(S.cart));

VIEWS.satis = (v) => {
  const auto = localStorage.getItem('autoAdd') === '1';
  v.append(scanBox(onScan));
  v.append(h(`<label class="switch"><input type="checkbox" id="autoAdd" ${auto ? 'checked' : ''}> Okutunca direkt sepete ekle</label>`));
  v.append(h('<div id="lastProd"></div>'));
  v.append(h(`<div class="card">
    <div class="card-h">Sepet <span class="muted" id="cartCount"></span><span class="sp"></span><button class="btn small ghost" id="cartClear">Temizle</button></div>
    <div id="cartList"></div>
    <div class="total">Toplam <b id="cartTotal">${tl(0)}</b></div>
    <div class="row"><button class="btn big green" id="payCash">💵 Nakit</button><button class="btn big blue" id="payCard">💳 Kart</button></div>
  </div>`));
  $('#autoAdd').onchange = (e) => localStorage.setItem('autoAdd', e.target.checked ? '1' : '0');
  $('#cartClear').onclick = () => { if (S.cart.length && confirm('Sepet temizlensin mi?')) { S.cart = []; saveCart(); renderCart(); } };
  $('#payCash').onclick = (e) => finishSale('nakit', e.currentTarget);
  $('#payCard').onclick = (e) => finishSale('kart', e.currentTarget);
  renderCart();

  async function onScan(code) {
    const box = $('#lastProd');
    if (!box) return;
    box.innerHTML = '<div class="card muted">Aranıyor…</div>';
    let p;
    try { p = await findByBarcode(code); } catch (e) { box.innerHTML = ''; return toast(errMsg(e), 'err'); }
    if (!p) {
      feedback(false);
      box.innerHTML = '';
      const c = h(`<div class="card warn"><b>Kayıtlı değil:</b> ${esc(code)}
        ${S.isAdmin ? '<div class="row"><button class="btn primary" id="lpAdd">+ Ürün olarak ekle</button></div>' : '<div class="muted small">Yöneticiye haber verin.</div>'}</div>`);
      box.append(c);
      if (S.isAdmin) $('#lpAdd', c).onclick = () => openProductForm({ barcode: code }, (np) => onScan(np.barcode));
      return;
    }
    renderLast(p);
    if ($('#autoAdd').checked) addToCart(p, 1);
  }

  function renderLast(p) {
    const box = $('#lastProd');
    box.innerHTML = '';
    const c = h(`<div class="card prod">
      ${thumb(p, 'pimg')}
      <div class="pinfo">
        <div class="pname">${esc(p.name)}</div>
        <div class="muted small">${esc(p.barcode)}${p.brand ? ' · ' + esc(p.brand) : ''}</div>
        <div class="price">${Number(p.price) > 0 ? tl(p.price) : '<span class="neg">Fiyat yok</span>'}</div>
        <div>Stok: ${stockBadge(p)} ${p.active ? '' : '<span class="badge red">pasif</span>'}</div>
      </div>
      <div class="row">
        <input class="inp qty" value="1" inputmode="decimal" aria-label="Miktar">
        <button class="btn primary" id="lpCart">+ Sepete</button>
        ${S.isAdmin ? '<button class="btn ghost" id="lpEdit">Düzenle</button>' : ''}
      </div></div>`);
    box.append(c);
    $('#lpCart', c).onclick = () => {
      const q = toNum($('.qty', c).value);
      if (!q || q <= 0) return toast('Miktar hatalı', 'err');
      addToCart(p, q);
    };
    if (S.isAdmin) $('#lpEdit', c).onclick = () => openProductForm(p, (np) => renderLast(np));
  }

  function addToCart(p, q) {
    if (!(Number(p.price) > 0)) {
      feedback(false);
      return toast('Bu ürünün satış fiyatı girilmemiş. Yöneticiye haber verin.', 'err', 5000);
    }
    const ex = S.cart.find((i) => i.id === p.id);
    if (ex) ex.qty = Math.round((ex.qty + q) * 1000) / 1000;
    else S.cart.unshift({ id: p.id, name: p.name, price: Number(p.price), unit: p.unit, qty: q });
    saveCart(); renderCart();
    toast(`${p.name} sepete eklendi`, 'ok', 1200);
  }
};

function renderCart() {
  const list = $('#cartList');
  if (!list) return;
  let total = 0;
  list.innerHTML = '';
  if (!S.cart.length) list.innerHTML = '<div class="muted empty">Sepet boş</div>';
  S.cart.forEach((it, idx) => {
    const line = Math.round(it.price * it.qty * 100) / 100;
    total += line;
    const r = h(`<div class="cline">
      <div class="cname">${esc(it.name)}<div class="muted small">${tl(it.price)} / ${esc(it.unit)}</div></div>
      <div class="qtybox"><button class="btn small" data-a="-">−</button><input class="inp qty" value="${num(it.qty)}" inputmode="decimal"><button class="btn small" data-a="+">+</button></div>
      <div class="ctot">${tl(line)}</div>
      <button class="btn small ghost" data-a="x">✕</button></div>`);
    r.addEventListener('click', (e) => {
      const a = e.target.dataset && e.target.dataset.a;
      if (!a) return;
      if (a === 'x') S.cart.splice(idx, 1);
      if (a === '+') it.qty = Math.round((it.qty + 1) * 1000) / 1000;
      if (a === '-') { it.qty = Math.round((it.qty - 1) * 1000) / 1000; if (it.qty <= 0) S.cart.splice(idx, 1); }
      saveCart(); renderCart();
    });
    $('input', r).onchange = (e) => {
      const q = toNum(e.target.value);
      if (!q || q <= 0) S.cart.splice(idx, 1); else it.qty = q;
      saveCart(); renderCart();
    };
    list.append(r);
  });
  $('#cartTotal').textContent = tl(total);
  $('#cartCount').textContent = S.cart.length ? `(${S.cart.length} kalem)` : '';
}

async function finishSale(payment, btn) {
  if (!S.cart.length) return toast('Sepet boş', 'err');
  const total = S.cart.reduce((s, i) => s + Math.round(i.price * i.qty * 100) / 100, 0);
  if (!confirm(`${payment === 'kart' ? 'KART' : 'NAKİT'} satış\nToplam: ${tl(total)}\nOnaylıyor musunuz?`)) return;
  await busy(btn, async () => {
    const items = S.cart.map((i) => ({ product_id: i.id, qty: i.qty }));
    const { data, error } = await S.sb.rpc('make_sale', { p_items: items, p_payment: payment });
    if (error) throw error;
    S.cart = []; saveCart(); renderCart();
    $('#lastProd') && ($('#lastProd').innerHTML = '');
    feedback(true);
    toast(`Satış tamam ✓  ${tl(data.total)}`, 'ok', 4000);
    if (data.negative && data.negative.length)
      toast('Dikkat, stokta görünmeyen ürün satıldı: ' + data.negative.map((n) => n.name).join(', '), 'warn', 7000);
  });
}

// =====================================================================
//  ÜRÜN KARTI (ekle / düzenle)
// =====================================================================
async function openProductForm(p0 = {}, onSaved) {
  const isNew = !p0.id;
  const p = { unit: 'adet', min_stock: 5, active: true, ...p0 };
  let image = p.image_url || '';
  let ownBarcode = !!p.is_own_barcode;
  const cats = S.products ? [...new Set(S.products.map((x) => x.category).filter(Boolean))].sort() : [];
  const f = h(`<form class="form">
    <div class="scan-slot"></div>
    <label>Barkod
      <div class="row"><input class="inp" name="barcode" value="${esc(p.barcode || '')}" inputmode="numeric" required>
      <button type="button" class="btn" id="fScan">📷</button>
      <button type="button" class="btn" id="fGen" title="Barkodu olmayan ürüne bizim barkodumuz">Barkod üret</button></div></label>
    <button type="button" class="btn ghost" id="fWeb">🌐 İnternetten bilgi bul</button>
    <label>Ürün adı<input class="inp" name="name" value="${esc(p.name || '')}" required></label>
    <div class="grid2">
      <label>Marka<input class="inp" name="brand" value="${esc(p.brand || '')}"></label>
      <label>Kategori<input class="inp" name="category" list="catList" value="${esc(p.category || '')}"></label>
    </div>
    <datalist id="catList">${cats.map((c) => `<option value="${esc(c)}">`).join('')}</datalist>
    <div class="grid2">
      <label>Satış fiyatı (KDV dahil)<input class="inp" name="price" inputmode="decimal" value="${p.price != null ? num(p.price) : ''}" required></label>
      <label>Alış maliyeti<input class="inp" name="cost" inputmode="decimal" value="${p.cost != null ? num(p.cost) : ''}"></label>
    </div>
    <div class="grid3">
      <label>Birim<select class="inp" name="unit">${['adet', 'kg', 'lt', 'paket', 'koli', 'metre'].map((u) => `<option ${u === p.unit ? 'selected' : ''}>${u}</option>`).join('')}</select></label>
      <label>${isNew ? 'Başlangıç stoğu' : 'Stok'}<input class="inp" name="stock" inputmode="decimal" value="${p.stock != null ? num(p.stock) : ''}"></label>
      <label>Uyarı (min)<input class="inp" name="min_stock" inputmode="decimal" value="${num(p.min_stock)}"></label>
    </div>
    <div class="imgrow">
      <div id="fImg">${image ? `<img class="pimg" src="${esc(image)}">` : '<div class="pimg noimg">📦</div>'}</div>
      <div class="col">
        <label class="btn ghost">📸 Fotoğraf çek/seç<input type="file" accept="image/*" capture="environment" id="fPhoto" hidden></label>
        <button type="button" class="btn ghost small" id="fImgDel">Resmi kaldır</button>
      </div>
    </div>
    ${p.list_price ? `<div class="infobox small">Üretici kodu: <b>${esc(p.product_code || '-')}</b> · Liste fiyatı: <b>${num(p.list_price)} ${esc(p.list_currency)}</b> (KDV hariç)<br>
      <label class="switch small"><input type="checkbox" name="price_auto" ${p.price_auto !== false ? 'checked' : ''}> Satış fiyatını marka kuralından otomatik hesapla</label>
      <span class="muted">Fiyatı elle değiştirirsen otomatik hesaplama bu ürün için kapanır.</span></div>` : ''}
    <label class="switch"><input type="checkbox" name="active" ${p.active ? 'checked' : ''}> Satışta (aktif)</label>
    <div class="row"><button class="btn primary big" type="submit">Kaydet</button>
      ${isNew ? '' : '<button type="button" class="btn red" id="fDel">Sil</button>'}</div>
    ${isNew ? '' : '<button type="button" class="btn ghost small" id="fHist">Stok geçmişi</button><div id="fHistBox"></div>'}
  </form>`);
  const fe = (n) => f.elements.namedItem(n);
  const m = modal(isNew ? 'Yeni ürün' : 'Ürün düzenle', f);
  const setImg = (src) => { image = src; $('#fImg', f).innerHTML = src ? `<img class="pimg" src="${esc(src)}">` : '<div class="pimg noimg">📦</div>'; };

  $('#fScan', f).onclick = () => openScanner($('.scan-slot', f), async (code) => {
    fe("barcode").value = code; ownBarcode = false; await stopScanner();
  });
  $('#fGen', f).onclick = (e) => busy(e.currentTarget, async () => {
    const { data, error } = await S.sb.rpc('next_own_barcode');
    if (error) throw error;
    fe("barcode").value = data; ownBarcode = true;
  });
  $('#fWeb', f).onclick = (e) => busy(e.currentTarget, async () => {
    const code = fe("barcode").value.trim();
    if (!code) return toast('Önce barkodu girin', 'err');
    const r = await lookupOnline(code);
    if (!r || !r.name) {
      toast('İnternet veritabanında bulunamadı. Google sekmesi açılıyor…', 'warn', 4000);
      window.open(`https://www.google.com/search?q=${encodeURIComponent(code)}`, '_blank');
      return;
    }
    if (!fe("name").value || confirm(`Bulundu: ${r.name}\nAd bu olsun mu?`)) fe("name").value = r.name;
    if (r.brand && !fe("brand").value) fe("brand").value = r.brand;
    if (r.image && !image) setImg(r.image);
    toast('Bilgiler dolduruldu, kontrol edin', 'ok');
  });
  $('#fPhoto', f).onchange = async (e) => {
    const file = e.target.files[0];
    if (file) { try { setImg(await resizeImage(file)); } catch { toast('Resim okunamadı', 'err'); } }
  };
  $('#fImgDel', f).onclick = () => setImg('');

  if (!isNew) {
    $('#fDel', f).onclick = (e) => busy(e.currentTarget, async () => {
      if (!confirm(`"${p.name}" silinsin mi?\n(Satış geçmişi varsa silinemez; bunun yerine "Satışta" işaretini kaldırın.)`)) return;
      const { error } = await S.sb.from('products').delete().eq('id', p.id);
      if (error) throw new Error(error.code === '23503' ? 'Bu ürünün satış geçmişi var. Silmek yerine pasif yapın.' : error.message);
      invalidateProducts(); m.close(); toast('Silindi'); onSaved && onSaved(null);
    });
    $('#fHist', f).onclick = (e) => busy(e.currentTarget, async () => {
      const { data, error } = await S.sb.from('stock_movements').select('*').eq('product_id', p.id).order('created_at', { ascending: false }).limit(30);
      if (error) throw error;
      const names = { satis: 'Satış', fatura: 'Fatura', sayim: 'Sayım', iptal: 'İptal', toplu: 'Toplu' };
      $('#fHistBox', f).innerHTML = `<table class="tbl">${data.map((r) => `<tr><td>${new Date(r.created_at).toLocaleString('tr-TR', { dateStyle: 'short', timeStyle: 'short' })}</td><td>${names[r.type] || r.type}</td><td class="${r.change < 0 ? 'neg' : 'pos'}">${r.change > 0 ? '+' : ''}${num(r.change)}</td><td class="muted small">${esc(r.note || '')}</td></tr>`).join('') || '<tr><td>Kayıt yok</td></tr>'}</table>`;
    });
  }

  f.onsubmit = async (e) => {
    e.preventDefault();
    await busy($('button[type=submit]', f), async () => {
      const price = toNum(fe("price").value);
      if (price == null || price < 0) throw new Error('Satış fiyatı hatalı');
      const row = {
        barcode: fe("barcode").value.trim(),
        name: fe("name").value.trim(),
        brand: fe("brand").value.trim() || null,
        category: fe("category").value.trim() || null,
        unit: fe("unit").value,
        price,
        cost: toNum(fe("cost").value),
        min_stock: toNum(fe("min_stock").value) ?? 0,
        image_url: image || null,
        active: fe("active").checked,
        is_own_barcode: ownBarcode,
      };
      if (fe('price_auto')) {
        row.price_auto = fe('price_auto').checked;
        if (row.price_auto && p.id && Number(p.price) !== price) row.price_auto = false; // elle değiştirildi
      }
      if (!row.barcode || !row.name) throw new Error('Barkod ve ad zorunlu');
      let saved;
      if (isNew) {
        const { data, error } = await S.sb.from('products').insert(row).select().single();
        if (error) throw new Error(error.code === '23505' ? 'Bu barkod başka bir üründe kayıtlı' : error.message);
        saved = data;
      } else {
        const { data, error } = await S.sb.from('products').update(row).eq('id', p.id).select().single();
        if (error) throw new Error(error.code === '23505' ? 'Bu barkod başka bir üründe kayıtlı' : error.message);
        saved = data;
      }
      const newStock = toNum(fe("stock").value);
      if (newStock != null && newStock !== Number(saved.stock)) {
        const { error } = await S.sb.rpc('set_stock', { p_product_id: saved.id, p_new_stock: newStock, p_note: isNew ? 'Başlangıç stoğu' : 'Ürün kartından' });
        if (error) throw error;
        saved.stock = newStock;
      }
      invalidateProducts();
      toast('Kaydedildi ✓');
      m.close();
      onSaved && onSaved(saved);
    });
  };
}

// =====================================================================
//  ÜRÜNLER
// =====================================================================
VIEWS.urunler = async (v) => {
  v.append(h(`<div>
    <div class="row"><input class="inp" id="pSearch" placeholder="Ürün adı veya barkod ara" autocomplete="off"><button class="btn primary" id="pNew">+ Yeni</button></div>
    <div class="chips">
      <button class="chip on" data-f="all">Tümü</button><button class="chip" data-f="low">Azalan</button>
      <button class="chip" data-f="out">Biten</button><button class="chip" data-f="own">Kendi barkodlu</button>
      <button class="chip" data-f="passive">Pasif</button><button class="chip" data-f="noprice">Fiyatsız</button><button class="chip" data-f="instock">Stokta olan</button></div>
    <select class="inp" id="pBrand"><option value="">Tüm markalar</option></select>
    <div class="row wrap">
      <label class="btn ghost small">📥 Excel/CSV yükle<input type="file" accept=".csv,text/csv" id="pCsv" hidden></label>
      <button class="btn ghost small" id="pExport">📤 Listeyi indir</button>
      <button class="btn ghost small" id="pLabels">🏷️ Etiket yazdır</button></div>
    <div class="muted small" id="pInfo"></div>
    <div id="pList" class="list"></div></div>`));
  let filter = 'all', shown = [];
  const all = await loadAllProducts(true);

  const draw = () => {
    const q = $('#pSearch').value.trim().toLocaleLowerCase('tr');
    const items = S.products.filter((p) => {
      if (filter === 'low' && !(p.active && Number(p.stock) <= Number(p.min_stock) && Number(p.stock) > 0)) return false;
      if (filter === 'out' && !(p.active && Number(p.stock) <= 0)) return false;
      if (filter === 'own' && !p.is_own_barcode) return false;
      if (filter === 'passive' && p.active) return false;
      if (filter === 'noprice' && Number(p.price) > 0) return false;
      if (filter === 'instock' && !(Number(p.stock) > 0)) return false;
      const br = $('#pBrand').value;
      if (br && p.brand !== br) return false;
      if (q && !(p.name.toLocaleLowerCase('tr').includes(q) || p.barcode.includes(q) || (p.product_code || '').toLocaleLowerCase('tr').includes(q))) return false;
      return true;
    });
    shown = items;
    $('#pInfo').textContent = `${items.length} ürün${items.length > 300 ? ' (ilk 300 gösteriliyor, arama yapın)' : ''}`;
    $('#pList').innerHTML = items.slice(0, 300).map((p) => `
      <div class="litem" data-id="${p.id}">${thumb(p)}
        <div class="lmain"><div>${esc(p.name)}</div><div class="muted small">${esc(p.barcode)}${p.category ? ' · ' + esc(p.category) : ''}</div></div>
        <div class="lright"><b>${tl(p.price)}</b>${stockBadge(p)}</div></div>`).join('') || '<div class="muted empty">Ürün yok</div>';
  };
  draw();
  if (!all.length) $('#pInfo').innerHTML = 'Henüz ürün yok. <b>+ Yeni</b> ile tek tek, <b>Sayım</b> ekranından okutarak veya <b>Excel/CSV yükle</b> ile toplu ekleyin.';

  const brands = [...new Set(S.products.map((p) => p.brand).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'tr'));
  $('#pBrand').innerHTML += brands.map((b) => `<option>${esc(b)}</option>`).join('');
  $('#pBrand').onchange = draw;
  $('#pSearch').oninput = draw;
  $$('.chip', v).forEach((c) => (c.onclick = () => { $$('.chip', v).forEach((x) => x.classList.remove('on')); c.classList.add('on'); filter = c.dataset.f; draw(); }));
  $('#pList').onclick = (e) => {
    const it = e.target.closest('.litem');
    if (!it) return;
    const p = S.products.find((x) => x.id === Number(it.dataset.id));
    openProductForm(p, async () => { await loadAllProducts(true); draw(); });
  };
  $('#pNew').onclick = () => openProductForm({}, async () => { await loadAllProducts(true); draw(); });
  $('#pExport').onclick = () => exportCsv(shown);
  $('#pLabels').onclick = () => openLabels(shown);
  $('#pCsv').onchange = async (e) => {
    const file = e.target.files[0]; e.target.value = '';
    if (file) await importCsv(file, async () => { await loadAllProducts(true); draw(); });
  };
};

// ---------- CSV
function parseCsv(text) {
  text = text.replace(/^﻿/, '');
  const first = text.split(/\r?\n/)[0] || '';
  const d = (first.match(/;/g) || []).length >= (first.match(/,/g) || []).length ? ';' : ',';
  const rows = []; let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c; }
    else if (c === '"') q = true;
    else if (c === d) { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim()));
}

async function importCsv(file, done) {
  const rows = parseCsv(await file.text());
  if (rows.length < 2) return toast('Dosyada satır yok', 'err');
  const head = rows[0].map((x) => x.trim().toLocaleLowerCase('tr'));
  const find = (...names) => head.findIndex((x) => names.some((n) => x.includes(n)));
  const col = {
    barcode: find('barkod', 'barcode'), name: find('ürün', 'urun', 'ad', 'isim', 'name'),
    price: find('fiyat', 'price'), stock: find('stok', 'miktar', 'adet'),
    min_stock: find('min', 'uyarı'), unit: find('birim', 'unit'), category: find('kategori', 'grup'),
  };
  if (col.stock === col.min_stock) col.stock = head.findIndex((x) => (x.includes('stok') || x.includes('miktar')) && !x.includes('min'));
  if (col.barcode < 0 || col.name < 0) return toast('İlk satırda en az "Barkod" ve "Ürün adı" başlıkları olmalı', 'err', 6000);
  const get = (r, k) => (col[k] >= 0 ? (r[col[k]] || '').trim() : '');
  const numStr = (s) => { const n = toNum(s); return n == null ? '' : String(n); };
  const data = rows.slice(1).map((r) => ({
    barcode: get(r, 'barcode'), name: get(r, 'name'), price: numStr(get(r, 'price')),
    stock: numStr(get(r, 'stock')), min_stock: numStr(get(r, 'min_stock')),
    unit: get(r, 'unit').toLocaleLowerCase('tr'), category: get(r, 'category'),
  })).filter((r) => r.barcode && r.name);
  if (!confirm(`${data.length} ürün yüklenecek. Aynı barkodlu ürünler güncellenir. Devam?`)) return;
  let ins = 0, upd = 0;
  for (let i = 0; i < data.length; i += 500) {
    const { data: r, error } = await S.sb.rpc('import_products', { p_rows: data.slice(i, i + 500) });
    if (error) return toast(errMsg(error), 'err', 6000);
    ins += r?.eklenen || 0; upd += r?.guncellenen || 0;
  }
  toast(`${ins} yeni ürün eklendi, ${upd} ürün güncellendi`, 'ok', 5000);
  done && done();
}

function exportCsv(list) {
  const q = (s) => `"${String(s ?? '').replace(/"/g, '""')}"`;
  const fmt = (n) => (n == null ? '' : String(n).replace('.', ','));
  const lines = ['Barkod;Ürün adı;Marka;Kategori;Birim;Fiyat;Maliyet;Stok;Min stok;Aktif'];
  for (const p of list) lines.push([q(p.barcode), q(p.name), q(p.brand), q(p.category), q(p.unit), fmt(p.price), fmt(p.cost), fmt(p.stock), fmt(p.min_stock), p.active ? 'Evet' : 'Hayır'].join(';'));
  const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `urunler-${todayStr()}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

// ---------- ETİKET
function openLabels(list) {
  if (!list.length) return toast('Listede ürün yok', 'err');
  const items = list.slice(0, 300);
  const body = h(`<div>
    <p class="muted small">A4 kâğıda 3×8 = 24 etiket sığar. Yazdırma ekranında "Kenar boşluğu: Yok / Ölçek %100" seçin.</p>
    <div class="row"><label class="switch"><input type="checkbox" id="lAll" checked> Hepsini seç</label>
      <label class="switch"><input type="checkbox" id="lBar" checked> Barkod bas</label></div>
    <div class="list">${items.map((p) => `<div class="litem nohover"><input type="checkbox" class="lchk" data-id="${p.id}" checked>
      <div class="lmain">${esc(p.name)}<div class="muted small">${tl(p.price)}</div></div>
      <input class="inp qty lcnt" data-id="${p.id}" value="1" inputmode="numeric" aria-label="Adet"></div>`).join('')}</div>
    <button class="btn primary big" id="lPrint">🖨️ Yazdır</button></div>`);
  const m = modal('Etiket yazdır', body);
  $('#lAll', body).onchange = (e) => $$('.lchk', body).forEach((c) => (c.checked = e.target.checked));
  $('#lPrint', body).onclick = () => {
    const withBar = $('#lBar', body).checked;
    const area = $('#printArea');
    area.innerHTML = '';
    for (const p of items) {
      if (!$(`.lchk[data-id="${p.id}"]`, body).checked) continue;
      const n = Math.max(0, Math.min(200, parseInt($(`.lcnt[data-id="${p.id}"]`, body).value, 10) || 0));
      for (let i = 0; i < n; i++) {
        const lab = h(`<div class="label"><div class="lname">${esc(p.name)}</div><div class="lprice">${tl(p.price)}</div>${withBar ? '<svg class="lbar"></svg>' : `<div class="lcode">${esc(p.barcode)}</div>`}</div>`);
        if (withBar) {
          const svg = $('svg', lab);
          const fmt = /^\d{13}$/.test(p.barcode) ? 'EAN13' : /^\d{8}$/.test(p.barcode) ? 'EAN8' : 'CODE128';
          try { window.JsBarcode(svg, p.barcode, { format: fmt, height: 34, width: 1.6, fontSize: 12, margin: 0 }); }
          catch { try { window.JsBarcode(svg, p.barcode, { format: 'CODE128', height: 34, width: 1.4, fontSize: 12, margin: 0 }); } catch {} }
        }
        area.append(lab);
      }
    }
    if (!area.children.length) return toast('Seçili etiket yok', 'err');
    m.close();
    setTimeout(() => window.print(), 300);
  };
}

// =====================================================================
//  E-FATURA → STOK GİRİŞİ
// =====================================================================
VIEWS.fatura = (v) => {
  v.append(h(`<div>
    <div class="card">
      <b>E-fatura ile stok girişi</b>
      <p class="muted small">Tedarikçiden gelen e-faturanın <b>PDF</b>'ini, <b>XML</b>'ini veya içinde XML olan <b>ZIP</b>'i seçin (Ticari Bulut, GİB portalı, Uyumsoft, Logo vb. "gelen faturalar"dan indirilir). Birden fazla dosya seçebilirsiniz. PDF'te rakamlar faturadaki toplamla karşılaştırılır; tutmazsa uyarı çıkar.</p>
      <label class="btn primary big">📂 Fatura dosyası seç<input type="file" id="invFile" accept=".pdf,.xml,.zip,application/pdf,text/xml,application/zip" multiple hidden></label>
    </div>
    <div id="invList"></div></div>`));
  $('#invFile').onchange = async (e) => {
    const files = [...e.target.files]; e.target.value = '';
    if (!files.length) return;
    const list = $('#invList');
    list.innerHTML = '<div class="card muted">Okunuyor…</div>';
    try {
      const xmls = await readInvoiceFiles(files);
      if (!xmls.length) throw new Error('Dosyada XML bulunamadı');
      await loadAllProducts(true);
      list.innerHTML = '';
      for (const x of xmls) {
        try {
          if (x.hata) throw new Error(x.hata);
          list.append(await invoiceCard(x.pdf || parseUBL(x.xml), x.fileName));
        }
        catch (err) { list.append(h(`<div class="card err">${esc(x.fileName)}: ${esc(errMsg(err))}</div>`)); }
      }
    } catch (err) { list.innerHTML = ''; toast(errMsg(err), 'err', 6000); }
  };
};

async function invoiceCard(inv, fileName) {
  const { header, lines } = inv;
  const pdf = header.kaynak === 'pdf';
  const card = h(`<div class="card invoice">
    <div class="card-h"><b>${esc(header.supplier_name || 'Tedarikçi?')}</b><span class="sp"></span><span class="muted small">${esc(header.invoice_date)}</span></div>
    <div class="muted small">Fatura no: ${esc(header.invoice_no)} · VKN: ${esc(header.supplier_vkn || '-')} · Toplam: ${tl(header.total)} · ${esc(fileName)}</div>
    <div class="ilines"></div>
    <div class="isum muted small"></div>
    <button class="btn green big iapply">✅ Stoğa ekle</button></div>`);

  if (header.uuid) {
    const { data } = await S.sb.from('invoices').select('id, created_at').eq('uuid', header.uuid).maybeSingle();
    if (data) {
      card.append(h(`<div class="warnbox">Bu fatura ${new Date(data.created_at).toLocaleDateString('tr-TR')} tarihinde zaten stoğa işlenmiş.</div>`));
      $('.iapply', card).remove();
      return card;
    }
  } else if (header.invoice_no && header.supplier_vkn) {
    // PDF'te ETTN okunamadıysa: aynı firma + aynı fatura no daha önce işlendi mi?
    const { data } = await S.sb.from('invoices').select('id, created_at').eq('invoice_no', header.invoice_no).eq('supplier_vkn', header.supplier_vkn).limit(1);
    if (data && data.length) {
      card.append(h(`<div class="warnbox">Bu fatura ${new Date(data[0].created_at).toLocaleDateString('tr-TR')} tarihinde zaten stoğa işlenmiş.</div>`));
      $('.iapply', card).remove();
      return card;
    }
  }
  if (pdf) {
    const k = inv.kontrol || { dogru: false, uyarilar: [] };
    card.insertBefore(h(k.dogru
      ? `<div class="okbox small">📄 PDF'ten okundu · ${lines.length} kalem · toplam faturadaki tutarla tuttu (${tl(k.kalem_net_toplam)} + KDV)</div>`
      : `<div class="warnbox small">📄 PDF'ten okundu ama <b>rakamları kontrol edin</b>:<br>${k.uyarilar.map(esc).join('<br>')}<br>Miktar ve maliyeti aşağıda düzeltebilirsiniz.</div>`), $('.ilines', card));
  }
  if (/IADE/i.test(header.type)) card.append(h('<div class="warnbox">Bu bir İADE faturası. Stoğa eklemek yerine sayım ekranından düşmeniz gerekebilir.</div>'));

  // Otomatik eşleştirme: önce tedarikçi kodu hafızası, sonra barkod
  const byBarcode = new Map(S.products.map((p) => [p.barcode, p]));
  const byId = new Map(S.products.map((p) => [p.id, p]));
  let supMap = new Map();
  if (header.supplier_vkn) {
    const { data } = await S.sb.from('supplier_codes').select('*').eq('supplier_vkn', header.supplier_vkn);
    supMap = new Map((data || []).map((r) => [r.supplier_code, r]));
  }
  const rows = lines.map((l) => {
    const sm = l.supplier_code && supMap.get(l.supplier_code);
    let product = null, mult = 1;
    if (sm && byId.get(sm.product_id)) { product = byId.get(sm.product_id); mult = Number(sm.multiplier) || 1; }
    else if (l.barcode) product = barcodeVariants(l.barcode).map((b) => byBarcode.get(b)).find(Boolean) || null;
    return { l, product, mult, skip: false, price: product ? Number(product.price) : null };
  });

  const box = $('.ilines', card);
  const drawRow = (r, i) => {
    const pieceCost = r.l.unit_cost / (r.mult || 1);
    const addQty = r.l.qty * (r.mult || 1);
    const margin = r.price && pieceCost ? Math.round(((r.price - pieceCost) / pieceCost) * 100) : null;
    const el = h(`<div class="iline ${r.skip ? 'skipped' : ''} ${!r.product && !r.skip ? 'unmatched' : ''}">
      <div><b>${r.l.line_no}.</b> ${esc(r.l.name)}</div>
      <div class="muted small">${num(r.l.qty)} ${esc(r.l.unit_name)} × ${tl(r.l.unit_cost)} (KDV %${num(r.l.vat)} dahil)${r.l.barcode ? ' · barkod ' + esc(r.l.barcode) : ''}${r.l.supplier_code ? ' · kod ' + esc(r.l.supplier_code) : ''}</div>
      ${r.skip ? '' : `
      <div class="imatch">${r.product
        ? `✅ <b>${esc(r.product.name)}</b> <span class="muted small">(stok ${num(r.product.stock)})</span> <button type="button" class="btn small ghost" data-a="pick">Değiştir</button>`
        : `⚠️ Eşleşmedi <button type="button" class="btn small" data-a="pick">Ürün seç</button> <button type="button" class="btn small primary" data-a="new">+ Yeni ürün</button>`}</div>
      ${r.product ? `<div class="grid2">
        <label>1 ${esc(r.l.unit_name)} = kaç ${esc(r.product.unit)}?<input class="inp" data-k="mult" inputmode="decimal" value="${num(r.mult)}"></label>
        <label>Satış fiyatı${margin != null ? ` <span class="${margin < 0 ? 'neg' : 'muted'}">(kâr %${margin})</span>` : ''}<input class="inp" data-k="price" inputmode="decimal" value="${r.price != null ? num(r.price) : ''}"></label></div>
        ${pdf ? `<div class="grid2">
        <label>Faturadaki miktar (${esc(r.l.unit_name)})<input class="inp" data-k="qty" inputmode="decimal" value="${num(r.l.qty)}"></label>
        <label>Birim maliyet (KDV dahil)<input class="inp" data-k="cost" inputmode="decimal" value="${num(r.l.unit_cost)}"></label></div>` : ''}
        <div class="small">→ Stoğa <b>+${num(addQty)} ${esc(r.product.unit)}</b>, birim maliyet ${tl(pieceCost)}</div>` : ''}`}
      <label class="switch small"><input type="checkbox" data-k="skip" ${r.skip ? 'checked' : ''}> Bu kalemi atla (stok dışı: nakliye, poşet vb.)</label></div>`);
    el.addEventListener('click', (e) => {
      const a = e.target.dataset && e.target.dataset.a;
      if (a === 'pick') pickProduct((p) => { r.product = p; r.price = Number(p.price); redraw(); });
      if (a === 'new') openProductForm(
        { barcode: r.l.barcode || '', name: r.l.name, brand: r.l.brand || '', cost: Math.round(pieceCost * 100) / 100 },
        async (p) => { if (!p) return; await loadAllProducts(true); r.product = p; r.price = Number(p.price); redraw(); });
    });
    el.addEventListener('change', (e) => {
      const k = e.target.dataset && e.target.dataset.k;
      if (k === 'skip') r.skip = e.target.checked;
      if (k === 'mult') r.mult = toNum(e.target.value) || 1;
      if (k === 'price') r.price = toNum(e.target.value);
      if (k === 'qty' && toNum(e.target.value) > 0) r.l.qty = toNum(e.target.value);
      if (k === 'cost' && toNum(e.target.value) >= 0) r.l.unit_cost = toNum(e.target.value);
      redraw();
    });
    return el;
  };
  const redraw = () => {
    box.innerHTML = '';
    rows.forEach((r, i) => box.append(drawRow(r, i)));
    const open = rows.filter((r) => !r.skip && !r.product).length;
    $('.isum', card).textContent = open ? `${open} kalem eşleşmedi — eşleştirin veya atlayın.` : `${rows.filter((r) => !r.skip).length} kalem stoğa eklenmeye hazır.`;
    const btn = $('.iapply', card);
    if (btn) btn.disabled = open > 0;
  };
  redraw();

  $('.iapply', card).onclick = (e) => busy(e.currentTarget, async () => {
    const use = rows.filter((r) => !r.skip);
    if (!use.length) throw new Error('Eklenecek kalem yok');
    const uyar = pdf && !(inv.kontrol && inv.kontrol.dogru) ? '\n\nDİKKAT: PDF\'ten okunan toplam faturayla tutmadı. Miktar ve maliyetleri kontrol ettiniz mi?' : '';
    if (!confirm(`${use.length} kalem stoğa eklenecek. Onaylıyor musunuz?${uyar}`)) return;
    // Değişen satış fiyatlarını güncelle
    for (const r of use) {
      if (r.price != null && r.price !== Number(r.product.price)) {
        const { error } = await S.sb.from('products').update({ price: r.price, updated_at: new Date().toISOString() }).eq('id', r.product.id);
        if (error) throw error;
      }
    }
    const { error } = await S.sb.rpc('apply_invoice', {
      p_header: { uuid: header.uuid || null, invoice_no: header.invoice_no, supplier_vkn: header.supplier_vkn, supplier_name: header.supplier_name, invoice_date: header.invoice_date || null, total: header.total },
      p_lines: use.map((r) => ({ product_id: r.product.id, qty: r.l.qty, unit_cost: r.l.unit_cost, supplier_code: r.l.supplier_code || null, multiplier: r.mult || 1 })),
    });
    if (error) throw error;
    invalidateProducts();
    card.innerHTML = `<div class="okbox">✅ ${esc(header.supplier_name)} — ${esc(header.invoice_no)} stoğa işlendi (${use.length} kalem).</div>`;
    toast('Fatura stoğa eklendi ✓');
  });
  return card;
}

function pickProduct(onPick) {
  const body = h(`<div><input class="inp" id="ppQ" placeholder="Ad veya barkod yazın" autocomplete="off"><div class="list" id="ppList"></div></div>`);
  const m = modal('Ürün seç', body);
  const draw = () => {
    const q = $('#ppQ', body).value.trim().toLocaleLowerCase('tr');
    const items = (S.products || []).filter((p) => !q || p.name.toLocaleLowerCase('tr').includes(q) || p.barcode.includes(q)).slice(0, 60);
    $('#ppList', body).innerHTML = items.map((p) => `<div class="litem" data-id="${p.id}">${thumb(p)}<div class="lmain">${esc(p.name)}<div class="muted small">${esc(p.barcode)}</div></div>${stockBadge(p)}</div>`).join('') || '<div class="muted empty">Bulunamadı</div>';
  };
  $('#ppQ', body).oninput = draw;
  $('#ppList', body).onclick = (e) => {
    const it = e.target.closest('.litem');
    if (!it) return;
    const p = S.products.find((x) => x.id === Number(it.dataset.id));
    m.close(); onPick(p);
  };
  draw();
  setTimeout(() => $('#ppQ', body).focus(), 50);
}

// =====================================================================
//  SAYIM / ELLE STOK GİRİŞİ
// =====================================================================
VIEWS.sayim = (v) => {
  v.append(h(`<div class="card muted small">Ürünü okutun → <b>"= Stok bu"</b> ile saydığınız miktarı yazın, ya da <b>"+ Ekle"</b> ile gelen malı ekleyin. Kayıtlı olmayan ürünü burada hemen tanımlayabilirsiniz. İlk açılışta tüm rafları bu ekranla sayabilirsiniz.</div>`));
  v.append(scanBox(onScan));
  v.append(h('<div id="cntCard"></div>'));
  v.append(h('<div class="card"><div class="card-h">Bu oturumda sayılanlar</div><div id="cntLog" class="muted small">Henüz yok</div></div>'));
  const log = [];

  async function onScan(code) {
    let p;
    try { p = await findByBarcode(code); } catch (e) { return toast(errMsg(e), 'err'); }
    const box = $('#cntCard');
    if (!box) return;
    if (!p) {
      feedback(false);
      box.innerHTML = '';
      const c = h(`<div class="card warn"><b>Kayıtlı değil:</b> ${esc(code)}<div class="row"><button class="btn primary">+ Ürün olarak ekle</button></div></div>`);
      $('button', c).onclick = () => openProductForm({ barcode: code }, (np) => np && show(np));
      box.append(c);
      return;
    }
    show(p);
  }

  function show(p) {
    const box = $('#cntCard');
    box.innerHTML = '';
    const c = h(`<div class="card prod">${thumb(p, 'pimg')}
      <div class="pinfo"><div class="pname">${esc(p.name)}</div><div class="muted small">${esc(p.barcode)}</div>
        <div>Sistemdeki stok: ${stockBadge(p)}</div><div class="muted small">Fiyat ${tl(p.price)}</div></div>
      <div class="row"><input class="inp qty big" id="cntQty" inputmode="decimal" placeholder="Miktar">
        <button class="btn primary" id="cntSet">= Stok bu</button><button class="btn green" id="cntAdd">+ Ekle</button></div></div>`);
    box.append(c);
    setTimeout(() => $('#cntQty').focus(), 50);
    const apply = async (mode, btn) => busy(btn, async () => {
      const q = toNum($('#cntQty').value);
      if (q == null || q < 0) throw new Error('Miktar girin');
      const target = mode === 'set' ? q : Number(p.stock) + q;
      const { error } = await S.sb.rpc('set_stock', { p_product_id: p.id, p_new_stock: target, p_note: mode === 'set' ? 'Sayım' : 'Elle giriş' });
      if (error) throw error;
      invalidateProducts();
      log.unshift(`${p.name}: ${num(p.stock)} → <b>${num(target)}</b> ${esc(p.unit)}`);
      $('#cntLog').innerHTML = log.slice(0, 50).map((x) => `<div>${x}</div>`).join('');
      p.stock = target;
      box.innerHTML = '';
      feedback(true);
      toast(`${p.name}: stok ${num(target)} ✓`);
    });
    $('#cntSet', c).onclick = (e) => apply('set', e.currentTarget);
    $('#cntAdd', c).onclick = (e) => apply('add', e.currentTarget);
    $('#cntQty', c).addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#cntSet', c).click(); });
  }
};

// =====================================================================
//  RAPOR
// =====================================================================
VIEWS.rapor = async (v) => {
  v.append(h(`<div><div class="row"><input type="date" class="inp" id="rDate" value="${todayStr()}"><button class="btn" id="rGo">Göster</button></div><div id="rBody"></div></div>`));
  const load = async () => {
    const day = $('#rDate').value || todayStr();
    const body = $('#rBody');
    body.innerHTML = '<div class="card muted">Yükleniyor…</div>';
    const [{ data: rep, error: e1 }, { data: sales, error: e2 }, { data: profs }] = await Promise.all([
      S.sb.rpc('daily_report', { p_date: day }),
      S.sb.from('sales').select('id, created_at, total, payment, cancelled, item_count, user_id, sale_items(qty, unit_price, line_total, products(name))')
        .gte('created_at', `${day}T00:00:00+03:00`).lte('created_at', `${day}T23:59:59.999+03:00`).order('created_at', { ascending: false }),
      S.sb.from('profiles').select('id, full_name'),
    ]);
    if (e1 || e2) { body.innerHTML = `<div class="card err">${esc(errMsg(e1 || e2))}</div>`; return; }
    const pn = new Map((profs || []).map((p) => [p.id, p.full_name]));
    body.innerHTML = `
      <div class="stats">
        <div class="stat"><span>Ciro</span><b>${tl(rep.ciro)}</b></div>
        <div class="stat"><span>Satış</span><b>${rep.satis_adedi}</b></div>
        <div class="stat"><span>Nakit</span><b>${tl(rep.nakit)}</b></div>
        <div class="stat"><span>Kart</span><b>${tl(rep.kart)}</b></div></div>
      <div class="card"><div class="card-h">En çok satanlar</div>
        <table class="tbl">${rep.en_cok_satan.map((r) => `<tr><td>${esc(r.urun)}</td><td>${num(r.adet)}</td><td class="r">${tl(r.tutar)}</td></tr>`).join('') || '<tr><td class="muted">Satış yok</td></tr>'}</table></div>
      <div class="card"><div class="card-h">Azalan / biten ürünler (şu an)</div>
        <table class="tbl">${rep.azalan.map((r) => `<tr><td>${esc(r.urun)}</td><td class="${Number(r.stok) <= 0 ? 'neg' : ''}">${num(r.stok)} ${esc(r.birim)}</td><td class="muted small">min ${num(r.min_stok)}</td></tr>`).join('') || '<tr><td class="muted">Yok 👍</td></tr>'}</table></div>
      <div class="card"><div class="card-h">Satışlar</div><div id="rSales"></div></div>`;
    const box = $('#rSales');
    if (!sales.length) box.innerHTML = '<div class="muted empty">Bu gün satış yok</div>';
    for (const s of sales) {
      const el = h(`<details class="sale ${s.cancelled ? 'cancelled' : ''}"><summary>
        <span>${new Date(s.created_at).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' })}</span>
        <span class="muted small">${esc(pn.get(s.user_id) || '')} · ${s.payment}</span><span class="sp"></span>
        <b>${tl(s.total)}</b>${s.cancelled ? ' <span class="badge red">iptal</span>' : ''}</summary>
        <table class="tbl">${s.sale_items.map((i) => `<tr><td>${esc(i.products?.name || '?')}</td><td>${num(i.qty)} × ${tl(i.unit_price)}</td><td class="r">${tl(i.line_total)}</td></tr>`).join('')}</table>
        ${s.cancelled ? '' : '<button class="btn small red">Satışı iptal et (stok geri eklenir)</button>'}</details>`);
      const b = $('button', el);
      if (b) b.onclick = (e) => busy(e.currentTarget, async () => {
        if (!confirm(`${tl(s.total)} tutarındaki satış iptal edilsin mi?`)) return;
        const { error } = await S.sb.rpc('cancel_sale', { p_sale_id: s.id });
        if (error) throw error;
        toast('Satış iptal edildi'); invalidateProducts(); load();
      });
      box.append(el);
    }
  };
  $('#rGo').onclick = load;
  $('#rDate').onchange = load;
  await load();
};

// =====================================================================
//  AYARLAR (yönetici)
// =====================================================================
VIEWS.ayarlar = async (v) => {
  const { data: st } = await S.sb.from('app_settings').select('*');
  const sv = Object.fromEntries((st || []).map((r) => [r.key, r.value]));
  const { data: profs } = await S.sb.from('profiles').select('*').order('created_at');
  v.append(h(`<div>
    <div class="card"><div class="card-h">Telegram bildirimi (n8n)</div>
      <p class="muted small">n8n'deki "Market stok uyarısı" akışının <b>Production URL</b> adresini ve aynı gizli kelimeyi girin. Ürün minimumun altına inince ya da bitince Telegram'a mesaj gelir.</p>
      <label>n8n webhook adresi<input class="inp" id="sUrl" value="${esc(sv.n8n_webhook_url || '')}" placeholder="https://n8n.alanadiniz.com/webhook/market-stok-uyari"></label>
      <label>Gizli kelime (secret)<input class="inp" id="sSec" value="${esc(sv.n8n_secret || '')}"></label>
      <div class="row"><button class="btn primary" id="sSave">Kaydet</button><button class="btn ghost" id="sTest">Test mesajı gönder</button></div></div>
    <div class="card"><div class="card-h">Kullanıcılar</div>
      <div id="sUsers"></div>
      <details class="adduser"><summary class="btn primary">+ Yeni kullanıcı ekle</summary>
        <form class="form" id="nuForm">
          <label>Adı<input class="inp" name="nu_name" required></label>
          <label>Kullanıcı adı <span class="small">(Türkçe karakter yok, örn: eleman1)</span><input class="inp" name="nu_user" autocapitalize="none" required></label>
          <label>Şifre (en az 6)<input class="inp" name="nu_pass" required></label>
          <label>Yetki<select class="inp" name="nu_role"><option value="staff">Eleman (satış + fiyat görme)</option><option value="admin">Yönetici (her şey)</option></select></label>
          <button class="btn primary" type="submit">Oluştur</button>
        </form></details></div>
    <div class="card"><div class="card-h">Marka fiyat kuralları</div>
      <p class="muted small">Satış fiyatı = Liste fiyatı × kur × (1 − iskonto) × (1 + KDV) × (1 + kâr). Kâr boşsa satış fiyatı hesaplanmaz, sadece maliyet yazılır.</p>
      <div class="grid2"><label>1 USD = ? TL<input class="inp" id="sUsd" inputmode="decimal" value="${esc(sv.usd_rate || '')}"></label>
        <label>1 EUR = ? TL<input class="inp" id="sEur" inputmode="decimal" value="${esc(sv.eur_rate || '')}"></label></div>
      <div id="sRules"></div>
      <div class="row wrap"><button class="btn ghost small" id="sRuleAdd">+ Marka ekle</button>
        <button class="btn primary" id="sRecalc">Kaydet ve fiyatları yeniden hesapla</button></div></div>
    <div class="card"><div class="card-h">Bu cihaz</div>
      <label>Market adı<input class="inp" id="sName" value="${esc(S.cfg.name)}"></label>
      <div class="row"><button class="btn" id="sNameSave">Kaydet</button>
      ${S.cfg.fromFile ? '' : '<button class="btn ghost" id="sReset">Bağlantı ayarını sıfırla</button>'}</div>
      <div class="muted small">Sunucu: ${esc(S.cfg.url)}</div></div></div>`));

  const { data: rules } = await S.sb.from('brand_rules').select('*').order('brand');
  const rb = $('#sRules');
  const ruleRow = (r = {}) => h(`<div class="rule grid4">
      <label>Marka<input class="inp" data-k="brand" value="${esc(r.brand || '')}" ${r.brand ? 'readonly' : ''}></label>
      <label>İskonto %<input class="inp" data-k="discount" inputmode="decimal" value="${r.discount != null ? num(r.discount) : ''}"></label>
      <label>KDV %<input class="inp" data-k="vat" inputmode="decimal" value="${r.vat != null ? num(r.vat) : '20'}"></label>
      <label>Kâr %<input class="inp" data-k="markup" inputmode="decimal" value="${r.markup != null ? num(r.markup) : ''}" placeholder="boş"></label></div>`);
  (rules || []).forEach((r) => rb.append(ruleRow(r)));
  $('#sRuleAdd').onclick = () => rb.append(ruleRow());
  $('#sRecalc').onclick = (e) => busy(e.currentTarget, async () => {
    const usd = toNum($('#sUsd').value), eur = toNum($('#sEur').value);
    const { error: e1 } = await S.sb.from('app_settings').upsert([
      { key: 'usd_rate', value: usd != null ? String(usd) : '' }, { key: 'eur_rate', value: eur != null ? String(eur) : '' }]);
    if (e1) throw e1;
    const list = $$('.rule', rb).map((el) => {
      const g = (k) => $(`[data-k="${k}"]`, el).value.trim();
      return { brand: g('brand'), discount: toNum(g('discount')) ?? 0, vat: toNum(g('vat')) ?? 20, markup: toNum(g('markup')), updated_at: new Date().toISOString() };
    }).filter((r) => r.brand);
    if (list.length) { const { error: e2 } = await S.sb.from('brand_rules').upsert(list); if (e2) throw e2; }
    const { data: n, error: e3 } = await S.sb.rpc('recalc_prices', { p_brand: null });
    if (e3) throw e3;
    invalidateProducts();
    toast(`${n} ürünün fiyatı yeniden hesaplandı ✓`, 'ok', 5000);
  });

  $('#sSave').onclick = (e) => busy(e.currentTarget, async () => {
    const { error } = await S.sb.from('app_settings').upsert([
      { key: 'n8n_webhook_url', value: $('#sUrl').value.trim() },
      { key: 'n8n_secret', value: $('#sSec').value.trim() },
    ]);
    if (error) throw error;
    toast('Kaydedildi ✓');
  });
  $('#sTest').onclick = (e) => busy(e.currentTarget, async () => {
    const { error } = await S.sb.rpc('test_notify');
    if (error) throw error;
    toast('Test gönderildi — Telegram\'a bakın (birkaç saniye sürebilir)', 'ok', 5000);
  });
  $('#sNameSave').onclick = () => { saveCfg({ name: $('#sName').value.trim() || 'Market' }); S.cfg = loadCfg(); renderShell(); go('ayarlar'); };
  if (!S.cfg.fromFile) $('#sReset').onclick = async () => {
    if (!confirm('Bağlantı bilgileri bu cihazdan silinsin mi?')) return;
    await S.sb.auth.signOut(); localStorage.removeItem(CFG_KEY); location.reload();
  };

  const ub = $('#sUsers');
  for (const p of profs || []) {
    const me = p.id === S.user.id;
    const r = h(`<div class="litem nohover uitem ${p.active ? '' : 'passive'}">
      <div class="lmain">${esc(p.full_name || '?')}${me ? ' <span class="muted small">(siz)</span>' : ''}${p.active ? '' : ' <span class="badge red">pasif</span>'}</div>
      <select class="inp role" ${me ? 'disabled' : ''}><option value="staff" ${p.role === 'staff' ? 'selected' : ''}>Eleman</option><option value="admin" ${p.role === 'admin' ? 'selected' : ''}>Yönetici</option></select>
      <button class="btn small ghost pw" title="Şifre değiştir">🔑</button>
      ${me ? '' : `<button class="btn small ghost act">${p.active ? 'Pasif yap' : 'Aktif yap'}</button>`}</div>`);
    $('.role', r).onchange = async (e) => {
      const { error } = await S.sb.from('profiles').update({ role: e.target.value }).eq('id', p.id);
      if (error) toast(errMsg(error), 'err'); else toast('Yetki güncellendi');
    };
    $('.pw', r).onclick = (e) => busy(e.currentTarget, async () => {
      const pw = prompt(`${p.full_name} için yeni şifre (en az 6 karakter):`);
      if (!pw) return;
      const { error } = await S.sb.rpc('reset_password', { p_user_id: p.id, p_password: pw });
      if (error) throw error;
      toast('Şifre değiştirildi ✓');
    });
    const act = $('.act', r);
    if (act) act.onclick = (e) => busy(e.currentTarget, async () => {
      if (p.active && !confirm(`${p.full_name} pasif yapılsın mı? Artık giriş yapamaz.`)) return;
      const { error } = await S.sb.rpc('set_user_active', { p_user_id: p.id, p_active: !p.active });
      if (error) throw error;
      go('ayarlar');
    });
    ub.append(r);
  }
  const nf = $('#nuForm');
  nf.onsubmit = async (e) => {
    e.preventDefault();
    const val = (n) => nf.elements.namedItem(n).value.trim();
    await busy($('button[type=submit]', nf), async () => {
      const { error } = await S.sb.rpc('create_user', {
        p_username: val('nu_user').toLowerCase(), p_password: val('nu_pass'), p_full_name: val('nu_name'), p_role: val('nu_role'),
      });
      if (error) throw error;
      toast(`Kullanıcı açıldı ✓  Giriş: ${val('nu_user').toLowerCase()}`, 'ok', 6000);
      go('ayarlar');
    });
  };
};

// =====================================================================
window.addEventListener('DOMContentLoaded', () => {
  if (!window.supabase || !window.Html5Qrcode) {
    document.getElementById('app').innerHTML = '<div class="center"><div class="card err">Gerekli dosyalar yüklenemedi. İnternet bağlantısını kontrol edip sayfayı yenileyin.</div></div>';
    return;
  }
  boot();
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
});
