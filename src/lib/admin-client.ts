/**
 * Browser-side admin authentication helper.
 *
 * Flow:
 *   1. Frontend tries POST /api/metadata with the saved token (if any).
 *   2. If server returns 401, we prompt for password, save it, retry.
 *
 * Token is kept in localStorage so the user only enters it once per browser.
 */

const TOKEN_KEY = 'photo-admin-token';

export function getToken(): string {
  try { return localStorage.getItem(TOKEN_KEY) || ''; } catch { return ''; }
}
export function setToken(t: string) {
  try { localStorage.setItem(TOKEN_KEY, t); } catch {}
}
export function clearToken() {
  try { localStorage.removeItem(TOKEN_KEY); } catch {}
}

/**
 * Wraps `fetch` so the saved admin token rides along on every call. If the
 * server responds 401 we ask the user once, save the new password, retry.
 */
export async function authedFetch(url: string, init: RequestInit = {}): Promise<Response> {
  async function go(token: string): Promise<Response> {
    const headers = new Headers(init.headers || {});
    if (token) headers.set('Authorization', `Bearer ${token}`);
    return fetch(url, { ...init, headers });
  }

  let res = await go(getToken());
  if (res.status !== 401) return res;

  // Token missing/wrong — ask the user, save, retry once.
  const entered = window.prompt('需要管理員密碼才能編輯。請輸入 ADMIN_PASSWORD:');
  if (!entered) return res; // user cancelled — let caller surface the 401
  setToken(entered);
  res = await go(entered);
  if (res.status === 401) {
    clearToken();
    alert('密碼錯誤');
  }
  return res;
}
