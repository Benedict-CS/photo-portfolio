/**
 * Minimal in-memory leaky-bucket rate limiter. Per-key (usually IP).
 *
 * Goal: stop brute-forcing the ADMIN_PASSWORD via /api/metadata, and stop
 * accidentally hammering writes during dev. Not a substitute for a real
 * WAF — but good enough for a single-server deployment.
 *
 * Window-style: at most `max` events per `windowMs`. After `max+1` you get
 * 429 until the oldest event in the window expires.
 */
type Bucket = number[]; // timestamps of recent hits

const buckets = new Map<string, Bucket>();

export function rateLimit(key: string, max: number, windowMs: number): { ok: boolean; remaining: number; resetMs: number } {
  const now = Date.now();
  const cutoff = now - windowMs;
  const arr = buckets.get(key) || [];
  // Drop expired
  while (arr.length && arr[0] < cutoff) arr.shift();
  if (arr.length >= max) {
    const resetMs = arr[0] + windowMs - now;
    return { ok: false, remaining: 0, resetMs: Math.max(0, resetMs) };
  }
  arr.push(now);
  buckets.set(key, arr);
  return { ok: true, remaining: max - arr.length, resetMs: 0 };
}

/** Extract the caller IP from common proxy headers. Falls back to "unknown". */
export function clientIp(request: Request): string {
  const fwd = request.headers.get('x-forwarded-for');
  if (fwd) return fwd.split(',')[0].trim();
  const real = request.headers.get('x-real-ip');
  if (real) return real;
  return 'unknown';
}
