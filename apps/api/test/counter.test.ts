// FT-07: the legacy counter session (one venue QR per branch; takeaway counter / cloud kitchen). Legacy server.js
// /api/table-session with the venue QR opened a table-less "Counter order" visit per scan; the guest ordered, quoted a
// number at the till and paid on the phone or at the counter. Here: the venue credential (hashed, rotatable), the
// session, ordering through the kernel as pickup, ticket numbers (per branch and business day, unique under
// concurrency), the KDS and staff boards, payment safety (paid only by a verified provider event or staff collection),
// closing and the abandoned-scan sweep, tenant isolation and rate limits.
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { VisitsService } from '../src/modules/orders/visits.service';
import { addMember, auth, bootTestApp, createTenant, seedMenu, sql, type SeededMenu, type TestApp, type TestTenant, type TestUser } from './helpers';
import { key } from './ops-fixtures';

let t: TestApp;
let shop: TestTenant;
let menu: SeededMenu;
let kitchen: TestUser;
let waiter: TestUser;
let cashier: TestUser;
let venue: string;

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const visitHeader = (token: string) => ({ 'X-Visit-Token': token });
const S = (tenant: TestTenant, path: string) => `/v1/o/${tenant.orgId}${path}`;
/** Each scan comes from its own phone address unless a test says otherwise (per-address scan limit). */
let ipN = 0;
const ip = () => `10.77.${Math.floor(++ipN / 250)}.${ipN % 250}`;
const scan = (code: string, headers: Record<string, string> = {}) =>
  t.http.post(`/v1/public/venue/${code}/session`).set('X-Forwarded-For', ip()).set(headers);
const fries = (quantity = 1) => ({ productId: menu.products.fries, quantity });

async function counterBranch(tenant: TestTenant) {
  const r = await t.http.put(S(tenant, `/branches/${tenant.branchId}/service-mode`)).set(auth(tenant.owner)).send({ mode: 'counter' });
  expect(r.status).toBe(200);
  const qr = await t.http.get(S(tenant, `/floor/${tenant.branchId}/venue-qr`)).set(auth(tenant.owner));
  expect(qr.status).toBe(200);
  return qr.body as { url: string; kind: string; rotatedAt: string | null; svg: string };
}
const codeOf = (url: string) => url.split('/v/')[1]!;

async function order(token: string, lines = [fries()]) {
  const quote = await t.http.post('/v1/public/visits/current/quote').set(visitHeader(token)).send({ lines });
  expect(quote.status, JSON.stringify(quote.body)).toBe(200);
  const o = await t.http.post('/v1/public/visits/current/orders').set(visitHeader(token)).set('Idempotency-Key', key('counter'))
    .send({ lines, expectedTotalMinor: quote.body.totalMinor });
  expect(o.status, JSON.stringify(o.body)).toBe(201);
  return o.body as { id: string; number: string; totalMinor: number };
}

beforeAll(async () => {
  t = await bootTestApp();
  // Concurrent requests below: bind the server once, so supertest does not start a listener per request.
  await new Promise<void>((resolve) => t.app.getHttpServer().listen(0, '127.0.0.1', () => resolve()));
  shop = await createTenant(t, { country: 'EG' });
  menu = await seedMenu(shop);
  kitchen = await addMember(t, shop, 'kitchen', [shop.branchId]);
  waiter = await addMember(t, shop, 'waiter', [shop.branchId]);
  cashier = await addMember(t, shop, 'cashier', [shop.branchId]);
  venue = codeOf((await counterBranch(shop)).url);
});
afterAll(async () => { await t.close(); });

