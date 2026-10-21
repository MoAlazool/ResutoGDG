// INT-20: Meta Pixel + Conversions API. Consent-gated, deduplicated (shared event_id), prepaid vs cash Purchase policy,
// never for demo restaurants or test/simulated payments, test_event_code only on test connections, retried by the outbox.
// INT-22: Custom Audience dry run (hashed, consent-filtered, nothing sent to Meta).
import { createHash } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { EventDispatcher } from '../src/common/events/dispatcher.service';
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
const UA = 'Mozilla/5.0 (Linux; Android 14) Chrome/130';
const FBP = 'fb.1.1760961600000.1234567890';
const FBC = 'fb.1.1760961600000.IwAR1abcdefghijkl';

async function tracked(opts: { environment?: 'live' | 'sandbox'; config?: Record<string, unknown> } = {}) {
  const tenant = await createTenant(t);
  const menu = await seedMenu(tenant);
  const res = await t.http.post(`/v1/o/${tenant.orgId}/integrations/connections`).set(auth(tenant.owner))
    .send({ provider: 'meta_capi', environment: opts.environment ?? 'live', credentials: { accessToken: 'EAAG-capi-token-123456' }, config: { pixelId: '1234567890', ...opts.config } });
  expect(res.status).toBe(201);
  await sql(`update integration_connections set status = 'connected' where id = $1`, [res.body.id]);
  return { tenant, menu, connectionId: res.body.id as string };
}

let phoneSeq = 0;
async function webOrder(tenant: TestTenant, menu: SeededMenu, email: string | null = 'Salma@Example.com', phone = `+2010077${String(++phoneSeq).padStart(5, '0')}`) {
  const res = await t.http.post(`/v1/public/order/${tenant.slug}/orders`).set('Idempotency-Key', unique('capi'))
    .send({ branchId: tenant.branchId, fulfillment: 'pickup', payment: 'pay_at_pickup', lines: [{ productId: menu.products.fries, quantity: 2 }],
      customer: { name: 'Salma', phone, email } });
  if (res.status !== 201) throw new Error(`web order failed: ${res.status} ${JSON.stringify(res.body)}`);
  return { id: res.body.order.id as string, ref: res.body.order.publicRef as string };
}

const consent = (tenant: TestTenant, ref: string, body: Record<string, unknown> = {}) =>
  t.http.post(`/v1/public/tracking/${tenant.slug}/orders/${ref}/context`).set('User-Agent', UA)
    .send({ consentVersion: TRACKING_CONSENT_VERSION, fbp: FBP, fbc: FBC, pageUrl: `https://olive.example/order/${tenant.slug}`, ...body });

async function pay(tenant: TestTenant, orderId: string, p: { provider: string; method?: string; isTest?: boolean }) {
  const [o] = await sql(`select total_minor, currency from orders where id = $1`, [orderId]);
  await sql(`insert into payments(org_id, branch_id, order_id, method, provider, amount_minor, currency, status, is_test, captured_at)
             values ($1, $2, $3, $4, $5, $6, $7, 'succeeded', $8, now())`,
    [tenant.orgId, tenant.branchId, orderId, p.method ?? 'card', p.provider, o.total_minor, o.currency, p.isTest ?? false]);
  await sql(`update orders set payment_status = 'paid', paid_minor = total_minor where id = $1`, [orderId]);
}

const events = (orgId: string) => sql(`select event_name, event_id, source, status, skip_reason, test_mode, attempts, events_received, summary from meta_capi_events where org_id = $1 order by created_at`, [orgId]);

describe('website Pixel config', () => {
  it('is null until the restaurant has a healthy connection; never for a demo restaurant; respects "browser Pixel off"', async () => {
    const plain = await createTenant(t);
    expect((await t.http.get(`/v1/public/tracking/${plain.slug}`)).body).toEqual({ meta: null, consentVersion: TRACKING_CONSENT_VERSION });
    const { tenant, connectionId } = await tracked();
    expect((await t.http.get(`/v1/public/tracking/${tenant.slug}`)).body).toEqual({ meta: { pixelId: '1234567890', testMode: false }, consentVersion: TRACKING_CONSENT_VERSION });
    await sql(`update integration_connections set config = config || '{"browserPixel":"off"}' where id = $1`, [connectionId]);
    expect((await t.http.get(`/v1/public/tracking/${tenant.slug}`)).body.meta).toBeNull();
    await sql(`update integration_connections set config = config - 'browserPixel' where id = $1`, [connectionId]);
    await sql(`update organizations set onboarding = onboarding || '{"demo": true}' where id = $1`, [tenant.orgId]);
    expect((await t.http.get(`/v1/public/tracking/${tenant.slug}`)).body.meta).toBeNull();
    expect((await t.http.get('/v1/public/tracking/no-such-place')).status).toBe(404);
  });

  it('the connection form validates the pixel id and the Test Events code', async () => {
    const tenant = await createTenant(t);
    const res = await t.http.post(`/v1/o/${tenant.orgId}/integrations/connections`).set(auth(tenant.owner))
      .send({ provider: 'meta_capi', environment: 'sandbox', credentials: { accessToken: 'tok-123456789' }, config: { pixelId: 'abc', testEventCode: 'nope' } });
    expect(res.status).toBe(422);
    expect(res.body.error.details.invalid.sort()).toEqual(['pixelId', 'testEventCode']);
  });
});

