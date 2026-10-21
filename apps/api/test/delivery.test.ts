import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TenantContext } from '../src/common/auth/context';
import { DbService } from '../src/common/db/db.service';
import { EventDispatcher } from '../src/common/events/dispatcher.service';
import { RateLimiter } from '../src/common/http/rate-limiter';
import { DeliveryService } from '../src/modules/delivery/delivery.service';
import { OrdersKernelService } from '../src/modules/kernel/orders-kernel.service';
import { PaymentLedgerService } from '../src/modules/kernel/payment-ledger.service';
import { addMember, auth, bootTestApp, createTenant, seedMenu, sql, type SeededMenu, type TestApp, type TestTenant, type TestUser } from './helpers';

let t: TestApp;
let db: DbService;
let orders: OrdersKernelService;
let ledger: PaymentLedgerService;
let dispatcher: EventDispatcher;
let tenant: TestTenant;
let menu: SeededMenu;
let ownerCtx: TenantContext;
let manager: TestUser;
let waiter: TestUser;
let d1: TestUser;
let d2: TestUser;
let d3: TestUser;
let driverIds: Record<string, string>;
let branch2: string;

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);

beforeAll(async () => {
  t = await bootTestApp();
  db = t.app.get(DbService);
  orders = t.app.get(OrdersKernelService);
  ledger = t.app.get(PaymentLedgerService);
  dispatcher = t.app.get(EventDispatcher);
  tenant = await createTenant(t, { country: 'EG' });
  menu = await seedMenu(tenant);
  ownerCtx = new TenantContext(tenant.orgId, 'owner', null, tenant.owner.userId, 'user', tenant.owner.userId);
  await sql(`update branches set latitude = 30.0444, longitude = 31.2357 where id = $1`, [tenant.branchId]);
  const b2 = await t.http.post(`/v1/o/${tenant.orgId}/branches`).set(auth(tenant.owner)).send({ name: 'Second branch', acceptsDelivery: true });
  expect(b2.status).toBe(201);
  branch2 = b2.body.id;
  manager = await addMember(t, tenant, 'manager');
  waiter = await addMember(t, tenant, 'waiter');
  d1 = await addMember(t, tenant, 'driver', [tenant.branchId]);
  d2 = await addMember(t, tenant, 'driver', [tenant.branchId]);
  d3 = await addMember(t, tenant, 'driver', [branch2]);
  const rows = await sql<{ id: string; user_id: string }>(`select id, user_id from drivers where org_id = $1`, [tenant.orgId]);
  driverIds = Object.fromEntries(rows.map((r) => [r.user_id, r.id]));
  // Start from a clean outbox so drains only see this file's events.
  await sql(`update outbox_events set published_at = now() where published_at is null`);
});
afterAll(async () => { await t.close(); });

const did = (u: TestUser) => driverIds[u.userId]!;
const D = (path: string) => `/v1/o/${tenant.orgId}/driver${path}`;
const M = (path: string) => `/v1/o/${tenant.orgId}/delivery${path}`;

async function placeDelivery(opts: { prepaid?: boolean; branchId?: string; target?: TestTenant } = {}) {
  const tt = opts.target ?? tenant;
  const ctx = opts.target ? new TenantContext(tt.orgId, 'owner', null, tt.owner.userId, 'user', tt.owner.userId) : ownerCtx;
  const productId = opts.target ? (await sql(`select id from products where org_id = $1 and name = 'Fries'`, [tt.orgId]))[0].id : menu.products.fries;
  return db.scoped(ctx, (tx) => orders.place(tx, ctx, {
    branchId: opts.branchId ?? tt.branchId, channel: 'web', fulfillment: 'delivery', lines: [{ productId, quantity: 2 }],
    customer: { name: 'Salma', phone: '+201005550001' },
    deliveryAddress: { line1: '5 Tahrir Sq', area: 'Downtown', city: 'Cairo', latitude: 30.0450, longitude: 31.2400, notes: 'Floor 3' },
    initialStatus: opts.prepaid ? 'awaiting_payment' : 'placed',
  }));
}

async function jobFor(orderId: string) {
  return (await sql(`select * from delivery_jobs where order_id = $1`, [orderId]))[0];
}

async function makeReady(orderId: string) {
  for (const s of ['accepted', 'preparing', 'ready'] as const) await db.scoped(ownerCtx, (tx) => orders.transition(tx, ownerCtx, orderId, s));
}

async function online(u: TestUser) {
  const r = await t.http.patch(D('/me/availability')).set(auth(u)).send({ availability: 'available' });
  expect(r.status).toBe(200);
}

