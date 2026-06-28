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
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import exifr from 'exifr';
import sharp from 'sharp';
import { createClient, type FileStat, type WebDAVClient } from 'webdav';
import { db, Photo as PhotoTable, eq, sql } from 'astro:db';

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
// HEVC videos get transcoded to H.264 MP4 here, keyed by thumbKey, so
// Firefox + Chromium-on-Linux can decode them. Same dev/prod split as
// THUMBS_DIR but the files are served via the API (we need Range
// handling that the static layer doesn't give us).
const VIDEOS_DIR = IS_PROD
  ? path.join(PROJECT_ROOT, 'dist', 'client', 'videos')
  : path.join(PROJECT_ROOT, 'public', 'videos');
const IMG_EXTS = new Set(['.jpg', '.jpeg']);
const VIDEO_EXTS = new Set(['.mp4', '.mov']);
const ALL_EXTS = new Set<string>([...IMG_EXTS, ...VIDEO_EXTS]);
// Codecs that need to be re-encoded as H.264 for cross-browser playback.
// Phone footage is overwhelmingly HEVC (iPhone default) or H.264 (Android).
const HEVC_CODECS = new Set(['hevc', 'h265']);

function isVideoExt(ext: string): boolean {
  return VIDEO_EXTS.has(ext.toLowerCase());
}

/** Local path of the transcoded (or copied) H.264 MP4 for a given thumbKey. */
function transcodedPath(key: string): string {
  return path.join(VIDEOS_DIR, `${key}.mp4`);
}

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
  /** 'photo' or 'video' — picks <img> vs <video> in the UI. */
  kind: 'photo' | 'video';
  /** Duration in seconds, videos only (else null). */
  durationSec: number | null;
  /** Source codec ('hevc', 'h264', …). Videos only; null otherwise. */
  videoCodec: string | null;
  /** File size in bytes (after any HEVC→H.264 transcode for videos). */
  bytes: number | null;
  favorite: boolean;
  thumbs: Record<ThumbSize, string>;
  /** URL the browser hits to download the original (photo) or play the video. */
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

// Strip any extension we know how to ingest (image OR video) before
// slugifying / keying. Keeps thumb keys stable across photo/video kinds and
// avoids `.mp4` segments leaking into URLs.
const KNOWN_EXT_RE = /\.(jpe?g|mp4|mov)$/i;

function slugify(p: string): string {
  return p
    .replace(KNOWN_EXT_RE, '')
    .replace(/[^\w\-/]+/g, '-')
    .replace(/\/+/g, '--');
}

function thumbKey(relPath: string): string {
  return relPath.replace(KNOWN_EXT_RE, '').replace(/[\/\\]/g, '__');
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
    glob: '/**/*.{jpg,jpeg,JPG,JPEG,mp4,mov,MP4,MOV}',
  })) as FileStat[];
  return items.filter((it) => it.type === 'file' && ALL_EXTS.has(path.extname(it.basename).toLowerCase()));
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
  // Same pass for the transcoded-video cache so deleted/renamed videos
  // don't leave stale .mp4 files on disk.
  try {
    for (const name of await fs.readdir(VIDEOS_DIR)) {
      const key = name.replace(/\.mp4$/i, '');
      if (!liveKeys.has(key)) {
        await fs.unlink(path.join(VIDEOS_DIR, name));
        removed++;
      }
    }
  } catch { /* dir missing — fine */ }
  return removed;
}

// ---------- Video helpers (ffmpeg / ffprobe) ----------

/**
 * Write a video buffer to a temp file, run a callback with its path, then
 * unlink. ffmpeg + ffprobe both need a real file (stdin can't seek for
 * most container formats), so this is the cheapest reliable wrapper.
 */
async function withTempVideoFile<T>(
  buf: Buffer,
  ext: string,
  fn: (p: string) => Promise<T>,
): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pp-video-'));
  const p = path.join(dir, 'in' + ext);
  await fs.writeFile(p, buf);
  try {
    return await fn(p);
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

function runProc(
  cmd: string,
  args: string[],
): Promise<{ stdout: Buffer; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args);
    const out: Buffer[] = [];
    let err = '';
    proc.stdout.on('data', (d: Buffer) => out.push(d));
    proc.stderr.on('data', (d: Buffer) => { err += d.toString(); });
    proc.on('error', reject);
    proc.on('close', (code) =>
      resolve({ stdout: Buffer.concat(out), stderr: err, code: code ?? -1 }),
    );
  });
}

/**
 * Pull a single representative frame out of a video and return it as JPEG
 * bytes (which sharp can downsize to all 3 thumb sizes + the LQIP). Uses
 * the `thumbnail` filter so we don't end up with a black intro frame.
 */
