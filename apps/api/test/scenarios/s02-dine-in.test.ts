// S02 — Dine-in with QR ordering and an equally split bill paid share by share
// through ResutoPay's simulated provider (verified webhook path). HTTP only.
import { splitEvenly } from '@resuto/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addMember, auth, bootTestApp, createTenant, sql, type TestApp, type TestTenant, type TestUser } from '../helpers';
import { qrTokenFor, saveFloor, table } from '../ops-fixtures';
import { buildMenuViaApi, burgerLine, key, payViaSandbox, PRICES, tokenFromUrl, type ApiMenu } from './support';

let t: TestApp;
let tenant: TestTenant;
let menu: ApiMenu;
let kitchen: TestUser;
let waiter: TestUser;
let tableId: string;
let qr: string;
let visitToken: string;
let visitId: string;
let orderId: string;
let shares: Array<{ id: string; amountMinor: number; url: string }>;

const V = (tok: string) => ({ 'X-Visit-Token': tok });
const lines = () => [burgerLine(menu, 2, { large: true }), { productId: menu.fries, quantity: 1, notes: 'Extra crispy' }];
const EXPECTED_TOTAL = (PRICES.burger + PRICES.large) * 2 + PRICES.fries; // 47500, dine-in, no service charge configured

beforeAll(async () => {
  t = await bootTestApp();
  tenant = await createTenant(t, { country: 'EG' });
  menu = await buildMenuViaApi(t, tenant);
  kitchen = await addMember(t, tenant, 'kitchen', [tenant.branchId]);
  waiter = await addMember(t, tenant, 'waiter', [tenant.branchId]);
  const f = await saveFloor(t, tenant, [table('T1', 200, 200), table('T2', 400, 200)]);
  tableId = f.tables.find((x: any) => x.label === 'T1').id;
  qr = await qrTokenFor(t, tenant, tableId);
});
afterAll(async () => { await t.close(); });

