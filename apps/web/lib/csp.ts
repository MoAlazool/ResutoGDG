/**
 * Content-Security-Policy for the web app (audit PS-17). The session token lives in localStorage, so the policy's main
 * job is to stop injected script from running at all: every page response carries a per-request nonce (set by
 * middleware.ts) and script-src allows only scripts with that nonce plus what they load ('strict-dynamic'). Next.js
 * reads the nonce from the request's CSP header and puts it on its own bootstrap and chunk scripts. There is no
 * 'unsafe-inline' for scripts on pages, so an injected <script> or inline event handler does not run.
 *
 * Defence in depth around that: connections only to this site, the API, Supabase and the Pwned Passwords range API
 * (connect-src; AUTH-01), no plugins, no
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
  /**
   * Restaurant website pages (INT-23): the TikTok and Snap Pixels, also consent-gated and loaded by nonce'd code. Only
   * their event hosts are added to connect-src (their scripts come in through 'strict-dynamic'; beacons use img-src).
   */
  tiktokPixel?: boolean;
  snapPixel?: boolean;
  /**
   * Settings › Messaging > Channels (INT-13; the Inbox's Channels tab until 21-INBOX increment 2): WhatsApp Embedded
   * Signup runs Meta's JavaScript SDK (loaded by trusted code), whose login dialog talks to www.facebook.com through a
   * hidden frame. Only that page gets these hosts.
   */
  metaSdk?: boolean;
}

export const META_SDK_HOSTS = ['https://www.facebook.com', 'https://web.facebook.com', 'https://connect.facebook.net'];

/**
 * Settings › Messaging runs Meta's SDK for WhatsApp Embedded Signup (INT-13): only documents loaded at this path get
 * META_SDK_HOSTS. (It was the Inbox until the channels moved; the Inbox no longer gets them.)
 */
export const META_SDK_PAGE = /^\/dashboard\/[^/]+\/settings\/messaging\/?$/;

/**
 * A document keeps the policy it was loaded with: client-side navigation (next/link) to Messaging does not bring that
 * page's policy. So the SDK may only run when the document itself was loaded at the Messaging path. `loadedUrl` is the
 * URL the browser loaded the document from (its navigation timing entry), not the current URL.
 */
export function documentAllowsMetaSdk(loadedUrl: string | null | undefined): boolean {
  if (!loadedUrl) return false;
  try { return META_SDK_PAGE.test(new URL(loadedUrl, 'http://local').pathname); } catch { return false; }
}

export const META_PIXEL_CONNECT = ['https://www.facebook.com', 'https://connect.facebook.net'];
/**
 * AUTH-01: the Pwned Passwords range API (k-anonymity: the browser sends only a 5-character SHA-1 prefix) checks every
 * new password on sign-up, reset and Account → Security. It is allowed on every page, not only the auth pages: a
 * document keeps the policy it was loaded with, and Account → Security is reached by client-side navigation from any
 * staff page (the dashboard shell links to it), so a path-scoped entry would silently disable the check there.
 */
export const PWNED_PASSWORDS_CONNECT = ['https://api.pwnedpasswords.com'];
/** TikTok Pixel script and event host (analytics.tiktok.com/i18n/pixel/events.js, events to the same host). */
export const TIKTOK_PIXEL_CONNECT = ['https://analytics.tiktok.com'];
/** Snap Pixel script host and event host (sc-static.net/scevent.min.js, tr.snapchat.com). */
export const SNAP_PIXEL_CONNECT = ['https://sc-static.net', 'https://tr.snapchat.com'];

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
    list("connect-src 'self'", api, supabase, supabaseWs, ...PWNED_PASSWORDS_CONNECT, o.dev && 'ws: wss:', ...(o.metaPixel ? META_PIXEL_CONNECT : []),
      ...(o.tiktokPixel ? TIKTOK_PIXEL_CONNECT : []), ...(o.snapPixel ? SNAP_PIXEL_CONNECT : []), ...(o.metaSdk ? META_SDK_HOSTS : [])),
    list("media-src 'self' blob: https:", api),
    "worker-src 'self' blob:",
    "manifest-src 'self'",
    o.metaSdk ? list('frame-src', ...META_SDK_HOSTS) : "frame-src 'none'",
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
