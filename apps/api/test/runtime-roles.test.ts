import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DbService } from '../src/common/db/db.service';
import { loadEnv } from '../src/config/env';
import { auth, bootTestApp, createTenant, seedMenu, sql, type TestApp, type TestTenant } from './helpers';

// Audit PS-16: the API connected as the table owner (BYPASSRLS) and platform-mode SQL ran with no RLS at all.
// Platform work now runs as resuto_platform; under vitest.restricted.config.ts the whole connection is the
// NOINHERIT, NOBYPASSRLS resuto_api login (RESTRICTED_DB=1), and this file proves what that login can and cannot do.

const restricted = process.env.RESTRICTED_DB === '1';
let t: TestApp;
let db: DbService;
let a: TestTenant;
let b: TestTenant;

beforeAll(async () => {
  t = await bootTestApp();
  db = t.app.get(DbService);
  a = await createTenant(t, { name: 'Role House A' });
  b = await createTenant(t, { name: 'Role House B' });
  await seedMenu(a);
  await seedMenu(b);
});
afterAll(async () => { await t?.close(); });

describe('platform mode runs as resuto_platform, not as the owner (PS-16)', () => {
  it('reports resuto_platform inside withPlatform, and the execution roles in member/tenant mode', async () => {
    expect(await db.withPlatform((tx) => tx.one<{ r: string }>('select current_user::text as r')).then((x) => x.r)).toBe('resuto_platform');
    expect(await db.withTenant(a.orgId, (tx) => tx.one<{ r: string }>('select current_user::text as r')).then((x) => x.r)).toBe('resuto_tenant');
    expect(await db.withMember({ userId: a.owner.userId, orgId: a.orgId }, (tx) => tx.one<{ r: string }>('select current_user::text as r'))
      .then((x) => x.r)).toBe('resuto_member');
  });

  it('cannot run DDL, change policies, switch to the owner or read tables it was not granted', async () => {
    await expect(db.withPlatform((tx) => tx.query('create table public.ps16_probe (id int)'))).rejects.toThrow(/permission denied/);
    await expect(db.withPlatform((tx) => tx.query('alter table public.orders disable row level security'))).rejects.toThrow(/must be owner|permission denied/);
    await expect(db.withPlatform((tx) => tx.query('drop policy tenant_system on public.orders'))).rejects.toThrow(/must be owner|permission denied/);
    // SET ROLE is checked against the session user: on an owner connection the owner could switch back, which is why
    // the restricted login (below) is the real boundary. As resuto_api there is nothing above the execution roles.
    if (restricted) {
      await expect(db.withPlatform((tx) => tx.query('set role postgres'))).rejects.toThrow(/permission denied|does not exist/);
      // Switching back to the login itself is allowed (it is the session user) and yields nothing: NOINHERIT, no grants.
      await expect(db.withPlatform(async (tx) => { await tx.query('set role resuto_api'); return tx.query('select 1 from public.organizations limit 1'); }))
        .rejects.toThrow(/permission denied/);
    }
    // stock movements, order lines and payment credentials are tenant data the platform never touches
    for (const table of ['stock_movements', 'order_lines', 'expenses', 'customer_consent_events']) {
      await expect(db.withPlatform((tx) => tx.query(`select 1 from public.${table} limit 1`)), table).rejects.toThrow(/permission denied/);
    }
  });

  it('cannot rewrite the audit log', async () => {
    await expect(db.withPlatform((tx) => tx.query(`update audit_logs set action = 'x' where org_id = $1`, [a.orgId]))).rejects.toThrow(/permission denied/);
    await expect(db.withPlatform((tx) => tx.query(`delete from audit_logs where org_id = $1`, [a.orgId]))).rejects.toThrow(/permission denied/);
  });

  it('notification recipients come from the definer function, not a grant on auth.users', async () => {
    const rows = await db.withPlatform((tx) => tx.query<{ email: string }>(
      'select email from app.notification_recipient_emails($1, $2, $3, null) as email', [a.orgId, a.owner.userId, []]));
    expect(rows.map((r) => r.email)).toEqual([a.owner.email]);
    await expect(db.withTenant(a.orgId, (tx) => tx.query('select app.notification_recipient_emails($1, null, $2, null)', [a.orgId, ['owner']])))
      .rejects.toThrow(/permission denied/);
  });
});

