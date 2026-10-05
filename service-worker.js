const CACHE = 'voice-navi-public-v3';
const CACHE_PREFIXES = ['voice-navi-public-', 'voice-navi-lab-'];
const ASSETS = [
  './',
  'index.html',
  'styles.css',
  'app.js',
  'manifest.webmanifest',
  'icon.svg',
  'icon-512.png',
  'apple-touch-icon.png',
  'data/catalog.json'
];

const assetURLs = new Set(ASSETS.map(path => new URL(path, self.registration.scope).href));

self.addEventListener('install', event => {
  self.skipWaiting();
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(ASSETS)));
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(key =>
        key !== CACHE && CACHE_PREFIXES.some(prefix => key.startsWith(prefix))
      ).map(key => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;

  const url = new URL(event.request.url);
  const inPublicScope = url.origin === self.location.origin && url.href.startsWith(self.registration.scope);
  if (!inPublicScope) return;

  const isNavigation = event.request.mode === 'navigate';
  const isPublicAsset = assetURLs.has(url.href);
  if (!isNavigation && !isPublicAsset) return;

  event.respondWith((async () => {
    try {
      const response = await fetch(event.request);
      if (response && response.ok && isPublicAsset) {
        const copy = response.clone();
        caches.open(CACHE).then(cache => cache.put(event.request, copy));
      }
      return response;
    } catch (error) {
      if (isPublicAsset) {
        const cached = await caches.match(event.request);
        if (cached) return cached;
      }
      if (isNavigation) {
        const scope = self.registration.scope;
        return (await caches.match(new URL('index.html', scope).href)) || (await caches.match(new URL('./', scope).href));
      }
      throw error;
    }
  })());
});
