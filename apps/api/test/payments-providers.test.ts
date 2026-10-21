// Real-provider payments through the REAL connection setup path (POST /integrations/connections + /health), the
// real webhook controller and the kernel ledger, with scripted provider HTTP (no credentials, no network).
// Covers the owner's required list for Stripe, Paymob and Moyasar (PAY-13) and the audit probes PS-01..PS-05 with
// their assertions inverted (they reproduced the defects before this workstream).
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TenantContext } from '../src/common/auth/context';
import { SecretBox } from '../src/common/crypto/secret-box';
import { DbService } from '../src/common/db/db.service';
import { OrdersKernelService } from '../src/modules/kernel/orders-kernel.service';
import { CHECKOUT_PORT, type CheckoutPort } from '../src/modules/kernel/ports';
import { PaymentProvidersService } from '../src/modules/payments/providers.service';
import { PaymentWebhooksService } from '../src/modules/payments/webhooks.service';
import { auth, bootTestApp, createTenant, seedMenu, sql, type SeededMenu, type TestApp, type TestTenant } from './helpers';
import { connect, inbox, paymobSignature, paymobTxn, scriptHealth, scriptProviders, stripeSignature, type Scripted } from './payments-fixtures';

let t: TestApp;
let db: DbService;
let orders: OrdersKernelService;
let port: CheckoutPort;
let s: Scripted;
const evt = () => `evt_${randomBytes(8).toString('hex')}`;

beforeAll(async () => {
  t = await bootTestApp();
  db = t.app.get(DbService);
  orders = t.app.get(OrdersKernelService);
  port = t.app.get(CHECKOUT_PORT);
  s = scriptProviders(t);
});
afterAll(async () => { await t.close(); });

async function tenantWithMenu(country: 'EG' | 'SA' = 'EG') {
  const tenant = await createTenant(t, { country });
  const menu = await seedMenu(tenant);
  const ctx = new TenantContext(tenant.orgId, 'owner', null, tenant.owner.userId, 'user', tenant.owner.userId);
  return { tenant, menu, ctx };
}
const placeOrder = (k: { tenant: TestTenant; menu: SeededMenu; ctx: TenantContext }, qty = 1) =>
  db.scoped(k.ctx, (tx) => orders.place(tx, k.ctx, { branchId: k.tenant.branchId, channel: 'staff', fulfillment: 'pickup', lines: [{ productId: k.menu.products.fries, quantity: qty }] } as any));
const link = (k: { ctx: TenantContext }, orderId: string, amountMinor?: number) =>
  db.scoped(k.ctx, (tx) => port.createSession(tx, k.ctx, { purpose: 'order', orderId, channel: 'web', ...(amountMinor ? { amountMinor } : {}) }));
const attemptOf = async (sessionId: string) =>
  (await sql(`select p.*, r.provider_session_id from payments p join payment_attempt_refs r on r.payment_id = p.id where p.checkout_session_id = $1 order by p.created_at desc limit 1`, [sessionId]))[0];
const orderRow = async (id: string) => (await sql(`select paid_minor, refunded_minor, payment_status from orders where id = $1`, [id]))[0];

