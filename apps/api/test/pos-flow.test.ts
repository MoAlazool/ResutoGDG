import 'reflect-metadata';
import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { DiscoveryService, MetadataScanner, Reflector } from '@nestjs/core';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { IS_PUBLIC, POS_DEVICE } from '../src/common/auth/decorators';
import { PosFeedService } from '../src/modules/pos/pos-feed.service';
import { addMember, auth, bootTestApp, createTenant, seedMenu, sql, type SeededMenu, type TestApp, type TestTenant, type TestUser } from './helpers';
import { addBranch } from './insights-fixtures';

// 21-POSAPI cross-platform acceptance test (docs/plans/RESUTO_2_1_PLAN.md §8): a scripted iPad (a paired device that
// only speaks the POS device API) takes an order; the web (orders list, overview, KDS) sees it; the kitchen moves the
// ticket; the device sees that through the event feed and the order sync cursor; a payment is captured and inventory
// depletion and analytics reconcile with the order totals. Plus reconnect, resync on a gap or an old cursor, offline
// replay with a duplicate client UUID, price and availability conflicts, version conflicts, branch and tenant
// isolation, revocation, and the route lockdown in both directions.

let t: TestApp;
let A: TestTenant;
let menu: SeededMenu;
let branchB: string;
let tableB: string;
let C: TestTenant;
let menuC: SeededMenu;
let manager: TestUser;
let kitchenUser: TestUser;
let waiterUser: TestUser;

interface Device { token: string; id: string; branchId: string }
let waiter: Device;     // A, main branch
let kds: Device;        // A, main branch, acting role kitchen
let cashierB: Device;   // A, branch B
let deviceC: Device;    // another restaurant

const dev = (d: Device | string) => {
  const token = typeof d === 'string' ? d : d.token;
  const h = { Authorization: `Bearer ${token}` };
  return {
    get: (p: string) => t.http.get(`/v1/pos${p}`).set(h),
    post: (p: string, body: unknown = {}) => t.http.post(`/v1/pos${p}`).set(h).send(body as object),
  };
};

async function pairDevice(tenant: TestTenant, by: TestUser, branchId: string, actingRole: 'waiter' | 'cashier' | 'kitchen', name: string): Promise<Device> {
  const code = await t.http.post(`/v1/o/${tenant.orgId}/pos/pairings`).set(auth(by)).send({ branchId, actingRole, name });
  expect(code.status, JSON.stringify(code.body)).toBe(201);
  const paired = await t.http.post('/v1/pos/pair').send({ code: code.body.code, appVersion: '0.1.0', model: 'iPad13,1' });
  expect(paired.status, JSON.stringify(paired.body)).toBe(201);
  return { token: paired.body.token, id: paired.body.device.id, branchId };
}

const burgerLine = (qty = 2) => ({
  productId: menu.products.burger, quantity: qty,
  modifiers: [{ groupId: menu.groups.size, optionId: menu.options.large }, { groupId: menu.groups.extras, optionId: menu.options.cheese }],
});

async function events(d: Device, after: number, extra = '') {
  const res = await dev(d).get(`/events?after=${after}${extra}`);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body as { epoch: string; head: number; events: Array<{ seq: number; kind: string; entityId: string; payload: any }>; nextAfter: number; hasMore: boolean };
}

/** Reads the feed to its head, like the app does after reconnecting. */
async function drain(d: Device, after: number) {
  const all: Array<{ seq: number; kind: string; entityId: string; payload: any }> = [];
  let cursor = after;
  for (let i = 0; i < 20; i++) {
    const page = await events(d, cursor);
    all.push(...page.events);
    cursor = page.nextAfter;
    if (!page.hasMore) return { events: all, after: cursor, epoch: page.epoch };
  }
  throw new Error('feed did not drain');
}

async function submit(d: Device, body: Record<string, unknown>) {
  return dev(d).post('/orders', { clientOrderId: randomUUID(), ...body });
}

beforeAll(async () => {
  t = await bootTestApp();
  A = await createTenant(t, { name: 'POS Grill' });
  menu = await seedMenu(A);
  branchB = await addBranch(t, A, 'Harbour');
  [{ id: tableB }] = await sql(`insert into dining_tables(org_id, branch_id, label, capacity, qr_token) values ($1, $2, 'H1', 4, $3) returning id`,
    [A.orgId, branchB, `qr-${randomUUID()}`]);
  C = await createTenant(t, { name: 'Other Diner' });
  menuC = await seedMenu(C);
  manager = await addMember(t, A, 'manager');
  kitchenUser = await addMember(t, A, 'kitchen');
  waiterUser = await addMember(t, A, 'waiter');
  waiter = await pairDevice(A, manager, A.branchId, 'waiter', 'Floor iPad');
  kds = await pairDevice(A, A.owner, A.branchId, 'kitchen', 'Grill KDS');
  cashierB = await pairDevice(A, A.owner, branchB, 'cashier', 'Harbour till');
  deviceC = await pairDevice(C, C.owner, C.branchId, 'cashier', 'Other till');
}, 120_000);
afterAll(async () => { await t?.close(); });

