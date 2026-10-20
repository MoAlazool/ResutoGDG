/**
 * Content-Security-Policy for the web app (audit PS-17). The session token lives in localStorage, so the policy's main
 * job is to stop injected script from running at all: every page response carries a per-request nonce (set by
 * middleware.ts) and script-src allows only scripts with that nonce plus what they load ('strict-dynamic'). Next.js
 * reads the nonce from the request's CSP header and puts it on its own bootstrap and chunk scripts. There is no
 * 'unsafe-inline' for scripts on pages, so an injected <script> or inline event handler does not run.
 *
 * Defence in depth around that: connections only to this site, the API and Supabase (connect-src), no plugins, no
 * <base> hijack, forms post only here, no framing (also covers the hosted pay page). Product images are tenant URLs on
 * any HTTPS host, so img-src allows https:; that only matters once script runs, which the nonce prevents, and script
 * that did run could navigate away with the token anyway (CSP cannot block top-level navigation).
 *
 * buildCsp({ nonce: null }) is the fallback next.config.ts sends on responses the middleware does not handle (static
 * files, Next internals). It has no nonce, so it keeps 'unsafe-inline' for scripts; it is compatible with the page
 * policy, so a response that ended up carrying both still runs only nonce'd scripts.
 */
export interface CspOptions {
  /** Per-request nonce (base64). Null: the static fallback policy. */
  nonce: string | null;
  /** Development server: React needs eval, HMR needs websockets. */
  dev: boolean;
  apiUrl?: string;
  supabaseUrl?: string;
  /**
   * Restaurant website pages (INT-20): the Meta Pixel, which runs only after the guest consents, sends its events to
   * www.facebook.com. Its script is loaded by trusted (nonce'd) code, so script-src needs nothing extra ('strict-dynamic').
   * Staff pages never get this.
   */
  metaPixel?: boolean;
}

export const META_PIXEL_CONNECT = ['https://www.facebook.com', 'https://connect.facebook.net'];

const originOf = (url: string | undefined) => {
  try { return url ? new URL(url).origin : null; } catch { return null; }
};
const list = (...xs: Array<string | null | false | undefined>) => xs.filter(Boolean).join(' ');

export function buildCsp(o: CspOptions): string {
  const api = originOf(o.apiUrl ?? 'http://localhost:4000');
  const supabase = originOf(o.supabaseUrl);
  const supabaseWs = supabase ? supabase.replace(/^http/, 'ws') : null;
  const secure = !!api?.startsWith('https:');
  const script = o.nonce
    ? list("script-src 'self'", `'nonce-${o.nonce}'`, "'strict-dynamic'", o.dev && "'unsafe-eval'")
    : list("script-src 'self' 'unsafe-inline'", o.dev && "'unsafe-eval'");
  return [
    "default-src 'self'",
    script,
    "script-src-attr 'none'",
    "style-src 'self' 'unsafe-inline'",
    list("img-src 'self' data: blob: https:", api, supabase),
    "font-src 'self' data:",
    list("connect-src 'self'", api, supabase, supabaseWs, o.dev && 'ws: wss:', ...(o.metaPixel ? META_PIXEL_CONNECT : [])),
    list("media-src 'self' blob: https:", api),
    "worker-src 'self' blob:",
    "manifest-src 'self'",
    "frame-src 'none'",
    "frame-ancestors 'none'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    secure && 'upgrade-insecure-requests',
  ].filter(Boolean).join('; ');
}

/** 128-bit random nonce, base64 (Edge and Node runtimes both have Web Crypto). */
export function newNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}
