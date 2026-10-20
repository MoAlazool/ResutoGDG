// Financial safety: uncertain refunds, concurrency, ledger invariants, manual collection, inbox hygiene and the
// PAYMENT_MODE=live boot. Probes PS-06, PS-07, PS-09, PS-10 and PS-24 from the payments audit, with their assertions
// inverted (they reproduced the defects before this workstream).
import { createHash, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TenantContext } from '../src/common/auth/context';
import { DbService } from '../src/common/db/db.service';
import { IdempotencyService } from '../src/common/platform/idempotency.service';
import { WebhookInboxService } from '../src/common/platform/webhook-inbox.service';
import { OrdersKernelService } from '../src/modules/kernel/orders-kernel.service';
import { PaymentLedgerService } from '../src/modules/kernel/payment-ledger.service';
import { CHECKOUT_PORT, type CheckoutPort } from '../src/modules/kernel/ports';
import { RefundsService } from '../src/modules/payments/refunds.service';
import { SandboxProviderService } from '../src/modules/payments/sandbox.service';
import { auth, bootTestApp, createTenant, seedMenu, sql, type SeededMenu, type TestApp, type TestTenant } from './helpers';
import { connect, scriptHealth, scriptProviders, stripeSignature, type Scripted } from './payments-fixtures';

let t: TestApp;
let db: DbService;
let orders: OrdersKernelService;
let ledger: PaymentLedgerService;
let port: CheckoutPort;
let s: Scripted;
const key = () => `k-${randomBytes(8).toString('hex')}`;

