// INT-23: TikTok Events API and Snap Conversions API as additional sinks of the INT-20 pipeline. One consented order
// context and one Purchase decision feed every connected platform with the same event id; each platform is delivered
// and retried on its own; test connections use each platform's test path. No real request: ProviderHttp is scripted.
import { createHash } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ProviderHttp } from '../src/modules/integrations/provider-http';
import { MetaTrackingService, purchaseEventId, TRACKING_CONSENT_VERSION } from '../src/modules/marketing/meta-tracking.service';
import { scriptedFetch } from './growth-helpers';
import { auth, bootTestApp, createTenant, seedMenu, sql, unique, type SeededMenu, type TestApp, type TestTenant } from './helpers';

let t: TestApp;
let http: ProviderHttp;
let original: typeof fetch;
let svc: MetaTrackingService;
beforeAll(async () => { t = await bootTestApp(); http = t.app.get(ProviderHttp); original = http.fetch; svc = t.app.get(MetaTrackingService); });
afterEach(() => { http.fetch = original; });
afterAll(async () => { await t.close(); });

const sha = (v: string) => createHash('sha256').update(v).digest('hex');
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0) Safari/604.1';
const TT_PIXEL = 'C4ABCDEF1234567890AB';
const SNAP_PIXEL = '0f3c1c4e-1111-2222-3333-444455556666';

async function connect(tenant: TestTenant, provider: string, environment: 'live' | 'sandbox', credentials: Record<string, string>, config: Record<string, unknown>) {
  const res = await t.http.post(`/v1/o/${tenant.orgId}/integrations/connections`).set(auth(tenant.owner)).send({ provider, environment, credentials, config });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  await sql(`update integration_connections set status = 'connected' where id = $1`, [res.body.id]);
  return res.body.id as string;
}
async function allSinks(env: 'live' | 'sandbox' = 'live') {
  const tenant = await createTenant(t);
  const menu = await seedMenu(tenant);
  await connect(tenant, 'meta_capi', env, { accessToken: 'EAAG-capi-token-123456' }, { pixelId: '1234567890', ...(env === 'sandbox' ? { testEventCode: 'TEST4242' } : {}) });
  await connect(tenant, 'tiktok_events', env, { accessToken: 'tt-events-token-123456' }, { pixelCode: TT_PIXEL, ...(env === 'sandbox' ? { testEventCode: 'TT_TEST_77' } : {}) });
  await connect(tenant, 'snap_capi', env, { accessToken: 'snap-capi-token-123456' }, { pixelId: SNAP_PIXEL });
  return { tenant, menu };
}
let seq = 0;
async function webOrder(tenant: TestTenant, menu: SeededMenu) {
  const res = await t.http.post(`/v1/public/order/${tenant.slug}/orders`).set('Idempotency-Key', unique('sink'))
    .send({ branchId: tenant.branchId, fulfillment: 'pickup', payment: 'pay_at_pickup', lines: [{ productId: menu.products.fries, quantity: 2 }],
      customer: { name: 'Salma', phone: `+2010088${String(++seq).padStart(5, '0')}`, email: 'Salma@Example.com' } });
  if (res.status !== 201) throw new Error(`web order failed: ${res.status} ${JSON.stringify(res.body)}`);
  return { id: res.body.order.id as string, ref: res.body.order.publicRef as string, phone: `+2010088${String(seq).padStart(5, '0')}` };
}
const consent = (tenant: TestTenant, ref: string) => t.http.post(`/v1/public/tracking/${tenant.slug}/orders/${ref}/context`).set('User-Agent', UA)
  .send({ consentVersion: TRACKING_CONSENT_VERSION, fbp: 'fb.1.1760961600000.1234567890', pageUrl: `https://olive.example/order/${tenant.slug}`,
    ttp: 'ttp_Abcdefgh12345', ttclid: 'E.C.P.click123456', scid: '7d1c2f3a-aaaa-bbbb-cccc-1234567890ab', scClickId: 'sc-click-abcdef' });
