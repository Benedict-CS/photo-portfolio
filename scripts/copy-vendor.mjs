#!/usr/bin/env node
/**
 * Copy self-hosted vendor JS / CSS / fonts from node_modules into
 * public/lib/ so Astro serves them as same-origin static assets.
 *
 * Wired into the build script so a plain `npm run build` always ships
 * a fresh copy. Re-runs are cheap (it's six small files + an icon
 * folder) and idempotent.
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve('.');
const DEST_ROOT = path.join(ROOT, 'public', 'lib');

const FILES = [
  // Leaflet core
  ['node_modules/leaflet/dist/leaflet.js',          'leaflet/leaflet.js'],
  ['node_modules/leaflet/dist/leaflet.css',         'leaflet/leaflet.css'],
  ['node_modules/leaflet/dist/images',              'leaflet/images'],
  // MarkerCluster plugin — its CSS references no external files so just copy.
  ['node_modules/leaflet.markercluster/dist/leaflet.markercluster.js',    'leaflet/leaflet.markercluster.js'],
  ['node_modules/leaflet.markercluster/dist/MarkerCluster.css',           'leaflet/MarkerCluster.css'],
  ['node_modules/leaflet.markercluster/dist/MarkerCluster.Default.css',   'leaflet/MarkerCluster.Default.css'],
];

function copyRecursive(src, dst) {
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    fs.mkdirSync(dst, { recursive: true });
    for (const entry of fs.readdirSync(src)) {
      copyRecursive(path.join(src, entry), path.join(dst, entry));
    }
  } else {
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
  }
}

let copied = 0;
for (const [rel, target] of FILES) {
  const src = path.join(ROOT, rel);
  const dst = path.join(DEST_ROOT, target);
  if (!fs.existsSync(src)) {
    console.error(`[copy-vendor] missing source: ${src}`);
    process.exit(1);
  }
  copyRecursive(src, dst);
  copied++;
}

console.log(`[copy-vendor] ${copied} entries copied to public/lib/`);
