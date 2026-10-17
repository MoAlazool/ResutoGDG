import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { VisitsService } from '../src/modules/orders/visits.service';
import { addMember, auth, bootTestApp, createTenant, seedMenu, sql, type SeededMenu, type TestApp, type TestTenant, type TestUser } from './helpers';
import { key, qrTokenFor, saveFloor, table } from './ops-fixtures';

let t: TestApp;
let tenant: TestTenant;
let menu: SeededMenu;
let kitchen: TestUser;
let waiter: TestUser;
let cashier: TestUser;
let tables: Record<string, { id: string; qr: string }>;

beforeAll(async () => {
  t = await bootTestApp();
  tenant = await createTenant(t, { country: 'EG' });
  menu = await seedMenu(tenant);
  kitchen = await addMember(t, tenant, 'kitchen', [tenant.branchId]);
  waiter = await addMember(t, tenant, 'waiter', [tenant.branchId]);
  cashier = await addMember(t, tenant, 'cashier', [tenant.branchId]);
  const f = await saveFloor(t, tenant, ['G1', 'G2', 'G3', 'G4', 'G5', 'G6'].map((l, i) => table(l, 150 + i * 170, 300)));
  tables = {};
  for (const tb of f.tables) tables[tb.label] = { id: tb.id, qr: await qrTokenFor(t, tenant, tb.id) };
});
afterAll(async () => { await t.close(); });

const visitHeader = (token: string) => ({ 'X-Visit-Token': token });
const burger = () => ({ productId: menu.products.burger, quantity: 2, modifiers: [{ groupId: menu.groups.size, optionId: menu.options.large }], notes: 'No onions' });