async function freshJob(opts: { prepaid?: boolean } = {}) {
  const o = await placeDelivery(opts);
  await dispatcher.drain();
  return { order: o, job: await jobFor(o.id) };
}

describe('job creation', () => {
  it('creates exactly one job per delivery order with drop-off snapshot and COD due', async () => {
    const o = await placeDelivery();
    await dispatcher.drain();
    let jobs = await sql(`select * from delivery_jobs where order_id = $1`, [o.id]);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ status: 'unassigned', branch_id: tenant.branchId, cod_amount_minor: o.totalMinor, cash_status: 'pending' });
    expect(jobs[0].dropoff).toMatchObject({ line1: '5 Tahrir Sq', customerName: 'Salma', customerPhone: '+201005550001' });
    expect(jobs[0].distance_m).toBeGreaterThan(0);

    // A later status change re-triggers the handler: still one job.
    await db.scoped(ownerCtx, (tx) => orders.transition(tx, ownerCtx, o.id, 'accepted'));
    await dispatcher.drain();
    jobs = await sql(`select id from delivery_jobs where order_id = $1`, [o.id]);
    expect(jobs).toHaveLength(1);
    const again = await db.scoped(ownerCtx, (tx) => t.app.get(DeliveryService).createJobForOrder(tx, ownerCtx, o.id));
    expect(again).toEqual({ id: jobs[0].id, created: false });
    const outbox = await sql(`select event_type from outbox_events where aggregate_id = $1`, [jobs[0].id]);
    expect(outbox.filter((e) => e.event_type === 'delivery.created')).toHaveLength(1);
  });

  it('waits for payment on prepaid orders and then needs no cash', async () => {
    const o = await placeDelivery({ prepaid: true });
    await dispatcher.drain();
    expect(await jobFor(o.id)).toBeUndefined();
    await db.scoped(ownerCtx, (tx) => ledger.recordSucceeded(tx, ownerCtx, {
      branchId: tenant.branchId, orderId: o.id, method: 'card', provider: 'simulated', amountMinor: o.totalMinor, currency: 'EGP', isTest: true,
    }));
    await dispatcher.drain();
    expect(await jobFor(o.id)).toMatchObject({ status: 'unassigned', cod_amount_minor: 0, cash_status: 'none' });
  });

  it('ignores non-delivery orders and cancels the job when the order is cancelled', async () => {
    const pickup = await db.scoped(ownerCtx, (tx) => orders.place(tx, ownerCtx, {
      branchId: tenant.branchId, channel: 'staff', fulfillment: 'pickup', lines: [{ productId: menu.products.soda, quantity: 1 }],
    }));
    const { order, job } = await freshJob();
    expect(await jobFor(pickup.id)).toBeUndefined();
    await db.scoped(ownerCtx, (tx) => orders.transition(tx, ownerCtx, order.id, 'cancelled', { reason: 'test' }));
    await dispatcher.drain();
    expect((await jobFor(order.id)).status).toBe('cancelled');
    expect(job.status).toBe('unassigned');
  });
});

