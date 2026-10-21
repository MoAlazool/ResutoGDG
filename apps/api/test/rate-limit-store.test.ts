import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DbService } from '../src/common/db/db.service';
import { hashKey, RateLimiter } from '../src/common/http/rate-limiter';
import type { Env } from '../src/config/env';
import { bootTestApp, sql, type TestApp } from './helpers';

// Audit PS-13: limits were counted per API process, so two instances allowed twice every limit and a restart reset
// them. RATE_LIMIT_STORE=postgres shares the windows through public.rate_limit_windows.

let t: TestApp;
let db: DbService;
beforeAll(async () => { t = await bootTestApp(); db = t.app.get(DbService); });
afterAll(async () => { await t?.close(); });

const shared = () => new RateLimiter({ RATE_LIMIT_STORE: 'postgres' } as Env, db);
const refused = (fn: () => void) => { try { fn(); return false; } catch (e) { return (e as { status?: number }).status === 429; } };

describe('rate limits shared across instances (PS-13)', () => {
  it('two in-memory instances each allow the full limit (the finding)', () => {
    const a = new RateLimiter();
    const b = new RateLimiter();
    const key = `probe:${Date.now()}`;
    for (let i = 0; i < 5; i++) { a.hit(key, 5); b.hit(key, 5); }
    expect(a.store).toBe('memory');
    expect(refused(() => a.hit(key, 5))).toBe(true);
  });

  it('with the postgres store, hits on one instance count against the other', async () => {
    const a = shared();
    const b = shared();
    expect(a.store).toBe('postgres');
    const key = `ip:203.0.113.9:${Date.now()}`;
    for (let i = 0; i < 3; i++) a.hit(key, 5, 600_000);
    await a.flush();
    b.hit(key, 5, 600_000); // 4th in the shared window
    await b.flush();
    b.hit(key, 5, 600_000); // 5th: still allowed
    expect(refused(() => b.hit(key, 5, 600_000))).toBe(true); // 6th across both instances: refused
    await b.flush();
    // A has not read the shared total since its own flush (3), so one more hit passes there: the bounded overshoot
    // documented in rate-limiter.ts. Its next flush reads the total and from then on A refuses too.
    expect(refused(() => a.hit(key, 5, 600_000))).toBe(false);
    await a.flush();
    expect(refused(() => a.hit(key, 5, 600_000))).toBe(true);
    // Only a hash of the key is stored: no client address in the table.
    const rows = await sql<{ key_hash: string; count: number }>(`select key_hash, count from rate_limit_windows where key_hash = $1`, [hashKey(key)]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.count).toBeGreaterThanOrEqual(6);
    expect(JSON.stringify(await sql(`select * from rate_limit_windows`))).not.toContain('203.0.113.9');
  });

  it('fails open when the store is unreachable: counting continues in memory, traffic is not refused for that', async () => {
    const broken = { withPlatform: async () => { throw new Error('connection refused'); } } as unknown as DbService;
    const c = new RateLimiter({ RATE_LIMIT_STORE: 'postgres' } as Env, broken);
    const key = `down:${Date.now()}`;
    for (let i = 0; i < 3; i++) c.hit(key, 3);
    await c.flush();
    expect(refused(() => c.hit(key, 3))).toBe(true); // the local count still limits
    expect(refused(() => c.hit(`other:${Date.now()}`, 3))).toBe(false);
  });

  it('the table is reachable only by the platform role', async () => {
    await expect(db.withTenant('00000000-0000-4000-8000-000000000000', (tx) => tx.query('select 1 from rate_limit_windows limit 1')))
      .rejects.toThrow(/permission denied/);
  });
});
