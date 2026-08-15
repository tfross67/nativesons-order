// Native Sons PWA service worker
// Strategy: stale-while-revalidate for the catalog/data assets that change
// weekly. Cache-first for static branding assets. Network-first for the HTML
// itself (so deploys always show up).

// CACHE_VERSION bump policy: bump on every deploy that changes static assets
// (styles.css, logo, icons, manifest). Catalog data files in DATA_CACHE are
// served stale-while-revalidate, so they pick up changes on next visit
// automatically. Static-cache assets are cache-first and only refresh when
// the version changes — bumping here is what triggers a fresh fetch for
// every existing visitor on their next page load.
const CACHE_VERSION = 'ns-pwa-v49';
const STATIC_CACHE = `${CACHE_VERSION}-static`;
const DATA_CACHE = `${CACHE_VERSION}-data`;

// Static branding — cache-first, rarely change
const STATIC_ASSETS = [
  '/',
  '/logo.jpg',
  '/icon-512.png',
  '/apple-touch-icon.png',
  '/popppy-flower.png',
  '/styles.css',
  '/manifest.webmanifest',
];

// Catalog data — stale-while-revalidate so the app loads instantly offline
// using last week's snapshot, then refreshes in the background.
const DATA_ASSETS = [
  '/availability_data.js',
  '/masteritem_full.js',
  '/image_map.json',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(STATIC_CACHE).then((cache) => cache.addAll(STATIC_ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  // Drop any old caches from previous versions
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((k) => k.startsWith('ns-pwa-') && k !== STATIC_CACHE && k !== DATA_CACHE)
          .map((k) => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return; // ignore Supabase, CDN

  // Network-first for HTML — always get the latest deploy
  if (request.mode === 'navigate' || request.destination === 'document') {
    event.respondWith(
      fetch(request)
        .then((resp) => {
          const copy = resp.clone();
          caches.open(STATIC_CACHE).then((c) => c.put(request, copy));
          return resp;
        })
        .catch(() => caches.match(request).then((r) => r || caches.match('/availability.html')))
    );
    return;
  }

  // Stale-while-revalidate for catalog data
  if (DATA_ASSETS.some((p) => url.pathname.endsWith(p.replace(/^\//, '')))) {
    event.respondWith(
      caches.open(DATA_CACHE).then(async (cache) => {
        const cached = await cache.match(request);
        const network = fetch(request).then((resp) => {
          if (resp.ok) cache.put(request, resp.clone());
          return resp;
        }).catch(() => cached);
        return cached || network;
      })
    );
    return;
  }

  // Cache-first for static assets (logo, styles, manifest)
  if (STATIC_ASSETS.some((p) => url.pathname.endsWith(p.replace(/^\//, '')))) {
    event.respondWith(
      caches.match(request).then((cached) =>
        cached || fetch(request).then((resp) => {
          if (resp.ok) {
            const copy = resp.clone();
            caches.open(STATIC_CACHE).then((c) => c.put(request, copy));
          }
          return resp;
        })
      )
    );
    return;
  }

  // Default: pass through, don't cache
});