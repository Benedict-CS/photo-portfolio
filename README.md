# 📸 Photo Portfolio

A travel photo portfolio built on top of a self-hosted Nextcloud share. Pulls photos at build time, extracts EXIF (location + date), reverse-geocodes country, and renders two browsing modes:

- **🗺️ Map** — every photo as a circular thumbnail marker, click → side preview, supports infinite horizontal panning.
- **📅 Timeline** — countries grouped (Apple-Photos-style big headers), with photos in justified rows by year-month.

Photos without GPS land in a 📍 未定位 bucket where they can be hand-pinned to the map.

## Stack

| | |
|---|---|
| Static site | Astro 5 |
| Map | Leaflet + MarkerCluster + CARTO Voyager tiles |
| Image pipeline | sharp → WebP thumbs at 3 sizes + base64 LQIP placeholder |
| Photo source | Nextcloud public share via WebDAV |
| Country lookup | OpenStreetMap Nominatim (cached) |
| Editing | Local dev-only Vite middleware that writes `metadata.json` |

## Setup

1. Make a public-share folder in your Nextcloud with photos.
2. `cp .env.example .env` and fill in `NEXTCLOUD_URL` + `NEXTCLOUD_SHARE_TOKEN`.
3. `npm install`
4. `npm run dev` — first build downloads every file once for EXIF + thumbs; the result is cached in `.astro/photos-cache.json` (committed to git so CI builds are fast).

## Editing photo metadata

Run the dev server, open a photo's `/photos/<id>` detail page, and use the **📝 編輯位置** button. The popup writes lat/lon/datetime/album/description to `metadata.json` via a `POST /api/metadata` endpoint that only exists in dev mode. Commit `metadata.json` to persist changes.

## Organising the Nextcloud folder

`node scripts/organize.mjs` does a dry-run; `--execute` actually MOVEs files into `<country>/` subfolders inside the share. Cache + metadata + thumb filenames are kept in sync.

## Building

`npm run build` → `dist/` static files for any host (Cloudflare Pages, Vercel, GitHub Pages…).

## Notes

- Thumbnails and `photos-cache.json` are committed so CI cold builds skip the slow Nextcloud download + sharp + Nominatim pass.
- Markers are duplicated lazily into adjacent world copies as you pan — true-infinite horizontal scroll without losing markers.
- `minZoom` is set per-viewport so you can never see the same marker twice on screen at once.

🤖 Built with [Claude Code](https://claude.com/claude-code)
