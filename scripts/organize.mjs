#!/usr/bin/env node
/**
 * Organise Nextcloud photos into `<country>/<YYYY-MM-DD>/` folders based
 * on what's stored in the SQLite DB (which getPhotos() populates from a
 * fresh Nextcloud sync).
 *
 * This script talks to the DB directly via @libsql/client and to
 * Nextcloud directly via webdav — NO `astro:db`, NO `.ts` imports — so
 * it can run as plain `node` inside the Docker container (where the
 * runtime stage doesn't include `src/`) AND on the host. Avoids three
 * earlier dead ends: tree-shaking dropping helper exports from the
 * built chunk, `astro db execute` bundling the script to /app/ and
 * breaking relative imports, and `astro:db` not resolving inside
 * dynamically-imported .ts files.
 *
 *   node scripts/organize.mjs              # dry-run (prints plan)
 *   node scripts/organize.mjs --execute    # actually MOVE files
 *
 * Layout chosen for each photo:
 *   - has country  + has datetime  →  <country>/<YYYY-MM-DD>/<basename>
 *   - has country, no datetime     →  <country>/未分類日期/<basename>
 *   - no country (Unlocated)       →  未分類/<basename>
 *
 * For each plan entry we:
 *   1. WebDAV-move the file on Nextcloud to its new path
 *   2. Rename the three on-disk WebP thumbs (s/m/l) to match the new key
 *   3. UPDATE the Photo row's path / file / thumbKey / updatedAt
 *
 * Idempotent: re-running after a successful move sees the file already
 * at its target and produces an empty plan.
 */
import 'dotenv/config';
import path from 'node:path';
import fs from 'node:fs/promises';
import { createClient as createWebdavClient } from 'webdav';
import { createClient as createDbClient } from '@libsql/client';

const EXECUTE = process.argv.includes('--execute');

// ---------- Config from env ----------
const NEXTCLOUD_URL = (process.env.NEXTCLOUD_URL || '').replace(/\/+$/, '');
const SHARE_TOKEN = process.env.NEXTCLOUD_SHARE_TOKEN || '';
const SHARE_PASSWORD = process.env.NEXTCLOUD_SHARE_PASSWORD || '';
if (!NEXTCLOUD_URL || !SHARE_TOKEN) {
  console.error('NEXTCLOUD_URL and NEXTCLOUD_SHARE_TOKEN must be set in .env');
  process.exit(1);
}

// In a built SSR deploy public/ has been copied into dist/client/, and
// the runtime serves thumbs from there. Mirror src/lib/photos.ts's
// IS_PROD-based decision so we rename the right files.
const IS_PROD = (process.env.NODE_ENV || '') === 'production';
const DB_PATH = path.resolve(process.cwd(), '.astro', 'content.db');
const THUMBS_DIR = IS_PROD
  ? path.resolve(process.cwd(), 'dist', 'client', 'thumbs')
  : path.resolve(process.cwd(), 'public', 'thumbs');
const THUMB_SIZES = ['s', 'm', 'l'];

// ---------- Country folder names (zh-TW so they read naturally in the share UI) ----------
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
const UNCATEGORISED_COUNTRY = '未分類';
const UNCATEGORISED_DAY = '未分類日期';

function countryFolder(country, code) {
  if (!country || country === 'Unlocated') return UNCATEGORISED_COUNTRY;
  if (code && COUNTRY_NAME_TW[String(code).toLowerCase()]) {
    return COUNTRY_NAME_TW[String(code).toLowerCase()];
  }
  return (country || '').split(/[;/,]/)[0].trim() || UNCATEGORISED_COUNTRY;
}

function thumbKey(p) {
  return p.replace(/\.(jpe?g)$/i, '').replace(/[/\\]/g, '__');
}

// ---------- Read all photo rows ----------
const db = createDbClient({ url: `file:${DB_PATH}` });

let result;
try {
  result = await db.execute(
    'SELECT path, file, lat, lon, datetime, country, countryCode, thumbKey FROM Photo',
  );
} catch (err) {
  console.error('Failed to read the Photo table from', DB_PATH);
  console.error('Has the app run at least once to populate the DB?');
  console.error('Original error:', err?.message || err);
  process.exit(1);
}

const photos = result.rows;
if (!photos.length) {
  console.error('No photos found in DB. Open /map (or /timeline) once first so that');
  console.error('syncFromNextcloud() populates the table, then retry.');
  process.exit(1);
}

// ---------- Plan ----------
const plan = [];
for (const p of photos) {
  const folder = countryFolder(p.country, p.countryCode);
  let dst;
  if (folder === UNCATEGORISED_COUNTRY) {
    // Both axes missing isn't useful — don't nest a date folder
    dst = `${folder}/${p.file}`;
  } else {
    const day = p.datetime ? String(p.datetime).slice(0, 10) : UNCATEGORISED_DAY;
    dst = `${folder}/${day}/${p.file}`;
  }
  if (p.path === dst) continue;
  plan.push({ src: p.path, dst, country: folder, oldThumbKey: p.thumbKey });
}

// ---------- Display plan ----------
console.log('');
console.log('─'.repeat(72));
console.log(`Plan: ${plan.length} move(s) (out of ${photos.length} photos)`);
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

// ---------- Execute ----------
console.log('');
console.log('─'.repeat(72));
console.log('Executing…');
console.log('─'.repeat(72));

const webdav = createWebdavClient(`${NEXTCLOUD_URL}/public.php/webdav`, {
  username: SHARE_TOKEN,
  password: SHARE_PASSWORD,
});

let ok = 0;
let failed = 0;
const createdDirs = new Set();

for (const m of plan) {
  const dstDir = path.posix.dirname(m.dst);
  try {
    if (dstDir && dstDir !== '.' && !createdDirs.has(dstDir)) {
      // Nextcloud returns 405 if the directory already exists — fine to ignore
      try {
        await webdav.createDirectory('/' + dstDir, { recursive: true });
      } catch {
        /* exists */
      }
      createdDirs.add(dstDir);
    }
    await webdav.moveFile('/' + m.src, '/' + m.dst);

    const newKey = thumbKey(m.dst);
    if (m.oldThumbKey !== newKey) {
      for (const size of THUMB_SIZES) {
        const oldT = path.join(THUMBS_DIR, size, `${m.oldThumbKey}.webp`);
        const newT = path.join(THUMBS_DIR, size, `${newKey}.webp`);
        await fs.rename(oldT, newT).catch(() => undefined);
      }
    }

    await db.execute({
      sql: 'UPDATE Photo SET path = ?, file = ?, thumbKey = ?, updatedAt = ? WHERE path = ?',
      args: [m.dst, path.posix.basename(m.dst), newKey, new Date().toISOString(), m.src],
    });

    console.log(`  ✓  ${m.src}  →  ${m.dst}`);
    ok++;
  } catch (err) {
    console.error(`  ✗  ${m.src}: ${err?.message || err}`);
    failed++;
  }
}

console.log('');
console.log('─'.repeat(72));
console.log(`Done. ${ok} moved, ${failed} failed.`);
console.log('─'.repeat(72));
process.exit(failed > 0 ? 1 : 0);