// ---------------------------------------------------------------------------
describe('activation through the integrations API (INT-04, INT-05, INT-06, INT-18, PS-01 inverted)', () => {
  it('Stripe: test keys only on a test connection, health records the account, sealed credentials are usable', async () => {
    s.reset(); scriptHealth(s);
    const k = await tenantWithMenu();
    const post = (body: Record<string, unknown>) => t.http.post(`/v1/o/${k.tenant.orgId}/integrations/connections`).set(auth(k.tenant.owner)).send(body);
    // Fail closed on mixed environments (PAY-02, INT-08).
    const liveOnTest = await post({ provider: 'stripe', environment: 'sandbox', credentials: { secretKey: 'sk_live_abc', webhookSecret: 'whsec_abc' } });
    expect(liveOnTest.status).toBe(422);
    expect(liveOnTest.body.error.code).toBe('credential_environment_mismatch');
    const testOnLive = await post({ provider: 'stripe', environment: 'live', credentials: { secretKey: 'sk_test_abc', webhookSecret: 'whsec_abc' } });
    expect(testOnLive.body.error.code).toBe('credential_environment_mismatch');
    const badFormat = await post({ provider: 'stripe', credentials: { secretKey: 'not-a-key', webhookSecret: 'whsec_abc' } });
    expect(badFormat.body.error.code).toBe('invalid_fields');
    const missing = await post({ provider: 'stripe', credentials: { secretKey: 'sk_test_abc' } });
    expect(missing.body.error.code).toBe('missing_fields');

    const c = await connect(t, k.tenant, 'stripe', { secretKey: 'sk_test_olive', webhookSecret: 'whsec_olive' });
    expect(c.created).toMatchObject({ status: 'pending', environment: 'sandbox' }); // the default environment is TEST
    expect(c.health).toMatchObject({ status: 'connected', account: { id: 'acct_test_olive', name: 'Olive Room', country: 'AE' }, lastFailureAt: null });
    expect(c.health.lastSuccessAt).toBeTruthy();
    expect(c.health.webhook).toEqual({
      url: `http://api.test/v1/webhooks/payments/stripe?c=${c.id}`, registeredByMerchant: true,
      events: expect.arrayContaining(['checkout.session.completed', 'checkout.session.expired', 'charge.refunded', 'charge.dispute.created']),
    });
    const call = s.calls.find((x) => x.url === 'https://api.stripe.com/v1/account')!;
    expect(call.headers.authorization).toBe('Bearer sk_test_olive');
    expect(call.headers['stripe-version']).toBe('2026-09-30.endive');
    // Sealed with the tenant AAD and readable by ResutoPay (INT-04).
    const [row] = await sql(`select credentials_encrypted as c from integration_connections where id = $1`, [c.id]);
    const box = t.app.get(SecretBox);
    expect(() => box.openJson(row.c)).toThrow();
    expect((await t.app.get(PaymentProvidersService).credentials(k.tenant.orgId, c.id))?.credentials).toEqual({ secretKey: 'sk_test_olive', webhookSecret: 'whsec_olive' });
    // Switching to live without live keys is refused; the catalog shows Stripe blocked for an Egyptian business.
    const sw = await t.http.patch(`/v1/o/${k.tenant.orgId}/integrations/connections/${c.id}`).set(auth(k.tenant.owner)).send({ environment: 'live' });
    expect(sw.body.error.code).toBe('credentials_required');
    const cat = await t.http.get(`/v1/o/${k.tenant.orgId}/integrations/catalog`).set(auth(k.tenant.owner));
    const stripe = cat.body.items.find((i: any) => i.id === 'stripe');
    expect(stripe.readinessDetail).toMatchObject({ summary: 'blocked_by_provider', configured: true, restriction: { country: 'EG', source: 'https://stripe.com/global' } });
    expect(stripe.fields.credentials.map((f: any) => f.key)).toEqual(['secretKey', 'webhookSecret']);
  });

  it('a health check that reaches the provider with a bad key leaves the connection in error with redacted diagnostics', async () => {
    s.reset();
    s.on('GET', 'https://api.stripe.com/v1/account', () => ({ status: 401, body: { error: { message: 'Invalid API Key provided: sk_test_****wxyz for owner@example.com' } } }));
    const k = await tenantWithMenu();
    const c = await connect(t, k.tenant, 'stripe', { secretKey: 'sk_test_wrongwxyz', webhookSecret: 'whsec_x' });
    expect(c.health.status).toBe('error');
    expect(c.health.lastError).toBe('stripe: HTTP 401');
    expect(JSON.stringify(c.health)).not.toMatch(/owner@example|sk_test_\*/);
    expect(c.health.health.error).toMatchObject({ code: 'http_401', status: 401, retryable: false });
    expect(c.health.lastFailureAt).toBeTruthy();
    expect(c.health.lastSuccessAt).toBeNull();
  });

  it('Paymob requires the API key, mode-specific keys and numeric integration ids; Moyasar requires sk_test_ on a test connection', async () => {
    s.reset(); scriptHealth(s);
    const k = await tenantWithMenu();
    const post = (provider: string, credentials: Record<string, string>, config: Record<string, unknown> = {}, environment = 'sandbox') =>
      t.http.post(`/v1/o/${k.tenant.orgId}/integrations/connections`).set(auth(k.tenant.owner)).send({ provider, environment, credentials, config });
    const creds = { secretKey: 'egy_sk_test_olive', publicKey: 'egy_pk_test_olive', hmacSecret: 'HMACSECRET', apiKey: 'ZXlK.api' };
    expect((await post('paymob', creds, {})).body.error).toMatchObject({ code: 'missing_fields', details: { missing: ['integrationIdCard'] } });
    expect((await post('paymob', { ...creds, apiKey: '' }, { integrationIdCard: 4520 })).status).toBe(400); // empty values fail the contract
    expect((await post('paymob', creds, { integrationIdCard: 'abc' })).body.error.code).toBe('invalid_fields');
    expect((await post('paymob', creds, { integrationIdCard: 4520, baseUrl: 'https://evil.example' })).body.error.code).toBe('invalid_fields');
    expect((await post('paymob', { ...creds, publicKey: 'egy_pk_live_olive' }, { integrationIdCard: 4520 })).body.error.code).toBe('credential_environment_unknown');
    const pm = await connect(t, k.tenant, 'paymob', creds, { integrationIdCard: 4520 });
    expect(pm.health).toMatchObject({ status: 'connected', account: { id: '4242', name: 'Olive Room EG' }, webhook: { url: `http://api.test/v1/webhooks/payments/paymob?c=${pm.id}`, registeredByMerchant: false } });
    const sa = await tenantWithMenu('SA');
    const moyLive = await t.http.post(`/v1/o/${sa.tenant.orgId}/integrations/connections`).set(auth(sa.tenant.owner))
      .send({ provider: 'moyasar', environment: 'sandbox', credentials: { secretKey: 'sk_live_moy', webhookSecret: 'token-123' } });
    expect(moyLive.body.error.code).toBe('credential_environment_mismatch');
    const moy = await connect(t, sa.tenant, 'moyasar', { secretKey: 'sk_test_moy', webhookSecret: 'token-123' });
    expect(moy.health.status).toBe('connected');
  });

  it('a disabled payment connection is never offered for new checkouts (INT-07)', async () => {
    s.reset(); scriptHealth(s);
    const k = await tenantWithMenu();
    const c = await connect(t, k.tenant, 'stripe', { secretKey: 'sk_test_en', webhookSecret: 'whsec_en' });
    const order = await placeOrder(k);
    const view = async () => (await t.http.get(`/v1/public/pay/${(await link(k, order.id)).token}`)).body.methods.find((m: any) => m.method === 'card');
    expect((await view()).provider).toBe('stripe');
    await t.http.post(`/v1/o/${k.tenant.orgId}/integrations/connections/${c.id}/disable`).set(auth(k.tenant.owner)).expect(200);
    expect((await view()).provider).toBe('simulated');
  });
});

