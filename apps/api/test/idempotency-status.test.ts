// PS-24 remainder (REM-A03): IdempotencyService stored a fixed status (200) with every result, whatever the route
// answered (a create answers 201), so the stored record did not describe the response it replays. Now the service
// records the status the first call answered with and sets it again on a replay. Covered per caller family through
// the real routes (orders, floor, reservations; delivery and intelligence in their own suites), plus the mechanism.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DbService } from '../src/common/db/db.service';
import { requestContext } from '../src/common/http/request-context';
import { IdempotencyService } from '../src/common/platform/idempotency.service';
import { addMember, auth, bootTestApp, createTenant, seedMenu, sql, type SeededMenu, type TestApp, type TestTenant, type TestUser } from './helpers';
import { key, saveFloor, table, layout } from './ops-fixtures';

let t: TestApp;
let tenant: TestTenant;
let menu: SeededMenu;
let waiter: TestUser;
let cashier: TestUser;
let host: TestUser;

beforeAll(async () => {
  t = await bootTestApp();
  tenant = await createTenant(t, { country: 'EG' });
  menu = await seedMenu(tenant);
  waiter = await addMember(t, tenant, 'waiter', [tenant.branchId]);
  cashier = await addMember(t, tenant, 'cashier', [tenant.branchId]);
  host = await addMember(t, tenant, 'host', [tenant.branchId]);
});
afterAll(async () => { await t.close(); });

const stored = async (scope: string, k: string) =>
  (await sql(`select status_code from idempotency_keys where org_id = $1 and scope = $2 and key = $3`, [tenant.orgId, scope, k]))[0]?.status_code;

/** Sends the same request twice with one key: the replay must answer with the first call's status and body. */
async function twice(send: () => Promise<{ status: number; body: any }>) {
  const first = await send();
  const replay = await send();
  expect(replay.status, JSON.stringify(replay.body)).toBe(first.status);
  expect(replay.body).toEqual(first.body);
  return first;
}

describe('the stored status is the status the caller received, and a replay answers with it', () => {
  it('orders: create answers 201 (stored 201), collect answers 200 (stored 200)', async () => {
    const k = key('order');
    const created = await twice(() => t.http.post(`/v1/o/${tenant.orgId}/orders`).set(auth(waiter)).set('Idempotency-Key', k)
      .send({ branchId: tenant.branchId, fulfillment: 'pickup', lines: [{ productId: menu.products.fries, quantity: 1 }] }));
    expect(created.status).toBe(201);
    expect(await stored('staff-order', k)).toBe(201);   // was 200 before REM-A03

    const ck = key('collect');
    const collected = await twice(() => t.http.post(`/v1/o/${tenant.orgId}/orders/${created.body.id}/collect`).set(auth(cashier))
      .set('Idempotency-Key', ck).send({ method: 'cash' }));
    expect(collected.status).toBe(200);
    expect(await stored(`order-collect:${created.body.id}`, ck)).toBe(200);
  });

  it('floor: saving a layout answers 200 and its replay too', async () => {
    const k = key('floor');
    const body = { baseRevision: 0, key: k, layout: layout([table('S1', 200, 200), table('S2', 400, 200)]) };
    const saved = await twice(() => t.http.put(`/v1/o/${tenant.orgId}/floor/${tenant.branchId}`).set(auth(tenant.owner)).send(body));
    expect(saved.status).toBe(200);
    expect(await stored(`floor-save:${tenant.branchId}`, k)).toBe(saved.status);
  });

  it('reservations: a staff booking answers 201 (stored 201) and its replay too', async () => {
    const f = await saveFloor(t, tenant, [table('R4', 200, 300, { capacity: 4 })]);
    const tableId = f.tables.find((x: any) => x.label === 'R4').id;
    const date = new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 10);
    const k = key('resv');
    const booked = await twice(() => t.http.post(`/v1/o/${tenant.orgId}/reservations`).set(auth(host)).set('Idempotency-Key', k)
      .send({ branchId: tenant.branchId, tableId, date, time: '19:00', partySize: 2, guestName: 'Idem Guest' }));
    expect(booked.status, JSON.stringify(booked.body)).toBe(201);
    expect(await stored('reservation-staff', k)).toBe(201);
  });
});

describe('IdempotencyService mechanism', () => {
  it('records the response status of the request context and sets it again on a replay; outside a request it stores 200', async () => {
    const idem = t.app.get(IdempotencyService);
    const db = t.app.get(DbService);
    const k = key('mech');
    const fake = (statusCode: number) => { const r = { statusCode, set: [] as number[], status(c: number) { r.set.push(c); r.statusCode = c; return r; } }; return r; };
    let runs = 0;
    const call = (res?: ReturnType<typeof fake>) => {
      const work = () => db.withTenant(tenant.orgId, (tx) => idem.run(tx, tenant.orgId, 'test.mech', k, { a: 1 }, async () => ({ n: ++runs })));
      return res ? requestContext.run({ requestId: `req-${k}`, source: 'api', response: res }, work) : work();
    };
    const first = fake(201);
    expect(await call(first)).toEqual({ n: 1 });
    expect(first.set).toEqual([]);
    expect(await stored('test.mech', k)).toBe(201);
    // A replay through a route whose default would be 200 answers with the stored 201.
    const replay = fake(200);
    expect(await call(replay)).toEqual({ n: 1 });
    expect(replay.set).toEqual([201]);
    expect(runs).toBe(1);
    // Work outside an HTTP request (worker, job) stores 200.
    const k2 = key('worker');
    await db.withTenant(tenant.orgId, (tx) => idem.run(tx, tenant.orgId, 'test.mech', k2, {}, async () => 'ok'));
    expect(await stored('test.mech', k2)).toBe(200);
  });
});

// Review of REM-A03: keys stored before the fix hold 200 for every route. Migration 20261023020003 clears those, so a
// retry across the deploy answers with the route's own status (201 for a create), as it did before the fix.
describe('keys stored before the status fix', () => {
  it('a replay of a pre-fix key (stored 200 on a 201 route) answers 201 once the migration has run', async () => {
    const k = key('legacy');
    const send = () => t.http.post(`/v1/o/${tenant.orgId}/orders`).set(auth(waiter)).set('Idempotency-Key', k)
      .send({ branchId: tenant.branchId, fulfillment: 'pickup', lines: [{ productId: menu.products.fries, quantity: 1 }] });
    const first = await send();
    expect(first.status).toBe(201);
    // What the pre-fix code stored for this key.
    await sql(`update idempotency_keys set status_code = 200 where org_id = $1 and scope = 'staff-order' and key = $2`, [tenant.orgId, k]);
    const unfixed = await send();
    expect(unfixed.status).toBe(200);   // the transitional problem the review describes
    await sql(readFileSync(path.resolve(__dirname, '../../../supabase/migrations/20261023020003_idempotency_legacy_status.sql'), 'utf8'));
    expect(await stored('staff-order', k)).toBeNull();
    const replay = await send();
    expect(replay.status).toBe(201);
    expect(replay.body).toEqual(first.body);
  });
});
