import { Injectable } from '@nestjs/common';
import { DbService } from '../../common/db/db.service';
import { EntitlementsService } from '../../common/entitlements/entitlements.service';
import { OnDomainEvent, Scheduled, type OutboxEvent } from '../../common/events/events';
import { LoyaltyService } from './loyalty.service';

/** Worker reactions for loyalty (FT-03). Every step is idempotent (ledger idempotency keys). */
@Injectable()
export class LoyaltyHandlers {
  constructor(private readonly db: DbService, private readonly loyalty: LoyaltyService, private readonly entitlements: EntitlementsService) {}

  /** Earn on PAID orders only: order.paid is published once the order is fully paid. */
  @OnDomainEvent('loyalty.earn', 'order.paid')
  async onOrderPaid(e: OutboxEvent) {
    if (!e.orgId || !(await this.entitlements.isEnabled(e.orgId, 'marketing'))) return;
    await this.db.withTenant(e.orgId, (tx) => this.loyalty.earnForOrder(tx, e.orgId!, e.aggregateId), 'system:loyalty');
  }

  /** Refunds take earned points back in proportion; a full refund also returns redeemed points. */
  @OnDomainEvent('loyalty.refund', 'payment.refunded')
  async onRefund(e: OutboxEvent) {
    if (!e.orgId) return;
    await this.db.withTenant(e.orgId, async (tx) => {
      for (const { order_id } of await this.loyalty.ordersOfPayment(tx, e.aggregateId)) {
        await this.loyalty.reconcileOrder(tx, e.orgId!, order_id, e.aggregateId);
      }
    }, 'system:loyalty');
  }

  /** Cancellation reverses everything earned and returns redeemed points. */
  @OnDomainEvent('loyalty.cancel', 'order.cancelled')
  async onCancelled(e: OutboxEvent) {
    if (!e.orgId) return;
    await this.db.withTenant(e.orgId, (tx) => this.loyalty.reconcileOrder(tx, e.orgId!, e.aggregateId), 'system:loyalty');
  }

  /** Daily expiry of unused points for programmes with an expiry period. */
  @Scheduled('loyalty.expiry', 6 * 3600)
  async expire() {
    const orgs = await this.db.withPlatform((tx) => tx.query<{ org_id: string }>(
      `select distinct org_id from loyalty_ledger where kind = 'earn' and expires_at is not null and expires_at <= now() limit 1000`), 'system:loyalty');
    let expired = 0;
    for (const { org_id } of orgs) expired += await this.db.withTenant(org_id, (tx) => this.loyalty.expireDue(tx, org_id), 'system:loyalty');
    return { orgs: orgs.length, expired };
  }
}
