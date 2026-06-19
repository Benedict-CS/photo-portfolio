import 'dotenv/config';
import { defineConfig } from 'astro/config';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const PROJECT_ROOT = path.resolve('.');
const METADATA_PATH = path.join(PROJECT_ROOT, 'metadata.json');
const CACHE_PATH = path.join(PROJECT_ROOT, '.astro', 'photos-cache.json');

const WATCH_INTERVAL_MS = parseInt(process.env.WATCH_INTERVAL_MS || '30000', 10);

/**
 * Dev-only Nextcloud poller.
 *
 * Every WATCH_INTERVAL_MS (default 30 s) we issue a PROPFIND Depth:1 against the
 * shared folder root and hash the resulting XML. If the digest changes (new /
 * removed / re-uploaded file) we invalidate `src/lib/photos.ts`'s in-memory
 * cache and ask Vite to full-reload connected browsers — so a freshly-dropped
 * photo shows up within a tick without restarting `npm run dev`.
 */
function nextcloudWatcher(server) {
  let lastDigest = '';
  let inFlight = false;

  async function tick() {
    if (inFlight) return;
    inFlight = true;
    try {
      const url = process.env.NEXTCLOUD_URL?.replace(/\/+$/, '');
      const token = process.env.NEXTCLOUD_SHARE_TOKEN;
      if (!url || !token) return;
      const res = await fetch(`${url}/public.php/webdav/`, {
        method: 'PROPFIND',
        headers: {
          Authorization:
            'Basic ' +
            Buffer.from(`${token}:${process.env.NEXTCLOUD_SHARE_PASSWORD || ''}`).toString('base64'),
          Depth: 'infinity',
        },
      });
      if (!res.ok) return;
      const text = await res.text();
      // Hash only the etag/href pairs so unrelated XML noise doesn't trigger churn.
      const fingerprint = (text.match(/<d:(href|getetag)>[^<]+<\/d:[^>]+>/g) || []).join('|');
      const digest = crypto.createHash('md5').update(fingerprint).digest('hex');
      if (!lastDigest) {
        lastDigest = digest;
        console.log('[watch] Nextcloud baseline captured, polling every ' + WATCH_INTERVAL_MS / 1000 + 's');
        return;
      }
      if (digest !== lastDigest) {
        console.log('[watch] Nextcloud changed → reloading');
        lastDigest = digest;
        try {
          const mod = await server.ssrLoadModule('/src/lib/photos.ts');
          mod.clearPhotoCache?.();
        } catch {}
        server.ws.send({ type: 'full-reload', path: '*' });
      }
    } catch (err) {
      // Network blip — silently retry next tick.
    } finally {
      inFlight = false;
    }
  }

  tick();
  const timer = setInterval(tick, WATCH_INTERVAL_MS);
  server.httpServer?.on('close', () => clearInterval(timer));
}

/**
 * Dev-only Vite middleware that exposes a tiny metadata API:
 *   POST   /api/metadata  { path: "...", title?, album?, description? }
 *   DELETE /api/metadata  { path: "..." }
 *   GET    /api/metadata  -> entire metadata.json
 *   POST   /api/refresh   forces photo cache invalidation on next page load
 *
 * In production builds this plugin contributes nothing — the deployed site stays
 * fully static and is therefore read-only by design.
 */
function metadataApiPlugin() {
  return {
    name: 'metadata-api',
    apply: 'serve', // dev only
    configureServer(server) {
      server.middlewares.use('/api/metadata', async (req, res) => {
        try {
          if (req.method === 'GET') {
            const text = await fs.readFile(METADATA_PATH, 'utf-8').catch(() => '{}');
            res.setHeader('Content-Type', 'application/json');
            res.end(text);
            return;
          }

          const chunks = [];
          for await (const c of req) chunks.push(c);
          const body = JSON.parse(Buffer.concat(chunks).toString('utf-8') || '{}');
          const metaRaw = await fs.readFile(METADATA_PATH, 'utf-8').catch(() => '{}');
          const metadata = JSON.parse(metaRaw);

          if (req.method === 'POST') {
            const { path: p, title, album, description, lat, lon, datetime } = body;
            if (!p) throw new Error('path required');
            const entry = metadata[p] || { title: '', album: '', description: '' };
            if (title !== undefined) entry.title = title;
            if (album !== undefined) entry.album = album;
            if (description !== undefined) entry.description = description;
            if (lat !== undefined && lon !== undefined) {
              if (lat === null || lon === null) {
                delete entry.lat;
                delete entry.lon;
              } else {
                entry.lat = Number(lat);
                entry.lon = Number(lon);
              }
            }
            if (datetime !== undefined) {
              if (datetime === null || datetime === '') delete entry.datetime;
              else entry.datetime = String(datetime);
            }
            metadata[p] = entry;
          } else if (req.method === 'DELETE') {
            delete metadata[body.path];
          } else {
            res.statusCode = 405;
            res.end('Method not allowed');
            return;
          }

          await fs.writeFile(METADATA_PATH, JSON.stringify(metadata, null, 2), 'utf-8');
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ ok: true }));
        } catch (err) {
          res.statusCode = 500;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ ok: false, error: String(err) }));
        }
      });

      server.middlewares.use('/api/refresh', async (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405;
          res.end('POST only');
          return;
        }
        await fs.rm(CACHE_PATH, { force: true });
        try {
          const mod = await server.ssrLoadModule('/src/lib/photos.ts');
          mod.clearPhotoCache?.();
        } catch {}
        server.ws.send({ type: 'full-reload', path: '*' });
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ ok: true, message: 'cache cleared — reload page' }));
      });

      nextcloudWatcher(server);
    },
  };
}

export default defineConfig({
  site: 'https://example.com',
  vite: {
    plugins: [metadataApiPlugin()],
    server: {
      fs: { strict: false, allow: ['..'] },
    },
  },
});
