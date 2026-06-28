#!/usr/bin/env node
/**
 * Local backup: zips the DB + metadata + thumbs into ./backups/.
 *
 * Usage:  npm run backup
 *
 * Restores: extract the zip and overwrite the files in-place.
 */
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve('.');
const BACKUPS_DIR = path.join(ROOT, 'backups');
if (!fs.existsSync(BACKUPS_DIR)) fs.mkdirSync(BACKUPS_DIR, { recursive: true });

const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const outName = `photo-portfolio-${stamp}.zip`;
const outPath = path.join(BACKUPS_DIR, outName);

// Items to include — only stuff that's not regeneratable.
// Thumbs live in dist/client/thumbs/ in built mode (production), but a
// dev checkout has them in public/thumbs/ — back up whichever exists.
const items = [
  '.astro/content.db',
  'metadata.json',
  '.env.example',
  fs.existsSync('dist/client/thumbs') ? 'dist/client/thumbs' : 'public/thumbs',
];

const present = items.filter((p) => fs.existsSync(p));
if (present.length === 0) {
  console.error('Nothing to back up — DB and metadata missing?');
  process.exit(1);
}

console.log(`Creating backup: ${outName}`);
console.log('Including:', present.join(', '));

try {
  // Capture stdout + stderr so a failure surfaces the *actual* zip error
  // (path missing, no write perm, name too long, …) instead of just
  // "Command failed: zip -rq …". Previously we used stdio:'inherit' which
  // sent everything to the parent's TTY and the API caller saw nothing.
  if (process.platform === 'win32') {
    const escaped = present.map((p) => `'${p.replace(/'/g, "''")}'`).join(',');
    execSync(
      `powershell -NoLogo -NoProfile -Command "Compress-Archive -Path ${escaped} -DestinationPath '${outPath}' -Force"`,
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
  } else {
    execSync(
      `zip -rq "${outPath}" ${present.map((p) => `"${p}"`).join(' ')}`,
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
  }
  const size = (fs.statSync(outPath).size / 1024 / 1024).toFixed(1);
  console.log(`✓ Backup saved: ${outPath} (${size} MB)`);
} catch (err) {
  // execSync attaches the captured pipes on the thrown error.
  const stderr = err?.stderr?.toString?.() || '';
  const stdout = err?.stdout?.toString?.() || '';
  const detail = (stderr || stdout || err?.message || String(err)).trim();
  console.error('Backup failed:', detail);
  process.exit(1);
}

// ---- Retention: grandfather-father-son rotation ---------------------------
// Without pruning, a daily cron piles up a zip a day forever. Cap the set:
//   - last 7 daily backups (one per calendar day)
//   - one per ISO week for the last 4 weeks
//   - one per calendar month for the last 12 months
// Anything not in those buckets gets deleted. Worst case ≈ 23 zips on disk.
function pruneOldBackups() {
  const DAY = 86_400_000;
  const now = Date.now();

  const backups = fs.readdirSync(BACKUPS_DIR)
    .filter((f) => /^photo-portfolio-\d{4}-\d{2}-\d{2}/.test(f) && f.endsWith('.zip'))
    .map((name) => {
      const m = name.match(/^photo-portfolio-(\d{4}-\d{2}-\d{2})/);
      return { name, time: new Date(m[1]).getTime() };
    })
    .sort((a, b) => b.time - a.time); // newest first

  const keep = new Set();

  // Daily — newest backup per calendar day, last 7 days.
  const daySeen = new Set();
  for (const b of backups) {
    const dayKey = Math.floor((now - b.time) / DAY);
    if (dayKey < 7 && !daySeen.has(dayKey)) {
      daySeen.add(dayKey);
      keep.add(b.name);
    }
  }

  // Weekly — newest backup per ISO week, last 4 weeks.
  const weekSeen = new Set();
  for (const b of backups) {
    const weekKey = Math.floor((now - b.time) / (7 * DAY));
    if (weekKey < 4 && !weekSeen.has(weekKey)) {
      weekSeen.add(weekKey);
      keep.add(b.name);
    }
  }

  // Monthly — newest backup per calendar month, last 12 months.
  const monthSeen = new Set();
  for (const b of backups) {
    const d = new Date(b.time);
    const monthKey = `${d.getUTCFullYear()}-${d.getUTCMonth()}`;
    const monthsAgo = (now - b.time) / (30 * DAY);
    if (monthsAgo < 12 && !monthSeen.has(monthKey)) {
      monthSeen.add(monthKey);
      keep.add(b.name);
    }
  }

  let pruned = 0;
  for (const b of backups) {
    if (!keep.has(b.name)) {
      fs.unlinkSync(path.join(BACKUPS_DIR, b.name));
      pruned++;
    }
  }
  if (pruned > 0) console.log(`✓ Pruned ${pruned} old backup(s); ${keep.size} retained.`);
}

pruneOldBackups();
