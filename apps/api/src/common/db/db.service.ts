import { Inject, Injectable, OnModuleDestroy } from '@nestjs/common';
import pg from 'pg';
import { ENV, type Env } from '../../config/env';
import type { TenantContext } from '../auth/context';
import { pgClientConfig } from './pg-tls';

// int8 (bigint) columns hold money in minor units; values stay far below 2^53,
// so parse them as numbers and fail loudly if one ever is not safe.
pg.types.setTypeParser(20, (v) => {
  const n = Number(v);
  if (!Number.isSafeInteger(n)) throw new RangeError(`bigint ${v} exceeds safe integer range`);
  return n;
});
// numeric stays a string unless explicitly converted by the caller (quantities, coordinates).
// date columns stay ISO strings (no timezone shifting).
pg.types.setTypeParser(1082, (v) => v);

export interface Tx {
  query<T = any>(sql: string, params?: unknown[]): Promise<T[]>;
  one<T = any>(sql: string, params?: unknown[]): Promise<T>;
  maybeOne<T = any>(sql: string, params?: unknown[]): Promise<T | null>;
  /** The execution context this transaction runs in. */
  readonly ctx: ExecutionContextInfo;
}

export interface ExecutionContextInfo {
  mode: 'member' | 'tenant' | 'platform';
  orgId: string | null;
  userId: string | null;
  actor: string;
}

export class NotFoundInDb extends Error {}

function wrap(client: pg.PoolClient, ctx: ExecutionContextInfo): Tx {
  return {
    ctx,
    async query(sql, params) {
      return (await client.query(sql, params as any[])).rows;
    },
    async one(sql, params) {
      const rows = (await client.query(sql, params as any[])).rows;
      if (rows.length !== 1) throw new NotFoundInDb(`Expected one row, got ${rows.length}`);
      return rows[0];
    },
    async maybeOne(sql, params) {
      const rows = (await client.query(sql, params as any[])).rows;
      if (rows.length > 1) throw new Error(`Expected at most one row, got ${rows.length}`);
      return rows[0] ?? null;
    },
  };
}

const RETRYABLE = new Set(['40001', '40P01']); // serialization failure, deadlock

/**
 * All database access goes through one of three execution contexts
 * (docs/architecture/SECURITY_MODEL.md):
 *
 * - withMember: a signed-in staff user inside one tenant. RLS checks membership.
 * - withTenant: a guest, webhook or job inside one tenant. RLS pins app.org_id.
 * - withPlatform: cross-tenant lookups and platform administration. No RLS;
 *   use only from code that resolves a tenant or is platform-admin guarded.
 */
@Injectable()
export class DbService implements OnModuleDestroy {
  readonly pool: pg.Pool;

  constructor(@Inject(ENV) env: Env) {
    this.pool = new pg.Pool({ ...pgClientConfig(env.DATABASE_URL, env.DATABASE_SSL_CA), max: env.DATABASE_POOL_MAX, application_name: 'resuto-api' });
  }

  async onModuleDestroy() {
    await this.pool.end();
  }

  /**
   * Runs in the strictest context available for this tenant actor: member mode
   * (membership-checked RLS) for staff users, tenant mode for MCP clients,
   * drivers acting through their own records, and system jobs.
   */
  scoped<T>(ctx: TenantContext, fn: (tx: Tx) => Promise<T>): Promise<T> {
    const actor = `${ctx.actorType}:${ctx.actorId}`;
    return ctx.userId && ctx.actorType === 'user'
      ? this.withMember({ userId: ctx.userId, orgId: ctx.orgId, actor }, fn)
      : this.withTenant(ctx.orgId, fn, actor);
  }

  withMember<T>(ctx: { userId: string; orgId: string; actor?: string }, fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.run({ mode: 'member', orgId: ctx.orgId, userId: ctx.userId, actor: ctx.actor ?? `user:${ctx.userId}` }, fn);
  }

  withTenant<T>(orgId: string, fn: (tx: Tx) => Promise<T>, actor = 'system'): Promise<T> {
    return this.run({ mode: 'tenant', orgId, userId: null, actor }, fn);
  }

  withPlatform<T>(fn: (tx: Tx) => Promise<T>, actor = 'platform'): Promise<T> {
    return this.run({ mode: 'platform', orgId: null, userId: null, actor }, fn);
  }

  private async run<T>(ctx: ExecutionContextInfo, fn: (tx: Tx) => Promise<T>, attempt = 1): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      await client.query(
        `select set_config('request.jwt.claims', $1, true), set_config('app.org_id', $2, true), set_config('app.actor', $3, true)`,
        [ctx.userId ? JSON.stringify({ sub: ctx.userId, role: 'authenticated' }) : '', ctx.orgId ?? '', ctx.actor],
      );
      if (ctx.mode === 'member') await client.query('set local role resuto_member');
      if (ctx.mode === 'tenant') await client.query('set local role resuto_tenant');
      const result = await fn(wrap(client, ctx));
      await client.query('commit');
      return result;
    } catch (error: any) {
      await client.query('rollback').catch(() => undefined);
      // serialization failures and deadlocks are retried below on a fresh connection
      if (!RETRYABLE.has(error?.code) || attempt >= 3) throw error;
    } finally {
      client.release();
    }
    return this.run(ctx, fn, attempt + 1);
  }
}