// ---------------------------------------------------------------------------
describe('pairing and device credentials', () => {
  it('pairs a device with a one-time code; the credential is hashed, scoped and audited', async () => {
    // Only devices:manage may create codes.
    const denied = await t.http.post(`/v1/o/${A.orgId}/pos/pairings`).set(auth(waiterUser)).send({ branchId: A.branchId, actingRole: 'waiter', name: 'x' });
    expect(denied.status).toBe(403);
    const managerRole = await t.http.post(`/v1/o/${A.orgId}/pos/pairings`).set(auth(manager)).send({ branchId: A.branchId, actingRole: 'manager', name: 'x' });
    expect(managerRole.status).toBe(400);

    const code = await t.http.post(`/v1/o/${A.orgId}/pos/pairings`).set(auth(manager)).send({ branchId: A.branchId, actingRole: 'cashier', name: 'Bar till' });
    expect(code.status).toBe(201);
    expect(code.body.code).toMatch(/^[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}$/);
    // Case and separators do not matter; the code works once.
    const typed = ` ${code.body.code.toLowerCase().replace('-', ' ')} `;
    const paired = await t.http.post('/v1/pos/pair').send({ code: typed, platform: 'ipados' });
    expect(paired.status, JSON.stringify(paired.body)).toBe(201);
    expect(paired.body.token).toMatch(/^rpos_[A-Za-z0-9_-]{43}$/);
    expect(paired.body).toMatchObject({ orgId: A.orgId, contractVersion: expect.any(String),
      device: { branchId: A.branchId, actingRole: 'cashier', name: 'Bar till', status: 'active', expired: false } });
    const again = await t.http.post('/v1/pos/pair').send({ code: code.body.code });
    expect(again.status).toBe(401);
    expect(again.body.error.code).toBe('pairing_code_invalid');

    const [row] = await sql(`select token_hash, token_prefix, created_by from pos_devices where id = $1`, [paired.body.device.id]);
    expect(row.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.token_hash).not.toContain(paired.body.token.slice(5));
    expect(paired.body.token.startsWith(row.token_prefix)).toBe(true);
    expect(row.created_by).toBe(manager.userId);
    const audit = await sql(`select action, actor_type from audit_logs where org_id = $1 and entity_id in ($2, $3) order by id`,
      [A.orgId, code.body.id, paired.body.device.id]);
    expect(audit).toEqual([{ action: 'pos.pairing.created', actor_type: 'user' }, { action: 'pos.device.paired', actor_type: 'device' }]);

    const session = await dev(paired.body.token).get('/session');
    expect(session.status).toBe(200);
    expect(session.body).toMatchObject({ device: { id: paired.body.device.id }, org: { id: A.orgId, currency: 'EGP' }, branch: { id: A.branchId } });
    expect(session.body.permissions).toContain('orders:write');
    expect(session.body.permissions).not.toContain('kitchen:operate');
    expect(session.body.feed).toMatchObject({ epoch: expect.any(String), head: expect.any(Number), oldest: 0 });
    expect((await sql(`select last_seen_at from pos_devices where id = $1`, [paired.body.device.id]))[0].last_seen_at).not.toBeNull();

    // The device list never shows a credential.
    const list = await t.http.get(`/v1/o/${A.orgId}/pos/devices?limit=2`).set(auth(manager));
    expect(list.status).toBe(200);
    expect(list.body.items).toHaveLength(2);
    expect(list.body.nextCursor).toEqual(expect.any(String));
    expect(JSON.stringify(list.body)).not.toMatch(/token_hash|tokenHash|rpos_[A-Za-z0-9_-]{20}/);
    const next = await t.http.get(`/v1/o/${A.orgId}/pos/devices?limit=2&cursor=${list.body.nextCursor}`).set(auth(manager));
    expect(next.body.items.length).toBeGreaterThan(0);
  });

  it('refuses expired, unknown and malformed pairing codes', async () => {
    const code = await t.http.post(`/v1/o/${A.orgId}/pos/pairings`).set(auth(A.owner)).send({ branchId: A.branchId, actingRole: 'waiter', name: 'Late' });
    await sql(`update pos_device_pairings set created_at = now() - interval '2 hours', expires_at = now() - interval '1 hour' where id = $1`, [code.body.id]);
    for (const c of [code.body.code, 'ZZZZZ-ZZZZZ', 'not-a-code!!']) {
      const res = await t.http.post('/v1/pos/pair').send({ code: c });
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('pairing_code_invalid');
    }
  });

  it('keeps device credentials and staff tokens on their own routes', async () => {
    const asDevice = await t.http.get(`/v1/o/${A.orgId}/orders`).set({ Authorization: `Bearer ${waiter.token}` });
    expect(asDevice.status).toBe(403);
    expect(asDevice.body.error.code).toBe('pos_device_only');
    const asStaff = await t.http.get('/v1/pos/session').set(auth(A.owner));
    expect(asStaff.status).toBe(403);
    expect(asStaff.body.error.code).toBe('pos_device_required');
    expect((await t.http.get('/v1/pos/session')).status).toBe(401);
    expect((await t.http.get('/v1/pos/session').set({ Authorization: 'Bearer rpos_short' })).status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
describe('cross-platform order flow', () => {
  let orderId: string;
  let feedStart: number;
  let orderCursor: string;
  let totalMinor: number;
  let beefItem: string;

  it('the device syncs menu, floor and orders, then creates an order the API persists', async () => {
    const m = await dev(waiter).get('/sync/menu');
    expect(m.status).toBe(200);
    expect(m.body.unchanged).toBe(false);
    const burger = m.body.categories.flatMap((c: any) => c.products).find((p: any) => p.id === menu.products.burger);
    expect(burger).toMatchObject({ priceMinor: 18500, available: true, station: 'Grill' });
    expect(burger.modifierGroups.map((g: any) => g.name)).toEqual(['Size', 'Extras']);
    expect(m.body.stations).toEqual(['Grill']);
    const again = await dev(waiter).get(`/sync/menu?since=${encodeURIComponent(m.body.cursor)}`);
    expect(again.body).toEqual({ cursor: m.body.cursor, unchanged: true });

    const floor = await dev(waiter).get('/sync/floor');
    expect(floor.status).toBe(200);
    expect(floor.body.tables.map((x: any) => x.label)).toEqual(['T1']);
    expect((await dev(waiter).get(`/sync/floor?since=${floor.body.cursor}`)).body.unchanged).toBe(true);

    const full = await dev(waiter).get('/sync/orders');
    expect(full.body).toMatchObject({ mode: 'full', orders: [] });
    orderCursor = full.body.cursor;
    feedStart = (await dev(waiter).get('/session')).body.feed.head;

    // Inventory: the burger uses 150 g of beef.
    const inv = `/v1/o/${A.orgId}/inventory`;
    beefItem = (await t.http.post(`${inv}/items`).set(auth(A.owner)).send({ name: 'Beef', unit: 'kg', costPerUnitMinor: 40000 })).body.id;
    expect((await t.http.put(`${inv}/recipes/${menu.products.burger}`).set(auth(A.owner)).send({ components: [{ itemId: beefItem, quantity: 150, unit: 'g' }] })).status).toBe(200);
    expect((await t.http.post(`${inv}/movements`).set(auth(A.owner)).set('Idempotency-Key', `beef-${randomUUID()}`)
      .send({ kind: 'purchase', branchId: A.branchId, itemId: beefItem, quantity: 2 })).status).toBe(201);

    // The device prices the cart with the server, then submits what it showed.
    const lines = [burgerLine(2), { productId: menu.products.fries, quantity: 1, notes: 'extra crispy' }];
    const quote = await dev(waiter).post('/orders/quote', { fulfillment: 'dine_in', lines });
    expect(quote.status, JSON.stringify(quote.body)).toBe(200);
    expect(quote.body.lines.map((l: any) => l.lineTotalMinor)).toEqual([46000, 4500]);
    const res = await submit(waiter, {
      fulfillment: 'dine_in', tableId: menu.tableId, guests: 3,
      lines: lines.map((l, i) => ({ ...l, expectedLineTotalMinor: quote.body.lines[i].lineTotalMinor })),
      expectedTotalMinor: quote.body.totalMinor, takenAt: new Date().toISOString(),
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.headers['idempotent-replayed']).toBeUndefined();
    expect(res.body.repriced).toBeNull();
    orderId = res.body.order.id;
    totalMinor = res.body.order.totalMinor;
    expect(totalMinor).toBe(quote.body.totalMinor);
    expect(res.body.order).toMatchObject({ clientOrderId: res.body.clientOrderId, channel: 'pos', fulfillment: 'dine_in', status: 'placed',
      tableId: menu.tableId, tableLabel: 'T1', open: true, version: 0, subtotalMinor: 50500 });
    expect(res.body.order.lines.map((l: any) => [l.name, l.quantity, l.lineTotalMinor, l.station])).toEqual([
      ['Smash burger', 2, 46000, 'Grill'], ['Fries', 1, 4500, 'Grill']]);

    const [o] = await sql(`select o.channel, o.total_minor, v.party_size, s.device_id from orders o join visits v on v.id = o.visit_id
      join pos_order_submissions s on s.order_id = o.id where o.id = $1`, [orderId]);
    expect(o).toEqual({ channel: 'pos', total_minor: totalMinor, party_size: 3, device_id: waiter.id });
    const audit = await sql(`select action, actor_type, actor_id from audit_logs where entity_id = $1 order by id`, [orderId]);
    expect(audit.map((a) => a.action)).toEqual(['order.created', 'pos.order.submitted']);
    expect(audit.every((a) => a.actor_type === 'device' && a.actor_id === waiter.id)).toBe(true);
  });

  it('the web orders list, the overview and the KDS show it', async () => {
    const list = await t.http.get(`/v1/o/${A.orgId}/orders?status=placed`).set(auth(A.owner));
    expect(list.body.items.find((x: any) => x.id === orderId)).toMatchObject({ channel: 'pos', totalMinor, tableLabel: 'T1', version: 0 });
    const overview = await t.http.get(`/v1/o/${A.orgId}/analytics/overview`).set(auth(A.owner));
    expect(overview.status).toBe(200);
    expect(overview.body.live).toMatchObject({ openOrders: 1, openVisits: 1 });
    expect(overview.body.today).toMatchObject({ orders: 1, netMinor: totalMinor });
    const kdsWeb = await t.http.get(`/v1/o/${A.orgId}/kitchen/${A.branchId}`).set(auth(kitchenUser));
    expect(kdsWeb.body.tickets.find((x: any) => x.id === orderId)).toMatchObject({ status: 'placed', tableLabel: 'T1', isNew: true });
    const kdsDevice = await dev(kds).get('/kitchen/tickets?station=Grill');
    expect(kdsDevice.status).toBe(200);
    expect(kdsDevice.body.tickets.map((x: any) => x.id)).toEqual([orderId]);
    const routing = await dev(kds).get('/kitchen/routing');
    expect(routing.body.stations).toEqual([{ station: 'Grill', productIds: expect.arrayContaining([menu.products.burger, menu.products.fries]) }]);
  });

  it('a kitchen ticket print job is created for the station', async () => {
    const jobs = await dev(kds).get('/print-jobs?status=pending&kind=kitchen_ticket');
    expect(jobs.status).toBe(200);
    const job = jobs.body.items.find((j: any) => j.orderId === orderId);
    expect(job).toMatchObject({ kind: 'kitchen_ticket', station: 'Grill', status: 'pending' });
    const claimed = await dev(kds).post(`/print-jobs/${job.id}/claim`);
    expect(claimed.status).toBe(200);
    expect(claimed.body.document).toMatchObject({ type: 'kitchen_ticket', station: 'Grill', order: { number: expect.any(String), tableLabel: 'T1' } });
    expect(claimed.body.document.lines).toEqual([
      { name: 'Smash burger', nameAr: null, quantity: 2, notes: null, kitchenStatus: 'queued',
        modifiers: [{ group: 'Size', option: 'Large', optionAr: null, priceDeltaMinor: 3000 }, { group: 'Extras', option: 'Cheese', optionAr: null, priceDeltaMinor: 1500 }] },
      { name: 'Fries', nameAr: null, quantity: 1, notes: 'extra crispy', kitchenStatus: 'queued', modifiers: [] },
    ]);
    // A second device cannot take a fresh claim; completing needs the claim.
    const other = await dev(waiter).post(`/print-jobs/${job.id}/claim`);
    expect(other.status).toBe(409);
    expect(other.body.error.code).toBe('print_job_claimed');
    expect((await dev(waiter).post(`/print-jobs/${job.id}/complete`, { status: 'printed' })).body.error.code).toBe('print_job_not_claimed');
    const done = await dev(kds).post(`/print-jobs/${job.id}/complete`, { status: 'printed' });
    expect(done.body).toMatchObject({ status: 'printed', claimedBy: kds.id, attempts: 1 });
    expect((await dev(kds).post(`/print-jobs/${job.id}/claim`)).body.error.code).toBe('print_job_completed');
  });

  it('the kitchen changes the ticket; the device sees it on the event feed and through the order cursor', async () => {
    // Web KDS (kitchen staff) accepts and starts; the iPad KDS marks a line ready, then the order.
    expect((await t.http.post(`/v1/o/${A.orgId}/kitchen/orders/${orderId}/bump`).set(auth(kitchenUser)).send({ to: 'accepted', version: 0 })).status).toBe(200);
    expect((await t.http.post(`/v1/o/${A.orgId}/kitchen/orders/${orderId}/bump`).set(auth(kitchenUser)).send({ to: 'preparing', version: 1 })).status).toBe(200);
    const ticket = (await dev(kds).get('/kitchen/tickets')).body.tickets.find((x: any) => x.id === orderId);
    expect(ticket.status).toBe('preparing');
    const fries = ticket.lines.find((l: any) => l.name === 'Fries');
    expect((await dev(kds).post(`/kitchen/lines/${fries.id}`, { status: 'ready' })).body).toMatchObject({ kitchenStatus: 'ready', orderStatus: 'preparing' });
    const ready = await dev(kds).post(`/kitchen/orders/${orderId}/bump`, { to: 'ready', version: ticket.version });
    expect(ready.status, JSON.stringify(ready.body)).toBe(200);
    expect(ready.body).toMatchObject({ status: 'ready', version: 3 });

    const feed = await drain(waiter, feedStart);
    const seqs = feed.events.map((e) => e.seq);
    expect(seqs).toEqual(seqs.map((_, i) => feedStart + 1 + i)); // ordered, no gaps
    const mine = feed.events.filter((e) => e.payload.orderId === orderId);
    expect(mine.map((e) => e.kind)).toEqual(expect.arrayContaining(['order.created', 'print_job.created', 'ticket.status_changed', 'order.updated']));
    expect(mine.find((e) => e.kind === 'order.created')!.payload).toMatchObject({ status: 'placed', totalMinor, channel: 'pos' });
    const tickets = mine.filter((e) => e.kind === 'ticket.status_changed').map((e) => [e.payload.scope, e.payload.to]);
    expect(tickets).toEqual([['order', 'accepted'], ['order', 'preparing'], ['line', 'ready'], ['order', 'ready']]);
    // order.updated is merged per transaction and carries the latest state.
    expect(mine.filter((e) => e.kind === 'order.updated').at(-1)!.payload).toMatchObject({ status: 'ready', version: 3 });
    expect(feed.events.some((e) => e.kind === 'table.changed' && e.payload.tableId === menu.tableId && e.payload.status === 'occupied')).toBe(true);
    // At least once: re-reading from the same point returns the same events with the same seq (the app dedupes by seq).
    const replay = await drain(waiter, feedStart);
    expect(replay.events).toEqual(feed.events);

    const delta = await dev(waiter).get(`/sync/orders?cursor=${orderCursor}`);
    expect(delta.status).toBe(200);
    expect(delta.body.mode).toBe('delta');
    expect(delta.body.orders.map((o: any) => [o.id, o.status, o.version])).toEqual([[orderId, 'ready', 3]]);
    expect(delta.body.orders[0].lines.find((l: any) => l.name === 'Fries').kitchenStatus).toBe('ready');
    orderCursor = delta.body.cursor;
    // Nothing changed since: an empty delta.
    expect((await dev(waiter).get(`/sync/orders?cursor=${orderCursor}`)).body).toMatchObject({ mode: 'delta', orders: [], cursor: orderCursor });
    // The web reflects the same status.
    expect((await t.http.get(`/v1/o/${A.orgId}/orders/${orderId}`).set(auth(A.owner))).body).toMatchObject({ status: 'ready', version: 3 });
  });

  it('payments are captured (device cash + sandbox link), and inventory and analytics reconcile with the order', async () => {
    const served = await dev(waiter).post(`/orders/${orderId}/transition`, { to: 'served', version: 3 });
    expect(served.status, JSON.stringify(served.body)).toBe(200);
    const clientPaymentId = randomUUID();
    const cash = await dev(waiter).post(`/orders/${orderId}/payments`, { clientPaymentId, method: 'cash', amountMinor: 20000 });
    expect(cash.status, JSON.stringify(cash.body)).toBe(201);
    expect(cash.body).toMatchObject({ amountMinor: 20000, paymentStatus: 'partially_paid', dueMinor: totalMinor - 20000 });
    // The offline queue replays the payment: same result, no second payment.
    const replay = await dev(waiter).post(`/orders/${orderId}/payments`, { clientPaymentId, method: 'cash', amountMinor: 20000 });
    expect(replay.status).toBe(201);
    expect(replay.body.paymentId).toBe(cash.body.paymentId);
    const reused = await dev(waiter).post(`/orders/${orderId}/payments`, { clientPaymentId, method: 'card', amountMinor: 20000 });
    expect(reused.status).toBe(409);

    // The rest through the simulated provider (sandbox: no money moves).
    const link = await t.http.post(`/v1/o/${A.orgId}/payments/links`).set(auth(A.owner)).send({ orderId, amountMinor: totalMinor - 20000, key: `pos-${randomUUID()}` });
    expect(link.status, JSON.stringify(link.body)).toBe(201);
    const token = link.body.url.split('/pay/')[1];
    expect((await t.http.post(`/v1/public/pay/${token}/start`).send({ method: 'card' })).status).toBe(200);
    expect((await t.http.post(`/v1/public/pay/${token}/sandbox/complete`).send({ outcome: 'success' })).body.status).toBe('paid');

    const order = (await dev(waiter).get(`/orders/${orderId}`)).body;
    expect(order).toMatchObject({ paymentStatus: 'paid', dueMinor: 0, paidMinor: totalMinor, open: true }); // the visit is still open
    const feed = await drain(waiter, feedStart);
    const captured = feed.events.filter((e) => e.kind === 'payment.captured');
    expect(captured.map((e) => [e.payload.method, e.payload.provider, e.payload.amountMinor, e.payload.isTest])).toEqual([
      ['cash', 'manual', 20000, false], ['card', 'simulated', totalMinor - 20000, true]]);
    expect(captured.reduce((a, e) => a + e.payload.amountMinor, 0)).toBe(totalMinor);

    // Receipt: a print job whose document carries the same totals and payments.
    const receipt = await dev(waiter).post(`/orders/${orderId}/receipt`, { clientRequestId: randomUUID() });
    expect(receipt.status).toBe(201);
    expect(receipt.body.document).toMatchObject({ type: 'receipt', currency: 'EGP', totals: { totalMinor, paidMinor: totalMinor, dueMinor: 0 } });
    expect(receipt.body.document.payments.map((p: any) => p.amountMinor)).toEqual([20000, totalMinor - 20000]);
    expect((await drain(waiter, feedStart)).events.some((e) => e.kind === 'print_job.created' && e.entityId === receipt.body.id)).toBe(true);

    // Inventory: 2 burgers × 150 g of beef.
    const sale = await sql(`select quantity_delta::text as q from stock_movements where reference_id = $1 and reason = 'sale'`, [orderId]);
    expect(sale).toEqual([{ q: '-0.300' }]);
    expect(Number((await sql(`select quantity from stock_levels where branch_id = $1 and item_id = $2`, [A.branchId, beefItem]))[0].quantity)).toBeCloseTo(1.7, 3);

    // Analytics: the order and its payments, by channel and method.
    const today = (await sql(`select (now() at time zone 'Africa/Cairo')::date::text as d`))[0].d;
    const summary = await t.http.get(`/v1/o/${A.orgId}/analytics/summary?from=${today}&to=${today}`).set(auth(A.owner));
    expect(summary.status, JSON.stringify(summary.body)).toBe(200);
    const pos = (summary.body.byChannel as any[]).find((c) => c.key === 'pos');
    expect(pos).toMatchObject({ orders: 1, netMinor: totalMinor });
    // Real payments by method; sandbox payments are reported apart (excluded from the payment mix).
    expect(summary.body.byPaymentMethod).toEqual([{ method: 'cash', collectedMinor: 20000, refundedMinor: 0, netMinor: 20000 }]);
    expect(summary.body.meta.dataCoverage.excludedTestPaymentsMinor).toBe(totalMinor - 20000);
    expect(summary.body.totals).toMatchObject({ orders: 1, netMinor: totalMinor, paidMinor: totalMinor });
    const overview = await t.http.get(`/v1/o/${A.orgId}/analytics/overview`).set(auth(A.owner));
    expect(overview.body.today).toMatchObject({ orders: 1, netMinor: totalMinor });
  });

  it('a long-poll returns as soon as an event arrives', async () => {
    const head = (await dev(waiter).get('/session')).body.feed.head;
    const started = Date.now();
    const poll = dev(waiter).get(`/events?after=${head}&wait=10`);
    setTimeout(() => {
      t.http.post(`/v1/o/${A.orgId}/menu/products/${menu.products.soda}/availability`).set(auth(A.owner)).send({ branchId: A.branchId, available: false })
        .then(() => undefined, () => undefined);
    }, 300);
    const res = await poll;
    expect(res.status).toBe(200);
    expect(Date.now() - started).toBeLessThan(8000);
    expect(res.body.events.map((e: any) => e.kind)).toEqual(expect.arrayContaining(['availability.changed', 'menu.changed']));
    expect(res.body.events.find((e: any) => e.kind === 'availability.changed').payload).toMatchObject({ productId: menu.products.soda, soldOut: true });
    await t.http.post(`/v1/o/${A.orgId}/menu/products/${menu.products.soda}/availability`).set(auth(A.owner)).send({ branchId: A.branchId, available: true });
  });
});

// ---------------------------------------------------------------------------
describe('reconnect, gaps and resync', () => {
  let D: TestTenant;
  let menuD: SeededMenu;
  let devD: Device;

  beforeAll(async () => {
    D = await createTenant(t, { name: 'Resync Cafe' });
    menuD = await seedMenu(D);
    devD = await pairDevice(D, D.owner, D.branchId, 'cashier', 'Till');
  });
  const pickup = () => ({ fulfillment: 'pickup', lines: [{ productId: menuD.products.soda, quantity: 1 }] });

  it('resumes from the last seq after a reconnect', async () => {
    expect((await submit(devD, pickup())).status).toBe(201);
    const first = await drain(devD, 0);
    expect(first.events[0]!.seq).toBe(1);
    // Offline: two more orders are taken elsewhere.
    expect((await submit(devD, pickup())).status).toBe(201);
    expect((await submit(devD, pickup())).status).toBe(201);
    const resumed = await drain(devD, first.after);
    expect(resumed.events[0]!.seq).toBe(first.after + 1);
    expect(resumed.events.filter((e) => e.kind === 'order.created')).toHaveLength(2);
    expect(resumed.epoch).toBe(first.epoch);
    // With the right epoch nothing changes; caught up = an empty page at the head.
    const caughtUp = await events(devD, resumed.after, `&epoch=${resumed.epoch}`);
    expect(caughtUp).toMatchObject({ events: [], nextAfter: resumed.after, head: resumed.after, hasMore: false });
  });

  it('answers resync_required for a gap, a cursor ahead of the head, another epoch, or a cursor older than retention', async () => {
    const { after, epoch } = await drain(devD, 0);
    const expectResync = async (q: string, reason: string) => {
      const res = await dev(devD).get(`/events?${q}`);
      expect(res.status, JSON.stringify(res.body)).toBe(409);
      expect(res.body.error).toMatchObject({ code: 'resync_required', details: { reason, epoch, head: expect.any(Number) } });
      return res.body.error.details;
    };
    await expectResync(`after=${after + 5}`, 'cursor_ahead');
    await expectResync(`after=0&epoch=${randomUUID()}`, 'epoch_mismatch');
    // A hole in the sequence (lost rows) is never skipped silently.
    await sql(`delete from pos_events where branch_id = $1 and seq = 2`, [D.branchId]);
    await expectResync('after=0', 'gap');
    expect((await dev(devD).get('/events?after=2')).status).toBe(200);

    // Retention: events past the window are purged and an older cursor must resync, for the feed and the order sync.
    const oldOrders = (await dev(devD).get('/sync/orders')).body.cursor as string;
    await sql(`update pos_events set created_at = now() - interval '8 days' where branch_id = $1 and seq <= $2`, [D.branchId, after]);
    expect((await t.app.get(PosFeedService).purge()).deleted).toBeGreaterThan(0);
    const details = await expectResync('after=1', 'cursor_expired');
    expect(details.oldest).toBe(after);
    const sync = await dev(devD).get(`/sync/orders?cursor=${oldOrders.replace(/\.\d+$/, '.1')}`);
    expect(sync.status).toBe(409);
    expect(sync.body.error.code).toBe('resync_required');
    expect((await dev(devD).get('/sync/orders?cursor=garbage')).body.error.code).toBe('invalid_cursor');

    // The resync procedure: full syncs, then follow the feed from head.
    const full = await dev(devD).get('/sync/orders');
    expect(full.body.mode).toBe('full');
    expect(full.body.orders).toHaveLength(3);
    const head = (await dev(devD).get('/session')).body.feed.head;
    expect((await dev(devD).get(`/events?after=${head}`)).status).toBe(200);
    expect((await dev(devD).get(`/sync/orders?cursor=${full.body.cursor}`)).body).toMatchObject({ mode: 'delta', orders: [] });
  });
});

// ---------------------------------------------------------------------------
describe('offline replay and conflicts', () => {
  it('a duplicate client UUID returns the original order, also when two submits race', async () => {
    const body = { clientOrderId: randomUUID(), fulfillment: 'pickup', lines: [{ productId: menu.products.fries, quantity: 2, expectedLineTotalMinor: 9000 }] };
    const first = await dev(waiter).post('/orders', body);
    expect(first.status).toBe(201);
    const replay = await dev(waiter).post('/orders', body);
    expect(replay.status).toBe(201);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(replay.body).toEqual(first.body);
    expect((await sql(`select count(*)::int as n from pos_order_submissions where client_order_id = $1`, [body.clientOrderId]))[0].n).toBe(1);
    const reused = await dev(waiter).post('/orders', { ...body, lines: [{ productId: menu.products.fries, quantity: 3 }] });
    expect(reused.status).toBe(409);
    expect(reused.body.error.code).toBe('client_order_id_reused');

    const racing = { clientOrderId: randomUUID(), fulfillment: 'pickup', lines: [{ productId: menu.products.soda, quantity: 1 }] };
    const both = await Promise.all([dev(waiter).post('/orders', racing), dev(waiter).post('/orders', racing)]);
    expect(both.map((r) => r.status)).toEqual([201, 201]);
    expect(both[0]!.body.order.id).toBe(both[1]!.body.order.id);
    const ids = await sql(`select o.id from orders o join pos_order_submissions s on s.order_id = o.id where s.client_order_id = $1`, [racing.clientOrderId]);
    expect(ids).toHaveLength(1);
  });

  it('a price changed while offline is a conflict with current values, or repriced when the device opts in', async () => {
    const before = (await dev(waiter).get('/sync/menu')).body.cursor;
    expect((await t.http.put(`/v1/o/${A.orgId}/menu/products/${menu.products.fries}/branches/${A.branchId}`).set(auth(A.owner))
      .send({ priceOverrideMinor: 5000 })).status).toBe(200);
    const clientOrderId = randomUUID();
    const queued = { clientOrderId, fulfillment: 'pickup', lines: [{ productId: menu.products.fries, quantity: 2, expectedLineTotalMinor: 9000 }], expectedTotalMinor: 9000 };
    const refused = await dev(waiter).post('/orders', queued);
    expect(refused.status).toBe(409);
    expect(refused.body.error).toMatchObject({ code: 'pos_price_changed', details: {
      currency: 'EGP', expectedTotalMinor: 9000, currentTotalMinor: 10000,
      lines: [{ index: 0, productId: menu.products.fries, expectedLineTotalMinor: 9000, currentLineTotalMinor: 10000, currentUnitPriceMinor: 5000, currentModifiersTotalMinor: 0 }],
    } });
    expect(refused.body.error.details.menuCursor).not.toBe(before);
    expect((await sql(`select count(*)::int as n from pos_order_submissions where client_order_id = $1`, [clientOrderId]))[0].n).toBe(0);
    // The same queued order, now accepting server prices.
    const accepted = await dev(waiter).post('/orders', { ...queued, repricing: 'accept' });
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(201);
    expect(accepted.body.order.totalMinor).toBe(10000);
    expect(accepted.body.repriced).toMatchObject({ expectedTotalMinor: 9000, totalMinor: 10000, lines: [{ index: 0, currentLineTotalMinor: 10000 }] });
    const menuNow = (await dev(waiter).get(`/sync/menu?since=${encodeURIComponent(before)}`)).body;
    expect(menuNow.unchanged).toBe(false);
    expect(menuNow.categories.flatMap((c: any) => c.products).find((p: any) => p.id === menu.products.fries).priceMinor).toBe(5000);
    await t.http.put(`/v1/o/${A.orgId}/menu/products/${menu.products.fries}/branches/${A.branchId}`).set(auth(A.owner)).send({ priceOverrideMinor: null });
  });

  it('an unavailable item is a conflict that lists every item with its current state', async () => {
    await t.http.post(`/v1/o/${A.orgId}/menu/products/${menu.products.soda}/availability`).set(auth(A.owner)).send({ branchId: A.branchId, available: false });
    const res = await submit(waiter, { fulfillment: 'pickup', lines: [
      { productId: menu.products.soda, quantity: 1 }, { productId: menu.products.fries, quantity: 1 }, { productId: menu.products.limited, quantity: 3 },
      { productId: menuC.products.soda, quantity: 1 }] });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('pos_items_unavailable');
    expect(res.body.error.details.items).toEqual([
      { index: 0, productId: menu.products.soda, reason: 'sold_out', availableQty: null },
      { index: 2, productId: menu.products.limited, reason: 'out_of_stock', availableQty: 2 },
      { index: 3, productId: menuC.products.soda, reason: 'not_on_menu', availableQty: null },
    ]);
    await t.http.post(`/v1/o/${A.orgId}/menu/products/${menu.products.soda}/availability`).set(auth(A.owner)).send({ branchId: A.branchId, available: true });
  });

  it('concurrent status changes: one wins, the other gets stale_order with the current version', async () => {
    const placed = await submit(waiter, { fulfillment: 'pickup', lines: [{ productId: menu.products.fries, quantity: 1 }] });
    const id = placed.body.order.id;
    const [a, b] = await Promise.all([
      dev(waiter).post(`/orders/${id}/transition`, { to: 'accepted', version: 0 }),
      t.http.post(`/v1/o/${A.orgId}/kitchen/orders/${id}/bump`).set(auth(kitchenUser)).send({ to: 'preparing', version: 0 }),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const loser = a.status === 409 ? a : b;
    expect(loser.body.error).toMatchObject({ code: 'stale_order', details: { version: 1 } });
    // Without a version a device cannot change status.
    expect((await dev(waiter).post(`/orders/${id}/transition`, { to: 'ready' })).status).toBe(400);
    expect((await dev(kds).post(`/kitchen/orders/${id}/bump`, { to: 'ready', version: 0 })).body.error.code).toBe('stale_order');
  });
});

// ---------------------------------------------------------------------------
describe('isolation and revocation', () => {
  it('a device of branch A cannot read or write branch B or another restaurant', async () => {
    const inB = await submit(cashierB, { fulfillment: 'pickup', lines: [{ productId: menu.products.fries, quantity: 1 }] });
    expect(inB.status, JSON.stringify(inB.body)).toBe(201);
    const bId = inB.body.order.id;
    const inC = await submit(deviceC, { fulfillment: 'pickup', lines: [{ productId: menuC.products.fries, quantity: 1 }] });
    expect(inC.status).toBe(201);
    const cId = inC.body.order.id;

    for (const id of [bId, cId]) {
      expect((await dev(waiter).get(`/orders/${id}`)).status).toBe(404);
      expect((await dev(waiter).post(`/orders/${id}/transition`, { to: 'accepted', version: 0 })).status).toBe(404);
      expect((await dev(waiter).post(`/orders/${id}/payments`, { clientPaymentId: randomUUID(), method: 'cash' })).status).toBe(404);
      expect((await dev(waiter).post(`/orders/${id}/receipt`, { clientRequestId: randomUUID() })).status).toBe(404);
      expect((await dev(kds).post(`/kitchen/orders/${id}/bump`, { to: 'accepted', version: 0 })).status).toBe(404);
    }
    const bLine = (await sql(`select id from order_lines where order_id = $1`, [bId]))[0].id;
    expect((await dev(kds).post(`/kitchen/lines/${bLine}`, { status: 'ready' })).status).toBe(404);
    const bJob = (await sql(`select id from pos_print_jobs where order_id = $1`, [bId]))[0].id;
    expect((await dev(waiter).get(`/print-jobs/${bJob}`)).status).toBe(404);
    expect((await dev(waiter).post(`/print-jobs/${bJob}/claim`)).status).toBe(404);
    // A table of branch B, a table of another restaurant.
    for (const tableId of [tableB, menuC.tableId]) {
      expect((await submit(waiter, { fulfillment: 'dine_in', tableId, lines: [{ productId: menu.products.fries, quantity: 1 }] })).status).toBe(404);
    }
    // Feeds and syncs carry only the device's own branch.
    const mine = await drain(waiter, 0);
    expect(mine.events.some((e) => e.entityId === bId || e.entityId === cId || e.payload.orderId === bId)).toBe(false);
    const syncA = (await dev(waiter).get('/sync/orders')).body.orders.map((o: any) => o.id);
    expect(syncA).not.toContain(bId);
    expect(syncA).not.toContain(cId);
    expect((await dev(cashierB).get('/sync/orders')).body.orders.map((o: any) => o.id)).toContain(bId);
    // Device credentials never reach staff routes, of their own restaurant or another.
    for (const p of [`/v1/o/${A.orgId}/orders`, `/v1/o/${C.orgId}/orders`, `/v1/o/${A.orgId}/pos/devices`]) {
      expect((await t.http.get(p).set({ Authorization: `Bearer ${deviceC.token}` })).body.error.code).toBe('pos_device_only');
    }
    // Staff of A cannot see C's devices; a branch-scoped manager of B cannot revoke a device of the main branch.
    expect((await t.http.get(`/v1/o/${A.orgId}/pos/devices/${deviceC.id}`).set(auth(A.owner))).status).toBe(404);
    const mgrB = await addMember(t, A, 'manager', [branchB]);
    expect((await t.http.post(`/v1/o/${A.orgId}/pos/devices/${waiter.id}/revoke`).set(auth(mgrB)).send({})).status).toBe(404);
    expect((await t.http.get(`/v1/o/${A.orgId}/pos/devices`).set(auth(mgrB))).body.items.map((d: any) => d.id)).toEqual([cashierB.id]);
    expect((await t.http.post(`/v1/o/${A.orgId}/pos/pairings`).set(auth(mgrB)).send({ branchId: A.branchId, actingRole: 'waiter', name: 'x' })).status).toBe(403);
  });

  it('enforces the acting role of the device', async () => {
    expect((await dev(waiter).get('/kitchen/tickets')).status).toBe(403);
    expect((await dev(kds).get('/sync/floor')).status).toBe(403);
    expect((await submit(kds, { fulfillment: 'pickup', lines: [{ productId: menu.products.fries, quantity: 1 }] })).status).toBe(403);
    expect((await dev(kds).get('/sync/menu')).status).toBe(200);
  });

  it('refuses a revoked or expired device and a device of a suspended restaurant', async () => {
    const victim = await pairDevice(A, A.owner, A.branchId, 'waiter', 'Lost iPad');
    expect((await dev(victim).get('/session')).status).toBe(200);
    const revoked = await t.http.post(`/v1/o/${A.orgId}/pos/devices/${victim.id}/revoke`).set(auth(manager)).send({ reason: 'Lost' });
    expect(revoked.status).toBe(200);
    expect(revoked.body).toMatchObject({ status: 'revoked', revokeReason: 'Lost' });
    for (const res of [await dev(victim).get('/session'), await dev(victim).get('/events?after=0'), await submit(victim, { fulfillment: 'pickup', lines: [{ productId: menu.products.fries, quantity: 1 }] })]) {
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('device_revoked');
    }
    expect((await sql(`select actor_type, actor_id from audit_logs where action = 'pos.device.revoked' and entity_id = $1`, [victim.id]))[0])
      .toEqual({ actor_type: 'user', actor_id: manager.userId });

    const old = await pairDevice(A, A.owner, A.branchId, 'waiter', 'Old iPad');
    await sql(`update pos_devices set expires_at = now() - interval '1 minute' where id = $1`, [old.id]);
    expect((await dev(old).get('/session')).body.error.code).toBe('device_expired');

    await sql(`update organizations set status = 'suspended' where id = $1`, [C.orgId]);
    expect((await dev(deviceC).get('/session')).status).toBe(401);
    await sql(`update organizations set status = 'active' where id = $1`, [C.orgId]);
    expect((await dev(deviceC).get('/session')).status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
describe('route lockdown and the compatibility checklist', () => {
  const VERBS: Partial<Record<RequestMethod, 'get' | 'post' | 'put' | 'patch' | 'delete'>> = {
    [RequestMethod.GET]: 'get', [RequestMethod.POST]: 'post', [RequestMethod.PUT]: 'put', [RequestMethod.PATCH]: 'patch', [RequestMethod.DELETE]: 'delete',
  };
  const routes = () => {
    const discovery = t.app.get(DiscoveryService);
    const scanner = t.app.get(MetadataScanner);
    const reflector = t.app.get(Reflector);
    const join = (...parts: string[]) => `/${parts.map((p) => p.replace(/^\/+|\/+$/g, '')).filter(Boolean).join('/')}`;
    const out: Array<{ verb: 'get' | 'post' | 'put' | 'patch' | 'delete'; path: string; isPublic: boolean; pos: boolean }> = [];
    for (const wrapper of discovery.getControllers()) {
      const cls = wrapper.metatype as any;
      if (!cls) continue;
      const pos = Reflect.getMetadata(POS_DEVICE, cls) === true;
      for (const name of scanner.getAllMethodNames(cls.prototype)) {
        const handler = cls.prototype[name];
        const method = Reflect.getMetadata(METHOD_METADATA, handler) as RequestMethod | undefined;
        if (method === undefined) continue;
        const isPublic = !!reflector.getAllAndOverride<boolean>(IS_PUBLIC, [handler, cls]);
        for (const b of [Reflect.getMetadata(PATH_METADATA, cls) ?? ''].flat() as string[]) {
          for (const p of [Reflect.getMetadata(PATH_METADATA, handler) ?? ''].flat() as string[]) out.push({ verb: VERBS[method]!, path: join('v1', b, p), isPublic, pos });
        }
      }
    }
    return out;
  };
  const fill = (p: string) => p.replace(':orgId', A.orgId).replace(/\*\w+/g, 'x/y.png').replace(/:(\w+)/g, '6f1c2a40-0000-4000-8000-0000000000ff');

  it('refuses a device credential on every authenticated route outside the POS device API, and a staff token on every device route', async () => {
    const all = routes();
    expect(all.length).toBeGreaterThan(300);
    const leaks: string[] = [];
    for (const r of all.filter((x) => !x.isPublic && !x.pos)) {
      const res = await t.http[r.verb](fill(r.path)).set({ Authorization: `Bearer ${waiter.token}` }).send({});
      if (res.status !== 403 || res.body?.error?.code !== 'pos_device_only') leaks.push(`${r.verb.toUpperCase()} ${r.path} → ${res.status}`);
    }
    expect(leaks).toEqual([]);
    const device = all.filter((x) => x.pos);
    expect(device.length).toBeGreaterThan(15);
    for (const r of device) {
      const res = await t.http[r.verb](fill(r.path)).set(auth(A.owner)).send({});
      if (res.status !== 403 || res.body?.error?.code !== 'pos_device_required') leaks.push(`${r.verb.toUpperCase()} ${r.path} → ${res.status}`);
    }
    expect(leaks).toEqual([]);
  });

  it('docs/api/IPAD_COMPATIBILITY.md lists exactly the POS routes the API serves', () => {
    const doc = fs.readFileSync(path.resolve(__dirname, '../../../docs/api/IPAD_COMPATIBILITY.md'), 'utf8');
    const listed = new Set([...doc.matchAll(/`(GET|POST|PUT|PATCH|DELETE) (\/v1\/(?:pos|o\/:orgId\/pos)\/[^`\s]*)`/g)].map((m) => `${m[1]} ${m[2]}`));
    const served = new Set(routes().filter((r) => r.path.startsWith('/v1/pos') || r.path.startsWith('/v1/o/:orgId/pos/')).map((r) => `${r.verb.toUpperCase()} ${r.path}`));
    expect([...served].filter((r) => !listed.has(r))).toEqual([]);
    expect([...listed].filter((r) => !served.has(r))).toEqual([]);
  });
});
