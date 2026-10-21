import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { runAcceptance } from '../acceptance';
import { trackingChecks } from '../acceptance/tracking';
import type { AdapterContext } from '../core';
import { scriptedFetch } from '../messaging/testing/scripted-fetch';
import { buildSnapPurchase, snapCapiAdapter } from '../snapchat/capi';
import { buildTiktokPurchase, hashPhoneE164, tiktokEventsAdapter } from '../tiktok/events-api';
import { trackingSink, TRACKING_SINKS } from './tracking-sinks';

const sha = (v: string) => createHash('sha256').update(v).digest('hex');
const NOW = new Date('2026-10-21T10:00:00Z');
const input = {
  eventId: 'p.0123456789abcdef', eventTime: new Date('2026-10-21T09:58:00Z'), eventSourceUrl: 'https://olive.example/order/olive',
  user: { email: ' Salma@Example.COM ', phone: '+20 100 123 4567', externalId: 'cust-1', country: 'EG', clientIp: '198.51.100.7', userAgent: 'Mozilla/5.0',
    fbp: 'fb.1.1700000000000.1234567890', ttp: 'ttp_abcdefgh123', ttclid: 'E.C.P.abcdefgh', scid: '0f3c1c4e-1111-2222-3333-444455556666', scClickId: 'click-abcdef12' },
  custom: { currency: 'EGP', valueMinor: 12_550, orderId: 'p.0123456789abcdef', contents: [{ id: 'prod-1', quantity: 2, itemPriceMinor: 5000 }] },
};
const ctx = (fetch: typeof globalThis.fetch, over: Partial<AdapterContext> = {}): AdapterContext =>
  ({ environment: 'live', credentials: { accessToken: 'TT-SECRET-TOKEN-0001' }, config: {}, fetch, ...over });

