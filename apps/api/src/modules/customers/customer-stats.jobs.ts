import { Injectable, Logger } from '@nestjs/common';
import { DbService } from '../../common/db/db.service';
import { Scheduled } from '../../common/events/events';

/**
 * Daily drift check of the customer read models (customer_stats / customer_branch_stats, PCL-17). Triggers on orders
 * keep them exact in the same transaction; this job recomputes every customer whose orders changed in the last 26
 * hours, repairs any row that does not match the orders, and reports the count. A non-zero drift means orders were
 * changed without the trigger (bulk load with triggers off, manual SQL) and is logged as a warning.
 */
@Injectable()
export class CustomerStatsJobs {
  private readonly logger = new Logger('CustomerStats');

  constructor(private readonly db: DbService) {}

  @Scheduled('customers.stats-reconcile', 24 * 3600, { timeoutMs: 10 * 60_000 })
  async reconcile() {
    const { drift, missing } = await this.db.withPlatform(async (tx) => {
      // Customers created while the trigger was bypassed have no organization-wide row: the list would hide them.
      const added = await tx.query(
        `insert into customer_stats (customer_id, org_id) select c.id, c.org_id from customers c
          where not exists (select 1 from customer_stats s where s.customer_id = c.id) on conflict do nothing returning customer_id`);
      const fixed = await tx.one<{ n: number }>(`select app.reconcile_customer_stats(now() - interval '26 hours') as n`);
      return { drift: fixed.n, missing: added.length };
    }, 'customers.stats-reconcile');
    if (drift || missing) this.logger.warn(`customer stats drift repaired: ${drift} (customer, branch) rows, ${missing} missing customer rows`);
    return { drift, missing };
  }
}
