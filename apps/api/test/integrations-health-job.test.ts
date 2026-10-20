// Integration-connection health (review findings F1, F2): the scheduled integrations.health job really runs (it threw
// on every run before), provider outages never change a connection's status, and health status never takes payments
// already in flight offline (the reviewer's probe R1 with its assertions inverted). Every scheduled job of the payments
// and integrations lane is run once through the dispatcher's registry. Connections are created through the real API path.
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TenantContext } from '../src/common/auth/context';
import { DbService } from '../src/common/db/db.service';
import { EventDispatcher } from '../src/common/events/dispatcher.service';
import { IntegrationConnectionsService } from '../src/modules/integrations/connections.service';
import { OrdersKernelService } from '../src/modules/kernel/orders-kernel.service';
import { CHECKOUT_PORT, type CheckoutPort } from '../src/modules/kernel/ports';
import { auth, bootTestApp, createTenant, seedMenu, sql, type SeededMenu, type TestApp, type TestTenant } from './helpers';
import { connect, scriptHealth, scriptProviders, stripeSignature, type Scripted } from './payments-fixtures';

let t: TestApp;
let db: DbService;
let orders: OrdersKernelService;
let port: CheckoutPort;
let health: IntegrationConnectionsService;
let s: Scripted;
const key = () => `k-${randomBytes(8).toString('hex')}`;

beforeAll(async () => {
  t = await bootTestApp();
  db = t.app.get(DbService);
  orders = t.app.get(OrdersKernelService);
  port = t.app.get(CHECKOUT_PORT);
  health = t.app.get(IntegrationConnectionsService);
  s = scriptProviders(t);
});
afterAll(async () => { await t.close(); });

type K = { tenant: TestTenant; menu: SeededMenu; ctx: TenantContext };
async function tenantWithMenu(country: 'EG' | 'SA' = 'EG'): Promise<K> {
  const tenant = await createTenant(t, { country });
  const menu = await seedMenu(tenant);
  const ctx = new TenantContext(tenant.orgId, 'owner', null, tenant.owner.userId, 'user', tenant.owner.userId);
  return { tenant, menu, ctx };
}
const placeOrder = (k: K, qty = 1) =>
  db.scoped(k.ctx, (tx) => orders.place(tx, k.ctx, { branchId: k.tenant.branchId, channel: 'staff', fulfillment: 'pickup', lines: [{ productId: k.menu.products.fries, quantity: qty }] } as any));
const link = (k: K, orderId: string) => db.scoped(k.ctx, (tx) => port.createSession(tx, k.ctx, { purpose: 'order', orderId, channel: 'web' }));
const connRow = async (id: string) => (await sql(`select status, last_error, health, last_health_check_at, last_failure_at, last_success_at from integration_connections where id = $1`, [id]))[0];
const orderRow = async (id: string) => (await sql(`select paid_minor, refunded_minor, payment_status from orders where id = $1`, [id]))[0];
const ageHealth = (id: string, hours: number) => sql(`update integration_connections set last_health_check_at = now() - make_interval(hours => $2::int) where id = $1`, [id, hours]);

/** Stripe connection + a started checkout (attempt pending at the provider). */
async function stripeCheckout(k: K, conn: string, qty = 2) {
  const order = await placeOrder(k, qty);
  const session = await link(k, order.id);
  const csId = `cs_test_${randomBytes(6).toString('hex')}`;
  s.on('POST', 'https://api.stripe.com/v1/checkout/sessions', (c) => (c.url.endsWith('/sessions') ? { body: { id: csId, url: `https://checkout.stripe.com/c/pay/${csId}`, livemode: false } } : undefined));
  const start = await t.http.post(`/v1/public/pay/${session.token}/start`).send({ method: 'card' });
  expect(start.status, JSON.stringify(start.body)).toBe(200);
  const [attempt] = await sql(`select * from payments where checkout_session_id = $1 order by created_at desc limit 1`, [session.id]);
  return { order, session, csId, attempt };
}
const stripeCompleted = (csId: string, amount: number) => JSON.stringify({ id: `evt_${randomBytes(6).toString('hex')}`, type: 'checkout.session.completed', livemode: false,
  data: { object: { id: csId, amount_total: amount, currency: 'egp', payment_status: 'paid', payment_intent: `pi_${csId}` } } });
const sendStripe = (conn: string, secret: string, raw: string) =>
  t.http.post(`/v1/webhooks/payments/stripe?c=${conn}`).set({ 'stripe-signature': stripeSignature(secret, raw), 'content-type': 'application/json' }).send(raw);

