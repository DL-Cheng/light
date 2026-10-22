// Service Worker：快取應用程式外殼，讓 Web App 可安裝並可離線開啟（MQTT 連線仍需網路）。
// 更新網頁檔案後，請把 VERSION 加 1，手機才會取得新版。
const VERSION = 'v3';
const CACHE = 'transmittance-' + VERSION;
const ASSETS = ['./', 'index.html', 'css/style.css', 'js/app.js', 'vendor/mqtt.min.js',
  'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  // 網路優先、失敗時用快取，確保部署新版後能更新
  e.respondWith(fetch(req).then(res => {
    const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); return res;
  }).catch(() => caches.match(req).then(r => r || caches.match('index.html'))));
});
