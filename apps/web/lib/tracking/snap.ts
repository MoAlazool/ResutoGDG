// Snap Pixel for restaurant websites (INT-23): loaded only after the guest consents (same prompt as Meta), from
// nonce-trusted code (no inline script).
// Sources (checked 2026-10-21):
//   Base code: the snaptr queue + https://sc-static.net/scevent.min.js, snaptr('init', pixelId), snaptr('track', 'PAGE_VIEW')
//     (snippet from Snap Events Manager); dedup: Pixel client_dedup_id must equal the CAPI event_id, and for PURCHASE
//     transaction_id pairs with CAPI custom_data.order_id:
//     https://developers.snap.com/api/marketing-api/Conversions-API/Deduplication
//   Browser ids the CAPI matches on: _scid cookie (sc_cookie1) and the ScCid ad click parameter (sc_click_id):
//     https://developers.snap.com/api/marketing-api/Conversions-API/Parameters

export const SNAP_SCRIPT = 'https://sc-static.net/scevent.min.js';

type Snaptr = ((...args: unknown[]) => void) & { queue: unknown[]; handleRequest?: (...a: unknown[]) => void };

export function installSnapPixel(pixelId: string, w: Window & { snaptr?: Snaptr } = window, d: Document = document) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(pixelId)) return false;
  if (!w.snaptr) {
    const a = function (...args: unknown[]) { if (a.handleRequest) a.handleRequest(...args); else a.queue.push(args); } as Snaptr;
    a.queue = [];
    w.snaptr = a;
    const s = d.createElement('script');
    s.async = true; s.src = SNAP_SCRIPT;
    d.head.appendChild(s);
  }
  const inited = ((w as unknown as { __resutoSnap?: Set<string> }).__resutoSnap ??= new Set());
  if (!inited.has(pixelId)) { w.snaptr!('init', pixelId); w.snaptr!('track', 'PAGE_VIEW'); inited.add(pixelId); }
  return true;
}

/** PURCHASE with the shared event id as client_dedup_id and transaction_id (CAPI event_id / order_id). */
export function snapPurchase(value: number, currency: string, eventId: string, w: Window & { snaptr?: Snaptr } = window) {
  w.snaptr?.('track', 'PURCHASE', { price: value, currency, transaction_id: eventId, client_dedup_id: eventId });
}

export function snapTrack(event: string, eventId: string, w: Window & { snaptr?: Snaptr } = window) {
  w.snaptr?.('track', event, { client_dedup_id: eventId });
}

/** ScCid from an ad click landing URL. */
export function scClickIdFromSearch(search: string): string | null {
  const id = new URLSearchParams(search).get('ScCid') ?? new URLSearchParams(search).get('sccid');
  return id && /^[A-Za-z0-9._-]{8,500}$/.test(id) ? id : null;
}
