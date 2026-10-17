import 'reflect-metadata';
import { Global, Injectable, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { TenantContext } from '../src/common/auth/context';
import { newToken, sha256 } from '../src/common/crypto/hash';
import { DbService, type Tx } from '../src/common/db/db.service';
import { PaymentLedgerService } from '../src/modules/kernel/payment-ledger.service';
import { CHECKOUT_PORT, type CheckoutPort, type CheckoutSessionRequest } from '../src/modules/kernel/ports';
import { ReservationsService } from '../src/modules/reservations/reservations.service';
import { addMember, auth, createTenant, seedMenu, sql, type SeededMenu, type TestApp, type TestTenant, type TestUser } from './helpers';
import { key, qrTokenFor, saveFloor, table } from './ops-fixtures';

/**
 * Stand-in for ResutoPay's CheckoutService (Agent D1) so the deposit hand-off can
 * be exercised end to end: it records a checkout session like D1 does, and the
 * test settles it through the real PaymentLedgerService (as D1's verified webhook would).
 */
@Injectable()
class TestCheckout implements CheckoutPort {
  calls: CheckoutSessionRequest[] = [];
  async createSession(tx: Tx, ctx: TenantContext, input: CheckoutSessionRequest) {
    this.calls.push(input);
    const r = await tx.one<any>('select branch_id, deposit_minor from reservations where id = $1', [input.reservationId]);
    const token = newToken();
    const row = await tx.one<{ id: string; expires_at: Date }>(
      `insert into checkout_sessions(org_id, branch_id, token_hash, purpose, reservation_id, amount_minor, currency, channel, expires_at)
       values ($1, $2, $3, $4, $5, $6, 'EGP', $7, now() + interval '15 minutes') returning id, expires_at`,
      [ctx.orgId, r.branch_id, sha256(token), input.purpose, input.reservationId, input.amountMinor ?? r.deposit_minor, input.channel]);
    return { id: row.id, token, url: `http://app.test/pay/${token}`, amountMinor: input.amountMinor ?? r.deposit_minor, currency: 'EGP', expiresAt: row.expires_at.toISOString() };
  }
}

@Global()
@Module({ providers: [TestCheckout, { provide: CHECKOUT_PORT, useExisting: TestCheckout }], exports: [CHECKOUT_PORT, TestCheckout] })
class TestCheckoutModule {}

@Module({ imports: [AppModule, TestCheckoutModule] })
class TestRoot {}

let t: TestApp;
let tenant: TestTenant;
let menu: SeededMenu;
let host: TestUser;
let waiter: TestUser;
let tables: Record<string, string>;

beforeAll(async () => {
  const app = await NestFactory.create(TestRoot, { logger: ['error'] });
  app.setGlobalPrefix('v1');
  app.getHttpAdapter().getInstance().set('trust proxy', 1);
  await app.init();
  t = { app, http: request(app.getHttpServer()), close: () => app.close() };
  tenant = await createTenant(t, { country: 'EG' });
  menu = await seedMenu(tenant);
  host = await addMember(t, tenant, 'host', [tenant.branchId]);
  waiter = await addMember(t, tenant, 'waiter', [tenant.branchId]);
  const f = await saveFloor(t, tenant, [
    table('R2', 200, 200, { capacity: 2, features: ['Window side', 'Quiet area'] }),
    table('R4', 400, 200, { capacity: 4 }),
    table('R6', 600, 200, { capacity: 6, premium: true }),
    table('Bar', 800, 200, { capacity: 2, reservable: false }),
  ]);
  tables = Object.fromEntries(f.tables.map((x: any) => [x.label, x.id]));
});
afterAll(async () => { await t.close(); });

/** Local (Africa/Cairo) date and HH:MM for now + minutes, rounded down to the minute. */
function cairo(minutesFromNow: number) {
  const d = new Date(Date.now() + minutesFromNow * 60_000);
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Cairo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(d).map((p) => [p.type, p.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
}
const future = (days: number, time: string) => ({ date: cairo(days * 1440).date, time });

const holdBody = (extra: Record<string, unknown> = {}) => ({
  branchId: tenant.branchId, partySize: 2, guestName: 'Nour', guestPhone: `+2010${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`, key: key('hold'), ...future(3, '19:00'), ...extra,
});
const hold = (body: Record<string, unknown>) => t.http.post(`/v1/public/reservations/${tenant.slug}/holds`).send(body);
const manage = (token: string) => ({ 'X-Reservation-Token': token });

describe('availability search', () => {
  it('ranks candidate tables by capacity, reservable flag, features and bookings', async () => {
    const q = future(3, '20:00');
    const res = await t.http.get(`/v1/public/reservations/${tenant.slug}/availability?branch=main-branch&date=${q.date}&time=${q.time}&partySize=3`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ open: true, depositMinor: 0, currency: 'EGP' });
    const byLabel = Object.fromEntries(res.body.tables.map((x: any) => [x.label, x]));
    expect(byLabel.R2).toMatchObject({ available: false, reason: 'too_small' });
    expect(byLabel.Bar).toMatchObject({ available: false, reason: 'not_reservable' });
    expect(byLabel.R4.available).toBe(true);
    const withFeatures = await t.http.get(`/v1/public/reservations/${tenant.slug}/availability?date=${q.date}&time=${q.time}&partySize=2&features=${encodeURIComponent('Window side')}`);
    const r2 = withFeatures.body.tables.find((x: any) => x.label === 'R2');
    expect(r2).toMatchObject({ available: true, matchesFeatures: true });
    expect(withFeatures.body.tables.find((x: any) => x.label === 'R4')).toMatchObject({ available: false, reason: 'missing_features' });
    const bad = await t.http.get(`/v1/public/reservations/${tenant.slug}/availability?date=${q.date}&time=25:00&partySize=2`);
    expect(bad.status).toBe(400);
  });

  it('respects opening hours and the 180-day horizon', async () => {
    await sql(`update branches set opening_hours = $2 where id = $1`, [tenant.branchId, JSON.stringify([0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, opens: '12:00', closes: '23:30' })))]);
    const q = future(4, '10:00');
    const closed = await t.http.get(`/v1/public/reservations/${tenant.slug}/availability?date=${q.date}&time=${q.time}&partySize=2`);
    expect(closed.body).toMatchObject({ open: false, closedReason: 'outside_opening_hours' });
    expect(closed.body.tables.every((x: any) => !x.available)).toBe(true);
    const late = await hold(holdBody({ ...future(4, '23:00') }));
    expect(late.status).toBe(409);
    expect(late.body.error.code).toBe('outside_opening_hours');
    const far = await hold(holdBody({ ...future(200, '19:00') }));
    expect(far.body.error.code).toBe('too_far_ahead');
    await sql(`update branches set opening_hours = '[]' where id = $1`, [tenant.branchId]);
  });
});

