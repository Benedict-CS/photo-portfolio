import { defineDb, defineTable, column } from 'astro:db';

/**
 * One row per photo file in the Nextcloud share.
 *
 * Source of truth merges:
 *   - what was in metadata.json (manual title/album/description/lat/lon/datetime)
 *   - what was in .astro/photos-cache.json (etag-keyed EXIF + thumbs metadata)
 *
 * Everything is SQLite-local; nothing leaves the box. The dev API and the
 * production build both read/write the same DB so editing works after deploy.
 */
const Photo = defineTable({
  columns: {
    /** Nextcloud-relative path, used as primary key. e.g. "日本/IMG_001.jpg" */
    path: column.text({ primaryKey: true }),
    /** Bare filename. */
    file: column.text(),
    /** Nextcloud etag — when this changes we re-process the photo. */
    etag: column.text(),
    /** Slug-safe key used as the thumb filename (`/thumbs/<size>/<key>.webp`). */
    thumbKey: column.text(),
    /** Tiny WebP data-URI for blur-up loading. */
    placeholder: column.text({ optional: true }),

    /** Final resolved values. Manual overrides take precedence over EXIF. */
    lat: column.number({ optional: true }),
    lon: column.number({ optional: true }),
    datetime: column.text({ optional: true }), // ISO 8601 string
    country: column.text({ optional: true }),
    countryCode: column.text({ optional: true }),

    /** EXIF-original values, kept separate so we can revert to them. */
    exifLat: column.number({ optional: true }),
    exifLon: column.number({ optional: true }),
    exifDatetime: column.text({ optional: true }),

    /** User-editable narrative fields. */
    title: column.text({ default: '' }),
    album: column.text({ default: '' }),
    description: column.text({ default: '' }),

    /** Camera / phone model from EXIF. e.g. "OPPO Reno10 Pro+ 5G". */
    camera: column.text({ optional: true }),

    /** 'photo' (JPEG/HEIC) or 'video' (MP4/MOV). Existing rows default to 'photo'. */
    kind: column.text({ default: 'photo' }),
    /** Video duration in seconds (videos only). */
    durationSec: column.number({ optional: true }),
    /** Source codec from ffprobe (e.g. 'hevc', 'h264'). Used to know if a video needs transcoding. */
    videoCodec: column.text({ optional: true }),
    /** File size in bytes — populated for both photos and videos. Used as `Content-Length` and for the Range handler. */
    bytes: column.number({ optional: true }),

    /** Starred photos appear on /favorites and get a ⭐ overlay everywhere. */
    favorite: column.boolean({ default: false }),

    /** Bookkeeping. */
    updatedAt: column.date({ default: new Date() }),
  },
});

export default defineDb({ tables: { Photo } });