async function pay(tenant: TestTenant, orderId: string) {
  const [o] = await sql(`select total_minor, currency from orders where id = $1`, [orderId]);
  await sql(`insert into payments(org_id, branch_id, order_id, method, provider, amount_minor, currency, status, is_test, captured_at)
             values ($1, $2, $3, 'card', 'paymob', $4, $5, 'succeeded', false, now())`, [tenant.orgId, tenant.branchId, orderId, o.total_minor, o.currency]);
  await sql(`update orders set payment_status = 'paid', paid_minor = total_minor where id = $1`, [orderId]);
}
/** Answers each platform by URL, so the order of calls does not matter. */
function platforms(over: { tiktok?: () => { status?: number; body: unknown } } = {}) {
  return scriptedFetch([(req) => {
    if (req.url.startsWith('https://graph.facebook.com/')) return { body: { events_received: 1, fbtrace_id: 'MetaTrace' } };
    if (req.url.startsWith('https://business-api.tiktok.com/')) return over.tiktok?.() ?? { body: { code: 0, message: 'OK', request_id: 'tt-req-1' } };
    if (req.url.startsWith('https://tr.snapchat.com/')) return { body: { status: 'VALID', reason: 'Events have been processed successfully.' } };
    return { status: 404, body: {} };
  }]);
}

describe('website config and consent (INT-23)', () => {
  it('lists each connected platform\'s browser Pixel, never for demo restaurants; the context stores TikTok and Snap ids', async () => {
    const { tenant, menu } = await allSinks();
    const cfg = (await t.http.get(`/v1/public/tracking/${tenant.slug}`)).body;
    expect(cfg).toEqual({ meta: { pixelId: '1234567890', testMode: false }, tiktok: { pixelId: TT_PIXEL, testMode: false }, snap: { pixelId: SNAP_PIXEL, testMode: false },
      consentVersion: TRACKING_CONSENT_VERSION });
    const o = await webOrder(tenant, menu);
    expect((await consent(tenant, o.ref)).body).toEqual({ recorded: true });
    const [row] = await sql(`select ttp, ttclid, scid, sc_click_id from meta_tracking_contexts where order_id = $1`, [o.id]);
    expect(row).toEqual({ ttp: 'ttp_Abcdefgh12345', ttclid: 'E.C.P.click123456', scid: '7d1c2f3a-aaaa-bbbb-cccc-1234567890ab', sc_click_id: 'sc-click-abcdef' });
    const bad = await t.http.post(`/v1/public/tracking/${tenant.slug}/orders/${o.ref}/context`).send({ consentVersion: TRACKING_CONSENT_VERSION, ttp: '<script>' });
    expect(bad.status).toBe(400);
    await sql(`update organizations set onboarding = onboarding || '{"demo": true}' where id = $1`, [tenant.orgId]);
    expect((await t.http.get(`/v1/public/tracking/${tenant.slug}`)).body).toEqual({ meta: null, consentVersion: TRACKING_CONSENT_VERSION });
  });

  it('a TikTok-only restaurant gets no Meta Pixel; the connection forms validate pixel ids', async () => {
    const tenant = await createTenant(t);
    await connect(tenant, 'tiktok_events', 'live', { accessToken: 'tt-events-token-123456' }, { pixelCode: TT_PIXEL });
    expect((await t.http.get(`/v1/public/tracking/${tenant.slug}`)).body).toEqual({ meta: null, tiktok: { pixelId: TT_PIXEL, testMode: false }, consentVersion: TRACKING_CONSENT_VERSION });
    const bad = await t.http.post(`/v1/o/${tenant.orgId}/integrations/connections`).set(auth(tenant.owner))
      .send({ provider: 'snap_capi', environment: 'live', credentials: { accessToken: 'snap-token-1234' }, config: { pixelId: 'not-a-uuid' } });
    expect(bad.status).toBe(422);
    expect(bad.body.error.details.invalid).toEqual(['pixelId']);
  });
});