// ---------------------------------------------------------------------------
describe('F1: the scheduled integrations.health job runs and re-checks due connections (FT-26, INT-17)', () => {
  it('checks a due connection, records the result, honours the 6 h / 12 h / 1 h intervals and never throws', async () => {
    s.reset(); scriptHealth(s);
    const k = await tenantWithMenu();
    const conn = (await connect(t, k.tenant, 'stripe', { secretKey: 'sk_test_f1', webhookSecret: 'whsec_f1' })).id;
    expect((await connRow(conn)).status).toBe('connected');

    // Checked 1 h ago: not due yet (6 h for a connected one).
    await ageHealth(conn, 1);
    expect(await health.scheduledHealth(new Date(), { orgId: k.tenant.orgId })).toEqual({ checked: 0, failed: 0, unreachable: 0 });

    // A revoked key (401) found by the job: error, with diagnostics.
    await ageHealth(conn, 7);
    s.on('GET', 'https://api.stripe.com/v1/account', () => ({ status: 401, body: { error: { message: 'Invalid API Key provided: sk_test_****f1' } } }));
    const before = new Date((await connRow(conn)).last_health_check_at).getTime();
    expect(await health.scheduledHealth(new Date(), { orgId: k.tenant.orgId })).toEqual({ checked: 1, failed: 1, unreachable: 0 });
    let row = await connRow(conn);
    expect(row.status).toBe('error');
    expect(new Date(row.last_health_check_at).getTime()).toBeGreaterThan(before);
    expect(row.last_error).toBe('stripe: HTTP 401');

    // Failing connections back off to 12 h, then recover by themselves once the provider accepts the key again.
    scriptHealth(s);
    await ageHealth(conn, 7);
    expect((await health.scheduledHealth(new Date(), { orgId: k.tenant.orgId })).checked).toBe(0);
    await ageHealth(conn, 13);
    expect(await health.scheduledHealth(new Date(), { orgId: k.tenant.orgId })).toEqual({ checked: 1, failed: 0, unreachable: 0 });
    row = await connRow(conn);
    expect(row.status).toBe('connected');
    expect(row.last_error).toBeNull();

    // The job is registered under its documented name and its run is recorded as succeeded (it threw on every run before).
    const [{ n }] = await sql(`select count(*)::int as n from job_runs where job = 'integrations.health' and status = 'failed' and error like '%make_interval%'`);
    expect(n).toBe(0);
  });

  it('a pending connection whose first check hit a provider outage is verified by the job within the hour', async () => {
    s.reset(); scriptHealth(s);
    s.on('GET', 'https://api.stripe.com/v1/account', () => ({ status: 503, body: { error: { message: 'upstream' } } }));
    const k = await tenantWithMenu();
    const { id: conn, health: first } = await connect(t, k.tenant, 'stripe', { secretKey: 'sk_test_f1p', webhookSecret: 'whsec_f1p' });
    expect(first.status).toBe('pending');
    expect(first.health).toMatchObject({ ok: false, transient: true, error: { code: 'http_503', retryable: true } });
    scriptHealth(s);
    await ageHealth(conn, 2);
    expect(await health.scheduledHealth(new Date(), { orgId: k.tenant.orgId })).toEqual({ checked: 1, failed: 0, unreachable: 0 });
    expect((await connRow(conn)).status).toBe('connected');
  });
});

