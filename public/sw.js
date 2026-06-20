// Photo Portfolio service worker.
//
// Strategy by URL type:
//   - /thumbs/*           cache-first, immutable    (already long-cached, SW gives offline too)
//   - /_astro/*           cache-first, immutable    (content-hashed JS/CSS chunks)
//   - /api/*              network-only              (writes / freshly-rated-limited; never cache)
//   - /api/photo/*/original network-only            (originals are big, not worth the SW cache budget)
//   - everything else (HTML, /, /timeline, /photos/[id])
//                         network-first, cache fallback for offline
//
// Bumping VERSION invalidates ALL old caches on next install — flip this string
// whenever you change cache shapes or want to force a clean cache.
const VERSION = 'pp-v1';
const RUNTIME_CACHE = `${VERSION}-runtime`;
const PAGE_CACHE = `${VERSION}-pages`;

self.addEventListener('install', (event) => {
  // Take over from the previous SW immediately on update — no "close tab to refresh" dance.
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      // Drop any cache that doesn't belong to the current VERSION.
      const names = await caches.keys();
      await Promise.all(
        names
          .filter((n) => !n.startsWith(VERSION))
          .map((n) => caches.delete(n))
      );
      await self.clients.claim();
    })()
  );
});

const isImmutable = (url) =>
  url.pathname.startsWith('/thumbs/') || url.pathname.startsWith('/_astro/');

const isAPI = (url) => url.pathname.startsWith('/api/');

const isHTMLNavigation = (request) =>
  request.mode === 'navigate' ||
  (request.method === 'GET' &&
    request.headers.get('accept')?.includes('text/html'));

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Don't cache the API — writes need to hit the server, and we already
  // 304 the immutable original endpoint via ETag, so HTTP caching covers it.
  if (isAPI(url)) return;

  if (isImmutable(url)) {
    event.respondWith(cacheFirst(RUNTIME_CACHE, request));
    return;
  }

  if (isHTMLNavigation(request)) {
    event.respondWith(networkFirstWithOfflinePage(request));
    return;
  }
});

async function cacheFirst(cacheName, request) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) return cached;
  try {
    const res = await fetch(request);
    if (res.ok) cache.put(request, res.clone());
    return res;
  } catch (err) {
    // Hard offline + uncached → let the browser show its default error.
    return cached || Response.error();
  }
}

async function networkFirstWithOfflinePage(request) {
  const cache = await caches.open(PAGE_CACHE);
  try {
    const res = await fetch(request);
    // Cache only successful HTML so a 500 doesn't poison the offline copy.
    if (res.ok) cache.put(request, res.clone());
    return res;
  } catch (err) {
    const cached = await cache.match(request);
    if (cached) return cached;
    // Last resort: any cached HTML page so the user gets *something*.
    const anyHtml = (await cache.keys())[0];
    if (anyHtml) return cache.match(anyHtml);
    return new Response(
      '<!doctype html><meta charset=utf-8><title>Offline</title>' +
        '<style>body{font-family:system-ui;padding:40px;text-align:center;color:#555}</style>' +
        '<h1>You\'re offline</h1><p>Connect to the network and reload.</p>',
      { headers: { 'Content-Type': 'text/html; charset=utf-8' }, status: 503 }
    );
  }
}
