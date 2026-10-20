import 'reflect-metadata';
import { Injectable, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CommonModule } from '../src/common/common.module';
import { DbService } from '../src/common/db/db.service';
import { EventDispatcher, TIMED_OUT_HOLD_FACTOR, timedOutHoldUntil } from '../src/common/events/dispatcher.service';
import { onceForEvent } from '../src/common/events/effects';
import { OnDomainEvent, Scheduled, type OutboxEvent } from '../src/common/events/events';
import { sql } from './helpers';

// Audit PCL-01 / PS-10: the outbox claim committed at once without a lease, so a second worker loop (the in-process
// worker during an overlapping Render deploy, a separate worker, a replica) re-claimed events that were still being
// handled and ran their handlers again (duplicate WhatsApp notifications).

const runs = new Map<string, number>();
const count = (key: string) => runs.set(key, (runs.get(key) ?? 0) + 1);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let jobRuns = 0;
let crashAfterEffect = true;

@Injectable()
class LeaseHandlers {
  constructor(private readonly db: DbService) {}

  @OnDomainEvent('lease.slow', 'order.placed')
  async slow(e: OutboxEvent) { await sleep(120); count(`slow:${e.aggregateId}`); }

  @OnDomainEvent('lease.fast', 'order.placed')
  async fast(e: OutboxEvent) { count(`fast:${e.aggregateId}`); }

  /** Cannot be cancelled: keeps running 300 ms after its 120 ms timeout. */
  @OnDomainEvent('lease.hang', 'order.cancelled', { timeoutMs: 120 })
  async hang(e: OutboxEvent) { count(`hang-start:${e.aggregateId}`); await sleep(420); count(`hang-done:${e.aggregateId}`); }

  /** Cannot be cancelled: fails 200 ms after its 120 ms timeout. */
  @OnDomainEvent('lease.hangfail', 'order.status_changed', { timeoutMs: 120 })
  async hangFail(e: OutboxEvent) { count(`hangfail-start:${e.aggregateId}`); await sleep(320); throw new Error('provider said no, late'); }

  /** Sends a "message" exactly once even though the first attempt stops right after committing it. */
  @OnDomainEvent('lease.effect', 'order.paid')
  async effect(e: OutboxEvent) {
    await this.db.withPlatform(async (tx) => { if (await onceForEvent(tx, 'customer-message')) count(`effect:${e.aggregateId}`); });
    count(`effect-attempt:${e.aggregateId}`);
    if (crashAfterEffect) { crashAfterEffect = false; throw new Error('worker stopped after the effect committed'); }
  }

  @Scheduled('lease.job', 3600)
  async job() { jobRuns++; await sleep(100); return { ok: true }; }
}

async function boot(): Promise<INestApplication> {
  const mod = await Test.createTestingModule({ imports: [CommonModule], providers: [LeaseHandlers] }).compile();
  const app = mod.createNestApplication({ logger: ['error'] });
  await app.init();
  return app;
}

let a: INestApplication;
let b: INestApplication;
let da: EventDispatcher;
let db: EventDispatcher;

