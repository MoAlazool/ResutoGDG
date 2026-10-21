import { pointsFor, pointsToReverse, rewardDiscount } from '@resuto/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TenantContext } from '../src/common/auth/context';
import { DbService } from '../src/common/db/db.service';
import { EventDispatcher } from '../src/common/events/dispatcher.service';
import { OrdersKernelService, type PlaceOrderInput } from '../src/modules/kernel/orders-kernel.service';
import { PaymentLedgerService } from '../src/modules/kernel/payment-ledger.service';
import { LoyaltyHandlers } from '../src/modules/loyalty/loyalty.handlers';
import { LoyaltyService } from '../src/modules/loyalty/loyalty.service';
import { addMember, auth, bootTestApp, createTenant, seedMenu, sql, type SeededMenu, type TestApp, type TestTenant, type TestUser } from './helpers';
import { key, qrTokenFor, saveFloor, table } from './ops-fixtures';

let t: TestApp;
let A: TestTenant;
let B: TestTenant;
let menu: SeededMenu;
let ctx: TenantContext;
let db: DbService;
let kernel: OrdersKernelService;
let ledger: PaymentLedgerService;
let dispatcher: EventDispatcher;
let cashier: TestUser;
let marketing: TestUser;
let rewardId: string;
let percentRewardId: string;
const L = (tt: TestTenant, path: string) => `/v1/o/${tt.orgId}/loyalty${path}`;
let phoneSeq = 0;
const newPhone = () => `+2010${String(7_000_000 + ++phoneSeq).padStart(8, '0')}`;

const PROGRAM = {
  isActive: true, earnMode: 'spend', pointsPerUnit: 1, unitMinor: 1000, stampsPerVisit: 1, rounding: 'floor', minOrderMinor: 0,
  eligibleChannels: null, eligibleBranchIds: null, excludedProductIds: [] as string[], expiryDays: 365,
};

async function place(input: Partial<PlaceOrderInput> & { phone?: string } = {}) {
  const { phone, ...rest } = input;
  return db.scoped(ctx, (tx) => kernel.place(tx, ctx, {
    branchId: A.branchId, channel: 'staff', fulfillment: 'pickup', lines: [{ productId: menu.products.fries, quantity: 2 }],
    customer: phone ? { name: 'Loyal guest', phone } : null, ...rest,
  }));
}
async function pay(orderId: string, amountMinor: number) {
  const p = await db.scoped(ctx, (tx) => ledger.recordSucceeded(tx, ctx, { branchId: A.branchId, orderId, method: 'cash', provider: 'manual', amountMinor, currency: 'EGP' }));
  await dispatcher.drain();
  return p.id as string;
}
const balance = async (customerId: string) => (await t.http.get(L(A, `/customers/${customerId}`)).set(auth(A.owner))).body.balance as number;
const rows = (customerId: string) => sql<{ kind: string; points: number; balance_after: number; order_id: string | null }>(
  `select kind, points, balance_after, order_id from loyalty_ledger where customer_id = $1 order by seq`, [customerId]);

beforeAll(async () => {
  t = await bootTestApp();
  db = t.app.get(DbService);
  kernel = t.app.get(OrdersKernelService);
  ledger = t.app.get(PaymentLedgerService);
  dispatcher = t.app.get(EventDispatcher);
  A = await createTenant(t, { planId: 'pro' });
  B = await createTenant(t, { planId: 'pro' });
  menu = await seedMenu(A);
  ctx = new TenantContext(A.orgId, 'owner', null, A.owner.userId, 'user', A.owner.userId);
  cashier = await addMember(t, A, 'cashier');
  marketing = await addMember(t, A, 'marketing');
  await dispatcher.drain();
});
afterAll(async () => { await t.close(); });

