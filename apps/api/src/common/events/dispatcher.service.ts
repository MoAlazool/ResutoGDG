import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { DiscoveryService, MetadataScanner, Reflector } from '@nestjs/core';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { DbService } from '../db/db.service';
import { requestContext, workerRequestId } from '../http/request-context';
import { ON_EVENT, SCHEDULED, type OutboxEvent } from './events';

interface Handler { name: string; types: string[]; timeoutMs: number; fn: (e: OutboxEvent) => Promise<unknown> }
interface Job { name: string; everySeconds: number; timeoutMs: number; fn: () => Promise<unknown>; nextCheck: number }

const MAX_ATTEMPTS = 8;
const DEFAULT_HANDLER_TIMEOUT_MS = 30_000;
/**
 * Default job timeout: five intervals, between 1 and 10 minutes. It also bounds how long a job stays blocked after its
 * process died mid-run (the lease is timeout + margin), so the 5-second sender is back within ~1.5 minutes.
 */
const defaultJobTimeoutMs = (everySeconds: number) => Math.min(10 * 60_000, Math.max(60_000, everySeconds * 5_000));
/** Extra lease time on top of the timeouts, so a lease never ends while its holder is still finishing up. */
const LEASE_MARGIN_MS = 60_000;
const JOB_LEASE_MARGIN_MS = 30_000;
/** How often a process asks the database whether a job is due (the cadence itself is shared, in job_leases). */
const JOB_POLL_MAX_SECONDS = 60;
/** A claimed batch must be started within this long; each event's lease is renewed when its turn comes. */
const BATCH_LEASE_MS = 5 * 60_000;
const backoffSeconds = (attempt: number) => Math.min(30 * 2 ** (attempt - 1), 6 * 3600);
const secs = (ms: number) => Math.ceil(ms / 1000);

class TimeoutError extends Error {}
function withTimeout<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const limit = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new TimeoutError(`${label} timed out after ${ms} ms`)), ms); });
  return Promise.race([work, limit]).finally(() => clearTimeout(timer));
}

/**
 * Outbox dispatcher and scheduler. Discovers @OnDomainEvent/@Scheduled methods
 * across all modules. `tick()` is called by the worker loop (and directly by tests).
 *
 * Any number of worker loops may run side by side (separate worker, RUN_WORKER_IN_PROCESS, overlapping deploys,
 * replicas): event claims are leases with a claim token, each handler run is leased in event_handlings, and scheduled
 * jobs are claimed through job_leases. A handler or job that exceeds its timeout counts as failed; its lease is kept
 * until the retry time so the (uncancellable) run cannot overlap a retry, and a late success is still recorded.
 */
