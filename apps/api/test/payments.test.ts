import { createHash, randomBytes } from 'node:crypto';
import { signStripe } from '@resuto/integrations';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TenantContext } from '../src/common/auth/context';
import { SecretBox } from '../src/common/crypto/secret-box';
import { DbService } from '../src/common/db/db.service';
import { OrdersKernelService } from '../src/modules/kernel/orders-kernel.service';
import { PaymentLedgerService } from '../src/modules/kernel/payment-ledger.service';
import { CHECKOUT_PORT, type CheckoutPort } from '../src/modules/kernel/ports';
import { CheckoutService } from '../src/modules/payments/checkout.service';
import { SandboxProviderService } from '../src/modules/payments/sandbox.service';
import { addMember, auth, bootTestApp, createTenant, seedMenu, sql, unique, type SeededMenu, type TestApp, type TestTenant, type TestUser } from './helpers';

let t: TestApp;
let db: DbService;
let orders: OrdersKernelService;
let port: CheckoutPort;
let sandbox: SandboxProviderService;
let tenant: TestTenant;
let menu: SeededMenu;
let ctx: TenantContext;
let waiter: TestUser;
let cashier: TestUser;
let accountant: TestUser;

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const token = () => randomBytes(24).toString('base64url');
const key = () => `k-${randomBytes(8).toString('hex')}`;

beforeAll(async () => {
  t = await bootTestApp();
  db = t.app.get(DbService);
  orders = t.app.get(OrdersKernelService);
  port = t.app.get(CHECKOUT_PORT);
  sandbox = t.app.get(SandboxProviderService);
  tenant = await createTenant(t, { country: 'EG' });
  menu = await seedMenu(tenant);
  ctx = new TenantContext(tenant.orgId, 'owner', null, tenant.owner.userId, 'user', tenant.owner.userId);
  waiter = await addMember(t, tenant, 'waiter');
  cashier = await addMember(t, tenant, 'cashier');
  accountant = await addMember(t, tenant, 'accountant');
});
afterAll(async () => { await t.close(); });

const placeOrder = (lines: Array<{ productId: string; quantity: number }>, extra: Record<string, unknown> = {}) =>
  db.scoped(ctx, (tx) => orders.place(tx, ctx, { branchId: tenant.branchId, channel: 'staff', fulfillment: 'pickup', lines, ...extra } as any));

async function openVisit(withOrders: Array<Array<{ productId: string; quantity: number }>>) {
  const visitToken = token();
  const [table] = await sql(`insert into dining_tables(org_id, branch_id, label, capacity, qr_token) values ($1, $2, $3, 4, $4) returning id`,
    [tenant.orgId, tenant.branchId, unique('T').slice(-12), `qr-${token()}`]);
  const [visit] = await sql(`insert into visits(org_id, branch_id, table_id, guest_token_hash) values ($1, $2, $3, $4) returning id`,
    [tenant.orgId, tenant.branchId, table.id, sha256(visitToken)]);
  const placed = [];
  for (const lines of withOrders) {
    placed.push(await db.scoped(ctx, (tx) => orders.place(tx, ctx, { branchId: tenant.branchId, channel: 'qr', fulfillment: 'dine_in', tableId: table.id, visitId: visit.id, lines })));
  }
  return { visitId: visit.id as string, visitToken, tableId: table.id as string, orders: placed };
}

const createSession = (input: Parameters<CheckoutPort['createSession']>[2]) => db.scoped(ctx, (tx) => port.createSession(tx, ctx, input));

async function payViaSandbox(checkoutToken: string, outcome: 'success' | 'failure' = 'success', method = 'card') {
  const start = await t.http.post(`/v1/public/pay/${checkoutToken}/start`).send({ method });
  expect(start.status, JSON.stringify(start.body)).toBe(200);
  expect(start.body.kind).toBe('redirect');
  const done = await t.http.post(`/v1/public/pay/${checkoutToken}/sandbox/complete`).send({ outcome });
  expect(done.status, JSON.stringify(done.body)).toBe(200);
  return { start: start.body, view: done.body };
}

const pendingAttempt = async (sessionId: string) =>
  (await sql(`select p.*, r.provider_session_id from payments p join payment_attempt_refs r on r.payment_id = p.id where p.checkout_session_id = $1 order by p.created_at desc limit 1`, [sessionId]))[0];

