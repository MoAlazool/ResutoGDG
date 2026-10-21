// Cross-module integration (lead): reservation deposits (B1) settled by the
// ledger are refunded by ResutoPay (D1) when unused at visit close or when the
// reservation is cancelled. No-shows forfeit the deposit.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TenantContext } from '../src/common/auth/context';
import { DbService } from '../src/common/db/db.service';
import { EventDispatcher } from '../src/common/events/dispatcher.service';
import { PaymentLedgerService } from '../src/modules/kernel/payment-ledger.service';
import { auth, bootTestApp, createTenant, seedMenu, sql, type SeededMenu, type TestApp, type TestTenant } from './helpers';

let t: TestApp;
let tenant: TestTenant;
let menu: SeededMenu;
let db: DbService;
let ledger: PaymentLedgerService;
let dispatcher: EventDispatcher;

beforeAll(async () => {
  t = await bootTestApp();
  tenant = await createTenant(t);
  menu = await seedMenu(tenant);
  db = t.app.get(DbService);
  ledger = t.app.get(PaymentLedgerService);
  dispatcher = t.app.get(EventDispatcher);
  await sql(`update outbox_events set published_at = now() where published_at is null`);
});
afterAll(async () => { await t.close(); });

/** A confirmed reservation whose 20000 deposit was paid in cash at the desk. */
async function paidReservation(minutesFromNow: number) {
  const starts = new Date(Date.now() + minutesFromNow * 60_000);
  const [r] = await sql(
    `insert into reservations(org_id, branch_id, table_id, guest_name, party_size, starts_at, ends_at, blocked_until, status, deposit_minor, deposit_status)
     values ($1, $2, $3, 'Deposit guest', 2, $4, $4::timestamptz + interval '90 minutes', $4::timestamptz + interval '105 minutes', 'pending_deposit', 20000, 'required')
     returning id`, [tenant.orgId, tenant.branchId, menu.tableId, starts]);
  const ctx = TenantContext.system(tenant.orgId);
  await db.withTenant(tenant.orgId, (tx) => ledger.recordSucceeded(tx, ctx, {
    branchId: tenant.branchId, reservationId: r.id, method: 'cash', provider: 'manual', amountMinor: 20000, currency: 'EGP',
    idempotencyKey: `deposit-${r.id}`,
  }));
  return r.id as string;
}

const refundsFor = (reservationId: string) => sql(
  `select f.amount_minor, f.status, f.instructions is not null as has_instructions from refunds f join payments p on p.id = f.payment_id
    where p.reservation_id = $1 order by f.created_at`, [reservationId]);

describe('reservation deposit refunds', () => {
  it('refunds unused deposit credit when the seated visit closes, once', async () => {
    const reservationId = await paidReservation(5);
    const checkIn = await t.http.post(`/v1/o/${tenant.orgId}/reservations/${reservationId}/check-in`).set(auth(tenant.owner)).send({});
    expect(checkIn.status).toBe(200);
    const visitId = checkIn.body.visitId;
    // 2 × fries = 9000 consumed from the 20000 credit; 11000 is owed back.
    const order = await t.http.post(`/v1/o/${tenant.orgId}/orders`).set(auth(tenant.owner)).set('Idempotency-Key', `ord-${visitId}`)
      .send({ branchId: tenant.branchId, fulfillment: 'dine_in', tableId: menu.tableId, lines: [{ productId: menu.products.fries, quantity: 2 }] });
    expect(order.status).toBe(201);
    const orderId = order.body.id ?? order.body.order?.id;
    for (const to of ['accepted', 'preparing', 'ready', 'served']) {
      expect((await t.http.post(`/v1/o/${tenant.orgId}/orders/${orderId}/transition`).set(auth(tenant.owner)).send({ to })).status).toBeLessThan(300);
    }
    const close = await t.http.post(`/v1/o/${tenant.orgId}/visits/${visitId}/close`).set(auth(tenant.owner)).send({});
    expect(close.body).toMatchObject({ ok: true, unusedCreditMinor: 11000 });
    await dispatcher.drain();
    // Cash deposits are refunded manually, with instructions for the cashier.
    expect(await refundsFor(reservationId)).toEqual([{ amount_minor: 11000, status: 'manual_required', has_instructions: true }]);
    // Redelivery of the same event does not create a second refund.
    await sql(`update outbox_events set published_at = null, available_at = now() where aggregate_id = $1 and event_type = 'visit.closed'`, [visitId]);
    await sql(`delete from event_handlings where handler = 'payments.refund_unused_deposit'`);
    await dispatcher.drain();
    expect(await refundsFor(reservationId)).toHaveLength(1);
  });

  it('refunds the full deposit when a reservation is cancelled, but not on a no-show', async () => {
    const cancelled = await paidReservation(24 * 60);
    expect((await t.http.post(`/v1/o/${tenant.orgId}/reservations/${cancelled}/cancel`).set(auth(tenant.owner)).send({ reason: 'Guest called' })).body.status).toBe('cancelled');
    const noShow = await paidReservation(26 * 60);
    await sql(`update reservations set starts_at = now() - interval '2 hours', ends_at = now() - interval '30 minutes', blocked_until = now() - interval '15 minutes' where id = $1`, [noShow]);
    expect((await t.http.post(`/v1/o/${tenant.orgId}/reservations/${noShow}/no-show`).set(auth(tenant.owner)).send({})).status).toBeLessThan(300);
    await dispatcher.drain();
    expect(await refundsFor(cancelled)).toEqual([{ amount_minor: 20000, status: 'manual_required', has_instructions: true }]);
    expect(await refundsFor(noShow)).toEqual([]);
    const [r] = await sql(`select deposit_status from reservations where id = $1`, [noShow]);
    expect(r.deposit_status).toBe('forfeited');
  });
});
