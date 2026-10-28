// Bike News offline support. The page shell and fonts come from the cache; editions are fetched fresh
// and fall back to the last copy when there is no signal.
const SHELL = 'bike-news-shell-v7';
const DATA = 'bike-news-data';
const FILES = [
  './', 'styles.css', 'app.js', 'manifest.webmanifest', 'icons/apple-touch-icon.png',
  'fonts/barlow-condensed-latin-600-normal.woff2', 'fonts/barlow-semi-condensed-latin-600-normal.woff2',
  'fonts/source-serif-4-latin-400-normal.woff2',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== SHELL && k !== DATA).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

async function networkFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const res = await fetch(req, { cache: 'no-cache' });
    if (res.ok) cache.put(req, res.clone());
    return res;
  } catch {
    const hit = await cache.match(req, { ignoreSearch: cacheName === SHELL });
    if (hit) return hit;
    throw new Error('offline');
  }
}

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  if (url.pathname.startsWith('/content/')) e.respondWith(networkFirst(e.request, DATA));
  else if (url.pathname.startsWith('/fonts/') || url.pathname.startsWith('/icons/')) {
    e.respondWith(caches.match(e.request).then((hit) => hit || fetch(e.request)));
  } else e.respondWith(networkFirst(e.request, SHELL));
});