// ---------------------------------------------------------------------------
describe('Stripe webhooks through the real controller', () => {
  let k: Awaited<ReturnType<typeof tenantWithMenu>>;
  let conn: string;
  const secret = 'whsec_stripeflow';
  const send = (raw: string, sig: string | null, c: string | null = conn) =>
    t.http.post(`/v1/webhooks/payments/stripe${c ? `?c=${c}` : ''}`).set({ 'content-type': 'application/json', ...(sig ? { 'stripe-signature': sig } : {}) }).send(raw);
  const completed = (sessionId: string, amount: number, extra: Record<string, unknown> = {}, object: Record<string, unknown> = {}) => JSON.stringify({
    id: evt(), type: 'checkout.session.completed', livemode: false, ...extra,
    data: { object: { id: sessionId, amount_total: amount, currency: 'egp', payment_status: 'paid', payment_intent: `pi_${sessionId}`, ...object } },
  });
  async function startStripe(amountMinor?: number) {
    const order = await placeOrder(k, 2);
    const session = await link(k, order.id, amountMinor);
    const csId = `cs_test_${randomBytes(6).toString('hex')}`;
    s.on('POST', 'https://api.stripe.com/v1/checkout/sessions', (c) => (c.url.endsWith('/sessions') ? { body: { id: csId, url: `https://checkout.stripe.com/c/pay/${csId}`, livemode: false } } : undefined));
    const start = await t.http.post(`/v1/public/pay/${session.token}/start`).send({ method: 'card' });
    expect(start.status, JSON.stringify(start.body)).toBe(200);
    expect(start.body.redirectUrl).toBe(`https://checkout.stripe.com/c/pay/${csId}`);
    return { order, session, csId, payment: await attemptOf(session.id) };
  }

  /** Stripe's payment intent as read with the merchant key when a refund event is confirmed (metadata set at checkout). */
  const scriptPaymentIntent = (pi: string, paymentId: string, amount: number, refunded: number) =>
    s.on('GET', `https://api.stripe.com/v1/payment_intents/${pi}`, () => ({ body: { id: pi, amount, currency: 'egp', livemode: false,
      metadata: { resuto_payment_id: paymentId }, latest_charge: { id: `ch_${pi}`, amount_refunded: refunded } } }));

  beforeAll(async () => {
    s.reset(); scriptHealth(s);
    k = await tenantWithMenu();
    conn = (await connect(t, k.tenant, 'stripe', { secretKey: 'sk_test_flow', webhookSecret: secret })).id;
  });

  it('applies a valid signed completion once; duplicates, tampering, wrong/missing/malformed signatures never apply', async () => {
    const { order, csId, payment } = await startStripe();
    const body = s.calls.filter((c) => c.url === 'https://api.stripe.com/v1/checkout/sessions').at(-1)!;
    expect(new URLSearchParams(body.body!).get('allowed_payment_method_types[0]')).toBe('card');
    expect(body.headers['stripe-version']).toBe('2026-09-30.endive');
    const raw = completed(csId, order.totalMinor, {}, { client_reference_id: payment.id });
    expect((await send(raw, stripeSignature('whsec_wrong', raw))).status).toBe(401);
    expect((await send(raw, null)).status).toBe(401);
    expect((await send(raw, `t=${Math.floor(Date.now() / 1000)},v1=zz`)).status).toBe(401);
    expect((await send(raw.replace(`"amount_total":${order.totalMinor}`, '"amount_total":1'), stripeSignature(secret, raw))).status).toBe(401);
    expect((await send('not json at all', stripeSignature(secret, 'not json at all'))).status).toBe(400); // refused by the body parser
    expect((await orderRow(order.id)).paid_minor).toBe(0);
    const ok = await send(raw, stripeSignature(secret, raw));
    expect(ok.body).toEqual({ received: true, outcome: 'applied' });
    expect((await send(raw, stripeSignature(secret, raw))).body).toEqual({ received: true, duplicate: true });
    expect(await orderRow(order.id)).toMatchObject({ paid_minor: order.totalMinor, payment_status: 'paid' });
    const rows = await inbox('stripe', k.tenant.orgId);
    expect(rows.filter((r) => r.status === 'rejected').every((r) => Object.keys(r.payload).sort().join() === 'bytes,excerpt,reason,sha256')).toBe(true);
    const [conn1] = await sql(`select last_webhook_at from integration_connections where id = $1`, [conn]);
    expect(conn1.last_webhook_at).toBeTruthy();
  });

  it('refuses test/live confusion: a livemode:true event on a test connection is alerted, never applied', async () => {
    const { order, csId } = await startStripe();
    const raw = completed(csId, order.totalMinor, { livemode: true });
    const res = await send(raw, stripeSignature(secret, raw));
    expect(res.body.outcome).toBe('environment_mismatch');
    expect((await orderRow(order.id)).paid_minor).toBe(0);
    const [alert] = await sql(`select kind from payment_alerts where org_id = $1 and kind = 'environment_mismatch' order by created_at desc limit 1`, [k.tenant.orgId]);
    expect(alert.kind).toBe('environment_mismatch');
    // An event without livemode is malformed (Stripe always sends it).
    const noMode = JSON.stringify({ ...JSON.parse(raw), id: evt(), livemode: undefined });
    expect((await send(noMode, stripeSignature(secret, noMode))).status).toBe(401);
  });

  it('wrong amount, wrong currency, unknown session and another connection\'s payment are never applied (PS-05 inverted)', async () => {
    const a = await startStripe();
    const short = completed(a.csId, a.order.totalMinor - 1);
    expect((await send(short, stripeSignature(secret, short))).body.outcome).toBe('amount_mismatch');
    const b = await startStripe();
    const usd = JSON.stringify({ ...JSON.parse(completed(b.csId, b.order.totalMinor)), data: { object: { id: b.csId, amount_total: b.order.totalMinor, currency: 'usd', payment_status: 'paid', payment_intent: 'pi_usd' } } });
    expect((await send(usd, stripeSignature(secret, usd))).body.outcome).toBe('amount_mismatch');
    const unknown = completed('cs_test_unknown', 100);
    expect((await send(unknown, stripeSignature(secret, unknown))).body.outcome).toBe('unmatched');
    // A second Stripe connection (branch B) verifies its own event, which names A's session: never settles A's payment.
    const [b2] = await sql(`insert into branches(org_id, code, name) values ($1, $2, 'Branch B') returning id`, [k.tenant.orgId, `b-${randomBytes(3).toString('hex')}`]);
    const other = await t.http.post(`/v1/o/${k.tenant.orgId}/integrations/connections`).set(auth(k.tenant.owner))
      .send({ provider: 'stripe', branchId: b2.id, credentials: { secretKey: 'sk_test_other', webhookSecret: 'whsec_other' } });
    expect(other.status, JSON.stringify(other.body)).toBe(201);
    await t.http.post(`/v1/o/${k.tenant.orgId}/integrations/connections/${other.body.id}/health`).set(auth(k.tenant.owner));
    const c = await startStripe();
    const cross = completed(c.csId, c.order.totalMinor);
    const res = await send(cross, stripeSignature('whsec_other', cross), other.body.id);
    expect(res.body.outcome).toBe('unmatched');
    expect((await sql(`select status from payments where id = $1`, [c.payment.id]))[0].status).toBe('pending');
    // ?c= naming another tenant's connection cannot verify with this merchant's secret.
    const foreign = await tenantWithMenu();
    const fconn = await connect(t, foreign.tenant, 'stripe', { secretKey: 'sk_test_foreign', webhookSecret: 'whsec_foreign' });
    expect((await send(cross, stripeSignature(secret, cross), fconn.id)).status).toBe(401);
  });

  it('a refund, a dispute and a late (older) success arriving after the refund keep the ledger right (PAY-11)', async () => {
    const { order, csId, payment } = await startStripe();
    const paid = completed(csId, order.totalMinor);
    expect((await send(paid, stripeSignature(secret, paid))).body.outcome).toBe('applied');
    // The body's cumulative amount is not trusted: the payment intent read with the merchant key says 1000.
    scriptPaymentIntent(`pi_${csId}`, payment.id, order.totalMinor, 1000);
    const refunded = JSON.stringify({ id: evt(), type: 'charge.refunded', livemode: false, data: { object: { id: 'ch_1', payment_intent: `pi_${csId}`, amount: order.totalMinor, amount_refunded: order.totalMinor, currency: 'egp' } } });
    expect((await send(refunded, stripeSignature(secret, refunded))).body.outcome).toBe('refund_applied');
    expect(await orderRow(order.id)).toMatchObject({ refunded_minor: 1000, payment_status: 'partially_refunded' });
    const [r] = await sql(`select status, source, amount_minor from refunds where payment_id = $1`, [payment.id]);
    expect(r).toEqual({ status: 'succeeded', source: 'provider', amount_minor: 1000 });
    // The same cumulative total again (redelivery under another event id) is a no-op.
    const again = JSON.stringify({ ...JSON.parse(refunded), id: evt() });
    expect((await send(again, stripeSignature(secret, again))).body.outcome).toBe('already_settled');
    // An older success delivered late never re-settles over the refund.
    const late = JSON.stringify({ ...JSON.parse(paid), id: evt() });
    expect((await send(late, stripeSignature(secret, late))).body.outcome).toBe('already_settled');
    expect((await sql(`select status, refunded_minor from payments where id = $1`, [payment.id]))[0]).toEqual({ status: 'partially_refunded', refunded_minor: 1000 });
    const dispute = JSON.stringify({ id: evt(), type: 'charge.dispute.created', livemode: false, data: { object: { id: 'dp_1', payment_intent: `pi_${csId}`, amount: 500, currency: 'egp', status: 'needs_response' } } });
    expect((await send(dispute, stripeSignature(secret, dispute))).body.outcome).toBe('dispute_recorded');
    const [d] = await sql(`select kind, details from payment_alerts where payment_id = $1 and kind = 'dispute'`, [payment.id]);
    expect(d.details).toMatchObject({ disputeId: 'dp_1', opened: true });
  });

  it('a refund delivered BEFORE the success it reverses is retried, then applied once the success lands (reordered delivery)', async () => {
    const { order, csId, payment } = await startStripe();
    scriptPaymentIntent(`pi_${csId}`, payment.id, order.totalMinor, 700);
    const refunded = JSON.stringify({ id: evt(), type: 'charge.refunded', livemode: false, data: { object: { id: 'ch_r', payment_intent: `pi_${csId}`, amount: order.totalMinor, amount_refunded: 700, currency: 'egp' } } });
    const early = await send(refunded, stripeSignature(secret, refunded));
    expect(early.status).toBe(503); // the provider retries; nothing was applied
    expect((await sql(`select status, refunded_minor from payments where id = $1`, [payment.id]))[0]).toEqual({ status: 'pending', refunded_minor: 0 });
    const paid = completed(csId, order.totalMinor);
    expect((await send(paid, stripeSignature(secret, paid))).body.outcome).toBe('applied');
    // The inbox worker (or the provider's retry) now applies the refund exactly once.
    await t.app.get(PaymentWebhooksService).retryPending();
    expect((await send(refunded, stripeSignature(secret, refunded))).body).toEqual({ received: true, duplicate: true });
    expect((await sql(`select status, refunded_minor from payments where id = $1`, [payment.id]))[0]).toEqual({ status: 'partially_refunded', refunded_minor: 700 });
  });

  it('failure after success and expiry after success never undo a settled payment', async () => {
    const { order, csId } = await startStripe();
    const paid = completed(csId, order.totalMinor);
    await send(paid, stripeSignature(secret, paid));
    const failed = JSON.stringify({ id: evt(), type: 'checkout.session.async_payment_failed', livemode: false, data: { object: { id: csId, amount_total: order.totalMinor, currency: 'egp' } } });
    expect((await send(failed, stripeSignature(secret, failed))).body.outcome).toBe('ignored');
    const expired = JSON.stringify({ id: evt(), type: 'checkout.session.expired', livemode: false, data: { object: { id: csId, amount_total: order.totalMinor, currency: 'egp' } } });
    expect((await send(expired, stripeSignature(secret, expired))).body.outcome).toBe('ignored');
    expect((await orderRow(order.id)).payment_status).toBe('paid');
  });

  it('superseding an attempt expires the Stripe session at the provider first (PAY-08)', async () => {
    const { session, csId, payment } = await startStripe();
    s.on('POST', `https://api.stripe.com/v1/checkout/sessions/${csId}/expire`, () => ({ body: { id: csId, status: 'expired' } }));
    s.on('GET', `https://api.stripe.com/v1/checkout/sessions/${csId}`, () => ({ body: { id: csId, status: 'expired', livemode: false, amount_total: payment.amount_minor, currency: 'egp' } }));
    await sql(`update payments set created_at = now() - interval '30 minutes' where id = $1`, [payment.id]); // stale: a new session is created
    s.on('POST', 'https://api.stripe.com/v1/checkout/sessions', (c) => (c.url.endsWith('/sessions') ? { body: { id: `${csId}_2`, url: `https://checkout.stripe.com/c/pay/${csId}_2`, livemode: false } } : undefined));
    const again = await t.http.post(`/v1/public/pay/${session.token}/start`).send({ method: 'card' });
    expect(again.status, JSON.stringify(again.body)).toBe(200);
    expect(s.calls.some((c) => c.method === 'POST' && c.url.endsWith(`/v1/checkout/sessions/${csId}/expire`))).toBe(true);
    const [old] = await sql(`select status, failure_reason, raw->'providerCancel'->>'result' as cancel from payments where id = $1`, [payment.id]);
    expect(old.cancel).toBe('cancelled');
    expect(['cancelled', 'expired']).toContain(old.status);
  });

  it('a provider error at checkout shows guests a fixed code, never the provider\'s text (PAY-20)', async () => {
    const order = await placeOrder(k);
    const session = await link(k, order.id);
    s.on('POST', 'https://api.stripe.com/v1/checkout/sessions', () => ({ status: 400, body: { error: { message: 'Internal detail: account acct_secret_123 restricted' } } }));
    const start = await t.http.post(`/v1/public/pay/${session.token}/start`).send({ method: 'card' });
    expect(start.status).toBe(502);
    expect(start.body.error.code).toBe('provider_unavailable');
    const view = await t.http.get(`/v1/public/pay/${session.token}`);
    expect(view.body.attempt.failureReason).toBe('provider_unavailable');
    expect(JSON.stringify(view.body)).not.toContain('acct_secret_123');
    const [p] = await sql(`select raw->>'providerError' as e from payments where checkout_session_id = $1`, [session.id]);
    expect(p.e).toContain('HTTP 400'); // kept for staff
  });
});

