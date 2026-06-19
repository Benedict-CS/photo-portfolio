#!/usr/bin/env node
/**
 * Build-time Nextcloud sync.
 *
 * Run before `npm run build` (or in CI) so the deployed DB already has
 * fresh photo data. Without this, the first user request after a deploy
 * pays the cold-sync penalty.
 *
 * Reads .env, calls syncFromNextcloud() once, exits.
 */
import 'dotenv/config';

const start = Date.now();
// We dynamically import so this file can be invoked stand-alone without
// Astro's runtime — astro:db works in Node via the Astro CLI which sets it up.
const mod = await import('../src/lib/photos.ts').catch(async () => {
  // Fallback to .js (already-built) if the .ts import fails.
  return import('../dist/server/chunks/lib_photos.mjs');
});

if (typeof mod.invalidatePhotoSync === 'function') mod.invalidatePhotoSync();
const photos = await mod.getPhotos();
const dur = ((Date.now() - start) / 1000).toFixed(1);
console.log(`[sync] ${photos.length} photos resolved in ${dur}s`);