@Injectable()
export class EventDispatcher implements OnApplicationBootstrap {
  private readonly logger = new Logger('Events');
  private handlers: Handler[] = [];
  private jobs: Job[] = [];
  readonly workerId = `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;

  constructor(
    private readonly discovery: DiscoveryService,
    private readonly scanner: MetadataScanner,
    private readonly reflector: Reflector,
    private readonly db: DbService,
  ) {}

  onApplicationBootstrap() {
    // A service bound to a port with `useExisting` appears as two providers
    // sharing one instance; register each instance's handlers once.
    const seen = new Set<object>();
    for (const wrapper of this.discovery.getProviders()) {
      const instance = wrapper.instance as Record<string, any> | undefined;
      if (!instance || typeof instance !== 'object' || seen.has(instance)) continue;
      seen.add(instance);
      const proto = Object.getPrototypeOf(instance);
      for (const method of this.scanner.getAllMethodNames(proto)) {
        const on = this.reflector.get<{ name: string; types: string[]; timeoutMs?: number }>(ON_EVENT, proto[method]);
        if (on) this.handlers.push({ name: on.name, types: on.types, timeoutMs: on.timeoutMs ?? DEFAULT_HANDLER_TIMEOUT_MS, fn: (e) => instance[method](e) });
        const sched = this.reflector.get<{ name: string; everySeconds: number; timeoutMs?: number }>(SCHEDULED, proto[method]);
        if (sched) this.jobs.push({ name: sched.name, everySeconds: sched.everySeconds, timeoutMs: sched.timeoutMs ?? defaultJobTimeoutMs(sched.everySeconds),
          fn: () => instance[method](), nextCheck: 0 });
      }
    }
    const names = this.handlers.map((h) => h.name);
    const dup = names.find((n, i) => names.indexOf(n) !== i);
    if (dup) throw new Error(`Duplicate event handler name: ${dup}`);
  }

  get registered() {
    return { handlers: this.handlers.map((h) => ({ name: h.name, types: h.types })), jobs: this.jobs.map((j) => j.name) };
  }

  /** Processes one batch of events. Returns the number of handler executions. */
  async tick(batch = 50): Promise<number> {
    if (!this.handlers.length) {
      await this.db.withPlatform((tx) => tx.query(
        `update outbox_events set published_at = now() where id in (select id from outbox_events where published_at is null and available_at <= now() limit $1)`, [batch]));
      return 0;
    }
    let executed = 0;
    const token = randomUUID();
    // Claim with SKIP LOCKED and a lease: available_at moves forward, so no other worker takes these events meanwhile.
    const events = await this.db.withPlatform((tx) => tx.query<any>(
      `update outbox_events set attempts = attempts + 1, claim_token = $2, claimed_at = now(), available_at = now() + make_interval(secs => $3)
        where id in (select id from outbox_events where published_at is null and available_at <= now()
                     order by created_at limit $1 for update skip locked)
        returning id, org_id, event_type, aggregate_type, aggregate_id, payload, created_at, request_id`, [batch, token, secs(BATCH_LEASE_MS)]));
    // UPDATE ... RETURNING has no defined order; handle events in creation order.
    events.sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
    for (const row of events) {
      const event: OutboxEvent = { id: row.id, orgId: row.org_id, type: row.event_type, aggregateType: row.aggregate_type,
        aggregateId: row.aggregate_id, payload: row.payload, createdAt: row.created_at };
      const handlers = this.handlers.filter((x) => x.types.includes(event.type));
      // Renew the lease for this event's handlers; if it was lost (lease ran out and another worker claimed it), skip.
      const leaseMs = handlers.reduce((sum, h) => sum + h.timeoutMs, 0) + LEASE_MARGIN_MS;
      const renewed = await this.db.withPlatform((tx) => tx.maybeOne(
        `update outbox_events set available_at = now() + make_interval(secs => $3)
          where id = $1 and claim_token = $2 and published_at is null returning id`, [event.id, token, secs(leaseMs)]));
      if (!renewed) continue;
      const states = new Map((await this.db.withPlatform((tx) => tx.query<{ handler: string; status: string; lease_until: Date | null }>(
        `select handler, status, lease_until from event_handlings where event_id = $1`, [event.id]))).map((h) => [h.handler, h]));
      let retryAt: Date | null = null;
      const later = (d: Date) => { if (!retryAt || d < retryAt) retryAt = d; };
      for (const h of handlers) {
        const state = states.get(h.name);
        if (state?.status === 'succeeded' || state?.status === 'dead') continue;
        const attempt = await this.acquire(event.id, h, token);
        if (attempt === null) {
          // Running elsewhere, kept after a timeout, or its retry is not due yet: look again when that time comes.
          const now = await this.db.withPlatform((tx) => tx.maybeOne<{ status: string; wait_until: Date | null }>(
            `select status, greatest(lease_until, next_attempt_at) as wait_until from event_handlings where event_id = $1 and handler = $2`,
            [event.id, h.name]));
          if (now && (now.status === 'running' || now.status === 'failed')) later(new Date(Math.max(Date.now() + 1000, new Date(now.wait_until ?? Date.now()).getTime())));
          continue;
        }
        executed++;
        const next = await this.execute(event, row.request_id, h, token, attempt);
        if (next) later(next);
      }
      const due: Date | null = retryAt;
      await this.db.withPlatform((tx) => tx.query(
        due ? `update outbox_events set available_at = $3, last_error = 'handler retry scheduled', claim_token = null where id = $1 and claim_token = $2`
          : `update outbox_events set published_at = now(), last_error = null, claim_token = null where id = $1 and claim_token = $2`,
        due ? [event.id, token, due] : [event.id, token]));
    }
    return executed;
  }

  /** Leases one handler run for an event. Returns the attempt number, or null when it is done or leased by someone else. */
  private async acquire(eventId: string, h: Handler, token: string): Promise<number | null> {
    const row = await this.db.withPlatform((tx) => tx.maybeOne<{ attempts: number }>(
      `insert into event_handlings(event_id, handler, status, attempts, claim_token, started_at, lease_until, updated_at)
       values ($1, $2, 'running', 1, $3, now(), now() + make_interval(secs => $4), now())
       on conflict (event_id, handler) do update set status = 'running', attempts = event_handlings.attempts + 1,
         claim_token = excluded.claim_token, started_at = now(), lease_until = excluded.lease_until, next_attempt_at = null, updated_at = now()
        where (event_handlings.status = 'failed' and (event_handlings.lease_until is null or event_handlings.lease_until <= now())
                and (event_handlings.next_attempt_at is null or event_handlings.next_attempt_at <= now()))
           or (event_handlings.status = 'running' and event_handlings.lease_until <= now())
       returning attempts`, [eventId, h.name, token, secs(h.timeoutMs + LEASE_MARGIN_MS)]));
    return row ? row.attempts : null;
  }

  /** Runs one leased handler with its timeout and records the outcome. Returns the retry time on failure. */
  private async execute(event: OutboxEvent, requestId: string | null, h: Handler, token: string, attempt: number): Promise<Date | null> {
    const store = { requestId: requestId ?? workerRequestId('evt', event.id), source: 'worker' as const,
      handling: { eventId: event.id, handler: h.name, orgId: event.orgId } };
    const work = requestContext.run(store, () => Promise.resolve().then(() => h.fn(event)));
    try {
      await withTimeout(work, h.timeoutMs, h.name);
      await this.finish(event.id, h.name, token, { status: 'succeeded' });
      return null;
    } catch (error) {
      const timedOut = error instanceof TimeoutError;
      const dead = attempt >= MAX_ATTEMPTS;
      const next = new Date(Date.now() + backoffSeconds(attempt) * 1000);
      const message = (error as Error)?.message?.slice(0, 1000) ?? String(error);
      // A timed-out run may still be going: keep its lease until the retry so the two can never overlap.
      await this.finish(event.id, h.name, token, { status: dead ? 'dead' : 'failed', error: message, next: dead ? null : next,
        leaseUntil: timedOut ? next : null });
      if (timedOut) {
        work.then(() => this.lateSuccess(event.id, h.name, token), () => undefined).catch(() => undefined);
      }
      this.logger.warn(`${h.name} failed for ${event.type} ${event.id} (attempt ${attempt}, request ${store.requestId}): ${message}`);
      return dead ? null : next;
    }
  }

  private async finish(eventId: string, handler: string, token: string, o: { status: string; error?: string | null; next?: Date | null; leaseUntil?: Date | null }) {
    await this.db.withPlatform((tx) => tx.query(
      `update event_handlings set status = $4, last_error = $5, next_attempt_at = $6, lease_until = $7, updated_at = now()
        where event_id = $1 and handler = $2 and claim_token = $3`,
      [eventId, handler, token, o.status, o.error ?? null, o.next ?? null, o.leaseUntil ?? null]));
  }

  /** A run that timed out finished after all: record it so the retry does not repeat its effects. */
  private async lateSuccess(eventId: string, handler: string, token: string) {
    await this.db.withPlatform((tx) => tx.query(
      `update event_handlings set status = 'succeeded', last_error = null, next_attempt_at = null, lease_until = null, updated_at = now()
        where event_id = $1 and handler = $2 and claim_token = $3 and status in ('failed', 'dead')`, [eventId, handler, token]))
      .catch((e) => this.logger.warn(`could not record late success of ${handler} for ${eventId}: ${(e as Error).message}`));
  }

  /**
   * Runs due scheduled jobs. A job_leases row is the single-runner lock and the shared cadence: a job starts only when
   * its lease is free and its last start (by any process) is at least its interval ago. No session state is held, so
   * this works through transaction poolers and survives lost connections.
   */
  async runDueJobs(now = Date.now(), force = false): Promise<string[]> {
    const ran: string[] = [];
    for (const job of this.jobs) {
      if (!force) {
        if (now < job.nextCheck) continue;
        job.nextCheck = now + Math.min(job.everySeconds, JOB_POLL_MAX_SECONDS) * 1000;
      }
      const owner = `${this.workerId}:${randomUUID().slice(0, 8)}`;
      const leaseSeconds = secs(job.timeoutMs + JOB_LEASE_MARGIN_MS);
      const run = await this.db.withPlatform(async (tx) => {
        await tx.query(`insert into job_leases(job) values ($1) on conflict do nothing`, [job.name]);
        const claimed = await tx.maybeOne(
          `update job_leases set owner = $2, locked_until = now() + make_interval(secs => $3), last_started_at = now()
            where job = $1 and locked_until <= now()
              and ($4::boolean or last_started_at is null or last_started_at <= now() - make_interval(secs => $5))
            returning job`, [job.name, owner, leaseSeconds, force, Math.max(job.everySeconds - 1, 0)]);
        if (!claimed) return null;
        const r = await tx.one<{ id: number }>(`insert into job_runs(job) values ($1) returning id`, [job.name]);
        await tx.query(`update job_leases set run_id = $2 where job = $1`, [job.name, r.id]);
        return r;
      });
      if (!run) continue;
      const store = { requestId: workerRequestId('job', `${job.name}:${run.id}`), source: 'job' as const };
      const work = requestContext.run(store, () => Promise.resolve().then(() => job.fn()));
      try {
        const stats = await withTimeout(work, job.timeoutMs, `job ${job.name}`);
        await this.endJob(job.name, owner, run.id, 'succeeded', { stats });
        ran.push(job.name);
      } catch (error) {
        const timedOut = error instanceof TimeoutError;
        await this.endJob(job.name, owner, run.id, timedOut ? 'timed_out' : 'failed', { error: String((error as Error)?.message ?? error).slice(0, 1000) });
        this.logger.warn(`job ${job.name} failed (request ${store.requestId}): ${(error as Error)?.message}`);
      }
    }
    return ran;
  }

  private async endJob(job: string, owner: string, runId: number, outcome: 'succeeded' | 'failed' | 'timed_out', r: { stats?: unknown; error?: string }) {
    await this.db.withPlatform(async (tx) => {
      await tx.query(`update job_runs set status = $2, finished_at = now(), stats = $3, error = $4 where id = $1`,
        [runId, outcome === 'succeeded' ? 'succeeded' : 'failed', JSON.stringify(r.stats ?? {}), r.error ?? null]);
      // A timed-out run may still be going: keep the lease until it expires so no second copy starts.
      await tx.query(
        `update job_leases set last_finished_at = now(), last_status = $3${outcome === 'timed_out' ? '' : ', locked_until = now()'}
          where job = $1 and owner = $2`, [job, owner, outcome]);
    });
  }

  /** Test helper: drain all currently available events. */
  async drain(maxRounds = 20) {
    let total = 0;
    for (let i = 0; i < maxRounds; i++) {
      const pending = await this.db.withPlatform((tx) => tx.one<{ n: number }>(
        `select count(*)::int as n from outbox_events where published_at is null and available_at <= now()`));
      if (!pending.n) break;
      total += await this.tick(200);
    }
    return total;
  }
}