// ---------------------------------------------------------------------------
describe('Paymob callbacks through the real controller', () => {
  let k: Awaited<ReturnType<typeof tenantWithMenu>>;
  let conn: string;
  const hmacSecret = 'PAYMOB_FLOW_HMAC';
  const integrationId = 4520;
  const send = (obj: any, hmac = paymobSignature(hmacSecret, obj)) =>
    t.http.post(`/v1/webhooks/payments/paymob?c=${conn}&hmac=${hmac}`).set('content-type', 'application/json').send(JSON.stringify({ type: 'TRANSACTION', obj }));
  async function startPaymob() {
    const order = await placeOrder(k);
    const session = await link(k, order.id);
    const orderId = Math.floor(Math.random() * 1e8);
    s.on('POST', 'https://accept.paymob.com/v1/intention/', () => ({ body: { id: 'int_x', client_secret: 'egy_csk_test_x', intention_order_id: orderId } }));
    const start = await t.http.post(`/v1/public/pay/${session.token}/start`).send({ method: 'card' });
    expect(start.status, JSON.stringify(start.body)).toBe(200);
    expect(start.body.redirectUrl).toMatch(/^https:\/\/accept\.paymob\.com\/unifiedcheckout\/\?publicKey=egy_pk_test_flow&clientSecret=egy_csk_test_x$/);
    return { order, session, orderId, payment: await attemptOf(session.id) };
  }

  beforeAll(async () => {
    s.reset(); scriptHealth(s);
    k = await tenantWithMenu();
    conn = (await connect(t, k.tenant, 'paymob', { secretKey: 'egy_sk_test_flow', publicKey: 'egy_pk_test_flow', hmacSecret, apiKey: 'api-key' },
      { integrationIdCard: integrationId })).id;
  });

  it('a signed transaction cannot be replayed onto another payment through unsigned merchant_order_id (PS-02 inverted)', async () => {
    const p1 = await startPaymob();
    const p2 = await startPaymob();
    const signedForP1 = paymobTxn({ orderId: p1.orderId, amount: p1.order.totalMinor, integrationId, order: { id: p1.orderId, merchant_order_id: p1.payment.id } });
    const hmac = paymobSignature(hmacSecret, signedForP1);
    const forged = { ...signedForP1, order: { id: p1.orderId, merchant_order_id: p2.payment.id } };
    const res = await send(forged, hmac);
    expect(res.status).toBe(200);
    expect(res.body.outcome).toBe('reference_mismatch');
    const rows = await sql(`select id, status from payments where id = any($1::uuid[])`, [[p1.payment.id, p2.payment.id]]);
    expect(Object.fromEntries(rows.map((r) => [r.id, r.status]))).toEqual({ [p1.payment.id]: 'pending', [p2.payment.id]: 'pending' });
    // The genuine delivery is not pre-empted by the forged variant's event key.
    expect((await send(signedForP1, hmac)).body.outcome).toBe('applied');
    expect((await orderRow(p1.order.id)).payment_status).toBe('paid');
    expect((await orderRow(p2.order.id)).payment_status).toBe('unpaid');
  });

  it('accepts upper-case hex, rejects malformed/missing/wrong HMACs and bodies, and ignores other integrations', async () => {
    const p = await startPaymob();
    const obj = paymobTxn({ orderId: p.orderId, amount: p.order.totalMinor, integrationId });
    expect((await send(obj, 'abc')).status).toBe(401);
    expect((await send(obj, paymobSignature('wrong', obj))).status).toBe(401);
    expect((await t.http.post(`/v1/webhooks/payments/paymob?c=${conn}`).set('content-type', 'application/json').send(JSON.stringify({ obj }))).status).toBe(401);
    // Malformed JSON is refused by the body parser (400) before anything is verified or stored.
    expect((await t.http.post(`/v1/webhooks/payments/paymob?c=${conn}&hmac=${paymobSignature(hmacSecret, obj)}`).set('content-type', 'application/json').send('{"obj":')).status).toBe(400);
    const tampered = { ...obj, amount_cents: 1 };
    expect((await send(tampered, paymobSignature(hmacSecret, obj))).status).toBe(401);
    const otherIntegration = { ...obj, id: obj.id + 1, integration_id: 9999 };
    expect((await send(otherIntegration)).body.outcome).toBe('ignored');
    expect((await send(obj, paymobSignature(hmacSecret, obj).toUpperCase())).body.outcome).toBe('applied');
  });

  it('a decline followed by a success in the same Paymob checkout is applied (PS-03 inverted, PAY-07)', async () => {
    const p = await startPaymob();
    const base = { orderId: p.orderId, amount: p.order.totalMinor, integrationId };
    const declined = await send(paymobTxn({ ...base, success: false, data: { message: 'Do not honour' } }));
    expect(declined.body.outcome).toBe('decline_recorded');
    const view = await t.http.get(`/v1/public/pay/${p.session.token}`);
    expect(view.body.attempt).toMatchObject({ status: 'pending', failureReason: 'declined' });
    expect(JSON.stringify(view.body)).not.toContain('Do not honour');
    expect((await send(paymobTxn(base))).body.outcome).toBe('applied');
    expect((await orderRow(p.order.id)).payment_status).toBe('paid');
  });

  it('auth-only is recorded and alerted, never settled; a refund callback is applied only after the authenticated inquiry', async () => {
    const a = await startPaymob();
    const auth1 = await send(paymobTxn({ orderId: a.orderId, amount: a.order.totalMinor, integrationId, is_auth: true }));
    expect(auth1.body.outcome).toBe('authorized_recorded');
    expect((await orderRow(a.order.id)).paid_minor).toBe(0);
    expect((await sql(`select kind from payment_alerts where payment_id = $1`, [a.payment.id])).map((r) => r.kind)).toContain('auth_only');

    const b = await startPaymob();
    const txn = paymobTxn({ orderId: b.orderId, amount: b.order.totalMinor, integrationId });
    await send(txn);
    // The callback claims a refund of the whole amount (refunded_amount_cents is unsigned); the inquiry says 500.
    s.on('POST', 'https://accept.paymob.com/api/ecommerce/orders/transaction_inquiry', () => ({
      body: { ...txn, is_refunded: true, refunded_amount_cents: 500, is_live: false, order: { id: b.orderId, merchant_order_id: b.payment.id } } }));
    const refundCb = { ...txn, id: txn.id + 7, is_refunded: true, has_parent_transaction: true, refunded_amount_cents: b.order.totalMinor };
    expect((await send(refundCb)).body.outcome).toBe('refund_applied');
    expect((await orderRow(b.order.id)).refunded_minor).toBe(500);
    const inquiry = s.calls.filter((c) => c.url.endsWith('/transaction_inquiry')).at(-1)!;
    expect(inquiry.headers.authorization).toBe('Bearer pm-auth-token');
  });

  it('concurrent duplicate deliveries settle once', async () => {
    const p = await startPaymob();
    const obj = paymobTxn({ orderId: p.orderId, amount: p.order.totalMinor, integrationId });
    const results = await Promise.all([send(obj), send(obj), send(obj)]);
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(results.filter((r) => r.body.outcome === 'applied')).toHaveLength(1);
    const [alloc] = await sql(`select sum(amount_minor)::int as s from payment_allocations where order_id = $1`, [p.order.id]);
    expect(alloc.s).toBe(p.order.totalMinor);
  });
});