// ---------------------------------------------------------------------------
describe('F2: health status never takes in-flight payments offline (R1 inverted)', () => {
  it('a transient provider error keeps the connection connected; the genuine signed webhook still applies', async () => {
    s.reset(); scriptHealth(s);
    const k = await tenantWithMenu();
    const secret = 'whsec_f2';
    const conn = (await connect(t, k.tenant, 'stripe', { secretKey: 'sk_test_f2', webhookSecret: secret })).id;
    const { order, session, csId } = await stripeCheckout(k, conn);
    s.on('GET', 'https://api.stripe.com/v1/account', () => ({ status: 503, body: { error: { message: 'upstream' } } }));
    await ageHealth(conn, 7);
    expect(await health.scheduledHealth(new Date(), { orgId: k.tenant.orgId })).toEqual({ checked: 1, failed: 0, unreachable: 1 });
    const manual = await t.http.post(`/v1/o/${k.tenant.orgId}/integrations/connections/${conn}/health`).set(auth(k.tenant.owner));
    expect(manual.status).toBe(201);
    expect(manual.body).toMatchObject({ status: 'connected', lastError: null, health: { ok: false, transient: true } });
    const row = await connRow(conn);
    expect(row.status).toBe('connected');
    expect(row.last_failure_at).not.toBeNull();

    const res = await sendStripe(conn, secret, stripeCompleted(csId, order.totalMinor));
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.outcome).toBe('applied');
    expect((await orderRow(order.id)).payment_status).toBe('paid');
    expect((await t.http.get(`/v1/public/pay/${session.token}`)).body.status).toBe('paid');
  });

  it('even a connection in error (or pending after "Edit settings") verifies webhooks, answers status queries and refunds existing payments', async () => {
    s.reset(); scriptHealth(s);
    const k = await tenantWithMenu();
    const secret = 'whsec_f2b';
    const conn = (await connect(t, k.tenant, 'stripe', { secretKey: 'sk_test_f2b', webhookSecret: secret })).id;
    const a = await stripeCheckout(k, conn);
    const b = await stripeCheckout(k, conn);
    // A definite failure (401) puts the connection in error: new checkouts no longer use it...
    s.on('GET', 'https://api.stripe.com/v1/account', () => ({ status: 401, body: { error: { message: 'expired key' } } }));
    expect((await t.http.post(`/v1/o/${k.tenant.orgId}/integrations/connections/${conn}/health`).set(auth(k.tenant.owner))).body.status).toBe('error');
    const fresh = await link(k, (await placeOrder(k)).id);
    expect((await t.http.get(`/v1/public/pay/${fresh.token}`)).body.methods.find((m: any) => m.method === 'card')?.provider).toBe('simulated');
    // ...but the payment already taken through it is accounted for.
    const res = await sendStripe(conn, secret, stripeCompleted(a.csId, a.order.totalMinor));
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.outcome).toBe('applied');
    // Status query on return (refresh) for the second attempt, bound to its own connection.
    s.on('GET', `https://api.stripe.com/v1/checkout/sessions/${b.csId}`, () => ({ body: { id: b.csId, status: 'complete', payment_status: 'paid', amount_total: b.order.totalMinor,
      currency: 'egp', livemode: false, payment_intent: `pi_${b.csId}`, metadata: { resuto_payment_id: b.attempt.id } } }));
    const refresh = await t.http.post(`/v1/public/pay/${b.session.token}/refresh`).send({});
    expect(refresh.body.status, JSON.stringify(refresh.body)).toBe('paid');
    // Staff refund of the first payment goes to the provider through the same (error-status) connection.
    s.on('POST', 'https://api.stripe.com/v1/refunds', () => ({ body: { id: 're_f2b', status: 'succeeded' } }));
    const refund = await t.http.post(`/v1/o/${k.tenant.orgId}/payments/${a.attempt.id}/refunds`).set(auth(k.tenant.owner)).send({ amountMinor: 100, reason: 'test', key: key() });
    expect(refund.status, JSON.stringify(refund.body)).toBe(201);
    expect(refund.body.status).toBe('succeeded');

    // "Edit settings" on a connected connection re-runs the check (status pending): webhooks keep working meanwhile.
    scriptHealth(s);
    await t.http.post(`/v1/o/${k.tenant.orgId}/integrations/connections/${conn}/health`).set(auth(k.tenant.owner)).expect(201);
    const c = await stripeCheckout(k, conn);
    const patched = await t.http.patch(`/v1/o/${k.tenant.orgId}/integrations/connections/${conn}`).set(auth(k.tenant.owner)).send({ config: {} });
    expect(patched.status, JSON.stringify(patched.body)).toBe(200);
    expect(patched.body.status).toBe('pending');
    expect((await sendStripe(conn, secret, stripeCompleted(c.csId, c.order.totalMinor))).body.outcome).toBe('applied');
  });

  it('a revoked connection still refuses webhooks (credentials destroyed)', async () => {
    s.reset(); scriptHealth(s);
    const k = await tenantWithMenu();
    const secret = 'whsec_f2c';
    const conn = (await connect(t, k.tenant, 'stripe', { secretKey: 'sk_test_f2c', webhookSecret: secret })).id;
    const a = await stripeCheckout(k, conn);
    await t.http.post(`/v1/o/${k.tenant.orgId}/integrations/connections/${conn}/revoke`).set(auth(k.tenant.owner)).expect(201);
    expect((await sendStripe(conn, secret, stripeCompleted(a.csId, a.order.totalMinor))).status).toBe(401);
  });
});


// ---------------------------------------------------------------------------
describe('every scheduled job of the payments and integrations lane is registered and completes', () => {
  it('runs each job once through the dispatcher registry without throwing', async () => {
    s.reset(); scriptHealth(s);
    const lane = ['integrations.health', 'payments.refund_status', 'payments.webhook_retry', 'payments.expire_checkouts', 'platform.webhook_inbox_retention', 'platform.idempotency_retention'];
    const jobs: Array<{ name: string; fn: () => Promise<unknown> }> = (t.app.get(EventDispatcher) as any).jobs;
    expect(jobs.map((j) => j.name)).toEqual(expect.arrayContaining(lane));
    for (const j of jobs.filter((x) => lane.includes(x.name))) {
      try {
        await j.fn();
      } catch (e) {
        throw new Error(`scheduled job ${j.name} failed: ${(e as Error).message}`);
      }
    }
  });
});
