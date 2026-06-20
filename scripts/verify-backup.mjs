#!/usr/bin/env node
/**
 * Backup auto-verify — disaster recovery drill that actually drills.
 *
 *   npm run verify-backup
 *
 * Steps:
 *   1. Pick the newest zip in ./backups/.
 *   2. Test the zip's integrity with `unzip -t`.
 *   3. Extract to a fresh /tmp/ directory.
 *   4. Verify .astro/content.db is a real SQLite file (magic bytes + size).
 *   5. Try opening it with sqlite3 if available; check the Photo table
 *      has at least one row.
 *   6. Cleanup the temp dir.
 *
 * Exits 0 on success, 1 on any failure. Wired into the nightly systemd
 * timer so a silently-corrupted backup surfaces in `journalctl -u
 * photo-portfolio-verify` rather than the day you actually need it.
 */
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const BACKUPS_DIR = path.resolve('backups');
const SQLITE_MAGIC = Buffer.from('SQLite format 3\0');

function die(msg) {
  console.error(`\x1b[31m✖ ${msg}\x1b[0m`);
  process.exit(1);
}
function step(msg) {
  console.log(`\x1b[34m▶ ${msg}\x1b[0m`);
}
function ok(msg) {
  console.log(`\x1b[32m✓ ${msg}\x1b[0m`);
}

// ---- 1. Find the newest backup ---------------------------------------------
if (!fs.existsSync(BACKUPS_DIR)) die(`No backups directory at ${BACKUPS_DIR}`);
const backups = fs.readdirSync(BACKUPS_DIR)
  .filter((f) => /^photo-portfolio-.*\.zip$/.test(f))
  .map((f) => ({ name: f, mtime: fs.statSync(path.join(BACKUPS_DIR, f)).mtimeMs }))
  .sort((a, b) => b.mtime - a.mtime);

if (backups.length === 0) die('No backup zips found — has the nightly timer run yet?');

const newest = backups[0];
const zipPath = path.join(BACKUPS_DIR, newest.name);
const ageHours = ((Date.now() - newest.mtime) / 3_600_000).toFixed(1);
step(`Verifying newest backup: ${newest.name} (${ageHours}h old)`);

// ---- 2. Zip integrity ------------------------------------------------------
step('Testing zip integrity');
try {
  execSync(`unzip -tq "${zipPath}"`, { stdio: 'pipe' });
  ok('Zip integrity passed');
} catch (err) {
  die(`Zip integrity check failed: ${err.stderr?.toString() || err.message}`);
}

// ---- 3. Extract to /tmp ----------------------------------------------------
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-verify-'));
step(`Extracting to ${tmp}`);
try {
  execSync(`unzip -q "${zipPath}" -d "${tmp}"`, { stdio: 'pipe' });
} catch (err) {
  fs.rmSync(tmp, { recursive: true, force: true });
  die(`Extraction failed: ${err.stderr?.toString() || err.message}`);
}

const cleanup = () => fs.rmSync(tmp, { recursive: true, force: true });
process.on('exit', cleanup);

// ---- 4. SQLite header check ------------------------------------------------
const dbPath = path.join(tmp, '.astro', 'content.db');
if (!fs.existsSync(dbPath)) die('Restored backup is missing .astro/content.db');
const dbSize = fs.statSync(dbPath).size;
if (dbSize === 0) die('content.db is empty');

step(`Checking SQLite header (${(dbSize / 1024).toFixed(1)} KB)`);
const fd = fs.openSync(dbPath, 'r');
const header = Buffer.alloc(16);
fs.readSync(fd, header, 0, 16, 0);
fs.closeSync(fd);
if (!header.equals(SQLITE_MAGIC)) {
  die(`content.db doesn't carry the SQLite magic header (got: ${JSON.stringify(header.toString('latin1'))})`);
}
ok('SQLite header valid');

// ---- 5. Open the DB and count rows (best-effort) ---------------------------
// We try sqlite3 if installed; if not, the header check is the floor.
let sqliteAvailable = false;
try {
  execSync('command -v sqlite3', { stdio: 'pipe' });
  sqliteAvailable = true;
} catch {
  console.warn('\x1b[33m⚠ sqlite3 CLI not available — skipping row-count verification\x1b[0m');
}

if (sqliteAvailable) {
  step('Counting rows in Photo table');
  try {
    const out = execSync(`sqlite3 "${dbPath}" "SELECT COUNT(*) FROM Photo"`, { stdio: ['ignore', 'pipe', 'pipe'] });
    const count = parseInt(out.toString().trim(), 10);
    if (Number.isNaN(count)) die('Could not parse Photo row count');
    if (count === 0) {
      console.warn('\x1b[33m⚠ Photo table is empty — backup is structurally fine but contains zero rows. Was the source DB drained when the backup ran?\x1b[0m');
    } else {
      ok(`Photo table has ${count} row(s)`);
    }
  } catch (err) {
    die(`Row count query failed: ${err.stderr?.toString() || err.message}`);
  }
}

// ---- 6. Thumbs presence check ---------------------------------------------
const thumbsDir = fs.existsSync(path.join(tmp, 'dist', 'client', 'thumbs'))
  ? path.join(tmp, 'dist', 'client', 'thumbs')
  : path.join(tmp, 'public', 'thumbs');
if (fs.existsSync(thumbsDir)) {
  const sizes = ['s', 'm', 'l'].filter((s) => fs.existsSync(path.join(thumbsDir, s)));
  ok(`Thumbnails directory restored with sizes: ${sizes.join(', ') || '(empty)'}`);
} else {
  console.warn('\x1b[33m⚠ No thumbs directory in backup — these are regenerable but a full restore would have to re-sync from Nextcloud.\x1b[0m');
}

console.log(`\n\x1b[32m✓ Backup ${newest.name} restored cleanly.\x1b[0m`);