describe('guest QR flow (session → order → kitchen → bill → close)', () => {
  it('runs the whole table lifecycle', async () => {
    // 1. Scan: auto-opens the table (PIN-free) and returns a visit token.
    const scan = await t.http.post(`/v1/public/tables/${tables.G1!.qr}/session`);
    expect(scan.status).toBe(200);
    expect(scan.body).toMatchObject({ orgId: tenant.orgId, branchId: tenant.branchId, tableLabel: 'G1', currency: 'EGP', opened: true, org: { slug: tenant.slug } });
    const token = scan.body.token as string;
    expect(JSON.stringify(scan.body)).not.toContain(tables.G1!.qr);
    // A second guest at the same table joins the same visit with the same token.
    const second = await t.http.post(`/v1/public/tables/${tables.G1!.qr}/session`);
    expect(second.body).toMatchObject({ visitId: scan.body.visitId, token, opened: false });
    const [v] = await sql('select guest_token_hash, opened_via from visits where id = $1', [scan.body.visitId]);
    expect(v.guest_token_hash).not.toContain(token);
    expect(v.opened_via).toBe('qr');
    // The raw QR token is never a bearer credential.
    expect((await t.http.get('/v1/public/visits/current').set(visitHeader(tables.G1!.qr))).status).toBe(401);

    // 2. Menu and quote for the visit's branch.
    const m = await t.http.get('/v1/public/visits/current/menu').set(visitHeader(token));
    expect(m.status).toBe(200);
    expect(m.body.categories[0].products.map((p: any) => p.name)).toContain('Smash burger');
    const quote = await t.http.post('/v1/public/visits/current/quote').set(visitHeader(token)).send({ lines: [burger(), { productId: menu.products.fries, quantity: 1 }] });
    expect(quote.status).toBe(200);
    expect(quote.body.totalMinor).toBe((18500 + 3000) * 2 + 4500);

    // 3. Order, retried with the same key → one order.
    const k = key('guest-order');
    const send = () => t.http.post('/v1/public/visits/current/orders').set(visitHeader(token)).set('Idempotency-Key', k)
      .send({ lines: [burger(), { productId: menu.products.fries, quantity: 1 }], expectedTotalMinor: quote.body.totalMinor, notes: 'Birthday' });
    const o1 = await send();
    expect(o1.status).toBe(201);
    const o2 = await send();
    expect(o2.body).toEqual(o1.body);
    expect((await sql('select count(*)::int as n from orders where visit_id = $1', [scan.body.visitId]))[0].n).toBe(1);
    expect(o1.body).toMatchObject({ status: 'placed', totalMinor: 47500, currency: 'EGP' });
    const [order] = await sql('select channel, fulfillment, table_id from orders where id = $1', [o1.body.id]);
    expect(order).toMatchObject({ channel: 'qr', fulfillment: 'dine_in', table_id: tables.G1!.id });
    // No key → rejected; stale price → 409.
    expect((await t.http.post('/v1/public/visits/current/orders').set(visitHeader(token)).send({ lines: [burger()] })).status).toBe(422);
    const stale = await t.http.post('/v1/public/visits/current/orders').set(visitHeader(token)).set('Idempotency-Key', key())
      .send({ lines: [{ productId: menu.products.soda, quantity: 1 }], expectedTotalMinor: 1 });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('price_changed');

    // 4. Kitchen sees it with modifiers and notes, and bumps it through.
    const feed = await t.http.get(`/v1/o/${tenant.orgId}/kitchen/${tenant.branchId}`).set(auth(kitchen));
    expect(feed.status).toBe(200);
    const ticket = feed.body.tickets.find((x: any) => x.id === o1.body.id);
    expect(ticket).toMatchObject({ tableLabel: 'G1', status: 'placed', isNew: true, notes: 'Birthday' });
    expect(ticket.lines[0]).toMatchObject({ name: 'Smash burger', quantity: 2, station: 'Grill', modifiers: ['Large'], notes: 'No onions' });
    const unchanged = await t.http.get(`/v1/o/${tenant.orgId}/kitchen/${tenant.branchId}?since=${feed.body.cursor}`).set(auth(kitchen));
    expect(unchanged.body).toMatchObject({ unchanged: true, tickets: [] });
    for (const to of ['accepted', 'preparing', 'ready']) {
      const r = await t.http.post(`/v1/o/${tenant.orgId}/kitchen/orders/${o1.body.id}/bump`).set(auth(kitchen)).send({ to });
      expect(r.status).toBe(201);
    }
    const moved = await t.http.get(`/v1/o/${tenant.orgId}/kitchen/${tenant.branchId}?since=${feed.body.cursor}`).set(auth(kitchen));
    expect(moved.body.unchanged).toBeUndefined();
    expect(moved.body.tickets.find((x: any) => x.id === o1.body.id).status).toBe('ready');
    // Waiter serves it.
    const served = await t.http.post(`/v1/o/${tenant.orgId}/orders/${o1.body.id}/transition`).set(auth(waiter)).send({ to: 'served' });
    expect(served.status).toBe(201);
    expect(served.body.status).toBe('served');
    const status = await t.http.get(`/v1/public/visits/current/orders/${o1.body.id}`).set(visitHeader(token));
    expect(status.body.timeline.map((e: any) => e.status)).toEqual(['placed', 'accepted', 'preparing', 'ready', 'served']);

    // 5. Bill is due; closing is refused until it is paid.
    const bill = await t.http.get('/v1/public/visits/current').set(visitHeader(token));
    expect(bill.body.totals).toEqual({ totalMinor: 47500, paidMinor: 0, creditMinor: 0, dueMinor: 47500 });
    expect(bill.body.table).toEqual({ id: tables.G1!.id, label: 'G1' });
    const early = await t.http.post(`/v1/o/${tenant.orgId}/visits/${scan.body.visitId}/close`).set(auth(waiter)).send({});
    expect(early.status).toBe(409);
    expect(early.body.error).toMatchObject({ code: 'visit_not_settled', details: { dueMinor: 47500 } });
    expect((await t.http.post(`/v1/o/${tenant.orgId}/visits/${scan.body.visitId}/close`).set(auth(waiter)).send({ force: true })).status).toBe(403);

    // 6. Cash at the counter through the ledger (idempotent).
    const ck = key('cash');
    const pay = () => t.http.post(`/v1/o/${tenant.orgId}/visits/${scan.body.visitId}/collect`).set(auth(cashier)).set('Idempotency-Key', ck).send({ method: 'cash' });
    const p1 = await pay();
    expect(p1.status).toBe(201);
    expect(p1.body.totals.dueMinor).toBe(0);
    const p2 = await pay();
    expect(p2.body.paymentId).toBe(p1.body.paymentId);
    const [paid] = await sql('select paid_minor, payment_status from orders where id = $1', [o1.body.id]);
    expect(paid).toEqual({ paid_minor: 47500, payment_status: 'paid' });
    const again = await t.http.post(`/v1/o/${tenant.orgId}/visits/${scan.body.visitId}/collect`).set(auth(cashier)).set('Idempotency-Key', key()).send({ method: 'cash' });
    expect(again.status).toBe(409);

    // 7. Close; the token stops working and the next scan opens a new visit with a new token.
    const closed = await t.http.post(`/v1/o/${tenant.orgId}/visits/${scan.body.visitId}/close`).set(auth(waiter)).send({ needsCleaning: true });
    expect(closed.status).toBe(201);
    expect(closed.body).toMatchObject({ ok: true, unusedCreditMinor: 0 });
    const after = await t.http.get('/v1/public/visits/current').set(visitHeader(token));
    expect(after.status).toBe(401);
    expect(after.body.error.code).toBe('visit_closed');
    expect((await t.http.post('/v1/public/visits/current/orders').set(visitHeader(token)).set('Idempotency-Key', key()).send({ lines: [burger()] })).status).toBe(401);
    // Needs cleaning first; then a new scan opens a fresh visit.
    const dirty = await t.http.post(`/v1/public/tables/${tables.G1!.qr}/session`);
    expect(dirty.status).toBe(409);
    expect(dirty.body.error).toMatchObject({ code: 'table_unavailable', details: { reason: 'cleaning' } });
    expect((await t.http.post(`/v1/o/${tenant.orgId}/tables/${tables.G1!.id}/clean`).set(auth(waiter))).status).toBe(201);
    const fresh = await t.http.post(`/v1/public/tables/${tables.G1!.qr}/session`);
    expect(fresh.body.visitId).not.toBe(scan.body.visitId);
    expect(fresh.body.token).not.toBe(token);
    const outbox = await sql(`select event_type from outbox_events where aggregate_id = $1 order by created_at`, [scan.body.visitId]);
    expect(outbox.map((e) => e.event_type)).toEqual(['visit.opened', 'visit.closed']);
  });

  it('deduplicates waiter and bill requests while open', async () => {
    const s = await t.http.post(`/v1/public/tables/${tables.G2!.qr}/session`);
    const ask = (kind: string) => t.http.post('/v1/public/visits/current/requests').set(visitHeader(s.body.token)).send({ kind });
    const a = await ask('waiter');
    const b = await ask('waiter');
    expect(a.status).toBe(201);
    expect(b.body).toMatchObject({ id: a.body.id, duplicate: true });
    const bill = await ask('bill');
    expect(bill.body.id).not.toBe(a.body.id);
    expect((await ask('dance')).status).toBe(400);
    const list = await t.http.get(`/v1/o/${tenant.orgId}/requests?branchId=${tenant.branchId}`).set(auth(waiter));
    expect(list.body.items.filter((r: any) => r.visitId === s.body.visitId).map((r: any) => r.kind).sort()).toEqual(['bill', 'waiter']);
    expect((await t.http.post(`/v1/o/${tenant.orgId}/requests/${a.body.id}/resolve`).set(auth(waiter)).send({})).status).toBe(201);
    const c = await ask('waiter');
    expect(c.body.duplicate).toBe(false);
    const live = await t.http.get(`/v1/o/${tenant.orgId}/floor/${tenant.branchId}/live`).set(auth(waiter));
    expect(live.body.tables.find((x: any) => x.id === tables.G2!.id).visit.requests.sort()).toEqual(['bill', 'waiter']);
  });

  it('undoes an auto-opened table within 60 seconds only when nothing happened', async () => {
    const s = await t.http.post(`/v1/public/tables/${tables.G3!.qr}/session`);
    const undo = await t.http.post(`/v1/o/${tenant.orgId}/visits/${s.body.visitId}/undo`).set(auth(waiter));
    expect(undo.status).toBe(201);
    expect((await t.http.get('/v1/public/visits/current').set(visitHeader(s.body.token))).status).toBe(401);

    const s2 = await t.http.post(`/v1/public/tables/${tables.G3!.qr}/session`);
    await t.http.post('/v1/public/visits/current/orders').set(visitHeader(s2.body.token)).set('Idempotency-Key', key()).send({ lines: [{ productId: menu.products.soda, quantity: 1 }] });
    const busy = await t.http.post(`/v1/o/${tenant.orgId}/visits/${s2.body.visitId}/undo`).set(auth(waiter));
    expect(busy.body.error.code).toBe('visit_has_activity');

    const staff = await t.http.post(`/v1/o/${tenant.orgId}/visits`).set(auth(waiter)).send({ tableId: tables.G4!.id, partySize: 3 });
    expect(staff.status).toBe(201);
    expect((await t.http.post(`/v1/o/${tenant.orgId}/visits/${staff.body.id}/undo`).set(auth(waiter))).body.error.code).toBe('not_auto_opened');
    const s3 = await t.http.post(`/v1/public/tables/${tables.G4!.qr}/session`);
    expect(s3.body).toMatchObject({ visitId: staff.body.id, opened: false });
  });

  it('auto-closes paid, fulfilled visits after 10 quiet minutes (legacy sweep)', async () => {
    const visits = t.app.get(VisitsService);
    const s = await t.http.post(`/v1/public/tables/${tables.G5!.qr}/session`);
    const o = await t.http.post('/v1/public/visits/current/orders').set(visitHeader(s.body.token)).set('Idempotency-Key', key()).send({ lines: [{ productId: menu.products.fries, quantity: 1 }] });
    for (const to of ['accepted', 'preparing', 'ready', 'served']) {
      await t.http.post(`/v1/o/${tenant.orgId}/orders/${o.body.id}/transition`).set(auth(tenant.owner)).send({ to });
    }
    // Unpaid → stays open even when quiet.
    await sql(`update orders set fulfilled_at = now() - interval '11 minutes', placed_at = now() - interval '20 minutes' where id = $1`, [o.body.id]);
    await sql(`update visits set opened_at = now() - interval '25 minutes' where id = $1`, [s.body.visitId]);
    expect((await visits.runAutoClose()).closed).toBe(0);
    await t.http.post(`/v1/o/${tenant.orgId}/orders/${o.body.id}/collect`).set(auth(cashier)).set('Idempotency-Key', key()).send({ method: 'cash' });
    // Just paid → not quiet yet.
    expect((await visits.runAutoClose()).closed).toBe(0);
    await sql(`update payments set created_at = now() - interval '11 minutes' where order_id = $1`, [o.body.id]);
    // An open request blocks it.
    const r = await t.http.post('/v1/public/visits/current/requests').set(visitHeader(s.body.token)).send({ kind: 'waiter' });
    expect((await visits.runAutoClose()).closed).toBe(0);
    await t.http.post(`/v1/o/${tenant.orgId}/requests/${r.body.id}/resolve`).set(auth(waiter)).send({});
    const res = await visits.runAutoClose();
    expect(res.closed).toBeGreaterThanOrEqual(1);
    const [v] = await sql('select status, close_reason from visits where id = $1', [s.body.visitId]);
    expect(v).toEqual({ status: 'closed', close_reason: 'auto' });
    const [tb] = await sql('select status from dining_tables where id = $1', [tables.G5!.id]);
    expect(tb.status).toBe('available');
  });

  it('blocks new guest orders while a payment is in flight (settling rule)', async () => {
    const s = await t.http.post(`/v1/public/tables/${tables.G6!.qr}/session`);
    await t.http.post('/v1/public/visits/current/orders').set(visitHeader(s.body.token)).set('Idempotency-Key', key()).send({ lines: [{ productId: menu.products.soda, quantity: 2 }] });
    await sql(`insert into payments(org_id, branch_id, visit_id, method, provider, amount_minor, currency, status) values ($1, $2, $3, 'card', 'simulated', 1000, 'EGP', 'pending')`,
      [tenant.orgId, tenant.branchId, s.body.visitId]);
    const blocked = await t.http.post('/v1/public/visits/current/orders').set(visitHeader(s.body.token)).set('Idempotency-Key', key()).send({ lines: [{ productId: menu.products.soda, quantity: 1 }] });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe('bill_settling');
    expect((await t.http.get('/v1/public/visits/current').set(visitHeader(s.body.token))).body.settling).toBe(true);
  });

  it('rejects unknown QR codes and malformed tokens', async () => {
    expect((await t.http.post('/v1/public/tables/not-a-real-qr-token-000/session')).status).toBe(404);
    expect((await t.http.post('/v1/public/tables/<script>/session')).status).toBe(404);
    expect((await t.http.get('/v1/public/visits/current')).status).toBe(401);
    expect((await t.http.get('/v1/public/visits/current').set(visitHeader('x'.repeat(40)))).status).toBe(401);
  });
});
