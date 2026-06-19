/**
 * Photo discovery + EXIF + thumbnail pipeline (Nextcloud edition).
 *
 * Source of truth: a public-share Nextcloud folder, read via WebDAV.
 *   - List files recursively
 *   - Read EXIF (GPS + datetime) by fetching the file once, then caching it
 *   - Generate multi-size thumbnails into public/thumbs/<size>/ via sharp
 *   - Originals are served straight from Nextcloud (public download URL)
 *
 * Caching: .astro/photos-cache.json maps file -> { etag/mtime, lat, lon, datetime }.
 * If etag is unchanged, we skip the download AND skip thumbnail regeneration.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import exifr from 'exifr';
import sharp from 'sharp';
import { createClient, type FileStat, type WebDAVClient } from 'webdav';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '../..');

// Astro/Vite loads .env into import.meta.env; node CLI tools see process.env.
const env: Record<string, string | undefined> =
  (typeof import.meta !== 'undefined' && (import.meta as any).env) || process.env;
const NEXTCLOUD_URL = (env.NEXTCLOUD_URL || '').replace(/\/+$/, '');
const SHARE_TOKEN = env.NEXTCLOUD_SHARE_TOKEN || '';
const SHARE_PASSWORD = env.NEXTCLOUD_SHARE_PASSWORD || '';

const THUMBS_DIR = path.join(PROJECT_ROOT, 'public', 'thumbs');
const METADATA_PATH = path.join(PROJECT_ROOT, 'metadata.json');
const CACHE_DIR = path.join(PROJECT_ROOT, '.astro');
const CACHE_PATH = path.join(CACHE_DIR, 'photos-cache.json');

const IMG_EXTS = new Set(['.jpg', '.jpeg']);

/**
 * Sizes (longest edge) and crop strategy.
 *   - 'cover'  → centre-cropped to a perfect square. Used by the round map
 *                markers so a portrait photo still fills the whole circle.
 *   - 'inside' → keeps original aspect ratio, longest edge fits the target.
 */
export const THUMB_SPECS = {
  s: { px: 200, fit: 'cover' as const },   // map marker (square)
  m: { px: 400, fit: 'inside' as const },  // timeline grid
  l: { px: 1200, fit: 'inside' as const }, // lightbox / detail
};
export const THUMB_SIZES = {
  s: THUMB_SPECS.s.px,
  m: THUMB_SPECS.m.px,
  l: THUMB_SPECS.l.px,
} as const;
export type ThumbSize = keyof typeof THUMB_SPECS;

export interface Photo {
  /** Path relative to the shared folder root, e.g. "2024-tokyo/IMG_001.jpg". */
  path: string;
  /** URL/file-system safe id derived from path. */
  id: string;
  /** Bare filename (used as thumb storage key). */
  file: string;
  /** Tiny base64 placeholder for skeleton/blur-up effect. */
  placeholder: string;
  /** null when the photo has no EXIF GPS and no manual pin yet. */
  lat: number | null;
  lon: number | null;
  /** True when lat/lon came from a metadata.json pin, not from EXIF. */
  manualLocation: boolean;
  /** ISO 8601 (no Z), e.g. "2024-12-26T10:39:48". May be empty if EXIF was unreadable. */
  datetime: string;
  /** True when the date came from metadata.json override (not EXIF). */
  manualDatetime: boolean;
  /** Localised country name from reverse-geocode (e.g. "日本", "台灣"). Empty when no location. */
  country: string;
  /** ISO 3166-1 alpha-2, lowercase (e.g. "jp", "tw"). */
  countryCode: string;
  title: string;
  album: string;
  description: string;
  thumbs: Record<ThumbSize, string>;
  /** Direct Nextcloud download URL for the original. */
  originalUrl: string;
}

interface MetadataEntry {
  title?: string;
  album?: string;
  description?: string;
  /** User-pinned manual location for photos with no/wrong EXIF GPS. */
  lat?: number;
  lon?: number;
  /** User-set date for photos with missing/wrong EXIF DateTimeOriginal. */
  datetime?: string; // ISO "YYYY-MM-DD" or "YYYY-MM-DDTHH:MM:SS"
}
type Metadata = Record<string, MetadataEntry>;

