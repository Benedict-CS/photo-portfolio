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
  // PowerShell's Compress-Archive is on every Windows box; on *nix use `zip`.
  if (process.platform === 'win32') {
    const escaped = present.map((p) => `'${p.replace(/'/g, "''")}'`).join(',');
    execSync(`powershell -NoLogo -NoProfile -Command "Compress-Archive -Path ${escaped} -DestinationPath '${outPath}' -Force"`, { stdio: 'inherit' });
  } else {
    execSync(`zip -rq "${outPath}" ${present.map((p) => `"${p}"`).join(' ')}`, { stdio: 'inherit' });
  }
  const size = (fs.statSync(outPath).size / 1024 / 1024).toFixed(1);
  console.log(`✓ Backup saved: ${outPath} (${size} MB)`);
} catch (err) {
  console.error('Backup failed:', err.message || err);
  process.exit(1);
}
