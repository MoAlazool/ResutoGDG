// TikTok Events API + Snap Conversions API acceptance checks (INT-23). Both use the platforms' own test paths:
// TikTok's Test event code (events show under Test events and do not count as conversions) and Snap's /validate
// endpoint (checked, not recorded). Synthetic data only: a TEST-NET-3 IP and no customer identifiers.
import { buildSnapPurchase, snapCapiAdapter } from '../snapchat/capi';
import { buildTiktokPurchase, tiktokEventsAdapter } from '../tiktok/events-api';
import { expectThat, registerChecks, type AcceptanceCheck } from './index';
import { runKey } from './payments-common';

const synthetic = (eventId: string) => ({
  eventId, eventTime: new Date(), eventSourceUrl: 'https://resuto.app/acceptance',
  user: { clientIp: '203.0.113.10', userAgent: 'Resuto acceptance check', externalId: `resuto-acceptance-${eventId}` },
  custom: { currency: 'EGP', valueMinor: 100, orderId: eventId },
});

export const trackingChecks: AcceptanceCheck[] = [
  {
    id: 'tiktok_events.test_purchase', provider: 'tiktok_events', capability: 'server_purchase', modes: ['official_test'],
    requires: ['TIKTOK_EVENTS_TOKEN', 'TIKTOK_PIXEL_CODE', 'TIKTOK_TEST_EVENT_CODE'], effect: 'write_test',
    prerequisites: ['TikTok Events Manager > the Pixel > Settings: generate an Events API access token; Test events: copy the test event code. Then check the event under Test events.'],
    docsUrl: 'https://ads.tiktok.com/help/article/events-api',
    async run(ctx) {
      const eventId = runKey('tt').replace(/[^A-Za-z0-9._:-]/g, '');
      const built = buildTiktokPurchase(synthetic(eventId));
      expectThat('event' in built, `event not built: ${'error' in built ? built.error : ''}`);
      const r = await tiktokEventsAdapter.sendEvents({ environment: 'sandbox', credentials: { accessToken: ctx.env.TIKTOK_EVENTS_TOKEN! },
        config: { pixelCode: ctx.env.TIKTOK_PIXEL_CODE, testEventCode: ctx.env.TIKTOK_TEST_EVENT_CODE }, fetch: ctx.adapter.fetch }, [built.event]);
      ctx.evidence('test CompletePayment accepted', { eventId, requestId: r.traceId });
    },
  },
  {
    id: 'snap_capi.validate_purchase', provider: 'snap_capi', capability: 'server_purchase', modes: ['official_test'],
    requires: ['SNAP_CAPI_TOKEN', 'SNAP_PIXEL_ID'], effect: 'read',
    prerequisites: ['Ads Manager > Business Details > Conversions API Tokens (Organization Admin). The check calls /events/validate only: nothing is recorded.'],
    docsUrl: 'https://developers.snap.com/api/marketing-api/Conversions-API/UsingTheAPI',
    async run(ctx) {
      const eventId = runKey('sc').replace(/[^A-Za-z0-9._:-]/g, '');
      const built = buildSnapPurchase(synthetic(eventId));
      expectThat('event' in built, `event not built: ${'error' in built ? built.error : ''}`);
      const r = await snapCapiAdapter.sendEvents({ environment: 'sandbox', credentials: { accessToken: ctx.env.SNAP_CAPI_TOKEN! },
        config: { pixelId: ctx.env.SNAP_PIXEL_ID }, fetch: ctx.adapter.fetch }, [built.event]);
      ctx.evidence('PURCHASE validated by Snap', { eventId, eventsReceived: r.eventsReceived });
    },
  },
];

registerChecks(...trackingChecks);