describe('loyalty maths (pure)', () => {
  it('earns per spend with rounding, per visit as stamps, and never negative', () => {
    const rule = { earnMode: 'spend' as const, pointsPerUnit: 1.5, unitMinor: 1000, stampsPerVisit: 1, rounding: 'floor' as const };
    expect(pointsFor(rule, 9999)).toBe(14);
    expect(pointsFor({ ...rule, rounding: 'round' }, 9999)).toBe(15);
    expect(pointsFor({ ...rule, rounding: 'ceil' }, 9001)).toBe(14);
    expect(pointsFor({ ...rule, pointsPerUnit: 0.1, rounding: 'floor' }, 30_000)).toBe(3); // no 2.9999 binary noise
    expect(pointsFor({ ...rule, earnMode: 'visit', stampsPerVisit: 2 }, 50)).toBe(2);
    expect(pointsFor(rule, 0)).toBe(0);
    expect(pointsFor(rule, -5)).toBe(0);
  });
  it('caps reward discounts and reverses refunds proportionally in the customer’s favour', () => {
    expect(rewardDiscount({ kind: 'fixed', value: 5000, maxDiscountMinor: null }, 3000)).toBe(3000);
    expect(rewardDiscount({ kind: 'percent', value: 2500, maxDiscountMinor: 1000 }, 10_000)).toBe(1000);
    expect(rewardDiscount({ kind: 'percent', value: 1000, maxDiscountMinor: null }, 10_005)).toBe(1000);
    expect(pointsToReverse(10, 10_000, 3_333)).toBe(3);
    expect(pointsToReverse(10, 10_000, 10_000)).toBe(10);
    expect(pointsToReverse(10, 10_000, 0)).toBe(0);
  });
});

describe('programme and rewards (staff)', () => {
  it('lets marketing configure rules and rewards; cashiers cannot', async () => {
    const empty = await t.http.get(L(A, '/program')).set(auth(A.owner));
    expect(empty.status).toBe(200);
    expect(empty.body.program).toMatchObject({ isActive: false, earnMode: 'spend', updatedAt: null });
    expect((await t.http.put(L(A, '/program')).set(auth(cashier)).send(PROGRAM)).status).toBe(403);
    const saved = await t.http.put(L(A, '/program')).set(auth(marketing)).send(PROGRAM);
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({ isActive: true, unitMinor: 1000, expiryDays: 365 });
    expect((await t.http.put(L(A, '/program')).set(auth(A.owner)).send({ ...PROGRAM, excludedProductIds: [B.branchId] })).status).toBe(422);
    expect((await t.http.put(L(A, '/program')).set(auth(A.owner)).send({ ...PROGRAM, rounding: 'banker' })).status).toBe(400);
    const r = await t.http.post(L(A, '/rewards')).set(auth(marketing)).send({ name: 'EGP 15 off', nameAr: 'خصم 15 جنيه', pointsCost: 5, kind: 'fixed', value: 1500 });
    expect(r.status).toBe(201);
    rewardId = r.body.id;
    const pr = await t.http.post(L(A, '/rewards')).set(auth(A.owner)).send({ name: '50% off', pointsCost: 50, kind: 'percent', value: 5000, maxDiscountMinor: 2000 });
    percentRewardId = pr.body.id;
    expect((await t.http.post(L(A, '/rewards')).set(auth(A.owner)).send({ name: 'Bad', pointsCost: 1, kind: 'percent', value: 20000 })).status).toBe(400);
    const audit = await sql(`select action from audit_logs where org_id = $1 and action like 'loyalty.%'`, [A.orgId]);
    expect(audit.map((a) => a.action)).toEqual(expect.arrayContaining(['loyalty.program.saved', 'loyalty.reward.created']));
  });
});