describe('venue QR credential (FT-07)', () => {
  it('prints /v/<token> for a counter branch, stores only its hash, prints the same code again and rotates it', async () => {
    const first = await t.http.get(S(shop, `/floor/${shop.branchId}/venue-qr`)).set(auth(shop.owner));
    expect(first.body).toMatchObject({ branchId: shop.branchId, kind: 'counter', url: `http://app.test/v/${venue}` });
    expect(first.body.svg).toContain('<svg');
    expect(venue).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const [b] = await sql('select venue_qr_hash, venue_qr_nonce, venue_qr_rotated_at from branches where id = $1', [shop.branchId]);
    expect(b.venue_qr_hash).toBe(sha256(venue));
    expect(JSON.stringify(b)).not.toContain(venue);
    // A waiter can show it at the till (floor:read) and gets the same code; only floor:write rotates.
    const shown = await t.http.get(S(shop, `/floor/${shop.branchId}/venue-qr`)).set(auth(waiter));
    expect(shown.body.url).toBe(first.body.url);
    expect((await t.http.post(S(shop, `/floor/${shop.branchId}/venue-qr/rotate`)).set(auth(waiter))).status).toBe(403);

    const other = await createTenant(t, { country: 'EG' });
    await counterBranch(other);
    const old = codeOf((await t.http.get(S(other, `/floor/${other.branchId}/venue-qr`)).set(auth(other.owner))).body.url);
    const open = await scan(old);
    expect(open.status).toBe(200);
    const rotated = await t.http.post(S(other, `/floor/${other.branchId}/venue-qr/rotate`)).set(auth(other.owner));
    expect(rotated.status).toBe(200);
    const fresh = codeOf(rotated.body.url);
    expect(fresh).not.toBe(old);
    // The printed code stops opening orders at once; the guest already inside keeps their visit.
    expect((await scan(old)).status).toBe(404);
    expect((await t.http.get(`/v1/public/venue/${old}/counter`)).status).toBe(404);
    expect((await scan(fresh)).status).toBe(200);
    expect((await t.http.get('/v1/public/visits/current').set(visitHeader(open.body.token))).status).toBe(200);
    const [audit] = await sql(`select action from audit_logs where org_id = $1 and action = 'floor.venue_qr_rotated'`, [other.orgId]);
    expect(audit).toBeTruthy();
  });

  it('keeps the public ordering page for branches that do not serve at a counter, and refuses to rotate there', async () => {
    const dining = await createTenant(t, { country: 'EG' });
    const qr = await t.http.get(S(dining, `/floor/${dining.branchId}/venue-qr`)).set(auth(dining.owner));
    expect(qr.body).toMatchObject({ kind: 'order', rotatedAt: null });
    expect(qr.body.url).toMatch(new RegExp(`^http://app\\.test/order/${dining.slug}\\?branch=`));
    const r = await t.http.post(S(dining, `/floor/${dining.branchId}/venue-qr/rotate`)).set(auth(dining.owner));
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('not_counter');
  });

  it('is tenant-scoped: another restaurant can neither read nor rotate this branch code', async () => {
    const stranger = await createTenant(t, { country: 'EG' });
    expect([403, 404]).toContain((await t.http.get(`/v1/o/${shop.orgId}/floor/${shop.branchId}/venue-qr`).set(auth(stranger.owner))).status);
    expect([403, 404]).toContain((await t.http.get(S(stranger, `/floor/${shop.branchId}/venue-qr`)).set(auth(stranger.owner))).status);
    expect([403, 404]).toContain((await t.http.post(S(stranger, `/floor/${shop.branchId}/venue-qr/rotate`)).set(auth(stranger.owner))).status);
  });
});

