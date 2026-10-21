// TikTok Pixel for restaurant websites (INT-23): loaded only after the guest consents (same prompt as Meta), from code
// that Next.js loaded with the page's CSP nonce, so 'strict-dynamic' trusts it without inline script.
// Sources (checked 2026-10-21):
//   Base code (ttq queue, ttq.load(pixelCode) adding analytics.tiktok.com/i18n/pixel/events.js?sdkid=…&lib=ttq, ttq.page()):
//     the snippet TikTok Events Manager gives for manual installs; ttq.track(event, params, { event_id }) for dedup with the
//     Events API: https://github.com/tiktok/gtm-template-pixel (template.tpl) and https://ads.tiktok.com/help/article/events-api
//   Browser ids the Events API matches on: _ttp cookie (set by the Pixel) and ttclid (ad click URL parameter):
//     https://github.com/tiktok/gtm-template-eapi (template.tpl getTtp / getTtclid)

export const TIKTOK_SCRIPT = 'https://analytics.tiktok.com/i18n/pixel/events.js';
const METHODS = ['page', 'track', 'identify', 'instances', 'debug', 'on', 'off', 'once', 'ready', 'alias', 'group', 'enableCookie', 'disableCookie',
  'holdConsent', 'revokeConsent', 'grantConsent'];

type Ttq = unknown[] & Record<string, any>;

/** TikTok's base code without an inline script: the ttq queue, then events.js for the pixel, then page(). Idempotent per pixel. */
export function installTiktokPixel(pixelCode: string, w: Window & { ttq?: Ttq; TiktokAnalyticsObject?: string } = window, d: Document = document) {
  if (!/^[A-Z0-9]{10,40}$/.test(pixelCode)) return false;
  w.TiktokAnalyticsObject = 'ttq';
  const ttq = (w.ttq ??= [] as unknown as Ttq);
  if (!ttq.methods) {
    ttq.methods = METHODS;
    ttq.setAndDefer = (t: Ttq, e: string) => { t[e] = (...args: unknown[]) => { t.push([e, ...args]); }; };
    for (const m of METHODS) ttq.setAndDefer(ttq, m);
    ttq.instance = (t: string) => { const e = ttq._i[t] || []; for (const m of METHODS) ttq.setAndDefer(e, m); return e; };
    ttq.load = (e: string, n?: Record<string, unknown>) => {
      ttq._i = ttq._i || {}; ttq._i[e] = []; ttq._i[e]._u = TIKTOK_SCRIPT;
      ttq._t = ttq._t || {}; ttq._t[e] = Date.now(); ttq._o = ttq._o || {}; ttq._o[e] = n || {};
      const s = d.createElement('script');
      s.async = true; s.src = `${TIKTOK_SCRIPT}?sdkid=${encodeURIComponent(e)}&lib=ttq`;
      d.head.appendChild(s);
    };
  }
  const inited = ((w as unknown as { __resutoTiktok?: Set<string> }).__resutoTiktok ??= new Set());
  if (!inited.has(pixelCode)) { ttq.load(pixelCode); ttq.page(); inited.add(pixelCode); }
  return true;
}

/** ttq.track(event, params, { event_id }). */
export function tiktokTrack(event: string, params: Record<string, unknown>, eventId: string, w: Window & { ttq?: Ttq } = window) {
  w.ttq?.track?.(event, params, { event_id: eventId });
}

/** ttclid from an ad click landing URL (raw, as TikTok expects). */
export function ttclidFromSearch(search: string): string | null {
  const id = new URLSearchParams(search).get('ttclid');
  return id && /^[A-Za-z0-9._-]{8,500}$/.test(id) ? id : null;
}