describe('earning on paid orders', () => {
  it('earns only once an order is fully paid, once, with the rule applied to eligible spend', async () => {
    const phone = newPhone();
    const o = await place({ phone, lines: [{ productId: menu.products.fries, quantity: 3 }] });
    await dispatcher.drain();
    expect(await rows(o.customerId!)).toEqual([]); // placed but unpaid: nothing
    await pay(o.id, Math.floor(o.totalMinor / 2));
    expect(await rows(o.customerId!)).toEqual([]); // partly paid: nothing
    await pay(o.id, o.totalMinor - Math.floor(o.totalMinor / 2));
    const r = await rows(o.customerId!);
    const expected = Math.floor(o.quote.subtotalMinor / 1000);
    expect(expected).toBeGreaterThan(0);
    expect(r).toEqual([{ kind: 'earn', points: expected, balance_after: expected, order_id: o.id }]);
    // Redelivered order.paid: no second earn.
    await t.app.get(LoyaltyHandlers).onOrderPaid({ id: 'x', orgId: A.orgId, type: 'order.paid', aggregateType: 'order', aggregateId: o.id, payload: {}, createdAt: new Date().toISOString() });
    expect(await rows(o.customerId!)).toHaveLength(1);
    expect(await balance(o.customerId!)).toBe(expected);
    const [{ expires_at }] = await sql(`select expires_at from loyalty_ledger where order_id = $1`, [o.id]);
    expect(new Date(expires_at).getTime()).toBeGreaterThan(Date.now() + 364 * 86_400_000);
  });

  it('honours channel and branch eligibility, minimum order and excluded items', async () => {
    const phone = newPhone();
    await t.http.put(L(A, '/program')).set(auth(A.owner)).send({ ...PROGRAM, eligibleChannels: ['web'] });
    const staff = await place({ phone });
    await pay(staff.id, staff.totalMinor);
    expect(await rows(staff.customerId!)).toEqual([]);
    await t.http.put(L(A, '/program')).set(auth(A.owner)).send({ ...PROGRAM, minOrderMinor: 10_000_000 });
    const small = await place({ phone });
    await pay(small.id, small.totalMinor);
    expect(await rows(small.customerId!)).toEqual([]);
    // Excluding fries: only the burger's spend earns.
    await t.http.put(L(A, '/program')).set(auth(A.owner)).send({ ...PROGRAM, excludedProductIds: [menu.products.fries] });
    const mixed = await place({ phone, lines: [{ productId: menu.products.fries, quantity: 5 }, { productId: menu.products.soda, quantity: 4 }] });
    await pay(mixed.id, mixed.totalMinor);
    const sodaSpend = mixed.quote.lines.filter((l) => l.productId === menu.products.soda).reduce((s, l) => s + l.lineTotalMinor, 0);
    expect((await rows(mixed.customerId!)).map((r) => r.points)).toEqual([Math.floor(sodaSpend / 1000)].filter((n) => n > 0));
    await t.http.put(L(A, '/program')).set(auth(A.owner)).send(PROGRAM);
  });
});

describe('redemption through the pricing engine', () => {
  let customerId: string;
  let phone: string;
  beforeAll(async () => {
    phone = newPhone();
    const o = await place({ phone, lines: [{ productId: menu.products.fries, quantity: 10 }] });
    await pay(o.id, o.totalMinor);
    customerId = o.customerId!;
  });

  it('applies the reward as a discount, debits points in the same transaction, once per order', async () => {
    const before = await balance(customerId);
    expect(before).toBeGreaterThanOrEqual(5);
    const plain = await place({ customerId, customerIdentified: true });
    const o = await place({ customerId, customerIdentified: true, loyaltyRewardId: rewardId });
    expect(o.quote.loyalty?.reward).toMatchObject({ id: rewardId, pointsCost: 5, discountMinor: Math.min(1500, plain.quote.subtotalMinor) });
    expect(o.quote.discountMinor).toBe(plain.quote.discountMinor + o.quote.loyalty!.reward!.discountMinor);
    expect(o.totalMinor).toBeLessThan(plain.totalMinor);
    const [order] = await sql(`select discount_minor from orders where id = $1`, [o.id]);
    expect(Number(order.discount_minor)).toBe(o.quote.discountMinor);
    const redeem = (await rows(customerId)).filter((r) => r.kind === 'redeem');
    expect(redeem).toEqual([{ kind: 'redeem', points: -5, balance_after: before - 5, order_id: o.id }]);
    expect(await balance(customerId)).toBe(before - 5);
    // The commit is keyed by order: a repeated commit changes nothing.
    await db.scoped(ctx, (tx) => t.app.get(LoyaltyService).commitRedemption(tx, ctx, { orderId: o.id, customerId, rewardId, pointsCost: 5, discountMinor: 1 }));
    expect(await balance(customerId)).toBe(before - 5);
    await db.scoped(ctx, (tx) => kernel.transition(tx, ctx, plain.id, 'cancelled', { reason: 'test' }));
  });

  it('refuses redemption without enough points, without an identified customer, and leaves no order behind', async () => {
    const bal = await balance(customerId);
    const [{ n: before }] = await sql(`select count(*)::int as n from orders where org_id = $1`, [A.orgId]);
    await expect(place({ customerId, customerIdentified: true, loyaltyRewardId: percentRewardId }))
      .rejects.toMatchObject({ status: 409, code: 'loyalty_insufficient_points' });
    await expect(place({ phone, loyaltyRewardId: rewardId })).rejects.toMatchObject({ status: 409, code: 'loyalty_customer_required' });
    await expect(place({ customerId, customerIdentified: true, loyaltyRewardId: '00000000-0000-4000-8000-000000000001' }))
      .rejects.toMatchObject({ status: 409, code: 'loyalty_reward_unavailable' });
    const [{ n: after }] = await sql(`select count(*)::int as n from orders where org_id = $1`, [A.orgId]);
    expect(after).toBe(before);
    expect(await balance(customerId)).toBe(bal);
  });

  it('website checkout cannot redeem (unverified phone) but shows the points the order earns', async () => {
    const q = await t.http.post(`/v1/public/order/${A.slug}/quote`).send({ branchId: A.branchId, fulfillment: 'pickup', lines: [{ productId: menu.products.fries, quantity: 3 }] });
    expect(q.status).toBe(200);
    expect(q.body.loyalty).toMatchObject({ reward: null, balance: null, earnPreview: Math.floor(q.body.subtotalMinor / 1000) });
    // A reward id smuggled into the web request is not part of its contract and is ignored.
    const smuggled = await t.http.post(`/v1/public/order/${A.slug}/quote`).send({ branchId: A.branchId, fulfillment: 'pickup', lines: [{ productId: menu.products.fries, quantity: 3 }], loyaltyRewardId: rewardId });
    expect(smuggled.status).toBe(200);
    expect(smuggled.body.loyalty.reward).toBeNull();
    expect(smuggled.body.discountMinor).toBe(q.body.discountMinor);
  });
});

