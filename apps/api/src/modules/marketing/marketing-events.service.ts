import { Injectable } from '@nestjs/common';
import { DbService } from '../../common/db/db.service';
import { OnDomainEvent, type OutboxEvent } from '../../common/events/events';

/** Attribution: verified payment of a campaign-attributed order (once per order). */
@Injectable()
export class MarketingEventsService {
  constructor(private readonly db: DbService) {}

  @OnDomainEvent('marketing.attribution-order-paid', 'order.paid')
  async orderPaid(e: OutboxEvent) {
    if (!e.orgId) return;
    return this.db.withTenant(e.orgId, async (tx) => {
      const o = await tx.maybeOne<{ campaign_id: string | null; customer_id: string | null; total_minor: number; attribution: Record<string, unknown> }>(
        `select campaign_id, customer_id, total_minor, attribution from orders where id = $1`, [e.aggregateId]);
      if (!o?.campaign_id) return { skipped: 'not_attributed' };
      const done = await tx.maybeOne(`select 1 from attribution_events where order_id = $1 and kind = 'order_paid'`, [e.aggregateId]);
      if (done) return { skipped: 'already_recorded' };
      await tx.query(`insert into attribution_events(org_id, kind, campaign_id, customer_id, order_id, session_key, utm, value_minor)
                      values ($1, 'order_paid', $2, $3, $4, $5, $6, $7)`,
        [e.orgId, o.campaign_id, o.customer_id, e.aggregateId, (o.attribution?.session_key as string) ?? null, o.attribution ?? {}, o.total_minor]);
      return { recorded: true };
    }, 'marketing.attribution');
  }
}
