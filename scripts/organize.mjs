#!/usr/bin/env node
/**
 * Organise Nextcloud photos into country folders based on detected metadata.
 *
 *   node scripts/organize.mjs              # dry-run (prints plan)
 *   node scripts/organize.mjs --execute    # actually MOVE files
 *
 * Source of truth for "what country is this photo in":
 *   .astro/photos-cache.json   ← built by getPhotos() at dev/build time
 *
 * Action for each photo:
 *   - has country  → move to "<country>/<basename>"
 *   - no country   → move to "未分類/<basename>"
 *   - already at target → skip
 *
 * Side effects on the local repo when --execute:
 *   - metadata.json keys are rewritten old-path → new-path
 *   - photos-cache.json keys are rewritten old-path → new-path
 *   - public/thumbs/<size>/<thumbKey>.jpg files are renamed
 *   - The Vite watcher will pick up the Nextcloud change within ~30s and reload
 */
import 'dotenv/config';
import { createClient } from 'webdav';
import fs from 'node:fs/promises';
import path from 'node:path';

const EXECUTE = process.argv.includes('--execute');
const PROJECT_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\//, '')), '..');
const CACHE_PATH = path.join(PROJECT_ROOT, '.astro', 'photos-cache.json');
const METADATA_PATH = path.join(PROJECT_ROOT, 'metadata.json');
const THUMBS_DIR = path.join(PROJECT_ROOT, 'public', 'thumbs');
const THUMB_SIZES = ['s', 'm', 'l'];

const UNCATEGORISED = '未分類';

const url = process.env.NEXTCLOUD_URL?.replace(/\/+$/, '');
const token = process.env.NEXTCLOUD_SHARE_TOKEN;
if (!url || !token) {
  console.error('NEXTCLOUD_URL and NEXTCLOUD_SHARE_TOKEN required in .env');
  process.exit(1);
}

const client = createClient(`${url}/public.php/webdav`, {
  username: token,
  password: process.env.NEXTCLOUD_SHARE_PASSWORD || '',
});

// --------- Read state ---------
async function readJson(p, fallback) {
  try {
    return JSON.parse(await fs.readFile(p, 'utf-8'));
  } catch {
    return fallback;
  }
}

const COUNTRY_NAME_TW = {
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

function normalizeCountry(c, code) {
  if (code && COUNTRY_NAME_TW[code.toLowerCase()]) return COUNTRY_NAME_TW[code.toLowerCase()];
  return (c || '').split(/[;/,]/)[0].trim();
}

const cache = await readJson(CACHE_PATH, {});
const metadata = await readJson(METADATA_PATH, {});

const cacheEntries = Object.entries(cache);
if (cacheEntries.length === 0) {
  console.error('photos-cache.json is empty. Open the dev site once first so the cache is populated.');
  process.exit(1);
}

// --------- Find all image files actually on Nextcloud (incl. ones with no GPS) ---------
console.log('Listing all images on Nextcloud…');
const all = await client.getDirectoryContents('/', {
  deep: true,
  glob: '/**/*.{jpg,jpeg,JPG,JPEG}',
});
const liveFiles = all
  .filter((it) => it.type === 'file' && /\.jpe?g$/i.test(it.basename))
  .map((it) => it.filename.replace(/^\/+/, ''));

// --------- Plan ---------
const plan = []; // { src, dst, country, hasGps }

for (const relPath of liveFiles) {
  const basename = path.posix.basename(relPath);
  const cached = cache[relPath];
  let folder = UNCATEGORISED;
  if (cached) {
    const country = normalizeCountry(cached.country, cached.countryCode);
    if (country && country !== '未知') folder = country;
  }
  const dst = `${folder}/${basename}`;
  if (relPath === dst) continue;
  plan.push({ src: relPath, dst, country: folder, hasGps: !!cached });
}

// --------- Display plan ---------
console.log('');
console.log('─'.repeat(72));
console.log(`Plan: ${plan.length} move(s) (out of ${liveFiles.length} files)`);
console.log('─'.repeat(72));

const byCountry = new Map();
for (const m of plan) {
  if (!byCountry.has(m.country)) byCountry.set(m.country, []);
  byCountry.get(m.country).push(m);
}
for (const [country, moves] of [...byCountry.entries()].sort()) {
  console.log(`\n  📁 ${country}/  (${moves.length})`);
  for (const m of moves) {
    console.log(`     ${m.src}  →  ${m.dst}`);
  }
}

if (!EXECUTE) {
  console.log('');
  console.log('─'.repeat(72));
  console.log('Dry-run only. Re-run with --execute to actually move files.');
  console.log('─'.repeat(72));
  process.exit(0);
}

// --------- Execute ---------
console.log('');
console.log('─'.repeat(72));
console.log('Executing…');
console.log('─'.repeat(72));

function thumbKeyOf(p) {
  return p.replace(/\.(jpe?g)$/i, '').replace(/[\/\\]/g, '__');
}

let ok = 0, failed = 0;
const createdDirs = new Set();

async function ensureDir(folder) {
  if (folder === '' || createdDirs.has(folder)) return;
  try {
    await client.createDirectory('/' + folder, { recursive: true });
  } catch (err) {
    // ignore "exists" failures (Nextcloud returns 405 if dir exists)
  }
  createdDirs.add(folder);
}

for (const m of plan) {
  const dstFolder = path.posix.dirname(m.dst);
  try {
    await ensureDir(dstFolder);
    await client.moveFile('/' + m.src, '/' + m.dst);

    // 1. metadata.json: rename key
    if (metadata[m.src]) {
      metadata[m.dst] = metadata[m.src];
      delete metadata[m.src];
    }
    // 2. photos-cache.json: rename key + update thumbKey
    if (cache[m.src]) {
      const newThumbKey = thumbKeyOf(m.dst);
      const oldThumbKey = cache[m.src].thumbKey;
      cache[m.dst] = { ...cache[m.src], thumbKey: newThumbKey };
      delete cache[m.src];

      // 3. Rename thumb files
      for (const size of THUMB_SIZES) {
        const oldT = path.join(THUMBS_DIR, size, `${oldThumbKey}.jpg`);
        const newT = path.join(THUMBS_DIR, size, `${newThumbKey}.jpg`);
        try {
          await fs.rename(oldT, newT);
        } catch {
          /* thumb missing — will regenerate on next dev hit */
        }
      }
    }
    console.log(`  ✓  ${m.src}  →  ${m.dst}`);
    ok++;
  } catch (err) {
    console.error(`  ✗  ${m.src}: ${err.message || err}`);
    failed++;
  }
}

await fs.writeFile(METADATA_PATH, JSON.stringify(metadata, null, 2), 'utf-8');
await fs.writeFile(CACHE_PATH, JSON.stringify(cache, null, 2), 'utf-8');

console.log('');
console.log('─'.repeat(72));
console.log(`Done. ${ok} moved, ${failed} failed.`);
console.log('Vite watcher will pick this up within ~30s and reload the page.');
console.log('─'.repeat(72));