describe('TikTok Events API sink (INT-23)', () => {
  it('builds a CompletePayment with hashed identifiers, raw ttp/ttclid/ip/ua and decimal values', () => {
    const r = buildTiktokPurchase(input, NOW);
    if ('error' in r) throw new Error(r.error);
    expect(r.event).toMatchObject({ event: 'CompletePayment', event_time: Math.floor(input.eventTime.getTime() / 1000), event_id: input.eventId,
      page: { url: input.eventSourceUrl } });
    const user = r.event.user as Record<string, string>;
    expect(user.email).toBe(sha('salma@example.com'));
    expect(user.phone).toBe(sha('+201001234567'));
    expect(user.external_id).toBe(sha('cust-1'));
    expect(user).toMatchObject({ ttp: 'ttp_abcdefgh123', ttclid: 'E.C.P.abcdefgh', ip: '198.51.100.7', user_agent: 'Mozilla/5.0' });
    expect(JSON.stringify(r.event)).not.toContain('Salma');
    expect(r.event.properties).toEqual({ currency: 'EGP', value: 125.5, content_type: 'product', contents: [{ content_id: 'prod-1', quantity: 2, price: 50 }] });
    expect(hashPhoneE164('0020 100')).toBeNull();
  });

  it('refuses events Meta-style rules would refuse (too old, no user agent, http page)', () => {
    expect(buildTiktokPurchase({ ...input, eventTime: new Date('2026-10-10T00:00:00Z') }, NOW)).toEqual({ error: 'event_too_old' });
    expect(buildTiktokPurchase({ ...input, user: { ...input.user, userAgent: null } }, NOW)).toEqual({ error: 'client_user_agent_required' });
    expect(buildTiktokPurchase({ ...input, eventSourceUrl: 'http://x' }, NOW)).toEqual({ error: 'event_source_url_required' });
  });

  it('posts to event/track with the Access-Token header; live never sends the test code', async () => {
    const { fetch, calls } = scriptedFetch([{ body: { code: 0, message: 'OK', request_id: 'req-1' } }]);
    const built = buildTiktokPurchase(input, NOW) as { event: Record<string, unknown> };
    const r = await tiktokEventsAdapter.sendEvents(ctx(fetch, { config: { pixelCode: 'C4ABCDEF1234567890AB', testEventCode: 'TEST123' } }), [built.event]);
    expect(calls[0].url).toBe('https://business-api.tiktok.com/open_api/v1.3/event/track/');
    expect(calls[0].headers['access-token']).toBe('TT-SECRET-TOKEN-0001');
    const body = JSON.parse(calls[0].body!);
    expect(body).toMatchObject({ event_source: 'web', event_source_id: 'C4ABCDEF1234567890AB' });
    expect(body.test_event_code).toBeUndefined();
    expect(r).toEqual({ eventsReceived: 1, traceId: 'req-1' });
  });

  it('test connections must send the test code; TikTok error codes become ProviderErrors without the message', async () => {
    const noCode = scriptedFetch([{ body: { code: 0 } }]);
    await expect(tiktokEventsAdapter.sendEvents(ctx(noCode.fetch, { environment: 'sandbox', config: { pixelCode: 'C4ABCDEF1234567890AB' } }), [{}]))
      .rejects.toThrow('needs the Test event code');
    expect(noCode.calls).toHaveLength(0);
    const rejected = scriptedFetch([{ body: { code: 40002, message: 'Invalid email salma@example.com' } }]);
    const err = await tiktokEventsAdapter.sendEvents(ctx(rejected.fetch, { environment: 'sandbox', config: { pixelCode: 'C4ABCDEF1234567890AB', testEventCode: 'TEST123' } }), [{}])
      .catch((e) => e);
    expect(JSON.parse(rejected.calls[0].body!).test_event_code).toBe('TEST123');
    expect(err.message).toBe('tiktok_events: rejected (code 40002)');
    expect(err.retryable).toBe(false);
    const busy = scriptedFetch([{ body: { code: 50000, message: 'system error' } }]);
    expect((await tiktokEventsAdapter.sendEvents(ctx(busy.fetch, { config: { pixelCode: 'C4ABCDEF1234567890AB' } }), [{}]).catch((e) => e)).retryable).toBe(true);
  });

  it('health check sends one synthetic test event even on live connections (never a real conversion)', async () => {
    const { fetch, calls } = scriptedFetch([{ body: { code: 0, request_id: 'r' } }]);
    const h = await tiktokEventsAdapter.healthCheck(ctx(fetch, { config: { pixelCode: 'C4ABCDEF1234567890AB', testEventCode: 'TEST123' } }));
    expect(h.ok).toBe(true);
    const body = JSON.parse(calls[0].body!);
    expect(body.test_event_code).toBe('TEST123');
    expect(body.data[0].user).toEqual({ ip: '203.0.113.10', user_agent: 'Resuto TikTok Events API health check' });
  });
});

