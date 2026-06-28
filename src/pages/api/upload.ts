import type { APIRoute } from 'astro';
import { timingSafeEqual } from 'node:crypto';
import { createClient } from 'webdav';
import { rateLimit, clientIp } from '~/lib/rate-limit';
import { invalidatePhotoSync } from '~/lib/photos';

export const prerender = false;

/**
 * POST /api/upload — multipart/form-data with one or more `files` parts.
 *
 * Auth: same Bearer token as /api/metadata (ADMIN_PASSWORD).
 * Rate limit: 10 batch-requests/min per IP. Each batch may carry up
 * to 20 files. Files above 50 MB are rejected.
 *
 * Successful uploads PUT into the Nextcloud share root; on success we
 * invalidate the in-memory sync cache so the very next page load
 * triggers a fresh PROPFIND and the new photos appear in the UI.
 */

const ADMIN_PASSWORD = (
  (typeof import.meta !== 'undefined' && (import.meta as any).env?.ADMIN_PASSWORD) ||
  process.env.ADMIN_PASSWORD ||
  ''
);
const NEXTCLOUD_URL = (
  (typeof import.meta !== 'undefined' && (import.meta as any).env?.NEXTCLOUD_URL) ||
  process.env.NEXTCLOUD_URL ||
  ''
).replace(/\/+$/, '');
const SHARE_TOKEN = (
  (typeof import.meta !== 'undefined' && (import.meta as any).env?.NEXTCLOUD_SHARE_TOKEN) ||
  process.env.NEXTCLOUD_SHARE_TOKEN ||
  ''
);
const SHARE_PASSWORD = (
  (typeof import.meta !== 'undefined' && (import.meta as any).env?.NEXTCLOUD_SHARE_PASSWORD) ||
  process.env.NEXTCLOUD_SHARE_PASSWORD ||
  ''
);

const UPLOAD_MAX = 10;
const UPLOAD_WINDOW_MS = 60_000;
// Photos cap at 50 MB; videos at 200 MB. A 30s 4K iPhone clip is roughly
// 100–150 MB and we want headroom for one or two more.
const MAX_PHOTO_SIZE = 50 * 1024 * 1024;
const MAX_VIDEO_SIZE = 200 * 1024 * 1024;
const MAX_FILES_PER_REQUEST = 20;
const VALID_EXT = /\.(jpe?g|mp4|mov)$/i;
const VIDEO_EXT = /\.(mp4|mov)$/i;

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

/**
 * Pick a safe destination filename. Strips any folder components from the
 * client side (defence in depth — File.name shouldn't carry path on most
 * platforms but a hostile client could craft one), and appends a short
 * timestamp suffix to avoid collisions with existing photos.
 */
function safeFilename(raw: string): string {
  const base = raw.split(/[\\/]/).pop() || 'photo.jpg';
  const cleaned = base.replace(/[^\w.\-]+/g, '_');
  const dotIdx = cleaned.lastIndexOf('.');
  const stem = dotIdx > 0 ? cleaned.slice(0, dotIdx) : cleaned;
  const ext = dotIdx > 0 ? cleaned.slice(dotIdx) : '.jpg';
  // ISO-ish suffix without colons (Nextcloud / webdav friendly).
  const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
  return `${stem}-${stamp}${ext}`;
}

export const POST: APIRoute = async ({ request }) => {
  const ip = clientIp(request);
  const rl = rateLimit(`upload:${ip}`, UPLOAD_MAX, UPLOAD_WINDOW_MS);
  if (!rl.ok) {
    return new Response(JSON.stringify({ ok: false, error: 'too many requests' }), {
      status: 429,
      headers: {
        'Content-Type': 'application/json',
        'Retry-After': String(Math.ceil(rl.resetMs / 1000)),
      },
    });
  }

  if (!checkAuth(request)) {
    return new Response(JSON.stringify({ ok: false, error: 'unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json', 'WWW-Authenticate': 'Bearer' },
    });
  }

  if (!NEXTCLOUD_URL || !SHARE_TOKEN) {
    return new Response(JSON.stringify({ ok: false, error: 'nextcloud not configured' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return new Response(JSON.stringify({ ok: false, error: 'invalid multipart body' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const files = formData.getAll('files').filter((f): f is File => f instanceof File);
  if (files.length === 0) {
    return new Response(JSON.stringify({ ok: false, error: 'no files in request' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  if (files.length > MAX_FILES_PER_REQUEST) {
    return new Response(JSON.stringify({ ok: false, error: `max ${MAX_FILES_PER_REQUEST} files per request` }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const client = createClient(`${NEXTCLOUD_URL}/public.php/webdav`, {
    username: SHARE_TOKEN,
    password: SHARE_PASSWORD,
  });

  const results: { name: string; saved?: string; ok: boolean; error?: string }[] = [];
  let okCount = 0;

  for (const file of files) {
    if (file.size === 0) {
      results.push({ name: file.name, ok: false, error: 'empty file' });
      continue;
    }
    if (!VALID_EXT.test(file.name)) {
      results.push({ name: file.name, ok: false, error: 'only .jpg / .jpeg / .mp4 / .mov accepted' });
      continue;
    }
    const isVideo = VIDEO_EXT.test(file.name);
    const cap = isVideo ? MAX_VIDEO_SIZE : MAX_PHOTO_SIZE;
    if (file.size > cap) {
      const capMB = Math.round(cap / 1024 / 1024);
      results.push({ name: file.name, ok: false, error: `file too large (>${capMB} MB)` });
      continue;
    }
    try {
      const destName = safeFilename(file.name);
      const buffer = Buffer.from(await file.arrayBuffer());
      await client.putFileContents('/' + destName, buffer, { overwrite: false });
      results.push({ name: file.name, saved: destName, ok: true });
      okCount++;
    } catch (err: any) {
      console.error('[api/upload] put failed:', file.name, err?.message || err);
      results.push({ name: file.name, ok: false, error: String(err?.message || err) });
    }
  }

  if (okCount > 0) invalidatePhotoSync();

  return new Response(JSON.stringify({ ok: true, uploaded: okCount, results }), {
    headers: { 'Content-Type': 'application/json' },
  });
};