describe('counter session: scan → order → ticket → KDS → pay → pick up → close (FT-07)', () => {
  it('runs the legacy counter flow on the table visit paths', async () => {
    // Read-only lookup for the counter page: no visit is opened.
    const before = (await sql(`select count(*)::int as n from visits where branch_id = $1`, [shop.branchId]))[0].n;
    const view = await t.http.get(`/v1/public/venue/${venue}/counter`);
    expect(view.status).toBe(200);
    expect(view.body).toMatchObject({ org: { slug: shop.slug, currency: 'EGP' }, branch: { id: shop.branchId }, accepting: true, reason: null });
    expect(JSON.stringify(view.body)).not.toContain(venue);
    expect((await sql(`select count(*)::int as n from visits where branch_id = $1`, [shop.branchId]))[0].n).toBe(before);
    // Printed codes route to the counter page.
    expect((await t.http.get(`/v1/public/venue/${venue}`)).body.path).toBe(`/v/${venue}`);

    // 1. Scan: a table-less counter visit for this guest alone.
    const s = await scan(venue);
    expect(s.status).toBe(200);
    expect(s.body).toMatchObject({ kind: 'counter', orgId: shop.orgId, branchId: shop.branchId, currency: 'EGP', opened: true, org: { slug: shop.slug } });
    const token = s.body.token as string;
    const [v] = await sql('select kind, table_id, guest_token_hash, opened_via from visits where id = $1', [s.body.visitId]);
    expect(v).toEqual({ kind: 'counter', table_id: null, guest_token_hash: sha256(token), opened_via: 'qr' });
    // The same phone rejoins its own visit; another phone (no token) gets its own.
    const again = await scan(venue, visitHeader(token));
    expect(again.body).toMatchObject({ visitId: s.body.visitId, token, opened: false });
    const neighbour = await scan(venue);
    expect(neighbour.body.visitId).not.toBe(s.body.visitId);
    expect(neighbour.body.token).not.toBe(token);
    // The venue code is never a visit credential.
    expect((await t.http.get('/v1/public/visits/current').set(visitHeader(venue))).status).toBe(401);

    const live0 = await t.http.get('/v1/public/visits/current').set(visitHeader(token));
    expect(live0.body).toMatchObject({ kind: 'counter', table: null, ticket: null, orders: [], totals: { dueMinor: 0 } });
    expect((await t.http.get('/v1/public/visits/current/menu').set(visitHeader(token))).status).toBe(200);

    // 2. Order: priced and placed by the kernel as takeaway (pickup), no table.
    const o = await order(token, [fries(2)]);
    const [row] = await sql('select channel, fulfillment, table_id, visit_id, business_date::text as day, number from orders where id = $1', [o.id]);
    expect(row).toMatchObject({ channel: 'qr', fulfillment: 'pickup', table_id: null, visit_id: s.body.visitId, number: o.number });
    const live1 = await t.http.get('/v1/public/visits/current').set(visitHeader(token));
    expect(live1.body.ticket).toBe(o.number);
    expect(live1.body.totals).toMatchObject({ totalMinor: 9000, dueMinor: 9000, paidMinor: 0 });

    // 3. Kitchen: the ticket is the order number, marked as a counter order.
    const feed = await t.http.get(S(shop, `/kitchen/${shop.branchId}`)).set(auth(kitchen));
    expect(feed.body.serviceMode).toBe('counter');
    expect(feed.body.tickets.find((x: any) => x.id === o.id)).toMatchObject({ number: o.number, counter: true, tableLabel: null, fulfillment: 'pickup', channel: 'qr' });

    // 4. "Pay at the counter": a bill request the cashier sees with the ticket; a counter has no waiter to call.
    const waiterCall = await t.http.post('/v1/public/visits/current/requests').set(visitHeader(token)).send({ kind: 'waiter' });
    expect(waiterCall.status).toBe(409);
    expect(waiterCall.body.error.code).toBe('request_unavailable');
    expect((await t.http.post('/v1/public/visits/current/requests').set(visitHeader(token)).send({ kind: 'bill' })).status).toBe(201);
    const reqs = await t.http.get(S(shop, `/requests?branchId=${shop.branchId}`)).set(auth(cashier));
    expect(reqs.status).toBe(200);
    expect(reqs.body.items.find((r: any) => r.visitId === s.body.visitId)).toMatchObject({ kind: 'bill', visitKind: 'counter', ticket: o.number, tableLabel: null });
    const board = await t.http.get(S(shop, `/visits?branchId=${shop.branchId}`)).set(auth(cashier));
    expect(board.body.items.find((x: any) => x.id === s.body.visitId)).toMatchObject({ kind: 'counter', ticket: o.number, tableId: null, dueMinor: 9000, requests: ['bill'] });

    // 5. Nothing marks it paid but staff collection: the bill stays due; closing is refused.
    const bill = await t.http.get('/v1/public/payments/visit/bill').set(visitHeader(token));
    expect(bill.status).toBe(200);
    expect(bill.body).toMatchObject({ kind: 'counter', ticket: o.number, table: null, totals: { dueMinor: 9000 } });
    expect((await t.http.post(S(shop, `/visits/${s.body.visitId}/close`)).set(auth(waiter)).send({})).body.error.code).toBe('visit_not_settled');

    // 6. Ready for pickup: the guest's view shows it.
    for (const to of ['accepted', 'preparing', 'ready']) {
      expect((await t.http.post(S(shop, `/kitchen/orders/${o.id}/bump`)).set(auth(kitchen)).send({ to })).status).toBe(200);
    }
    const ready = await t.http.get(`/v1/public/visits/current/orders/${o.id}`).set(visitHeader(token));
    expect(ready.body).toMatchObject({ status: 'ready', fulfillment: 'pickup', dueMinor: 9000 });

    // 7. The cashier collects cash for the whole ticket (idempotent), the guest picks up, staff close the visit.
    const ck = key('cash');
    const pay = () => t.http.post(S(shop, `/visits/${s.body.visitId}/collect`)).set(auth(cashier)).set('Idempotency-Key', ck).send({ method: 'cash' });
    const p1 = await pay();
    expect(p1.status).toBe(200);
    expect(p1.body.totals.dueMinor).toBe(0);
    expect((await pay()).body.paymentId).toBe(p1.body.paymentId);
    expect((await t.http.post(S(shop, `/orders/${o.id}/transition`)).set(auth(waiter)).send({ to: 'picked_up' })).status).toBe(200);
    const closed = await t.http.post(S(shop, `/visits/${s.body.visitId}/close`)).set(auth(waiter)).send({});
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);
    expect((await t.http.get('/v1/public/visits/current').set(visitHeader(token))).status).toBe(401);
    // The next scan from that phone starts a fresh visit.
    const next = await scan(venue, visitHeader(token));
    expect(next.body.opened).toBe(true);
    expect(next.body.visitId).not.toBe(s.body.visitId);
  });

  it('pays on the phone only through the verified provider event, never when the checkout is merely started', async () => {
    const s = await scan(venue);
    const o = await order(s.body.token, [fries(1)]);
    const link = await t.http.post('/v1/public/payments/visit/checkout').set(visitHeader(s.body.token)).send({ key: key('pay') });
    expect(link.status, JSON.stringify(link.body)).toBe(200);
    expect(link.body.amountMinor).toBe(4500);
    const checkoutToken = link.body.url.split('/pay/')[1];
    const view = await t.http.get(`/v1/public/pay/${checkoutToken}`);
    expect(view.body.description ?? '').not.toMatch(/Table/);
    const start = await t.http.post(`/v1/public/pay/${checkoutToken}/start`).send({ method: 'card' });
    expect(start.status, JSON.stringify(start.body)).toBe(200);
    // Started, not paid: the ticket is still due and the order unpaid.
    expect((await t.http.get('/v1/public/visits/current').set(visitHeader(s.body.token))).body.totals.dueMinor).toBe(4500);
    expect((await sql('select payment_status from orders where id = $1', [o.id]))[0].payment_status).toBe('unpaid');
    // The provider's signed event (sandbox provider) settles it.
    const done = await t.http.post(`/v1/public/pay/${checkoutToken}/sandbox/complete`).send({ outcome: 'success' });
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect((await t.http.get('/v1/public/visits/current').set(visitHeader(s.body.token))).body.totals.dueMinor).toBe(0);
    expect((await sql('select payment_status from orders where id = $1', [o.id]))[0].payment_status).toBe('paid');
  });

  it('gives every order a unique ticket number per branch and business day, also under concurrent orders', async () => {
    const phones = await Promise.all(Array.from({ length: 6 }, () => scan(venue)));
    const placed = await Promise.all(phones.flatMap((p) => [order(p.body.token), order(p.body.token)]));
    const numbers = placed.map((p) => Number(p.number));
    expect(new Set(numbers).size).toBe(12);
    const rows = await sql<{ number: string; n: number }>(
      `select number, count(*)::int as n from orders where branch_id = $1 and business_date = (select day from order_counters where branch_id = $1) group by number having count(*) > 1`,
      [shop.branchId]);
    expect(rows).toEqual([]);
    // Consecutive: the counter is a row lock, no gaps between concurrent orders.
    const sorted = [...numbers].sort((a, b) => a - b);
    expect(sorted[sorted.length - 1]! - sorted[0]!).toBe(11);
    // Each phone's ticket is its latest order.
    const live = await t.http.get('/v1/public/visits/current').set(visitHeader(phones[0]!.body.token));
    const mine = placed.slice(0, 2).map((p) => p.number);
    expect(mine).toContain(live.body.ticket);
  });
});

