// Regression tests for the independent review of ws2-payments (findings F3-F5): one signed provider transaction is
// processed, alerted and refunded once; a failed one-click alert refund can be retried; a payment refunded before
// Resuto saw it settle is applied. Each case is the reviewer's probe (scratchpad/ws2-review/review.probe.ts, R2-R4) with
// its assertions inverted. Connections are created through the real API path; provider HTTP is scripted.
import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TenantContext } from '../src/common/auth/context';
import { DbService } from '../src/common/db/db.service';
import { OrdersKernelService } from '../src/modules/kernel/orders-kernel.service';
import { CHECKOUT_PORT, type CheckoutPort } from '../src/modules/kernel/ports';
import { PaymentWebhooksService } from '../src/modules/payments/webhooks.service';
import { auth, bootTestApp, createTenant, seedMenu, sql, type SeededMenu, type TestApp, type TestTenant } from './helpers';
import { connect, paymobSignature, paymobTxn, scriptHealth, scriptProviders, stripeSignature, type Scripted } from './payments-fixtures';

let t: TestApp;
let db: DbService;
let orders: OrdersKernelService;
let port: CheckoutPort;
let s: Scripted;
const key = () => `k-${randomBytes(8).toString('hex')}`;

beforeAll(async () => {
  t = await bootTestApp();
  db = t.app.get(DbService);
  orders = t.app.get(OrdersKernelService);
  port = t.app.get(CHECKOUT_PORT);
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
const orderRow = async (id: string) => (await sql(`select paid_minor, refunded_minor, payment_status from orders where id = $1`, [id]))[0];

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
describe('F3: one signed Paymob transaction is processed once, alerts once and refunds once (R2 inverted)', () => {
  const hmacSecret = 'PAYMOB_F3_HMAC';
  async function paymobTenant() {
    s.reset(); scriptHealth(s);
    const k = await tenantWithMenu();
    const conn = (await connect(t, k.tenant, 'paymob', { secretKey: 'egy_sk_test_f3', publicKey: 'egy_pk_test_f3', hmacSecret, apiKey: 'api-key' },
      { integrationIdCard: 4520, integrationIdWallet: 4521 })).id;
    let next = 8_000_000 + Math.floor(Math.random() * 100_000);
    const ids: number[] = [];
    s.on('POST', 'https://accept.paymob.com/v1/intention/', () => { const id = ++next; ids.push(id); return { body: { id: `int_${id}`, client_secret: 'egy_csk_test_x', intention_order_id: id } }; });
    s.on('POST', 'https://accept.paymob.com/api/ecommerce/orders/transaction_inquiry', () => ({ status: 404, body: { detail: 'not found' } }));
    const send = (body: unknown, hmac: string) => t.http.post(`/v1/webhooks/payments/paymob?c=${conn}&hmac=${hmac}`).set('content-type', 'application/json').send(JSON.stringify(body));
    return { k, conn, ids, send };
  }

  it('unsigned-field variants are duplicates or idempotent; one refundable alert; the capture is refunded at most once', async () => {
    const { k, ids, send } = await paymobTenant();
    const order = await placeOrder(k, 2);
    const session = await link(k, order.id);
    expect((await t.http.post(`/v1/public/pay/${session.token}/start`).send({ method: 'card' })).status).toBe(200);
    expect((await t.http.post(`/v1/public/pay/${session.token}/start`).send({ method: 'wallet' })).status).toBe(200);
    const [card] = await sql(`select p.id, p.status from payments p join payment_attempt_refs r on r.payment_id = p.id where r.provider_session_id = $1`, [String(ids[0])]);
    expect(card.status).not.toBe('pending');
    const obj = paymobTxn({ orderId: ids[0]!, amount: order.totalMinor, integrationId: 4520, order: { id: ids[0], merchant_order_id: card.id } });
    const hmac = paymobSignature(hmacSecret, obj);
    expect((await send({ type: 'TRANSACTION', obj }, hmac)).body.outcome).toBe('late_success');
    // Same hmac, only unsigned data.message changed: the same event.
    for (let i = 1; i <= 3; i++) {
      const r = await send({ type: 'TRANSACTION', obj: { ...obj, data: { message: `Approved ${i}` } } }, hmac);
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ received: true, duplicate: true });
    }
    // The unsigned reference echo removed / pointed at another attempt: processed separately, never a second refundable alert.
    expect((await send({ type: 'TRANSACTION', obj: { ...obj, order: { ...obj.order, merchant_order_id: 'junk' } } }, hmac)).body.outcome).toBe('late_success');
    expect((await send({ type: 'TRANSACTION', obj: { ...obj, order: { ...obj.order, merchant_order_id: randomUUID() } } }, hmac)).body.outcome).toBe('reference_mismatch');
    const inboxRows = await sql(`select event_key from webhook_inbox where provider = 'payments:paymob' and org_id = $1 and event_key like $2`, [k.tenant.orgId, `txn:${obj.id}:%`]);
    expect(inboxRows).toHaveLength(3);
    const alerts = await sql(`select id, details from payment_alerts where org_id = $1 and kind = 'late_success' order by created_at`, [k.tenant.orgId]);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].details).toMatchObject({ refundable: true, providerPaymentId: String(obj.id), repeats: 2 });

    // Staff refunds it once. An older duplicate alert for the same transaction (rows from before this fix) cannot refund it again.
    s.on('POST', 'https://accept.paymob.com/api/acceptance/void_refund/refund', () => ({ body: { id: Math.floor(Math.random() * 1e9), success: true, pending: false } }));
    const [legacyDup] = await sql(`insert into payment_alerts(org_id, branch_id, kind, payment_id, checkout_session_id, provider, details)
      select org_id, branch_id, kind, payment_id, checkout_session_id, provider, details - 'repeats' from payment_alerts where id = $1 returning id`, [alerts[0].id]);
    const r1 = await t.http.post(`/v1/o/${k.tenant.orgId}/payments/alerts/${alerts[0].id}/refund`).set(auth(k.tenant.owner)).send({ key: key() });
    expect(r1.status, JSON.stringify(r1.body)).toBe(201);
    expect(r1.body.status).toBe('succeeded');
    const r2 = await t.http.post(`/v1/o/${k.tenant.orgId}/payments/alerts/${legacyDup.id}/refund`).set(auth(k.tenant.owner)).send({ key: key() });
    expect(r2.status).toBe(409);
    expect(r2.body.error.code).toBe('capture_already_refunded');
    const refundCalls = s.calls.filter((c) => c.url.endsWith('/void_refund/refund')).map((c) => JSON.parse(c.body!).transaction_id);
    expect(refundCalls).toEqual([String(obj.id)]);
    // A redelivery after staff resolved the alert does not re-open it or add a refundable one.
    expect((await send({ type: 'TRANSACTION', obj: { ...obj, order: { ...obj.order, merchant_order_id: null } } }, hmac)).body).toMatchObject({ duplicate: true });
    expect((await sql(`select count(*)::int as n from payment_alerts where org_id = $1 and kind = 'late_success' and status = 'open' and id <> $2`, [k.tenant.orgId, legacyDup.id]))[0].n).toBe(0);
  });

  it('declines are kept once per provider transaction and capped', async () => {
    const { k, ids, send } = await paymobTenant();
    const order = await placeOrder(k, 1);
    const session = await link(k, order.id);
    expect((await t.http.post(`/v1/public/pay/${session.token}/start`).send({ method: 'card' })).status).toBe(200);
    const [attempt] = await sql(`select id from payments where checkout_session_id = $1`, [session.id]);
    const decline = paymobTxn({ orderId: ids[0]!, amount: order.totalMinor, integrationId: 4520, success: false, data: { message: 'Do not honour' }, order: { id: ids[0], merchant_order_id: attempt.id } });
    const hmac = paymobSignature(hmacSecret, decline);
    expect((await send({ type: 'TRANSACTION', obj: decline }, hmac)).body.outcome).toBe('decline_recorded');
    expect((await send({ type: 'TRANSACTION', obj: { ...decline, order: { ...decline.order, merchant_order_id: 'x' } } }, hmac)).body.outcome).toBe('decline_recorded');
    let [p] = await sql(`select raw from payments where id = $1`, [attempt.id]);
    expect(p.raw.declines).toHaveLength(1);
    for (let i = 0; i < 25; i++) {
      const d = { ...decline, id: decline.id + 1 + i };
      expect((await send({ type: 'TRANSACTION', obj: d }, paymobSignature(hmacSecret, d))).body.outcome).toBe('decline_recorded');
    }
    [p] = await sql(`select status, failure_reason, raw from payments where id = $1`, [attempt.id]);
    expect(p).toMatchObject({ status: 'pending', failure_reason: 'declined' });
    expect(p.raw.declines).toHaveLength(20);
  });
});