describe('who counts as identified (QR tables and staff orders)', () => {
  let victimId: string;
  let victimPhone: string;
  let tableId: string;
  let qr: string;
  beforeAll(async () => {
    victimPhone = newPhone();
    victimId = (await place({ phone: victimPhone })).customerId!;
    expect((await t.http.post(L(A, '/adjustments')).set(auth(A.owner)).send({ customerId: victimId, points: 120, reason: 'seed balance' })).status).toBe(201);
    const f = await saveFloor(t, A, [table('L1', 400, 200, { capacity: 4 })]);
    tableId = f.tables.find((x: any) => x.label === 'L1').id;
    qr = await qrTokenFor(t, A, tableId);
  });
  /** A public booking with the victim's phone (nobody verifies it), confirmed and moved to "now" (the guest arrives). */
  async function bookWithPhone(phone: string) {
    const d = new Date(Date.now() + 3 * 86_400_000);
    const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Cairo' }).format(d);
    const h = await t.http.post(`/v1/public/reservations/${A.slug}/holds`).send({ branchId: A.branchId, partySize: 2, guestName: 'Someone', guestPhone: phone, key: key('h'), date, time: '19:00' });
    expect(h.status).toBe(201);
    expect((await t.http.post('/v1/public/reservations/manage/confirm').set({ 'X-Reservation-Token': h.body.manageToken }).send({ key: key() })).status).toBeLessThan(300);
    const [r] = await sql(`select id, customer_id from reservations where org_id = $1 order by created_at desc limit 1`, [A.orgId]);
    expect(r.customer_id).toBe(victimId);
    await sql(`update reservations set table_id = $2, starts_at = now(), ends_at = now() + interval '90 minutes', blocked_until = now() + interval '2 hours' where id = $1`, [r.id, tableId]);
    return r.id as string;
  }
  async function closeTable() {
    await sql(`update visits set status = 'closed', closed_at = now() where table_id = $1 and status = 'open'`, [tableId]);
    await sql(`update dining_tables set status = 'available' where id = $1`, [tableId]);
    await sql(`update reservations set status = 'completed' where table_id = $1 and status in ('seated', 'confirmed')`, [tableId]);
  }

  it('a QR self-check-in from a phone-only booking cannot see or spend that customer’s points (review regression)', async () => {
    await bookWithPhone(victimPhone);
    const scan = await t.http.post(`/v1/public/tables/${qr}/session`);
    expect(scan.status).toBe(200);
    const tok = scan.body.token;
    // The probe's precondition: the self-opened visit did inherit the booked customer.
    expect((await sql(`select customer_id, opened_via, opened_by from visits where id = $1`, [scan.body.visitId]))[0]).toEqual({ customer_id: victimId, opened_via: 'qr', opened_by: null });
    const rewards = await t.http.get('/v1/public/visits/current/rewards').set('X-Visit-Token', tok);
    expect(rewards.body).toEqual({ identified: false, rewards: [] });
    const quote = await t.http.post('/v1/public/visits/current/quote').set('X-Visit-Token', tok).send({ lines: [{ productId: menu.products.fries, quantity: 2 }] });
    expect(quote.status).toBe(200);
    expect(quote.body.loyalty.balance).toBeNull();
    const smuggled = await t.http.post('/v1/public/visits/current/quote').set('X-Visit-Token', tok).send({ lines: [{ productId: menu.products.fries, quantity: 2 }], loyaltyRewardId: rewardId });
    expect(smuggled.status).toBe(409);
    expect(smuggled.body.error?.code ?? smuggled.body.code).toBe('loyalty_customer_required');
    const placed = await t.http.post('/v1/public/visits/current/orders').set('X-Visit-Token', tok).set('Idempotency-Key', key('g'))
      .send({ lines: [{ productId: menu.products.fries, quantity: 2 }], loyaltyRewardId: rewardId });
    expect(placed.status).toBe(409);
    expect((await rows(victimId)).filter((r) => r.kind === 'redeem')).toEqual([]);
    expect(await balance(victimId)).toBe(120);
    await closeTable();
  });

  it('a reservation the host checked in counts as identified for the table', async () => {
    const reservationId = await bookWithPhone(victimPhone);
    const host = await addMember(t, A, 'host');
    const seat = await t.http.post(`/v1/o/${A.orgId}/visits`).set(auth(host)).send({ tableId, reservationId });
    expect(seat.status).toBe(201);
    const tok = (await t.http.post(`/v1/public/tables/${qr}/session`)).body.token;
    const rewards = await t.http.get('/v1/public/visits/current/rewards').set('X-Visit-Token', tok);
    expect(rewards.body.identified).toBe(true);
    const quote = await t.http.post('/v1/public/visits/current/quote').set('X-Visit-Token', tok).send({ lines: [{ productId: menu.products.fries, quantity: 2 }], loyaltyRewardId: rewardId });
    expect(quote.status).toBe(200);
    expect(quote.body.loyalty).toMatchObject({ balance: 120, reward: { id: rewardId, pointsCost: 5 } });
    await closeTable();
  });

  it('staff orders redeem for a picked customer; cashiers see the redeemable rewards; other tenants’ customers are refused', async () => {
    const r = await t.http.get(L(A, `/customers/${victimId}/rewards`)).set(auth(cashier));
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ active: true, balance: (await balance(victimId)) });
    expect(r.body.rewards.find((x: any) => x.id === rewardId)).toMatchObject({ pointsCost: 5, affordable: true });
    const before = await balance(victimId);
    const o = await t.http.post(`/v1/o/${A.orgId}/orders`).set(auth(cashier)).set('Idempotency-Key', key('so'))
      .send({ branchId: A.branchId, fulfillment: 'pickup', lines: [{ productId: menu.products.fries, quantity: 2 }], customerId: victimId, loyaltyRewardId: rewardId });
    expect(o.status).toBe(201);
    const [order] = await sql(`select customer_id, discount_minor from orders where id = $1`, [o.body.id]);
    expect(order.customer_id).toBe(victimId);
    expect(Number(order.discount_minor)).toBeGreaterThan(0);
    const redeem = await sql(`select points, actor from loyalty_ledger where order_id = $1 and kind = 'redeem'`, [o.body.id]);
    expect(redeem).toEqual([{ points: -5, actor: `user:${cashier.userId}` }]);
    expect(await balance(victimId)).toBe(before - 5);
    // Without a customer there is nothing to redeem against; a foreign customer id is not found.
    const anon = await t.http.post(`/v1/o/${A.orgId}/orders`).set(auth(cashier)).set('Idempotency-Key', key('so'))
      .send({ branchId: A.branchId, fulfillment: 'pickup', lines: [{ productId: menu.products.fries, quantity: 1 }], loyaltyRewardId: rewardId });
    expect(anon.status).toBe(422);
    const foreign = (await sql(`insert into customers(org_id, display_name, phone_e164) values ($1, 'Other', $2) returning id`, [B.orgId, newPhone()]))[0].id;
    const cross = await t.http.post(`/v1/o/${A.orgId}/orders`).set(auth(cashier)).set('Idempotency-Key', key('so'))
      .send({ branchId: A.branchId, fulfillment: 'pickup', lines: [{ productId: menu.products.fries, quantity: 1 }], customerId: foreign, loyaltyRewardId: rewardId });
    expect(cross.status).toBe(404);
    expect((await t.http.get(L(A, `/customers/${foreign}/rewards`)).set(auth(cashier))).status).toBe(404);
  });
});

