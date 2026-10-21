import { Injectable } from '@nestjs/common';
import { DbService } from '../../common/db/db.service';
import { buildInfo } from '../../common/observability/build-info';

/** Thresholds behind the "status" of /v1/health/details; an uptime monitor can alert on status = 'degraded'. */
export const HEALTH_THRESHOLDS = {
  /** Oldest unpublished outbox event (the worker publishes within seconds when it runs). */
  outboxOldestPendingSeconds: 300,
  /** Dead event handlings (exhausted retries) waiting for an operator. */
  deadHandlings: 0,
  /** Failed provider webhooks still waiting for a retry. */
  failedWebhooks: 0,
};

export interface HealthDetails {
  status: 'ok' | 'degraded';
  reasons: string[];
  checkedAt: string;
  build: ReturnType<typeof buildInfo>;
  outbox: { pending: number; oldestPendingSeconds: number | null; failedAttempts: number };
  handlers: { running: number; failed: number; dead: number };
  jobs: Array<{ job: string; lastStatus: string | null; lastStartedAt: string | null; lastFinishedAt: string | null; failedLast24h: number }>;
  webhooks: { last24h: Array<{ provider: string; received: number; failed: number; rejected: number }>; pendingRetry: number; oldestPendingSeconds: number | null };
}

/**
 * Read-only operational snapshot across tenants (platform context): counts and timestamps only, never payloads,
 * error texts or tenant identifiers (audit CR-14).
 */
@Injectable()
export class HealthDetailsService {
  constructor(private readonly db: DbService) {}

  async snapshot(): Promise<HealthDetails> {
    return this.db.withPlatform(async (tx) => {
      const outbox = await tx.maybeOne<{ pending: number; oldest: number | null; failed: number }>(
        `select count(*)::int as pending,
                extract(epoch from now() - min(created_at))::int as oldest,
                count(*) filter (where attempts > 0)::int as failed
           from outbox_events where published_at is null`);
      const handlers = await tx.maybeOne<{ running: number; failed: number; dead: number }>(
        `select count(*) filter (where status = 'running')::int as running, count(*) filter (where status = 'failed')::int as failed,
                count(*) filter (where status = 'dead')::int as dead from event_handlings where status <> 'succeeded'`);
      const jobs = await tx.query<{ job: string; last_status: string | null; last_started_at: Date | null; last_finished_at: Date | null; failed: number }>(
        `select l.job, l.last_status, l.last_started_at, l.last_finished_at,
                (select count(*) from job_runs r where r.job = l.job and r.status in ('failed', 'abandoned') and r.started_at > now() - interval '24 hours')::int as failed
           from job_leases l order by l.job`);
      const hooks = await tx.query<{ provider: string; received: number; failed: number; rejected: number }>(
        `select provider, count(*)::int as received, count(*) filter (where status = 'failed')::int as failed,
                count(*) filter (where status = 'rejected')::int as rejected
           from webhook_inbox where received_at > now() - interval '24 hours' group by provider order by provider`);
      const pendingHooks = await tx.maybeOne<{ n: number; oldest: number | null }>(
        `select count(*)::int as n, extract(epoch from now() - min(received_at))::int as oldest from webhook_inbox where status in ('received', 'failed')`);
      const iso = (d: Date | null) => (d ? new Date(d).toISOString() : null);
      const out = {
        checkedAt: new Date().toISOString(),
        build: buildInfo(),
        outbox: { pending: outbox?.pending ?? 0, oldestPendingSeconds: outbox?.oldest ?? null, failedAttempts: outbox?.failed ?? 0 },
        handlers: { running: handlers?.running ?? 0, failed: handlers?.failed ?? 0, dead: handlers?.dead ?? 0 },
        jobs: jobs.map((j) => ({ job: j.job, lastStatus: j.last_status, lastStartedAt: iso(j.last_started_at), lastFinishedAt: iso(j.last_finished_at), failedLast24h: j.failed })),
        webhooks: { last24h: hooks, pendingRetry: pendingHooks?.n ?? 0, oldestPendingSeconds: pendingHooks?.oldest ?? null },
      };
      const reasons: string[] = [];
      if ((out.outbox.oldestPendingSeconds ?? 0) > HEALTH_THRESHOLDS.outboxOldestPendingSeconds) {
        reasons.push(`outbox: oldest unpublished event is ${out.outbox.oldestPendingSeconds} s old (is the worker running?)`);
      }
      if (out.handlers.dead > HEALTH_THRESHOLDS.deadHandlings) reasons.push(`handlers: ${out.handlers.dead} dead event handling(s) need replay`);
      const failedHooks = hooks.reduce((n, h) => n + h.failed, 0);
      if (failedHooks > HEALTH_THRESHOLDS.failedWebhooks) reasons.push(`webhooks: ${failedHooks} failed in the last 24 h`);
      return { status: reasons.length ? 'degraded' as const : 'ok' as const, reasons, ...out };
    }, 'system:health-details');
  }
}