async function extractVideoPoster(filePath: string): Promise<Buffer> {
  const { stdout, stderr, code } = await runProc('ffmpeg', [
    '-y',
    '-hide_banner',
    '-loglevel', 'error',
    '-i', filePath,
    '-vf', 'thumbnail,scale=1600:-1:flags=lanczos',
    '-frames:v', '1',
    '-f', 'image2',
    '-vcodec', 'mjpeg',
    '-q:v', '3',
    'pipe:1',
  ]);
  if (code !== 0 || stdout.length === 0) {
    throw new Error(`ffmpeg poster failed (code ${code}): ${stderr.trim()}`);
  }
  return stdout;
}

/**
 * Parse an ISO 6709 location string ("+25.0330+121.5654+010.000/") into
 * { lat, lon }. Returns null for unparseable input.
 */
function parseIso6709(s: string): { lat: number; lon: number } | null {
  const m = s.match(/^([+\-]\d+(?:\.\d+)?)([+\-]\d+(?:\.\d+)?)/);
  if (!m) return null;
  const lat = parseFloat(m[1]);
  const lon = parseFloat(m[2]);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return { lat, lon };
}

interface VideoMeta {
  lat?: number;
  lon?: number;
  datetime?: string;
  camera: string;
  durationSec?: number;
  /** First video stream codec — 'hevc' / 'h264' / etc. Empty when ffprobe can't tell. */
  videoCodec: string;
}

async function readVideoMeta(filePath: string): Promise<VideoMeta> {
  const { stdout, code } = await runProc('ffprobe', [
    '-v', 'quiet',
    '-print_format', 'json',
    '-show_format',
    '-show_streams',
    filePath,
  ]);
  if (code !== 0) return { camera: '', videoCodec: '' };
  let probe: any;
  try { probe = JSON.parse(stdout.toString()); }
  catch { return { camera: '', videoCodec: '' }; }

  const fmtTags = probe?.format?.tags || {};
  // Some containers expose location only on the first stream's tags.
  const streamTags = (probe?.streams || []).find((s: any) => s?.tags)?.tags || {};
  const videoStream = (probe?.streams || []).find((s: any) => s?.codec_type === 'video');
  const videoCodec = String(videoStream?.codec_name || '').toLowerCase();
  const iso =
    fmtTags['com.apple.quicktime.location.ISO6709'] ||
    streamTags['com.apple.quicktime.location.ISO6709'] ||
    fmtTags.location ||
    streamTags.location ||
    '';
  const loc = typeof iso === 'string' && iso ? parseIso6709(iso) : null;

  const ct = fmtTags.creation_time || streamTags.creation_time || '';
  let datetime = '';
  if (ct) {
    const d = new Date(ct);
    if (!Number.isNaN(d.getTime())) datetime = exifDateToIso(d);
  }

  const make = String(
    fmtTags['com.apple.quicktime.make'] || fmtTags.make || '',
  ).trim();
  const model = String(
    fmtTags['com.apple.quicktime.model'] || fmtTags.model || '',
  ).trim();
  let camera = '';
  if (model && make && model.toLowerCase().startsWith(make.toLowerCase())) camera = model;
  else if (make && model) camera = `${make} ${model}`;
  else camera = model || make;

  const durationSec = Number(probe?.format?.duration);

  return {
    lat: loc?.lat,
    lon: loc?.lon,
    datetime,
    camera,
    durationSec: Number.isFinite(durationSec) ? durationSec : undefined,
    videoCodec,
  };
}

/**
 * Re-encode the source video to broadly playable H.264 + AAC MP4 with the
 * moov atom moved to the front (faststart) so progressive playback works
 * from the first byte. Lands in VIDEOS_DIR/<key>.mp4. Idempotent — skips
 * if the output already exists AND is non-empty.
 */
async function transcodeToH264(srcPath: string, key: string): Promise<void> {
  const out = transcodedPath(key);
  await fs.mkdir(path.dirname(out), { recursive: true });
  try {
    const stat = await fs.stat(out);
    if (stat.size > 0) return; // already done
  } catch { /* missing — proceed */ }
  // `-preset fast` balances encode time vs compression for short personal
  // clips. `-crf 23` is visually transparent for most viewers. `yuv420p`
  // ensures broad <video> compatibility (some HEVC inputs are 10-bit which
  // not every browser's H.264 decoder accepts). `+faststart` is critical
  // for Range / scrubbing on first load.
  const { code, stderr } = await runProc('ffmpeg', [
    '-y',
    '-hide_banner',
    '-loglevel', 'error',
    '-i', srcPath,
    '-c:v', 'libx264',
    '-preset', 'fast',
    '-crf', '23',
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac',
    '-b:a', '128k',
    '-movflags', '+faststart',
    out,
  ]);
  if (code !== 0) {
    await fs.unlink(out).catch(() => undefined);
    throw new Error(`ffmpeg transcode failed (code ${code}): ${stderr.trim()}`);
  }
}

