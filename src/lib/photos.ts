/**
 * Photo discovery + EXIF + thumbnail pipeline (Astro DB edition).
 *
 * Single source of truth: SQLite table `Photo` (defined in db/config.ts).
 * No more split metadata.json + photos-cache.json.
 *
 *   - Nextcloud share (read-only) → list files via WebDAV
 *   - Compare etag against DB row; if changed, re-download + EXIF + thumb
 *   - DB row also stores user-edited title/album/description and manual
 *     overrides for lat/lon/datetime
 *   - Edits go through src/pages/api/metadata.ts (alive in production)
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import exifr from 'exifr';
import sharp from 'sharp';
import { createClient, type FileStat, type WebDAVClient } from 'webdav';
import { db, Photo as PhotoTable, eq } from 'astro:db';

// Anchor file-system writes off the process cwd, not `import.meta.url` —
// after Astro bundles, `__dirname` lands somewhere deep in `dist/server/chunks`
// and `../..` lands on `dist/`, NOT the project root. Using cwd matches both
// systemd (`WorkingDirectory=<app-dir>`) and Docker
// (`WORKDIR /app`), and stays correct under `npm run dev` too.
const PROJECT_ROOT = process.cwd();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const env: Record<string, string | undefined> =
  (typeof import.meta !== 'undefined' && (import.meta as any).env) || process.env;
const NEXTCLOUD_URL = (env.NEXTCLOUD_URL || '').replace(/\/+$/, '');
const SHARE_TOKEN = env.NEXTCLOUD_SHARE_TOKEN || '';
const SHARE_PASSWORD = env.NEXTCLOUD_SHARE_PASSWORD || '';

// In dev (`npm run dev`) Astro serves `public/` directly. In a built SSR
// deploy, `public/` is copied to `dist/client/` and the Node adapter
// serves THAT — so runtime-generated thumbs must land in `dist/client/`
// to actually be reachable at the `/thumbs/...` URL.
const IS_PROD =
  (env.NODE_ENV || process.env.NODE_ENV) === 'production' ||
  // import.meta.env.PROD is true in built bundles
  (typeof import.meta !== 'undefined' && (import.meta as any).env?.PROD === true);
const THUMBS_DIR = IS_PROD
  ? path.join(PROJECT_ROOT, 'dist', 'client', 'thumbs')
  : path.join(PROJECT_ROOT, 'public', 'thumbs');
const IMG_EXTS = new Set(['.jpg', '.jpeg']);

export const THUMB_SPECS = {
  s: { px: 200, fit: 'cover' as const },
  m: { px: 400, fit: 'inside' as const },
  l: { px: 1200, fit: 'inside' as const },
};
export const THUMB_SIZES = {
  s: THUMB_SPECS.s.px,
  m: THUMB_SPECS.m.px,
  l: THUMB_SPECS.l.px,
} as const;
export type ThumbSize = keyof typeof THUMB_SPECS;

// ---------- Public Photo type (what pages consume) ----------

export interface PhotoView {
  path: string;
  id: string;
  file: string;
  placeholder: string;
  lat: number | null;
  lon: number | null;
  manualLocation: boolean;
  datetime: string;
  manualDatetime: boolean;
  editable: boolean;
  country: string;
  countryCode: string;
  title: string;
  album: string;
  description: string;
  /** Camera / phone model from EXIF (e.g. "OPPO Reno10 Pro+ 5G"). Empty if unknown. */
  camera: string;
  favorite: boolean;
  thumbs: Record<ThumbSize, string>;
  originalUrl: string;
}

// ---------- Country normalisation ----------

// Canonical English country names by ISO-3166 alpha-2 code. Nominatim
// occasionally returns multi-language values like "Deutschland;Germany" or
// the local-only form depending on the language headers — we always prefer
// our own clean English name.
const COUNTRY_NAME_EN: Record<string, string> = {
  jp: 'Japan', tw: 'Taiwan', cn: 'China', hk: 'Hong Kong', mo: 'Macao',
  my: 'Malaysia', sg: 'Singapore', th: 'Thailand', vn: 'Vietnam', ph: 'Philippines',
  id: 'Indonesia', kr: 'South Korea', kp: 'North Korea', in: 'India',
  de: 'Germany', fr: 'France', it: 'Italy', es: 'Spain', nl: 'Netherlands',
  ch: 'Switzerland', at: 'Austria', be: 'Belgium', cz: 'Czechia', sk: 'Slovakia',
  hu: 'Hungary', pl: 'Poland', pt: 'Portugal', se: 'Sweden', no: 'Norway',
  fi: 'Finland', dk: 'Denmark', ie: 'Ireland', gb: 'United Kingdom', uk: 'United Kingdom',
  us: 'United States', ca: 'Canada', mx: 'Mexico', au: 'Australia', nz: 'New Zealand',
  br: 'Brazil', ar: 'Argentina', cl: 'Chile', ru: 'Russia', tr: 'Turkey',
  eg: 'Egypt', za: 'South Africa', ae: 'United Arab Emirates', sa: 'Saudi Arabia', il: 'Israel',
};

