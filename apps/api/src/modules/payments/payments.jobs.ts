import { Injectable } from '@nestjs/common';
import { OnDomainEvent, Scheduled, type OutboxEvent } from '../../common/events/events';
import { CheckoutService } from './checkout.service';

/**
 * Worker-side reactions for ResutoPay. Kept apart from CheckoutService because
 * that class is also bound to CHECKOUT_PORT (useExisting), and provider
 * discovery would otherwise register its handlers twice.
 */
@Injectable()
export class PaymentsJobs {
  constructor(private readonly checkout: CheckoutService) {}

  @Scheduled('payments.expire_checkouts', 60)
  expireCheckouts() {
    return this.checkout.expireDue();
  }

  @OnDomainEvent('payments.reservation_cancelled', 'reservation.cancelled')
  reservationCancelled(event: OutboxEvent) {
    return this.checkout.onReservationCancelled(event);
  }
}
