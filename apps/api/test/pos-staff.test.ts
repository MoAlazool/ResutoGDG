import { ROLE_PERMISSIONS } from '@resuto/contracts';
import { SignJWT } from 'jose';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { RateLimiter } from '../src/common/http/rate-limiter';
import { addMember, auth, bootTestApp, createTenant, seedMenu, sql, testDb, type SeededMenu, type TestApp, type TestTenant, type TestUser } from './helpers';
import { addBranch } from './insights-fixtures';

// POS contract 0.2.0 (docs/api/IPAD_COMPATIBILITY.md, "Staff session on a device"): a staff session
// (X-Resuto-Staff-Authorization) supplements the device credential. The request acts as the employee, whose role is
// bounded by the device's acting role, inside the device's branch; device-owned records keep the device id. Devices
// paired with requireStaff need the staff session everywhere except the session route. Plus the durable
// reconciliation route GET /v1/pos/orders/by-client-id/:clientOrderId.

const STAFF = 'X-Resuto-Staff-Authorization';

let t: TestApp;
let A: TestTenant;
let menu: SeededMenu;
let branchB: string;
let C: TestTenant;
let menuC: SeededMenu;
let manager: TestUser;
let waiterUser: TestUser;
let kitchenUser: TestUser;
let managerB: TestUser;

interface Device { token: string; id: string; branchId: string }
let till: Device;      // A, main branch, acting role cashier
let kds: Device;       // A, main branch, acting role kitchen
let tillB: Device;     // A, branch B, cashier
let deviceC: Device;   // another restaurant
let locked: Device;    // A, main branch, cashier, requireStaff

/** A device request, with a staff session when `staff` is given (a user, or a raw header value). */
const on = (d: Device, staff?: TestUser | string) => {
  const h: Record<string, string> = { Authorization: `Bearer ${d.token}` };
  if (staff !== undefined) h[STAFF] = typeof staff === 'string' ? staff : `Bearer ${staff.token}`;
  return {
    get: (p: string) => t.http.get(`/v1/pos${p}`).set(h),
    post: (p: string, body: unknown = {}) => t.http.post(`/v1/pos${p}`).set(h).send(body as object),
  };
};

async function pairDevice(tenant: TestTenant, branchId: string, actingRole: 'waiter' | 'cashier' | 'kitchen', name: string, extra: object = {}): Promise<Device> {
  const code = await t.http.post(`/v1/o/${tenant.orgId}/pos/pairings`).set(auth(tenant.owner)).send({ branchId, actingRole, name, ...extra });
  expect(code.status, JSON.stringify(code.body)).toBe(201);
  const paired = await t.http.post('/v1/pos/pair').send({ code: code.body.code });
  expect(paired.status, JSON.stringify(paired.body)).toBe(201);
  return { token: paired.body.token, id: paired.body.device.id, branchId };
}

const order = (productId: string, clientOrderId = randomUUID()) => ({ clientOrderId, fulfillment: 'pickup', lines: [{ productId, quantity: 1 }] });

beforeAll(async () => {
  t = await bootTestApp();
  A = await createTenant(t, { name: 'Staff Grill' });
  menu = await seedMenu(A);
  branchB = await addBranch(t, A, 'Corniche');
  C = await createTenant(t, { name: 'Elsewhere Diner' });
  menuC = await seedMenu(C);
  manager = await addMember(t, A, 'manager');
  waiterUser = await addMember(t, A, 'waiter');
  kitchenUser = await addMember(t, A, 'kitchen');
  managerB = await addMember(t, A, 'manager', [branchB]);
  till = await pairDevice(A, A.branchId, 'cashier', 'Front till');
  kds = await pairDevice(A, A.branchId, 'kitchen', 'Line KDS');
  tillB = await pairDevice(A, branchB, 'cashier', 'Corniche till');
  deviceC = await pairDevice(C, C.branchId, 'cashier', 'Other till');
  locked = await pairDevice(A, A.branchId, 'cashier', 'Staff-only till', { requireStaff: true });
}, 120_000);
afterAll(async () => { await t?.close(); });