function normalizeCountryName(raw: string, code?: string): string {
  if (code && COUNTRY_NAME_EN[code.toLowerCase()]) return COUNTRY_NAME_EN[code.toLowerCase()];
  return (raw || '').split(/[;/,]/)[0].trim();
}

// ---------- Reverse geocoding ----------

// Bounded LRU so a long-running server doesn't grow this map forever as
// the user explores new lat/lon buckets.
const GEO_CACHE_MAX = 5_000;
const geoBucketCache = new Map<string, { country: string; countryCode: string }>();
let lastGeoRequestAt = 0;

async function rateLimitedNominatim(lat: number, lon: number) {
  const delta = Date.now() - lastGeoRequestAt;
  if (delta < 1100) await new Promise((r) => setTimeout(r, 1100 - delta));
  lastGeoRequestAt = Date.now();
  const url = `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=jsonv2&zoom=3&accept-language=en`;
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'photo-portfolio/0.2',
        'Accept-Language': 'en',
      },
      // Don't let a slow Nominatim hang the whole sync loop.
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) return null;
    const data: any = await res.json();
    const country = (data?.address?.country || '').split(/[;/,]/)[0].trim();
    const countryCode = (data?.address?.country_code || '').toLowerCase();
    if (!country) return null;
    return { country, countryCode };
  } catch {
    return null;
  }
}

async function getCountry(lat: number, lon: number) {
  const bucketKey = `${Math.round(lat * 2) / 2},${Math.round(lon * 2) / 2}`;
  const cached = geoBucketCache.get(bucketKey);
  if (cached) {
    // Bump recency by deleting-and-re-inserting (Map iteration is insertion order).
    geoBucketCache.delete(bucketKey);
    geoBucketCache.set(bucketKey, cached);
    return cached;
  }
  const result = (await rateLimitedNominatim(lat, lon)) ?? { country: 'Unknown', countryCode: '' };
  geoBucketCache.set(bucketKey, result);
  // Evict the oldest if we've grown past the cap.
  if (geoBucketCache.size > GEO_CACHE_MAX) {
    const oldest = geoBucketCache.keys().next().value as string | undefined;
    if (oldest) geoBucketCache.delete(oldest);
  }
  return result;
}

// ---------- IO helpers ----------