describe('server Purchase to every connected platform (INT-23)', () => {
  it('sends one Purchase per platform with the same event id, platform-specific hashing, and never resends', async () => {
    const { tenant, menu } = await allSinks();
    const o = await webOrder(tenant, menu);
    await consent(tenant, o.ref);
    await pay(tenant, o.id);
    const f = platforms();
    http.fetch = f.fetch;
    const res = await svc.sendPurchase(tenant.orgId, o.id);
    expect(res).toEqual({ sinks: { meta_capi: { sent: true, eventsReceived: 1 }, tiktok_events: { sent: true, eventsReceived: 1 }, snap_capi: { sent: true, eventsReceived: 1 } } });
    expect(f.calls).toHaveLength(3);
    const eventId = purchaseEventId(o.ref);
    const tt = f.calls.find((c) => c.url.includes('tiktok'))!;
    expect(tt.headers['access-token']).toBe('tt-events-token-123456');
    const ttBody = JSON.parse(tt.body!);
    expect(ttBody).toMatchObject({ event_source: 'web', event_source_id: TT_PIXEL });
    expect(ttBody.test_event_code).toBeUndefined();
    expect(ttBody.data[0]).toMatchObject({ event: 'CompletePayment', event_id: eventId, properties: { currency: 'EGP', value: 90 } });
    expect(ttBody.data[0].user).toMatchObject({ email: sha('salma@example.com'), phone: sha(o.phone), ttp: 'ttp_Abcdefgh12345', ttclid: 'E.C.P.click123456', user_agent: UA });
    const sc = f.calls.find((c) => c.url.includes('snapchat'))!;
    expect(sc.url).toBe(`https://tr.snapchat.com/v3/${SNAP_PIXEL}/events?access_token=snap-capi-token-123456`);
    const scEv = JSON.parse(sc.body!).data[0];
    expect(scEv).toMatchObject({ event_name: 'PURCHASE', event_id: eventId, action_source: 'WEB', custom_data: { order_id: eventId, currency: 'EGP', value: 90, num_items: '2' } });
    expect(scEv.user_data).toMatchObject({ em: [sha('salma@example.com')], ph: [sha(o.phone.slice(1))], sc_cookie1: '7d1c2f3a-aaaa-bbbb-cccc-1234567890ab', sc_click_id: 'sc-click-abcdef' });
    for (const c of f.calls) expect(c.body).not.toContain('Salma@Example.com');
    const rows = await sql(`select provider, event_name, event_id, status, fbtrace_id from meta_capi_events where org_id = $1 order by provider`, [tenant.orgId]);
    expect(rows).toEqual([
      { provider: 'meta_capi', event_name: 'Purchase', event_id: eventId, status: 'sent', fbtrace_id: 'MetaTrace' },
      { provider: 'snap_capi', event_name: 'PURCHASE', event_id: eventId, status: 'sent', fbtrace_id: null },
      { provider: 'tiktok_events', event_name: 'CompletePayment', event_id: eventId, status: 'sent', fbtrace_id: 'tt-req-1' },
    ]);
    // The browser fires every connected Pixel with the same event id.
    expect((await t.http.get(`/v1/public/tracking/${tenant.slug}/orders/${o.ref}/purchase`)).body)
      .toEqual({ fire: true, eventId, valueMinor: 9000, currency: 'EGP', pixels: ['meta', 'snap', 'tiktok'] });
    expect(await svc.sendPurchase(tenant.orgId, o.id)).toEqual({ sinks: { meta_capi: { skipped: 'already_sent' }, tiktok_events: { skipped: 'already_sent' }, snap_capi: { skipped: 'already_sent' } } });
    expect(f.calls).toHaveLength(3);
  });

  it('a TikTok outage is retried alone: Meta and Snap are delivered once, the retry reaches only TikTok with the same event id', async () => {
    const { tenant, menu } = await allSinks();
    const o = await webOrder(tenant, menu);
    await consent(tenant, o.ref);
    await pay(tenant, o.id);
    const down = platforms({ tiktok: () => ({ body: { code: 50000, message: 'internal error' } }) });
    http.fetch = down.fetch;
    await expect(svc.sendPurchase(tenant.orgId, o.id)).rejects.toThrow(/tiktok_events send failed \(will retry\)/);
    expect(down.calls).toHaveLength(3);
    const status = async () => Object.fromEntries((await sql(`select provider, status, attempts from meta_capi_events where org_id = $1`, [tenant.orgId]))
      .map((r: any) => [r.provider, `${r.status}/${r.attempts}`]));
    expect(await status()).toEqual({ meta_capi: 'sent/1', snap_capi: 'sent/1', tiktok_events: 'failed/1' });
    const up = platforms();
    http.fetch = up.fetch;
    const retry = await svc.sendPurchase(tenant.orgId, o.id);
    expect(retry).toMatchObject({ sinks: { meta_capi: { skipped: 'already_sent' }, snap_capi: { skipped: 'already_sent' }, tiktok_events: { sent: true } } });
    expect(up.calls.map((c) => new URL(c.url).host)).toEqual(['business-api.tiktok.com']);
    expect(JSON.parse(up.calls[0]!.body!).data[0].event_id).toBe(JSON.parse(down.calls.find((c) => c.url.includes('tiktok'))!.body!).data[0].event_id);
    expect(await status()).toEqual({ meta_capi: 'sent/1', snap_capi: 'sent/1', tiktok_events: 'sent/2' });
  });

  it('no consent: every platform records the skip and nothing is sent', async () => {
    const { tenant, menu } = await allSinks();
    const o = await webOrder(tenant, menu);
    await pay(tenant, o.id);
    const f = platforms();
    http.fetch = f.fetch;
    expect(await svc.sendPurchase(tenant.orgId, o.id)).toEqual({ sinks: { meta_capi: { skipped: 'no_consent' }, tiktok_events: { skipped: 'no_consent' }, snap_capi: { skipped: 'no_consent' } } });
    expect(f.calls).toHaveLength(0);
  });
});