interface CacheEntry {
  etag: string;
  lat: number;
  lon: number;
  datetime: string;
  thumbKey: string; // basename used in /thumbs/<size>/
  country?: string;
  countryCode?: string;
  /** Tiny base64 data-URI for the skeleton placeholder (16px wide WebP). */
  placeholder?: string;
}
type Cache = Record<string, CacheEntry>;

// ---------- Reverse geocoding (country only) ----------

/**
 * Coarse "is this the same place as last time?" cache to avoid hammering
 * Nominatim — adjacent photos are nearly always in the same country.
 * Key is the rounded lat/lon (0.5 degree ≈ 55 km).
 */
const geoBucketCache = new Map<string, { country: string; countryCode: string }>();

let lastGeoRequestAt = 0;
async function rateLimitedNominatim(lat: number, lon: number): Promise<{ country: string; countryCode: string } | null> {
  // Nominatim usage policy: max 1 req/sec, identifying User-Agent required.
  const delta = Date.now() - lastGeoRequestAt;
  if (delta < 1100) await new Promise((r) => setTimeout(r, 1100 - delta));
  lastGeoRequestAt = Date.now();
  const url = `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=jsonv2&zoom=3&accept-language=zh-TW,zh,en`;
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'photo-portfolio/0.1 (https://github.com/ben/photo-portfolio)',
        'Accept-Language': 'zh-TW,zh,en',
      },
    });
    if (!res.ok) {
      console.warn(`[photos] Nominatim ${res.status} for ${lat},${lon}`);
      return null;
    }
    const data: any = await res.json();
    // OSM `name` sometimes packs multiple language variants in one string
    // separated by ";" or "/" — take the first.
    const rawCountry = data?.address?.country || '';
    const country = rawCountry.split(/[;/,]/)[0].trim();
    const countryCode = (data?.address?.country_code || '').toLowerCase();
    if (!country) return null;
    return { country, countryCode };
  } catch (err) {
    console.warn(`[photos] reverse geocode failed:`, err);
    return null;
  }
}

async function getCountry(lat: number, lon: number): Promise<{ country: string; countryCode: string }> {
  const bucketKey = `${Math.round(lat * 2) / 2},${Math.round(lon * 2) / 2}`;
  const cached = geoBucketCache.get(bucketKey);
  if (cached) return cached;
  const result = (await rateLimitedNominatim(lat, lon)) ?? { country: '未知', countryCode: '' };
  geoBucketCache.set(bucketKey, result);
  return result;
}

/** Preferred zh-TW country name by ISO 3166-1 alpha-2. */
const COUNTRY_NAME_TW: Record<string, string> = {
  jp: '日本', tw: '臺灣', cn: '中國', hk: '香港', mo: '澳門',
  my: '馬來西亞', sg: '新加坡', th: '泰國', vn: '越南', ph: '菲律賓',
  id: '印尼', kr: '韓國', kp: '北韓', in: '印度',
  de: '德國', fr: '法國', it: '義大利', es: '西班牙', nl: '荷蘭',
  ch: '瑞士', at: '奧地利', be: '比利時', cz: '捷克', sk: '斯洛伐克',
  hu: '匈牙利', pl: '波蘭', pt: '葡萄牙', se: '瑞典', no: '挪威',
  fi: '芬蘭', dk: '丹麥', ie: '愛爾蘭', gb: '英國', uk: '英國',
  us: '美國', ca: '加拿大', mx: '墨西哥', au: '澳洲', nz: '紐西蘭',
  br: '巴西', ar: '阿根廷', cl: '智利', ru: '俄羅斯', tr: '土耳其',
  eg: '埃及', za: '南非', ae: '阿聯酋', sa: '沙烏地阿拉伯', il: '以色列',
};

/**
 * Returns a clean, zh-TW country name from a (possibly multi-lingual) raw
 * Nominatim string and an ISO code. We prefer the curated override; otherwise
 * we strip multi-language separators ("德国;德國" → "德国").
 */
function normalizeCountryName(raw: string, code?: string): string {
  if (code && COUNTRY_NAME_TW[code.toLowerCase()]) return COUNTRY_NAME_TW[code.toLowerCase()];
  return (raw || '').split(/[;/,]/)[0].trim();
}

// ---------- IO helpers ----------