/** Coerces a value to a finite number, or `null` for null/undefined/NaN/Infinity. */
function safeNum(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function exifDateToIso(dt: unknown): string {
  if (!dt) return '';
  if (dt instanceof Date) return dt.toISOString().replace('Z', '').slice(0, 19);
  if (typeof dt === 'string') {
    const m = dt.match(/^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})/);
    if (m) return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}`;
    return dt;
  }
  return String(dt);
}

function slugify(p: string): string {
  return p
    .replace(/\.(jpe?g)$/i, '')
    .replace(/[^\w\-/]+/g, '-')
    .replace(/\/+/g, '--');
}

function thumbKey(relPath: string): string {
  return relPath.replace(/\.(jpe?g)$/i, '').replace(/[\/\\]/g, '__');
}

function makeClient(): WebDAVClient {
  if (!NEXTCLOUD_URL || !SHARE_TOKEN) {
    throw new Error('NEXTCLOUD_URL and NEXTCLOUD_SHARE_TOKEN must be set in .env');
  }
  return createClient(`${NEXTCLOUD_URL}/public.php/webdav`, {
    username: SHARE_TOKEN,
    password: SHARE_PASSWORD,
  });
}

/**
 * URL the browser hits to download the original. We deliberately proxy this
 * through our own server (/api/photo/[id]/original) so we never leak the
 * Nextcloud share token (which would grant access to the entire share).
 */
function originalUrl(relPath: string): string {
  return `/api/photo/${encodeURIComponent(slugify(relPath))}/original`;
}

async function listFilesRecursive(client: WebDAVClient): Promise<FileStat[]> {
  const items = (await client.getDirectoryContents('/', {
    deep: true,
    glob: '/**/*.{jpg,jpeg,JPG,JPEG}',
  })) as FileStat[];
  return items.filter((it) => it.type === 'file' && IMG_EXTS.has(path.extname(it.basename).toLowerCase()));
}

async function makePlaceholder(buf: Buffer): Promise<string> {
  const tiny = await sharp(buf)
    .rotate()
    .resize(16, 16, { fit: 'cover', position: 'centre' })
    .webp({ quality: 35 })
    .toBuffer();
  return `data:image/webp;base64,${tiny.toString('base64')}`;
}

async function ensureThumbsFromBuffer(buf: Buffer, key: string): Promise<void> {
  for (const [size, spec] of Object.entries(THUMB_SPECS) as [ThumbSize, { px: number; fit: 'cover' | 'inside' }][]) {
    const out = path.join(THUMBS_DIR, size, `${key}.webp`);
    await fs.mkdir(path.dirname(out), { recursive: true });
    await sharp(buf)
      .rotate()
      .resize({
        width: spec.px,
        height: spec.px,
        fit: spec.fit,
        position: 'centre',
        withoutEnlargement: spec.fit === 'inside',
      })
      .webp({ quality: 80 })
      .toFile(out);
  }
}

async function cleanupOrphanThumbs(liveKeys: Set<string>): Promise<number> {
  let removed = 0;
  for (const size of Object.keys(THUMB_SPECS)) {
    const dir = path.join(THUMBS_DIR, size);
    try {
      for (const name of await fs.readdir(dir)) {
        const key = name.replace(/\.(jpe?g|webp)$/i, '');
        if (!liveKeys.has(key)) {
          await fs.unlink(path.join(dir, name));
          removed++;
        }
      }
    } catch {
      /* dir missing — fine */
    }
  }
  return removed;
}

// ---------- Sync: Nextcloud → DB ----------

let syncing: Promise<void> | null = null;
let lastSync = 0;
const SYNC_TTL_MS = 5_000; // re-list Nextcloud at most every 5s

/** Force the next read to re-list Nextcloud. */
export function invalidatePhotoSync() {
  lastSync = 0;
}

async function syncFromNextcloud() {
  if (syncing) return syncing;
  if (Date.now() - lastSync < SYNC_TTL_MS) return;

  syncing = (async () => {
    const client = makeClient();
    const files = await listFilesRecursive(client);

    // Snapshot existing DB rows by path for quick lookup.
    const existingRows = await db.select().from(PhotoTable);
    const byPath = new Map(existingRows.map((r) => [r.path, r]));
    const livePaths = new Set<string>();
    const liveThumbKeys = new Set<string>();

    let downloaded = 0;
    let skipped = 0;

    for (const item of files) {
      const relPath = item.filename.replace(/^\/+/, '');
      const etag = String(item.etag ?? item.lastmod ?? '');
      const key = thumbKey(relPath);
      livePaths.add(relPath);
      liveThumbKeys.add(key);

      const existing = byPath.get(relPath);
      // Re-process when:
      //   - row doesn't exist yet
      //   - etag changed on Nextcloud
      //   - seeded etag is empty (legacy migration data, EXIF columns unreliable)
      if (existing && existing.etag === etag && etag !== '') {
        skipped++;
        continue;
      }

      // Need to (re-)process: download, EXIF, thumbs, placeholder, geocode.
      const raw = await client.getFileContents(item.filename);
      const buf: Buffer = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as ArrayBuffer);
      downloaded++;

      let exifLat: number | undefined;
      let exifLon: number | undefined;
      let exifDt: string | undefined;
      let camera = '';
      try {
        const parsed = await exifr.parse(buf, {
          ifd0: ['Make', 'Model'],
          exif: ['DateTimeOriginal'],
          gps: true,
          interop: false, thumbnail: false, iptc: false, icc: false, xmp: false, jfif: false,
        });
        exifLat = safeNum(parsed?.latitude) ?? undefined;
        exifLon = safeNum(parsed?.longitude) ?? undefined;
        exifDt = exifDateToIso(parsed?.DateTimeOriginal);
        // Compose camera string: drop Make if Model already starts with it
        // (avoids "OPPO OPPO Reno10..." duplication).
        const make = (parsed?.Make || '').trim();
        const model = (parsed?.Model || '').trim();
        if (model && make && model.toLowerCase().startsWith(make.toLowerCase())) camera = model;
        else if (make && model) camera = `${make} ${model}`;
        else camera = model || make;
      } catch {
        /* unreadable */
      }

      await ensureThumbsFromBuffer(buf, key);
      const placeholder = await makePlaceholder(buf);

      // Preserve user fields and any prior manual overrides from existing row.
      const manualLatExisting = existing && existing.lat !== existing.exifLat ? existing.lat : null;
      const manualLonExisting = existing && existing.lon !== existing.exifLon ? existing.lon : null;
      const manualDtExisting = existing && existing.datetime && existing.datetime !== existing.exifDatetime
        ? existing.datetime : null;

      const finalLat = manualLatExisting ?? exifLat ?? null;
      const finalLon = manualLonExisting ?? exifLon ?? null;
      const finalDt = manualDtExisting || exifDt || '';

      let country: string | null = null;
      let countryCode: string | null = null;
      if (finalLat !== null && finalLon !== null) {
        const geo = await getCountry(finalLat, finalLon);
        country = normalizeCountryName(geo.country, geo.countryCode);
        countryCode = geo.countryCode;
      } else {
        country = 'Unlocated';
        countryCode = '';
      }

      const row = {
        etag,
        file: path.posix.basename(relPath),
        thumbKey: key,
        placeholder,
        lat: safeNum(finalLat),
        lon: safeNum(finalLon),
        datetime: finalDt || null,
        country,
        countryCode,
        exifLat: safeNum(exifLat),
        exifLon: safeNum(exifLon),
        exifDatetime: exifDt || null,
        camera: camera || null,
        updatedAt: new Date(),
      };
      if (existing) {
        await db.update(PhotoTable).set(row).where(eq(PhotoTable.path, relPath));
      } else {
        await db.insert(PhotoTable).values({
          path: relPath,
          ...row,
          title: '',
          album: '',
          description: '',
        });
      }
    }

    // Delete DB rows + thumbs for files removed from Nextcloud.
    for (const r of existingRows) {
      if (!livePaths.has(r.path)) {
        await db.delete(PhotoTable).where(eq(PhotoTable.path, r.path));
      }
    }
    const removedThumbs = await cleanupOrphanThumbs(liveThumbKeys);

    lastSync = Date.now();
    console.log(`[photos] sync: ${files.length} on Nextcloud, ${downloaded} processed, ${skipped} unchanged, ${removedThumbs} orphan thumbs removed`);
  })();

  try { await syncing; }
  finally { syncing = null; }
}

// ---------- Row → PhotoView projection ----------

function rowToView(r: any): PhotoView {
  const lat: number | null = r.lat ?? null;
  const lon: number | null = r.lon ?? null;
  const datetime: string = r.datetime || '';
  const manualLocation = lat !== null && (r.exifLat === null || r.exifLat === undefined || lat !== r.exifLat);
  const manualDatetime = !!datetime && datetime !== (r.exifDatetime || '');
  const country = r.country || '';
  const countryCode = r.countryCode || '';
  const key = r.thumbKey as string;
  const editable =
    lat === null || lon === null || manualLocation || !datetime || manualDatetime;
  return {
    path: r.path,
    id: slugify(r.path),
    file: r.file,
    placeholder: r.placeholder || '',
    lat, lon,
    manualLocation,
    datetime,
    manualDatetime,
    editable,
    country: normalizeCountryName(country, countryCode),
    countryCode,
    title: r.title || '',
    album: r.album || '',
    description: r.description || '',
    camera: r.camera || '',
    favorite: !!r.favorite,
    thumbs: {
      s: `/thumbs/s/${encodeURIComponent(key)}.webp`,
      m: `/thumbs/m/${encodeURIComponent(key)}.webp`,
      l: `/thumbs/l/${encodeURIComponent(key)}.webp`,
    },
    originalUrl: originalUrl(r.path),
  };
}

// ---------- Public read API ----------

export async function getPhotos(): Promise<PhotoView[]> {
  await syncFromNextcloud();
  const rows = await db.select().from(PhotoTable);
  return rows
    .map(rowToView)
    .sort((a, b) => (a.datetime || '').localeCompare(b.datetime || ''));
}

export async function getPhotoById(id: string): Promise<PhotoView | undefined> {
  const photos = await getPhotos();
  return photos.find((p) => p.id === id);
}

// ---------- Trip auto-detection ----------

export interface Trip {
  slug: string;
  country: string;
  countryCode: string;
  /** ISO 'YYYY-MM-DD' of first photo. */
  start: string;
  /** ISO 'YYYY-MM-DD' of last photo. */
  end: string;
  /** Number of days between start and end (inclusive). */
  days: number;
  photos: PhotoView[];
}

const TRIP_GAP_DAYS = 7;

function trySlug(start: string, country: string, used: Set<string>): string {
  const base = `${start}-${country.toLowerCase().replace(/\s+/g, '-').replace(/[^\w-]/g, '')}`;
  if (!used.has(base)) return base;
  let n = 2;
  while (used.has(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

function finalizeTrip(photos: PhotoView[], used: Set<string>): Trip {
  const start = photos[0].datetime.slice(0, 10);
  const end = photos[photos.length - 1].datetime.slice(0, 10);
  const country = photos[0].country;
  const countryCode = photos[0].countryCode;
  const days =
    Math.floor(
      (new Date(end).getTime() - new Date(start).getTime()) / 86_400_000,
    ) + 1;
  const slug = trySlug(start, country, used);
  used.add(slug);
  return { slug, country, countryCode, start, end, days, photos };
}

/**
 * Group photos into trips: contiguous runs in the same country with no
 * gap longer than TRIP_GAP_DAYS between consecutive photos. Singletons
 * (a single photo) still count — useful for "I went to X for a day".
 */
export async function getTrips(): Promise<Trip[]> {
  const all = await getPhotos();
  const candidates = all
    .filter((p) => p.country && p.datetime && p.country !== 'Unlocated')
    .sort((a, b) => a.datetime.localeCompare(b.datetime));

  if (candidates.length === 0) return [];

  const used = new Set<string>();
  const trips: Trip[] = [];
  let bucket: PhotoView[] = [candidates[0]];

  for (let i = 1; i < candidates.length; i++) {
    const prev = bucket[bucket.length - 1];
    const cur = candidates[i];
    const gapDays =
      (new Date(cur.datetime).getTime() - new Date(prev.datetime).getTime()) /
      86_400_000;
    if (cur.country === prev.country && gapDays <= TRIP_GAP_DAYS) {
      bucket.push(cur);
    } else {
      trips.push(finalizeTrip(bucket, used));
      bucket = [cur];
    }
  }
  trips.push(finalizeTrip(bucket, used));

  // Newest first.
  return trips.reverse();
}

export async function getTripBySlug(slug: string): Promise<Trip | undefined> {
  const trips = await getTrips();
  return trips.find((t) => t.slug === slug);
}

export async function getPhotoByPath(p: string): Promise<PhotoView | undefined> {
  const rows = await db.select().from(PhotoTable).where(eq(PhotoTable.path, p));
  return rows[0] ? rowToView(rows[0]) : undefined;
}

/**
 * Fetch the original photo bytes from Nextcloud for a given photo id.
 * Returns the buffer + filename + mime so the API route can stream it
 * back to the browser without ever exposing the share token client-side.
 */
export async function fetchOriginalById(
  id: string,
): Promise<{ buffer: Buffer; filename: string; contentType: string } | null> {
  const rows = await db.select().from(PhotoTable);
  const row = rows.find((r) => slugify(r.path) === id);
  if (!row) return null;
  const client = makeClient();
  const data = (await client.getFileContents('/' + row.path)) as Buffer;
  const ext = path.extname(row.file).toLowerCase();
  const contentType = ext === '.png' ? 'image/png' : 'image/jpeg';
  return { buffer: data, filename: row.file, contentType };
}

// ---------- Mutation API (used by /api/metadata) ----------

/**
 * Permanently delete a photo: removes the file from Nextcloud, the DB row,
 * and all on-disk thumbnails. Same share token (with edit permission) is used.
 */
export async function deletePhoto(p: string): Promise<boolean> {
  const rows = await db.select().from(PhotoTable).where(eq(PhotoTable.path, p));
  const existing = rows[0];
  if (!existing) return false;

  try {
    const client = makeClient();
    await client.deleteFile('/' + p);
  } catch (err) {
    console.warn(`[photos] Nextcloud DELETE failed for ${p}:`, err);
  }
  await db.delete(PhotoTable).where(eq(PhotoTable.path, p));
  for (const size of Object.keys(THUMB_SPECS)) {
    const out = path.join(THUMBS_DIR, size, `${existing.thumbKey}.webp`);
    await fs.unlink(out).catch(() => undefined);
  }
  return true;
}

/**
 * Move a photo to a new path on Nextcloud and re-key everything that
 * depends on the path: the DB row (path, file, thumbKey), and the three
 * on-disk thumb files. Used by `scripts/organize.mjs` for bulk relocation
 * into `<country>/<day>/` folders. Idempotent on no-op (oldPath === newPath).
 */
export async function renamePhotoFile(
  oldPath: string,
  newPath: string,
): Promise<{ ok: boolean; error?: string }> {
  if (oldPath === newPath) return { ok: true };
  const rows = await db.select().from(PhotoTable).where(eq(PhotoTable.path, oldPath));
  const existing = rows[0];
  if (!existing) return { ok: false, error: 'no DB row for ' + oldPath };

  const client = makeClient();
  const dstDir = path.posix.dirname(newPath);
  if (dstDir && dstDir !== '.') {
    try {
      await client.createDirectory('/' + dstDir, { recursive: true });
    } catch {
      // Nextcloud returns 405 if the directory already exists — fine to ignore.
    }
  }
  try {
    await client.moveFile('/' + oldPath, '/' + newPath);
  } catch (err: any) {
    return { ok: false, error: err?.message || String(err) };
  }

  const newKey = thumbKey(newPath);
  if (existing.thumbKey !== newKey) {
    for (const size of Object.keys(THUMB_SPECS)) {
      const oldT = path.join(THUMBS_DIR, size, `${existing.thumbKey}.webp`);
      const newT = path.join(THUMBS_DIR, size, `${newKey}.webp`);
      await fs.rename(oldT, newT).catch(() => undefined);
    }
  }

  await db
    .update(PhotoTable)
    .set({
      path: newPath,
      file: path.posix.basename(newPath),
      thumbKey: newKey,
      updatedAt: new Date(),
    })
    .where(eq(PhotoTable.path, oldPath));

  return { ok: true };
}

export async function updatePhoto(
  p: string,
  patch: {
    title?: string;
    album?: string;
    description?: string;
    /** Pass `null` to clear a manual override and revert to EXIF. */
    lat?: number | null;
    lon?: number | null;
    datetime?: string | null;
    favorite?: boolean;
  }
): Promise<PhotoView | null> {
  const rows = await db.select().from(PhotoTable).where(eq(PhotoTable.path, p));
  const existing = rows[0];
  if (!existing) return null;

  const updates: any = { updatedAt: new Date() };
  if (patch.title !== undefined) updates.title = patch.title;
  if (patch.album !== undefined) updates.album = patch.album;
  if (patch.description !== undefined) updates.description = patch.description;
  if (patch.favorite !== undefined) updates.favorite = !!patch.favorite;

  let nextLat: number | null = existing.lat ?? null;
  let nextLon: number | null = existing.lon ?? null;
  if (patch.lat !== undefined && patch.lon !== undefined) {
    if (patch.lat === null || patch.lon === null) {
      // Reverting: fall back to EXIF original (which may itself be null).
      nextLat = existing.exifLat ?? null;
      nextLon = existing.exifLon ?? null;
    } else {
      nextLat = Number(patch.lat);
      nextLon = Number(patch.lon);
    }
    updates.lat = nextLat;
    updates.lon = nextLon;
  }

  if (patch.datetime !== undefined) {
    if (patch.datetime === null || patch.datetime === '') {
      updates.datetime = existing.exifDatetime ?? null;
    } else {
      const d = patch.datetime;
      updates.datetime = d.length === 10 ? `${d}T00:00:00` : d;
    }
  }

  // Re-geocode country if location changed (or was nulled).
  if ('lat' in updates) {
    if (nextLat !== null && nextLon !== null) {
      const geo = await getCountry(nextLat, nextLon);
      updates.country = normalizeCountryName(geo.country, geo.countryCode);
      updates.countryCode = geo.countryCode;
    } else {
      updates.country = 'Unlocated';
      updates.countryCode = '';
    }
  }

  await db.update(PhotoTable).set(updates).where(eq(PhotoTable.path, p));
  const updated = await db.select().from(PhotoTable).where(eq(PhotoTable.path, p));
  return updated[0] ? rowToView(updated[0]) : null;
}
