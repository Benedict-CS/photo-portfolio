# Project context for Claude

A self-hosted travel photo portfolio. Photos live on the owner's Nextcloud,
this app reads them via WebDAV, stores derived metadata in a local SQLite,
and renders a map + timeline + per-photo detail page.

## Stack
- **Astro 5** SSR (`output: 'server'`) with **@astrojs/node** adapter.
  All editing endpoints are alive in production — not dev-only.
- **Astro DB** (`@astrojs/db`) → local SQLite at `.astro/content.db`.
  Schema in `db/config.ts`, one-time migration in `db/seed.ts`.
- **Nextcloud public share** as photo source. WebDAV credentials live in
  `.env` (`NEXTCLOUD_URL`, `NEXTCLOUD_SHARE_TOKEN`).
- **sharp** generates 3 sizes of WebP thumbs + a 16px LQIP base64.
- **exifr** reads GPS + datetime + camera Make/Model.
- **Nominatim** (rate-limited 1 req/sec, bucket-cached) reverse-geocodes country.
- **Leaflet + markercluster** for the map.
- No cloud services. SQLite + WebDAV + your VPS = the whole thing.

## Pages
- `/` — Leaflet map with circular photo markers, infinite world panning,
  mode toggle (markers ↔ trip routes), collapsible time slider.
- `/timeline` — Country sections with year-month sub-groups, justified rows.
  Clicking a photo → goes to `/photos/[id]` (NOT a lightbox).
- `/photos/[id]` — Full-screen detail page. Single source of truth for
  "view a photo." Has ⭐ favorite, ← → arrow-key prev/next, X close
  (history.back), edit/delete buttons gated on login.
- `/favorites` — Grid of ⭐ photos.
- `/admin` — Buckets of "needs action": 未定位 / 手動標位置.
- `/api/metadata` — Single mutation endpoint (GET/POST/DELETE).
  POST supports `paths: []` for batch.
- `/sitemap.xml`, `/robots.txt` — SEO.

## Auth model
- `ADMIN_PASSWORD` in `.env` gates POST/DELETE on `/api/metadata`.
- Browser stores token in `localStorage` under `photo-admin-token`.
- `body.logged-in` class is toggled in `Layout.astro` (runs on EVERY page,
  including detail pages that don't render TopBar).
- CSS rule `body:not(.logged-in) .edit-only { display: none !important }`
  hides every editing affordance for visitors. Server still enforces.
- Custom `<PasswordPrompt />` modal (masks input) replaces `window.prompt`.

## Photo data flow
1. `getPhotos()` in `src/lib/photos.ts` runs `syncFromNextcloud()` first
   (TTL 5s). PROPFIND on the share, etag-compare against DB rows.
2. For new/changed files: download once → exifr → sharp thumbs →
   Nominatim country → INSERT/UPDATE the row.
3. EXIF originals are stored in `exifLat/exifLon/exifDatetime` columns.
   User-set overrides go into `lat/lon/datetime`. `manualLocation` is
   derived (`lat !== exifLat`), so revert == clear the override.
4. `editable` is computed: false when EXIF supplied both location AND
   date (and the user hasn't overridden). That makes the UI honest about
   which fields are still editable.

## Key conventions
- Admin password in `.env`, NEVER committed (`.gitignore` covers it).
- `.astro/content.db` is intentionally committed-via-exception in `.gitignore`
  so deploys ship the canonical state. Same for `metadata.json` (legacy seed).
- `public/thumbs/` is committed for now; switch to object storage when the
  repo balloons past ~500 MB.
- All inline `<script define:vars>` blocks: Astro processes them with esbuild,
  so TypeScript syntax (`as Type`, generics) is stripped. Function
  declarations are hoisted within the wrapping IIFE.
- One source of truth for "view a photo" = `/photos/[id]`. No lightbox.
  Timeline, map preview panel, favorites, admin all navigate via `window.location.href`.

## Build / deploy
```bash
npm run dev         # dev server with watcher
npm run build       # production build → dist/
npm run sync        # one-shot Nextcloud → DB pre-sync
npm run predeploy   # sync + build
npm run backup      # zip DB + metadata + thumbs into backups/
```

Docker: `Dockerfile` is multi-stage, Alpine, non-root, tini-wrapped. Mount
`.env`, `.astro/`, and `public/thumbs/` as volumes so they survive container
rebuilds.

## Things that have been deliberately removed
- **Lightbox** — was a separate component that diverged from the detail
  page. Removed in favour of detail-page-everywhere.
- **Album feature** — DB column kept for future use, but no UI reads or
  writes it. Replaced by ⭐ favorites for "I care about this photo."
- **Title field** — photos speak for themselves; no per-photo title UI.
- **Hero/landing page** — the user prefers the map as the entry point.
- **Dark mode** — explicitly out of scope.

## Things to NOT do without explicit confirmation
- Don't auto-open the edit modal — the user views first, edits when they
  want. Only `?pin=1` query param auto-opens.
- Don't add title/album UI back.
- Don't reintroduce a lightbox; navigate to `/photos/[id]` instead.
- Don't show technical EXIF (shutter/ISO/aperture); camera model only.
- Don't display hh:mm without timezone — date only.
- Don't show `🌍` for the unlocated bucket; use `📍`.
