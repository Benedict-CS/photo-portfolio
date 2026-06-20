import { defineMiddleware } from 'astro:middleware';

/**
 * Long-cache the immutable static assets that hit the SSR runtime:
 *   - /thumbs/*         (runtime-generated thumbnails — keyed by file hash, never overwritten in place)
 *   - /_astro/*         (Astro-built JS/CSS chunks with content hash in filename)
 *   - /favicon.svg, /icon-*.png, /manifest.webmanifest (one-off site chrome)
 *
 * Without this, the Node adapter's static handler ships a default short
 * cache and every page reload re-fetches the same 23+ thumbs. A year of
 * immutable cache cuts repeat-visit bandwidth ~90%.
 */
const IMMUTABLE = 'public, max-age=31536000, immutable';

// Match exact files (favicon, manifest, icons) and prefix paths (thumbs, _astro).
const isImmutablePath = (pathname: string): boolean => {
  if (pathname.startsWith('/thumbs/')) return true;
  if (pathname.startsWith('/_astro/')) return true;
  if (pathname === '/favicon.svg') return true;
  if (pathname === '/manifest.webmanifest') return true;
  if (/^\/icon-\d+\.png$/.test(pathname)) return true;
  return false;
};

export const onRequest = defineMiddleware(async (context, next) => {
  const response = await next();
  if (isImmutablePath(context.url.pathname)) {
    // Use set() (not append) so we win over whatever the static handler set.
    response.headers.set('Cache-Control', IMMUTABLE);
  }
  return response;
});
