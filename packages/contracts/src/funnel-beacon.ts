// Funnel beacons (21-CRM, plan §6.7): the zod-free part shared by the guest pages (the inline beacon helper) and the
// API (POST /v1/public/funnel/beacon). Exported from '@resuto/contracts/lite', so guest pages pay a few hundred bytes.
//
// What a beacon carries: the event, the guest page group, the restaurant's public slug, the branch id the page already
// shows (optional) and a random per-tab id. Never a customer id, a name, a phone number, a cookie or the page URL; the
// API stores no IP address or user agent and keeps only a hash of the tab id.

export const FUNNEL_BEACON_EVENTS = ['page_view', 'qr_scan', 'add_to_cart', 'checkout_started'] as const;
export type FunnelBeaconEvent = (typeof FUNNEL_BEACON_EVENTS)[number];

/** Guest page groups: restaurant site /r, menu-only QR /m, web ordering /order, table QR /t, venue (counter) QR /v, booking /reserve. */
export const FUNNEL_SURFACES = ['r', 'm', 'order', 't', 'v', 'reserve'] as const;
export type FunnelSurface = (typeof FUNNEL_SURFACES)[number];

/** A QR scan is the landing on a page only a printed QR code opens (table and counter codes). */
export const FUNNEL_QR_SURFACES: readonly FunnelSurface[] = ['t', 'v'];
/** Pages with a cart (add_to_cart, checkout_started). */
export const FUNNEL_CART_SURFACES: readonly FunnelSurface[] = ['order', 't', 'v'];

/** Page views are sampled per tab session: 1 in FUNNEL_PAGE_VIEW_WEIGHT sessions report them, each weighted by it. */
export const FUNNEL_PAGE_VIEW_WEIGHT = 4;

/** Random per-tab id format (base64url, 16 to 32 characters). */
export const FUNNEL_SESSION_ID = /^[A-Za-z0-9_-]{16,32}$/;

/** Largest accepted beacon body in bytes (the helper sends about 120). */
export const FUNNEL_BEACON_MAX_BYTES = 512;

/** FNV-1a (32-bit) of a string: a stable, cheap hash both sides compute identically. */
export function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * Whether this tab session reports page views. Deterministic per id, so the browser skips the request and the API
 * drops a page view from a session outside the sample even when a client sends it anyway.
 */
export const funnelPageViewSampled = (sessionId: string) => fnv1a(sessionId) % FUNNEL_PAGE_VIEW_WEIGHT === 0;

/** Whether an event may come from a page group (anything else is refused, not stored). */
export function funnelEventAllowed(event: FunnelBeaconEvent, surface: FunnelSurface): boolean {
  if (event === 'qr_scan') return FUNNEL_QR_SURFACES.includes(surface);
  if (event === 'add_to_cart' || event === 'checkout_started') return FUNNEL_CART_SURFACES.includes(surface);
  return true;
}
