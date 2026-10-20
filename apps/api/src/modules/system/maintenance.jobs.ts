import { Injectable, Logger } from '@nestjs/common';
import { DbService } from '../../common/db/db.service';
import { Scheduled } from '../../common/events/events';

/** Retention windows for operational tables (audit PCL-13). Business records are never touched here. */
export const RETENTION = {
  /** Published outbox events (with their handlings and effects) without a dead letter. */
  publishedEventsDays: 30,
  /** Published events that still carry a dead handler run stay visible for replay this long. */
  deadLetterDays: 90,
  succeededJobRunsDays: 14,
  otherJobRunsDays: 30,
  /** Client retry keys; providers and browsers retry within hours, so a month is generous. */
  idempotencyKeysDays: 30,
  /** Provider webhooks already processed, ignored or rejected (dedupe + forensics window). */
  finishedWebhooksDays: 90,
  /** A job run still 'running' this long after its start, with no live lease, belonged to a stopped process. */
  abandonedRunHours: 1,
};
/**
 * Each delete statement removes at most `batch` rows in its own transaction (short locks); a run repeats batches until
 * a table is cleared or the run has used `budgetMs` (below the job's 5-minute timeout). One hourly run can therefore
 * clear far more than one batch per table (audit PCL-13 review: a single 5,000-row batch per hour capped outbox
 * retention at ~120k events/day). Tables left with rows past retention are reported in `backlog`.
 */
export const MAINTENANCE_LIMITS = { batch: 5000, budgetMs: 4 * 60_000 };

type Table = 'outboxEvents' | 'jobRuns' | 'idempotencyKeys' | 'webhooks';
const DELETES: Record<Table, { sql: string; params: () => unknown[] }> = {
  outboxEvents: {
    sql: `delete from outbox_events where id in (
            select e.id from outbox_events e
             where e.published_at < now() - make_interval(days => $1)
               and (e.published_at < now() - make_interval(days => $2)
                    or not exists (select 1 from event_handlings h where h.event_id = e.id and h.status = 'dead'))
             limit $3) returning id`,
    params: () => [RETENTION.publishedEventsDays, RETENTION.deadLetterDays],
  },
  jobRuns: {
    sql: `delete from job_runs where id in (
            select id from job_runs
             where (status = 'succeeded' and started_at < now() - make_interval(days => $1))
                or (status <> 'running' and started_at < now() - make_interval(days => $2))
             limit $3) returning id`,
    params: () => [RETENTION.succeededJobRunsDays, RETENTION.otherJobRunsDays],
  },
  idempotencyKeys: {
    sql: `delete from idempotency_keys where ctid in (
            select ctid from idempotency_keys where created_at < now() - make_interval(days => $1) limit $2) returning key`,
    params: () => [RETENTION.idempotencyKeysDays],
  },
  webhooks: {
    sql: `delete from webhook_inbox where id in (
            select id from webhook_inbox where status in ('processed', 'ignored', 'rejected')
               and received_at < now() - make_interval(days => $1) limit $2) returning id`,
    params: () => [RETENTION.finishedWebhooksDays],
  },
};

/**
 * Hourly housekeeping: closes job runs abandoned by stopped processes and deletes operational rows past their
 * retention in bounded batches (see MAINTENANCE_LIMITS).
 */
@Injectable()
export class MaintenanceJobs {
  private readonly logger = new Logger('Maintenance');
  constructor(private readonly db: DbService) {}

  @Scheduled('platform.maintenance', 3600, { timeoutMs: 5 * 60_000 })
  async run() {
    const started = Date.now();
    const { batch, budgetMs } = MAINTENANCE_LIMITS;
    const abandonedJobRuns = (await this.db.withPlatform((tx) => tx.query(
      `update job_runs r set status = 'abandoned', finished_at = now(), error = 'the process stopped before the run finished'
        where r.status = 'running' and r.started_at < now() - make_interval(hours => $1)
          and not exists (select 1 from job_leases l where l.run_id = r.id and l.locked_until > now())
        returning r.id`, [RETENTION.abandonedRunHours]), 'system:maintenance')).length;
    const deleted: Record<Table, number> = { outboxEvents: 0, jobRuns: 0, idempotencyKeys: 0, webhooks: 0 };
    const backlog: Table[] = [];
    for (const table of Object.keys(DELETES) as Table[]) {
      const { sql, params } = DELETES[table];
      for (;;) {
        if (Date.now() - started >= budgetMs) { backlog.push(table); break; }
        const n = (await this.db.withPlatform((tx) => tx.query(sql, [...params(), batch]), 'system:maintenance')).length;
        deleted[table] += n;
        if (n < batch) break;
      }
    }
    const stats = { abandonedJobRuns, ...deleted, backlog };
    if (backlog.length) this.logger.warn(`maintenance stopped at its time budget; rows past retention remain in ${backlog.join(', ')}`);
    if (abandonedJobRuns || Object.values(deleted).some((v) => v > 0)) this.logger.log(`maintenance ${JSON.stringify(stats)}`);
    return stats;
  }
}
