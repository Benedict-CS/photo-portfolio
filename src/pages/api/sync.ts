/**
 * Force a Nextcloud → DB sync NOW, bypassing the 5 s TTL that
 * `syncFromNextcloud()` normally throttles itself with.
 *
 *   POST /api/sync    →  invalidate + getPhotos() to re-list and re-process
 *
 * Auth-gated identically to /api/metadata. Used by:
 *   - the /admin "Sync" button
 *   - scripts/sync.mjs (which pokes this endpoint from the shell)
 */
import type { APIRoute } from 'astro';
import { timingSafeEqual } from 'node:crypto';
import { getPhotos, invalidatePhotoSync } from '~/lib/photos';
import { rateLimit, clientIp } from '~/lib/rate-limit';

export const prerender = false;

// Sync hits Nextcloud + Nominatim and can be slow on first call — keep
// the cap loose enough for retries but tight enough to prevent abuse.
const SYNC_MAX = 6;
const SYNC_WINDOW_MS = 60_000;

const ADMIN_PASSWORD = (
  (typeof import.meta !== 'undefined' && (import.meta as any).env?.ADMIN_PASSWORD) ||
  process.env.ADMIN_PASSWORD ||
  ''
);

function safeEq(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

function checkAuth(request: Request): boolean {
  if (!ADMIN_PASSWORD) return true;
  const auth = request.headers.get('authorization') || '';
  const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  const header = request.headers.get('x-admin-password') || '';
  return safeEq(bearer, ADMIN_PASSWORD) || safeEq(header, ADMIN_PASSWORD);
}

function unauthorized() {
  return new Response(JSON.stringify({ ok: false, error: 'unauthorized' }), {
    status: 401,
    headers: { 'Content-Type': 'application/json', 'WWW-Authenticate': 'Bearer' },
  });
}

function tooManyRequests(reset: number) {
  return new Response(
    JSON.stringify({ ok: false, error: 'too many requests' }),
    {
      status: 429,
      headers: {
        'Content-Type': 'application/json',
        'Retry-After': Math.ceil(reset / 1000).toString(),
      },
    },
  );
}

export const POST: APIRoute = async ({ request }) => {
  const rl = rateLimit(`sync:${clientIp(request)}`, SYNC_MAX, SYNC_WINDOW_MS);
  if (!rl.ok) return tooManyRequests(rl.resetMs);
  if (!checkAuth(request)) return unauthorized();

  const start = Date.now();
  invalidatePhotoSync();
  const photos = await getPhotos();
  const ms = Date.now() - start;

  return new Response(
    JSON.stringify({ ok: true, count: photos.length, durationMs: ms }),
    { headers: { 'Content-Type': 'application/json' } },
  );
};