describe('dispatch: offers, assignment and isolation', () => {
  it('offers, declines, expires and accepts', async () => {
    const { job } = await freshJob();
    // offline drivers cannot receive offers
    const offline = await t.http.post(M(`/jobs/${job.id}/assign`)).set(auth(manager)).send({ driverId: did(d1), mode: 'offer' });
    expect(offline.status).toBe(409);
    expect(offline.body.error.code).toBe('driver_unavailable');
    await online(d1);
    await online(d2);

    const offer = await t.http.post(M(`/jobs/${job.id}/assign`)).set(auth(manager)).send({ driverId: did(d1), mode: 'offer', offerTtlSeconds: 60 });
    expect(offer.status).toBe(200);
    expect(offer.body).toMatchObject({ status: 'offered', offer: { driverId: did(d1) } });
    // The offered driver sees it; another driver does not.
    const mine = await t.http.get(D('/jobs')).set(auth(d1));
    expect(mine.body.offers.map((j: any) => j.id)).toContain(job.id);
    const theirs = await t.http.get(D('/jobs')).set(auth(d2));
    expect(theirs.body.offers.map((j: any) => j.id)).not.toContain(job.id);
    expect((await t.http.post(D(`/jobs/${job.id}/accept`)).set(auth(d2)).send({})).status).toBe(404);

    const declined = await t.http.post(D(`/jobs/${job.id}/decline`)).set(auth(d1)).send({ reason: 'too far' });
    expect(declined.status).toBe(200);
    expect((await jobFor(job.order_id)).status).toBe('unassigned');

    // Expiry job returns unanswered offers to the pool.
    await t.http.post(M(`/jobs/${job.id}/assign`)).set(auth(manager)).send({ driverId: did(d1), mode: 'offer', offerTtlSeconds: 30 });
    await sql(`update delivery_offers set expires_at = now() - interval '1 second' where job_id = $1 and status = 'offered'`, [job.id]);
    expect((await t.http.post(D(`/jobs/${job.id}/accept`)).set(auth(d1)).send({})).body.error.code).toBe('offer_expired');
    await dispatcher.runDueJobs(Date.now(), true);
    expect((await jobFor(job.order_id)).status).toBe('unassigned');
    const offers = await sql(`select status from delivery_offers where job_id = $1 order by created_at`, [job.id]);
    expect(offers.map((o) => o.status)).toEqual(['declined', 'expired']);

    await t.http.post(M(`/jobs/${job.id}/assign`)).set(auth(manager)).send({ driverId: did(d1), mode: 'offer' });
    const accepted = await t.http.post(D(`/jobs/${job.id}/accept`)).set(auth(d1)).send({ latitude: 30.04, longitude: 31.23 });
    expect(accepted.status).toBe(200);
    expect(accepted.body).toMatchObject({ status: 'accepted', driverId: did(d1) });
    const [drv] = await sql(`select availability from drivers where id = $1`, [did(d1)]);
    expect(drv.availability).toBe('busy');
    const events = await sql(`select to_status, actor_type, latitude from delivery_events where job_id = $1 order by id`, [job.id]);
    expect(events.at(-1)).toMatchObject({ to_status: 'accepted', actor_type: 'driver', latitude: '30.040000' });
  });

  it('keeps drivers to their own jobs and branches', async () => {
    const { job } = await freshJob();
    const assigned = await t.http.post(M(`/jobs/${job.id}/assign`)).set(auth(manager)).send({ driverId: did(d1) });
    expect(assigned.body.status).toBe('assigned');
    expect((await t.http.get(D(`/jobs/${job.id}`)).set(auth(d1))).status).toBe(200);
    expect((await t.http.get(D(`/jobs/${job.id}`)).set(auth(d2))).status).toBe(404);
    expect((await t.http.post(D(`/jobs/${job.id}/pickup`)).set(auth(d2)).send({})).status).toBe(404);
    // a branch-2 driver cannot be given a branch-1 job, and never sees it
    const wrongBranch = await t.http.post(M(`/jobs/${job.id}/assign`)).set(auth(manager)).send({ driverId: did(d3) });
    expect(wrongBranch.body.error.code).toBe('driver_branch_mismatch');
    expect((await t.http.get(D(`/jobs/${job.id}`)).set(auth(d3))).status).toBe(404);
    // reassign moves it to the other driver
    const re = await t.http.post(M(`/jobs/${job.id}/assign`)).set(auth(manager)).send({ driverId: did(d2) });
    expect(re.body).toMatchObject({ status: 'assigned', driverId: did(d2) });
    expect((await t.http.get(D(`/jobs/${job.id}`)).set(auth(d1))).status).toBe(404);
    // assigned (not yet accepted) jobs may be declined by the driver
    expect((await t.http.post(D(`/jobs/${job.id}/decline`)).set(auth(d2)).send({})).body.status).toBe('unassigned');
  });

  it('enforces permissions, validation and the delivery state machine', async () => {
    const { job } = await freshJob();
    expect((await t.http.get(M('/board')).set(auth(waiter))).status).toBe(403);
    expect((await t.http.get(M('/board')).set(auth(d1))).status).toBe(403);
    expect((await t.http.get(D('/me')).set(auth(manager))).status).toBe(403);
    expect((await t.http.post(M(`/jobs/${job.id}/assign`)).set(auth(manager)).send({ driverId: 'nope' })).status).toBe(400);
    expect((await t.http.get(M('/jobs/not-a-uuid')).set(auth(manager))).status).toBe(400);

    await t.http.post(M(`/jobs/${job.id}/assign`)).set(auth(manager)).send({ driverId: did(d2) });
    const early = await t.http.post(D(`/jobs/${job.id}/en-route`)).set(auth(d2)).send({});
    expect(early.status).toBe(409);
    expect(early.body.error).toMatchObject({ code: 'invalid_transition', details: { from: 'assigned', to: 'en_route' } });
    const noProof = await t.http.post(D(`/jobs/${job.id}/deliver`)).set(auth(d2)).send({});
    expect(noProof.status).toBe(400);

    const board = await t.http.get(M('/board')).set(auth(manager));
    expect(board.status).toBe(200);
    expect(board.body.active.map((j: any) => j.id)).toContain(job.id);
    expect(board.body.drivers.length).toBeGreaterThanOrEqual(2);
    const cancelled = await t.http.post(M(`/jobs/${job.id}/cancel`)).set(auth(manager)).send({ reason: 'customer called' });
    expect(cancelled.body.status).toBe('cancelled');
    expect((await t.http.post(M(`/jobs/${job.id}/assign`)).set(auth(manager)).send({ driverId: did(d2) })).status).toBe(409);
    const detail = await t.http.get(M(`/jobs/${job.id}`)).set(auth(manager));
    expect(detail.body.events.map((e: any) => e.toStatus)).toEqual(['unassigned', 'assigned', 'cancelled']);
  });
});