describe('holds, overlap and expiry', () => {
  it('holds for 5 minutes, blocks overlaps (including racing requests) and is idempotent', async () => {
    const body = holdBody({ tableId: tables.R4, ...future(5, '19:00') });
    const a = await hold(body);
    expect(a.status).toBe(201);
    expect(a.body.reservation).toMatchObject({ status: 'held', tableId: tables.R4, tableLabel: 'R4', partySize: 2, depositStatus: 'none' });
    expect(a.body.manageToken).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    const holdMs = new Date(a.body.reservation.holdExpiresAt).getTime() - Date.now();
    expect(holdMs).toBeGreaterThan(4 * 60_000);
    expect(holdMs).toBeLessThanOrEqual(5 * 60_000 + 1000);
    const replay = await hold(body);
    expect(replay.body).toEqual(a.body);

    // 90 min + 15 min buffer: 20:30 overlaps the 19:00 booking's buffer (until 20:45).
    const overlap = await hold(holdBody({ tableId: tables.R4, ...future(5, '20:30') }));
    expect(overlap.status).toBe(409);
    expect(overlap.body.error).toMatchObject({ code: 'table_unavailable', details: { reason: 'booked' } });
    expect((await hold(holdBody({ tableId: tables.R4, ...future(5, '20:45') }))).status).toBe(201);

    // Two guests racing for the same table: the exclusion constraint lets exactly one win.
    const race = await Promise.all([1, 2].map(() => hold(holdBody({ tableId: tables.R6, ...future(6, '19:00'), key: key('race') }))));
    expect(race.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(race.find((r) => r.status === 409)!.body.error.code).toBe('table_unavailable');
  });

  it('expires stale holds (job) and frees the table', async () => {
    const svc = t.app.get(ReservationsService);
    const a = await hold(holdBody({ tableId: tables.R2, ...future(7, '19:00') }));
    expect((await hold(holdBody({ tableId: tables.R2, ...future(7, '19:30') }))).status).toBe(409);
    await sql(`update reservations set hold_expires_at = now() - interval '1 minute' where id = $1`, [a.body.reservation.id]);
    const r = await svc.expireHolds();
    expect(r.expired).toBeGreaterThanOrEqual(1);
    const [row] = await sql('select status from reservations where id = $1', [a.body.reservation.id]);
    expect(row.status).toBe('expired');
    expect((await hold(holdBody({ tableId: tables.R2, ...future(7, '19:30') }))).status).toBe(201);
    const confirm = await t.http.post('/v1/public/reservations/manage/confirm').set(manage(a.body.manageToken)).send({ key: key() });
    expect(confirm.status).toBe(409);
    expect(confirm.body.error.code).toBe('hold_expired');
    const events = await sql(`select event_type, payload from outbox_events where aggregate_id = $1 order by created_at`, [a.body.reservation.id]);
    expect(events.map((e) => e.event_type)).toEqual(['reservation.created', 'reservation.cancelled']);
  });

  it('confirms without a deposit and lets the guest view and cancel via the manage link', async () => {
    const a = await hold(holdBody({ ...future(8, '13:00') }));
    const c = await t.http.post('/v1/public/reservations/manage/confirm').set(manage(a.body.manageToken)).send({ key: key() });
    expect(c.status).toBe(200);
    expect(c.body).toMatchObject({ reservation: { status: 'confirmed', holdExpiresAt: null }, checkout: null });
    const view = await t.http.get('/v1/public/reservations/manage').set(manage(a.body.manageToken));
    expect(view.body).toMatchObject({ cancellable: true, reservation: { code: a.body.reservation.code, guestPhone: null }, org: { slug: tenant.slug } });
    const cancel = await t.http.post('/v1/public/reservations/manage/cancel').set(manage(a.body.manageToken)).send({});
    expect(cancel.body).toMatchObject({ ok: true, status: 'cancelled', refundRequired: null });
    expect((await t.http.get('/v1/public/reservations/manage').set(manage('x'.repeat(43)))).status).toBe(404);
    expect((await t.http.get('/v1/public/reservations/manage')).status).toBe(401);
  });
});

describe('deposits and check-in', () => {
  it('requires a deposit via ResutoPay, then seats the party and moves the deposit to visit credit', async () => {
    await sql(`update branches set reservation_deposit_minor = 20000 where id = $1`, [tenant.branchId]);
    const soon = cairo(10);
    const a = await hold(holdBody({ tableId: tables.R4, partySize: 3, date: soon.date, time: soon.time }));
    expect(a.status).toBe(201);
    expect(a.body.reservation).toMatchObject({ depositMinor: 20000, depositStatus: 'required' });
    const c = await t.http.post('/v1/public/reservations/manage/confirm').set(manage(a.body.manageToken)).send({ key: key(), returnUrl: 'http://app.test/reserve/done' });
    expect(c.status).toBe(200);
    expect(c.body.reservation.status).toBe('pending_deposit');
    expect(c.body.checkout).toMatchObject({ amountMinor: 20000 });
    expect(c.body.checkout.url).toMatch(/^http:\/\/app\.test\/pay\//);
    const checkout = t.app.get(TestCheckout);
    expect(checkout.calls.at(-1)).toMatchObject({ purpose: 'reservation_deposit', reservationId: a.body.reservation.id, amountMinor: 20000 });

    // Pending deposit cannot be checked in.
    const early = await t.http.post(`/v1/o/${tenant.orgId}/reservations/${a.body.reservation.id}/check-in`).set(auth(host)).send({});
    expect(early.body.error.code).toBe('not_confirmed');

    // D1's verified webhook settles the deposit through the ledger → reservation confirmed.
    const db = t.app.get(DbService);
    const ledger = t.app.get(PaymentLedgerService);
    const sys = TenantContext.system(tenant.orgId);
    await db.withTenant(tenant.orgId, async (tx) => {
      const p = await ledger.createPending(tx, sys, { branchId: tenant.branchId, reservationId: a.body.reservation.id, method: 'card', provider: 'simulated', amountMinor: 20000, currency: 'EGP', isTest: true });
      await ledger.confirm(tx, sys, p.id, { amountMinor: 20000, currency: 'EGP' });
    });
    const [paid] = await sql('select status, deposit_status from reservations where id = $1', [a.body.reservation.id]);
    expect(paid).toEqual({ status: 'confirmed', deposit_status: 'paid' });

    const checkIn = await t.http.post(`/v1/o/${tenant.orgId}/reservations/${a.body.reservation.id}/check-in`).set(auth(host)).send({});
    expect(checkIn.status).toBe(201);
    expect(checkIn.body).toMatchObject({ tableId: tables.R4, creditMinor: 20000 });
    const [res] = await sql('select status, deposit_status, seated_visit_id from reservations where id = $1', [a.body.reservation.id]);
    expect(res).toEqual({ status: 'seated', deposit_status: 'applied', seated_visit_id: checkIn.body.visitId });

    // A guest scanning the table joins the seated visit and sees the credit on the bill.
    const qr = await qrTokenFor(t, tenant, tables.R4!);
    const s = await t.http.post(`/v1/public/tables/${qr}/session`);
    expect(s.body).toMatchObject({ visitId: checkIn.body.visitId, opened: false });
    await t.http.post('/v1/public/visits/current/orders').set({ 'X-Visit-Token': s.body.token }).set('Idempotency-Key', key())
      .send({ lines: [{ productId: menu.products.fries, quantity: 2 }] });
    const bill = await t.http.get('/v1/public/visits/current').set({ 'X-Visit-Token': s.body.token });
    expect(bill.body.totals).toEqual({ totalMinor: 9000, paidMinor: 0, creditMinor: 20000, dueMinor: 0 });

    // Closing applies the credit through the ledger and reports the unused part as a refund for ResutoPay.
    const order = (await sql('select id from orders where visit_id = $1', [checkIn.body.visitId]))[0];
    for (const to of ['accepted', 'preparing', 'ready', 'served']) await t.http.post(`/v1/o/${tenant.orgId}/orders/${order.id}/transition`).set(auth(waiter)).send({ to });
    const close = await t.http.post(`/v1/o/${tenant.orgId}/visits/${checkIn.body.visitId}/close`).set(auth(host)).send({});
    expect(close.status).toBe(201);
    expect(close.body).toMatchObject({ unusedCreditMinor: 11000, dueMinor: 0 });
    const [credit] = await sql(`select method, amount_minor from payments where visit_id = $1`, [checkIn.body.visitId]);
    expect(credit).toEqual({ method: 'deposit_credit', amount_minor: 9000 });
    const [done] = await sql('select status, deposit_credit_used_minor from reservations where id = $1', [a.body.reservation.id]);
    expect(done).toEqual({ status: 'completed', deposit_credit_used_minor: 9000 });
    const [evt] = await sql(`select payload from outbox_events where aggregate_id = $1 and event_type = 'visit.closed'`, [checkIn.body.visitId]);
    expect(evt.payload).toMatchObject({ unusedCreditMinor: 11000, reservationId: a.body.reservation.id });
    await sql(`update branches set reservation_deposit_minor = 0 where id = $1`, [tenant.branchId]);
  });

  it('enforces the −15/+30 minute check-in window and the staff day book', async () => {
    const later = await t.http.post(`/v1/o/${tenant.orgId}/reservations`).set(auth(host)).set('Idempotency-Key', key())
      .send({ branchId: tenant.branchId, ...future(0, '23:59'), partySize: 2, guestName: 'Late guest', guestPhone: '+201009990001' });
    // Today 23:59 may already be in the past right around midnight; book tomorrow instead in that case.
    const created = later.status === 201 ? later : await t.http.post(`/v1/o/${tenant.orgId}/reservations`).set(auth(host)).set('Idempotency-Key', key())
      .send({ branchId: tenant.branchId, ...future(1, '23:00'), partySize: 2, guestName: 'Late guest', guestPhone: '+201009990001' });
    expect(created.status).toBe(201);
    expect(created.body.reservation).toMatchObject({ status: 'confirmed', source: 'staff' });
    const id = created.body.reservation.id;
    await sql(`update reservations set starts_at = now() + interval '3 hours', ends_at = now() + interval '270 minutes', blocked_until = now() + interval '285 minutes' where id = $1`, [id]);
    const tooEarly = await t.http.post(`/v1/o/${tenant.orgId}/reservations/${id}/check-in`).set(auth(host)).send({});
    expect(tooEarly.status).toBe(409);
    expect(tooEarly.body.error.code).toBe('outside_check_in_window');
    await sql(`update reservations set starts_at = now() - interval '45 minutes', ends_at = now() + interval '45 minutes', blocked_until = now() + interval '60 minutes' where id = $1`, [id]);
    expect((await t.http.post(`/v1/o/${tenant.orgId}/reservations/${id}/check-in`).set(auth(host)).send({})).body.error.code).toBe('outside_check_in_window');

    // Past start: no-show is allowed (and only for confirmed bookings).
    const ns = await t.http.post(`/v1/o/${tenant.orgId}/reservations/${id}/no-show`).set(auth(host));
    expect(ns.body).toMatchObject({ status: 'no_show' });
    expect((await t.http.post(`/v1/o/${tenant.orgId}/reservations/${id}/no-show`).set(auth(host))).status).toBe(409);

    const day = cairo(5 * 1440).date;
    const list = await t.http.get(`/v1/o/${tenant.orgId}/reservations?date=${day}&branchId=${tenant.branchId}`).set(auth(waiter));
    expect(list.status).toBe(200);
    expect(list.body.items.length).toBeGreaterThan(0);
    expect(list.body.items.every((r: any) => r.startsAt.length > 0)).toBe(true);
    // Waiters can read the book but not write it.
    expect((await t.http.post(`/v1/o/${tenant.orgId}/reservations`).set(auth(waiter)).set('Idempotency-Key', key())
      .send({ branchId: tenant.branchId, ...future(9, '19:00'), partySize: 2, guestName: 'X' })).status).toBe(403);
    const other = await createTenant(t);
    expect((await t.http.get(`/v1/o/${tenant.orgId}/reservations?date=${day}`).set(auth(other.owner))).status).toBe(404);
    expect((await t.http.get(`/v1/o/${other.orgId}/reservations/${id}`).set(auth(other.owner))).status).toBe(404);
  });

  it('staff can move a booking; overlapping edits are refused', async () => {
    const a = await t.http.post(`/v1/o/${tenant.orgId}/reservations`).set(auth(host)).set('Idempotency-Key', key())
      .send({ branchId: tenant.branchId, tableId: tables.R6, ...future(10, '19:00'), partySize: 4, guestName: 'Group A' });
    const b = await t.http.post(`/v1/o/${tenant.orgId}/reservations`).set(auth(host)).set('Idempotency-Key', key())
      .send({ branchId: tenant.branchId, tableId: tables.R6, ...future(10, '21:00'), partySize: 4, guestName: 'Group B' });
    expect(b.status).toBe(201);
    const clash = await t.http.patch(`/v1/o/${tenant.orgId}/reservations/${b.body.reservation.id}`).set(auth(host)).send({ time: '20:00' });
    expect(clash.status).toBe(409);
    const moved = await t.http.patch(`/v1/o/${tenant.orgId}/reservations/${b.body.reservation.id}`).set(auth(host)).send({ time: '21:30', partySize: 5 });
    expect(moved.status).toBe(200);
    expect(moved.body).toMatchObject({ partySize: 5, tableId: tables.R6 });
    const cancel = await t.http.post(`/v1/o/${tenant.orgId}/reservations/${a.body.reservation.id}/cancel`).set(auth(host)).send({ reason: 'Called to cancel' });
    expect(cancel.body.status).toBe('cancelled');
    const audit = await sql(`select action from audit_logs where entity_id = $1 order by id`, [a.body.reservation.id]);
    expect(audit.map((x) => x.action)).toEqual(['reservation.created', 'reservation.cancelled']);
  });

  it('QR scan inside the check-in window seats a confirmed reservation automatically', async () => {
    const soon = cairo(5);
    const a = await hold(holdBody({ tableId: tables.R2, date: soon.date, time: soon.time }));
    expect(a.status).toBe(201);
    await t.http.post('/v1/public/reservations/manage/confirm').set(manage(a.body.manageToken)).send({ key: key() });
    const qr = await qrTokenFor(t, tenant, tables.R2!);
    const s = await t.http.post(`/v1/public/tables/${qr}/session`);
    expect(s.status).toBe(200);
    const [r] = await sql('select status, seated_visit_id from reservations where id = $1', [a.body.reservation.id]);
    expect(r).toEqual({ status: 'seated', seated_visit_id: s.body.visitId });
  });
});
