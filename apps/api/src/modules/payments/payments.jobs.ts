import { Injectable } from '@nestjs/common';
import { TenantContext } from '../../common/auth/context';
import { DbService } from '../../common/db/db.service';
import { OnDomainEvent, Scheduled, type OutboxEvent } from '../../common/events/events';
import { CheckoutService } from './checkout.service';
import { StaffPaymentsService } from './staff-payments.service';

/**
 * Worker-side reactions for ResutoPay. Kept apart from CheckoutService because
 * that class is also bound to CHECKOUT_PORT (useExisting), and provider
 * discovery would otherwise register its handlers twice.
 */
@Injectable()
export class PaymentsJobs {
  constructor(private readonly checkout: CheckoutService, private readonly staff: StaffPaymentsService, private readonly db: DbService) {}

  @Scheduled('payments.expire_checkouts', 60)
  expireCheckouts() {
    return this.checkout.expireDue();
  }

  @OnDomainEvent('payments.reservation_cancelled', 'reservation.cancelled')
  reservationCancelled(event: OutboxEvent) {
    return this.checkout.onReservationCancelled(event);
  }

  /** Unused reservation-deposit credit is owed back to the guest when the visit closes (legacy behaviour). */
  @OnDomainEvent('payments.refund_unused_deposit', 'visit.closed')
  async refundUnusedDeposit(event: OutboxEvent) {
    const amount = Number(event.payload.unusedCreditMinor ?? 0);
    if (event.orgId && event.payload.reservationId && amount > 0) {
      await this.refundDeposit(event, event.payload.reservationId, amount, 'Unused reservation deposit');
    }
  }

  /** A cancelled reservation with a paid deposit is refunded (no-shows forfeit, and publish depositPaidMinor 0). */
  @OnDomainEvent('payments.refund_cancelled_deposit', 'reservation.cancelled')
  async refundCancelledDeposit(event: OutboxEvent) {
    const amount = Number(event.payload.depositPaidMinor ?? 0);
    if (event.orgId && amount > 0) await this.refundDeposit(event, event.aggregateId, amount, 'Reservation cancelled');
  }

  /**
   * Refunds against the original deposit payment through the normal refund flow
   * (provider refund, or a manual_required refund with instructions). The event id
   * is the idempotency key, so redelivered events never refund twice.
   */
  private async refundDeposit(event: OutboxEvent, reservationId: string, amountMinor: number, reason: string) {
    const orgId = event.orgId!;
    const deposit = await this.db.withTenant(orgId, (tx) => tx.maybeOne<{ id: string; refundable: number }>(
      `select id, (amount_minor - refunded_minor)::bigint as refundable from payments
        where reservation_id = $1 and order_id is null and visit_id is null and status in ('succeeded', 'partially_refunded')
        order by created_at desc limit 1`, [reservationId]), 'payments:deposits');
    if (!deposit || Number(deposit.refundable) <= 0) return;
    const ctx = TenantContext.system(orgId, 'payments:deposit-refund', 'worker');
    const refund = await this.staff.refund(ctx, deposit.id, {
      amountMinor: Math.min(amountMinor, Number(deposit.refundable)), reason, key: `deposit-refund:${event.id}`,
    });
    if (refund?.status === 'succeeded' && Math.min(amountMinor, Number(deposit.refundable)) >= Number(deposit.refundable)) {
      await this.db.withTenant(orgId, (tx) => tx.query(
        `update reservations set deposit_status = 'refunded' where id = $1 and deposit_status in ('paid', 'applied')`, [reservationId]), 'payments:deposits');
    }
  }
}