/** Delete the cached transcoded file (if any) for a thumb key. */
async function removeTranscoded(key: string): Promise<void> {
  await fs.unlink(transcodedPath(key)).catch(() => undefined);
}

// ---------- Sync: Nextcloud → DB ----------

let syncing: Promise<void> | null = null;
let lastSync = 0;
const SYNC_TTL_MS = 5_000; // re-list Nextcloud at most every 5s

// Self-healing one-shot ALTERs for columns added after a deploy's last
// `npm run build`. preserve-db.mjs restores the live DB *over* the freshly
// seeded one, so the new schema columns are missing on existing installs.
// Each ALTER is wrapped in try/catch — "duplicate column" is the expected
// no-op once the column exists.
let migrationsRan = false;
async function ensureSchemaMigrations() {
  if (migrationsRan) return;
  migrationsRan = true;
  const migrations = [
    sql`ALTER TABLE Photo ADD COLUMN kind TEXT NOT NULL DEFAULT 'photo'`,
    sql`ALTER TABLE Photo ADD COLUMN durationSec REAL`,
    sql`ALTER TABLE Photo ADD COLUMN videoCodec TEXT`,
    sql`ALTER TABLE Photo ADD COLUMN bytes REAL`,
  ];
  for (const m of migrations) {
    try { await db.run(m); }
    catch (err: any) {
      const msg = String(err?.message || err);
      if (!/duplicate column|already exists/i.test(msg)) {
        console.warn('[photos] schema migration warning:', msg);
      }
    }
  }
}

/** Force the next read to re-list Nextcloud. */
export function invalidatePhotoSync() {
  lastSync = 0;
}

