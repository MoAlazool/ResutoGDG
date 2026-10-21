/** Fixed base for parsing `next` when no window exists (tests, server); only the origin comparison uses it. */
const PARSE_BASE = 'http://resuto.invalid';
/** C0 controls, DEL, C1 controls and backslash: the URL parser drops or rewrites these (tab/LF/CR are removed,
 * `\` becomes `/`), which can turn `/<TAB>/evil.example` into the protocol-relative `//evil.example`. */
const UNSAFE_NEXT_CHARS = /[\u0000-\u001F\u007F-\u009F\\]/;
const AUTH_PATH = /^\/(login|signup|forgot-password|reset-password|auth\/callback)(\/|$)/;

/**
 * The only post-sign-in destinations followed are same-origin paths (VS-05). The value is validated by parsing, not
 * by prefix: it must start with a single `/`, contain no control character or backslash anywhere, resolve to the
 * page's own origin, and not point at a sign-in page. The normalised path + query + hash is returned, so what the
 * router receives is exactly what was checked. Used for `?next=` on /login and /signup, by loginUrl() and by the
 * Google return URL.
 */
export function safeNext(next: string | null | undefined, origin?: string): string | null {
  if (typeof next !== 'string' || next.length === 0 || next.length > 2048) return null;
  if (next.trim() !== next || UNSAFE_NEXT_CHARS.test(next)) return null;
  if (!next.startsWith('/') || next.startsWith('//')) return null;
  const base = origin ?? (typeof window !== 'undefined' && window.location?.origin ? window.location.origin : PARSE_BASE);
  let u: URL;
  try { u = new URL(next, base); } catch { return null; }
  if (u.origin !== new URL(base).origin || u.username || u.password) return null;
  if (u.pathname.startsWith('//') || AUTH_PATH.test(u.pathname)) return null;
  return u.pathname + u.search + u.hash;
}

/** /login with a validated `next` (dropped when unsafe) and an optional reason, e.g. after a rejected token. */
export function loginUrl(next?: string | null, reason?: 'expired'): string {
  const q = new URLSearchParams();
  const safe = safeNext(next);
  if (safe) q.set('next', safe);
  if (reason) q.set('reason', reason);
  const s = q.toString();
  return `/login${s ? `?${s}` : ''}`;
}

/** Where Google OAuth returns to: this origin's /login, carrying `next` only when it passes safeNext. */
export function googleReturnUrl(origin: string, next?: string | null): string {
  const back = new URL('/login', origin);
  const safe = safeNext(next, origin);
  if (safe) back.searchParams.set('next', safe);
  return back.toString();
}