async function readJson<T>(p: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await fs.readFile(p, 'utf-8'));
  } catch {
    return fallback;
  }
}

async function writeJson(p: string, data: unknown) {
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, JSON.stringify(data, null, 2), 'utf-8');
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

/** A flat key suitable for `/thumbs/<size>/<key>.jpg` (extension stripped). */
function thumbKey(relPath: string): string {
  return relPath.replace(/\.(jpe?g)$/i, '').replace(/[\/\\]/g, '__');
}

// ---------- WebDAV ----------

function makeClient(): WebDAVClient {
  if (!NEXTCLOUD_URL || !SHARE_TOKEN) {
    throw new Error(
      'NEXTCLOUD_URL and NEXTCLOUD_SHARE_TOKEN must be set in .env'
    );
  }
  // Public share endpoint
  return createClient(`${NEXTCLOUD_URL}/public.php/webdav`, {
    username: SHARE_TOKEN,
    password: SHARE_PASSWORD,
  });
}

/** Direct download URL for a file inside the public share. */
function originalUrl(relPath: string): string {
  // /s/TOKEN/download?path=<dir>&files=<basename>
  const dir = path.posix.dirname('/' + relPath);
  const file = path.posix.basename(relPath);
  const params = new URLSearchParams({ path: dir, files: file });
  return `${NEXTCLOUD_URL}/s/${SHARE_TOKEN}/download?${params}`;
}

async function listFilesRecursive(client: WebDAVClient): Promise<FileStat[]> {
  const items = (await client.getDirectoryContents('/', {
    deep: true,
    glob: '/**/*.{jpg,jpeg,JPG,JPEG}',
  })) as FileStat[];
  return items.filter((it) => it.type === 'file' && IMG_EXTS.has(path.extname(it.basename).toLowerCase()));
}

// ---------- Thumbnail pipeline ----------

/**
 * Generate a tiny WebP (16px wide, ~200 bytes) for use as a CSS background
 * skeleton while the real thumb downloads. Returns a data URI.
 */
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
      /* dir doesn't exist — fine */
    }
  }
  return removed;
}

// ---------- Public API ----------

let cache: { photos: Photo[]; loadedAt: number } | null = null;