describe('consented order context', () => {
  it('is stored only for a recent web order of this restaurant, with the IP and user agent the API saw', async () => {
    const { tenant, menu } = await tracked();
    const o = await webOrder(tenant, menu);
    expect((await consent(tenant, o.ref, { consentVersion: 'old' })).body.error.code).toBe('consent_outdated');
    expect((await consent(tenant, o.ref, { fbp: 'not-a-cookie' })).status).toBe(400);
    expect((await consent(tenant, o.ref)).body).toEqual({ recorded: true });
    const [row] = await sql(`select fbp, fbc, client_user_agent, client_ip, event_source_url from meta_tracking_contexts where order_id = $1`, [o.id]);
    expect(row).toMatchObject({ fbp: FBP, fbc: FBC, client_user_agent: UA, event_source_url: `https://olive.example/order/${tenant.slug}` });
    expect(row.client_ip).toMatch(/^[0-9a-f:.]+$/i);
    const other = await tracked();
    expect((await consent(other.tenant, o.ref)).status).toBe(404);
    await sql(`update orders set placed_at = now() - interval '2 hours' where id = $1`, [o.id]);
    expect((await consent(tenant, o.ref)).status).toBe(404);
  });
});

describe('server Purchase (Conversions API)', () => {
  it('prepaid: sent once when the online payment is captured, hashed, with the browser ids and the shared event id', async () => {
    const { tenant, menu } = await tracked();
    const o = await webOrder(tenant, menu, 'Salma@Example.com', '+201006667777');
    await consent(tenant, o.ref);
    await pay(tenant, o.id, { provider: 'paymob' });
    const f = scriptedFetch([{ body: { events_received: 1, messages: [], fbtrace_id: 'AbcTrace' } }]);
    http.fetch = f.fetch;
    expect(await svc.sendPurchase(tenant.orgId, o.id)).toEqual({ sent: true, eventsReceived: 1 });
    expect(f.calls).toHaveLength(1);
    expect(new URL(f.calls[0]!.url).pathname).toBe('/v26.0/1234567890/events');
    expect(f.calls[0]!.headers.authorization).toBe('Bearer EAAG-capi-token-123456');
    const body = JSON.parse(f.calls[0]!.body!);
    expect(body.test_event_code).toBeUndefined();
    const ev = body.data[0];
    expect(ev).toMatchObject({ event_name: 'Purchase', event_id: purchaseEventId(o.ref), action_source: 'website', event_source_url: `https://olive.example/order/${tenant.slug}`,
      custom_data: { currency: 'EGP', value: 90, order_id: purchaseEventId(o.ref), content_type: 'product', num_items: 2 } });
    expect(ev.user_data).toMatchObject({ em: [sha('salma@example.com')], ph: [sha('201006667777')], country: [sha('eg')], fbp: FBP, fbc: FBC, client_user_agent: UA });
    expect(ev.event_id).not.toContain(o.ref);
    expect(f.calls[0]!.body).not.toContain('Salma@Example.com');
    expect(f.calls[0]!.body).not.toContain('201006667777"');
    // The browser is told to fire the same event id (Meta deduplicates the pair).
    expect((await t.http.get(`/v1/public/tracking/${tenant.slug}/orders/${o.ref}/purchase`)).body).toEqual({ fire: true, eventId: purchaseEventId(o.ref), valueMinor: 9000, currency: 'EGP' });
    // A second trigger (order completed later) does not resend.
    expect(await svc.sendPurchase(tenant.orgId, o.id)).toEqual({ skipped: 'already_sent' });
    expect(f.calls).toHaveLength(1);
    expect(await events(tenant.orgId)).toEqual([expect.objectContaining({ status: 'sent', attempts: 1, events_received: 1, test_mode: false,
      summary: expect.objectContaining({ basis: 'prepaid', matchKeys: ['client_ip_address', 'client_user_agent', 'country', 'em', 'external_id', 'fbc', 'fbp', 'ph'] }) })]);
  });

  it('no consent, a test or simulated payment, or a demo restaurant: nothing reaches Meta', async () => {
    const { tenant, menu } = await tracked();
    const f = scriptedFetch([{ body: { events_received: 1 } }]);
    http.fetch = f.fetch;
    const noConsent = await webOrder(tenant, menu);
    await pay(tenant, noConsent.id, { provider: 'paymob' });
    expect(await svc.sendPurchase(tenant.orgId, noConsent.id)).toEqual({ skipped: 'no_consent' });
    expect((await t.http.get(`/v1/public/tracking/${tenant.slug}/orders/${noConsent.ref}/purchase`)).body).toEqual({ fire: false });
    const simulated = await webOrder(tenant, menu);
    await consent(tenant, simulated.ref);
    await pay(tenant, simulated.id, { provider: 'simulated' });
    expect(await svc.sendPurchase(tenant.orgId, simulated.id)).toEqual({ skipped: 'test_payment' });
    const testPay = await webOrder(tenant, menu);
    await consent(tenant, testPay.ref);
    await pay(tenant, testPay.id, { provider: 'stripe', isTest: true });
    expect(await svc.sendPurchase(tenant.orgId, testPay.id)).toEqual({ skipped: 'test_payment' });
    const demo = await webOrder(tenant, menu);
    await consent(tenant, demo.ref);
    await pay(tenant, demo.id, { provider: 'paymob' });
    await sql(`update organizations set onboarding = onboarding || '{"demo": true}' where id = $1`, [tenant.orgId]);
    expect(await svc.sendPurchase(tenant.orgId, demo.id)).toEqual({ skipped: 'not_configured' });
    expect(f.calls).toHaveLength(0);
    expect((await events(tenant.orgId)).map((e: any) => [e.status, e.skip_reason])).toEqual([['skipped', 'no_consent'], ['skipped', 'test_payment'], ['skipped', 'test_payment']]);
  });

  it('cash orders count when completed (through the outbox), or never when the restaurant chose so', async () => {
    const { tenant, menu, connectionId } = await tracked();
    const f = scriptedFetch([{ body: { events_received: 1 } }]);
    http.fetch = f.fetch;
    const o = await webOrder(tenant, menu);
    await consent(tenant, o.ref);
    expect(await svc.sendPurchase(tenant.orgId, o.id)).toEqual({ skipped: 'not_paid_yet' });
    for (const to of ['accepted', 'preparing', 'ready', 'picked_up']) {
      const r = await t.http.post(`/v1/o/${tenant.orgId}/orders/${o.id}/transition`).set(auth(tenant.owner)).send({ to });
      expect(r.status).toBe(201);
    }
    await t.app.get(EventDispatcher).drain();
    expect(f.calls).toHaveLength(1);
    expect(JSON.parse(f.calls[0]!.body!).data[0].event_id).toBe(purchaseEventId(o.ref));
    expect((await events(tenant.orgId))[0]).toMatchObject({ status: 'sent', summary: expect.objectContaining({ basis: 'cash_on_completion' }) });

    await sql(`update integration_connections set config = config || '{"codPurchase":"never"}' where id = $1`, [connectionId]);
    const never = await webOrder(tenant, menu);
    await consent(tenant, never.ref);
    await sql(`update orders set status = 'picked_up', fulfilled_at = now() where id = $1`, [never.id]);
    expect(await svc.sendPurchase(tenant.orgId, never.id)).toEqual({ skipped: 'cod_policy_never' });
    expect(f.calls).toHaveLength(1);
  });

  it('a Meta outage marks the event failed and throws so the outbox retries it with the same event id', async () => {
    const { tenant, menu } = await tracked();
    const o = await webOrder(tenant, menu, null);
    await consent(tenant, o.ref);
    await pay(tenant, o.id, { provider: 'moyasar' });
    const down = scriptedFetch([{ status: 503, body: { error: { message: 'Service temporarily unavailable', code: 2 } } }]);
    http.fetch = down.fetch;
    await expect(svc.sendPurchase(tenant.orgId, o.id)).rejects.toThrow(/will retry/);
    expect((await events(tenant.orgId))[0]).toMatchObject({ status: 'failed', attempts: 1 });
    const up = scriptedFetch([{ body: { events_received: 1 } }]);
    http.fetch = up.fetch;
    expect(await svc.sendPurchase(tenant.orgId, o.id)).toEqual({ sent: true, eventsReceived: 1 });
    expect(JSON.parse(down.calls[0]!.body!).data[0].event_id).toBe(JSON.parse(up.calls[0]!.body!).data[0].event_id);
    expect((await events(tenant.orgId))[0]).toMatchObject({ status: 'sent', attempts: 2 });
    // A definite refusal is final (no retry).
    const o2 = await webOrder(tenant, menu, null);
    await consent(tenant, o2.ref);
    await pay(tenant, o2.id, { provider: 'moyasar' });
    http.fetch = scriptedFetch([{ status: 400, body: { error: { message: 'Invalid OAuth access token', code: 190 } } }]).fetch;
    expect(await svc.sendPurchase(tenant.orgId, o2.id)).toEqual({ failed: expect.stringContaining('HTTP 400') });
  });

  it('a test connection sends every event with its Test Events code; the test button sends only synthetic data and only on test connections', async () => {
    const { tenant, menu, connectionId } = await tracked({ environment: 'sandbox', config: { testEventCode: 'TEST4242' } });
    const f = scriptedFetch([{ body: { events_received: 1, fbtrace_id: 'T1' } }]);
    http.fetch = f.fetch;
    const res = await t.http.post(`/v1/o/${tenant.orgId}/marketing/tracking/meta/test-event`).set(auth(tenant.owner)).set('User-Agent', UA);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ sent: true, eventsReceived: 1 });
    const body = JSON.parse(f.calls[0]!.body!);
    expect(body.test_event_code).toBe('TEST4242');
    expect(Object.keys(body.data[0].user_data).sort()).toEqual(['client_ip_address', 'client_user_agent', 'external_id']);
    expect(body.data[0].user_data.client_ip_address).toBe('203.0.113.10');

    const o = await webOrder(tenant, menu);
    await consent(tenant, o.ref);
    await pay(tenant, o.id, { provider: 'paymob' });
    await svc.sendPurchase(tenant.orgId, o.id);
    expect(JSON.parse(f.calls[1]!.body!).test_event_code).toBe('TEST4242');

    const diag = (await t.http.get(`/v1/o/${tenant.orgId}/marketing/tracking/meta`).set(auth(tenant.owner))).body;
    expect(diag.connection).toMatchObject({ id: connectionId, testMode: true, pixelId: '1234567890', hasTestEventCode: true, codPurchase: 'on_completion' });
    expect(diag.events.map((e: any) => [e.source, e.status, e.testMode])).toEqual([['order', 'sent', true], ['test', 'sent', true]]);
    expect(JSON.stringify(diag)).not.toContain('EAAG-capi-token');

    // The documented path to Live: a second connection is refused (one per org); the same connection switches in place.
    const second = await t.http.post(`/v1/o/${tenant.orgId}/integrations/connections`).set(auth(tenant.owner))
      .send({ provider: 'meta_capi', environment: 'live', credentials: { accessToken: 'EAAG-capi-token-654321' }, config: { pixelId: '1234567890' } });
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('connection_exists');
    const toLive = await t.http.patch(`/v1/o/${tenant.orgId}/integrations/connections/${connectionId}`).set(auth(tenant.owner)).send({ environment: 'live' });
    expect(toLive.status, JSON.stringify(toLive.body)).toBe(200);
    expect(toLive.body.environment).toBe('live');
    expect((await t.http.post(`/v1/o/${tenant.orgId}/marketing/tracking/meta/test-event`).set(auth(tenant.owner))).body.error.code).toBe('test_connection_required');
  });
});

