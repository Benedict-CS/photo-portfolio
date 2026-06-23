#!/usr/bin/env node
/**
 * Force a Nextcloud → DB sync NOW by poking the running server's
 * /api/sync endpoint. Plain Node, no astro:db / no .ts imports — works
 * inside the Docker container and on the host alike.
 *
 *   npm run sync
 *
 * The previous implementation tried to import ../src/lib/photos.ts via
 * `astro db execute`, which (a) breaks on relative paths once the script
 * is bundled to /app/db.timestamp-*.mjs and (b) can't resolve astro:db
 * inside the dynamically-imported .ts anyway. Hitting the running server
 * over HTTP sidesteps both problems: the server's own astro:db is fully
 * wired, so it just calls invalidatePhotoSync() + getPhotos() inline.
 *
 * Requires the app container to be up. Override URL via SYNC_URL env
 * (default: http://localhost:4321/api/sync). If ADMIN_PASSWORD is set
 * we forward it as a Bearer token so the endpoint accepts the call.
 */
import 'dotenv/config';

const url = process.env.SYNC_URL || 'http://localhost:4321/api/sync';
const password = process.env.ADMIN_PASSWORD || '';

const start = Date.now();
let res;
try {
  res = await fetch(url, {
    method: 'POST',
    headers: password ? { Authorization: `Bearer ${password}` } : undefined,
  });
} catch (err) {
  console.error(`[sync] Failed to reach ${url}: ${err?.message || err}`);
  console.error('Is the server running? Inside Docker:');
  console.error('  docker compose ps');
  console.error('  docker compose exec app sh -c "npm run sync"');
  process.exit(1);
}

if (!res.ok) {
  const text = await res.text().catch(() => '');
  console.error(`[sync] ${url} returned ${res.status} ${res.statusText}`);
  if (text) console.error(text);
  process.exit(1);
}

const data = await res.json().catch(() => ({}));
const dur = ((Date.now() - start) / 1000).toFixed(1);
console.log(`[sync] ${data.count ?? '?'} photos resolved in ${dur}s`);