export async function getPhotos(opts: { force?: boolean } = {}): Promise<Photo[]> {
  if (cache && !opts.force) return cache.photos;

  const client = makeClient();
  const [files, metadata, fileCache] = await Promise.all([
    listFilesRecursive(client),
    readJson<Metadata>(METADATA_PATH, {}),
    readJson<Cache>(CACHE_PATH, {}),
  ]);

  console.log(`[photos] Nextcloud: found ${files.length} image file(s)`);

  let metadataChanged = false;
  let cacheChanged = false;
  let downloaded = 0;
  let skipped = 0;
  const photos: Photo[] = [];
  const liveThumbKeys = new Set<string>();

  for (const item of files) {
    const relPath = item.filename.replace(/^\/+/, '');
    const etag = String(item.etag ?? item.lastmod ?? '');
    const key = thumbKey(relPath);
    liveThumbKeys.add(key);

    const cached = fileCache[relPath];
    const metaEntry = metadata[relPath];
    let lat: number | null = null;
    let lon: number | null = null;
    let datetime: string = '';
    let country: string = '';
    let countryCode: string = '';
    let manualLocation = false;
    let manualDatetime = !!metaEntry?.datetime;

    // Cache hit needs to also match the manual-location AND manual-datetime
    // overrides (if any) — otherwise editing them wouldn't take effect.
    const manualLocMatches =
      metaEntry?.lat === undefined ||
      (cached?.lat === metaEntry.lat && cached?.lon === metaEntry.lon);
    const manualDateMatches =
      metaEntry?.datetime === undefined ||
      cached?.datetime?.startsWith(metaEntry.datetime);

    if (cached && cached.etag === etag && cached.country !== undefined && manualLocMatches && manualDateMatches) {
      lat = (cached.lat as number | null) ?? null;
      lon = (cached.lon as number | null) ?? null;
      datetime = cached.datetime;
      country = cached.country;
      countryCode = cached.countryCode || '';
      manualLocation = !!metaEntry?.lat;
      skipped++;
    } else {
      // Download the file once for EXIF + thumbnails
      const raw = await client.getFileContents(item.filename);
      const buf: Buffer = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as ArrayBuffer);
      downloaded++;
      // exifr's `pick` filters out the computed `latitude`/`longitude` fields,
      // so we parse without it. Pulling only EXIF + GPS segments keeps it fast.
      let latitude: number | undefined;
      let longitude: number | undefined;
      let dt: unknown;
      try {
        const parsed = await exifr.parse(buf, {
          ifd0: false,
          exif: ['DateTimeOriginal'],
          gps: true,
          interop: false,
          thumbnail: false,
          iptc: false,
          icc: false,
          xmp: false,
          jfif: false,
        });
        latitude = parsed?.latitude;
        longitude = parsed?.longitude;
        dt = parsed?.DateTimeOriginal;
      } catch {
        /* unreadable */
      }
      // Manual location/datetime from metadata overrides EXIF.
      if (metaEntry?.lat !== undefined && metaEntry?.lon !== undefined) {
        latitude = metaEntry.lat;
        longitude = metaEntry.lon;
        manualLocation = true;
      }
      if (metaEntry?.datetime) {
        // Accept either "YYYY-MM-DD" or full ISO; normalise.
        const d = metaEntry.datetime;
        dt = d.length === 10 ? `${d}T00:00:00` : d;
      }
      datetime = exifDateToIso(dt);

      // Always generate thumbs + placeholder, even for photos without a location.
      await ensureThumbsFromBuffer(buf, key);
      const placeholder = await makePlaceholder(buf);

      if (latitude && longitude) {
        lat = latitude;
        lon = longitude;
        const geo = await getCountry(lat, lon);
        country = geo.country;
        countryCode = geo.countryCode;
      } else {
        // No GPS yet — photo still shows up in a "未定位" bucket so the user
        // can open its detail page and pin a location.
        country = '未定位';
        countryCode = '';
        console.warn(`[photos] ${relPath} → no GPS yet (kept in 未定位)`);
      }
      fileCache[relPath] = {
        etag,
        lat: lat as number,
        lon: lon as number,
        datetime,
        thumbKey: key,
        country,
        countryCode,
        placeholder,
      };
      cacheChanged = true;
    }

    if (!metadata[relPath]) {
      metadata[relPath] = { title: '', album: '', description: '' };
      metadataChanged = true;
    }
    const md = metadata[relPath];

    photos.push({
      path: relPath,
      id: slugify(relPath),
      file: path.posix.basename(relPath),
      placeholder: fileCache[relPath]?.placeholder || '',
      lat,
      lon,
      manualLocation,
      datetime,
      manualDatetime,
      country: normalizeCountryName(country, countryCode),
      countryCode,
      title: md.title || '',
      album: md.album || '',
      description: md.description || '',
      thumbs: Object.fromEntries(
        // Percent-encode the filename so non-ASCII (e.g. Chinese folder names
        // baked into `key`) survives every browser / proxy / Vite middleware.
        Object.keys(THUMB_SPECS).map((s) => [s, `/thumbs/${s}/${encodeURIComponent(key)}.webp`])
      ) as Record<ThumbSize, string>,
      originalUrl: originalUrl(relPath),
    });
  }

  // Remove stale cache entries (files deleted in Nextcloud)
  const liveRel = new Set(photos.map((p) => p.path));
  for (const k of Object.keys(fileCache)) {
    if (!liveRel.has(k)) {
      delete fileCache[k];
      cacheChanged = true;
    }
  }

  const removed = await cleanupOrphanThumbs(liveThumbKeys);
  if (metadataChanged) await writeJson(METADATA_PATH, metadata);
  if (cacheChanged) await writeJson(CACHE_PATH, fileCache);

  photos.sort((a, b) => a.datetime.localeCompare(b.datetime));
  cache = { photos, loadedAt: Date.now() };

  console.log(
    `[photos] ready: ${photos.length} photos, ${downloaded} downloaded, ${skipped} cached, ${removed} stale thumbs removed`
  );
  return photos;
}

export function clearPhotoCache() {
  cache = null;
}

export async function getPhotoById(id: string): Promise<Photo | undefined> {
  return (await getPhotos()).find((p) => p.id === id);
}
