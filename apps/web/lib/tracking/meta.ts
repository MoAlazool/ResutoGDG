// Meta Pixel for restaurant websites (INT-20): consent storage, first-party browser ids and the Pixel loader.
// Docs (checked 2026-10-20):
//   Pixel base code + eventID:   https://developers.facebook.com/docs/meta-pixel/get-started
//   Dedup with the server:       https://developers.facebook.com/docs/marketing-api/conversions-api/deduplicate-pixel-and-server-events
//   fbp / fbc formats:           https://developers.facebook.com/docs/marketing-api/conversions-api/parameters/customer-information-parameters
//
// Nothing here runs before the guest accepts the restaurant's prompt: no script, no cookie, no request to Meta.
// The loader adds Meta's script from code that Next.js already loaded with the page's CSP nonce, so the
// 'strict-dynamic' policy trusts it without any inline script or a looser script-src (lib/csp.ts).

export const PIXEL_SCRIPT = 'https://connect.facebook.net/en_US/fbevents.js';
const COOKIE_DAYS = 90;

export type Consent = 'granted' | 'denied';
const consentKey = (slug: string) => `resuto.adConsent.${slug}`;

/** The guest's stored answer for this restaurant and prompt version (null when never asked or the wording changed). */
export function readConsent(slug: string, version: string, storage: Pick<Storage, 'getItem'> | null = safeStorage()): Consent | null {
  try {
    const raw = storage?.getItem(consentKey(slug));
    if (!raw) return null;
    const v = JSON.parse(raw) as { c?: string; v?: string };
    return v.v === version && (v.c === 'granted' || v.c === 'denied') ? v.c : null;
  } catch { return null; }
}

export function writeConsent(slug: string, version: string, c: Consent, storage: Pick<Storage, 'setItem'> | null = safeStorage(), now = Date.now()) {
  try { storage?.setItem(consentKey(slug), JSON.stringify({ c, v: version, at: now })); } catch { /* private mode: ask again next time */ }
}

function safeStorage(): Storage | null {
  try { return typeof window === 'undefined' ? null : window.localStorage; } catch { return null; }
}

/** _fbp value: fb.1.<creation ms>.<random 10 digits>. */
export const newFbp = (now: number, random: number) => `fb.1.${now}.${String(Math.floor(random * 9e9) + 1e9)}`;

/** _fbc value from an ad click (fbclid in the landing URL): fb.1.<creation ms>.<fbclid>. */
export function fbcFromSearch(search: string, now: number): string | null {
  const id = new URLSearchParams(search).get('fbclid');
  return id && /^[A-Za-z0-9_-]{8,500}$/.test(id) ? `fb.1.${now}.${id}` : null;
}

export function readCookie(name: string, cookie = typeof document === 'undefined' ? '' : document.cookie): string | null {
  for (const part of cookie.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

function writeCookie(name: string, value: string) {
  document.cookie = `${name}=${encodeURIComponent(value)}; Max-Age=${COOKIE_DAYS * 86400}; Path=/; SameSite=Lax${location.protocol === 'https:' ? '; Secure' : ''}`;
}

/** First-party browser ids, created only after consent (Meta's script reuses an existing _fbp). */
export function ensureBrowserIds(now = Date.now()): { fbp: string; fbc: string | null } {
  let fbp = readCookie('_fbp');
  if (!fbp || !/^fb\.[0-2]\.\d{10,13}\.\d{1,20}$/.test(fbp)) { fbp = newFbp(now, Math.random()); writeCookie('_fbp', fbp); }
  let fbc = readCookie('_fbc');
  const fromClick = fbcFromSearch(location.search, now);
  if (fromClick && (!fbc || !fbc.endsWith(fromClick.split('.').slice(3).join('.')))) { fbc = fromClick; writeCookie('_fbc', fbc); }
  if (fbc && !/^fb\.[0-2]\.\d{10,13}\.[A-Za-z0-9_-]{8,}$/.test(fbc)) fbc = null;
  return { fbp, fbc };
}

/** Same id as the API (meta-tracking.service purchaseEventId): Meta deduplicates the browser and server Purchase. */
export async function purchaseEventId(publicRef: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`purchase:${publicRef}`));
  return `p.${[...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 40)}`;
}

type Fbq = ((...args: unknown[]) => void) & { callMethod?: (...a: unknown[]) => void; queue: unknown[]; loaded: boolean; version: string; push: unknown };

/** Meta's base code without an inline script: the fbq queue, then fbevents.js, then init. Idempotent per pixel. */
export function installPixel(pixelId: string, w: Window & { fbq?: Fbq; _fbq?: Fbq } = window, d: Document = document) {
  if (!/^\d{6,20}$/.test(pixelId)) return;
  if (!w.fbq) {
    const n = function (...args: unknown[]) { if (n.callMethod) n.callMethod(...args); else n.queue.push(args); } as Fbq;
    n.push = n; n.loaded = true; n.version = '2.0'; n.queue = [];
    w.fbq = n; if (!w._fbq) w._fbq = n;
    const s = d.createElement('script');
    s.async = true; s.src = PIXEL_SCRIPT;
    d.head.appendChild(s);
  }
  const inited = ((w as unknown as { __resutoPixels?: Set<string> }).__resutoPixels ??= new Set());
  if (!inited.has(pixelId)) { w.fbq!('init', pixelId); inited.add(pixelId); }
}

/** fbq('track', event, data, { eventID }). */
export function pixelTrack(event: string, data: Record<string, unknown> = {}, eventId?: string, w: Window & { fbq?: Fbq } = window) {
  w.fbq?.('track', event, data, eventId ? { eventID: eventId } : undefined);
}
