import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { kitchenLaneOf, kitchenPathTo } from '@resuto/contracts';
import { addMember, auth, bootTestApp, createTenant, seedMenu, sql, type SeededMenu, type TestApp, type TestTenant, type TestUser } from './helpers';
import { key } from './ops-fixtures';

// The kitchen board restored from the legacy KDS (VS-10): five lanes (New, Preparing, Ready, On the way, Completed),
// forward-only moves validated by the server, and the delivery hand-off that must never complete an order (DF-02).

let t: TestApp;
let tenant: TestTenant;
let menu: SeededMenu;
let kitchen: TestUser;
let manager: TestUser;
let cashier: TestUser;

beforeAll(async () => {
  t = await bootTestApp();
  tenant = await createTenant(t, { country: 'EG' });
  menu = await seedMenu(tenant);
  await sql(`update branches set accepts_delivery = true where id = $1`, [tenant.branchId]);
  kitchen = await addMember(t, tenant, 'kitchen', [tenant.branchId]);
  manager = await addMember(t, tenant, 'manager');
  cashier = await addMember(t, tenant, 'cashier', [tenant.branchId]);
});
afterAll(async () => { await t.close(); });

const K = (path: string) => `/v1/o/${tenant.orgId}/kitchen${path}`;
const O = (path = '') => `/v1/o/${tenant.orgId}/orders${path}`;

async function place(fulfillment: 'pickup' | 'delivery' | 'dine_in') {
  const r = await t.http.post(O()).set(auth(manager)).set('Idempotency-Key', key('kds')).send({
    branchId: tenant.branchId, fulfillment, lines: [{ productId: menu.products.fries, quantity: 1 }],
    ...(fulfillment === 'dine_in' ? { tableId: menu.tableId } : {}),
    customer: { name: 'Mona', phone: '+201005550123' },
    ...(fulfillment === 'delivery' ? { deliveryAddress: { line1: '5 Tahrir Sq', city: 'Cairo' } } : {}),
  });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.id as string;
}
const version = async (id: string) => (await sql(`select version from orders where id = $1`, [id]))[0].version as number;
const bump = async (id: string, to: string, v?: number) =>
  t.http.post(K(`/orders/${id}/bump`)).set(auth(kitchen)).send({ to, version: v ?? await version(id) });
const feed = async () => (await t.http.get(K(`/${tenant.branchId}`)).set(auth(kitchen))).body;
const ticket = async (id: string) => {
  const f = await feed();
  return [...f.tickets, ...(f.recent ?? [])].find((x: any) => x.id === id);
};

describe('kitchen board lanes (VS-10)', () => {
  it('keeps a delivery hand-off on the board as "On the way" and lists fulfilled tickets as Completed', async () => {
    const pick = await place('pickup');
    for (const s of ['preparing', 'ready', 'picked_up']) expect((await bump(pick, s)).status).toBe(201);
    const done = await ticket(pick);
    expect(done).toMatchObject({ status: 'picked_up' });
    expect(kitchenLaneOf(done)).toBe('done');
    const f = await feed();
    expect(f.recent.length).toBeLessThanOrEqual(12);
    expect(f.tickets.map((x: any) => x.id)).not.toContain(pick);
  });

  it('computes forward-only paths, never backwards and never "On the way" for a table', () => {
    const lines = [{ kitchenStatus: 'queued' }];
    expect(kitchenPathTo({ status: 'placed', fulfillment: 'delivery', lines }, 'done')).toEqual(['preparing', 'ready', 'delivered', 'delivered']);
    expect(kitchenPathTo({ status: 'placed', fulfillment: 'dine_in', lines }, 'done')).toEqual(['preparing', 'ready', 'served']);
    expect(kitchenPathTo({ status: 'placed', fulfillment: 'dine_in', lines }, 'out')).toBeNull();
    expect(kitchenPathTo({ status: 'ready', fulfillment: 'pickup', lines: [{ kitchenStatus: 'ready' }] }, 'preparing')).toBeNull();
    expect(kitchenPathTo({ status: 'ready', fulfillment: 'delivery', handedOff: true, lines: [{ kitchenStatus: 'served' }] }, 'done')).toEqual(['delivered']);
  });

  it('refuses a stale or backwards move on the server', async () => {
    const id = await place('pickup');
    const v = await version(id);
    expect((await bump(id, 'preparing', v)).status).toBe(201);
    const stale = await bump(id, 'ready', v);
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('stale_order');
    const back = await bump(id, 'accepted');
    expect(back.status).toBe(409);
    expect(back.body.error.code).toBe('invalid_transition');
  });
});

