import { Inject, Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import pg from 'pg';
import { ENV, type Env } from '../../config/env';
import type { TenantContext } from '../auth/context';
import { DomainError } from '../errors/domain-error';
import { requestContext } from '../http/request-context';
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

/** The database is unreachable or saturated right now: answer 503 with Retry-After rather than hang or crash. */
export const dbUnavailable = (cause?: unknown) => Object.assign(
  new DomainError('db_unavailable', 'The service is busy. Please retry in a moment.', 503, { retryAfterSeconds: 2 }), { cause });

/**
 * All database access goes through one of three execution contexts
 * (docs/architecture/SECURITY_MODEL.md):
 *
 * - withMember: a signed-in staff user inside one tenant. RLS checks membership.
 * - withTenant: a guest, webhook or job inside one tenant. RLS pins app.org_id.
 * - withPlatform: cross-tenant lookups and platform administration, as the
 *   resuto_platform role (PS-16): only the tables and commands granted to it in
 *   supabase/migrations/20261022030001_runtime_roles.sql, never DDL, never BYPASSRLS.
 *   Use only from code that resolves a tenant or is platform-admin guarded.
 *
 * The connection itself can be the schema owner (today's single DATABASE_URL) or the restricted resuto_api login
 * (NOINHERIT: it can do nothing until one of the three contexts above sets its role).
 */
@Injectable()
export class DbService implements OnModuleDestroy, OnApplicationBootstrap {
  readonly pool: pg.Pool;
  private readonly logger = new Logger('Db');
  /** SET LOCAL values applied at the start of every transaction (pooler-safe: nothing persists on the session). */
  private readonly txSettings: [string, string, string];
  /** `set local role` for platform mode, or null to keep the connection's own role (DATABASE_PLATFORM_ROLE=off). */
  private readonly platformRole: string | null;

  constructor(@Inject(ENV) env: Env) {
    this.pool = new pg.Pool({
      ...pgClientConfig(env.DATABASE_URL, env.DATABASE_SSL_CA),
      max: env.DATABASE_POOL_MAX,
      application_name: 'resuto-api',
      connectionTimeoutMillis: env.DATABASE_CONNECT_TIMEOUT_MS,
      idleTimeoutMillis: 30_000,
      keepAlive: true,
    });
    // An idle pooled connection can be terminated by Postgres or the pooler (restart, failover, pg_terminate_backend).
    // Without a listener, pg re-emits that as an unhandled 'error' and the process exits; the pool already drops the
    // dead client, so logging is all that is needed.
    this.pool.on('error', (err) => this.logger.warn(`idle database connection closed: ${(err as any).code ?? ''} ${err.message}`));
    // JIT compilation costs 250+ ms on small OLTP queries (KDS) and never pays off here.
    this.txSettings = [`${env.DATABASE_STATEMENT_TIMEOUT_MS}ms`, `${env.DATABASE_IDLE_TX_TIMEOUT_MS}ms`, 'off'];
    this.platformRole = env.DATABASE_PLATFORM_ROLE === 'off' ? null : env.DATABASE_PLATFORM_ROLE;
    this.fallbackMode = env.DATABASE_PLATFORM_FALLBACK ?? 'off';
    this.nodeEnv = env.NODE_ENV;
  }

  private readonly nodeEnv: Env['NODE_ENV'];
  private readonly fallbackMode: 'off' | 'log-and-retry';
  /**
   * Retry a platform transaction as the connection's own role after a permission error. Only with the explicit opt-in
   * DATABASE_PLATFORM_FALLBACK=log-and-retry on an owner connection (review of PS-16): by default the platform role
   * is enforced and a missing grant fails the request.
   */
  private ownerFallback = false;

  /** Logs which database identity the API runs as (owner or restricted), so a deploy shows its least-privilege state. */
  async onApplicationBootstrap() {
    if (this.nodeEnv === 'test') return;
    try {
      await this.detectIdentity();
    } catch (e) {
      this.logger.warn(`could not read the database role at boot: ${(e as Error).message}`);
    }
  }

  /** Reads the connection's identity, decides the owner fallback and reports both (boot; tests call it directly). */
  async detectIdentity(): Promise<{ user: string; privileged: boolean; platform: string; fallback: boolean }> {
    const r = await this.describeConnection();
    this.ownerFallback = this.fallbackMode === 'log-and-retry' && r.privileged && !!this.platformRole;
    const platform = !this.platformRole ? 'the connection role (DATABASE_PLATFORM_ROLE=off: not restricted)'
      : this.ownerFallback ? `${this.platformRole}, NOT enforced: DATABASE_PLATFORM_FALLBACK=log-and-retry re-runs a denied transaction as ${r.user}`
        : r.privileged ? `${this.platformRole} (ungranted statements fail; not a boundary on an owner connection: switch DATABASE_URL to resuto_api)`
          : `${this.platformRole} (enforced)`;
    const line = `database role ${r.user} (${r.privileged ? 'owner/privileged: RLS bypass possible outside the execution roles' : 'restricted'}); `
      + `platform mode runs as ${platform}`;
    if (this.ownerFallback) this.logger.warn(line);
    else this.logger.log(line);
    return { ...r, platform: this.platformRole ?? r.user, fallback: this.ownerFallback };
  }

  /** The session user and whether it can bypass RLS (superuser, BYPASSRLS or table owner). */
  async describeConnection(): Promise<{ user: string; privileged: boolean }> {
    return this.withClient(async (c) => {
      const { rows } = await c.query(`select current_user::text as user, (r.rolsuper or r.rolbypassrls
          or exists (select 1 from pg_class t join pg_namespace n on n.oid = t.relnamespace where n.nspname = 'public' and t.relowner = r.oid)) as privileged
        from pg_roles r where r.rolname = current_user`);
      return rows[0];
    });
  }

  async onModuleDestroy() {
    await this.pool.end();
  }

  /*
   * Transaction callbacks (scoped / withMember / withTenant / withPlatform) must be free of external side effects:
   * a serialization failure or deadlock (40001 / 40P01) re-runs the whole callback, and every callback holds one of a
   * few pooled connections while it runs. Provider calls, storage uploads and URL signing therefore happen before or
   * after the transaction (PCL-11): see MessagingService.sendOne (claim, send, record), StorageService.store/record
   * and MediaUrls (sign after commit). test/side-effects-guard.test.ts flags adapter calls inside callbacks.
   */

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

  /** Checks out a client, failing with 503 db_unavailable when none frees up within DATABASE_CONNECT_TIMEOUT_MS. */
  async connect(): Promise<pg.PoolClient> {
    try {
      return await this.pool.connect();
    } catch (error) {
      throw dbUnavailable(error);
    }
  }

  /**
   * Runs `fn` on a checked-out client that is guarded against connection loss: an error emitted while the client is
   * checked out but idle (e.g. awaiting other work) is captured instead of crashing the process, and a broken client
   * is destroyed on release instead of being returned to the pool.
   */
  async withClient<T>(fn: (client: pg.PoolClient, broken: () => Error | undefined) => Promise<T>): Promise<T> {
    const client = await this.connect();
    let broken: Error | undefined;
    const onError = (e: Error) => { broken ??= e; };
    client.on('error', onError);
    try {
      return await fn(client, () => broken);
    } catch (error) {
      // pg marks a client whose socket or backend is gone as not queryable (the error itself may be a 57P01, an
      // ECONNRESET or "Connection terminated"); an error thrown by unrelated work inside fn leaves it queryable.
      if (!broken && (client as unknown as { _queryable?: boolean })._queryable === false) broken = error as Error;
      if (broken) {
        this.logger.warn(`database connection lost: ${(broken as any).code ?? ''} ${broken.message}`);
        throw dbUnavailable(error);
      }
      throw error;
    } finally {
      client.off('error', onError);
      client.release(broken);
    }
  }

  private async run<T>(ctx: ExecutionContextInfo, fn: (tx: Tx) => Promise<T>, attempt = 1, asOwner = false): Promise<T> {
    let retry = false;
    let retryAsOwner = false;
    const result = await this.withClient(async (client, broken) => {
      try {
        await client.query('begin');
        await client.query(
          `select set_config('request.jwt.claims', $1, true), set_config('app.org_id', $2, true), set_config('app.actor', $3, true),
                  set_config('statement_timeout', $4, true), set_config('idle_in_transaction_session_timeout', $5, true),
                  set_config('jit', $6, true), set_config('app.request_id', $7, true)`,
          [ctx.userId ? JSON.stringify({ sub: ctx.userId, role: 'authenticated' }) : '', ctx.orgId ?? '', ctx.actor, ...this.txSettings,
            requestContext.requestId() ?? ''],
        );
        if (ctx.mode === 'member') await client.query('set local role resuto_member');
        if (ctx.mode === 'tenant') await client.query('set local role resuto_tenant');
        if (ctx.mode === 'platform' && this.platformRole && !asOwner) await client.query(`set local role ${this.platformRole}`);
        const value = await fn(wrap(client, ctx));
        await client.query('commit');
        return value;
      } catch (error: any) {
        // A failed rollback means the connection itself is gone; withClient then destroys the client.
        if (!broken()) await client.query('rollback').catch(() => undefined);
        if (error?.code === '42501' && ctx.mode === 'platform' && this.ownerFallback && !asOwner) {
          this.logger.error(`platform role lacks a grant (${ctx.actor}; request ${requestContext.requestId() ?? '-'}): ${error.message}; `
            + 'transaction re-run as the connection role (DATABASE_PLATFORM_FALLBACK=log-and-retry). Add the grant (app.grant_platform).');
          retryAsOwner = true;
          return undefined as T;
        }
        // serialization failures and deadlocks are retried below on a fresh connection
        if (!RETRYABLE.has(error?.code) || attempt >= 3) throw error;
        retry = true;
        return undefined as T;
      }
    });
    if (retryAsOwner) return this.run(ctx, fn, attempt, true);
    return retry ? this.run(ctx, fn, attempt + 1, asOwner) : result;
  }
}