// ---------------------------------------------------------------------------
describe('hosted checkout through the simulated provider', () => {
  it('pays a prepaid order only from the verified webhook and then releases it to the kitchen', async () => {
    const order = await db.scoped(ctx, (tx) => orders.place(tx, ctx, {
      branchId: tenant.branchId, channel: 'web', fulfillment: 'delivery', initialStatus: 'awaiting_payment',
      lines: [{ productId: menu.products.fries, quantity: 2 }], customer: { phone: '+201001112223' }, deliveryAddress: { line1: '5 Tahrir St' },
    }));
    const session = await createSession({ purpose: 'order', orderId: order.id, channel: 'web' });
    expect(session.url).toBe(`http://app.test/pay/${session.token}`);
    expect(session.amountMinor).toBe(order.totalMinor); // defaults to what is due

    const view = await t.http.get(`/v1/public/pay/${session.token}`);
    expect(view.status).toBe(200);
    expect(view.body).toMatchObject({ status: 'open', purpose: 'order', amountMinor: order.totalMinor, currency: 'EGP', sandbox: true });
    expect(view.body.methods.map((m: any) => m.method)).toEqual(['card', 'wallet', 'cod']);
    expect(view.body.items).toEqual([{ name: 'Fries', nameAr: null, quantity: 2, totalMinor: 9000 }]);

    const start = await t.http.post(`/v1/public/pay/${session.token}/start`).send({ method: 'card', payerName: 'Mona' });
    expect(start.body).toMatchObject({ kind: 'redirect', sandbox: true });
    expect(start.body.redirectUrl).toMatch(new RegExp(`^http://app.test/pay/${session.token}/sandbox\\?session=sim_cs_`));

    // Returning from the provider (or a forged return URL) never marks anything paid.
    const back = await t.http.post(`/v1/public/pay/${session.token}/refresh?status=paid&success=true`);
    expect(back.body.status).toBe('processing');
    let [o] = await sql(`select status, payment_status, paid_minor from orders where id = $1`, [order.id]);
    expect(o).toEqual({ status: 'awaiting_payment', payment_status: 'unpaid', paid_minor: 0 });

    const sb = await t.http.get(`/v1/public/pay/${session.token}/sandbox`);
    expect(sb.body).toMatchObject({ sandbox: true, label: 'Sandbox — no money moves', providerSession: { status: 'open', amountMinor: order.totalMinor } });

    const done = await t.http.post(`/v1/public/pay/${session.token}/sandbox/complete`).send({ outcome: 'success' });
    expect(done.body.status).toBe('paid');
    [o] = await sql(`select status, payment_status, paid_minor from orders where id = $1`, [order.id]);
    expect(o).toEqual({ status: 'placed', payment_status: 'paid', paid_minor: order.totalMinor });
    const [inbox] = await sql(`select status, signature_valid, org_id from webhook_inbox where provider = 'payments:simulated' and org_id = $1 order by received_at desc limit 1`, [tenant.orgId]);
    expect(inbox).toEqual({ status: 'processed', signature_valid: true, org_id: tenant.orgId });
    const [payment] = await sql(`select status, is_test, provider, provider_payment_id from payments where checkout_session_id = $1`, [session.id]);
    expect(payment).toMatchObject({ status: 'succeeded', is_test: true, provider: 'simulated' });
    expect(payment.provider_payment_id).toMatch(/^sim_pay_/);

    const receipt = await t.http.get(`/v1/public/pay/${session.token}/receipt`);
    expect(receipt.status).toBe(200);
    expect(receipt.body).toMatchObject({ kind: 'order', status: 'paid', amountMinor: order.totalMinor, payment: { provider: 'simulated', mode: 'test' } });
    expect(receipt.body.id).toMatch(/^RC-/);
    // Starting again after payment is a no-op.
    expect((await t.http.post(`/v1/public/pay/${session.token}/start`).send({ method: 'card' })).body.kind).toBe('paid');
  });

  it('treats duplicate webhooks as no-ops and rejects bad or stale signatures', async () => {
    const order = await placeOrder([{ productId: menu.products.soda, quantity: 2 }]);
    const session = await createSession({ purpose: 'order', orderId: order.id, channel: 'web' });
    await t.http.post(`/v1/public/pay/${session.token}/start`).send({ method: 'card' }).expect(200);
    const attempt = await pendingAttempt(session.id);
    const hook = (await sandbox.settle(tenant.orgId, attempt.provider_session_id, 'success'))!;
    const send = (raw: string, headers: Record<string, string>) => t.http.post(`/v1/webhooks/payments/simulated?c=${tenant.orgId}`).set(headers).send(raw);

    const first = await send(hook.raw, hook.headers);
    expect(first.status).toBe(200);
    expect(first.body).toEqual({ received: true, outcome: 'applied' });
    const second = await send(hook.raw, hook.headers);
    expect(second.body).toEqual({ received: true, duplicate: true });
    const allocations = await sql(`select sum(a.amount_minor)::int as s from payment_allocations a where a.order_id = $1`, [order.id]);
    expect(allocations[0].s).toBe(order.totalMinor);
    expect((await sql(`select count(*)::int as n from payments where order_id = $1`, [order.id]))[0].n).toBe(1);

    // Tampered body → 401, stored as rejected; never applied.
    const tampered = hook.raw.replace(`"amount_minor":${order.totalMinor}`, '"amount_minor":1');
    const bad = await send(tampered, hook.headers);
    expect(bad.status).toBe(401);
    expect(bad.body.error.code).toBe('invalid_signature');
    const [rej] = await sql(`select status, signature_valid from webhook_inbox where provider = 'payments:simulated' and event_key = $1`, [`rejected:${sha256(tampered)}`]);
    expect(rej).toEqual({ status: 'rejected', signature_valid: false });

    // A correctly signed but stale delivery (replay outside the 300 s window) is rejected too.
    const stale = await sandbox.signedWebhook(tenant.orgId, JSON.parse(hook.raw), Math.floor(Date.now() / 1000) - 600);
    expect((await send(stale.raw, stale.headers)).status).toBe(401);
    // Unsigned / unknown merchant.
    expect((await t.http.post('/v1/webhooks/payments/simulated').send({ id: 'x', data: {} })).status).toBe(401);
    expect((await t.http.post('/v1/webhooks/payments/unknownpay').send({})).status).toBe(404);
  });

  it('records and alerts an amount mismatch without applying it', async () => {
    const order = await placeOrder([{ productId: menu.products.fries, quantity: 1 }]);
    const session = await createSession({ purpose: 'order', orderId: order.id, channel: 'web' });
    await t.http.post(`/v1/public/pay/${session.token}/start`).send({ method: 'card' }).expect(200);
    const attempt = await pendingAttempt(session.id);
    const forged = await sandbox.signedWebhook(tenant.orgId, {
      id: `evt_sim_${token()}`, type: 'payment.succeeded', created: Math.floor(Date.now() / 1000), livemode: false,
      data: { session_id: attempt.provider_session_id, payment_id: 'sim_pay_mismatch', reference: attempt.id, amount_minor: order.totalMinor - 100, currency: 'EGP', fee_minor: 0 },
    });
    const res = await t.http.post(`/v1/webhooks/payments/simulated?c=${tenant.orgId}`).set(forged.headers).send(forged.raw);
    expect(res.status).toBe(200);
    expect(res.body.outcome).toBe('amount_mismatch');
    const [p] = await sql(`select status, failure_reason from payments where id = $1`, [attempt.id]);
    expect(p).toEqual({ status: 'failed', failure_reason: 'amount_or_currency_mismatch' });
    const [o] = await sql(`select paid_minor, payment_status from orders where id = $1`, [order.id]);
    expect(o).toEqual({ paid_minor: 0, payment_status: 'unpaid' });
    const [alert] = await sql(`select kind, status, details from payment_alerts where payment_id = $1`, [attempt.id]);
    expect(alert).toMatchObject({ kind: 'amount_mismatch', status: 'open', details: { received: { amountMinor: order.totalMinor - 100 } } });
    const [inbox] = await sql(`select status, error from webhook_inbox where provider = 'payments:simulated' and payload->'body'->>'id' = $1`, [JSON.parse(forged.raw).id]);
    expect(inbox).toEqual({ status: 'ignored', error: 'amount_mismatch' });
    // The session is usable again; staff see the alert.
    expect((await t.http.get(`/v1/public/pay/${session.token}`)).body.status).toBe('open');
    const alerts = await t.http.get(`/v1/o/${tenant.orgId}/payments/alerts`).set(auth(tenant.owner));
    expect(alerts.body.items.some((a: any) => a.paymentId === attempt.id && a.kind === 'amount_mismatch')).toBe(true);
  });

  it('a declined sandbox payment fails the attempt and lets the guest retry', async () => {
    const order = await placeOrder([{ productId: menu.products.soda, quantity: 1 }]);
    const session = await createSession({ purpose: 'order', orderId: order.id, channel: 'web' });
    const { view } = await payViaSandbox(session.token, 'failure');
    expect(view.status).toBe('open');
    expect(view.attempt).toMatchObject({ status: 'failed', failureReason: 'sandbox_declined_by_tester' });
    const retry = await payViaSandbox(session.token, 'success');
    expect(retry.view.status).toBe('paid');
  });

  it('switching method supersedes the earlier attempt; offline methods never create a payment', async () => {
    const order = await placeOrder([{ productId: menu.products.fries, quantity: 1 }]);
    const session = await createSession({ purpose: 'order', orderId: order.id, channel: 'web' });
    await t.http.post(`/v1/public/pay/${session.token}/start`).send({ method: 'card' }).expect(200);
    const first = await pendingAttempt(session.id);
    // Resuming with the same method returns the same provider session.
    const again = await t.http.post(`/v1/public/pay/${session.token}/start`).send({ method: 'card' });
    expect(again.body.paymentId).toBe(first.id);
    const cash = await t.http.post(`/v1/public/pay/${session.token}/start`).send({ method: 'cash' });
    expect(cash.body).toMatchObject({ kind: 'offline', sandbox: false });
    expect(cash.body.instructions).toMatch(/counter/);
    const [old] = await sql(`select status, failure_reason from payments where id = $1`, [first.id]);
    expect(old).toEqual({ status: 'cancelled', failure_reason: 'superseded_by_new_attempt' });
    expect((await sql(`select count(*)::int as n from payments where order_id = $1 and status = 'pending'`, [order.id]))[0].n).toBe(0);
    // A late success for the cancelled attempt is alerted, never applied.
    const late = await sandbox.settle(tenant.orgId, first.provider_session_id, 'success');
    const res = await t.http.post(`/v1/webhooks/payments/simulated?c=${tenant.orgId}`).set(late!.headers).send(late!.raw);
    expect(res.body.outcome).toBe('late_success');
    expect((await sql(`select paid_minor from orders where id = $1`, [order.id]))[0].paid_minor).toBe(0);
    expect((await t.http.post(`/v1/public/pay/${session.token}/start`).send({ method: 'deposit_credit' })).status).toBe(400);
  });

  it('verifies real-provider webhooks with the merchant connection secret (Stripe, sandbox connection)', async () => {
    const box = t.app.get(SecretBox);
    const [conn] = await sql(
      `insert into integration_connections(org_id, provider, category, auth_type, environment, status, credentials_encrypted, credentials_hint)
       values ($1, 'stripe', 'payments', 'api_key', 'sandbox', 'connected', $2, 'sk_test_…0000') returning id`,
      [tenant.orgId, box.sealJson({ secretKey: 'sk_test_0000', webhookSecret: 'whsec_merchant_1' })]);
    const order = await placeOrder([{ productId: menu.products.fries, quantity: 1 }]);
    // An attempt as CheckoutService would have created it before redirecting to Stripe.
    const pending = await db.scoped(ctx, (tx) => t.app.get(PaymentLedgerService).createPending(tx, ctx, {
      branchId: tenant.branchId, orderId: order.id, method: 'card', provider: 'stripe', connectionId: conn.id, amountMinor: order.totalMinor, currency: 'EGP', isTest: true,
    }));
    await sql(`insert into payment_attempt_refs(payment_id, org_id, provider, provider_session_id, redirect_url) values ($1, $2, 'stripe', 'cs_test_abc', 'https://checkout.stripe.com/c/pay/cs_test_abc')`, [pending.id, tenant.orgId]);
    const raw = JSON.stringify({ id: `evt_${token()}`, type: 'checkout.session.completed', data: { object: {
      id: 'cs_test_abc', amount_total: order.totalMinor, currency: 'egp', payment_status: 'paid', payment_intent: 'pi_test_abc', client_reference_id: pending.id } } });
    const sig = signStripe('whsec_merchant_1', raw, Math.floor(Date.now() / 1000));
    const wrong = signStripe('whsec_other', raw, Math.floor(Date.now() / 1000));
    expect((await t.http.post('/v1/webhooks/payments/stripe').set({ 'stripe-signature': wrong, 'content-type': 'application/json' }).send(raw)).status).toBe(401);
    // Without ?c= the connection is found from the attempt; the secret is the merchant's.
    const ok = await t.http.post('/v1/webhooks/payments/stripe').set({ 'stripe-signature': sig, 'content-type': 'application/json' }).send(raw);
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.outcome).toBe('applied');
    const [p] = await sql(`select status, provider_payment_id from payments where id = $1`, [pending.id]);
    expect(p).toEqual({ status: 'succeeded', provider_payment_id: 'pi_test_abc' });
    // Live connections are ignored while PAYMENT_MODE=sandbox.
    await sql(`update integration_connections set environment = 'live' where id = $1`, [conn.id]);
    const again = JSON.stringify({ ...JSON.parse(raw), id: `evt_${token()}` });
    expect((await t.http.post(`/v1/webhooks/payments/stripe?c=${conn.id}`).set({ 'stripe-signature': signStripe('whsec_merchant_1', again, Math.floor(Date.now() / 1000)), 'content-type': 'application/json' }).send(again)).status).toBe(401);
    await sql(`delete from integration_connections where id = $1`, [conn.id]).catch(() => undefined);
  });

  it('expires sessions and their abandoned attempts', async () => {
    const order = await placeOrder([{ productId: menu.products.soda, quantity: 1 }]);
    const session = await createSession({ purpose: 'order', orderId: order.id, channel: 'web' });
    await t.http.post(`/v1/public/pay/${session.token}/start`).send({ method: 'card' }).expect(200);
    const attempt = await pendingAttempt(session.id);
    await sql(`update checkout_sessions set expires_at = now() - interval '1 hour' where id = $1`, [session.id]);
    await sql(`update payments set created_at = now() - interval '2 hours' where id = $1`, [attempt.id]);
    await t.app.get(CheckoutService).expireDue();
    expect((await sql(`select status from checkout_sessions where id = $1`, [session.id]))[0].status).toBe('expired');
    expect((await sql(`select status from payments where id = $1`, [attempt.id]))[0].status).toBe('expired');
    const res = await t.http.post(`/v1/public/pay/${session.token}/start`).send({ method: 'card' });
    expect(res.status).toBe(410);
    expect((await t.http.get('/v1/public/pay/not-a-real-token-at-all-xx')).status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
describe('table bill payment and splits', () => {
  it('shows the bill for the visit token, pays it in full and issues a receipt', async () => {
    const v = await openVisit([[{ productId: menu.products.fries, quantity: 2 }], [{ productId: menu.products.soda, quantity: 1 }]]);
    const bill = await t.http.get('/v1/public/payments/visit/bill').set('X-Visit-Token', v.visitToken);
    expect(bill.status).toBe(200);
    expect(bill.body.totals).toEqual({ totalMinor: 11500, paidMinor: 0, creditMinor: 0, dueMinor: 11500 });
    expect(bill.body.orders).toHaveLength(2);
    expect(JSON.stringify(bill.body)).not.toContain('qr-'); // QR tokens are never returned
    expect((await t.http.get('/v1/public/payments/visit/bill')).status).toBe(401);
    expect((await t.http.get('/v1/public/payments/visit/bill').set('X-Visit-Token', token())).status).toBe(404);

    const k = key();
    const c1 = await t.http.post('/v1/public/payments/visit/checkout').set('X-Visit-Token', v.visitToken).send({ key: k });
    const c2 = await t.http.post('/v1/public/payments/visit/checkout').set('X-Visit-Token', v.visitToken).send({ key: k });
    expect(c1.status).toBe(200);
    expect(c2.body).toEqual(c1.body); // idempotent retry returns the same link
    expect(c1.body.amountMinor).toBe(11500);
    const checkoutToken = c1.body.url.split('/pay/')[1];
    await payViaSandbox(checkoutToken);
    const after = await t.http.get('/v1/public/payments/visit/bill').set('X-Visit-Token', v.visitToken);
    expect(after.body.totals.dueMinor).toBe(0);
    expect(after.body.receipts).toHaveLength(1);
    const receipt = await t.http.get(`/v1/public/payments/visit/receipts/${after.body.receipts[0].paymentId}`).set('X-Visit-Token', v.visitToken);
    expect(receipt.body).toMatchObject({ kind: 'bill', totals: { totalMinor: 11500, dueMinor: 0 } });
    expect(receipt.body.items).toEqual([
      { name: 'Fries', nameAr: null, unitPriceMinor: 4500, quantity: 2, totalMinor: 9000 },
      { name: 'Soda', nameAr: null, unitPriceMinor: 2500, quantity: 1, totalMinor: 2500 },
    ]);
  });

  it('splits equally (largest remainder) and settles the split as shares are paid', async () => {
    const v = await openVisit([[{ productId: menu.products.fries, quantity: 1 }, { productId: menu.products.soda, quantity: 2 }]]); // 9500
    const split = await t.http.post('/v1/public/payments/visit/split').set('X-Visit-Token', v.visitToken).send({ mode: 'equal', people: 3, key: key() });
    expect(split.status, JSON.stringify(split.body)).toBe(200);
    expect(split.body.shares.map((s: any) => s.amountMinor)).toEqual([3167, 3167, 3166]);
    expect(split.body.shares.every((s: any) => /^http:\/\/app\.test\/s\/[A-Za-z0-9_-]{20,}$/.test(s.url))).toBe(true);
    // The split is returned again while open; full-bill checkout is refused.
    const again = await t.http.post('/v1/public/payments/visit/split').set('X-Visit-Token', v.visitToken).send({ mode: 'equal', people: 2, key: key() });
    expect(again.body.id).toBe(split.body.id);
    expect((await t.http.post('/v1/public/payments/visit/checkout').set('X-Visit-Token', v.visitToken).send({ key: key() })).body.error.code).toBe('split_active');

    for (const [i, share] of split.body.shares.entries()) {
      const shareToken = share.url.split('/s/')[1];
      const view = await t.http.get(`/v1/public/payments/shares/${shareToken}`);
      expect(view.body).toMatchObject({ amountMinor: share.amountMinor, status: 'open', participants: 3, paidCount: i });
      const co = await t.http.post(`/v1/public/payments/shares/${shareToken}/checkout`).send({ payerName: `Friend ${i}`, key: key() });
      expect(co.body.amountMinor).toBe(share.amountMinor);
      await payViaSandbox(co.body.url.split('/pay/')[1]);
      expect((await t.http.get(`/v1/public/payments/shares/${shareToken}`)).body.status).toBe('paid');
      const r = await t.http.get(`/v1/public/payments/shares/${shareToken}/receipt`);
      expect(r.body).toMatchObject({ kind: 'share', split: { yourShareMinor: share.amountMinor, participants: 3, paidCount: i + 1, mode: 'equal' } });
    }
    const [s] = await sql(`select status from bill_splits where id = $1`, [split.body.id]);
    expect(s.status).toBe('settled');
    const [o] = await sql(`select paid_minor, payment_status from orders where id = $1`, [v.orders[0]!.id]);
    expect(o).toEqual({ paid_minor: 9500, payment_status: 'paid' });
  });

  it('validates custom splits and splits by item exactly once per unit', async () => {
    const v = await openVisit([[{ productId: menu.products.fries, quantity: 2 }, { productId: menu.products.soda, quantity: 1 }]]); // 11500
    const post = (body: Record<string, unknown>) => t.http.post('/v1/public/payments/visit/split').set('X-Visit-Token', v.visitToken).send({ key: key(), ...body });
    const bad = await post({ mode: 'custom', amounts: [5000, 6000] });
    expect(bad.status).toBe(422);
    expect(bad.body.error.message).toMatch(/add up/);
    expect((await post({ mode: 'equal', people: 21 })).status).toBe(400);
    const bill = await t.http.get('/v1/public/payments/visit/bill').set('X-Visit-Token', v.visitToken);
    const fries = bill.body.orders[0].lines.find((l: any) => l.name === 'Fries');
    const soda = bill.body.orders[0].lines.find((l: any) => l.name === 'Soda');
    const twice = await post({ mode: 'items', allocations: [{ items: [{ lineId: fries.id, unit: 0 }] }, { items: [{ lineId: fries.id, unit: 0 }, { lineId: soda.id, unit: 0 }] }] });
    expect(twice.status).toBe(422);
    expect(twice.body.error.message).toMatch(/exactly once/);
    const ok = await post({ mode: 'items', allocations: [
      { label: 'Ali', items: [{ lineId: fries.id, unit: 0 }, { lineId: soda.id, unit: 0 }] },
      { label: 'Sara', items: [{ lineId: fries.id, unit: 1 }] },
    ] });
    expect(ok.status).toBe(200);
    expect(ok.body.shares.map((s: any) => [s.label, s.amountMinor])).toEqual([['Ali', 7000], ['Sara', 4500]]);
    expect(ok.body.shares[0].items.map((i: any) => i.name).sort()).toEqual(['Fries', 'Soda']);
    // Nothing paid yet: the split can be cancelled and replaced with a custom one.
    expect((await t.http.post('/v1/public/payments/visit/split/cancel').set('X-Visit-Token', v.visitToken)).status).toBe(200);
    const custom = await post({ mode: 'custom', amounts: [2500, 9000], labels: ['A', 'B'] });
    expect(custom.body.shares.map((s: any) => s.amountMinor)).toEqual([2500, 9000]);
  });

  it('applies reservation deposit credit once before splitting', async () => {
    const v = await openVisit([[{ productId: menu.products.fries, quantity: 2 }]]); // 9000
    await sql(`update visits set credit_minor = 3000 where id = $1`, [v.visitId]);
    const bill = await t.http.get('/v1/public/payments/visit/bill').set('X-Visit-Token', v.visitToken);
    expect(bill.body.totals).toMatchObject({ creditMinor: 3000, dueMinor: 6000 });
    const split = await t.http.post('/v1/public/payments/visit/split').set('X-Visit-Token', v.visitToken).send({ mode: 'equal', people: 2, key: key() });
    expect(split.body.totalMinor).toBe(6000);
    const credits = await sql(`select amount_minor from payments where visit_id = $1 and method = 'deposit_credit'`, [v.visitId]);
    expect(credits).toEqual([{ amount_minor: 3000 }]);
  });

  it('blocks overpayment when cash and online race for the same bill', async () => {
    const v = await openVisit([[{ productId: menu.products.fries, quantity: 2 }, { productId: menu.products.soda, quantity: 2 }]]); // 14000
    const link = await t.http.post('/v1/public/payments/visit/checkout').set('X-Visit-Token', v.visitToken).send({ key: key(), amountMinor: 10000 });
    const checkoutToken = link.body.url.split('/pay/')[1];
    await t.http.post(`/v1/public/pay/${checkoutToken}/start`).send({ method: 'card' }).expect(200);
    const collect = (amountMinor: number, k = key()) => t.http.post(`/v1/o/${tenant.orgId}/payments/collect`).set(auth(waiter)).send({ visitId: v.visitId, method: 'cash', amountMinor, key: k });
    // The pending online attempt reserves 10000 of the 14000.
    const over = await collect(4001);
    expect(over.status).toBe(409);
    expect(over.body.error).toMatchObject({ code: 'overpayment', details: { dueMinor: 4000 } });
    const k = key();
    const ok = await collect(4000, k);
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    expect((await collect(4000, k)).body.id).toBe(ok.body.id); // idempotent retry
    // Online completes for its reserved share; the bill is settled exactly once.
    await t.http.post(`/v1/public/pay/${checkoutToken}/sandbox/complete`).send({ outcome: 'success' }).expect(200);
    const [o] = await sql(`select paid_minor, payment_status from orders where id = $1`, [v.orders[0]!.id]);
    expect(o).toEqual({ paid_minor: 14000, payment_status: 'paid' });
    expect((await collect(1)).status).toBe(409);
  });
});

// ---------------------------------------------------------------------------
describe('reservation deposits', () => {
  it('confirms the reservation once the deposit is verified', async () => {
    const accessToken = token();
    const [r] = await sql(
      `insert into reservations(org_id, branch_id, guest_name, party_size, starts_at, ends_at, blocked_until, status, hold_expires_at, deposit_minor, deposit_status, access_token_hash)
       values ($1, $2, 'Layla', 4, now() + interval '2 days', now() + interval '2 days 90 minutes', now() + interval '2 days 105 minutes', 'pending_deposit',
               now() + interval '20 minutes', 20000, 'required', $3) returning id, code`, [tenant.orgId, tenant.branchId, sha256(accessToken)]);
    expect((await t.http.post(`/v1/public/payments/reservations/${r.code}/checkout`).send({ token: token() })).status).toBe(404);
    const res = await t.http.post(`/v1/public/payments/reservations/${r.code}/checkout`).send({ token: accessToken });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.amountMinor).toBe(20000);
    const checkoutToken = res.body.url.split('/pay/')[1];
    const view = await t.http.get(`/v1/public/pay/${checkoutToken}`);
    expect(view.body.methods.map((m: any) => m.method)).toEqual(['card', 'wallet']); // deposits are online only
    await payViaSandbox(checkoutToken);
    const [after] = await sql(`select status, deposit_status from reservations where id = $1`, [r.id]);
    expect(after).toEqual({ status: 'confirmed', deposit_status: 'paid' });
    const receipt = await t.http.get(`/v1/public/pay/${checkoutToken}/receipt`);
    expect(receipt.body).toMatchObject({ kind: 'deposit', reference: { reservation: `RSV-${r.code}` }, reservation: { partySize: 4, guestName: 'Layla' } });
    // A second deposit checkout is refused.
    expect((await t.http.post(`/v1/public/payments/reservations/${r.code}/checkout`).send({ token: accessToken })).body.error.code).toBe('deposit_not_required');
  });

  it('expires deposit links when the reservation is cancelled', async () => {
    const accessToken = token();
    const [r] = await sql(
      `insert into reservations(org_id, branch_id, guest_name, party_size, starts_at, ends_at, blocked_until, status, hold_expires_at, deposit_minor, deposit_status, access_token_hash)
       values ($1, $2, 'Omar', 2, now() + interval '3 days', now() + interval '3 days 90 minutes', now() + interval '3 days 105 minutes', 'pending_deposit',
               now() + interval '20 minutes', 15000, 'required', $3) returning id, code`, [tenant.orgId, tenant.branchId, sha256(accessToken)]);
    const res = await t.http.post(`/v1/public/payments/reservations/${r.code}/checkout`).send({ token: accessToken });
    const checkoutToken = res.body.url.split('/pay/')[1];
    await t.http.post(`/v1/public/pay/${checkoutToken}/start`).send({ method: 'card' }).expect(200);
    await sql(`update reservations set status = 'cancelled' where id = $1`, [r.id]);
    await t.app.get(CheckoutService).onReservationCancelled({ id: 'e', orgId: tenant.orgId, type: 'reservation.cancelled', aggregateType: 'reservation', aggregateId: r.id, payload: {}, createdAt: '' });
    expect((await t.http.get(`/v1/public/pay/${checkoutToken}`)).body.status).toBe('expired');
    expect((await sql(`select status from payments where reservation_id = $1`, [r.id]))[0].status).toBe('cancelled');
  });
});

// ---------------------------------------------------------------------------
describe('staff payments, refunds and permissions', () => {
  it('refunds through the provider and applies the ledger only after success', async () => {
    const order = await placeOrder([{ productId: menu.products.fries, quantity: 2 }]);
    const session = await createSession({ purpose: 'order', orderId: order.id, channel: 'web' });
    await payViaSandbox(session.token);
    const [p] = await sql(`select id, provider_payment_id from payments where checkout_session_id = $1 and status = 'succeeded'`, [session.id]);
    const k = key();
    const refund = (u: TestUser, amountMinor: number, kk = k) => t.http.post(`/v1/o/${tenant.orgId}/payments/${p.id}/refunds`).set(auth(u)).send({ amountMinor, reason: 'Cold fries', key: kk });
    expect((await refund(waiter, 1000)).status).toBe(403); // waiters cannot refund
    const r1 = await refund(tenant.owner, 3000);
    expect(r1.status, JSON.stringify(r1.body)).toBe(201);
    expect(r1.body).toMatchObject({ status: 'succeeded', amountMinor: 3000, provider: 'simulated' });
    expect((await refund(tenant.owner, 3000)).body.id).toBe(r1.body.id); // idempotent retry
    expect((await refund(tenant.owner, 2999)).body.error.code).toBe('idempotency_key_reused');
    expect((await refund(tenant.owner, 6001, key())).body.error.code).toBe('refund_exceeds_payment');
    const [o] = await sql(`select refunded_minor, payment_status from orders where id = $1`, [order.id]);
    expect(o).toEqual({ refunded_minor: 3000, payment_status: 'partially_refunded' });
    const [sbx] = await sql(`select refunded_minor, status from payment_sandbox_transactions where provider_payment_id = $1`, [p.provider_payment_id]);
    expect(sbx).toEqual({ refunded_minor: 3000, status: 'partially_refunded' });
    const detail = await t.http.get(`/v1/o/${tenant.orgId}/payments/${p.id}`).set(auth(tenant.owner));
    expect(detail.body).toMatchObject({ status: 'partially_refunded', refundableMinor: 6000, refundMode: 'provider' });
    expect(detail.body.allocations.map((a: any) => [a.kind, a.amountMinor])).toEqual([['payment', 9000], ['refund', -3000]]);
  });

  it('cash refunds require manual completion with instructions', async () => {
    const order = await placeOrder([{ productId: menu.products.soda, quantity: 2 }]);
    const pay = await t.http.post(`/v1/o/${tenant.orgId}/payments/collect`).set(auth(cashier)).send({ orderId: order.id, method: 'cash', amountMinor: 5000, key: key() });
    expect(pay.status, JSON.stringify(pay.body)).toBe(201);
    expect(pay.body).toMatchObject({ status: 'succeeded', method: 'cash', provider: 'manual', receivedBy: cashier.userId });
    const r = await t.http.post(`/v1/o/${tenant.orgId}/payments/${pay.body.id}/refunds`).set(auth(tenant.owner)).send({ amountMinor: 2500, reason: 'Wrong item', key: key() });
    expect(r.body).toMatchObject({ status: 'manual_required' });
    expect(r.body.instructions).toMatch(/Return .*25.* in cash/);
    expect((await sql(`select refunded_minor from orders where id = $1`, [order.id]))[0].refunded_minor).toBe(0);
    const done = await t.http.post(`/v1/o/${tenant.orgId}/payments/refunds/${r.body.id}/complete`).set(auth(tenant.owner)).send({ note: 'handed back' });
    expect(done.body.status).toBe('succeeded');
    expect((await sql(`select refunded_minor from orders where id = $1`, [order.id]))[0].refunded_minor).toBe(2500);
    const audit = await sql(`select action from audit_logs where org_id = $1 and entity_id = $2 order by id`, [tenant.orgId, r.body.id]);
    expect(audit.map((a) => a.action)).toEqual(['refund.requested', 'refund.completed_manually']);
    const receipt = await t.http.get(`/v1/o/${tenant.orgId}/payments/${pay.body.id}/receipt`).set(auth(accountant));
    expect(receipt.body).toMatchObject({ status: 'partially_refunded', refundedMinor: 2500, payment: { method: 'cash', mode: 'live' } });
  });

  it('validates collection input and enforces permissions, tenancy and entitlements', async () => {
    const order = await placeOrder([{ productId: menu.products.soda, quantity: 1 }]);
    const url = `/v1/o/${tenant.orgId}/payments`;
    expect((await t.http.post(`${url}/collect`).set(auth(cashier)).send({ method: 'cash', amountMinor: 100, key: key() })).status).toBe(400);
    expect((await t.http.post(`${url}/collect`).set(auth(cashier)).send({ orderId: order.id, method: 'instapay', amountMinor: 100, key: key() })).status).toBe(400);
    expect((await t.http.post(`${url}/collect`).set(auth(cashier)).send({ orderId: order.id, method: 'cod', amountMinor: 100, key: key() })).body.error.code).toBe('cod_requires_delivery');
    expect((await t.http.get(url).set(auth(waiter))).status).toBe(403);           // waiter: collect yes, read no
    expect((await t.http.post(`${url}/reconciliation/runs`).set(auth(cashier)).send({})).status).toBe(403);
    const list = await t.http.get(`${url}?limit=5`).set(auth(accountant));
    expect(list.status).toBe(200);
    expect(list.body.items.length).toBeLessThanOrEqual(5);
    const someId = list.body.items[0].id;

    const other = await createTenant(t, { country: 'SA' });
    expect((await t.http.get(`${url}/${someId}`).set(auth(other.owner))).status).toBe(404);
    expect((await t.http.get(`/v1/o/${other.orgId}/payments/${someId}`).set(auth(other.owner))).status).toBe(404);

    const free = await createTenant(t, { planId: 'free' });
    const denied = await t.http.get(`/v1/o/${free.orgId}/payments`).set(auth(free.owner));
    expect(denied.status).toBe(402);
    expect(denied.body.error.code).toBe('module_not_entitled');
    const freeMenu = await seedMenu(free);
    const freeCtx = new TenantContext(free.orgId, 'owner', null, free.owner.userId, 'user', free.owner.userId);
    const freeOrder = await db.scoped(freeCtx, (tx) => orders.place(tx, freeCtx, { branchId: free.branchId, channel: 'staff', fulfillment: 'pickup', lines: [{ productId: freeMenu.products.soda, quantity: 1 }] }));
    await expect(db.scoped(freeCtx, (tx) => port.createSession(tx, freeCtx, { purpose: 'order', orderId: freeOrder.id, channel: 'web' }))).rejects.toMatchObject({ status: 402 });
    const visitToken = token();
    await sql(`insert into visits(org_id, branch_id, table_id, guest_token_hash) values ($1, $2, $3, $4)`, [free.orgId, free.branchId, freeMenu.tableId, sha256(visitToken)]);
    expect((await t.http.get('/v1/public/payments/visit/bill').set('X-Visit-Token', visitToken)).status).toBe(402);
  });

  it('creates, lists and cancels staff payment links', async () => {
    const order = await placeOrder([{ productId: menu.products.fries, quantity: 1 }]);
    const res = await t.http.post(`/v1/o/${tenant.orgId}/payments/links`).set(auth(tenant.owner))
      .send({ orderId: order.id, amountMinor: 2000, allowedMethods: ['card'], expiresInMinutes: 60, key: key() });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body).toMatchObject({ purpose: 'payment_link', amountMinor: 2000, status: 'open', allowedMethods: ['card'] });
    const linkToken = res.body.url.split('/pay/')[1];
    expect((await t.http.get(`/v1/public/pay/${linkToken}`)).body.methods.map((m: any) => m.method)).toEqual(['card']);
    const over = await t.http.post(`/v1/o/${tenant.orgId}/payments/links`).set(auth(tenant.owner)).send({ orderId: order.id, amountMinor: 999999, key: key() });
    expect(over.body.error.code).toBe('overpayment');
    const list = await t.http.get(`/v1/o/${tenant.orgId}/payments/links`).set(auth(accountant));
    expect(list.body.items.find((l: any) => l.id === res.body.id).url).toBe(res.body.url);
    await t.http.post(`/v1/o/${tenant.orgId}/payments/links/${res.body.id}/cancel`).set(auth(tenant.owner)).expect(201);
    expect((await t.http.post(`/v1/public/pay/${linkToken}/start`).send({ method: 'card' })).status).toBe(410);
  });
});

// ---------------------------------------------------------------------------
describe('reconciliation', () => {
  it('reconciles sandbox provider records and settlement statements', async () => {
    const recon = await createTenant(t, { country: 'EG' });
    const rmenu = await seedMenu(recon);
    const rctx = new TenantContext(recon.orgId, 'owner', null, recon.owner.userId, 'user', recon.owner.userId);
    const paid: Array<{ id: string; ppid: string; amount: number }> = [];
    for (const qty of [1, 2]) {
      const o = await db.scoped(rctx, (tx) => orders.place(tx, rctx, { branchId: recon.branchId, channel: 'web', fulfillment: 'pickup', lines: [{ productId: rmenu.products.fries, quantity: qty }] }));
      const s = await db.scoped(rctx, (tx) => port.createSession(tx, rctx, { purpose: 'order', orderId: o.id, channel: 'web' }));
      await payViaSandbox(s.token);
      const [p] = await sql(`select id, provider_payment_id, amount_minor from payments where checkout_session_id = $1 and status = 'succeeded'`, [s.id]);
      paid.push({ id: p.id, ppid: p.provider_payment_id, amount: p.amount_minor });
    }
    const from = new Date(Date.now() - 3600_000).toISOString(), to = new Date(Date.now() + 3600_000).toISOString();
    const url = `/v1/o/${recon.orgId}/payments/reconciliation/runs`;
    const run = await t.http.post(url).set(auth(recon.owner)).send({ provider: 'simulated', from, to, source: 'provider_api' });
    expect(run.status, JSON.stringify(run.body)).toBe(201);
    expect(run.body).toMatchObject({ source: 'sandbox', totals: { items: 2, matched: 2, expectedMinor: 13500, actualMinor: 13500, differenceMinor: 0 } });

    // A provider-side transaction Resuto never recorded.
    await sql(`insert into payment_sandbox_transactions(org_id, provider_session_id, provider_payment_id, reference, amount_minor, currency, status, completed_at)
               values ($1, $2, $3, 'external', 7700, 'EGP', 'succeeded', now())`, [recon.orgId, `sim_cs_${token()}`, `sim_pay_${token()}`]);
    const run2 = await t.http.post(url).set(auth(recon.owner)).send({ provider: 'simulated', from, to, source: 'provider_api' });
    expect(run2.body.totals).toMatchObject({ matched: 2, missingInResuto: 1 });

    // Settlement CSV: first payment at a different amount, second missing, one unknown.
    const csv = `transaction_id,amount,currency,status,fee\n${paid[0]!.ppid},44.00,EGP,succeeded,1.25\n"sim_pay_unknown",10.00,EGP,paid,0.30\n`;
    const run3 = await t.http.post(url).set(auth(recon.owner)).send({ provider: 'simulated', from, to, source: 'statement_upload', csv });
    expect(run3.status, JSON.stringify(run3.body)).toBe(201);
    expect(run3.body.totals).toMatchObject({ amountMismatch: 1, missingInProvider: 1, missingInResuto: 1, matched: 0, feesMinor: 155 });
    const detail = await t.http.get(`${url}/${run3.body.id}`).set(auth(recon.owner));
    const mismatch = detail.body.items.find((i: any) => i.status === 'amount_mismatch');
    expect(mismatch).toMatchObject({ paymentId: paid[0]!.id, expectedMinor: 4500, actualMinor: 4400, resolution: 'open' });
    const resolved = await t.http.patch(`/v1/o/${recon.orgId}/payments/reconciliation/items/${mismatch.id}`).set(auth(recon.owner)).send({ resolution: 'escalated', notes: 'asked provider' });
    expect(resolved.body.resolution).toBe('escalated');
    expect((await t.http.post(url).set(auth(recon.owner)).send({ provider: 'simulated', from, to, source: 'statement_upload', csv: 'nope\n1' })).status).toBe(422);
    expect((await t.http.post(url).set(auth(recon.owner)).send({ provider: 'stripe', from, to, source: 'provider_api' })).body.error.code).toBe('not_connected');
  });

  it('compares expected cash by method and staff with the counted amounts', async () => {
    const order = await placeOrder([{ productId: menu.products.fries, quantity: 3 }]); // 13500
    const kc = key();
    await t.http.post(`/v1/o/${tenant.orgId}/payments/collect`).set(auth(cashier)).send({ orderId: order.id, method: 'cash', amountMinor: 13500, key: kc }).expect(201);
    const from = new Date(Date.now() - 60_000).toISOString(), to = new Date(Date.now() + 60_000).toISOString();
    const exp = await t.http.get(`/v1/o/${tenant.orgId}/payments/reconciliation/cash/expected`).query({ branchId: tenant.branchId, from, to }).set(auth(accountant));
    expect(exp.status).toBe(200);
    const mine = exp.body.groups.find((g: any) => g.staffId === cashier.userId && g.method === 'cash');
    expect(mine.expectedMinor).toBeGreaterThanOrEqual(13500);
    const count = await t.http.post(`/v1/o/${tenant.orgId}/payments/reconciliation/cash`).set(auth(accountant)).send({
      branchId: tenant.branchId, from, to, counts: [{ method: 'cash', staffId: cashier.userId, countedMinor: mine.expectedMinor - 500 }],
    });
    expect(count.status, JSON.stringify(count.body)).toBe(201);
    expect(count.body).toMatchObject({ source: 'cash_count', provider: 'cash' });
    const detail = await t.http.get(`/v1/o/${tenant.orgId}/payments/reconciliation/runs/${count.body.id}`).set(auth(accountant));
    const item = detail.body.items.find((i: any) => i.dimension.staffId === cashier.userId);
    expect(item).toMatchObject({ status: 'amount_mismatch', expectedMinor: mine.expectedMinor, actualMinor: mine.expectedMinor - 500, notes: 'Difference -500' });
  });
});
