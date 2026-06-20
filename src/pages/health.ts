import type { APIRoute } from 'astro';
import { db, Photo } from 'astro:db';
import fs from 'node:fs/promises';
import path from 'node:path';

export const prerender = false;

/**
 * Health check endpoint — used by uptime monitors / load balancers /
 * `curl /health` to know whether the site is alive and how much it knows.
 *
 *   200  ok=true       → everything ready
 *   503  ok=false      → DB not reachable (most likely cause)
 */
export const GET: APIRoute = async () => {
  const started = Date.now();
  try {
    const rows = await db.select().from(Photo);
    const photoCount = rows.length;
    const located = rows.filter((r) => r.lat !== null && r.lon !== null).length;
    const favorites = rows.filter((r) => r.favorite).length;
    const manual = rows.filter((r) => r.lat !== null && r.lat !== r.exifLat).length;

    let dbSize: number | null = null;
    try {
      const stat = await fs.stat(path.resolve('.astro/content.db'));
      dbSize = stat.size;
    } catch {}

    return new Response(
      JSON.stringify({
        ok: true,
        photoCount,
        located,
        unlocated: photoCount - located,
        favorites,
        manualLocation: manual,
        dbBytes: dbSize,
        durationMs: Date.now() - started,
        node: process.version,
        timestamp: new Date().toISOString(),
      }),
      {
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
        },
      }
    );
  } catch (err: any) {
    return new Response(
      JSON.stringify({ ok: false, error: String(err?.message || err) }),
      { status: 503, headers: { 'Content-Type': 'application/json' } }
    );
  }
};