describe('pickup, delivery, COD and settlement', () => {
  it('requires a ready order for pickup, delivers with proof and collects COD through the ledger', async () => {
    const { order, job } = await freshJob();
    await t.http.post(M(`/jobs/${job.id}/assign`)).set(auth(manager)).send({ driverId: did(d1) });
    await t.http.post(D(`/jobs/${job.id}/accept`)).set(auth(d1)).send({});
    const notReady = await t.http.post(D(`/jobs/${job.id}/pickup`)).set(auth(d1)).send({});
    expect(notReady.status).toBe(409);
    expect(notReady.body.error.code).toBe('order_not_ready');
    await makeReady(order.id);
    expect((await t.http.post(D(`/jobs/${job.id}/pickup`)).set(auth(d1)).send({})).body.status).toBe('picked_up');
    const enRoute = await t.http.post(D(`/jobs/${job.id}/en-route`)).set(auth(d1)).send({ latitude: 30.044, longitude: 31.236 });
    expect(enRoute.body.status).toBe('en_route');
    expect(enRoute.body.etaAt).not.toBeNull();

    const photo = await t.http.post(D(`/jobs/${job.id}/proof-photo`)).set(auth(d1)).attach('file', PNG, { filename: 'proof.png', contentType: 'image/png' });
    expect(photo.status).toBe(201);
    const bogus = await t.http.post(D(`/jobs/${job.id}/proof-photo`)).set(auth(d1)).attach('file', Buffer.from('not an image'), { filename: 'x.png', contentType: 'image/png' });
    expect(bogus.status).toBe(422);

    const over = await t.http.post(D(`/jobs/${job.id}/deliver`)).set(auth(d1)).send({ proofMediaId: photo.body.mediaId, cashCollectedMinor: order.totalMinor + 1 });
    expect(over.status).toBe(409);
    expect(over.body.error.code).toBe('overpayment');
    const short = await t.http.post(D(`/jobs/${job.id}/deliver`)).set(auth(d1)).send({ proofMediaId: photo.body.mediaId, cashCollectedMinor: order.totalMinor - 1 });
    expect(short.body.error.code).toBe('cash_amount_mismatch');

    const key = `deliver-${job.id}`;
    const done = await t.http.post(D(`/jobs/${job.id}/deliver`)).set(auth(d1)).set('Idempotency-Key', key)
      .send({ proofMediaId: photo.body.mediaId, recipientName: 'Salma', cashCollectedMinor: order.totalMinor, latitude: 30.045, longitude: 31.24 });
    expect(done.status).toBe(200);
    expect(done.body).toMatchObject({ status: 'delivered', cashStatus: 'collected', cashCollectedMinor: order.totalMinor, proofRecipient: 'Salma' });
    // retry with the same key replays; without it the state machine refuses
    const replay = await t.http.post(D(`/jobs/${job.id}/deliver`)).set(auth(d1)).set('Idempotency-Key', key)
      .send({ proofMediaId: photo.body.mediaId, recipientName: 'Salma', cashCollectedMinor: order.totalMinor, latitude: 30.045, longitude: 31.24 });
    expect(replay.status).toBe(200);
    expect((await t.http.post(D(`/jobs/${job.id}/deliver`)).set(auth(d1)).send({ recipientName: 'x', cashCollectedMinor: 0 })).status).toBe(409);

    const [o] = await sql(`select status, payment_status, paid_minor from orders where id = $1`, [order.id]);
    expect(o).toEqual({ status: 'delivered', payment_status: 'paid', paid_minor: order.totalMinor });
    const pays = await sql(`select method, driver_id, amount_minor, received_by from payments where order_id = $1`, [order.id]);
    expect(pays).toEqual([{ method: 'cod', driver_id: did(d1), amount_minor: order.totalMinor, received_by: d1.userId }]);
    // d1 still carries the job accepted in the offer test, so stays busy until that one ends.
    const [drv] = await sql(`select availability, (select count(*)::int from delivery_jobs where driver_id = $1 and status in ('accepted', 'picked_up', 'en_route')) as live
                               from drivers where id = $1`, [did(d1)]);
    expect(drv.availability).toBe(drv.live > 0 ? 'busy' : 'available');
    const detail = await t.http.get(M(`/jobs/${job.id}`)).set(auth(manager));
    expect(detail.body.proofPhotoUrl).toMatch(/^http:\/\/api\.test\/v1\/media\//);

    // cash summary and settlement
    const cash = await t.http.get(D('/me/cash')).set(auth(d1));
    expect(cash.body.onHandMinor).toBeGreaterThanOrEqual(order.totalMinor);
    const collectedIds = cash.body.collectedJobs.map((j: any) => j.id);
    const wrong = await t.http.post(M('/settlements')).set(auth(manager)).send({ driverId: did(d1), jobIds: collectedIds, amountMinor: cash.body.onHandMinor - 1 });
    expect(wrong.status).toBe(422);
    expect(wrong.body.error).toMatchObject({ code: 'settlement_amount_mismatch', details: { expectedMinor: cash.body.onHandMinor } });
    const settled = await t.http.post(M('/settlements')).set(auth(manager)).send({ driverId: did(d1), jobIds: collectedIds, amountMinor: cash.body.onHandMinor, note: 'end of shift' });
    expect(settled.status).toBe(201);
    expect((await jobFor(order.id)).cash_status).toBe('settled');
    const twice = await t.http.post(M('/settlements')).set(auth(manager)).send({ driverId: did(d1), jobIds: [job.id], amountMinor: order.totalMinor });
    expect(twice.body.error.code).toBe('cash_not_collected');
    expect((await t.http.get(D('/me/cash')).set(auth(d1))).body.onHandMinor).toBe(0);
    const history = await t.http.get(D('/history')).set(auth(d1));
    expect(history.body.items.map((j: any) => j.id)).toContain(job.id);
  });

  it('verifies the optional delivery code and records failures', async () => {
    const { order, job: before } = await freshJob({ prepaid: true });
    expect(before).toBeUndefined();
    await db.scoped(ownerCtx, (tx) => ledger.recordSucceeded(tx, ownerCtx, {
      branchId: tenant.branchId, orderId: order.id, method: 'card', provider: 'simulated', amountMinor: order.totalMinor, currency: 'EGP', isTest: true,
    }));
    await dispatcher.drain();
    const j = await jobFor(order.id);
    const otp = await t.http.post(M(`/jobs/${j.id}/otp`)).set(auth(manager));
    expect(otp.body.code).toMatch(/^\d{4}$/);
    // Connect is deployed; this tenant has no messaging channel, so the code is not sent (and says why).
    expect(otp.body.messaging).toEqual({ status: 'skipped', reason: 'no_channel' });
    await t.http.post(M(`/jobs/${j.id}/assign`)).set(auth(manager)).send({ driverId: did(d2) });
    await t.http.post(D(`/jobs/${j.id}/accept`)).set(auth(d2)).send({});
    await makeReady(order.id);
    await t.http.post(D(`/jobs/${j.id}/pickup`)).set(auth(d2)).send({});
    const wrong = String((Number(otp.body.code) + 1) % 10000).padStart(4, '0');
    expect((await t.http.post(D(`/jobs/${j.id}/deliver`)).set(auth(d2)).send({ otp: wrong })).body.error.code).toBe('otp_invalid');
    // prepaid: nothing to collect, any cash is overpayment
    expect((await t.http.post(D(`/jobs/${j.id}/deliver`)).set(auth(d2)).send({ otp: otp.body.code, cashCollectedMinor: 100 })).body.error.code).toBe('overpayment');
    const ok = await t.http.post(D(`/jobs/${j.id}/deliver`)).set(auth(d2)).send({ otp: otp.body.code });
    expect(ok.body).toMatchObject({ status: 'delivered', cashStatus: 'none' });
    const [ev] = await sql(`select details from delivery_events where job_id = $1 and to_status = 'delivered'`, [j.id]);
    expect(ev.details.otpVerified).toBe(true);

    // failure path
    const f = await freshJob();
    await t.http.post(M(`/jobs/${f.job.id}/assign`)).set(auth(manager)).send({ driverId: did(d2) });
    await t.http.post(D(`/jobs/${f.job.id}/accept`)).set(auth(d2)).send({});
    await makeReady(f.order.id);
    await t.http.post(D(`/jobs/${f.job.id}/pickup`)).set(auth(d2)).send({});
    const failed = await t.http.post(D(`/jobs/${f.job.id}/fail`)).set(auth(d2)).send({ reason: 'customer_unreachable', note: 'no answer' });
    expect(failed.body).toMatchObject({ status: 'failed', failureReason: 'customer_unreachable' });
    // dispatch can put a failed job back in the pool and reassign it
    const back = await t.http.post(M(`/jobs/${f.job.id}/assign`)).set(auth(manager)).send({ driverId: did(d1) });
    expect(back.body).toMatchObject({ status: 'assigned', driverId: did(d1) });
  });

  // Audit PS-08: the stored code was sha256("delivery-otp:<job>:<code>") — 10,000 guesses reverse it offline — and
  // wrong attempts were counted in one process's memory (reset by a restart, not shared between instances).
  it('stores a keyed code hash and locks the code after 5 wrong attempts until a new one is issued', async () => {
    const { order, job } = await freshJob();
    await t.http.post(M(`/jobs/${job.id}/assign`)).set(auth(manager)).send({ driverId: did(d2) });
    await t.http.post(D(`/jobs/${job.id}/accept`)).set(auth(d2)).send({});
    await makeReady(order.id);
    await t.http.post(D(`/jobs/${job.id}/pickup`)).set(auth(d2)).send({});
    const first = (await t.http.post(M(`/jobs/${job.id}/otp`)).set(auth(manager))).body.code as string;
    const [{ delivery_otp_hash: stored }] = await sql(`select delivery_otp_hash from delivery_jobs where id = $1`, [job.id]);
    const { createHash } = await import('node:crypto');
    const unkeyed = (c: string) => createHash('sha256').update(`delivery-otp:${job.id}:${c}`).digest('hex');
    expect(stored).toMatch(/^h1:[0-9a-f]{64}$/);
    // the offline brute force that used to work finds nothing
    const found = Array.from({ length: 10_000 }, (_, i) => String(i).padStart(4, '0')).filter((c) => unkeyed(c) === stored || `h1:${unkeyed(c)}` === stored);
    expect(found).toEqual([]);

    const wrong = String((Number(first) + 1) % 10000).padStart(4, '0');
    for (let i = 1; i <= 4; i++) {
      const r = await t.http.post(D(`/jobs/${job.id}/deliver`)).set(auth(d2)).send({ otp: wrong });
      expect(r.body.error.code).toBe('otp_invalid');
    }
    // the counter is in the database (survives restarts, shared by instances)
    expect((await sql(`select otp_failed_attempts from delivery_jobs where id = $1`, [job.id]))[0].otp_failed_attempts).toBe(4);
    t.app.get(RateLimiter)['windows'].clear(); // a restart / another instance: no in-memory state
    const fifth = await t.http.post(D(`/jobs/${job.id}/deliver`)).set(auth(d2)).send({ otp: wrong });
    expect([fifth.status, fifth.body.error.code]).toEqual([423, 'otp_locked']);
    const right = await t.http.post(D(`/jobs/${job.id}/deliver`)).set(auth(d2)).send({ otp: first });
    expect([right.status, right.body.error.code]).toEqual([423, 'otp_locked']); // even the right code, once locked
    expect((await sql(`select status from delivery_jobs where id = $1`, [job.id]))[0].status).toBe('picked_up');

    const second = (await t.http.post(M(`/jobs/${job.id}/otp`)).set(auth(manager))).body.code as string;
    expect((await sql(`select otp_failed_attempts, otp_locked_at from delivery_jobs where id = $1`, [job.id]))[0]).toEqual({ otp_failed_attempts: 0, otp_locked_at: null });
    const ok = await t.http.post(D(`/jobs/${job.id}/deliver`)).set(auth(d2)).send({ otp: second, cashCollectedMinor: order.totalMinor });
    expect(ok.body).toMatchObject({ status: 'delivered' });
  });

  it('asks for a new code when the stored one predates keyed hashes', async () => {
    const { order, job } = await freshJob();
    await t.http.post(M(`/jobs/${job.id}/assign`)).set(auth(manager)).send({ driverId: did(d2) });
    await t.http.post(D(`/jobs/${job.id}/accept`)).set(auth(d2)).send({});
    await makeReady(order.id);
    await t.http.post(D(`/jobs/${job.id}/pickup`)).set(auth(d2)).send({});
    const { createHash } = await import('node:crypto');
    await sql(`update delivery_jobs set delivery_otp_hash = $2 where id = $1`, [job.id, createHash('sha256').update(`delivery-otp:${job.id}:1234`).digest('hex')]);
    const r = await t.http.post(D(`/jobs/${job.id}/deliver`)).set(auth(d2)).send({ otp: '1234' });
    expect(r.body.error.code).toBe('otp_reissue_required');
  });
});

describe('kitchen hand-over (KDS "Out for delivery")', () => {
  it('hands a driver-dispatched ticket to the driver without marking the order delivered', async () => {
    const { order, job } = await freshJob();
    await t.http.post(M(`/jobs/${job.id}/assign`)).set(auth(manager)).send({ driverId: did(d1) });
    await t.http.post(D(`/jobs/${job.id}/accept`)).set(auth(d1)).send({});
    const K = (path: string) => `/v1/o/${tenant.orgId}/kitchen${path}`;
    const early = await t.http.post(K(`/orders/${order.id}/bump`)).set(auth(manager)).send({ to: 'delivered' });
    expect(early.status).toBe(409);
    await makeReady(order.id);
    const version = (await sql(`select version from orders where id = $1`, [order.id]))[0].version;
    const bump = await t.http.post(K(`/orders/${order.id}/bump`)).set(auth(manager)).send({ to: 'delivered', version });
    expect(bump.status, JSON.stringify(bump.body)).toBe(200);
    expect(bump.body).toMatchObject({ status: 'ready', handedToDriver: true });
    const [o] = await sql(`select status, payment_status from orders where id = $1`, [order.id]);
    expect(o).toMatchObject({ status: 'ready', payment_status: 'unpaid' });
    const feed = await t.http.get(K(`/${tenant.branchId}`)).set(auth(manager));
    // The bag left the kitchen: the ticket stays on the board in the "On the way" lane (legacy KDS, VS-10) until the
    // driver delivers it. (It used to vanish from the board here, which hid deliveries in progress from the kitchen.)
    expect(feed.body.tickets.find((x: any) => x.id === order.id)).toMatchObject({ status: 'ready', handedOff: true, driverJob: true });
    // The driver still picks up and delivers; delivery is what completes the order.
    expect((await t.http.post(D(`/jobs/${job.id}/pickup`)).set(auth(d1)).send({})).body.status).toBe('picked_up');
    const photo = await t.http.post(D(`/jobs/${job.id}/proof-photo`)).set(auth(d1)).attach('file', PNG, { filename: 'proof.png', contentType: 'image/png' });
    const done = await t.http.post(D(`/jobs/${job.id}/deliver`)).set(auth(d1)).send({ proofMediaId: photo.body.mediaId, cashCollectedMinor: order.totalMinor });
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect((await sql(`select status, payment_status from orders where id = $1`, [order.id]))[0]).toMatchObject({ status: 'delivered', payment_status: 'paid' });
    const completed = await t.http.get(K(`/${tenant.branchId}`)).set(auth(manager));
    expect(completed.body.tickets.map((x: any) => x.id)).not.toContain(order.id);
    expect(completed.body.recent.map((x: any) => x.id)).toContain(order.id);
  });

  it('moves the ticket to "On the way" when the driver picks up without a kitchen hand-over', async () => {
    const { order, job } = await freshJob();
    await t.http.post(M(`/jobs/${job.id}/assign`)).set(auth(manager)).send({ driverId: did(d1) });
    await t.http.post(D(`/jobs/${job.id}/accept`)).set(auth(d1)).send({});
    await makeReady(order.id);
    const K = (path: string) => `/v1/o/${tenant.orgId}/kitchen${path}`;
    const before = await t.http.get(K(`/${tenant.branchId}`)).set(auth(manager));
    expect(before.body.tickets.map((x: any) => x.id)).toContain(order.id);
    const picked = await t.http.post(D(`/jobs/${job.id}/pickup`)).set(auth(d1)).send({});
    expect(picked.status, JSON.stringify(picked.body)).toBe(200);
    expect(picked.body.status).toBe('picked_up');
    expect((await sql(`select status from orders where id = $1`, [order.id]))[0].status).toBe('ready');
    const lines = await sql(`select distinct kitchen_status from order_lines where order_id = $1`, [order.id]);
    expect(lines.map((l) => l.kitchen_status)).toEqual(['served']);
    const events = await sql(`select details from order_events where order_id = $1 and event_type = 'picked_up_by_driver'`, [order.id]);
    expect(events).toHaveLength(1);
    expect(events[0].details).toMatchObject({ deliveryJobId: job.id, linesServed: 1 });
    const after = await t.http.get(K(`/${tenant.branchId}`)).set(auth(manager));
    expect(after.body.tickets.find((x: any) => x.id === order.id)).toMatchObject({ handedOff: true, driverJob: true });
  });
});

describe('driver device and location ingest', () => {
  it('registers devices idempotently', async () => {
    const body = { platform: 'web', deviceId: 'browser-1234567', pushToken: 'web-push-token', appVersion: '1.0.0' };
    expect((await t.http.post(D('/me/devices')).set(auth(d3)).send(body)).status).toBe(201);
    const again = await t.http.post(D('/me/devices')).set(auth(d3)).send({ ...body, appVersion: '1.0.1', pushToken: null });
    expect(again.body).toMatchObject({ appVersion: '1.0.1', hasPushToken: true });
    const rows = await sql(`select count(*)::int as n from driver_devices where driver_id = $1`, [did(d3)]);
    expect(rows[0].n).toBe(1);
  });

  it('accepts locations only on shift and rate limits batches', async () => {
    const point = { points: [{ latitude: 30.05, longitude: 31.24, accuracyM: 8 }] };
    const offShift = await t.http.post(D('/me/locations')).set(auth(d3)).send(point);
    expect(offShift.status).toBe(409);
    expect(offShift.body.error.code).toBe('not_on_shift');
    await online(d3);
    const stale = await t.http.post(D('/me/locations')).set(auth(d3)).send({ points: [{ latitude: 1, longitude: 1, recordedAt: '2020-01-01T00:00:00Z' }, point.points[0]] });
    expect(stale.body).toMatchObject({ accepted: 1, dropped: 1 });
    const results: number[] = [];
    for (let i = 0; i < 12; i++) results.push((await t.http.post(D('/me/locations')).set(auth(d3)).send(point)).status);
    expect(results.slice(0, 10).every((s) => s === 202)).toBe(true);
    expect(results.at(-1)).toBe(429);
    const [drv] = await sql(`select last_latitude, last_location_at from drivers where id = $1`, [did(d3)]);
    expect(drv.last_latitude).toBe('30.050000');
    const bad = await t.http.post(D('/me/locations')).set(auth(d2)).send({ points: [{ latitude: 200, longitude: 0 }] });
    expect(bad.status).toBe(400);
  });

  it('lets managers edit and suspend drivers', async () => {
    const list = await t.http.get(M('/drivers')).set(auth(manager));
    expect(list.body.items.length).toBeGreaterThanOrEqual(3);
    const edited = await t.http.patch(M(`/drivers/${did(d3)}`)).set(auth(manager)).send({ vehicleType: 'car', vehiclePlate: 'ABC 123', displayName: 'Karim' });
    expect(edited.body).toMatchObject({ vehicleType: 'car', vehiclePlate: 'ABC 123', displayName: 'Karim' });
    const suspended = await t.http.patch(M(`/drivers/${did(d3)}`)).set(auth(manager)).send({ status: 'suspended' });
    expect(suspended.body).toMatchObject({ status: 'suspended', availability: 'offline' });
    const blocked = await t.http.get(D('/me')).set(auth(d3));
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe('driver_suspended');
    await t.http.patch(M(`/drivers/${did(d3)}`)).set(auth(manager)).send({ status: 'active' });
    expect((await t.http.get(D('/me')).set(auth(d3))).status).toBe(200);
  });
});

describe('tenancy and entitlements', () => {
  it('hides other tenants and denies the free plan', async () => {
    const other = await createTenant(t, { country: 'EG' });
    const { job } = await freshJob();
    expect((await t.http.get(`/v1/o/${tenant.orgId}/delivery/board`).set(auth(other.owner))).status).toBe(404);
    expect((await t.http.get(`/v1/o/${other.orgId}/delivery/jobs/${job.id}`).set(auth(other.owner))).status).toBe(404);
    expect((await t.http.get(`/v1/o/${other.orgId}/delivery/drivers/${did(d1)}`).set(auth(other.owner))).status).toBe(404);

    const free = await createTenant(t, { country: 'EG', planId: 'free' });
    const denied = await t.http.get(`/v1/o/${free.orgId}/delivery/board`).set(auth(free.owner));
    expect(denied.status).toBe(402);
    expect(denied.body.error.code).toBe('module_not_entitled');
    await seedMenu(free);
    const o = await placeDelivery({ target: free });
    await dispatcher.drain();
    expect(await jobFor(o.id)).toBeUndefined();
  });
});