// ---------------------------------------------------------------------------
describe('Moyasar webhooks: secret_token is a hint, the fetched payment decides (PS-04 inverted, PAY-04, PAY-16)', () => {
  let k: Awaited<ReturnType<typeof tenantWithMenu>>;
  let conn: string;
  const token = `moy_${randomBytes(12).toString('hex')}`;
  const hook = (type: string, data: Record<string, unknown>, secretToken = token, extra: Record<string, unknown> = {}) => JSON.stringify({
    id: evt(), type, created_at: new Date().toISOString(), secret_token: secretToken, account_name: 'Olive Riyadh', live: false, data, ...extra,
  });
  const send = (raw: string) => t.http.post(`/v1/webhooks/payments/moyasar?c=${conn}`).set('content-type', 'application/json').send(raw);
  async function startMoyasar() {
    const order = await placeOrder(k, 3);
    const session = await link(k, order.id);
    const inv = `inv_${randomBytes(6).toString('hex')}`;
    s.on('POST', 'https://api.moyasar.com/v1/invoices', () => ({ body: { id: inv, status: 'initiated', url: `https://checkout.moyasar.com/invoices/${inv}?lang=ar` } }));
    const start = await t.http.post(`/v1/public/pay/${session.token}/start`).send({ method: 'card' });
    expect(start.status, JSON.stringify(start.body)).toBe(200);
    const sent = JSON.parse(s.calls.filter((c) => c.url === 'https://api.moyasar.com/v1/invoices').at(-1)!.body!);
    expect(sent.callback_url).toBe(`http://api.test/v1/public/pay/${session.token}/nudge`);
    return { order, session, inv, payment: await attemptOf(session.id) };
  }
  const fetched = (id: string, p: Record<string, unknown>) => s.on('GET', `https://api.moyasar.com/v1/payments/${id}`, () => ({ body: { id, ...p } }));

  beforeAll(async () => {
    s.reset(); scriptHealth(s);
    k = await tenantWithMenu('SA');
    conn = (await connect(t, k.tenant, 'moyasar', { secretKey: 'sk_test_moyflow', webhookSecret: token })).id;
  });

  it('applies only the payment fetched with the merchant key and never stores the token', async () => {
    const { order, inv, payment } = await startMoyasar();
    fetched('pay_m1', { status: 'paid', amount: order.totalMinor, currency: 'SAR', invoice_id: inv, metadata: {} });
    // The body claims a different amount; the fetched payment wins.
    const res = await send(hook('payment_paid', { id: 'pay_m1', status: 'paid', amount: 1, currency: 'SAR', invoice_id: inv }));
    expect(res.body.outcome).toBe('applied');
    expect((await orderRow(order.id)).payment_status).toBe('paid');
    const get = s.calls.filter((c) => c.url === 'https://api.moyasar.com/v1/payments/pay_m1').at(-1)!;
    expect(get.headers.authorization).toBe(`Basic ${Buffer.from('sk_test_moyflow:').toString('base64')}`);
    const stored = await inbox('moyasar', k.tenant.orgId);
    expect(JSON.stringify(stored)).not.toContain(token);
    expect((await sql(`select status from payments where id = $1`, [payment.id]))[0].status).toBe('succeeded');
    // A wrong token is rejected and the rejected excerpt does not keep the token either.
    const bad = await send(hook('payment_paid', { id: 'pay_m1', invoice_id: inv }, `${token}x`));
    expect(bad.status).toBe(401);
    expect(JSON.stringify(await inbox('moyasar', k.tenant.orgId))).not.toContain(token);
  });

  it('a forged "paid" with the right token is not applied when the provider says failed; both failure spellings are accepted', async () => {
    const { order, inv } = await startMoyasar();
    fetched('pay_m2', { status: 'failed', amount: order.totalMinor, currency: 'SAR', invoice_id: inv, source: { message: 'INSUFFICIENT_FUNDS' } });
    expect((await send(hook('payment_paid', { id: 'pay_m2', status: 'paid', invoice_id: inv }))).body.outcome).toBe('decline_recorded');
    expect((await send(hook('payment_faild', { id: 'pay_m2', invoice_id: inv }))).body.outcome).toBe('decline_recorded');
    expect((await orderRow(order.id)).paid_minor).toBe(0);
    // The amount is checked on the fetched payment.
    const b = await startMoyasar();
    fetched('pay_m3', { status: 'paid', amount: b.order.totalMinor - 100, currency: 'SAR', invoice_id: b.inv });
    expect((await send(hook('payment_paid', { id: 'pay_m3', invoice_id: b.inv }))).body.outcome).toBe('amount_mismatch');
  });

  it('a live:true webhook on a test connection is refused before any fetch; the unsigned invoice callback only triggers a status query', async () => {
    const { order, inv, session } = await startMoyasar();
    const before = s.calls.length;
    const res = await send(hook('payment_paid', { id: 'pay_m4', invoice_id: inv }, token, { live: true }));
    expect(res.body.outcome).toBe('ignored');
    expect(s.calls.slice(before).some((c) => c.url.includes('/payments/pay_m4'))).toBe(false);
    expect((await sql(`select kind from payment_alerts where org_id = $1 and kind = 'environment_mismatch'`, [k.tenant.orgId])).length).toBeGreaterThan(0);
    // Moyasar's callback_url POST (unsigned invoice object) → server-side GET /invoices/:id with the merchant key.
    s.on('GET', `https://api.moyasar.com/v1/invoices/${inv}`, () => ({ body: { id: inv, status: 'paid', amount: order.totalMinor, currency: 'SAR',
      payments: [{ id: 'pay_m5', status: 'paid', amount: order.totalMinor, currency: 'SAR' }] } }));
    const nudge = await t.http.post(`/v1/public/pay/${session.token}/nudge`).send({ id: inv, status: 'paid', amount: 1 });
    expect(nudge.body).toEqual({ received: true });
    expect((await orderRow(order.id)).payment_status).toBe('paid');
    expect((await t.http.post('/v1/public/pay/not-a-real-token-at-all-xx/nudge').send({})).body).toEqual({ received: true });
  });
});