describe('reversal on refund and cancellation', () => {
  it('reverses earned points in proportion to refunds and returns redeemed points on a full refund', async () => {
    const phone = newPhone();
    const first = await place({ phone, lines: [{ productId: menu.products.fries, quantity: 10 }] });
    await pay(first.id, first.totalMinor);
    const customerId = first.customerId!;
    const o = await place({ customerId, customerIdentified: true, loyaltyRewardId: rewardId, lines: [{ productId: menu.products.fries, quantity: 8 }] });
    const paymentId = await pay(o.id, o.totalMinor);
    const earned = (await rows(customerId)).find((r) => r.kind === 'earn' && r.order_id === o.id)!.points;
    expect(earned).toBeGreaterThan(0);

    const part = Math.floor(o.totalMinor / 2);
    await db.scoped(ctx, (tx) => ledger.applyRefund(tx, ctx, paymentId, part));
    await dispatcher.drain();
    const half = (await rows(customerId)).filter((r) => r.order_id === o.id && r.kind === 'reverse_earn');
    expect(half.map((r) => r.points)).toEqual([-pointsToReverse(earned, o.totalMinor, part)]);
    expect((await rows(customerId)).some((r) => r.order_id === o.id && r.kind === 'reverse_redeem')).toBe(false);

    await db.scoped(ctx, (tx) => ledger.applyRefund(tx, ctx, paymentId, o.totalMinor - part));
    await dispatcher.drain();
    await dispatcher.drain();
    const all = (await rows(customerId)).filter((r) => r.order_id === o.id);
    expect(-all.filter((r) => r.kind === 'reverse_earn').reduce((s, r) => s + r.points, 0)).toBe(earned);
    expect(all.filter((r) => r.kind === 'reverse_redeem').map((r) => r.points)).toEqual([5]);
    // Replaying the refund event changes nothing.
    await t.app.get(LoyaltyHandlers).onRefund({ id: 'y', orgId: A.orgId, type: 'payment.refunded', aggregateType: 'payment', aggregateId: paymentId, payload: {}, createdAt: new Date().toISOString() });
    expect((await rows(customerId)).filter((r) => r.order_id === o.id)).toHaveLength(all.length);
  });

  it('returns redeemed points when an unpaid order is cancelled and never earns for it', async () => {
    const phone = newPhone();
    const first = await place({ phone, lines: [{ productId: menu.products.fries, quantity: 10 }] });
    await pay(first.id, first.totalMinor);
    const customerId = first.customerId!;
    const bal = await balance(customerId);
    const o = await place({ customerId, customerIdentified: true, loyaltyRewardId: rewardId });
    expect(await balance(customerId)).toBe(bal - 5);
    await db.scoped(ctx, (tx) => kernel.transition(tx, ctx, o.id, 'cancelled', { reason: 'guest left' }));
    await dispatcher.drain();
    expect(await balance(customerId)).toBe(bal);
    expect((await rows(customerId)).filter((r) => r.order_id === o.id).map((r) => r.kind)).toEqual(['redeem', 'reverse_redeem']);
  });
});