describe('INT-22 custom audience dry run', () => {
  it('shows the hashed, consent-filtered upload plan and calls nothing', async () => {
    const tenant = await createTenant(t);
    const f = scriptedFetch([{ body: {} }]);
    http.fetch = f.fetch;
    const add = async (phone: string, email: string | null, consent: boolean) =>
      (await sql(`insert into customers(org_id, display_name, phone_e164, email, marketing_consent) values ($1, 'C', $2, $3, $4) returning id`, [tenant.orgId, phone, email, consent]))[0].id;
    const ids = [await add('+201001110001', 'One@x.co', true), await add('+201001110002', null, false), await add('+201001110003', 'three@x.co', true)];
    const [seg] = await sql(`insert into segments(org_id, name, definition, member_count) values ($1, 'Regulars', '{}', 3) returning id`, [tenant.orgId]);
    for (const id of ids) await sql(`insert into segment_members(org_id, segment_id, customer_id) values ($1, $2, $3)`, [tenant.orgId, seg.id, id]);
    const res = await t.http.post(`/v1/o/${tenant.orgId}/marketing/segments/${seg.id}/meta-audience/dry-run`).set(auth(tenant.owner));
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ dryRun: true, adAccountConnected: false, counts: { segment: 3, withConsent: 2, matchable: 2, excludedNoConsent: 1 },
      create: { path: 'act_<AD_ACCOUNT_ID>/customaudiences', body: { subtype: 'CUSTOM', customer_file_source: 'USER_PROVIDED_ONLY' } } });
    // Segment members come back in no guaranteed order; both consenting customers, hashed, and nothing else.
    expect(res.body.sample).toHaveLength(2);
    expect(res.body.sample).toEqual(expect.arrayContaining([[sha('one@x.co'), sha('201001110001')], [sha('three@x.co'), sha('201001110003')]]));
    expect(JSON.stringify(res.body)).not.toContain('x.co');
    expect(f.calls).toHaveLength(0);
  });
});
