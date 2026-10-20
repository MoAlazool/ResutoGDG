import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MAINTENANCE_LIMITS, MaintenanceJobs, RETENTION } from '../src/modules/system/maintenance.jobs';
import { auth, bootTestApp, signup, sql, unique, type TestApp, type TestUser } from './helpers';

// Audit PCL-13: no retention for outbox/handlings/job_runs/idempotency keys, no dead-letter replay, job_runs left
// 'running' forever by a stopped process.

let t: TestApp;
let superadmin: TestUser;
let support: TestUser;

beforeAll(async () => {
  t = await bootTestApp();
  superadmin = await signup(t, 'ops-super');
  support = await signup(t, 'ops-support');
  await sql(`insert into platform_admins(user_id, role) values ($1, 'superadmin'), ($2, 'support')`, [superadmin.userId, support.userId]);
});
afterAll(async () => { await t.close(); });

const event = async (publishedDaysAgo: number | null) => (await sql<{ id: string }>(
  `insert into outbox_events(aggregate_type, aggregate_id, event_type, published_at, created_at)
   values ('order', $1, 'ops.test', case when $2::int is null then null else now() - make_interval(days => $2::int) end, now() - interval '200 days')
   returning id`, [unique('agg'), publishedDaysAgo]))[0].id;
const exists = async (id: string) => (await sql(`select 1 from outbox_events where id = $1`, [id])).length === 1;

describe('maintenance job', () => {
  it('deletes operational rows past retention, keeps recent ones and dead letters, closes abandoned job runs', async () => {
    const old = await event(RETENTION.publishedEventsDays + 1);
    const recent = await event(2);
    const unpublished = await event(null);
    const deadRecent = await event(RETENTION.publishedEventsDays + 1);
    const deadOld = await event(RETENTION.deadLetterDays + 1);
    await sql(`insert into event_handlings(event_id, handler, status, attempts) values ($1, 'x.ok', 'succeeded', 1)`, [old]);
    await sql(`insert into event_handlings(event_id, handler, status, attempts) values ($1, 'x.dead', 'dead', 8), ($2, 'x.dead', 'dead', 8)`, [deadRecent, deadOld]);
    const [abandoned] = await sql<{ id: number }>(`insert into job_runs(job, started_at) values ('ops.test', now() - interval '3 hours') returning id`);
    const [live] = await sql<{ id: number }>(`insert into job_runs(job, started_at) values ('ops.live', now() - interval '3 hours') returning id`);
    await sql(`insert into job_leases(job, owner, locked_until, run_id) values ('ops.live', 'busy', now() + interval '10 minutes', $1)
               on conflict (job) do update set locked_until = excluded.locked_until, run_id = excluded.run_id`, [live.id]);
    const [oldRun] = await sql<{ id: number }>(`insert into job_runs(job, started_at, status, finished_at) values ('ops.test', now() - interval '20 days', 'succeeded', now() - interval '20 days') returning id`);
    const [failedRun] = await sql<{ id: number }>(`insert into job_runs(job, started_at, status, finished_at) values ('ops.test', now() - interval '20 days', 'failed', now() - interval '20 days') returning id`);
    const oldHook = unique('wh-old');
    const freshHook = unique('wh-new');
    const pendingHook = unique('wh-pending');
    await sql(`insert into webhook_inbox(provider, event_key, signature_valid, payload, status, received_at) values
               ('stripe', $1, true, '{}', 'processed', now() - interval '120 days'),
               ('stripe', $2, true, '{}', 'processed', now() - interval '5 days'),
               ('stripe', $3, true, '{}', 'failed', now() - interval '120 days')`, [oldHook, freshHook, pendingHook]);

    const stats = await t.app.get(MaintenanceJobs).run();
    expect(stats.abandonedJobRuns).toBeGreaterThanOrEqual(1);
    expect(await exists(old)).toBe(false);
    expect(await sql(`select 1 from event_handlings where event_id = $1`, [old])).toEqual([]);
    expect(await exists(recent)).toBe(true);
    expect(await exists(unpublished)).toBe(true);
    expect(await exists(deadRecent)).toBe(true); // still visible for replay
    expect(await exists(deadOld)).toBe(false);
    const runs = new Map((await sql(`select id, status from job_runs where id = any($1)`, [[abandoned.id, live.id, oldRun.id, failedRun.id]])).map((r) => [Number(r.id), r.status]));
    expect(runs.get(abandoned.id)).toBe('abandoned');
    expect(runs.get(live.id)).toBe('running'); // its lease is still held by a live process
    expect(runs.has(oldRun.id)).toBe(false); // succeeded runs: 14 days
    expect(runs.get(failedRun.id)).toBe('failed'); // failures: 30 days
    const hooks = (await sql(`select event_key from webhook_inbox where event_key = any($1)`, [[oldHook, freshHook, pendingHook]])).map((r) => r.event_key).sort();
    expect(hooks).toEqual([freshHook, pendingHook].sort());
    await sql(`delete from job_leases where job = 'ops.live'`);
  });
});