async function syncFromNextcloud() {
  if (syncing) return syncing;
  if (Date.now() - lastSync < SYNC_TTL_MS) return;

  syncing = (async () => {
    await ensureSchemaMigrations();
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

      // Need to (re-)process: download, metadata, thumbs, placeholder, geocode.
      const raw = await client.getFileContents(item.filename);
      const buf: Buffer = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as ArrayBuffer);
      downloaded++;

      const ext = path.extname(relPath).toLowerCase();
      const isVideo = isVideoExt(ext);
      const kind: 'photo' | 'video' = isVideo ? 'video' : 'photo';

      let exifLat: number | undefined;
      let exifLon: number | undefined;
      let exifDt: string | undefined;
      let camera = '';
      let durationSec: number | undefined;
      let videoCodec = '';
      const bytes = buf.length;
      // posterBuf is what sharp consumes for thumbs + LQIP. For photos it's
      // the original bytes; for videos it's a ffmpeg-extracted frame.
      let posterBuf: Buffer = buf;

      if (isVideo) {
        try {
          await withTempVideoFile(buf, ext, async (p) => {
            const meta = await readVideoMeta(p);
            exifLat = meta.lat;
            exifLon = meta.lon;
            exifDt = meta.datetime;
            camera = meta.camera;
            durationSec = meta.durationSec;
            videoCodec = meta.videoCodec;
            posterBuf = await extractVideoPoster(p);
            // Re-encode HEVC → H.264 so Firefox + Chromium-on-Linux can
            // play. H.264 sources stream directly from Nextcloud with
            // Range; no need to duplicate them locally.
            if (HEVC_CODECS.has(videoCodec)) {
              try { await transcodeToH264(p, key); }
              catch (err) {
                console.warn(`[photos] HEVC transcode failed for ${relPath}:`, err);
              }
            } else {
              // Source isn't HEVC anymore — drop any stale transcode from
              // a previous version of the file.
              await removeTranscoded(key);
            }
          });
        } catch (err) {
          console.warn(`[photos] video processing failed for ${relPath}:`, err);
          // Leave posterBuf as the raw video bytes — sharp will fail on the
          // next step and we'll skip writing thumbs for this one. The row
          // still gets inserted so the file shows up in admin as broken.
        }
      } else {
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
      }

      let placeholder = '';
      try {
        await ensureThumbsFromBuffer(posterBuf, key);
        placeholder = await makePlaceholder(posterBuf);
      } catch (err) {
        console.warn(`[photos] thumb generation failed for ${relPath}:`, err);
      }

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
        kind,
        durationSec: durationSec ?? null,
        videoCodec: videoCodec || null,
        bytes,
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
  const kind: 'photo' | 'video' = r.kind === 'video' ? 'video' : 'photo';
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
    kind,
    durationSec: typeof r.durationSec === 'number' ? r.durationSec : null,
    videoCodec: r.videoCodec || null,
    bytes: typeof r.bytes === 'number' ? r.bytes : null,
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
const MIME_BY_EXT: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
};

export async function fetchOriginalById(
  id: string,
): Promise<{ buffer: Buffer; filename: string; contentType: string } | null> {
  const rows = await db.select().from(PhotoTable);
  const row = rows.find((r) => slugify(r.path) === id);
  if (!row) return null;
  const client = makeClient();
  const data = (await client.getFileContents('/' + row.path)) as Buffer;
  const ext = path.extname(row.file).toLowerCase();
  const contentType = MIME_BY_EXT[ext] || 'application/octet-stream';
  return { buffer: data, filename: row.file, contentType };
}

/**
 * Describes the playable bytes for a row — either the cached on-disk
 * transcode (HEVC inputs) or the original on Nextcloud (H.264 / images).
 * The API route uses this to decide whether to stream from disk or from
 * WebDAV, and to know the total size for Range responses.
 */
export interface PlayableSource {
  /** Suggested download filename. */
  filename: string;
  contentType: string;
  /** Total bytes — needed to compute Content-Length / Content-Range. */
  size: number;
  /** When set, stream from this local file. */
  localPath?: string;
  /** When set, stream from this WebDAV path on the Nextcloud share. */
  remotePath?: string;
}

/**
 * Resolve the playable source for a slugified id — choosing the local
 * transcode when present, else falling back to the original on Nextcloud.
 * Returns null when the row doesn't exist.
 */
export async function getPlayableSourceById(
  id: string,
): Promise<PlayableSource | null> {
  const rows = await db.select().from(PhotoTable);
  const row = rows.find((r) => slugify(r.path) === id);
  if (!row) return null;
  const ext = path.extname(row.file).toLowerCase();

  if (row.kind === 'video') {
    const local = transcodedPath(row.thumbKey);
    try {
      const stat = await fs.stat(local);
      if (stat.size > 0) {
        return {
          filename: row.file.replace(/\.(mov|MOV)$/, '.mp4'),
          contentType: 'video/mp4',
          size: stat.size,
          localPath: local,
        };
      }
    } catch { /* no transcode — fall through */ }
    return {
      filename: row.file,
      contentType: MIME_BY_EXT[ext] || 'video/mp4',
      size: typeof row.bytes === 'number' ? row.bytes : 0,
      remotePath: '/' + row.path,
    };
  }

  // Photos — keep the existing buffered path (fast + tiny). Caller can
  // still treat this as a remote source if they want to stream.
  return {
    filename: row.file,
    contentType: MIME_BY_EXT[ext] || 'application/octet-stream',
    size: typeof row.bytes === 'number' ? row.bytes : 0,
    remotePath: '/' + row.path,
  };
}

/**
 * Parse the HTTP `Range: bytes=start-end` header. Returns null when the
 * header is missing or malformed (caller responds with 200 OK). Returns
 * { start, end } clamped to [0, size-1] inclusive when valid.
 */
export function parseRange(
  header: string | null,
  size: number,
): { start: number; end: number } | null {
  if (!header || !size) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return null;
  let start = m[1] === '' ? NaN : parseInt(m[1], 10);
  let end = m[2] === '' ? NaN : parseInt(m[2], 10);
  if (Number.isNaN(start) && Number.isNaN(end)) return null;
  if (Number.isNaN(start)) {
    // Suffix range: last N bytes.
    const suffix = end;
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else if (Number.isNaN(end)) {
    end = size - 1;
  }
  if (start > end || start < 0 || end >= size) return null;
  return { start, end };
}

/**
 * Open a Node Readable for a slice of a Nextcloud-hosted file. The webdav
 * library handles the `Range` request header for us; the returned stream
 * yields just the requested bytes.
 */
export function openRemoteReadStream(
  remotePath: string,
  range?: { start: number; end: number },
) {
  const client = makeClient();
  return client.createReadStream(remotePath, range ? { range } : undefined);
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
  // Drop the cached transcode too. No-op for photos.
  await removeTranscoded(existing.thumbKey);
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
    // Move the transcoded video cache too if it exists.
    await fs.rename(transcodedPath(existing.thumbKey), transcodedPath(newKey))
      .catch(() => undefined);
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