// ---------------------------------------------------------------------------
describe('staff session on a paired device', () => {
  it('a waiter signed in on a till takes an order: the waiter is the actor, the device is recorded', async () => {
    const session = await on(till, waiterUser).get('/session');
    expect(session.status, JSON.stringify(session.body)).toBe(200);
    expect(session.body).toMatchObject({ device: { id: till.id, requireStaff: false }, requireStaff: false, contractVersion: '0.2.0',
      staff: { id: waiterUser.userId, email: waiterUser.email, role: 'waiter' } });
    // Effective permissions: the waiter's, within the cashier device's.
    expect(session.body.permissions).toEqual(ROLE_PERMISSIONS.waiter.filter((p) => ROLE_PERMISSIONS.cashier.includes(p)));
    expect(session.body.permissions).not.toContain('payments:read');
    // Without the header the same device is itself (0.1.0).
    const bare = await on(till).get('/session');
    expect(bare.body).toMatchObject({ staff: null, requireStaff: false, permissions: [...ROLE_PERMISSIONS.cashier] });

    const body = order(menu.products.fries);
    const placed = await on(till, waiterUser).post('/orders', body);
    expect(placed.status, JSON.stringify(placed.body)).toBe(201);
    const orderId = placed.body.order.id;
    expect((await sql('select device_id, branch_id from pos_order_submissions where org_id = $1 and client_order_id = $2', [A.orgId, body.clientOrderId]))[0])
      .toEqual({ device_id: till.id, branch_id: A.branchId });
    const [audit] = await sql(`select actor_type, actor_id, branch_id, metadata from audit_logs where action = 'pos.order.submitted' and entity_id = $1`, [orderId]);
    expect(audit).toMatchObject({ actor_type: 'user', actor_id: waiterUser.userId, branch_id: A.branchId,
      metadata: { clientOrderId: body.clientOrderId, deviceId: till.id } });
    const [created] = await sql(`select actor_type, actor_id from order_events where order_id = $1 and event_type = 'created'`, [orderId]);
    expect(created).toEqual({ actor_type: 'user', actor_id: waiterUser.userId });
    expect((await sql('select channel, branch_id from orders where id = $1', [orderId]))[0]).toEqual({ channel: 'pos', branch_id: A.branchId });

    // A retry is still idempotent; a payment and a print-job claim keep the device as the device.
    const replay = await on(till, waiterUser).post('/orders', body);
    expect(replay.status).toBe(201);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(replay.body.order.id).toBe(orderId);
    const paid = await on(till, waiterUser).post(`/orders/${orderId}/payments`, { clientPaymentId: randomUUID(), method: 'cash' });
    expect(paid.status, JSON.stringify(paid.body)).toBe(201);
    const [job] = await sql(`select id from pos_print_jobs where order_id = $1 and kind = 'kitchen_ticket'`, [orderId]);
    const claim = await on(till, waiterUser).post(`/print-jobs/${job.id}/claim`);
    expect(claim.status, JSON.stringify(claim.body)).toBe(200);
    expect(claim.body.claimedBy).toBe(till.id);
    expect((await on(till, waiterUser).post(`/print-jobs/${job.id}/complete`, { status: 'printed' })).status).toBe(200);
    const receipt = await on(till, waiterUser).post(`/orders/${orderId}/receipt`, { clientRequestId: randomUUID() });
    expect(receipt.status).toBe(201);
    expect((await sql('select requested_by from pos_print_jobs where id = $1', [receipt.body.id]))[0].requested_by)
      .toBe(`device:${till.id} user:${waiterUser.userId}`);
  });

  it('the device acting role is a ceiling: a manager on a KDS cannot take orders; kitchen staff on a till cannot either', async () => {
    const mgrOnKds = await on(kds, manager).post('/orders', order(menu.products.fries));
    expect(mgrOnKds.status).toBe(403);
    expect(mgrOnKds.body.error.code).toBe('forbidden');
    expect((await on(kds, manager).get('/sync/floor')).status).toBe(403);
    expect((await on(kds, manager).get('/kitchen/tickets')).status).toBe(200);
    const s = await on(kds, manager).get('/session');
    expect(s.body.permissions).toEqual(ROLE_PERMISSIONS.manager.filter((p) => ROLE_PERMISSIONS.kitchen.includes(p)));
    // The employee's own role still applies: the till may take orders and read the floor, kitchen staff may not.
    expect((await on(till).post('/orders', order(menu.products.fries))).status).toBe(201);
    expect((await on(till, kitchenUser).post('/orders', order(menu.products.fries))).status).toBe(403);
    expect((await on(till, kitchenUser).get('/sync/floor')).status).toBe(403);
    expect((await on(till, kitchenUser).get('/kitchen/tickets')).status).toBe(403);
    expect((await on(till, kitchenUser).get('/sync/menu')).status).toBe(200);
  });

  it('refuses staff of another restaurant, of another branch, or with a suspended membership (403 pos_staff_not_allowed)', async () => {
    for (const res of [await on(till, C.owner).get('/session'), await on(till, managerB).get('/session'), await on(till, managerB).post('/orders', order(menu.products.fries))]) {
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('pos_staff_not_allowed');
      expect(JSON.stringify(res.body)).not.toContain(C.orgId);
    }
    // The branch-scoped manager works on a device of their branch; C's owner on C's device.
    expect((await on(tillB, managerB).get('/session')).body.staff).toMatchObject({ id: managerB.userId, role: 'manager' });
    expect((await on(deviceC, C.owner).post('/orders', order(menuC.products.fries))).status).toBe(201);

    const temp = await addMember(t, A, 'waiter');
    expect((await on(till, temp).get('/session')).status).toBe(200);
    await sql(`update memberships set status = 'suspended' where org_id = $1 and user_id = $2`, [A.orgId, temp.userId]);
    const suspended = await on(till, temp).post('/orders', order(menu.products.fries));
    expect(suspended.status).toBe(403);
    expect(suspended.body.error.code).toBe('pos_staff_not_allowed');
  });

  it('refuses an expired, forged or malformed staff session (401 unauthorized), and never accepts a credential in its place', async () => {
    const secret = new TextEncoder().encode(process.env.SUPABASE_JWT_SECRET!);
    const now = Math.floor(Date.now() / 1000);
    const expired = await new SignJWT({ email: waiterUser.email, role: 'authenticated', aal: 'aal1' }).setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setSubject(waiterUser.userId).setAudience('authenticated').setIssuer('resuto-dev-auth').setIssuedAt(now - 7200).setExpirationTime(now - 3600).sign(secret);
    const forged = await new SignJWT({ email: waiterUser.email, role: 'authenticated' }).setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setSubject(waiterUser.userId).setAudience('authenticated').setIssuer('resuto-dev-auth').setExpirationTime('1h')
      .sign(new TextEncoder().encode('another-secret-that-is-at-least-32-characters'));
    for (const value of [`Bearer ${expired}`, `Bearer ${forged}`, 'Bearer garbage', 'Bearer ', waiterUser.token, `Bearer ${till.token}`, '']) {
      const res = await on(till, value).get('/session');
      expect(res.status, value.slice(0, 20)).toBe(401);
      expect(res.body.error.code).toBe('unauthorized');
    }
    // A staff token as the Authorization header stays refused on device routes (unchanged from 0.1.0).
    const asStaff = await t.http.get('/v1/pos/session').set({ ...auth(waiterUser), [STAFF]: `Bearer ${waiterUser.token}` });
    expect(asStaff.status).toBe(403);
    expect(asStaff.body.error.code).toBe('pos_device_required');
    // The header does not open staff routes to a device credential either.
    const staffRoute = await t.http.get(`/v1/o/${A.orgId}/orders`).set({ Authorization: `Bearer ${till.token}`, [STAFF]: `Bearer ${A.owner.token}` });
    expect(staffRoute.body.error.code).toBe('pos_device_only');
  });

  it('a revoked device is refused even with a valid staff session', async () => {
    const lost = await pairDevice(A, A.branchId, 'waiter', 'Lost till');
    expect((await on(lost, waiterUser).get('/session')).status).toBe(200);
    expect((await t.http.post(`/v1/o/${A.orgId}/pos/devices/${lost.id}/revoke`).set(auth(manager)).send({})).status).toBe(200);
    for (const res of [await on(lost, waiterUser).get('/session'), await on(lost, waiterUser).post('/orders', order(menu.products.fries))]) {
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('device_revoked');
    }
  });

  it('counts staff requests against the device rate limit', async () => {
    const limiter = t.app.get(RateLimiter);
    const spy = vi.spyOn(limiter, 'hit');
    try {
      expect((await on(till, waiterUser).get('/session')).status).toBe(200);
      expect(spy).toHaveBeenCalledWith(`pos:${till.id}`, 600);
    } finally {
      spy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
describe('requireStaff devices', () => {
  it('pairing records requireStaff; the device lists and details show it', async () => {
    const list = await t.http.get(`/v1/o/${A.orgId}/pos/devices?limit=50`).set(auth(manager));
    const byId = new Map(list.body.items.map((d: any) => [d.id, d]));
    expect(byId.get(locked.id)).toMatchObject({ requireStaff: true });
    expect(byId.get(till.id)).toMatchObject({ requireStaff: false });
    expect((await t.http.get(`/v1/o/${A.orgId}/pos/devices/${locked.id}`).set(auth(manager))).body.requireStaff).toBe(true);
    const code = await t.http.post(`/v1/o/${A.orgId}/pos/pairings`).set(auth(manager)).send({ branchId: A.branchId, actingRole: 'waiter', name: 'x', requireStaff: true });
    expect(code.body.requireStaff).toBe(true);
    expect((await t.http.post(`/v1/o/${A.orgId}/pos/pairings`).set(auth(manager)).send({ branchId: A.branchId, actingRole: 'waiter', name: 'x', requireStaff: 'yes' })).status).toBe(400);
    const [audit] = await sql(`select metadata from audit_logs where action = 'pos.pairing.created' and entity_id = $1`, [code.body.id]);
    expect(audit.metadata.requireStaff).toBe(true);
  });

  it('answers 401 pos_staff_required without a staff session, except the session route', async () => {
    const session = await on(locked).get('/session');
    expect(session.status).toBe(200);
    expect(session.body).toMatchObject({ requireStaff: true, staff: null, device: { id: locked.id, requireStaff: true } });
    for (const res of [await on(locked).get('/events?after=0'), await on(locked).get('/sync/menu'), await on(locked).post('/orders', order(menu.products.fries)),
      await on(locked).get(`/orders/by-client-id/${randomUUID()}`), await on(locked).get('/print-jobs')]) {
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('pos_staff_required');
    }
    const signedIn = await on(locked, waiterUser).get('/session');
    expect(signedIn.body).toMatchObject({ requireStaff: true, staff: { id: waiterUser.userId, role: 'waiter' } });
    const placed = await on(locked, waiterUser).post('/orders', order(menu.products.fries));
    expect(placed.status, JSON.stringify(placed.body)).toBe(201);
    expect((await on(locked, waiterUser).get('/sync/menu')).status).toBe(200);
    // A bad staff session is still a bad session, also on the session route.
    expect((await on(locked, 'Bearer garbage').get('/session')).status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
describe('durable reconciliation by client order id', () => {
  it('accepted with the original response; 404 when never accepted; a device of another branch or restaurant sees 404', async () => {
    const body = order(menu.products.fries);
    const placed = await on(till).post('/orders', body);
    expect(placed.status).toBe(201);
    const found = await on(till).get(`/orders/by-client-id/${body.clientOrderId}`);
    expect(found.status, JSON.stringify(found.body)).toBe(200);
    expect(found.body).toEqual({ state: 'accepted', orderId: placed.body.order.id, number: placed.body.order.number, response: placed.body });
    // Any device of the branch, and staff signed in on one, may ask.
    expect((await on(kds).get(`/orders/by-client-id/${body.clientOrderId}`)).body.state).toBe('accepted');
    expect((await on(till, waiterUser).get(`/orders/by-client-id/${body.clientOrderId}`)).body.orderId).toBe(placed.body.order.id);

    const never = await on(till).get(`/orders/by-client-id/${randomUUID()}`);
    expect(never.status).toBe(404);
    expect(never.body.error.code).toBe('not_found');
    // A refused submit (price conflict) commits nothing: still 404, and the same id may be resubmitted.
    const refused = order(menu.products.fries);
    const conflict = await on(till).post('/orders', { ...refused, expectedTotalMinor: 1 });
    expect(conflict.status).toBe(409);
    expect((await on(till).get(`/orders/by-client-id/${refused.clientOrderId}`)).status).toBe(404);
    expect((await on(till).post('/orders', refused)).status).toBe(201);
    expect((await on(till).get(`/orders/by-client-id/${refused.clientOrderId}`)).body.state).toBe('accepted');

    const inB = order(menu.products.fries);
    expect((await on(tillB).post('/orders', inB)).status).toBe(201);
    const inC = order(menuC.products.fries);
    expect((await on(deviceC).post('/orders', inC)).status).toBe(201);
    for (const id of [inB.clientOrderId, inC.clientOrderId]) {
      const res = await on(till).get(`/orders/by-client-id/${id}`);
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('not_found');
    }
    expect((await on(tillB).get(`/orders/by-client-id/${inB.clientOrderId}`)).body.state).toBe('accepted');
    expect((await on(till).get('/orders/by-client-id/not-a-uuid')).status).toBe(400);
    // orders:read is required (every acting role has it); staff routes are untouched.
    expect((await t.http.get(`/v1/pos/orders/by-client-id/${body.clientOrderId}`).set(auth(A.owner))).body.error.code).toBe('pos_device_required');
  });

  it('processing while a submit with that id is in flight, or when a stored submission has no response yet', async () => {
    const inflight = randomUUID();
    const c = await testDb().connect();
    try {
      await c.query('begin');
      await c.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [`pos_order_submission:${A.orgId}:${A.branchId}:${inflight}`]);
      const res = await on(till).get(`/orders/by-client-id/${inflight}`);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body).toEqual({ state: 'processing' });
      // Another branch's device asking for the same id is not told anything.
      expect((await on(tillB).get(`/orders/by-client-id/${inflight}`)).status).toBe(404);
    } finally {
      await c.query('rollback');
      c.release();
    }
    expect((await on(till).get(`/orders/by-client-id/${inflight}`)).status).toBe(404);

    const pending = randomUUID();
    await sql(`insert into pos_order_submissions(org_id, client_order_id, branch_id, device_id, request_hash) values ($1, $2, $3, $4, 'h')`,
      [A.orgId, pending, A.branchId, till.id]);
    expect((await on(till).get(`/orders/by-client-id/${pending}`)).body).toEqual({ state: 'processing' });
    expect((await on(tillB).get(`/orders/by-client-id/${pending}`)).status).toBe(404);
  });
});