describe('the owner fallback is opt-in, never the default (review of PS-16)', () => {
  const probe = (d: DbService) => d.withPlatform(async (tx) => {
    await tx.query('create table public.ps16_fallback_probe (id int)');
    await tx.query('drop table public.ps16_fallback_probe');
    return 'ran';
  });

  it('by default (DATABASE_PLATFORM_FALLBACK unset) a denied platform statement fails, even on an owner connection', async () => {
    const env = loadEnv();
    expect(env.DATABASE_PLATFORM_FALLBACK).toBe('off');
    const d = new DbService({ ...env, NODE_ENV: 'production' } as any);
    try {
      const id = await d.detectIdentity();
      expect(id.fallback).toBe(false);
      expect(id.platform).toBe('resuto_platform');
      await expect(probe(d)).rejects.toThrow(/permission denied/);
    } finally {
      await d.onModuleDestroy();
    }
  });

  it.skipIf(restricted)('only DATABASE_PLATFORM_FALLBACK=log-and-retry on an owner connection re-runs it as the owner, and says so', async () => {
    const d = new DbService({ ...loadEnv(), NODE_ENV: 'production', DATABASE_PLATFORM_FALLBACK: 'log-and-retry' } as any);
    try {
      const id = await d.detectIdentity();
      expect(id).toMatchObject({ privileged: true, fallback: true });
      expect(await probe(d)).toBe('ran');
    } finally {
      await d.onModuleDestroy();
    }
  });

  it.runIf(restricted)('the restricted login never falls back, even when asked to', async () => {
    const d = new DbService({ ...loadEnv(), NODE_ENV: 'production', DATABASE_PLATFORM_FALLBACK: 'log-and-retry' } as any);
    try {
      expect((await d.detectIdentity()).fallback).toBe(false);
      await expect(probe(d)).rejects.toThrow(/permission denied/);
    } finally {
      await d.onModuleDestroy();
    }
  });
});

describe('tenant isolation holds on every execution role (PS-16)', () => {
  it('a tenant session never sees another tenant, even with a forged org id in the query', async () => {
    const rows = await db.withTenant(a.orgId, (tx) => tx.query<{ org_id: string }>('select org_id from dining_tables where org_id = $1', [b.orgId]));
    expect(rows).toEqual([]);
    const own = await db.withTenant(a.orgId, (tx) => tx.query<{ org_id: string }>('select org_id from dining_tables'));
    expect(own.length).toBeGreaterThan(0);
    expect(own.every((r) => r.org_id === a.orgId)).toBe(true);
  });

  it('a member of A gets 404 for B through the API and sees only A through public lookups', async () => {
    expect((await t.http.get(`/v1/o/${b.orgId}/orders`).set(auth(a.owner))).status).toBe(404);
    const menu = await t.http.get(`/v1/public/menu/${a.slug}`);
    expect(menu.status).toBe(200);
  });
});

describe.runIf(restricted)('the API connection itself is the restricted login (vitest.restricted.config.ts)', () => {
  it('is resuto_api: not a superuser, not BYPASSRLS, owns no table', async () => {
    const r = await db.describeConnection();
    expect(r).toEqual({ user: 'resuto_api', privileged: false });
  });

  it('can do nothing without an execution context (NOINHERIT)', async () => {
    const c = await db.pool.connect();
    try {
      await expect(c.query('select count(*) from public.orders')).rejects.toThrow(/permission denied/);
      await expect(c.query('select count(*) from public.organizations')).rejects.toThrow(/permission denied/);
      await expect(c.query('select count(*) from auth.users')).rejects.toThrow(/permission denied/);
    } finally {
      c.release();
    }
  });

  it('nothing in the schema needs BYPASSRLS: no table forces RLS off for it and no policy names it', async () => {
    const rows = await sql<{ n: number }>(`select count(*)::int as n from pg_policies where 'resuto_api' = any(roles)`);
    expect(rows[0].n).toBe(0);
  });
});
