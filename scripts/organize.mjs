#!/usr/bin/env node
/**
 * Organise Nextcloud photos into `<country>/<YYYY-MM-DD>/` folders based
 * on what's stored in the SQLite DB (which getPhotos() populates from a
 * fresh Nextcloud sync).
 *
 * Run via the Astro CLI so astro:db + .ts imports resolve:
 *
 *   npm run organize                       # dry-run (prints plan)
 *   npm run organize -- --execute          # actually MOVE files
 *
 * (Or directly: `astro db execute scripts/organize.mjs [--execute]`.)
 *
 * Layout chosen for each photo:
 *   - has country  + has datetime  →  <country>/<YYYY-MM-DD>/<basename>
 *   - has country, no datetime     →  <country>/未分類日期/<basename>
 *   - no country (Unlocated)       →  未分類/<basename>
 *
 * Source of truth comes from `src/lib/photos.ts → getPhotos()` (which
 * triggers `syncFromNextcloud()` first). Each plan entry is applied via
 * `renamePhotoFile(src, dst)` exported from that same module, so the
 * DB row, the on-disk thumbnails, and the Nextcloud file all stay in sync.
 */
import 'dotenv/config';

const EXECUTE = process.argv.includes('--execute');

// .ts is resolved by the Astro CLI's loader, and astro:db is wired up
// the same way. Plain `node scripts/organize.mjs` will fail on both
// counts — bail with a helpful message instead of a cryptic stack.
const mod = await import('../src/lib/photos.ts').catch((err) => {
  console.error('Failed to load src/lib/photos.ts.');
  console.error('This script must be invoked via the Astro CLI so that');
  console.error('.ts files and astro:db resolve. Run one of:');
  console.error('');
  console.error('  npm run organize                 # dry-run');
  console.error('  npm run organize -- --execute    # actually move');
  console.error('');
  console.error('Original error:', err?.message || err);
  process.exit(1);
});

if (typeof mod.invalidatePhotoSync === 'function') mod.invalidatePhotoSync();
const photos = await mod.getPhotos();

if (photos.length === 0) {
  console.error('No photos found. Check that the Nextcloud share has images and that .env is configured.');
  process.exit(1);
}

// Use zh-TW country names for the folder structure — these are what
// the user will see when they open the Nextcloud share in a file
// browser. Mirror the same canonical mapping as src/lib/photos.ts but
// in zh-TW so the folder names read naturally to a Chinese reader.
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
  if (code && COUNTRY_NAME_TW[code.toLowerCase()]) return COUNTRY_NAME_TW[code.toLowerCase()];
  return (country || '').split(/[;/,]/)[0].trim() || UNCATEGORISED_COUNTRY;
}

// --------- Plan ---------
const plan = [];
for (const p of photos) {
  const folder = countryFolder(p.country, p.countryCode);
  let dst;
  if (folder === UNCATEGORISED_COUNTRY) {
    // No country → don't nest a date folder (both axes missing isn't useful)
    dst = `${folder}/${p.file}`;
  } else {
    const day = p.datetime ? p.datetime.slice(0, 10) : UNCATEGORISED_DAY;
    dst = `${folder}/${day}/${p.file}`;
  }
  if (p.path === dst) continue;
  plan.push({ src: p.path, dst, country: folder });
}

// --------- Display plan ---------
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

// --------- Execute ---------
console.log('');
console.log('─'.repeat(72));
console.log('Executing…');
console.log('─'.repeat(72));

let ok = 0;
let failed = 0;
for (const m of plan) {
  const res = await mod.renamePhotoFile(m.src, m.dst);
  if (res.ok) {
    console.log(`  ✓  ${m.src}  →  ${m.dst}`);
    ok++;
  } else {
    console.error(`  ✗  ${m.src}: ${res.error || 'unknown error'}`);
    failed++;
  }
}

if (typeof mod.invalidatePhotoSync === 'function') mod.invalidatePhotoSync();

console.log('');
console.log('─'.repeat(72));
console.log(`Done. ${ok} moved, ${failed} failed.`);
console.log('─'.repeat(72));
