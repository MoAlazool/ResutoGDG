// Ad-measurement sinks of the INT-20 pipeline (INT-23): Meta Conversions API, TikTok Events API, Snap Conversions API.
// One consented order context and one Purchase decision feed every connected sink; each sink gets the same event_id
// (its browser Pixel uses the same id, so each platform deduplicates its own pair). Sinks only differ in how they
// build and send the event.
import { ProviderError, type AdapterContext, type HealthCheckResult } from '../core';
import { buildSnapPurchase, snapCapiAdapter, SNAP_PIXEL_ID } from '../snapchat/capi';
import { buildTiktokPurchase, tiktokEventsAdapter, TIKTOK_PIXEL_CODE, type SinkSendResult, type TrackingPurchaseInput } from '../tiktok/events-api';
import { buildServerEvent, metaCapiAdapter, META_PIXEL_ID } from './meta-capi';

export type TrackingProvider = 'meta_capi' | 'tiktok_events' | 'snap_capi';
export const TRACKING_PROVIDERS: TrackingProvider[] = ['meta_capi', 'tiktok_events', 'snap_capi'];

export interface TrackingSink {
  provider: TrackingProvider;
  /** The platform's name for a purchase (Meta "Purchase", TikTok "CompletePayment", Snap "PURCHASE"). */
  purchaseEventName: string;
  /** The id the browser Pixel is initialised with (validated), or null. */
  browserPixelId(config: Record<string, unknown>): string | null;
  buildPurchase(input: TrackingPurchaseInput, now?: Date): { event: Record<string, unknown> } | { error: string };
  send(ctx: AdapterContext, events: Array<Record<string, unknown>>): Promise<SinkSendResult>;
  healthCheck(ctx: AdapterContext): Promise<HealthCheckResult>;
}

const str = (v: unknown) => (typeof v === 'string' ? v : '');

export const TRACKING_SINKS: Record<TrackingProvider, TrackingSink> = {
  meta_capi: {
    provider: 'meta_capi', purchaseEventName: 'Purchase',
    browserPixelId: (c) => (META_PIXEL_ID.test(str(c.pixelId)) ? str(c.pixelId) : null),
    buildPurchase: (i, now) => buildServerEvent({ eventName: 'Purchase', eventId: i.eventId, eventTime: i.eventTime, eventSourceUrl: i.eventSourceUrl,
      user: { email: i.user.email, phone: i.user.phone, externalId: i.user.externalId, country: i.user.country, clientIp: i.user.clientIp, userAgent: i.user.userAgent,
        fbp: i.user.fbp, fbc: i.user.fbc },
      custom: { currency: i.custom.currency, valueMinor: i.custom.valueMinor, orderId: i.custom.orderId, contents: i.custom.contents } }, now),
    async send(ctx, events) {
      const r = await metaCapiAdapter.sendEvents(ctx, events);
      return { eventsReceived: r.eventsReceived, traceId: r.fbtraceId };
    },
    healthCheck: async (ctx) => metaCapiAdapter.healthCheck(ctx),
  },
  tiktok_events: {
    provider: 'tiktok_events', purchaseEventName: tiktokEventsAdapter.purchaseEventName,
    browserPixelId: (c) => (TIKTOK_PIXEL_CODE.test(str(c.pixelCode)) ? str(c.pixelCode) : null),
    buildPurchase: buildTiktokPurchase,
    send: (ctx, events) => tiktokEventsAdapter.sendEvents(ctx, events),
    healthCheck: (ctx) => tiktokEventsAdapter.healthCheck(ctx),
  },
  snap_capi: {
    provider: 'snap_capi', purchaseEventName: snapCapiAdapter.purchaseEventName,
    browserPixelId: (c) => (SNAP_PIXEL_ID.test(str(c.pixelId)) ? str(c.pixelId).toLowerCase() : null),
    buildPurchase: buildSnapPurchase,
    send: (ctx, events) => snapCapiAdapter.sendEvents(ctx, events),
    healthCheck: (ctx) => snapCapiAdapter.healthCheck(ctx),
  },
};

export function trackingSink(provider: string): TrackingSink {
  const s = (TRACKING_SINKS as Record<string, TrackingSink | undefined>)[provider];
  if (!s) throw new ProviderError(provider, 'not a tracking provider', false);
  return s;
}

export type { SinkSendResult, TrackingPurchaseInput, TrackingUserInput } from '../tiktok/events-api';
