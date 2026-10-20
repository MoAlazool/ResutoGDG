import 'reflect-metadata';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { dbUnavailable, DbService } from '../src/common/db/db.service';
import { DomainError } from '../src/common/errors/domain-error';
import { ApiExceptionFilter } from '../src/common/errors/exception.filter';
import { loadEnv } from '../src/config/env';
import { sql } from './helpers';

// Audit PS-04 / PCL-10: the API (and the in-process worker) crashed with "Unhandled 'error' event ... BoundPool" when
// Postgres terminated an idle pooled connection (failover, pooler restart, pg_terminate_backend). The pool also had
// no connect timeout, no statement or idle-in-transaction timeout, and ran OLTP queries with JIT on.

const APP = 'resuto-api'; // DbService's application_name; only this file's pools use it in the test database
let db: DbService;
const unhandled: unknown[] = [];
const onUncaught = (e: unknown) => { unhandled.push(e); };

async function backends(state?: string) {
  return sql<{ pid: number }>(`select pid from pg_stat_activity where application_name = $1 and datname = current_database()
    ${state ? 'and state = $2' : ''}`, state ? [APP, state] : [APP]);
}
async function terminateAll() {
  await sql(`select pg_terminate_backend(pid) from pg_stat_activity where application_name = $1 and datname = current_database()`, [APP]);
}
const until = async (cond: () => Promise<boolean>, ms = 3000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await cond()) return; await new Promise((r) => setTimeout(r, 25)); }
  throw new Error('condition not met in time');
};

beforeAll(() => {
  process.on('uncaughtException', onUncaught);
  db = new DbService({ ...loadEnv(), DATABASE_POOL_MAX: 3, DATABASE_STATEMENT_TIMEOUT_MS: 400 } as any);
});
afterEach(() => { expect(unhandled).toEqual([]); });
afterAll(async () => {
  process.off('uncaughtException', onUncaught);
  await db?.onModuleDestroy();
});

describe('database connection resilience', () => {
  it('survives Postgres terminating idle pooled connections and serves the next request', async () => {
    await Promise.all([1, 2, 3].map(() => db.withPlatform((tx) => tx.query('select pg_sleep(0.05)'))));
    await until(async () => (await backends('idle')).length >= 1);
    await terminateAll();
    await until(async () => (await backends()).length === 0);
    await new Promise((r) => setTimeout(r, 100)); // let the pool notice the dead sockets
    const [row] = await db.withPlatform((tx) => tx.query<{ ok: number }>('select 1 as ok'));
    expect(row.ok).toBe(1);
  });

  it('a connection killed while a transaction waits (checked out, idle) fails that request only; the pool recovers', async () => {
    const outcome = db.withPlatform(async (tx) => {
      await tx.query('select 1');
      await terminateAll();
      await new Promise((r) => setTimeout(r, 150));
      return tx.query('select 2');
    });
    await expect(outcome).rejects.toThrow();
    for (let i = 0; i < 4; i++) expect((await db.withPlatform((tx) => tx.query<{ n: number }>('select 3 as n')))[0].n).toBe(3);
  });

  it('runs every transaction with jit off, a statement timeout and an idle-in-transaction timeout', async () => {
    const [s] = await db.withPlatform((tx) => tx.query<any>(
      `select current_setting('jit') as jit, current_setting('statement_timeout') as st,
              current_setting('idle_in_transaction_session_timeout') as itx`));
    expect(s).toEqual({ jit: 'off', st: '400ms', itx: '30s' });
    await expect(db.withPlatform((tx) => tx.query('select pg_sleep(2)'))).rejects.toMatchObject({ code: '57014' });
    // the same settings apply in member/tenant mode (role switch inside the transaction)
    const [m] = await db.withTenant('6f1c2a40-0000-4000-8000-000000000001', (tx) => tx.query<any>(`select current_setting('jit') as jit`));
    expect(m.jit).toBe('off');
  });

  it('a long export can raise its own statement timeout inside the transaction', async () => {
    const [r] = await db.withPlatform(async (tx) => {
      await tx.query(`select set_config('statement_timeout', '5s', true)`);
      return tx.query<{ ok: boolean }>(`select true as ok from pg_sleep(0.6)`);
    });
    expect(r.ok).toBe(true);
  });

  it('gives up waiting for a connection after the connect timeout instead of queueing forever', async () => {
    const small = new DbService({ ...loadEnv(), DATABASE_POOL_MAX: 1, DATABASE_CONNECT_TIMEOUT_MS: 200 } as any);
    try {
      const hold = small.withPlatform((tx) => tx.query('select pg_sleep(0.8)'));
      const t0 = Date.now();
      await expect(small.withPlatform((tx) => tx.query('select 1'))).rejects.toMatchObject({ code: 'db_unavailable' });
      expect(Date.now() - t0).toBeLessThan(700);
      await hold;
    } finally {
      await small.onModuleDestroy();
    }
  });
});

describe('transient database failures reach clients as 503 with Retry-After', () => {
  const respond = (exception: unknown) => {
    const out: { status?: number; body?: any; headers: Record<string, string> } = { headers: {} };
    const res: any = {
      setHeader: (k: string, v: string) => { out.headers[k.toLowerCase()] = v; },
      status: (code: number) => { out.status = code; return res; },
      json: (body: unknown) => { out.body = body; return res; },
    };
    const host: any = { switchToHttp: () => ({ getResponse: () => res, getRequest: () => ({ id: 'req-test-0001' }) }) };
    new ApiExceptionFilter().catch(exception, host);
    return out;
  };

  it('maps statement timeouts, terminated backends and pool exhaustion to 503', () => {
    for (const [err, code] of [[Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' }), 'db_timeout'],
      [Object.assign(new Error('terminating connection due to administrator command'), { code: '57P01' }), 'db_unavailable'],
      [dbUnavailable(new Error('timeout exceeded when trying to connect')), 'db_unavailable']] as const) {
      const r = respond(err);
      expect(r.status).toBe(503);
      expect(r.body.error.code).toBe(code);
      expect(r.headers['retry-after']).toBe('2');
      expect(JSON.stringify(r.body)).not.toContain('administrator'); // no driver internals in the response
    }
  });

  it('sends Retry-After with rate limits (seconds, rounded up)', () => {
    const r = respond(new DomainError('rate_limited', 'Too many requests. Please slow down.', 429, { retryAfterMs: 1500 }));
    expect(r.status).toBe(429);
    expect(r.headers['retry-after']).toBe('2');
  });
});
