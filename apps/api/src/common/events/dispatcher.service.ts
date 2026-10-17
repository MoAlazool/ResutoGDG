import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { DiscoveryService, MetadataScanner, Reflector } from '@nestjs/core';
import { DbService } from '../db/db.service';
import { ON_EVENT, SCHEDULED, type OutboxEvent } from './events';

interface Handler { name: string; types: string[]; fn: (e: OutboxEvent) => Promise<unknown> }
interface Job { name: string; everySeconds: number; fn: () => Promise<unknown>; lastRun: number }

const MAX_ATTEMPTS = 8;
const backoffSeconds = (attempt: number) => Math.min(30 * 2 ** (attempt - 1), 6 * 3600);

/**
 * Outbox dispatcher and scheduler. Discovers @OnDomainEvent/@Scheduled methods
 * across all modules. `tick()` is called by the worker loop (and directly by tests).
 */
@Injectable()
export class EventDispatcher implements OnApplicationBootstrap {
  private readonly logger = new Logger('Events');
  private handlers: Handler[] = [];
  private jobs: Job[] = [];

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
        const on = this.reflector.get<{ name: string; types: string[] }>(ON_EVENT, proto[method]);
        if (on) this.handlers.push({ ...on, fn: (e) => instance[method](e) });
        const sched = this.reflector.get<{ name: string; everySeconds: number }>(SCHEDULED, proto[method]);
        if (sched) this.jobs.push({ ...sched, fn: () => instance[method](), lastRun: 0 });
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
    // Claim events with SKIP LOCKED so several workers can run safely.
    const events = await this.db.withPlatform((tx) => tx.query<any>(
      `update outbox_events set attempts = attempts + 1
        where id in (select id from outbox_events where published_at is null and available_at <= now()
                     order by created_at limit $1 for update skip locked)
        returning id, org_id, event_type, aggregate_type, aggregate_id, payload, created_at`, [batch]));
    // UPDATE ... RETURNING has no defined order; handle events in creation order.
    events.sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
    for (const row of events) {
      const event: OutboxEvent = { id: row.id, orgId: row.org_id, type: row.event_type, aggregateType: row.aggregate_type,
        aggregateId: row.aggregate_id, payload: row.payload, createdAt: row.created_at };
      const done = new Set((await this.db.withPlatform((tx) => tx.query<{ handler: string; status: string }>(
        `select handler, status from event_handlings where event_id = $1`, [event.id]))).filter((h) => h.status !== 'failed').map((h) => h.handler));
      let pendingRetry: Date | null = null;
      for (const h of this.handlers.filter((x) => x.types.includes(event.type) && !done.has(x.name))) {
        executed++;
        try {
          await h.fn(event);
          await this.record(event.id, h.name, 'succeeded', null, null);
        } catch (error) {
          const prev = await this.db.withPlatform((tx) => tx.maybeOne<{ attempts: number }>(
            `select attempts from event_handlings where event_id = $1 and handler = $2`, [event.id, h.name]));
          const attempt = (prev?.attempts ?? 0) + 1;
          const dead = attempt >= MAX_ATTEMPTS;
          const next = new Date(Date.now() + backoffSeconds(attempt) * 1000);
          if (!dead && (!pendingRetry || next < pendingRetry)) pendingRetry = next;
          await this.record(event.id, h.name, dead ? 'dead' : 'failed', (error as Error).message?.slice(0, 1000) ?? String(error), dead ? null : next, attempt);
          this.logger.warn(`${h.name} failed for ${event.type} ${event.id} (attempt ${attempt}): ${(error as Error).message}`);
        }
      }
      await this.db.withPlatform((tx) => tx.query(
        pendingRetry ? `update outbox_events set available_at = $2, last_error = 'handler retry scheduled' where id = $1`
          : `update outbox_events set published_at = now(), last_error = null where id = $1`,
        pendingRetry ? [event.id, pendingRetry] : [event.id]));
    }
    return executed;
  }

  /** Runs due scheduled jobs; a Postgres advisory lock ensures one runner per job. */
  async runDueJobs(now = Date.now(), force = false): Promise<string[]> {
    const ran: string[] = [];
    for (const job of this.jobs) {
      if (!force && now - job.lastRun < job.everySeconds * 1000) continue;
      job.lastRun = now;
      const client = await this.db.pool.connect();
      try {
        const { rows } = await client.query('select pg_try_advisory_lock(hashtext($1)) as locked', [`job:${job.name}`]);
        if (!rows[0].locked) continue;
        const { rows: [run] } = await client.query(`insert into job_runs(job) values ($1) returning id`, [job.name]);
        try {
          const stats = await job.fn();
          await client.query(`update job_runs set status = 'succeeded', finished_at = now(), stats = $2 where id = $1`, [run.id, JSON.stringify(stats ?? {})]);
          ran.push(job.name);
        } catch (error) {
          await client.query(`update job_runs set status = 'failed', finished_at = now(), error = $2 where id = $1`, [run.id, String((error as Error).message ?? error).slice(0, 1000)]);
          this.logger.warn(`job ${job.name} failed: ${(error as Error).message}`);
        } finally {
          await client.query('select pg_advisory_unlock(hashtext($1))', [`job:${job.name}`]);
        }
      } finally {
        client.release();
      }
    }
    return ran;
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

  private async record(eventId: string, handler: string, status: string, error: string | null, next: Date | null, attempts = 1) {
    await this.db.withPlatform((tx) => tx.query(
      `insert into event_handlings(event_id, handler, status, attempts, last_error, next_attempt_at) values ($1, $2, $3, $4, $5, $6)
       on conflict (event_id, handler) do update set status = excluded.status, attempts = excluded.attempts,
         last_error = excluded.last_error, next_attempt_at = excluded.next_attempt_at, updated_at = now()`,
      [eventId, handler, status, attempts, error, next]));
  }
}
