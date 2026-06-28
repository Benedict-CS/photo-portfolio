import 'dotenv/config';
import { defineConfig } from 'astro/config';
import db from '@astrojs/db';
import node from '@astrojs/node';
import crypto from 'node:crypto';

const WATCH_INTERVAL_MS = parseInt(process.env.WATCH_INTERVAL_MS || '30000', 10);

/**
 * Dev-only Nextcloud poller — when share contents change, tell connected
 * browsers to full-reload (so photos.ts picks up the new files).
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
          mod.invalidatePhotoSync?.();
        } catch {}
        server.ws.send({ type: 'full-reload', path: '*' });
      }
    } catch {
      // Network blip — silently retry next tick.
    } finally {
      inFlight = false;
    }
  }

  tick();
  const timer = setInterval(tick, WATCH_INTERVAL_MS);
  server.httpServer?.on('close', () => clearInterval(timer));
}

function watcherPlugin() {
  return {
    name: 'nextcloud-watcher',
    apply: 'serve',
    configureServer(server) {
      nextcloudWatcher(server);
    },
  };
}

export default defineConfig({
  // Public site URL for canonical/og:url/sitemap. Override per-deploy by
  // setting SITE_URL in .env (e.g. http://192.168.1.50:4321 for LAN).
  site: process.env.SITE_URL || 'http://localhost:4321',
  output: 'server',          // SSR — API routes are alive in production too.
  adapter: node({ mode: 'standalone' }),
  integrations: [db()],
  // Astro 5 enables an Origin-vs-Host check by default that rejects
  // POSTs with `multipart/form-data` (browsers' default for FormData)
  // when the request looks "cross-site". With a reverse proxy in front
  // of the container the Host header gets rewritten but Origin doesn't,
  // so /api/upload (FormData) was always failing with a "Cross-site
  // form submissions are not allowed" HTML response. Our mutation
  // endpoints are already gated by ADMIN_PASSWORD (constant-time
  // compare) + per-IP rate limits, so this layer is redundant for us.
  security: { checkOrigin: false },
  vite: {
    plugins: [watcherPlugin()],
    server: {
      fs: { strict: false, allow: ['..'] },
    },
  },
});