describe('S02 dine-in: QR → order → kitchen → split bill → close → clean', () => {
  it('1. a guest scans the table QR and a second guest joins the same visit', async () => {
    const scan = await t.http.post(`/v1/public/tables/${qr}/session`);
    expect(scan.status).toBe(200);
    expect(scan.body).toMatchObject({ orgId: tenant.orgId, branchId: tenant.branchId, tableLabel: 'T1', currency: 'EGP', opened: true });
    expect(JSON.stringify(scan.body)).not.toContain(qr);
    visitToken = scan.body.token;
    visitId = scan.body.visitId;
    const friend = await t.http.post(`/v1/public/tables/${qr}/session`);
    expect(friend.body).toMatchObject({ visitId, token: visitToken, opened: false });
    const live = await t.http.get(`/v1/o/${tenant.orgId}/floor/${tenant.branchId}/live`).set(auth(waiter));
    expect(live.body.tables.find((x: any) => x.id === tableId)).toMatchObject({ status: 'occupied', visit: { id: visitId } });
  });

  it('2. browses the public menu for the visit and gets a server-side quote', async () => {
    const m = await t.http.get('/v1/public/visits/current/menu').set(V(visitToken));
    expect(m.status).toBe(200);
    const names = m.body.categories.flatMap((c: any) => c.products.map((p: any) => p.nameAr));
    expect(names).toEqual(expect.arrayContaining(['برجر سماش', 'بطاطس مقلية', 'مشروب غازي']));
    const quote = await t.http.post('/v1/public/visits/current/quote').set(V(visitToken)).send({ lines: lines() });
    expect(quote.status).toBe(200);
    expect(quote.body.totalMinor).toBe(EXPECTED_TOTAL);
  });

  it('3. places the order; a network retry with the same key does not duplicate it', async () => {
    const k = key('dine-in');
    const send = () => t.http.post('/v1/public/visits/current/orders').set(V(visitToken)).set('Idempotency-Key', k)
      .send({ lines: lines(), expectedTotalMinor: EXPECTED_TOTAL, notes: 'Anniversary' });
    const first = await send();
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    expect(first.body).toMatchObject({ status: 'placed', totalMinor: EXPECTED_TOTAL, currency: 'EGP' });
    const retry = await send();
    expect(retry.status).toBe(201);
    expect(retry.body.id).toBe(first.body.id);
    orderId = first.body.id;
    const [n] = await sql('select count(*)::int as n from orders where visit_id = $1', [visitId]);
    expect(n.n).toBe(1);
    const [row] = await sql('select channel, fulfillment, table_id from orders where id = $1', [orderId]);
    expect(row).toEqual({ channel: 'qr', fulfillment: 'dine_in', table_id: tableId });
  });

  it('4. the kitchen feed shows the ticket and the kitchen bumps it to ready', async () => {
    const feed = await t.http.get(`/v1/o/${tenant.orgId}/kitchen/${tenant.branchId}`).set(auth(kitchen));
    expect(feed.status).toBe(200);
    const ticket = feed.body.tickets.find((x: any) => x.id === orderId);
    expect(ticket).toMatchObject({ tableLabel: 'T1', status: 'placed', notes: 'Anniversary' });
    expect(ticket.lines.find((l: any) => l.name === 'Smash burger')).toMatchObject({ quantity: 2, station: 'Grill', modifiers: ['Large'] });
    expect(ticket.lines.find((l: any) => l.name === 'Fries')).toMatchObject({ station: 'Fryer', notes: 'Extra crispy' });
    for (const to of ['accepted', 'preparing', 'ready']) {
      const r = await t.http.post(`/v1/o/${tenant.orgId}/kitchen/orders/${orderId}/bump`).set(auth(kitchen)).send({ to });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
    }
    const after = await t.http.get(`/v1/o/${tenant.orgId}/kitchen/${tenant.branchId}`).set(auth(kitchen));
    expect(after.body.tickets.find((x: any) => x.id === orderId).status).toBe('ready');
  });

  it('5. the waiter serves it and the guest sees the full timeline', async () => {
    const served = await t.http.post(`/v1/o/${tenant.orgId}/orders/${orderId}/transition`).set(auth(waiter)).send({ to: 'served' });
    expect(served.status).toBe(200);
    expect(served.body.status).toBe('served');
    const status = await t.http.get(`/v1/public/visits/current/orders/${orderId}`).set(V(visitToken));
    expect(status.body.timeline.map((e: any) => e.status)).toEqual(['placed', 'accepted', 'preparing', 'ready', 'served']);
    const bill = await t.http.get('/v1/public/visits/current').set(V(visitToken));
    expect(bill.body.totals).toEqual({ totalMinor: EXPECTED_TOTAL, paidMinor: 0, creditMinor: 0, dueMinor: EXPECTED_TOTAL });
  });

  it('6. three guests split the bill equally (largest remainder)', async () => {
    const bill = await t.http.get('/v1/public/payments/visit/bill').set(V(visitToken));
    expect(bill.status).toBe(200);
    expect(bill.body.totals.dueMinor).toBe(EXPECTED_TOTAL);
    const split = await t.http.post('/v1/public/payments/visit/split').set(V(visitToken)).send({ mode: 'equal', people: 3, key: key('split') });
    expect(split.status, JSON.stringify(split.body)).toBe(200);
    expect(split.body.shares.map((s: any) => s.amountMinor)).toEqual(splitEvenly(EXPECTED_TOTAL, 3));
    expect(split.body.shares.reduce((s: number, x: any) => s + x.amountMinor, 0)).toBe(EXPECTED_TOTAL);
    shares = split.body.shares;
    // While the split is open the full-bill checkout is refused.
    const full = await t.http.post('/v1/public/payments/visit/checkout').set(V(visitToken)).send({ key: key() });
    expect(full.body.error.code).toBe('split_active');
  });

  it('7. each share is paid through the simulated provider; only verified webhooks move money', async () => {
    for (const [i, share] of shares.entries()) {
      const shareToken = tokenFromUrl(share.url, '/s/');
      const view = await t.http.get(`/v1/public/payments/shares/${shareToken}`);
      expect(view.body).toMatchObject({ amountMinor: share.amountMinor, status: 'open', participants: 3, paidCount: i });
      const co = await t.http.post(`/v1/public/payments/shares/${shareToken}/checkout`).send({ payerName: `Guest ${i + 1}`, key: key('share') });
      expect(co.status, JSON.stringify(co.body)).toBe(200);
      expect(co.body.amountMinor).toBe(share.amountMinor);
      const checkoutToken = tokenFromUrl(co.body.url, '/pay/');
      // Returning from the provider with a forged "paid" query string changes nothing.
      await t.http.post(`/v1/public/pay/${checkoutToken}/start`).send({ method: 'card' }).expect(200);
      const forged = await t.http.post(`/v1/public/pay/${checkoutToken}/refresh?status=paid&success=true`);
      expect(forged.body.status).not.toBe('paid');
      expect((await t.http.get(`/v1/public/payments/shares/${shareToken}`)).body.status).toBe('open');
      const { view: done } = await payViaSandbox(t, checkoutToken);
      expect(done.status).toBe('paid');
      expect((await t.http.get(`/v1/public/payments/shares/${shareToken}`)).body.status).toBe('paid');
    }
    const inbox = await sql(`select status, signature_valid from webhook_inbox where provider = 'payments:simulated' and org_id = $1`, [tenant.orgId]);
    expect(inbox.length).toBeGreaterThanOrEqual(3);
    expect(inbox.every((r) => r.status === 'processed' && r.signature_valid === true)).toBe(true);
    const payments = await sql(`select amount_minor, status, provider, is_test from payments where visit_id = $1 or order_id = $2 order by amount_minor desc`, [visitId, orderId]);
    expect(payments.filter((p) => p.status === 'succeeded').map((p) => p.amount_minor).sort()).toEqual(splitEvenly(EXPECTED_TOTAL, 3).sort());
    expect(payments.every((p) => p.provider === 'simulated' && p.is_test)).toBe(true);
  });

  it('8. the bill is settled: split settled, order paid, nothing due', async () => {
    const bill = await t.http.get('/v1/public/payments/visit/bill').set(V(visitToken));
    expect(bill.body.totals).toMatchObject({ totalMinor: EXPECTED_TOTAL, dueMinor: 0 });
    const [split] = await sql(`select status from bill_splits where visit_id = $1`, [visitId]);
    expect(split.status).toBe('settled');
    const order = await t.http.get(`/v1/o/${tenant.orgId}/orders/${orderId}`).set(auth(tenant.owner));
    expect(order.body).toMatchObject({ paymentStatus: 'paid', paidMinor: EXPECTED_TOTAL, dueMinor: 0 });
  });

  it('9. the waiter closes the visit; the table needs cleaning; the old guest token is rejected', async () => {
    const closed = await t.http.post(`/v1/o/${tenant.orgId}/visits/${visitId}/close`).set(auth(waiter)).send({ needsCleaning: true });
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);
    expect(closed.body).toMatchObject({ ok: true });
    const live = await t.http.get(`/v1/o/${tenant.orgId}/floor/${tenant.branchId}/live`).set(auth(waiter));
    expect(live.body.tables.find((x: any) => x.id === tableId)).toMatchObject({ status: 'cleaning', visit: null });
    const old = await t.http.get('/v1/public/visits/current').set(V(visitToken));
    expect(old.status).toBe(401);
    expect(old.body.error.code).toBe('visit_closed');
    expect((await t.http.post('/v1/public/visits/current/orders').set(V(visitToken)).set('Idempotency-Key', key()).send({ lines: lines() })).status).toBe(401);
    expect((await t.http.get('/v1/public/payments/visit/bill').set(V(visitToken))).status).not.toBe(200);
    const blocked = await t.http.post(`/v1/public/tables/${qr}/session`);
    expect(blocked.status).toBe(409);
    expect(blocked.body.error).toMatchObject({ code: 'table_unavailable', details: { reason: 'cleaning' } });
  });

  it('10. after cleaning the table is available and the next scan opens a fresh visit', async () => {
    expect((await t.http.post(`/v1/o/${tenant.orgId}/tables/${tableId}/clean`).set(auth(waiter))).status).toBe(200);
    const live = await t.http.get(`/v1/o/${tenant.orgId}/floor/${tenant.branchId}/live`).set(auth(waiter));
    expect(live.body.tables.find((x: any) => x.id === tableId).status).toBe('available');
    const fresh = await t.http.post(`/v1/public/tables/${qr}/session`);
    expect(fresh.status).toBe(200);
    expect(fresh.body.visitId).not.toBe(visitId);
    expect(fresh.body.token).not.toBe(visitToken);
    expect((await t.http.get('/v1/public/visits/current').set(V(visitToken))).status).toBe(401);
  });
});
