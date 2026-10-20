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
const BATCH = 5000;

/**
 * Hourly housekeeping: closes job runs abandoned by stopped processes and deletes operational rows past their
 * retention in bounded batches (each statement removes at most BATCH rows, so it never holds long locks).
 */
@Injectable()
export class MaintenanceJobs {
  private readonly logger = new Logger('Maintenance');
  constructor(private readonly db: DbService) {}

  @Scheduled('platform.maintenance', 3600, { timeoutMs: 5 * 60_000 })
  async run() {
    const n = (rows: unknown[]) => rows.length;
    const stats = await this.db.withPlatform(async (tx) => ({
      abandonedJobRuns: n(await tx.query(
        `update job_runs r set status = 'abandoned', finished_at = now(), error = 'the process stopped before the run finished'
          where r.status = 'running' and r.started_at < now() - make_interval(hours => $1)
            and not exists (select 1 from job_leases l where l.run_id = r.id and l.locked_until > now())
          returning r.id`, [RETENTION.abandonedRunHours])),
      outboxEvents: n(await tx.query(
        `delete from outbox_events where id in (
           select e.id from outbox_events e
            where e.published_at < now() - make_interval(days => $1)
              and (e.published_at < now() - make_interval(days => $2)
                   or not exists (select 1 from event_handlings h where h.event_id = e.id and h.status = 'dead'))
            limit $3) returning id`, [RETENTION.publishedEventsDays, RETENTION.deadLetterDays, BATCH])),
      jobRuns: n(await tx.query(
        `delete from job_runs where id in (
           select id from job_runs
            where (status = 'succeeded' and started_at < now() - make_interval(days => $1))
               or (status <> 'running' and started_at < now() - make_interval(days => $2))
            limit $3) returning id`, [RETENTION.succeededJobRunsDays, RETENTION.otherJobRunsDays, BATCH])),
      idempotencyKeys: n(await tx.query(
        `delete from idempotency_keys where ctid in (
           select ctid from idempotency_keys where created_at < now() - make_interval(days => $1) limit $2) returning key`,
        [RETENTION.idempotencyKeysDays, BATCH])),
      webhooks: n(await tx.query(
        `delete from webhook_inbox where id in (
           select id from webhook_inbox where status in ('processed', 'ignored', 'rejected')
              and received_at < now() - make_interval(days => $1) limit $2) returning id`, [RETENTION.finishedWebhooksDays, BATCH])),
    }), 'system:maintenance');
    if (Object.values(stats).some((v) => v > 0)) this.logger.log(`maintenance ${JSON.stringify(stats)}`);
    return stats;
  }
}
