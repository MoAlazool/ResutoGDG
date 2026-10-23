// FT-07: the legacy counter session (one venue QR per branch; takeaway counter / cloud kitchen). Legacy server.js
// /api/table-session with the venue QR opened a table-less "Counter order" visit per scan; the guest ordered, quoted a
// number at the till and paid on the phone or at the counter. Here: the venue credential (hashed, rotatable), the
// session, ordering through the kernel as pickup, ticket numbers (per branch and business day, unique under
// concurrency), the KDS and staff boards, payment safety (paid only by a verified provider event or staff collection),
// closing and the abandoned-visit sweep, tenant isolation and rate limits. A scan writes nothing: the guest's counter
// visit opens with their first order (review finding: anonymous scans must not use up a shared branch budget).
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

/** The guest's first counter order: venue quote, then the order that opens their counter visit. */
async function firstOrder(code: string, lines = [fries()], addr = ip()) {
  const quote = await t.http.post(`/v1/public/venue/${code}/quote`).set('X-Forwarded-For', addr).send({ lines });
  expect(quote.status, JSON.stringify(quote.body)).toBe(200);
  const o = await t.http.post(`/v1/public/venue/${code}/orders`).set('X-Forwarded-For', addr).set('Idempotency-Key', key('counter-first'))
    .send({ lines, expectedTotalMinor: quote.body.totalMinor });
  expect(o.status, JSON.stringify(o.body)).toBe(201);
  return o.body as { order: { id: string; number: string; totalMinor: number }; session: { token: string; visitId: string; opened: boolean; branchId: string } };
}
const visitsOf = async (branchId: string) => (await sql(`select count(*)::int as n from visits where branch_id = $1`, [branchId]))[0].n as number;

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
    const otherMenu = await seedMenu(other);
    const old = codeOf((await t.http.get(S(other, `/floor/${other.branchId}/venue-qr`)).set(auth(other.owner))).body.url);
    const open = (await firstOrder(old, [{ productId: otherMenu.products.fries, quantity: 1 }])).session;
    const rotated = await t.http.post(S(other, `/floor/${other.branchId}/venue-qr/rotate`)).set(auth(other.owner));
    expect(rotated.status).toBe(200);
    const fresh = codeOf(rotated.body.url);
    expect(fresh).not.toBe(old);
    // The printed code stops opening orders at once; the guest already inside keeps their visit.
    expect((await scan(old)).status).toBe(404);
    expect((await t.http.get(`/v1/public/venue/${old}/counter`)).status).toBe(404);
    expect((await t.http.post(`/v1/public/venue/${old}/quote`).send({ lines: [fries()] })).status).toBe(404);
    expect((await t.http.post(`/v1/public/venue/${old}/orders`).set('Idempotency-Key', key('old-code')).send({ lines: [fries()], expectedTotalMinor: 4500 })).status).toBe(404);
    expect((await scan(fresh)).status).toBe(200);
    expect((await t.http.get('/v1/public/visits/current').set(visitHeader(open.token))).status).toBe(200);
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

    // 1. Scan: read-only. The counter takes orders; no visit and no token yet.
    const s0 = await scan(venue);
    expect(s0.status).toBe(200);
    expect(s0.body).toMatchObject({ kind: 'counter', orgId: shop.orgId, branchId: shop.branchId, currency: 'EGP', opened: false, token: null, visitId: null, org: { slug: shop.slug } });
    expect(await visitsOf(shop.branchId)).toBe(before);
    // The venue code is never a visit credential.
    expect((await t.http.get('/v1/public/visits/current').set(visitHeader(venue))).status).toBe(401);

    // 2. First order: the venue quote (takeaway pricing), then the order opens this guest's table-less counter visit.
    const first = await firstOrder(venue, [fries(2)]);
    const o = first.order;
    const s = { body: first.session };
    expect(s.body).toMatchObject({ kind: 'counter', orgId: shop.orgId, branchId: shop.branchId, opened: true });
    const token = s.body.token;
    expect(await visitsOf(shop.branchId)).toBe(before + 1);
    const [v] = await sql('select kind, table_id, guest_token_hash, opened_via from visits where id = $1', [s.body.visitId]);
    expect(v).toEqual({ kind: 'counter', table_id: null, guest_token_hash: sha256(token), opened_via: 'qr' });
    const [row] = await sql('select channel, fulfillment, table_id, visit_id, business_date::text as day, number from orders where id = $1', [o.id]);
    expect(row).toMatchObject({ channel: 'qr', fulfillment: 'pickup', table_id: null, visit_id: s.body.visitId, number: o.number });
    // The same phone rejoins its own visit; another phone (no token) still has none.
    const again = await scan(venue, visitHeader(token));
    expect(again.body).toMatchObject({ visitId: s.body.visitId, token, opened: false });
    const neighbour = await scan(venue);
    expect(neighbour.body).toMatchObject({ token: null, visitId: null });
    expect((await t.http.get('/v1/public/visits/current/menu').set(visitHeader(token))).status).toBe(200);
    const live1 = await t.http.get('/v1/public/visits/current').set(visitHeader(token));
    expect(live1.body).toMatchObject({ kind: 'counter', table: null, ticket: o.number });
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
    // The next scan from that phone has no visit; its next order opens a fresh one.
    const next = await scan(venue, visitHeader(token));
    expect(next.body).toMatchObject({ token: null, visitId: null });
    const nextOrder = await firstOrder(venue);
    expect(nextOrder.session.visitId).not.toBe(s.body.visitId);
  });

  it('pays on the phone only through the verified provider event, never when the checkout is merely started', async () => {
    const first = await firstOrder(venue, [fries(1)]);
    const s = { body: first.session };
    const o = first.order;
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
    // Six phones place their first orders at once (each opens its own visit), then each orders again at once.
    const firsts = await Promise.all(Array.from({ length: 6 }, () => firstOrder(venue)));
    expect(new Set(firsts.map((f) => f.session.visitId)).size).toBe(6);
    const again = await Promise.all(firsts.map((f) => order(f.session.token)));
    const placed = [...firsts.map((f) => f.order), ...again];
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
    const live = await t.http.get('/v1/public/visits/current').set(visitHeader(firsts[0]!.session.token));
    expect(live.body.ticket).toBe(again[0]!.number);
  });

  it('replays a retried first order (same key: same order, same visit, token derived again, never stored)', async () => {
    const lines = [fries(1)];
    const quote = await t.http.post(`/v1/public/venue/${venue}/quote`).send({ lines });
    const k = key('counter-retry');
    const send = () => t.http.post(`/v1/public/venue/${venue}/orders`).set('X-Forwarded-For', ip()).set('Idempotency-Key', k).send({ lines, expectedTotalMinor: quote.body.totalMinor });
    const [a, b] = await Promise.all([send(), send()]);
    expect([a.status, b.status]).toEqual([201, 201]);
    expect(b.body.order.id).toBe(a.body.order.id);
    expect(b.body.session).toMatchObject({ visitId: a.body.session.visitId, token: a.body.session.token });
    expect((await sql('select count(*)::int as n from orders where visit_id = $1', [a.body.session.visitId]))[0].n).toBe(1);
    const [rec] = await sql(`select response::text as r from idempotency_keys where scope = $1 and key = $2`, [`counter-order:${shop.branchId}`, k]);
    expect(rec.r).not.toContain(a.body.session.token);
    // A short key is refused (it stands for the visit on a replay); a price that moved opens nothing.
    const before = await visitsOf(shop.branchId);
    const short = await t.http.post(`/v1/public/venue/${venue}/orders`).set('Idempotency-Key', 'short-key').send({ lines, expectedTotalMinor: quote.body.totalMinor });
    expect(short.status).toBe(400);
    const moved = await t.http.post(`/v1/public/venue/${venue}/orders`).set('Idempotency-Key', key('counter-moved')).send({ lines, expectedTotalMinor: 1 });
    expect(moved.status).toBe(409);
    expect(moved.body.error.code).toBe('price_changed');
    expect(await visitsOf(shop.branchId)).toBe(before);
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
    expect((await t.http.post(`/v1/public/venue/${code}/quote`).send({ lines: [{ productId: menu.products.fries, quantity: 1 }] })).body.error.code).toBe('venue_unavailable');
    const refusedOrder = await t.http.post(`/v1/public/venue/${code}/orders`).set('Idempotency-Key', key('not-counter')).send({ lines: [{ productId: menu.products.fries, quantity: 1 }], expectedTotalMinor: 4500 });
    expect(refusedOrder.status).toBe(409);
    expect(await visitsOf(r.branchId)).toBe(0);
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

  it('a legacy-printed venue code of a counter branch opens the counter session until the branch rotates its code', async () => {
    const r = await createTenant(t, { country: 'EG' });
    const rMenu = await seedMenu(r);
    await counterBranch(r);
    const legacy = `legacy${Date.now().toString(16)}venue0000000000`.slice(0, 32);
    await sql(`insert into legacy_id_map(org_id, entity_type, legacy_id, new_id) values ($1, 'venue_qr', $2, $3)`, [r.orgId, legacy, r.branchId]);
    expect((await t.http.get(`/v1/public/venue/${legacy}`)).body.path).toBe(`/v/${legacy}`);
    const s = await scan(legacy);
    expect(s.status).toBe(200);
    expect(s.body).toMatchObject({ kind: 'counter', branchId: r.branchId, token: null });
    const lines = [{ productId: rMenu.products.fries, quantity: 1 }];
    const q = await t.http.post(`/v1/public/venue/${legacy}/quote`).send({ lines });
    const o = await t.http.post(`/v1/public/venue/${legacy}/orders`).set('Idempotency-Key', key('legacy-first')).send({ lines, expectedTotalMinor: q.body.totalMinor });
    expect(o.status, JSON.stringify(o.body)).toBe(201);
    expect(o.body.session).toMatchObject({ kind: 'counter', branchId: r.branchId, opened: true });
    // Rotating the branch's code retires the legacy-printed one too ("the printed code stops opening orders at once");
    // the guest already ordering keeps their visit.
    expect((await t.http.post(S(r, `/floor/${r.branchId}/venue-qr/rotate`)).set(auth(r.owner))).status).toBe(200);
    expect((await scan(legacy)).status).toBe(404);
    expect((await t.http.get(`/v1/public/venue/${legacy}`)).status).toBe(404);
    expect((await t.http.get(`/v1/public/venue/${legacy}/counter`)).status).toBe(404);
    expect((await t.http.post(`/v1/public/venue/${legacy}/orders`).set('Idempotency-Key', key('legacy-after')).send({ lines, expectedTotalMinor: q.body.totalMinor })).status).toBe(404);
    expect((await t.http.get('/v1/public/visits/current').set(visitHeader(o.body.session.token))).status).toBe(200);
    // A legacy row the old tool mapped to the organization (resolves to the main branch) is retired as well.
    const orgMapped = `legacyorg${Date.now().toString(16)}venue000000000`.slice(0, 32);
    await sql(`insert into legacy_id_map(org_id, entity_type, legacy_id, new_id) values ($1, 'venue_qr', $2, $1)`, [r.orgId, orgMapped]);
    expect((await scan(orgMapped)).status).toBe(404);
  });

  it('scripted scans from many addresses open nothing, so a real guest can always order', async () => {
    // Review probe: 17 addresses x 30 scans used to open 500 empty visits and lock the branch for hours (429).
    const r = await createTenant(t, { country: 'EG' });
    const rMenu = await seedMenu(r);
    const code = codeOf((await counterBranch(r)).url);
    for (let a = 0; a < 17; a++) {
      const res = await Promise.all(Array.from({ length: 30 }, () => t.http.post(`/v1/public/venue/${code}/session`).set('X-Forwarded-For', `10.200.${a}.1`)));
      expect(res.every((x) => x.status === 200)).toBe(true);
    }
    expect(await visitsOf(r.branchId)).toBe(0);
    const lines = [{ productId: rMenu.products.fries, quantity: 1 }];
    const q = await t.http.post(`/v1/public/venue/${code}/quote`).set('X-Forwarded-For', '10.201.0.1').send({ lines });
    expect(q.status).toBe(200);
    const guest = await t.http.post(`/v1/public/venue/${code}/orders`).set('X-Forwarded-For', '10.201.0.1').set('Idempotency-Key', key('real-guest'))
      .send({ lines, expectedTotalMinor: q.body.totalMinor });
    expect(guest.status, JSON.stringify(guest.body)).toBe(201);
    expect(await visitsOf(r.branchId)).toBe(1);
    // Scans are limited per address only (a read: 120 a minute), never by a budget the whole counter shares.
    const addr = '10.99.1.1';
    const codes: number[] = [];
    for (let i = 0; i < 121; i++) codes.push((await t.http.post(`/v1/public/venue/${code}/session`).set('X-Forwarded-For', addr)).status);
    expect(codes.slice(0, 120).every((c) => c === 200)).toBe(true);
    expect(codes[120]).toBe(429);
    expect((await t.http.post(`/v1/public/venue/${code}/session`).set('X-Forwarded-For', '10.99.1.2')).status).toBe(200);
    // Placing orders (the only write that opens a visit) is guard()ed per address: 20 a minute.
    const place = () => t.http.post(`/v1/public/venue/${code}/orders`).set('X-Forwarded-For', '10.99.2.1').set('Idempotency-Key', key('flood'))
      .send({ lines, expectedTotalMinor: 1 });
    const placed: number[] = [];
    for (let i = 0; i < 21; i++) placed.push((await place()).status);
    expect(placed.slice(0, 20).every((c) => c === 409)).toBe(true);
    expect(placed[20]).toBe(429);
    expect(await visitsOf(r.branchId)).toBe(1);
  });

  it('sweeps counter visits left with nothing to collect: every order cancelled, or (older rows) no order at all', async () => {
    const r = await createTenant(t, { country: 'EG' });
    const rMenu = await seedMenu(r);
    const code = codeOf((await counterBranch(r)).url);
    const lines = [{ productId: rMenu.products.fries, quantity: 1 }];
    const place = async () => {
      const q = await t.http.post(`/v1/public/venue/${code}/quote`).send({ lines });
      const o = await t.http.post(`/v1/public/venue/${code}/orders`).set('X-Forwarded-For', ip()).set('Idempotency-Key', key('sweep')).send({ lines, expectedTotalMinor: q.body.totalMinor });
      expect(o.status, JSON.stringify(o.body)).toBe(201);
      return o.body as { order: { id: string }; session: { visitId: string; token: string } };
    };
    const cancelled = await place();
    const recent = await place();
    const live = await place();
    for (const v of [cancelled, recent]) {
      const c = await t.http.post(S(r, `/orders/${v.order.id}/cancel`)).set(auth(r.owner)).send({ reason: 'guest left' });
      expect(c.status, JSON.stringify(c.body)).toBe(200);
    }
    // Visits opened before counter visits opened with the first order: empty rows.
    await sql(`insert into visits(org_id, branch_id, table_id, kind, guest_token_hash, opened_via, opened_at)
               select $1, $2, null, 'counter', md5(random()::text || g::text) || md5(g::text), 'qr', now() - interval '4 hours' from generate_series(1, 3) g`, [r.orgId, r.branchId]);
    await sql(`update visits set opened_at = now() - interval '30 hours' where id = any($1)`, [[cancelled.session.visitId, recent.session.visitId, live.session.visitId]]);
    await sql(`update orders set placed_at = now() - interval '30 hours', cancelled_at = now() - interval '30 hours' where id = $1`, [cancelled.order.id]);
    await sql(`update orders set placed_at = now() - interval '30 hours' where id = $1`, [live.order.id]);
    const res = await t.app.get(VisitsService).runAutoClose();
    expect(res.abandoned).toBeGreaterThanOrEqual(4);
    const status = async (id: string) => (await sql('select status, close_reason from visits where id = $1', [id]))[0];
    expect(await status(cancelled.session.visitId)).toEqual({ status: 'closed', close_reason: 'auto' });
    // Cancelled a moment ago: kept until it has been quiet COUNTER_ABANDON. A live order is never swept.
    expect((await status(recent.session.visitId)).status).toBe('open');
    expect((await status(live.session.visitId)).status).toBe('open');
    expect((await sql(`select count(*)::int as n from visits where branch_id = $1 and status = 'open' and not exists (select 1 from orders o where o.visit_id = visits.id)`, [r.branchId]))[0].n).toBe(0);
    expect((await t.http.get('/v1/public/visits/current').set(visitHeader(cancelled.session.token))).status).toBe(401);
  });

  it('does not sweep a counter visit that ordered, and keeps tenants apart', async () => {
    const s = (await firstOrder(venue)).session;
    await sql(`update visits set opened_at = now() - interval '4 hours' where id = $1`, [s.visitId]);
    await t.app.get(VisitsService).runAutoClose();
    expect((await sql('select status from visits where id = $1', [s.visitId]))[0].status).toBe('open');
    // Another restaurant's staff cannot see or close it.
    const stranger = await createTenant(t, { country: 'EG' });
    const list = await t.http.get(S(stranger, '/visits')).set(auth(stranger.owner));
    expect(list.body.items.map((x: any) => x.id)).not.toContain(s.visitId);
    expect([403, 404]).toContain((await t.http.post(S(stranger, `/visits/${s.visitId}/close`)).set(auth(stranger.owner)).send({ force: true })).status);
    expect([403, 404]).toContain((await t.http.post(S(stranger, `/visits/${s.visitId}/collect`)).set(auth(stranger.owner)).set('Idempotency-Key', key()).send({ method: 'cash' })).status);
    // Nor can a guest order into another restaurant's counter with this restaurant's visit token.
    const other = await createTenant(t, { country: 'EG' });
    const otherCode = codeOf((await counterBranch(other)).url);
    const rejoin = await scan(otherCode, visitHeader(s.token));
    expect(rejoin.body).toMatchObject({ token: null, visitId: null, branchId: other.branchId });
  });
});