// ---------------------------------------------------------------------------
describe('F4: a failed one-click alert refund can be retried and is never reported as sent (R3 inverted)', () => {
  it('replays only pending/succeeded refunds; after a definite failure the next click is a new provider request', async () => {
    s.reset(); scriptHealth(s);
    const k = await tenantWithMenu();
    const secret = 'whsec_f4';
    const conn = (await connect(t, k.tenant, 'stripe', { secretKey: 'sk_test_f4', webhookSecret: secret })).id;
    const { order, session, csId, attempt } = await stripeCheckout(k, conn, 1);
    await sql(`update checkout_sessions set status = 'cancelled' where id = $1`, [session.id]);
    await sql(`update payments set status = 'cancelled', failure_reason = 'superseded_by_new_attempt' where id = $1`, [attempt.id]);
    expect((await sendStripe(conn, secret, stripeCompleted(csId, order.totalMinor))).body.outcome).toBe('late_success');
    const [alert] = await sql(`select id from payment_alerts where payment_id = $1 and kind = 'late_success'`, [attempt.id]);
    const click = () => t.http.post(`/v1/o/${k.tenant.orgId}/payments/alerts/${alert.id}/refund`).set(auth(k.tenant.owner)).send({ key: `alert-${alert.id}` });
    const refundCalls = () => s.calls.filter((c) => c.url === 'https://api.stripe.com/v1/refunds');

    s.on('POST', 'https://api.stripe.com/v1/refunds', () => ({ status: 400, body: { error: { message: 'balance_insufficient' } } }));
    const first = await click();
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({ status: 'failed', failureReason: 'provider_refused_400' });
    expect((await sql(`select status from payment_alerts where id = $1`, [alert.id]))[0].status).toBe('open');

    s.on('POST', 'https://api.stripe.com/v1/refunds', () => ({ body: { id: 're_f4_ok', status: 'succeeded' } }));
    const second = await click();
    expect(second.status).toBe(201);
    expect(second.body.status).toBe('succeeded');
    expect(second.body.id).not.toBe(first.body.id);
    expect(refundCalls()).toHaveLength(2);
    const keys = refundCalls().map((c) => c.headers['idempotency-key']);
    expect(new Set(keys).size).toBe(2);
    expect((await sql(`select status from payment_alerts where id = $1`, [alert.id]))[0].status).toBe('resolved');

    // A further click replays the succeeded refund: no third provider request.
    const third = await click();
    expect(third.body.id).toBe(second.body.id);
    expect(refundCalls()).toHaveLength(2);
    const rows = await sql(`select idempotency_key, status from refunds where payment_id = $1 order by created_at`, [attempt.id]);
    expect(rows).toEqual([{ idempotency_key: `alert:${alert.id}`, status: 'failed' }, { idempotency_key: `alert:${alert.id}:2`, status: 'succeeded' }]);
  });
});