describe('maintenance throughput', () => {
  // Review finding: one batch per table per hourly run capped retention at 5,000 outbox events/hour (~120k/day);
  // anything above that piled up for ever.
  it('repeats batches within one run until the backlog is cleared', async () => {
    const saved = { ...MAINTENANCE_LIMITS };
    try {
      MAINTENANCE_LIMITS.batch = 3;
      const ids = await Promise.all(Array.from({ length: 10 }, () => event(RETENTION.publishedEventsDays + 3)));
      const stats = await t.app.get(MaintenanceJobs).run();
      expect(stats.outboxEvents).toBeGreaterThanOrEqual(10);
      expect(stats.backlog).toEqual([]);
      for (const id of ids) expect(await exists(id)).toBe(false);
    } finally { Object.assign(MAINTENANCE_LIMITS, saved); }
  });

  it('stops at its time budget and reports what is left', async () => {
    const saved = { ...MAINTENANCE_LIMITS };
    try {
      MAINTENANCE_LIMITS.budgetMs = 0;
      const id = await event(RETENTION.publishedEventsDays + 3);
      const stats = await t.app.get(MaintenanceJobs).run();
      expect(stats.backlog).toEqual(['outboxEvents', 'jobRuns', 'idempotencyKeys', 'webhooks']);
      expect(await exists(id)).toBe(true);
    } finally { Object.assign(MAINTENANCE_LIMITS, saved); }
  });
});

describe('dead-letter replay', () => {
  const replay = (u: TestUser, eventId: string, handler: string, reason = 'provider fixed, resend') =>
    t.http.post(`/v1/admin/operations/handlings/${eventId}/${handler}/replay`).set(auth(u)).send({ reason });

  it('re-queues a dead handler run with a fresh budget, audited; support cannot; succeeded runs are not replayable', async () => {
    const id = await event(1);
    await sql(`insert into event_handlings(event_id, handler, status, attempts, last_error) values ($1, 'x.dead', 'dead', 8, 'boom'), ($1, 'x.ok', 'succeeded', 1, null)`, [id]);
    const ops = await t.http.get('/v1/admin/operations').set(auth(support));
    expect(ops.body.eventHandlings.recent.some((r: any) => r.eventId === id && r.status === 'dead')).toBe(true);

    expect((await replay(support, id, 'x.dead')).status).toBe(403);
    expect((await replay(superadmin, id, 'x.ok')).status).toBe(409);
    expect((await replay(superadmin, '00000000-0000-4000-8000-000000000000', 'x.dead')).status).toBe(404);

    const res = await replay(superadmin, id, 'x.dead');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ eventId: id, handler: 'x.dead', status: 'queued' });
    const [h] = await sql(`select status, attempts, next_attempt_at <= now() as due from event_handlings where event_id = $1 and handler = 'x.dead'`, [id]);
    expect(h).toEqual({ status: 'failed', attempts: 0, due: true });
    const [e] = await sql(`select published_at, available_at <= now() as available from outbox_events where id = $1`, [id]);
    expect(e).toEqual({ published_at: null, available: true });
    const [log] = await sql(`select actor_id, metadata from audit_logs where action = 'admin.event_handler_replayed' and entity_id = $1`, [`${id}:x.dead`]);
    expect(log.actor_id).toBe(superadmin.userId);
    expect(log.metadata).toMatchObject({ previousStatus: 'dead', previousAttempts: 8, reason: 'provider fixed, resend' });
  });

  // Review finding: replay cleared the lease of a timed-out run that may still be working, so the next tick started a
  // second copy next to it and the original's late success could no longer be recorded.
  it('refuses to replay a timed-out run while its lease is held', async () => {
    const id = await event(null);
    await sql(`insert into event_handlings(event_id, handler, status, attempts, last_error, claim_token, lease_until, next_attempt_at)
               values ($1, 'x.timedout', 'failed', 1, 'x.timedout timed out after 30000 ms', gen_random_uuid(), now() + interval '2 minutes', now() + interval '30 seconds'),
                      ($1, 'x.deadheld', 'dead', 8, 'timed out', gen_random_uuid(), now() + interval '2 minutes', null)`, [id]);
    for (const handler of ['x.timedout', 'x.deadheld']) {
      const res = await replay(superadmin, id, handler);
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('run_in_progress');
      expect(new Date(res.body.error.details.retryAfter).getTime()).toBeGreaterThan(Date.now());
    }
    const [h] = await sql(`select attempts, lease_until > now() as held from event_handlings where event_id = $1 and handler = 'x.timedout'`, [id]);
    expect(h).toEqual({ attempts: 1, held: true });
    // once the hold ends (run settled or lease expired) the replay goes through
    await sql(`update event_handlings set lease_until = now() - interval '1 second' where event_id = $1`, [id]);
    expect((await replay(superadmin, id, 'x.timedout')).status).toBe(200);
  });

  it('counts and replays a run left "running" after its lease ended (stopped worker)', async () => {
    const id = await event(null);
    await sql(`update outbox_events set available_at = now() + interval '1 hour' where id = $1`, [id]);
    await sql(`insert into event_handlings(event_id, handler, status, attempts, lease_until) values ($1, 'x.stuck', 'running', 2, now() - interval '5 minutes')`, [id]);
    const ops = await t.http.get('/v1/admin/operations').set(auth(support));
    expect(ops.body.eventHandlings.stuck).toBeGreaterThanOrEqual(1);
    expect(ops.body.eventHandlings.recent.some((r: any) => r.eventId === id && r.status === 'running')).toBe(true);
    expect((await replay(superadmin, id, 'x.stuck')).status).toBe(200);
    const [log] = await sql(`select metadata from audit_logs where action = 'admin.event_handler_replayed' and entity_id = $1`, [`${id}:x.stuck`]);
    expect(log.metadata.previousStatus).toBe('stuck');
  });
});