beforeAll(async () => {
  t = await bootTestApp();
  db = t.app.get(DbService);
  orders = t.app.get(OrdersKernelService);
  ledger = t.app.get(PaymentLedgerService);
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
type K = Awaited<ReturnType<typeof tenantWithMenu>>;
const placeOrder = (k: K, qty = 1, extra: Record<string, unknown> = {}) =>
  db.scoped(k.ctx, (tx) => orders.place(tx, k.ctx, { branchId: k.tenant.branchId, channel: 'staff', fulfillment: 'pickup', lines: [{ productId: k.menu.products.fries, quantity: qty }], ...extra } as any));

/** A settled Stripe payment created through the real path (connection via API, checkout, signed webhook). */
async function settledStripePayment(k: K, conn: string, secret: string, qty = 2) {
  const order = await placeOrder(k, qty);
  const session = await db.scoped(k.ctx, (tx) => port.createSession(tx, k.ctx, { purpose: 'order', orderId: order.id, channel: 'web' }));
  const csId = `cs_test_${randomBytes(6).toString('hex')}`;
  s.on('POST', 'https://api.stripe.com/v1/checkout/sessions', (c) => (c.url.endsWith('/sessions') ? { body: { id: csId, url: `https://checkout.stripe.com/c/pay/${csId}`, livemode: false } } : undefined));
  await t.http.post(`/v1/public/pay/${session.token}/start`).send({ method: 'card' }).expect(200);
  const raw = JSON.stringify({ id: `evt_${randomBytes(6).toString('hex')}`, type: 'checkout.session.completed', livemode: false,
    data: { object: { id: csId, amount_total: order.totalMinor, currency: 'egp', payment_status: 'paid', payment_intent: `pi_${csId}` } } });
  const res = await t.http.post(`/v1/webhooks/payments/stripe?c=${conn}`).set({ 'stripe-signature': stripeSignature(secret, raw), 'content-type': 'application/json' }).send(raw);
  expect(res.body.outcome).toBe('applied');
  const [p] = await sql(`select * from payments where checkout_session_id = $1`, [session.id]);
  return { order, payment: p, pi: `pi_${csId}` };
}

// ---------------------------------------------------------------------------
describe('refunds whose outcome is unknown (PS-06 inverted, PAY-05, PAY-12)', () => {
  let k: K;
  let conn: string;
  const secret = 'whsec_refundflow';
  beforeAll(async () => {
    s.reset(); scriptHealth(s);
    k = await tenantWithMenu();
    conn = (await connect(t, k.tenant, 'stripe', { secretKey: 'sk_test_refunds', webhookSecret: secret })).id;
  });
  const refund = (paymentId: string, amountMinor: number, k2 = key()) =>
    t.http.post(`/v1/o/${k.tenant.orgId}/payments/${paymentId}/refunds`).set(auth(k.tenant.owner)).send({ amountMinor, reason: 'guest complaint', key: k2 });

  it('a dropped refund stays pending, blocks a second refund, and is resolved by inquiry with the SAME key', async () => {
    const { payment, pi } = await settledStripePayment(k, conn, secret);
    let mode: 'drop' | 'ok' = 'drop';
    s.on('POST', 'https://api.stripe.com/v1/refunds', () => (mode === 'drop' ? 'network_error' : { body: { id: 're_ok', status: 'succeeded' } }));
    const first = await refund(payment.id, 1000);
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    expect(first.body).toMatchObject({ status: 'pending', outcomeUncertain: true });
    expect((await sql(`select refunded_minor from payments where id = $1`, [payment.id]))[0].refunded_minor).toBe(0); // ledger untouched
    const second = await refund(payment.id, 1000);
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('refund_in_progress');
    expect((await sql(`select kind from payment_alerts where payment_id = $1`, [payment.id])).map((r) => r.kind)).toContain('refund_uncertain');
    // Inquiry: the provider has no record yet and the refund is young -> nothing is resent.
    s.on('GET', `https://api.stripe.com/v1/refunds?payment_intent=${pi}`, () => ({ body: { data: [] } }));
    const check = await t.http.post(`/v1/o/${k.tenant.orgId}/payments/refunds/${first.body.id}/check`).set(auth(k.tenant.owner));
    expect(check.body.status).toBe('pending');
    // Ten minutes later the provider still has no trace: it is resent with the same key and succeeds.
    await sql(`update refunds set created_at = now() - interval '15 minutes' where id = $1`, [first.body.id]);
    mode = 'ok';
    const resolved = await t.app.get(RefundsService).resolve(k.tenant.orgId, first.body.id);
    expect(resolved).toMatchObject({ status: 'succeeded', outcomeUncertain: false });
    const keys = new Set(s.calls.filter((c) => c.method === 'POST' && c.url === 'https://api.stripe.com/v1/refunds').map((c) => c.headers['idempotency-key']));
    expect(keys.size).toBe(1); // one intended refund, one provider idempotency key
    expect([...keys][0]).toBe(`resuto-refund-${payment.id}:1`);
    expect((await sql(`select refunded_minor, status from payments where id = $1`, [payment.id]))[0]).toEqual({ refunded_minor: 1000, status: 'partially_refunded' });
  });

  it('an uncertain refund the provider DID process is settled from the inquiry without a second request', async () => {
    const { payment, pi } = await settledStripePayment(k, conn, secret);
    s.on('POST', 'https://api.stripe.com/v1/refunds', () => ({ status: 503, body: { error: { message: 'upstream timeout' } } }));
    const first = await refund(payment.id, 2000);
    expect(first.body).toMatchObject({ status: 'pending', outcomeUncertain: true });
    const posts = s.calls.filter((c) => c.method === 'POST' && c.url === 'https://api.stripe.com/v1/refunds').length;
    const providerKey = `${payment.id}:1`;
    s.on('GET', `https://api.stripe.com/v1/refunds?payment_intent=${pi}`, () => ({ body: { data: [{ id: 're_seen', status: 'succeeded', metadata: { resuto_refund_key: providerKey } }] } }));
    await sql(`update refunds set last_checked_at = now() - interval '1 day', created_at = now() - interval '5 minutes' where id = $1`, [first.body.id]);
    const run = await t.app.get(RefundsService).resolvePending();
    expect(run.resolved).toBeGreaterThanOrEqual(1);
    const [r] = await sql(`select status, provider_refund_id, outcome_uncertain from refunds where id = $1`, [first.body.id]);
    expect(r).toEqual({ status: 'succeeded', provider_refund_id: 're_seen', outcome_uncertain: false });
    expect(s.calls.filter((c) => c.method === 'POST' && c.url === 'https://api.stripe.com/v1/refunds').length).toBe(posts);
    expect((await sql(`select refunded_minor from payments where id = $1`, [payment.id]))[0].refunded_minor).toBe(2000);
  });

  it('a definite provider refusal fails the refund (and frees the amount); concurrent same-key requests replay (PS-24)', async () => {
    const { payment } = await settledStripePayment(k, conn, secret);
    s.on('POST', 'https://api.stripe.com/v1/refunds', () => ({ status: 400, body: { error: { message: 'charge_already_refunded' } } }));
    const refused = await refund(payment.id, 500);
    expect(refused.body).toMatchObject({ status: 'failed', failureReason: 'provider_refused_400', outcomeUncertain: false });
    s.on('POST', 'https://api.stripe.com/v1/refunds', () => ({ body: { id: `re_${randomBytes(3).toString('hex')}`, status: 'succeeded' } }));
    const same = key();
    const [a, b] = await Promise.all([refund(payment.id, 700, same), refund(payment.id, 700, same)]);
    expect([a.status, b.status].sort()).toEqual([201, 201]);
    expect(a.body.id).toBe(b.body.id);
    expect((await sql(`select count(*)::int as n from refunds where idempotency_key = $1`, [same]))[0].n).toBe(1);
    expect((await sql(`select refunded_minor from payments where id = $1`, [payment.id]))[0].refunded_minor).toBe(700);
  });
});

// ---------------------------------------------------------------------------
describe('concurrency and ledger invariants', () => {
  it('two parallel /start calls create ONE provider attempt (PS-07 inverted, PAY-09)', async () => {
    const k = await tenantWithMenu();
    const o = await placeOrder(k, 3);
    const session = await db.scoped(k.ctx, (tx) => port.createSession(tx, k.ctx, { purpose: 'payment_link', orderId: o.id, amountMinor: 4000, channel: 'staff' }));
    const results = await Promise.all([1, 2, 3].map(() => t.http.post(`/v1/public/pay/${session.token}/start`).send({ method: 'card' })));
    const live = await sql(`select id from payments where checkout_session_id = $1 and status in ('pending', 'requires_action', 'authorized')`, [session.id]);
    expect(live).toHaveLength(1);
    for (const r of results) {
      expect([200, 409]).toContain(r.status);
      if (r.status === 200) expect(r.body.paymentId).toBe(live[0].id);
      else expect(r.body.error.code).toBe('checkout_in_progress');
    }
    // The database refuses a second active attempt even if application code raced.
    await expect(sql(`insert into payments(org_id, branch_id, order_id, checkout_session_id, method, provider, amount_minor, currency, status)
      values ($1, $2, $3, $4, 'card', 'simulated', 100, 'EGP', 'pending')`, [k.tenant.orgId, k.tenant.branchId, o.id, session.id])).rejects.toThrow(/payments_one_active_attempt_idx/);
  });

  it('cash collection and a verified webhook racing for one bill never overpay', async () => {
    const k = await tenantWithMenu();
    const sandbox = t.app.get(SandboxProviderService);
    const o = await placeOrder(k, 2);
    const session = await db.scoped(k.ctx, (tx) => port.createSession(tx, k.ctx, { purpose: 'order', orderId: o.id, channel: 'web' }));
    await t.http.post(`/v1/public/pay/${session.token}/start`).send({ method: 'card' }).expect(200);
    const [attempt] = await sql(`select r.provider_session_id from payments p join payment_attempt_refs r on r.payment_id = p.id where p.checkout_session_id = $1`, [session.id]);
    const hook = (await sandbox.settle(k.tenant.orgId, attempt.provider_session_id, 'success'))!;
    const [cash, web] = await Promise.all([
      t.http.post(`/v1/o/${k.tenant.orgId}/payments/collect`).set(auth(k.tenant.owner)).send({ orderId: o.id, method: 'cash', amountMinor: o.totalMinor, key: key() }),
      t.http.post(`/v1/webhooks/payments/simulated?c=${k.tenant.orgId}`).set(hook.headers).send(hook.raw),
    ]);
    const [row] = await sql(`select paid_minor, total_minor from orders where id = $1`, [o.id]);
    expect(row.paid_minor).toBe(row.total_minor);
    // The pending online attempt reserves the amount, so the counter collection is refused either way.
    expect(cash.status).toBe(409);
    expect(web.body.outcome).toBe('applied');
  });

  it('reservation deposits: never more than the deposit due, never on a cancelled reservation (PS-09 inverted, PAY-17)', async () => {
    const k = await tenantWithMenu();
    const hash = createHash('sha256').update(randomBytes(16)).digest('hex');
    const [r] = await sql(`insert into reservations(org_id, branch_id, guest_name, party_size, starts_at, ends_at, blocked_until, status, deposit_minor, deposit_status, access_token_hash)
      values ($1, $2, 'Guest', 2, now() + interval '2 days', now() + interval '2 days 90 minutes', now() + interval '2 days 105 minutes', 'pending_deposit', 10000, 'required', $3) returning id`,
      [k.tenant.orgId, k.tenant.branchId, hash]);
    const rec = (amount: number) => db.scoped(k.ctx, (tx) => ledger.recordSucceeded(tx, k.ctx, { branchId: k.tenant.branchId, reservationId: r.id, method: 'cash', provider: 'manual', amountMinor: amount, currency: 'EGP', idempotencyKey: key() }));
    await expect(rec(10001)).rejects.toMatchObject({ code: 'overpayment' });
    await rec(6000);
    await expect(rec(5000)).rejects.toMatchObject({ code: 'overpayment', details: { dueMinor: 4000 } });
    await sql(`update reservations set status = 'cancelled' where id = $1`, [r.id]);
    await expect(rec(4000)).rejects.toMatchObject({ code: 'overpayment' });
    const [{ n, s: sum }] = await sql(`select count(*)::int as n, sum(amount_minor)::int as s from payments where reservation_id = $1 and status = 'succeeded'`, [r.id]);
    expect([n, sum]).toEqual([1, 6000]);
  });
});

// ---------------------------------------------------------------------------
describe('manual collection is staff-verified and audited (PAY-19)', () => {
  it('one validator for every route: references required, a transfer reference counts once, receipts say staff-verified', async () => {
    const k = await tenantWithMenu();
    const url = `/v1/o/${k.tenant.orgId}/payments/collect`;
    const o1 = await placeOrder(k, 1), o2 = await placeOrder(k, 1);
    const ok = await t.http.post(url).set(auth(k.tenant.owner)).send({ orderId: o1.id, method: 'instapay', amountMinor: 1000, reference: 'IPN-778899', key: key() });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    const dup = await t.http.post(url).set(auth(k.tenant.owner)).send({ orderId: o2.id, method: 'instapay', amountMinor: 1000, reference: 'ipn-778899', key: key() });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('duplicate_reference');
    // The order-level collect route (orders module) goes through the same ledger rule.
    const terminal = await t.http.post(`/v1/o/${k.tenant.orgId}/orders/${o2.id}/collect`).set({ ...auth(k.tenant.owner), 'Idempotency-Key': key() }).send({ method: 'card' });
    expect(terminal.status).toBe(422);
    expect(terminal.body.error.code).toBe('reference_required');
    const receipt = await t.http.get(`/v1/o/${k.tenant.orgId}/payments/${ok.body.id}/receipt`).set(auth(k.tenant.owner));
    expect(receipt.body.payment).toMatchObject({ provider: 'manual', verification: 'staff' });
    const [audit] = await sql(`select action from audit_logs where org_id = $1 and entity_id = $2`, [k.tenant.orgId, ok.body.id]);
    expect(audit.action).toBe('payment.collected');
  });
});

// ---------------------------------------------------------------------------
describe('late captures are resolved, not just alerted (PAY-08)', () => {
  it('a capture on a cancelled link is alerted with a one-click provider refund that never touches the ledger', async () => {
    s.reset(); scriptHealth(s);
    const k = await tenantWithMenu();
    const secret = 'whsec_lateflow';
    const conn = (await connect(t, k.tenant, 'stripe', { secretKey: 'sk_test_late', webhookSecret: secret })).id;
    const o = await placeOrder(k, 1);
    const session = await db.scoped(k.ctx, (tx) => port.createSession(tx, k.ctx, { purpose: 'payment_link', orderId: o.id, channel: 'staff' }));
    const csId = `cs_test_${randomBytes(6).toString('hex')}`;
    s.on('POST', 'https://api.stripe.com/v1/checkout/sessions', (c) => (c.url.endsWith('/sessions') ? { body: { id: csId, url: `https://checkout.stripe.com/c/pay/${csId}`, livemode: false } } : undefined));
    await t.http.post(`/v1/public/pay/${session.token}/start`).send({ method: 'card' }).expect(200);
    const [attempt] = await sql(`select id from payments where checkout_session_id = $1`, [session.id]);
    await sql(`update checkout_sessions set status = 'cancelled' where id = $1`, [session.id]);
    await db.scoped(k.ctx, (tx) => ledger.fail(tx, attempt.id, 'superseded_by_new_attempt', 'cancelled'));
    const raw = JSON.stringify({ id: `evt_${randomBytes(6).toString('hex')}`, type: 'checkout.session.completed', livemode: false,
      data: { object: { id: csId, amount_total: o.totalMinor, currency: 'egp', payment_status: 'paid', payment_intent: `pi_${csId}` } } });
    const res = await t.http.post(`/v1/webhooks/payments/stripe?c=${conn}`).set({ 'stripe-signature': stripeSignature(secret, raw), 'content-type': 'application/json' }).send(raw);
    expect(res.body.outcome).toBe('late_success');
    const [alert] = await sql(`select id, details from payment_alerts where payment_id = $1 and kind = 'late_success'`, [attempt.id]);
    expect(alert.details).toMatchObject({ refundable: true, providerPaymentId: `pi_${csId}` });
    s.on('POST', 'https://api.stripe.com/v1/refunds', () => ({ body: { id: 're_late', status: 'succeeded' } }));
    const r = await t.http.post(`/v1/o/${k.tenant.orgId}/payments/alerts/${alert.id}/refund`).set(auth(k.tenant.owner)).send({ key: key() });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body).toMatchObject({ status: 'succeeded', source: 'unapplied_capture', amountMinor: o.totalMinor });
    const call = s.calls.filter((c) => c.url === 'https://api.stripe.com/v1/refunds').at(-1)!;
    expect(new URLSearchParams(call.body!).get('payment_intent')).toBe(`pi_${csId}`);
    expect(call.headers['idempotency-key']).toBe(`resuto-refund-alert:${alert.id}`);
    expect((await sql(`select status from payment_alerts where id = $1`, [alert.id]))[0].status).toBe('resolved');
    expect((await sql(`select paid_minor, refunded_minor from orders where id = $1`, [o.id]))[0]).toEqual({ paid_minor: 0, refunded_minor: 0 });
    // A second click replays; nothing is refunded twice.
    const again = await t.http.post(`/v1/o/${k.tenant.orgId}/payments/alerts/${alert.id}/refund`).set(auth(k.tenant.owner)).send({ key: key() });
    expect(again.body.id).toBe(r.body.id);
    expect(s.calls.filter((c) => c.url === 'https://api.stripe.com/v1/refunds')).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
describe('webhook endpoint hygiene (PS-10 inverted, PAY-18, PS-24)', () => {
  it('prototype keys are unknown providers (404) and leave no inbox row', async () => {
    for (const p of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
      expect((await t.http.post(`/v1/webhooks/payments/${p}`).set('content-type', 'application/json').send('{"probe":true}')).status).toBe(404);
    }
    expect((await sql(`select count(*)::int as n from webhook_inbox where provider in ('payments:constructor', 'payments:__proto__', 'payments:tostring')`))[0].n).toBe(0);
  });

  it('rejected deliveries keep only a reason, a hash and a short redacted excerpt', async () => {
    const k = await tenantWithMenu();
    const big = JSON.stringify({ id: 'x', data: { email: 'guest@example.com', phone: '+201001234567', note: 'y'.repeat(20000) }, secret_token: 'leak-me' });
    expect((await t.http.post(`/v1/webhooks/payments/simulated?c=${k.tenant.orgId}`).set('content-type', 'application/json').send(big)).status).toBe(401);
    const [row] = await sql(`select payload from webhook_inbox where provider = 'payments:simulated' and event_key = $1`, [`rejected:${createHash('sha256').update(big).digest('hex')}`]);
    expect(Object.keys(row.payload).sort()).toEqual(['bytes', 'excerpt', 'reason', 'sha256']);
    expect(row.payload.excerpt.length).toBeLessThanOrEqual(512);
    expect(JSON.stringify(row.payload)).not.toMatch(/guest@example|1001234567|leak-me/);
  });

  it('purges inbox rows and idempotency keys past retention', async () => {
    const old = new Date(Date.now() - 400 * 86_400_000);
    await sql(`insert into webhook_inbox(provider, event_key, signature_valid, headers, payload, status, received_at) values
      ('payments:simulated', $1, true, '{}', '{}', 'processed', $3), ('payments:simulated', $2, false, '{}', '{}', 'rejected', now() - interval '8 days')`,
      [`old-${key()}`, `rej-${key()}`, old]);
    const kept = `new-${key()}`;
    await sql(`insert into webhook_inbox(provider, event_key, signature_valid, headers, payload, status) values ('payments:simulated', $1, true, '{}', '{}', 'processed')`, [kept]);
    const { deleted } = await t.app.get(WebhookInboxService).purge();
    expect(deleted).toBeGreaterThanOrEqual(2);
    expect((await sql(`select count(*)::int as n from webhook_inbox where event_key = $1`, [kept]))[0].n).toBe(1);
    const k = await tenantWithMenu();
    await sql(`insert into idempotency_keys(org_id, scope, key, request_hash, created_at) values ($1, 'test', $2, 'h', now() - interval '30 days')`, [k.tenant.orgId, key()]);
    expect((await t.app.get(IdempotencyService).purge()).deleted).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
describe('PAYMENT_MODE=live boot', () => {
  let live: TestApp;
  let tenant: TestTenant;
  let menu: SeededMenu;
  beforeAll(async () => {
    const previous = process.env.PAYMENT_MODE;
    process.env.PAYMENT_MODE = 'live';
    try { live = await bootTestApp(); } finally { process.env.PAYMENT_MODE = previous; }
    tenant = await createTenant(live, { country: 'EG' });
    menu = await seedMenu(tenant);
  });
  afterAll(async () => { await live.close(); });

  it('the simulated provider is gone, sandbox connections are ignored and test keys are refused on live connections', async () => {
    expect((await live.http.post(`/v1/webhooks/payments/simulated?c=${tenant.orgId}`).send({})).status).toBe(404);
    const ctx = new TenantContext(tenant.orgId, 'owner', null, tenant.owner.userId, 'user', tenant.owner.userId);
    const o = await live.app.get(DbService).scoped(ctx, (tx) => live.app.get(OrdersKernelService).place(tx, ctx,
      { branchId: tenant.branchId, channel: 'staff', fulfillment: 'pickup', lines: [{ productId: menu.products.fries, quantity: 1 }] } as any));
    const session = await live.app.get(DbService).scoped(ctx, (tx) => live.app.get(CHECKOUT_PORT).createSession(tx, ctx, { purpose: 'order', orderId: o.id, channel: 'web' }))
      .catch((e) => e);
    // No live connection: no online method is offered at all (nothing falls back to a simulator).
    expect((session as any).code ?? null).toBe(null);
    const view = await live.http.get(`/v1/public/pay/${(session as any).token}`);
    expect(view.body.sandbox).toBe(false);
    expect(view.body.methods.map((m: any) => m.method)).toEqual(['cash']);
    expect((await live.http.get(`/v1/public/pay/${(session as any).token}/sandbox`)).status).toBe(403);
    const testOnLive = await live.http.post(`/v1/o/${tenant.orgId}/integrations/connections`).set(auth(tenant.owner))
      .send({ provider: 'stripe', environment: 'live', credentials: { secretKey: 'sk_test_x', webhookSecret: 'whsec_x' } });
    expect(testOnLive.body.error.code).toBe('credential_environment_mismatch');
    // A sandbox connection (test keys) exists, but live mode never uses it for checkout or webhooks.
    const sandboxConn = await live.http.post(`/v1/o/${tenant.orgId}/integrations/connections`).set(auth(tenant.owner))
      .send({ provider: 'stripe', environment: 'sandbox', credentials: { secretKey: 'sk_test_x', webhookSecret: 'whsec_x' } });
    await sql(`update integration_connections set status = 'connected' where id = $1`, [sandboxConn.body.id]);
    const raw = JSON.stringify({ id: 'evt_live_1', type: 'checkout.session.completed', livemode: false, data: { object: { id: 'cs_x', amount_total: 1, currency: 'egp', payment_status: 'paid' } } });
    expect((await live.http.post(`/v1/webhooks/payments/stripe?c=${sandboxConn.body.id}`).set({ 'stripe-signature': stripeSignature('whsec_x', raw), 'content-type': 'application/json' }).send(raw)).status).toBe(401);
  });
});
