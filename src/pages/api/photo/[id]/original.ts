import type { APIRoute } from 'astro';
import { createHash } from 'node:crypto';
import { fetchOriginalById } from '~/lib/photos';
import { rateLimit, clientIp } from '~/lib/rate-limit';

export const prerender = false;

/**
 * GET /api/photo/<id>/original
 *
 * Streams the original JPEG back to the browser by pulling it from
 * Nextcloud server-side. This means the Nextcloud public-share token
 * never leaves the server — sharing a /photos/<id> URL no longer lets
 * the recipient enumerate the entire share folder.
 *
 * Rate limit: 60 requests/min per IP to make abusive downloads expensive.
 */
const DOWNLOAD_MAX = 60;
const DOWNLOAD_WINDOW_MS = 60_000;

export const GET: APIRoute = async ({ params, request }) => {
  const ip = clientIp(request);
  const rl = rateLimit(`photo:${ip}`, DOWNLOAD_MAX, DOWNLOAD_WINDOW_MS);
  if (!rl.ok) {
    return new Response('Too Many Requests', {
      status: 429,
      headers: { 'Retry-After': String(Math.ceil(rl.resetMs / 1000)) },
    });
  }

  const id = params.id;
  if (!id) return new Response('Bad Request', { status: 400 });

  try {
    const result = await fetchOriginalById(id);
    if (!result) return new Response('Not Found', { status: 404 });
    const { buffer, filename, contentType } = result;

    // ETag = sha1 of the bytes, quoted per RFC 9110. Stable for a given
    // file version, so a "force reload" can short-circuit to 304 instead
    // of round-tripping the whole JPEG.
    const etag = `"${createHash('sha1').update(buffer).digest('hex')}"`;
    const ifNoneMatch = request.headers.get('if-none-match');
    if (ifNoneMatch && ifNoneMatch === etag) {
      return new Response(null, {
        status: 304,
        headers: {
          ETag: etag,
          'Cache-Control': 'public, max-age=31536000, immutable',
        },
      });
    }

    return new Response(buffer, {
      status: 200,
      headers: {
        'Content-Type': contentType,
        'Content-Length': String(buffer.length),
        // attachment so browsers default to "Save as", inline override possible via ?inline=1
        'Content-Disposition': `inline; filename="${filename.replace(/"/g, '')}"`,
        // Originals are immutable for a given id — cache hard.
        'Cache-Control': 'public, max-age=31536000, immutable',
        ETag: etag,
      },
    });
  } catch (err) {
    console.error('[api/photo/original] fetch failed:', err);
    return new Response('Internal Server Error', { status: 500 });
  }
};
