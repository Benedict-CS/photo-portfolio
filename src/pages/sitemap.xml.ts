import type { APIRoute } from 'astro';
import { getPhotos, getTrips } from '~/lib/photos';

export const prerender = false;

/**
 * Auto-generated sitemap.xml — lists the homepage, timeline, and every
 * /photos/<id> detail page so search engines can crawl them.
 */
export const GET: APIRoute = async ({ site, url }) => {
  const photos = await getPhotos();
  const trips = await getTrips();
  const origin = site?.toString().replace(/\/$/, '') || `${url.protocol}//${url.host}`;

  const staticUrls = [
    { loc: `${origin}/`, priority: 1.0, changefreq: 'weekly' },
    { loc: `${origin}/timeline`, priority: 0.8, changefreq: 'weekly' },
    { loc: `${origin}/trips`, priority: 0.7, changefreq: 'weekly' },
    { loc: `${origin}/favorites`, priority: 0.5, changefreq: 'weekly' },
    ...trips.map((t) => ({
      loc: `${origin}/trips/${t.slug}`,
      priority: 0.65,
      changefreq: 'monthly' as const,
    })),
  ];

  // Detail pages also advertise their hero thumb via the Google Images
  // sitemap extension so the photo can show up in image search results.
  const photoUrls = photos.map((p) => ({
    loc: `${origin}/photos/${p.id}`,
    image: `${origin}${p.thumbs.l}`,
    caption: `${p.country || ''} ${p.datetime ? p.datetime.slice(0, 10) : ''}`.trim(),
    priority: 0.6,
    changefreq: 'monthly',
    lastmod: p.datetime ? p.datetime.slice(0, 10) : undefined,
  }));

  const xmlEsc = (s: string) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"
        xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">
${staticUrls.map((u) => `  <url>
    <loc>${u.loc}</loc>
    <changefreq>${u.changefreq}</changefreq>
    <priority>${u.priority.toFixed(1)}</priority>
  </url>`).join('\n')}
${photoUrls.map((u) => `  <url>
    <loc>${u.loc}</loc>
    <changefreq>${u.changefreq}</changefreq>
    <priority>${u.priority.toFixed(1)}</priority>${u.lastmod ? `\n    <lastmod>${u.lastmod}</lastmod>` : ''}
    <image:image>
      <image:loc>${xmlEsc(u.image)}</image:loc>${u.caption ? `\n      <image:caption>${xmlEsc(u.caption)}</image:caption>` : ''}
    </image:image>
  </url>`).join('\n')}
</urlset>
`;

  return new Response(xml, {
    headers: {
      'Content-Type': 'application/xml; charset=utf-8',
      'Cache-Control': 'public, max-age=3600',
    },
  });
};
