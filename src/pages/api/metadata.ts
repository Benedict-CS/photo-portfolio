import type { APIRoute } from 'astro';
import { updatePhoto, deletePhoto, getPhotoByPath } from '~/lib/photos';

export const prerender = false;

const ADMIN_PASSWORD = (
  (typeof import.meta !== 'undefined' && (import.meta as any).env?.ADMIN_PASSWORD) ||
  process.env.ADMIN_PASSWORD ||
  ''
);

/**
 * Accepts the admin password via either:
 *   - `Authorization: Bearer <password>` header (set by the SPA), or
 *   - `x-admin-password` header.
 *
 * If `ADMIN_PASSWORD` is empty (dev), we never reject. In production set
 * ADMIN_PASSWORD as an env var on your host (fly.io / Railway / …).
 */
function checkAuth(request: Request): boolean {
  if (!ADMIN_PASSWORD) return true;
  const auth = request.headers.get('authorization') || '';
  const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  const header = request.headers.get('x-admin-password') || '';
  return bearer === ADMIN_PASSWORD || header === ADMIN_PASSWORD;
}

function unauthorized() {
  return new Response(JSON.stringify({ ok: false, error: 'unauthorized' }), {
    status: 401,
    headers: { 'Content-Type': 'application/json', 'WWW-Authenticate': 'Bearer' },
  });
}

export const GET: APIRoute = async ({ url }) => {
  const p = url.searchParams.get('path');
  if (!p) return new Response(JSON.stringify({ ok: false, error: 'path required' }), { status: 400 });
  const photo = await getPhotoByPath(p);
  return new Response(JSON.stringify({ ok: true, photo }), {
    headers: { 'Content-Type': 'application/json' },
  });
};

export const DELETE: APIRoute = async ({ request }) => {
  if (!checkAuth(request)) return unauthorized();
  try {
    const body = await request.json().catch(() => ({}));
    const { path: p } = body;
    if (!p) {
      return new Response(JSON.stringify({ ok: false, error: 'path required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    const ok = await deletePhoto(p);
    return new Response(JSON.stringify({ ok }), {
      status: ok ? 200 : 404,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err: any) {
    return new Response(JSON.stringify({ ok: false, error: String(err?.message || err) }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};

export const POST: APIRoute = async ({ request }) => {
  if (!checkAuth(request)) return unauthorized();
  try {
    const body = await request.json().catch(() => ({}));
    const { path: p, title, album, description, lat, lon, datetime, favorite, paths } = body;
    // Reject silently-empty requests with a clear 400 instead of a 500.
    if (!p && !Array.isArray(paths)) {
      return new Response(JSON.stringify({ ok: false, error: 'path or paths required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Batch mode: { paths: ["a", "b"], album: "Tokyo trip" } updates many at once.
    const patch = {
      title, album, description,
      lat: lat === null ? null : (lat === undefined ? undefined : Number(lat)),
      lon: lon === null ? null : (lon === undefined ? undefined : Number(lon)),
      datetime: datetime === null ? null : datetime,
      favorite,
    };

    if (Array.isArray(paths)) {
      const results = [];
      for (const target of paths) {
        const u = await updatePhoto(target, patch);
        if (u) results.push(u);
      }
      return new Response(JSON.stringify({ ok: true, count: results.length }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const updated = await updatePhoto(p, patch);
    if (!updated) {
      return new Response(JSON.stringify({ ok: false, error: 'photo not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({ ok: true, photo: updated }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err: any) {
    return new Response(JSON.stringify({ ok: false, error: String(err?.message || err) }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
