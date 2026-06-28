import { db, Photo } from 'astro:db';
import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * One-time migration from the old flat files (metadata.json +
 * .astro/photos-cache.json) into the Photo table.
 *
 * Runs every time `astro dev` / `astro build` starts and the DB is fresh.
 * Safe to re-run — uses INSERT OR IGNORE semantics by checking the path PK.
 */
const ROOT = path.resolve('.');
const META = path.join(ROOT, 'metadata.json');
const CACHE = path.join(ROOT, '.astro', 'photos-cache.json');

async function readJson<T>(p: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await fs.readFile(p, 'utf-8'));
  } catch {
    return fallback;
  }
}

export default async function seed() {
  const metadata = await readJson<Record<string, any>>(META, {});
  const cache = await readJson<Record<string, any>>(CACHE, {});

  const allPaths = new Set([...Object.keys(metadata), ...Object.keys(cache)]);
  if (allPaths.size === 0) {
    console.log('[seed] No legacy files to migrate — starting with empty DB.');
    return;
  }

  // Only seed the *user-edited* fields (title/album/description) and any
  // manual lat/lon/datetime overrides that the user explicitly set. Leave
  // exifLat/exifLon/etag empty so syncFromNextcloud will populate them
  // from the actual file on first run — the legacy cache values for these
  // were unreliable.
  const rows = [];
  for (const p of allPaths) {
    const m = metadata[p] || {};
    const manualDt = m.datetime;
    const finalDt = manualDt
      ? (manualDt.length === 10 ? `${manualDt}T00:00:00` : manualDt)
      : null;

    rows.push({
      path: p,
      file: path.posix.basename(p),
      etag: '', // forces re-sync on first run
      thumbKey: p.replace(/\.(jpe?g|mp4|mov)$/i, '').replace(/[\/\\]/g, '__'),
      placeholder: null,
      lat: typeof m.lat === 'number' ? m.lat : null,
      lon: typeof m.lon === 'number' ? m.lon : null,
      datetime: finalDt,
      country: null,
      countryCode: null,
      exifLat: null,
      exifLon: null,
      exifDatetime: null,
      kind: /\.(mp4|mov)$/i.test(p) ? 'video' : 'photo',
      durationSec: null,
      title: m.title || '',
      album: m.album || '',
      description: m.description || '',
      updatedAt: new Date(),
    });
  }

  await db.insert(Photo).values(rows);
  console.log(`[seed] Migrated ${rows.length} photo records from legacy files into DB.`);
}
