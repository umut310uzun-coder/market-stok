// Basit önbellek: uygulama dosyaları hızlı açılsın. Veritabanı istekleri ASLA önbelleğe alınmaz.
const CACHE = 'market-v2';
const SHELL = ['./', 'index.html', 'style.css', 'app.js', 'efatura.js', 'config.js', 'manifest.json', 'icon-192.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  if (url.hostname.endsWith('supabase.co') || url.hostname.includes('openfoodfacts') || url.hostname.includes('openproductsfacts') || url.hostname.includes('openbeautyfacts')) return;
  const isLib = /cdn\.jsdelivr\.net|unpkg\.com/.test(url.hostname);
  if (isLib) {
    // kütüphaneler: önce önbellek
    e.respondWith(caches.match(e.request).then((r) => r || fetch(e.request).then((res) => {
      const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); return res;
    })));
  } else if (url.origin === location.origin) {
    // kendi dosyalarımız: önce internet (güncel kalsın), yoksa önbellek
    e.respondWith(fetch(e.request).then((res) => {
      const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); return res;
    }).catch(() => caches.match(e.request)));
  }
});