async function publish(aggregateId: string, type = 'order.placed') {
  const [row] = await sql<{ id: string }>(`insert into outbox_events(aggregate_type, aggregate_id, event_type) values ('order', $1, $2) returning id`, [aggregateId, type]);
  return row.id;
}
const uid = (p: string) => `${p}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const handling = async (eventId: string, handler: string) =>
  (await sql(`select status, attempts, last_error, lease_until from event_handlings where event_id = $1 and handler = $2`, [eventId, handler]))[0];
const outbox = async (eventId: string) => (await sql(`select published_at, available_at, claim_token from outbox_events where id = $1`, [eventId]))[0];

beforeAll(async () => {
  a = await boot();
  b = await boot();
  da = a.get(EventDispatcher);
  db = b.get(EventDispatcher);
});
beforeEach(async () => {
  runs.clear();
  await sql(`update outbox_events set published_at = now() where published_at is null`);
});
afterAll(async () => { await a?.close(); await b?.close(); });

describe('outbox claims are leased', () => {
  it('two workers ticking at the same time run each handler exactly once per event', async () => {
    const ids = [];
    for (let i = 0; i < 6; i++) ids.push(`lease-${Date.now()}-${i}`);
    for (const id of ids) await publish(id);
    const first = da.tick();
    await sleep(30); // the first claim has committed; the second worker must not take the same events
    await Promise.all([first, db.tick(), sleep(40).then(() => db.tick())]);
    for (const id of ids) {
      expect(runs.get(`slow:${id}`), `slow handler for ${id}`).toBe(1);
      expect(runs.get(`fast:${id}`), `fast handler for ${id}`).toBe(1);
    }
    const rows = await sql(`select published_at from outbox_events where aggregate_id = any($1)`, [ids]);
    expect(rows.every((r) => r.published_at !== null)).toBe(true);
  });

  it('an event claimed by a worker that stopped is taken over once its lease ends', async () => {
    const agg = uid('stale');
    const id = await publish(agg);
    await sql(`update outbox_events set claim_token = gen_random_uuid(), attempts = 1, available_at = now() + interval '1 hour' where id = $1`, [id]);
    await da.tick();
    expect(runs.get(`slow:${agg}`)).toBeUndefined();
    await sql(`update outbox_events set available_at = now() - interval '1 second' where id = $1`, [id]);
    await da.tick();
    expect([runs.get(`slow:${agg}`), runs.get(`fast:${agg}`)]).toEqual([1, 1]);
    expect((await outbox(id)).published_at).not.toBeNull();
  });

  it('a handler run leased by another worker is not repeated; the event waits for it', async () => {
    const agg = uid('busy');
    const id = await publish(agg);
    await sql(`insert into event_handlings(event_id, handler, status, attempts, claim_token, started_at, lease_until)
               values ($1, 'lease.slow', 'running', 1, gen_random_uuid(), now(), now() + interval '10 minutes')`, [id]);
    await da.tick();
    expect(runs.get(`slow:${agg}`)).toBeUndefined();
    expect(runs.get(`fast:${agg}`)).toBe(1);
    const waiting = await outbox(id);
    expect(waiting.published_at).toBeNull();
    expect(new Date(waiting.available_at).getTime()).toBeGreaterThan(Date.now() + 9 * 60_000);
    // that worker died: its lease runs out and the next tick takes the run over (attempt 2)
    await sql(`update event_handlings set lease_until = now() - interval '1 second' where event_id = $1`, [id]);
    await sql(`update outbox_events set available_at = now() where id = $1`, [id]);
    await da.tick();
    expect([runs.get(`slow:${agg}`), runs.get(`fast:${agg}`)]).toEqual([1, 1]);
    expect(await handling(id, 'lease.slow')).toMatchObject({ status: 'succeeded', attempts: 2 });
    expect((await outbox(id)).published_at).not.toBeNull();
  });

  it('a handler that exceeds its timeout fails without blocking the loop; its late success is kept and not repeated', async () => {
    const agg = uid('hang');
    const id = await publish(agg, 'order.cancelled');
    const t0 = Date.now();
    await da.tick();
    expect(Date.now() - t0).toBeLessThan(400); // the loop moved on after 120 ms
    const failed = await handling(id, 'lease.hang');
    expect(failed).toMatchObject({ status: 'failed', attempts: 1 });
    expect(failed.last_error).toMatch(/timed out after 120 ms/);
    expect(new Date(failed.lease_until).getTime()).toBeGreaterThan(Date.now()); // nobody re-runs it meanwhile
    await sleep(450);
    expect(runs.get(`hang-done:${agg}`)).toBe(1);
    expect((await handling(id, 'lease.hang')).status).toBe('succeeded');
    await sql(`update outbox_events set available_at = now() where id = $1`, [id]);
    await da.tick();
    expect(runs.get(`hang-start:${agg}`)).toBe(1);
    expect((await outbox(id)).published_at).not.toBeNull();
  });

  // Review finding: the hold used to end at the first retry time (30 s), so a handler still working after its 30 s
  // timeout (two provider calls of ~45 s each) could run next to its own retry.
  it('a timed-out run holds its lease for several timeouts even when the retry is due sooner', () => {
    const now = Date.UTC(2026, 9, 20);
    const retry = new Date(now + 30_000);
    expect(timedOutHoldUntil(now, retry, 30_000).getTime()).toBe(now + TIMED_OUT_HOLD_FACTOR * 30_000); // 150 s, not 30 s
    expect(timedOutHoldUntil(now, retry, 1_000).getTime()).toBe(retry.getTime()); // never shorter than the retry time
  });

  it('a timed-out run that later fails frees its lease, so the retry is not held back', async () => {
    const agg = uid('hangfail');
    const id = await publish(agg, 'order.status_changed');
    await da.tick();
    const failed = await handling(id, 'lease.hangfail');
    expect(failed).toMatchObject({ status: 'failed', attempts: 1 });
    expect(new Date(failed.lease_until).getTime()).toBeGreaterThan(Date.now());
    await sleep(400);
    const after = await handling(id, 'lease.hangfail');
    expect(after).toMatchObject({ status: 'failed', attempts: 1, lease_until: null });
    // its retry runs once due (here: made due now)
    await sql(`update event_handlings set next_attempt_at = now() where event_id = $1`, [id]);
    await sql(`update outbox_events set available_at = now() where id = $1`, [id]);
    await da.tick();
    expect(runs.get(`hangfail-start:${agg}`)).toBe(2);
    await sleep(400);
  });

  it('a failed handler waits for its own retry time even when the event comes back earlier for another handler', async () => {
    const agg = uid('wait');
    const id = await publish(agg);
    // lease.slow failed and is due in an hour; lease.fast never ran (the event is claimable now)
    await sql(`insert into event_handlings(event_id, handler, status, attempts, last_error, next_attempt_at)
               values ($1, 'lease.slow', 'failed', 3, 'provider down', now() + interval '1 hour')`, [id]);
    await da.tick();
    expect(runs.get(`slow:${agg}`)).toBeUndefined();
    expect(runs.get(`fast:${agg}`)).toBe(1);
    expect(await handling(id, 'lease.slow')).toMatchObject({ status: 'failed', attempts: 3 });
    const waiting = await outbox(id);
    expect(waiting.published_at).toBeNull();
    expect(new Date(waiting.available_at).getTime()).toBeGreaterThan(Date.now() + 59 * 60_000);
  });

  it('onceForEvent keeps a side effect single when a worker stops after committing it', async () => {
    const agg = uid('effect');
    const id = await publish(agg, 'order.paid');
    await da.tick();
    expect(await handling(id, 'lease.effect')).toMatchObject({ status: 'failed', attempts: 1 });
    // the 30 s backoff has passed
    await sql(`update event_handlings set next_attempt_at = now() where event_id = $1`, [id]);
    await sql(`update outbox_events set available_at = now() where id = $1`, [id]);
    await da.tick();
    expect([runs.get(`effect:${agg}`), runs.get(`effect-attempt:${agg}`)]).toEqual([1, 2]);
    expect(await handling(id, 'lease.effect')).toMatchObject({ status: 'succeeded', attempts: 2 });
    expect(await sql(`select effect from event_effects where event_id = $1`, [id])).toEqual([{ effect: 'customer-message' }]);
  });

  it('scheduled jobs run once across workers', async () => {
    jobRuns = 0;
    const ran = await Promise.all([da.runDueJobs(Date.now(), true), db.runDueJobs(Date.now(), true)]);
    expect(jobRuns).toBe(1);
    expect(ran.flat()).toEqual(['lease.job']);
  });

  it('job cadence is shared by every process and a lease held by a stopped process blocks until it ends', async () => {
    jobRuns = 0;
    await sql(`update job_leases set last_started_at = now() - interval '2 hours', locked_until = '-infinity' where job = 'lease.job'`);
    expect(await da.runDueJobs(Date.now())).toEqual(['lease.job']);
    // another process that has never run the job locally still sees the shared cadence
    const third = await boot();
    try {
      expect(await third.get(EventDispatcher).runDueJobs(Date.now())).toEqual([]);
    } finally { await third.close(); }
    expect(jobRuns).toBe(1);
    await sql(`update job_leases set owner = 'stopped-process', locked_until = now() + interval '10 minutes' where job = 'lease.job'`);
    expect(await db.runDueJobs(Date.now(), true)).toEqual([]);
    await sql(`update job_leases set locked_until = now() - interval '1 second' where job = 'lease.job'`);
    expect(await db.runDueJobs(Date.now(), true)).toEqual(['lease.job']);
    const [lease] = await sql(`select last_status, locked_until <= now() as free from job_leases where job = 'lease.job'`);
    expect(lease).toEqual({ last_status: 'succeeded', free: true });
  });
});
