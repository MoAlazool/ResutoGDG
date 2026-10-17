import { Injectable } from '@nestjs/common';
import { TenantContext } from '../../common/auth/context';
import { DbService } from '../../common/db/db.service';
import { EntitlementsService } from '../../common/entitlements/entitlements.service';
import { OnDomainEvent, Scheduled, type OutboxEvent } from '../../common/events/events';
import { DeliveryService } from './delivery.service';

/** Order states in which a delivery order should have a job (prepaid orders wait for payment). */
const JOB_STATES = ['placed', 'accepted', 'preparing', 'ready'];

/** Worker-side reactions for ResutoDriver. Handlers are idempotent (re-delivery safe). */
@Injectable()
export class DeliveryHandlers {
  constructor(private readonly db: DbService, private readonly delivery: DeliveryService, private readonly entitlements: EntitlementsService) {}

  /** A delivery order that is placed (or released after payment / accepted) gets exactly one job. */
  @OnDomainEvent('delivery.create_job', 'order.placed', 'order.status_changed')
  async createJob(e: OutboxEvent) {
    if (!e.orgId || e.payload?.fulfillment !== 'delivery') return;
    const status = e.type === 'order.placed' ? e.payload.status : e.payload.to;
    if (!JOB_STATES.includes(status)) return;
    if (!(await this.entitlements.isEnabled(e.orgId, 'driver'))) return;
    const ctx = TenantContext.system(e.orgId, 'delivery');
    await this.db.withTenant(e.orgId, (tx) => this.delivery.createJobForOrder(tx, ctx, e.aggregateId), 'system:delivery');
  }

  /** Cancelling the order cancels its open delivery job (on-road jobs are marked failed first). */
  @OnDomainEvent('delivery.cancel_job', 'order.cancelled')
  async cancelJob(e: OutboxEvent) {
    if (!e.orgId || e.payload?.fulfillment !== 'delivery') return;
    const ctx = TenantContext.system(e.orgId, 'delivery');
    await this.db.withTenant(e.orgId, async (tx) => {
      const job = await tx.maybeOne<any>('select * from delivery_jobs where order_id = $1 for update', [e.aggregateId]);
      if (!job || ['cancelled', 'delivered'].includes(job.status)) return;
      await this.delivery.cancelLocked(tx, ctx, job, 'order_cancelled');
    }, 'system:delivery');
  }

  @Scheduled('delivery.expire_offers', 30)
  expireOffers() {
    return this.delivery.expireOffers();
  }
}
