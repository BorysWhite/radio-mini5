// Версію змінювати при кожному оновленні, інакше телефон покаже стару програму
const VERSION = 'mini5-2.0.0';
const FILES = ['./', 'index.html', 'app.js', 'radio-core.js', 'manifest.webmanifest', 'icon-180.png', 'icon-192.png', 'icon-512.png'];
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
// Спершу мережа, без мережі кеш
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  e.respondWith(fetch(e.request, { cache: 'no-store' }).then((r) => {
    const copy = r.clone();
    caches.open(VERSION).then((c) => c.put(e.request, copy));
    return r;
  }).catch(() => caches.match(e.request)));
});