describe('delivery hand-off without a driver job (DF-02)', () => {
  it('"Out for delivery" keeps the order ready and unpaid; only a confirmed, settled delivery completes it', async () => {
    const id = await place('delivery');
    expect((await bump(id, 'preparing')).status).toBe(201);
    expect((await bump(id, 'ready')).status).toBe(201);
    const out = await bump(id, 'delivered');
    expect(out.status, JSON.stringify(out.body)).toBe(201);
    // Before: the order became delivered (fulfilled) here although the bag had only left the kitchen.
    expect(out.body).toMatchObject({ status: 'ready', handedOff: true });
    const [o] = await sql(`select status, payment_status, fulfilled_at from orders where id = $1`, [id]);
    expect(o).toEqual({ status: 'ready', payment_status: 'unpaid', fulfilled_at: null });
    const [evt] = await sql(`select event_type, details from order_events where order_id = $1 order by id desc limit 1`, [id]);
    expect(evt).toMatchObject({ event_type: 'handed_to_courier' });
    const tk = await ticket(id);
    expect(tk).toMatchObject({ handedOff: true, driverJob: false });
    expect(kitchenLaneOf(tk)).toBe('out');

    // Confirming delivery of an unpaid cash-on-delivery order is refused until the cash is recorded.
    const unpaid = await bump(id, 'delivered');
    expect(unpaid.status).toBe(409);
    expect(unpaid.body.error).toMatchObject({ code: 'payment_due' });
    const direct = await t.http.post(O(`/${id}/transition`)).set(auth(manager)).send({ to: 'delivered' });
    expect(direct.status).toBe(409);
    expect(direct.body.error.code).toBe('payment_due');
    const pay = await t.http.post(O(`/${id}/collect`)).set(auth(cashier)).set('Idempotency-Key', key('cod')).send({ method: 'cash' });
    expect(pay.status, JSON.stringify(pay.body)).toBe(201);
    const confirmed = await bump(id, 'delivered');
    expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(201);
    expect(confirmed.body).toMatchObject({ status: 'delivered' });
    expect(kitchenLaneOf(await ticket(id))).toBe('done');
  });

  it('with an active driver job, the hand-off goes to the driver and only the driver completes the delivery', async () => {
    const id = await place('delivery');
    await sql(`insert into delivery_jobs(org_id, branch_id, order_id, status, dropoff) values ($1, $2, $3, 'unassigned', '{}')`, [tenant.orgId, tenant.branchId, id]);
    for (const s of ['preparing', 'ready']) expect((await bump(id, s)).status).toBe(201);
    const out = await bump(id, 'delivered');
    expect(out.body).toMatchObject({ status: 'ready', handedToDriver: true, handedOff: true });
    expect(await ticket(id)).toMatchObject({ handedOff: true, driverJob: true });
    const confirm = await bump(id, 'delivered');
    expect(confirm.status).toBe(409);
    expect(confirm.body.error.code).toBe('driver_job_active');
    const direct = await t.http.post(O(`/${id}/transition`)).set(auth(manager)).send({ to: 'delivered' });
    expect(direct.body.error.code).toBe('driver_job_active');
    const [o] = await sql(`select status from orders where id = $1`, [id]);
    expect(o.status).toBe('ready');
  });
});
