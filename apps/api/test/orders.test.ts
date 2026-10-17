import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TenantContext } from '../src/common/auth/context';
import { DbService } from '../src/common/db/db.service';
import { ORDERS_QUERY_PORT, type OrdersQueryPort } from '../src/modules/kernel/ports';
import { addMember, auth, bootTestApp, createTenant, seedMenu, sql, type SeededMenu, type TestApp, type TestTenant, type TestUser } from './helpers';
import { key } from './ops-fixtures';

let t: TestApp;
let tenant: TestTenant;
let menu: SeededMenu;
let waiter: TestUser;
let kitchen: TestUser;
let cashier: TestUser;

beforeAll(async () => {
  t = await bootTestApp();
  tenant = await createTenant(t, { country: 'EG' });
  menu = await seedMenu(tenant);
  waiter = await addMember(t, tenant, 'waiter', [tenant.branchId]);
  kitchen = await addMember(t, tenant, 'kitchen', [tenant.branchId]);
  cashier = await addMember(t, tenant, 'cashier', [tenant.branchId]);
});
afterAll(async () => { await t.close(); });

const o = (path = '') => `/v1/o/${tenant.orgId}/orders${path}`;
const pickup = (extra: Record<string, unknown> = {}) => ({
  branchId: tenant.branchId, fulfillment: 'pickup', lines: [{ productId: menu.products.fries, quantity: 2 }],
  customer: { name: 'Hana', phone: '+201005550001' }, ...extra,
});

