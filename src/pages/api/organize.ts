/**
 * Admin endpoint for /admin's "Organise on Nextcloud" card.
 *
 *   GET  /api/organize  →  dry-run plan as JSON
 *   POST /api/organize  →  execute every move in the plan
 *
 * Both gated by ADMIN_PASSWORD via the same Bearer / x-admin-password
 * scheme as /api/metadata. Uses the in-server astro:db handle through
 * `getPhotos()` + `renamePhotoFile()` from src/lib/photos.ts, so this
 * route always sees the same DB the SSR app does.
 *
 * Pairs with `scripts/organize.mjs`, which does the same job from the
 * shell with no astro:db dependency. Folder layout is identical:
 *
 *   has country  + has datetime  →  <country>/<YYYY-MM-DD>/<basename>
 *   has country, no datetime     →  <country>/未分類日期/<basename>
 *   no country (Unlocated)       →  未分類/<basename>
 */
import type { APIRoute } from 'astro';
import { timingSafeEqual } from 'node:crypto';
import { getPhotos, renamePhotoFile, invalidatePhotoSync, type PhotoView } from '~/lib/photos';
import { rateLimit, clientIp } from '~/lib/rate-limit';

export const prerender = false;

// Execute is much heavier than a metadata POST (one WebDAV move per photo);
// cap aggressively so a misbehaving client can't churn the share.
const EXEC_MAX = 4;
const EXEC_WINDOW_MS = 60_000;

const ADMIN_PASSWORD = (
  (typeof import.meta !== 'undefined' && (import.meta as any).env?.ADMIN_PASSWORD) ||
  process.env.ADMIN_PASSWORD ||
  ''
);

function safeEq(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

function checkAuth(request: Request): boolean {
  if (!ADMIN_PASSWORD) return true;
  const auth = request.headers.get('authorization') || '';
  const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  const header = request.headers.get('x-admin-password') || '';
  return safeEq(bearer, ADMIN_PASSWORD) || safeEq(header, ADMIN_PASSWORD);
}

function unauthorized() {
  return new Response(JSON.stringify({ ok: false, error: 'unauthorized' }), {
    status: 401,
    headers: { 'Content-Type': 'application/json', 'WWW-Authenticate': 'Bearer' },
  });
}

function tooManyRequests(reset: number) {
  return new Response(
    JSON.stringify({ ok: false, error: 'too many requests' }),
    {
      status: 429,
      headers: {
        'Content-Type': 'application/json',
        'Retry-After': Math.ceil(reset / 1000).toString(),
      },
    },
  );
}

// zh-TW country names so the folders on Nextcloud read naturally.
// Mirror the same set used by scripts/organize.mjs.
const COUNTRY_NAME_TW: Record<string, string> = {
  jp: '日本', tw: '臺灣', cn: '中國', hk: '香港', mo: '澳門',
  my: '馬來西亞', sg: '新加坡', th: '泰國', vn: '越南', ph: '菲律賓',
  id: '印尼', kr: '韓國', kp: '北韓', in: '印度',
  de: '德國', fr: '法國', it: '義大利', es: '西班牙', nl: '荷蘭',
  ch: '瑞士', at: '奧地利', be: '比利時', cz: '捷克', sk: '斯洛伐克',
  hu: '匈牙利', pl: '波蘭', pt: '葡萄牙', se: '瑞典', no: '挪威',
  fi: '芬蘭', dk: '丹麥', ie: '愛爾蘭', gb: '英國', uk: '英國',
  us: '美國', ca: '加拿大', mx: '墨西哥', au: '澳洲', nz: '紐西蘭',
  br: '巴西', ar: '阿根廷', cl: '智利', ru: '俄羅斯', tr: '土耳其',
  eg: '埃及', za: '南非', ae: '阿聯酋', sa: '沙烏地阿拉伯', il: '以色列',
};
const UNCATEGORISED_COUNTRY = '未分類';
const UNCATEGORISED_DAY = '未分類日期';

function countryFolder(country: string, code: string): string {
  if (!country || country === 'Unlocated') return UNCATEGORISED_COUNTRY;
  if (code && COUNTRY_NAME_TW[code.toLowerCase()]) return COUNTRY_NAME_TW[code.toLowerCase()];
  return (country || '').split(/[;/,]/)[0].trim() || UNCATEGORISED_COUNTRY;
}

interface PlanItem {
  src: string;
  dst: string;
  country: string;
}

function buildPlanFromPhotos(photos: PhotoView[]): PlanItem[] {
  const plan: PlanItem[] = [];
  for (const p of photos) {
    const folder = countryFolder(p.country, p.countryCode);
    let dst: string;
    if (folder === UNCATEGORISED_COUNTRY) {
      // Both axes missing isn't useful — don't nest a date folder
      dst = `${folder}/${p.file}`;
    } else {
      const day = p.datetime ? p.datetime.slice(0, 10) : UNCATEGORISED_DAY;
      dst = `${folder}/${day}/${p.file}`;
    }
    if (p.path === dst) continue;
    plan.push({ src: p.path, dst, country: folder });
  }
  return plan;
}

export const GET: APIRoute = async ({ request }) => {
  if (!checkAuth(request)) return unauthorized();
  const photos = await getPhotos();
  const plan = buildPlanFromPhotos(photos);
  return new Response(
    JSON.stringify({ ok: true, total: photos.length, plan }),
    { headers: { 'Content-Type': 'application/json' } },
  );
};

export const POST: APIRoute = async ({ request }) => {
  const rl = rateLimit(`organize:${clientIp(request)}`, EXEC_MAX, EXEC_WINDOW_MS);
  if (!rl.ok) return tooManyRequests(rl.resetMs);
  if (!checkAuth(request)) return unauthorized();

  const photos = await getPhotos();
  const plan = buildPlanFromPhotos(photos);

  let moved = 0;
  let failed = 0;
  const errors: { src: string; error: string }[] = [];
  for (const m of plan) {
    const r = await renamePhotoFile(m.src, m.dst);
    if (r.ok) moved++;
    else {
      failed++;
      errors.push({ src: m.src, error: r.error || 'unknown' });
    }
  }

  // Force the next getPhotos() to re-list Nextcloud — paths have changed
  // and the 5 s sync TTL would otherwise serve a stale snapshot.
  invalidatePhotoSync();

  return new Response(
    JSON.stringify({ ok: failed === 0, total: plan.length, moved, failed, errors }),
    { headers: { 'Content-Type': 'application/json' } },
  );
};