describe('expiry, adjustments and invariants', () => {
  it('expires unused points oldest first, once', async () => {
    const svc = t.app.get(LoyaltyService);
    const phone = newPhone();
    const o = await place({ phone });
    const customerId = o.customerId!;
    await db.scoped(ctx, async (tx) => {
      await svc.append(tx, A.orgId, { customerId, kind: 'earn', points: 30, idempotencyKey: `t-old:${customerId}`, actor: 'test', expiresAt: new Date(Date.now() - 86_400_000) });
      await svc.append(tx, A.orgId, { customerId, kind: 'earn', points: 20, idempotencyKey: `t-new:${customerId}`, actor: 'test', expiresAt: new Date(Date.now() + 86_400_000 * 30) });
      await svc.append(tx, A.orgId, { customerId, kind: 'adjust', points: -10, idempotencyKey: `t-use:${customerId}`, actor: 'test', reason: 'used at the counter' });
    });
    const n = await t.app.get(LoyaltyHandlers).expire();
    expect(n.expired).toBeGreaterThanOrEqual(20);
    expect((await rows(customerId)).filter((r) => r.kind === 'expire').map((r) => r.points)).toEqual([-20]); // 30 old - 10 used
    expect(await balance(customerId)).toBe(20);
    await t.app.get(LoyaltyHandlers).expire();
    expect((await rows(customerId)).filter((r) => r.kind === 'expire')).toHaveLength(1);
    const view = (await t.http.get(L(A, `/customers/${customerId}`)).set(auth(A.owner))).body;
    expect(view.expiringSoon).toMatchObject({ points: 20 });
  });

  it('expires an old lot even when a newer order was refunded (FIFO per lot, review regression)', async () => {
    const svc = t.app.get(LoyaltyService);
    const old = await place({ phone: newPhone() });
    const customerId = old.customerId!;
    const newer = await place({ customerId });
    await db.scoped(ctx, async (tx) => {
      await svc.append(tx, A.orgId, { customerId, kind: 'earn', points: 100, orderId: old.id, idempotencyKey: `t-lot-old:${customerId}`, actor: 'test', expiresAt: new Date(Date.now() - 86_400_000) });
      await svc.append(tx, A.orgId, { customerId, kind: 'earn', points: 100, orderId: newer.id, idempotencyKey: `t-lot-new:${customerId}`, actor: 'test', expiresAt: new Date(Date.now() + 86_400_000 * 30) });
      // The newer order is refunded in full: its own lot is reversed.
      await svc.append(tx, A.orgId, { customerId, kind: 'reverse_earn', points: -100, orderId: newer.id, idempotencyKey: `t-lot-rev:${customerId}`, actor: 'test' });
    });
    await t.app.get(LoyaltyHandlers).expire();
    expect((await rows(customerId)).filter((r) => r.kind === 'expire').map((r) => r.points)).toEqual([-100]);
    expect(await balance(customerId)).toBe(0);
  });

  it('refuses any debit below zero under the lock and in the database (review regression)', async () => {
    const svc = t.app.get(LoyaltyService);
    const customerId = (await place({ phone: newPhone() })).customerId!;
    await db.scoped(ctx, (tx) => svc.append(tx, A.orgId, { customerId, kind: 'adjust', points: 10, reason: 'seed', idempotencyKey: `t-neg-seed:${customerId}`, actor: 'test' }));
    // A negative adjustment that races a redemption is re-checked against the locked balance, not the earlier read.
    await expect(db.scoped(ctx, (tx) => svc.append(tx, A.orgId, { customerId, kind: 'adjust', points: -11, reason: 'race', idempotencyKey: `t-neg-adj:${customerId}`, actor: 'test' })))
      .rejects.toMatchObject({ status: 409, code: 'loyalty_negative_balance' });
    await expect(sql(
      `insert into loyalty_ledger(org_id, customer_id, kind, points, balance_after, reason, actor, idempotency_key) values ($1, $2, 'adjust', -11, -1, 'direct', 'test', $3)`,
      [A.orgId, customerId, `t-neg-sql:${customerId}`])).rejects.toThrow(/loyalty_ledger_no_negative_debit/);
    expect(await balance(customerId)).toBe(10);
  });

  it('manual adjustments need marketing:approve and a reason, cannot go below zero, are audited and idempotent', async () => {
    const o = await place({ phone: newPhone() });
    const customerId = o.customerId!;
    expect((await t.http.post(L(A, '/adjustments')).set(auth(cashier)).send({ customerId, points: 10, reason: 'goodwill' })).status).toBe(403);
    expect((await t.http.post(L(A, '/adjustments')).set(auth(A.owner)).send({ customerId, points: 10 })).status).toBe(400);
    expect((await t.http.post(L(A, '/adjustments')).set(auth(A.owner)).send({ customerId, points: -1, reason: 'oops' })).status).toBe(409);
    const ok = await t.http.post(L(A, '/adjustments')).set(auth(marketing)).set('Idempotency-Key', 'adj-0001').send({ customerId, points: 10, reason: 'goodwill gesture' });
    expect(ok.status).toBe(201);
    expect(ok.body).toMatchObject({ balance: 10, replayed: false });
    const again = await t.http.post(L(A, '/adjustments')).set(auth(marketing)).set('Idempotency-Key', 'adj-0001').send({ customerId, points: 10, reason: 'goodwill gesture' });
    expect(again.body).toMatchObject({ balance: 10, replayed: true });
    const [audit] = await sql(`select metadata from audit_logs where org_id = $1 and action = 'loyalty.points.adjusted' and entity_id = $2`, [A.orgId, customerId]);
    expect(audit.metadata).toMatchObject({ points: 10, reason: 'goodwill gesture', balanceAfter: 10 });
    const led = await t.http.get(L(A, '/ledger')).query({ customerId }).set(auth(cashier));
    expect(led.status).toBe(200);
    expect(led.body.items[0]).toMatchObject({ kind: 'adjust', points: 10, reason: 'goodwill gesture' });
  });

  it('moves the balance to the surviving profile when customers are merged', async () => {
    const a = (await place({ phone: newPhone() })).customerId!;
    const b = (await place({ phone: newPhone() })).customerId!;
    await t.http.post(L(A, '/adjustments')).set(auth(A.owner)).send({ customerId: a, points: 7, reason: 'seed survivor' });
    await t.http.post(L(A, '/adjustments')).set(auth(A.owner)).send({ customerId: b, points: 12, reason: 'seed duplicate' });
    const m = await t.http.post(`/v1/o/${A.orgId}/customers/${a}/merge`).set(auth(A.owner)).send({ duplicateId: b });
    expect(m.status).toBe(200);
    expect(m.body.moved.loyaltyPoints).toBe(12);
    expect(await balance(a)).toBe(19);
    expect((await sql(`select balance from loyalty_accounts where customer_id = $1`, [b]))[0].balance).toBe(0);
  });

  it('keeps the ledger append-only and every balance equal to the sum of its ledger', async () => {
    await expect(sql(`update loyalty_ledger set points = points + 1 where org_id = $1`, [A.orgId])).rejects.toThrow(/append-only/);
    await expect(sql(`delete from loyalty_ledger where org_id = $1`, [A.orgId])).rejects.toThrow(/append-only/);
    const mismatches = await sql(
      `select a.customer_id from loyalty_accounts a
        where a.org_id = $1 and a.balance <> coalesce((select sum(points) from loyalty_ledger l where l.org_id = a.org_id and l.customer_id = a.customer_id), 0)`, [A.orgId]);
    expect(mismatches).toEqual([]);
    // Every row's balance_after continues the previous one.
    const chain = await sql(
      `select customer_id, points, balance_after, lag(balance_after, 1, 0) over (partition by customer_id order by seq) as prev
         from loyalty_ledger where org_id = $1`, [A.orgId]);
    expect(chain.filter((r) => r.prev + r.points !== r.balance_after)).toEqual([]);
    expect(chain.length).toBeGreaterThan(5);
  });

  it('segments customers by points and isolates tenants', async () => {
    const seg = await t.http.post(`/v1/o/${A.orgId}/marketing/segments/preview`).set(auth(A.owner))
      .send({ definition: { op: 'and', rules: [{ type: 'points_balance_gte', points: 10 }] } });
    expect(seg.status).toBe(200);
    const [{ n }] = await sql(`select count(*)::int as n from loyalty_accounts where org_id = $1 and balance >= 10`, [A.orgId]);
    expect(seg.body.count ?? seg.body.memberCount).toBe(n);
    const someone = (await sql(`select customer_id from loyalty_accounts where org_id = $1 limit 1`, [A.orgId]))[0].customer_id;
    expect((await t.http.get(L(B, `/customers/${someone}`)).set(auth(B.owner))).status).toBe(404);
    expect((await t.http.get(L(A, `/customers/${someone}`)).set(auth(B.owner))).status).toBe(404);
    const free = await createTenant(t, { planId: 'free' });
    expect((await t.http.get(L(free, '/program')).set(auth(free.owner))).status).toBe(402);
  });
});
