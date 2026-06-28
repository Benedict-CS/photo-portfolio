import type { APIRoute } from 'astro';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import {
  fetchOriginalById,
  getPlayableSourceById,
  openRemoteReadStream,
  parseRange,
} from '~/lib/photos';
import { rateLimit, clientIp } from '~/lib/rate-limit';

export const prerender = false;

/**
 * GET /api/photo/<id>/original
 *
 * Photos: small enough to buffer; we keep the existing ETag/304 short-
 * circuit so a force-reload doesn't re-download the JPEG.
 *
 * Videos: streamed with HTTP Range support so the browser <video> tag
 * can scrub the timeline. HEVC sources get served from the on-disk
 * transcode cache (H.264 MP4 with faststart); everything else streams
 * straight from Nextcloud via the webdav lib's createReadStream.
 *
 * Rate limit: 60 requests/min per IP. Range requests count individually
 * so a single video can burn through the budget — set higher if you
 * actually have many concurrent video viewers.
 */
const DOWNLOAD_MAX = 60;
const DOWNLOAD_WINDOW_MS = 60_000;

function quoteFilename(name: string): string {
  return name.replace(/"/g, '');
}

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
    // Resolve once so the same DB lookup serves both branches below.
    const src = await getPlayableSourceById(id);
    if (!src) return new Response('Not Found', { status: 404 });

    const isVideo = src.contentType.startsWith('video/');

    // ---- Photo path: keep the existing buffered + ETag behaviour. ----
    // The buffer is tiny and the 304 short-circuit is worth keeping.
    if (!isVideo) {
      const result = await fetchOriginalById(id);
      if (!result) return new Response('Not Found', { status: 404 });
      const { buffer, filename, contentType } = result;
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
          'Content-Disposition': `inline; filename="${quoteFilename(filename)}"`,
          'Cache-Control': 'public, max-age=31536000, immutable',
          ETag: etag,
        },
      });
    }

    // ---- Video path: Range-aware streaming. ----
    const totalSize = src.size;
    // Size has to be known to support Range. If a row predates the size
    // column and serves from Nextcloud, fall back to 200 with no Range.
    const rangeHeader = request.headers.get('range');
    const range = totalSize > 0 ? parseRange(rangeHeader, totalSize) : null;

    if (rangeHeader && !range && totalSize > 0) {
      return new Response('Requested Range Not Satisfiable', {
        status: 416,
        headers: {
          'Content-Range': `bytes */${totalSize}`,
          'Accept-Ranges': 'bytes',
        },
      });
    }

    // Pick a Node Readable for either the local transcode or the remote
    // Nextcloud file, restricted to the requested byte slice when given.
    let nodeStream: Readable;
    if (src.localPath) {
      nodeStream = createReadStream(
        src.localPath,
        range ? { start: range.start, end: range.end } : undefined,
      );
    } else if (src.remotePath) {
      nodeStream = openRemoteReadStream(
        src.remotePath,
        range ? { start: range.start, end: range.end } : undefined,
      );
    } else {
      return new Response('Internal Server Error', { status: 500 });
    }

    const headers: Record<string, string> = {
      'Content-Type': src.contentType,
      'Content-Disposition': `inline; filename="${quoteFilename(src.filename)}"`,
      'Accept-Ranges': 'bytes',
      // Videos are content-addressed by id + we strip-replace on re-sync,
      // so a long browser cache is safe here too.
      'Cache-Control': 'public, max-age=31536000, immutable',
    };

    if (range) {
      headers['Content-Range'] = `bytes ${range.start}-${range.end}/${totalSize}`;
      headers['Content-Length'] = String(range.end - range.start + 1);
      // Node 22's Readable.toWeb adapts a Node stream to the Fetch API.
      return new Response(Readable.toWeb(nodeStream) as unknown as BodyInit, {
        status: 206,
        headers,
      });
    }

    if (totalSize > 0) headers['Content-Length'] = String(totalSize);
    return new Response(Readable.toWeb(nodeStream) as unknown as BodyInit, {
      status: 200,
      headers,
    });
  } catch (err) {
    console.error('[api/photo/original] fetch failed:', err);
    return new Response('Internal Server Error', { status: 500 });
  }
};