describe('when a counter scan is refused (FT-07)', () => {
  it('a tables branch, an inactive branch, a suspended restaurant and unknown codes', async () => {
    const r = await createTenant(t, { country: 'EG' });
    const code = codeOf((await counterBranch(r)).url);
    // Back to table service: the printed code now leads to the ordering page and opens no counter visit.
    await t.http.put(S(r, `/branches/${r.branchId}/service-mode`)).set(auth(r.owner)).send({ mode: 'tables' });
    expect((await t.http.get(`/v1/public/venue/${code}`)).body.path).toMatch(/^\/order\//);
    expect((await t.http.get(`/v1/public/venue/${code}/counter`)).body).toMatchObject({ accepting: false, reason: 'not_counter' });
    const notCounter = await scan(code);
    expect(notCounter.status).toBe(409);
    expect(notCounter.body.error).toMatchObject({ code: 'venue_unavailable', details: { reason: 'not_counter' } });
    await t.http.put(S(r, `/branches/${r.branchId}/service-mode`)).set(auth(r.owner)).send({ mode: 'counter' });
    await sql('update branches set is_active = false where id = $1', [r.branchId]);
    const closed = await scan(code);
    expect(closed.status).toBe(409);
    expect(closed.body.error.details.reason).toBe('branch_closed');
    await sql('update branches set is_active = true where id = $1', [r.branchId]);
    await sql(`update organizations set status = 'suspended' where id = $1`, [r.orgId]);
    expect((await scan(code)).status).toBe(404);
    expect((await scan('x'.repeat(43))).status).toBe(404);
    expect((await scan('short')).status).toBe(404);
  });

  it('a legacy-printed venue code of a counter branch opens the counter session', async () => {
    const r = await createTenant(t, { country: 'EG' });
    await counterBranch(r);
    const legacy = `legacy${Date.now().toString(16)}venue0000000000`.slice(0, 32);
    await sql(`insert into legacy_id_map(org_id, entity_type, legacy_id, new_id) values ($1, 'venue_qr', $2, $3)`, [r.orgId, legacy, r.branchId]);
    expect((await t.http.get(`/v1/public/venue/${legacy}`)).body.path).toBe(`/v/${legacy}`);
    const s = await scan(legacy);
    expect(s.status).toBe(200);
    expect(s.body).toMatchObject({ kind: 'counter', branchId: r.branchId, opened: true });
  });

  it('limits scans per address and caps empty open counter visits per branch', async () => {
    const r = await createTenant(t, { country: 'EG' });
    const code = codeOf((await counterBranch(r)).url);
    const addr = '10.99.1.1';
    const codes: number[] = [];
    for (let i = 0; i < 31; i++) codes.push((await t.http.post(`/v1/public/venue/${code}/session`).set('X-Forwarded-For', addr)).status);
    expect(codes.slice(0, 30).every((c) => c === 200)).toBe(true);
    expect(codes[30]).toBe(429);
    // A branch with 500 open counter visits that never ordered refuses new scans until the sweep clears them.
    await sql(`insert into visits(org_id, branch_id, table_id, kind, guest_token_hash, opened_via)
               select $1, $2, null, 'counter', md5(random()::text || g::text) || md5(g::text), 'qr' from generate_series(1, 470) g`, [r.orgId, r.branchId]);
    const busy = await scan(code);
    expect(busy.status).toBe(429);
    await sql(`update visits set opened_at = now() - interval '4 hours' where branch_id = $1 and kind = 'counter'`, [r.branchId]);
    const res = await t.app.get(VisitsService).runAutoClose();
    expect(res.abandoned).toBeGreaterThanOrEqual(500);
    expect((await sql(`select count(*)::int as n from visits where branch_id = $1 and status = 'open'`, [r.branchId]))[0].n).toBe(0);
    expect((await sql(`select close_reason from visits where branch_id = $1 limit 1`, [r.branchId]))[0].close_reason).toBe('auto');
    expect((await scan(code)).status).toBe(200);
  });

  it('does not sweep a counter visit that ordered, and keeps tenants apart', async () => {
    const s = await scan(venue);
    await order(s.body.token);
    await sql(`update visits set opened_at = now() - interval '4 hours' where id = $1`, [s.body.visitId]);
    await t.app.get(VisitsService).runAutoClose();
    expect((await sql('select status from visits where id = $1', [s.body.visitId]))[0].status).toBe('open');
    // Another restaurant's staff cannot see or close it.
    const stranger = await createTenant(t, { country: 'EG' });
    const list = await t.http.get(S(stranger, '/visits')).set(auth(stranger.owner));
    expect(list.body.items.map((x: any) => x.id)).not.toContain(s.body.visitId);
    expect([403, 404]).toContain((await t.http.post(S(stranger, `/visits/${s.body.visitId}/close`)).set(auth(stranger.owner)).send({ force: true })).status);
    expect([403, 404]).toContain((await t.http.post(S(stranger, `/visits/${s.body.visitId}/collect`)).set(auth(stranger.owner)).set('Idempotency-Key', key()).send({ method: 'cash' })).status);
  });
});