describe('Snap Conversions API sink (INT-23)', () => {
  it('builds a PURCHASE with array-hashed em/ph (digits only), raw click ids, order_id and string num_items', () => {
    const r = buildSnapPurchase(input, NOW);
    if ('error' in r) throw new Error(r.error);
    expect(r.event).toMatchObject({ event_name: 'PURCHASE', action_source: 'WEB', event_id: input.eventId, event_source_url: input.eventSourceUrl,
      event_time: Math.floor(input.eventTime.getTime() / 1000) });
    expect(r.event.user_data).toEqual({ em: [sha('salma@example.com')], ph: [sha('201001234567')], client_ip_address: '198.51.100.7', client_user_agent: 'Mozilla/5.0',
      sc_click_id: 'click-abcdef12', sc_cookie1: '0f3c1c4e-1111-2222-3333-444455556666' });
    expect(r.event.custom_data).toEqual({ currency: 'EGP', value: 125.5, order_id: input.eventId, contents: [{ id: 'prod-1', quantity: 2, item_price: 50 }], num_items: '2' });
  });

  it('live posts to /events with the token in the query (Snap\'s documented form); test connections call /validate', async () => {
    const live = scriptedFetch([{ body: { status: 'VALID', reason: 'Events have been processed successfully.' } }]);
    const built = buildSnapPurchase(input, NOW) as { event: Record<string, unknown> };
    await snapCapiAdapter.sendEvents(ctx(live.fetch, { config: { pixelId: '0F3C1C4E-1111-2222-3333-444455556666' } }), [built.event]);
    expect(live.calls[0].url).toBe('https://tr.snapchat.com/v3/0f3c1c4e-1111-2222-3333-444455556666/events?access_token=TT-SECRET-TOKEN-0001');
    const test = scriptedFetch([{ body: { status: 'VALID' } }]);
    await snapCapiAdapter.sendEvents(ctx(test.fetch, { environment: 'sandbox', config: { pixelId: '0f3c1c4e-1111-2222-3333-444455556666', testEventCode: 'datahash' } }), [built.event]);
    expect(test.calls[0].url).toContain('/events/validate?access_token=');
    expect(JSON.parse(test.calls[0].body!).test_event_code).toBe('datahash');
  });

  it('a non-VALID answer or HTTP error is reported without the URL (which carries the token)', async () => {
    const bad = scriptedFetch([{ body: { status: 'INVALID', reason: 'bad em for salma' } }]);
    const err = await snapCapiAdapter.sendEvents(ctx(bad.fetch, { config: { pixelId: '0f3c1c4e-1111-2222-3333-444455556666' } }), [{}]).catch((e) => e);
    expect(err.message).toBe('snap_capi: rejected (status INVALID)');
    const down = scriptedFetch([{ status: 503, body: {} }]);
    const e2 = await snapCapiAdapter.sendEvents(ctx(down.fetch, { config: { pixelId: '0f3c1c4e-1111-2222-3333-444455556666' } }), [{}]).catch((e) => e);
    expect(e2.message).toBe('snap_capi: HTTP 503');
    expect(e2.retryable).toBe(true);
    expect(`${err.message}${e2.message}`).not.toContain('TT-SECRET');
  });
});

describe('sink registry', () => {
  it('maps each provider to its purchase event name and validated browser pixel id', () => {
    expect(Object.keys(TRACKING_SINKS)).toEqual(['meta_capi', 'tiktok_events', 'snap_capi']);
    expect(trackingSink('meta_capi').purchaseEventName).toBe('Purchase');
    expect(trackingSink('tiktok_events').purchaseEventName).toBe('CompletePayment');
    expect(trackingSink('snap_capi').purchaseEventName).toBe('PURCHASE');
    expect(trackingSink('tiktok_events').browserPixelId({ pixelCode: 'bad code' })).toBeNull();
    expect(trackingSink('snap_capi').browserPixelId({ pixelId: '0F3C1C4E-1111-2222-3333-444455556666' })).toBe('0f3c1c4e-1111-2222-3333-444455556666');
    expect(() => trackingSink('google_ads')).toThrow('not a tracking provider');
    // The same event id goes to every sink (each platform dedups against its own Pixel).
    for (const s of Object.values(TRACKING_SINKS)) {
      const b = s.buildPurchase(input, NOW) as { event: Record<string, unknown> };
      expect(b.event.event_id).toBe(input.eventId);
    }
  });
});

describe('tracking acceptance checks', () => {
  it('are not_run without credentials and pass against scripted transports', async () => {
    const none = await runAcceptance(trackingChecks, { mode: 'official_test', env: {} });
    expect(none.map((r) => r.status)).toEqual(['not_run', 'not_run']);
    const { fetch } = scriptedFetch([{ body: { code: 0, request_id: 'x' } }, { body: { status: 'VALID' } }]);
    const env = { TIKTOK_EVENTS_TOKEN: 'tt-token-123456', TIKTOK_PIXEL_CODE: 'C4ABCDEF1234567890AB', TIKTOK_TEST_EVENT_CODE: 'TEST123',
      SNAP_CAPI_TOKEN: 'snap-token-123456', SNAP_PIXEL_ID: '0f3c1c4e-1111-2222-3333-444455556666' };
    const ran = await runAcceptance(trackingChecks, { mode: 'official_test', env, fetch });
    expect(ran.map((r) => r.status)).toEqual(['passed', 'passed']);
    expect(JSON.stringify(ran)).not.toContain('tt-token-123456');
  });
});