describe('staff orders', () => {
  it('creates staff orders idempotently, including dine-in that opens the table', async () => {
    const k = key('staff');
    const a = await t.http.post(o()).set(auth(waiter)).set('Idempotency-Key', k).send(pickup());
    expect(a.status).toBe(201);
    const b = await t.http.post(o()).set(auth(waiter)).set('Idempotency-Key', k).send(pickup());
    expect(b.body.id).toBe(a.body.id);
    expect((await t.http.post(o()).set(auth(waiter)).send(pickup())).status).toBe(422);
    const dine = await t.http.post(o()).set(auth(waiter)).set('Idempotency-Key', key()).send({
      branchId: tenant.branchId, fulfillment: 'dine_in', tableId: menu.tableId, lines: [{ productId: menu.products.soda, quantity: 1 }],
    });
    expect(dine.status).toBe(201);
    expect(dine.body.visitId).toBeTruthy();
    const [row] = await sql('select channel, visit_id from orders where id = $1', [dine.body.id]);
    expect(row).toEqual({ channel: 'staff', visit_id: dine.body.visitId });
    const bad = await t.http.post(o()).set(auth(waiter)).set('Idempotency-Key', key()).send({ ...pickup(), lines: [] });
    expect(bad.status).toBe(400);
  });

  it('lists with filters and cursor pagination, and shows detail with events and payments', async () => {
    for (let i = 0; i < 3; i++) await t.http.post(o()).set(auth(waiter)).set('Idempotency-Key', key()).send(pickup());
    const page1 = await t.http.get(o('?limit=2&fulfillment=pickup')).set(auth(waiter));
    expect(page1.status).toBe(200);
    expect(page1.body.items).toHaveLength(2);
    expect(page1.body.nextCursor).toBeTruthy();
    const page2 = await t.http.get(o(`?limit=2&fulfillment=pickup&cursor=${page1.body.nextCursor}`)).set(auth(waiter));
    expect(page2.body.items[0].id).not.toBe(page1.body.items[1].id);
    expect(new Date(page2.body.items[0].placedAt) <= new Date(page1.body.items[1].placedAt)).toBe(true);
    const placed = await t.http.get(o(`?status=placed,accepted&channel=staff&branchId=${tenant.branchId}`)).set(auth(waiter));
    expect(placed.body.items.every((x: any) => ['placed', 'accepted'].includes(x.status) && x.channel === 'staff')).toBe(true);
    expect((await t.http.get(o('?status=placed&limit=500')).set(auth(waiter))).status).toBe(400);

    const id = page1.body.items[0].id;
    await t.http.post(o(`/${id}/collect`)).set(auth(cashier)).set('Idempotency-Key', key()).send({ method: 'cash', amountMinor: 4000 });
    const detail = await t.http.get(o(`/${id}`)).set(auth(tenant.owner));
    expect(detail.body).toMatchObject({ id, paymentStatus: 'partially_paid', paidMinor: 4000, dueMinor: 5000, customerPhone: '+201005550001' });
    expect(detail.body.lines[0]).toMatchObject({ name: 'Fries', quantity: 2, lineTotalMinor: 9000 });
    expect(detail.body.events.map((e: any) => e.type)).toEqual(['created', 'payment_applied']);
    expect(detail.body.payments[0]).toMatchObject({ method: 'cash', provider: 'manual', amountMinor: 4000, status: 'succeeded' });
    expect(detail.body.allocations[0]).toMatchObject({ amountMinor: 4000, kind: 'payment' });
  });

  it('kitchen staff see orders but never customer contact details', async () => {
    const a = await t.http.post(o()).set(auth(waiter)).set('Idempotency-Key', key()).send(pickup());
    const asKitchen = await t.http.get(o(`/${a.body.id}`)).set(auth(kitchen));
    expect(asKitchen.status).toBe(200);
    expect(asKitchen.body).toMatchObject({ customerName: 'Hana', customerPhone: null, customerId: null, deliveryAddress: null });
    expect(JSON.stringify(asKitchen.body)).not.toContain('+201005550001');
    expect((await t.http.get(o(`/${a.body.id}`)).set(auth(waiter))).body.customerPhone).toBe('+201005550001');
  });

  it('enforces transitions, cancel permission and the refund requirement for paid orders', async () => {
    const a = await t.http.post(o()).set(auth(waiter)).set('Idempotency-Key', key()).send(pickup());
    const skip = await t.http.post(o(`/${a.body.id}/transition`)).set(auth(waiter)).send({ to: 'ready' });
    expect(skip.status).toBe(409);
    expect(skip.body.error.code).toBe('invalid_transition');
    const viaTransition = await t.http.post(o(`/${a.body.id}/transition`)).set(auth(waiter)).send({ to: 'cancelled' });
    expect(viaTransition.status).toBe(400);
    // Waiter cannot cancel; managers can.
    expect((await t.http.post(o(`/${a.body.id}/cancel`)).set(auth(waiter)).send({ reason: 'Changed mind' })).status).toBe(403);
    const stale = await t.http.post(o(`/${a.body.id}/cancel`)).set(auth(tenant.owner)).send({ reason: 'Changed mind', version: 7 });
    expect(stale.body.error.code).toBe('stale_order');
    const ok = await t.http.post(o(`/${a.body.id}/cancel`)).set(auth(tenant.owner)).send({ reason: 'Changed mind', version: 0 });
    expect(ok.status).toBe(201);
    expect(ok.body.status).toBe('cancelled');

    const paid = await t.http.post(o()).set(auth(waiter)).set('Idempotency-Key', key()).send(pickup());
    await t.http.post(o(`/${paid.body.id}/collect`)).set(auth(cashier)).set('Idempotency-Key', key()).send({ method: 'cash' });
    const refused = await t.http.post(o(`/${paid.body.id}/cancel`)).set(auth(tenant.owner)).send({ reason: 'Kitchen fire' });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toMatchObject({ code: 'refund_required', details: { paidMinor: 9000, currency: 'EGP' } });
    expect(refused.body.error.details.payments[0]).toMatchObject({ method: 'cash', allocatedMinor: 9000 });
    const [still] = await sql('select status from orders where id = $1', [paid.body.id]);
    expect(still.status).toBe('placed');
    const audit = await sql(`select action from audit_logs where entity_id = $1 order by id`, [a.body.id]);
    expect(audit.map((x) => x.action)).toEqual(['order.created', 'order.cancelled']);
  });

  it('collects cash only with payments:collect, never above what is due', async () => {
    const a = await t.http.post(o()).set(auth(waiter)).set('Idempotency-Key', key()).send(pickup());
    const host = await addMember(t, tenant, 'host', [tenant.branchId]);
    expect((await t.http.post(o(`/${a.body.id}/collect`)).set(auth(host)).set('Idempotency-Key', key()).send({ method: 'cash' })).status).toBe(403);
    const over = await t.http.post(o(`/${a.body.id}/collect`)).set(auth(cashier)).set('Idempotency-Key', key()).send({ method: 'cash', amountMinor: 999999 });
    expect(over.status).toBe(409);
    expect(over.body.error.code).toBe('overpayment');
  });

  it('hides other tenants and binds ORDERS_QUERY_PORT', async () => {
    const other = await createTenant(t);
    const a = await t.http.post(o()).set(auth(waiter)).set('Idempotency-Key', key()).send(pickup());
    expect((await t.http.get(o(`/${a.body.id}`)).set(auth(other.owner))).status).toBe(404);
    expect((await t.http.get(`/v1/o/${other.orgId}/orders/${a.body.id}`).set(auth(other.owner))).status).toBe(404);
    expect((await t.http.post(`/v1/o/${other.orgId}/orders/${a.body.id}/transition`).set(auth(other.owner)).send({ to: 'accepted' })).status).toBe(404);

    const port = t.app.get<OrdersQueryPort>(ORDERS_QUERY_PORT);
    const db = t.app.get(DbService);
    const ctx = new TenantContext(tenant.orgId, 'owner', null, tenant.owner.userId, 'user', tenant.owner.userId);
    const list = await db.scoped(ctx, (tx) => port.list(tx, ctx, { status: ['placed'], limit: 5 }));
    expect(list.items.length).toBeGreaterThan(0);
    const one = await db.scoped(ctx, (tx) => port.get(tx, ctx, a.body.id)) as any;
    expect(one.id).toBe(a.body.id);
    const otherCtx = new TenantContext(other.orgId, 'owner', null, other.owner.userId, 'user', other.owner.userId);
    await expect(db.scoped(otherCtx, (tx) => port.get(tx, otherCtx, a.body.id))).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('kitchen display', () => {
  it('filters by station, bumps lines, recalls line-level only and measures prep times', async () => {
    const grill = await sql(`select id from products where id = $1`, [menu.products.burger]);
    await sql(`update products set station = 'Fryer' where id = $1`, [menu.products.fries]);
    const a = await t.http.post(o()).set(auth(waiter)).set('Idempotency-Key', key()).send({
      branchId: tenant.branchId, fulfillment: 'pickup', customer: { name: 'Omar' },
      lines: [{ productId: grill[0].id, quantity: 1, modifiers: [{ groupId: menu.groups.size, optionId: menu.options.regular }] }, { productId: menu.products.fries, quantity: 1 }],
    });
    const fryer = await t.http.get(`/v1/o/${tenant.orgId}/kitchen/${tenant.branchId}?station=Fryer`).set(auth(kitchen));
    const ticket = fryer.body.tickets.find((x: any) => x.id === a.body.id);
    expect(ticket.lines.map((l: any) => l.station)).toEqual(['Fryer']);
    expect(fryer.body.stations).toEqual(expect.arrayContaining(['Fryer', 'Grill']));
    const detail = (await t.http.get(o(`/${a.body.id}`)).set(auth(kitchen))).body;
    const burgerLine = detail.lines.find((l: any) => l.name === 'Smash burger');
    const friesLine = detail.lines.find((l: any) => l.name === 'Fries');

    // Starting a line moves the order to preparing; finishing all lines makes it ready.
    const start = await t.http.post(`/v1/o/${tenant.orgId}/kitchen/lines/${friesLine.id}`).set(auth(kitchen)).send({ status: 'preparing' });
    expect(start.body).toMatchObject({ kitchenStatus: 'preparing', orderStatus: 'preparing' });
    await t.http.post(`/v1/o/${tenant.orgId}/kitchen/lines/${friesLine.id}`).set(auth(kitchen)).send({ status: 'ready' });
    const last = await t.http.post(`/v1/o/${tenant.orgId}/kitchen/lines/${burgerLine.id}`).set(auth(kitchen)).send({ status: 'ready' });
    expect(last.body.orderStatus).toBe('ready');
    // Recall: the line goes back to preparing, the order stays ready (ready → preparing is not a legal order transition).
    const recall = await t.http.post(`/v1/o/${tenant.orgId}/kitchen/lines/${burgerLine.id}`).set(auth(kitchen)).send({ status: 'preparing' });
    expect(recall.body).toMatchObject({ kitchenStatus: 'preparing', orderStatus: 'ready', recalled: true });
    const [rc] = await sql('select recall_count from order_lines where id = $1', [burgerLine.id]);
    expect(rc.recall_count).toBe(1);
    expect((await t.http.post(`/v1/o/${tenant.orgId}/kitchen/orders/${a.body.id}/bump`).set(auth(kitchen)).send({ to: 'preparing' })).status).toBe(409);
    await t.http.post(`/v1/o/${tenant.orgId}/kitchen/lines/${burgerLine.id}`).set(auth(kitchen)).send({ status: 'ready' });
    const done = await t.http.post(`/v1/o/${tenant.orgId}/kitchen/orders/${a.body.id}/bump`).set(auth(kitchen)).send({ to: 'picked_up' });
    expect(done.body.status).toBe('picked_up');
    const gone = await t.http.get(`/v1/o/${tenant.orgId}/kitchen/${tenant.branchId}`).set(auth(kitchen));
    expect(gone.body.tickets.find((x: any) => x.id === a.body.id)).toBeUndefined();

    const prep = await t.http.get(`/v1/o/${tenant.orgId}/kitchen/${tenant.branchId}/prep-times?days=7`).set(auth(kitchen));
    expect(prep.status).toBe(200);
    expect(prep.body.products.find((p: any) => p.name === 'Smash burger')).toMatchObject({ station: 'Grill', recalls: 1 });
    expect(prep.body.stations.map((s: any) => s.station)).toEqual(expect.arrayContaining(['Fryer', 'Grill']));

    expect((await t.http.get(`/v1/o/${tenant.orgId}/kitchen/${tenant.branchId}`).set(auth(waiter))).status).toBe(403);
    expect((await t.http.get(`/v1/o/${tenant.orgId}/kitchen/${tenant.branchId}?since=abc`).set(auth(kitchen))).status).toBe(422);
  });
});

describe('website pickup and delivery ordering', () => {
  it('places a pay-at-pickup order with customer details and tracks it publicly', async () => {
    const menuRes = await t.http.get(`/v1/public/order/${tenant.slug}`);
    expect(menuRes.status).toBe(200);
    expect(menuRes.body.payment).toEqual({ payAtPickup: true, cashOnDelivery: true, online: true });
    const quote = await t.http.post(`/v1/public/order/${tenant.slug}/quote`).send({ branchId: tenant.branchId, fulfillment: 'pickup', lines: [{ productId: menu.products.soda, quantity: 3 }] });
    expect(quote.body.totalMinor).toBe(7500);
    const k = key('web');
    const body = {
      branchId: tenant.branchId, fulfillment: 'pickup', lines: [{ productId: menu.products.soda, quantity: 3 }], payment: 'pay_at_pickup',
      customer: { name: 'Laila', phone: '+201112223334', marketingConsent: true }, expectedTotalMinor: 7500,
    };
    const placed = await t.http.post(`/v1/public/order/${tenant.slug}/orders`).set('Idempotency-Key', k).send(body);
    expect(placed.status).toBe(201);
    expect(placed.body).toMatchObject({ payment: 'pay_at_pickup', checkout: null, order: { status: 'placed', totalMinor: 7500 } });
    const replay = await t.http.post(`/v1/public/order/${tenant.slug}/orders`).set('Idempotency-Key', k).send(body);
    expect(replay.body.order.id).toBe(placed.body.order.id);
    const [row] = await sql('select channel, fulfillment, customer_name, customer_phone, customer_id from orders where id = $1', [placed.body.order.id]);
    expect(row).toMatchObject({ channel: 'web', fulfillment: 'pickup', customer_name: 'Laila', customer_phone: '+201112223334' });
    const [c] = await sql('select marketing_consent, marketing_consent_source from customers where id = $1', [row.customer_id]);
    expect(c).toEqual({ marketing_consent: true, marketing_consent_source: 'web' });
    const track = await t.http.get(`/v1/public/order/${tenant.slug}/orders/${placed.body.order.publicRef}`);
    expect(track.body).toMatchObject({ status: 'placed', totalMinor: 7500, fulfillment: 'pickup' });
    expect(JSON.stringify(track.body)).not.toContain('+20111');
    // The kitchen sees it immediately.
    const feed = await t.http.get(`/v1/o/${tenant.orgId}/kitchen/${tenant.branchId}`).set(auth(kitchen));
    expect(feed.body.tickets.some((x: any) => x.id === placed.body.order.id)).toBe(true);
  });

  it('validates delivery, cash-on-delivery and online payment availability', async () => {
    const base = {
      branchId: tenant.branchId, lines: [{ productId: menu.products.burger, quantity: 1, modifiers: [{ groupId: menu.groups.size, optionId: menu.options.regular }] }],
      customer: { name: 'Karim', phone: '+201223334445' },
    };
    const noAddress = await t.http.post(`/v1/public/order/${tenant.slug}/orders`).set('Idempotency-Key', key()).send({ ...base, fulfillment: 'delivery', payment: 'cod' });
    expect(noAddress.body.error.code).toBe('address_required');
    const wrongMethod = await t.http.post(`/v1/public/order/${tenant.slug}/orders`).set('Idempotency-Key', key()).send({ ...base, fulfillment: 'pickup', payment: 'cod' });
    expect(wrongMethod.body.error.code).toBe('payment_unavailable');
    const cod = await t.http.post(`/v1/public/order/${tenant.slug}/orders`).set('Idempotency-Key', key())
      .send({ ...base, fulfillment: 'delivery', payment: 'cod', deliveryAddress: { line1: '12 Tahrir St', area: 'Downtown', city: 'Cairo' } });
    expect(cod.status).toBe(201);
    expect(cod.body.order.totalMinor).toBe(18500 + 2500);
    // Online payment hands off to ResutoPay: the order waits for verified payment before the kitchen sees it.
    const online = await t.http.post(`/v1/public/order/${tenant.slug}/orders`).set('Idempotency-Key', key()).send({ ...base, fulfillment: 'pickup', payment: 'online' });
    expect(online.status).toBe(201);
    expect(online.body.order.status).toBe('awaiting_payment');
    expect(JSON.stringify(online.body)).toMatch(/\/pay\//);
    const invalidPhone = await t.http.post(`/v1/public/order/${tenant.slug}/orders`).set('Idempotency-Key', key()).send({ ...base, customer: { name: 'X', phone: '0100' }, fulfillment: 'pickup', payment: 'pay_at_pickup' });
    expect(invalidPhone.status).toBe(400);
    expect((await t.http.get('/v1/public/order/unknown-place')).status).toBe(404);
  });
});
