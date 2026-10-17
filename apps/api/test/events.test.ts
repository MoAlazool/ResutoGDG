import 'reflect-metadata';
import { Injectable } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { CommonModule } from '../src/common/common.module';
import { DbService } from '../src/common/db/db.service';
import { EventDispatcher } from '../src/common/events/dispatcher.service';
import { OnDomainEvent, Scheduled, type OutboxEvent } from '../src/common/events/events';
import { sql } from './helpers';

const seen: string[] = [];
let failFirst = true;

@Injectable()
class Handlers {
  @OnDomainEvent('test.ok', 'order.placed')
  async ok(e: OutboxEvent) { seen.push(`ok:${e.aggregateId}`); }

  @OnDomainEvent('test.flaky', 'order.placed')
  async flaky(e: OutboxEvent) {
    if (failFirst) { failFirst = false; throw new Error('transient'); }
    seen.push(`flaky:${e.aggregateId}`);
  }

  @Scheduled('test.job', 3600)
  async job() { seen.push('job'); return { ran: true }; }
}

let dispatcher: EventDispatcher;
let close: () => Promise<void>;
beforeAll(async () => {
  const mod = await Test.createTestingModule({ imports: [CommonModule], providers: [Handlers] }).compile();
  const app = mod.createNestApplication();
  await app.init();
  dispatcher = app.get(EventDispatcher);
  close = () => app.close();
  await sql(`update outbox_events set published_at = now() where published_at is null`);
});
afterAll(async () => { await close(); });

it('delivers each event once per handler and retries failures with backoff', async () => {
  const db = (dispatcher as any).db as DbService;
  await db.withPlatform((tx) => tx.query(
    `insert into outbox_events(aggregate_type, aggregate_id, event_type) values ('order', 'o-1', 'order.placed')`));
  await dispatcher.tick();
  expect(seen).toEqual(['ok:o-1']);
  const [h] = await sql(`select status, attempts from event_handlings where handler = 'test.flaky'`);
  expect(h).toMatchObject({ status: 'failed', attempts: 1 });
  // Make the retry due now and run again: only the failed handler re-runs.
  await sql(`update outbox_events set available_at = now() where aggregate_id = 'o-1'`);
  await dispatcher.tick();
  expect(seen).toEqual(['ok:o-1', 'flaky:o-1']);
  const [e] = await sql(`select published_at from outbox_events where aggregate_id = 'o-1'`);
  expect(e.published_at).not.toBeNull();
});

it('runs scheduled jobs once and records the run', async () => {
  expect(await dispatcher.runDueJobs(Date.now(), true)).toEqual(['test.job']);
  const [run] = await sql(`select status, stats from job_runs where job = 'test.job' order by id desc limit 1`);
  expect(run).toMatchObject({ status: 'succeeded', stats: { ran: true } });
});
