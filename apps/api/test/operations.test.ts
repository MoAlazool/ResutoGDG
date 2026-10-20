import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addMember, auth, bootTestApp, createTenant, seedMenu, sql, type SeededMenu, type TestApp, type TestTenant, type TestUser } from './helpers';
import { key, saveFloor, table } from './ops-fixtures';

// Operations restored from the original workspace (ws5): active visits (VS-13), live floor side panel data (VS-11),
// service model and venue QR (VS-16, FT-07), and the guided setup with a server-derived checklist (FT-13, VS-17).

let t: TestApp;
let tenant: TestTenant;
let menu: SeededMenu;
let host: TestUser;
let waiter: TestUser;
let manager: TestUser;

beforeAll(async () => {
  t = await bootTestApp();
  tenant = await createTenant(t, { country: 'EG' });
  menu = await seedMenu(tenant);
  host = await addMember(t, tenant, 'host', [tenant.branchId]);
  waiter = await addMember(t, tenant, 'waiter', [tenant.branchId]);
  manager = await addMember(t, tenant, 'manager');
});
afterAll(async () => { await t.close(); });

const O = (path: string) => `/v1/o/${tenant.orgId}${path}`;

describe('active visits and the live floor side panel', () => {
  it('lists open visits with bills, kitchen counts and the auto-open window', async () => {
    const f = await saveFloor(t, tenant, [table('V1', 150, 300), table('V2', 400, 300)]);
    const [v1, v2] = f.tables;
    const seat = await t.http.post(O('/visits')).set(auth(host)).send({ tableId: v1.id, partySize: 3 });
    expect(seat.status).toBe(201);
    const order = await t.http.post(O('/orders')).set(auth(waiter)).set('Idempotency-Key', key('v')).send({
      branchId: tenant.branchId, fulfillment: 'dine_in', tableId: v1.id, lines: [{ productId: menu.products.fries, quantity: 2 }],
    });
    expect(order.status).toBe(201);

    const list = await t.http.get(O(`/visits?branchId=${tenant.branchId}`)).set(auth(host));
    expect(list.status).toBe(200);
    const card = list.body.items.find((x: any) => x.id === seat.body.id);
    expect(card).toMatchObject({ tableLabel: 'V1', partySize: 3, orderCount: 1, openOrders: 1, totalMinor: 9000, dueMinor: 9000, billingLocked: false, currency: 'EGP' });

    const live = await t.http.get(O(`/floor/${tenant.branchId}/live`)).set(auth(host));
    const t1 = live.body.tables.find((x: any) => x.id === v1.id);
    expect(t1.visit).toMatchObject({ preparing: 1, ready: 0, totalMinor: 9000, openedVia: 'staff', undoable: false });
    expect(live.body.tables.find((x: any) => x.id === v2.id).visit).toBeNull();
    // No QR token reaches the polled live payload.
    expect(JSON.stringify(live.body)).not.toMatch(/qr_?token|\/t\//i);
  });

  it('gives a table QR to floor writers only, and audits each view', async () => {
    const f = await t.http.get(O(`/floor/${tenant.branchId}`)).set(auth(tenant.owner));
    const tableId = f.body.tables[0].id;
    expect((await t.http.get(O(`/floor/${tenant.branchId}/qr/${tableId}`)).set(auth(host))).status).toBe(403);
    const qr = await t.http.get(O(`/floor/${tenant.branchId}/qr/${tableId}`)).set(auth(manager));
    expect(qr.status).toBe(200);
    expect(qr.body.url).toMatch(/^http:\/\/app\.test\/t\/.{16,}/);
    expect(qr.body.svg).toContain('<svg');
    const [audit] = await sql(`select action from audit_logs where org_id = $1 and entity_id = $2 order by id desc limit 1`, [tenant.orgId, tableId]);
    expect(audit.action).toBe('floor.table_qr_viewed');
  });
});

describe('service model and venue QR (VS-16, FT-07)', () => {
  it('switches a branch to counter service: no dine-in or reservations, pickup on, one venue QR', async () => {
    const shop = await createTenant(t, { country: 'EG' });
    const S = (path: string) => `/v1/o/${shop.orgId}${path}`;
    const bad = await t.http.put(S(`/branches/${shop.branchId}/service-mode`)).set(auth(shop.owner)).send({ mode: 'counter', acceptsReservations: true });
    expect(bad.status).toBe(422);
    const r = await t.http.put(S(`/branches/${shop.branchId}/service-mode`)).set(auth(shop.owner)).send({ mode: 'counter' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ serviceMode: 'counter', acceptsDineIn: false, acceptsPickup: true, acceptsReservations: false });
    const org = await t.http.get(S('')).set(auth(shop.owner));
    expect(org.body.branches[0]).toMatchObject({ serviceMode: 'counter', acceptsDineIn: false });
    const venue = await t.http.get(S(`/floor/${shop.branchId}/venue-qr`)).set(auth(shop.owner));
    expect(venue.body.url).toBe(`http://app.test/order/${shop.slug}?branch=${org.body.branches[0].code}`);
    expect(venue.body.svg).toContain('<svg');
    const k = await t.http.get(S(`/kitchen/${shop.branchId}`)).set(auth(shop.owner));
    expect(k.body.serviceMode).toBe('counter');
    // A waiter cannot change how the restaurant serves guests.
    const w = await addMember(t, shop, 'waiter');
    expect((await t.http.put(S(`/branches/${shop.branchId}/service-mode`)).set(auth(w)).send({ mode: 'tables' })).status).toBe(403);
    const back = await t.http.put(S(`/branches/${shop.branchId}/service-mode`)).set(auth(shop.owner)).send({ mode: 'tables', acceptsReservations: true });
    expect(back.body).toMatchObject({ serviceMode: 'tables', acceptsDineIn: true, acceptsReservations: true });
  });
});

describe('guided setup: checklist derived from data (FT-13)', () => {
  it('derives every step, refuses self-assertion, and gates launch on the required steps', async () => {
    const shop = await createTenant(t, { country: 'EG' });
    const S = (path: string) => `/v1/o/${shop.orgId}${path}`;
    const steps = async () => Object.fromEntries((await t.http.get(S('/setup')).set(auth(shop.owner))).body.steps.map((s: any) => [s.step, s.done]));
    expect(await steps()).toMatchObject({ welcome: true, profile: false, mode: false, menu: false, floor: false, launch: false });

    // The old "Mark done" is gone: a step can no longer be ticked by hand.
    const tick = await t.http.post(S('/onboarding/menu')).set(auth(shop.owner)).send({});
    expect(tick.status).toBe(409);
    expect(tick.body.error.code).toBe('setup_step_derived');
    const early = await t.http.post(S('/setup/launch')).set(auth(shop.owner)).send({});
    expect(early.status).toBe(409);
    expect(early.body.error).toMatchObject({ code: 'setup_incomplete' });
    expect(early.body.error.details.missing).toEqual(expect.arrayContaining(['profile', 'branch', 'mode', 'menu', 'floor']));

    await t.http.patch(S('')).set(auth(shop.owner)).send({ legalName: 'Shop LLC' }).expect(200);
    await t.http.patch(S(`/branches/${shop.branchId}`)).set(auth(shop.owner))
      .send({ address: '1 Nile St', openingHours: [{ day: 1, opens: '09:00', closes: '23:00' }] }).expect(200);
    await t.http.put(S(`/branches/${shop.branchId}/service-mode`)).set(auth(shop.owner)).send({ mode: 'tables' }).expect(200);
    const m = await seedMenu(shop);
    expect(await steps()).toMatchObject({ profile: true, branch: true, mode: true, menu: true, floor: true });
    // An 86'd dish does not count as a menu guests can order from; the floor counts only active tables.
    await sql(`update products set is_active = false where org_id = $1 and id <> $2`, [shop.orgId, m.products.fries]);
    await t.http.post(S(`/menu/products/${m.products.fries}/availability`)).set(auth(shop.owner)).send({ branchId: shop.branchId, available: false }).expect(201);
    expect((await steps()).menu).toBe(false);
    await t.http.post(S(`/menu/products/${m.products.fries}/availability`)).set(auth(shop.owner)).send({ branchId: shop.branchId, available: true }).expect(201);

    const launch = await t.http.post(S('/setup/launch')).set(auth(shop.owner)).send({});
    expect(launch.status).toBe(201);
    expect(launch.body).toMatchObject({ launched: true, ready: true, status: 'active' });
    const [audit] = await sql(`select action from audit_logs where org_id = $1 and action = 'organization.launched'`, [shop.orgId]);
    expect(audit).toBeTruthy();
    // Managers without org:manage cannot see or launch the setup.
    const mgr = await addMember(t, shop, 'manager');
    expect((await t.http.get(S('/setup')).set(auth(mgr))).status).toBe(403);
  });
});
