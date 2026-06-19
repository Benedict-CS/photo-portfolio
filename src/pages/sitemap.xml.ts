import type { APIRoute } from 'astro';
import { getPhotos } from '~/lib/photos';

export const prerender = false;

/**
 * Auto-generated sitemap.xml — lists the homepage, timeline, and every
 * /photos/<id> detail page so search engines can crawl them.
 */
export const GET: APIRoute = async ({ site, url }) => {
  const photos = await getPhotos();
  const origin = site?.toString().replace(/\/$/, '') || `${url.protocol}//${url.host}`;

  const staticUrls = [
    { loc: `${origin}/`, priority: 1.0, changefreq: 'weekly' },
    { loc: `${origin}/timeline`, priority: 0.8, changefreq: 'weekly' },
  ];

  const photoUrls = photos.map((p) => ({
    loc: `${origin}/photos/${p.id}`,
    priority: 0.6,
    changefreq: 'monthly',
    lastmod: p.datetime ? p.datetime.slice(0, 10) : undefined,
  }));

  const all = [...staticUrls, ...photoUrls];

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${all.map((u) => `  <url>
    <loc>${u.loc}</loc>
    <changefreq>${u.changefreq}</changefreq>
    <priority>${u.priority.toFixed(1)}</priority>${u.lastmod ? `\n    <lastmod>${u.lastmod}</lastmod>` : ''}
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
