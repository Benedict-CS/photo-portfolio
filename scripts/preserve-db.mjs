#!/usr/bin/env node
/**
 * Astro DB in local mode DROPS the database file every time
 * `astro build` runs, then re-seeds it from db/seed.ts. The seed
 * only reads from metadata.json (the legacy migration source), so
 * user-edited fields (favorite, manual lat/lon, manual dates,
 * descriptions, …) get nuked on every build.
 *
 * This script preserves the live DB across that wipe:
 *
 *   node scripts/preserve-db.mjs save        # before `astro build`
 *   <astro build runs here, freely wipes>
 *   node scripts/preserve-db.mjs restore     # after `astro build`
 *
 * Wired into package.json's `build` script so a plain `npm run build`
 * is now safe to run on a populated host.
 *
 * No-op (and silently fine) when there's no existing DB to save —
 * e.g. inside the Docker builder stage, or on a fresh install.
 */
import fs from 'node:fs';
import path from 'node:path';

const DB = path.join('.astro', 'content.db');
// Stash sibling to .astro/ so an accidental `rm -rf .astro/` clears it too —
// you really do want a clean reset to be a clean reset.
const PRESERVED = path.join('.', '.preserved-db.sqlite');

const action = process.argv[2];

if (action === 'save') {
  if (fs.existsSync(DB)) {
    const size = (fs.statSync(DB).size / 1024).toFixed(1);
    fs.copyFileSync(DB, PRESERVED);
    console.log(`[preserve-db] saved ${DB} (${size} KB) → ${PRESERVED}`);
  } else {
    console.log('[preserve-db] save: no existing DB (first install / Docker builder)');
  }
} else if (action === 'restore') {
  if (fs.existsSync(PRESERVED)) {
    fs.mkdirSync(path.dirname(DB), { recursive: true });
    fs.copyFileSync(PRESERVED, DB);
    fs.unlinkSync(PRESERVED);
    console.log(`[preserve-db] restored ${PRESERVED} → ${DB} (overwrites the freshly-seeded copy)`);
  } else {
    console.log('[preserve-db] restore: nothing to restore (clean build)');
  }
} else {
  console.error('Usage: node scripts/preserve-db.mjs (save|restore)');
  process.exit(1);
}
