import { Injectable, Logger } from '@nestjs/common';
import { DbService } from '../../common/db/db.service';
import { Scheduled } from '../../common/events/events';

/** Days recomputed per run; a backlog (first deploy without the migration backfill, a timezone change) drains over runs. */
const DAYS_PER_RUN = 200;

/**
 * Maintains the analytics daily rollups (PCL-26; freshness policy in docs/CACHE_POLICY.md and the migration
 * 20261020080003). Reports are always exact: a day is served from its rollup only while it is not stale, otherwise
 * live. These jobs only decide how soon a day is fast again.
 */
@Injectable()
export class AnalyticsRollupJobs {
  private readonly logger = new Logger('AnalyticsRollups');

  constructor(private readonly db: DbService) {}

  /**
   * Every minute: adds rows for days that just left the live window (orders of the last 10 days), then recomputes stale
   * days. Each day is refreshed in its own short transaction holding that day's row lock: an order change on that day
   * waits for it and marks the day stale again afterwards, so a day is never marked fresh for data it did not see.
   */
  @Scheduled('analytics.rollup-refresh', 60, { timeoutMs: 5 * 60_000 })
  async refresh(limit = DAYS_PER_RUN) {
    const discovered = await this.db.withPlatform((tx) => tx.one<{ n: number }>(`select app.analytics_discover_days(interval '10 days') as n`),
      'analytics.rollup-refresh');
    const stale = await this.db.withPlatform((tx) => tx.query<{ org_id: string; branch_id: string; local_date: string }>(
      `select d.org_id, d.branch_id, d.local_date::text as local_date
         from analytics_days d join branches b on b.id = d.branch_id join organizations org on org.id = d.org_id
        where d.stale
          and d.local_date < (now() at time zone coalesce(b.timezone, org.timezone))::date - 3
        order by d.local_date desc limit $1`, [limit]), 'analytics.rollup-refresh');
    let refreshed = 0;
    for (const day of stale) {
      const done = await this.db.withPlatform(async (tx) => {
        const row = await tx.maybeOne<{ stale: boolean }>(
          `select stale from analytics_days where branch_id = $1 and local_date = $2 and stale for update`, [day.branch_id, day.local_date]);
        if (!row) return false; // refreshed by another worker meanwhile
        await tx.query(`select app.analytics_refresh_day($1, $2, $3)`, [day.org_id, day.branch_id, day.local_date]);
        await tx.query(`update analytics_days set stale = false, rolled_at = now() where branch_id = $1 and local_date = $2`,
          [day.branch_id, day.local_date]);
        return true;
      }, 'analytics.rollup-refresh');
      if (done) refreshed++;
    }
    return { discovered: discovered.n, stale: stale.length, refreshed };
  }

  /**
   * Daily reconciliation: rediscovers days over the whole history (a timezone change drops a branch's rollups) and
   * forces the three most recent rolled days of every branch to be recomputed by the next refresh, as a standing check
   * that rollups and orders agree. Drift found here is logged: it means an order changed without its trigger.
   */
  @Scheduled('analytics.rollup-reconcile', 24 * 3600, { timeoutMs: 10 * 60_000 })
  async reconcile() {
    return this.db.withPlatform(async (tx) => {
      const discovered = await tx.one<{ n: number }>(`select app.analytics_discover_days(null) as n`);
      // Compare the recent rolled days against a live recomputation before forcing the refresh.
      const drift = await tx.one<{ n: number }>(
        `with recent as (
           select d.org_id, d.branch_id, d.local_date from (
             select d.*, row_number() over (partition by d.branch_id order by d.local_date desc) as rn
               from analytics_days d where not d.stale) d where d.rn <= 3),
         live as (
           select r.branch_id, r.local_date, count(o.id) filter (where o.status not in ('cancelled', 'awaiting_payment'))::int as orders,
                  coalesce(sum(o.total_minor - o.refunded_minor) filter (where o.status not in ('cancelled', 'awaiting_payment')), 0)::bigint as net
             from recent r join branches b on b.id = r.branch_id join organizations org on org.id = r.org_id
             left join orders o on o.org_id = r.org_id and o.branch_id = r.branch_id
              and o.placed_at >= (r.local_date::timestamp at time zone coalesce(b.timezone, org.timezone))
              and o.placed_at < ((r.local_date + 1)::timestamp at time zone coalesce(b.timezone, org.timezone))
            group by r.branch_id, r.local_date),
         rolled as (
           select r.branch_id, r.local_date, coalesce(sum(x.orders), 0)::int as orders, coalesce(sum(x.net), 0)::bigint as net
             from recent r left join analytics_order_rollups x on x.branch_id = r.branch_id and x.local_date = r.local_date
            group by r.branch_id, r.local_date)
         select count(*)::int as n from live l join rolled r using (branch_id, local_date) where (l.orders, l.net) is distinct from (r.orders, r.net)`);
      const forced = await tx.query(
        `update analytics_days d set stale = true from (
           select branch_id, local_date, row_number() over (partition by branch_id order by local_date desc) as rn
             from analytics_days where not stale) r
          where r.rn <= 3 and d.branch_id = r.branch_id and d.local_date = r.local_date returning d.branch_id`);
      if (drift.n) this.logger.warn(`analytics rollups drift: ${drift.n} recent day(s) differed from orders; recomputing`);
      return { discovered: discovered.n, drift: drift.n, forced: forced.length };
    }, 'analytics.rollup-reconcile');
  }
}