describe('test connections (INT-23)', () => {
  it('TikTok test connections carry the test event code; Snap test connections only call /validate; test buttons send synthetic data', async () => {
    const { tenant, menu } = await allSinks('sandbox');
    const o = await webOrder(tenant, menu);
    await consent(tenant, o.ref);
    await pay(tenant, o.id);
    const f = platforms();
    http.fetch = f.fetch;
    await svc.sendPurchase(tenant.orgId, o.id);
    expect(JSON.parse(f.calls.find((c) => c.url.includes('tiktok'))!.body!).test_event_code).toBe('TT_TEST_77');
    expect(f.calls.find((c) => c.url.includes('snapchat'))!.url).toContain(`/v3/${SNAP_PIXEL}/events/validate?`);

    const tt = await t.http.post(`/v1/o/${tenant.orgId}/marketing/tracking/sinks/tiktok_events/test-event`).set(auth(tenant.owner)).set('User-Agent', UA);
    expect(tt.status).toBe(201);
    expect(tt.body).toMatchObject({ sent: true });
    const ttTest = JSON.parse(f.calls.at(-1)!.body!);
    expect(ttTest.test_event_code).toBe('TT_TEST_77');
    expect(Object.keys(ttTest.data[0].user).sort()).toEqual(['external_id', 'ip', 'user_agent']);
    const sn = await t.http.post(`/v1/o/${tenant.orgId}/marketing/tracking/sinks/snap_capi/test-event`).set(auth(tenant.owner)).set('User-Agent', UA);
    expect(sn.body).toMatchObject({ sent: true });
    expect(f.calls.at(-1)!.url).toContain('/events/validate?');

    const diag = (await t.http.get(`/v1/o/${tenant.orgId}/marketing/tracking/sinks/tiktok_events`).set(auth(tenant.owner))).body;
    expect(diag).toMatchObject({ provider: 'tiktok_events', connection: { testMode: true, pixelId: TT_PIXEL, hasTestEventCode: true } });
    expect(diag.events.map((e: any) => [e.source, e.eventName, e.status])).toEqual([['test', 'CompletePayment', 'sent'], ['order', 'CompletePayment', 'sent']]);
    expect(JSON.stringify(diag)).not.toContain('tt-events-token');
    // The Meta diagnostics stay Meta-only.
    const meta = (await t.http.get(`/v1/o/${tenant.orgId}/marketing/tracking/meta`).set(auth(tenant.owner))).body;
    expect(meta.events.every((e: any) => e.eventName === 'Purchase')).toBe(true);
    expect((await t.http.get(`/v1/o/${tenant.orgId}/marketing/tracking/sinks/google_ads`).set(auth(tenant.owner))).status).toBe(400);
  });
});