// ---------------------------------------------------------------------------
describe('F5: a Moyasar payment refunded before Resuto saw it settle is applied, then refunded (R4 inverted)', () => {
  const token = `moy_${randomBytes(8).toString('hex')}`;
  async function moyasarCheckout() {
    s.reset(); scriptHealth(s);
    const k = await tenantWithMenu('SA');
    const conn = (await connect(t, k.tenant, 'moyasar', { secretKey: 'sk_test_f5', webhookSecret: token })).id;
    const order = await placeOrder(k, 3);
    const session = await link(k, order.id);
    const inv = `inv_${randomBytes(6).toString('hex')}`;
    s.on('POST', 'https://api.moyasar.com/v1/invoices', () => ({ body: { id: inv, status: 'initiated', url: `https://checkout.moyasar.com/invoices/${inv}` } }));
    await t.http.post(`/v1/public/pay/${session.token}/start`).send({ method: 'card' }).expect(200);
    const [attempt] = await sql(`select id from payments where checkout_session_id = $1`, [session.id]);
    return { k, conn, order, session, inv, attempt };
  }

  it('webhook path: payment_paid confirmed as "refunded" (partial) settles the charge and the refund in one go', async () => {
    const { conn, order, session, inv, attempt } = await moyasarCheckout();
    const pay = `pay_${randomBytes(6).toString('hex')}`;
    s.on('GET', `https://api.moyasar.com/v1/payments/${pay}`, () => ({ body: { id: pay, status: 'refunded', amount: order.totalMinor, refunded: 100, captured: 0, currency: 'SAR', invoice_id: inv,
      metadata: { resuto_payment_id: attempt.id } } }));
    const hook = JSON.stringify({ id: `evt_${randomBytes(6).toString('hex')}`, type: 'payment_paid', created_at: new Date().toISOString(), secret_token: token, live: false, data: { id: pay, invoice_id: inv } });
    const res = await t.http.post(`/v1/webhooks/payments/moyasar?c=${conn}`).set('content-type', 'application/json').send(hook);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.outcome).toBe('refund_applied');
    const [p] = await sql(`select status, amount_minor, refunded_minor, provider_payment_id from payments where id = $1`, [attempt.id]);
    expect(p).toMatchObject({ status: 'partially_refunded', amount_minor: order.totalMinor, refunded_minor: 100, provider_payment_id: pay });
    expect(await orderRow(order.id)).toMatchObject({ paid_minor: order.totalMinor, refunded_minor: 100 });
    expect((await t.http.get(`/v1/public/pay/${session.token}`)).body.status).toBe('paid');
    // Re-delivery and the worker change nothing more.
    await t.app.get(PaymentWebhooksService).retryPending();
    expect((await t.http.post(`/v1/webhooks/payments/moyasar?c=${conn}`).set('content-type', 'application/json').send(hook)).body).toMatchObject({ duplicate: true });
    expect((await sql(`select count(*)::int as n from refunds where payment_id = $1`, [attempt.id]))[0].n).toBe(1);
  });

  it('status-query path: an invoice whose only payment is fully refunded settles and refunds the attempt on /refresh', async () => {
    const { order, session, inv, attempt } = await moyasarCheckout();
    s.on('GET', `https://api.moyasar.com/v1/invoices/${inv}`, () => ({ body: { id: inv, status: 'paid', amount: order.totalMinor, currency: 'SAR',
      payments: [{ id: 'pay_f5_full', status: 'refunded', amount: order.totalMinor, refunded: order.totalMinor, currency: 'SAR', metadata: { resuto_payment_id: attempt.id } }] } }));
    const refresh = await t.http.post(`/v1/public/pay/${session.token}/refresh`).send({});
    expect(refresh.status).toBe(200);
    const [p] = await sql(`select status, refunded_minor from payments where id = $1`, [attempt.id]);
    expect(p).toMatchObject({ status: 'refunded', refunded_minor: order.totalMinor });
    expect(await orderRow(order.id)).toMatchObject({ paid_minor: order.totalMinor, refunded_minor: order.totalMinor });
  });

  it('an authenticated "refunded" for a different amount than the attempt is never applied (amount mismatch)', async () => {
    const { conn, order, inv, attempt } = await moyasarCheckout();
    s.on('GET', 'https://api.moyasar.com/v1/payments/pay_f5_bad', () => ({ body: { id: 'pay_f5_bad', status: 'refunded', amount: order.totalMinor - 1, refunded: 10, currency: 'SAR', invoice_id: inv,
      metadata: { resuto_payment_id: attempt.id } } }));
    const hook = JSON.stringify({ id: `evt_${randomBytes(6).toString('hex')}`, type: 'payment_paid', created_at: new Date().toISOString(), secret_token: token, live: false, data: { id: 'pay_f5_bad', invoice_id: inv } });
    const res = await t.http.post(`/v1/webhooks/payments/moyasar?c=${conn}`).set('content-type', 'application/json').send(hook);
    expect(res.body.outcome).toBe('amount_mismatch');
    expect(await orderRow(order.id)).toMatchObject({ paid_minor: 0, refunded_minor: 0 });
  });
});
