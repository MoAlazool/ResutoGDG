import { Injectable } from '@nestjs/common';
import {
  DEFAULT_INTEGRATION_SOURCE_OF_TRUTH, type CreateIntegrationConnection, type IntegrationConnectionView, type IntegrationSourceOfTruth,
  type UpdateIntegrationConnection,
} from '@resuto/contracts';
import { ProviderError, type AdapterContext } from '@resuto/integrations';
import type { TenantContext } from '../../common/auth/context';
import { SecretBox } from '../../common/crypto/secret-box';
import { DbService, type Tx } from '../../common/db/db.service';
import { DomainError, conflict, invalid, notFound } from '../../common/errors/domain-error';
import { AuditService } from '../../common/platform/audit.service';
import { adapterFor, credentialsHint, fieldsFor } from './catalog';
import { ProviderHttp } from './provider-http';

/** Columns member sessions may read (credentials_encrypted is not among them). */
export const SAFE_COLUMNS = `id, org_id, branch_id, provider, category, auth_type, environment, status, enabled, credentials_hint, config, scopes,
  source_of_truth, health, last_health_check_at, last_error, rate_limit, connected_by, connected_at, created_at, updated_at`;

export interface LoadedConnection {
  id: string;
  orgId: string;
  provider: string;
  category: string;
  environment: 'sandbox' | 'live';
  status: string;
  enabled: boolean;
  config: Record<string, unknown>;
  sourceOfTruth: Required<IntegrationSourceOfTruth>;
  adapter: AdapterContext;
}

const iso = (v: Date | string | null) => (v ? new Date(v).toISOString() : null);

export function toView(r: any): IntegrationConnectionView {
  return {
    id: r.id, provider: r.provider, category: r.category, branchId: r.branch_id, authType: r.auth_type, environment: r.environment,
    status: r.status, enabled: r.enabled, credentialsHint: r.credentials_hint, config: r.config ?? {},
    sourceOfTruth: { ...DEFAULT_INTEGRATION_SOURCE_OF_TRUTH, ...(r.source_of_truth ?? {}), orders: 'resuto' },
    health: r.health ?? {}, lastHealthCheckAt: iso(r.last_health_check_at), lastError: r.last_error,
    readiness: adapterFor(r.provider)?.descriptor.readiness ?? null, connectedAt: iso(r.connected_at),
    createdAt: iso(r.created_at)!, updatedAt: iso(r.updated_at)!,
  };
}

/**
 * Per-tenant provider connections. Credentials are sealed with SecretBox
 * (aad = "<orgId>:<provider>") and only ever decrypted in tenant mode for an
 * adapter call; API responses carry credentials_hint only.
 */
@Injectable()
export class IntegrationConnectionsService {
  constructor(
    private readonly db: DbService,
    private readonly box: SecretBox,
    private readonly audit: AuditService,
    private readonly http: ProviderHttp,
  ) {}

  list(ctx: TenantContext, filter: { category?: string } = {}) {
    return this.db.scoped(ctx, async (tx) => {
      const rows = await tx.query(`select ${SAFE_COLUMNS} from integration_connections where org_id = $1 and ($2::text is null or category = $2)
         order by category, provider`, [ctx.orgId, filter.category ?? null]);
      return { items: rows.filter((r) => ctx.canAccessBranch(r.branch_id)).map(toView), nextCursor: null };
    });
  }

  get(ctx: TenantContext, id: string) {
    return this.db.scoped(ctx, async (tx) => toView(await this.row(tx, ctx, id)));
  }

  async row(tx: Tx, ctx: TenantContext, id: string) {
    const r = await tx.maybeOne(`select ${SAFE_COLUMNS} from integration_connections where id = $1 and org_id = $2`, [id, ctx.orgId]);
    if (!r) throw notFound('Connection');
    ctx.assertBranch(r.branch_id);
    return r;
  }

  async create(ctx: TenantContext, input: CreateIntegrationConnection) {
    const adapter = adapterFor(input.provider);
    if (!adapter) throw invalid('unknown_provider', `Unknown provider ${input.provider}`);
    ctx.assertBranch(input.branchId ?? null);
    const d = adapter.descriptor;
    const simulated = d.readiness === 'simulated';
    this.requireFields(input.provider, input.credentials, input.config, simulated);
    const environment = simulated ? 'sandbox' : input.environment;
    const hasCreds = Object.keys(input.credentials).length > 0;
    const status = simulated ? 'sandbox' : hasCreds ? 'pending' : 'not_configured';
    const sot = this.sourceOfTruth(input.sourceOfTruth);
    return this.db.scoped(ctx, async (tx) => {
      const exists = await tx.maybeOne(`select id from integration_connections where org_id = $1 and provider = $2 and branch_id is not distinct from $3`,
        [ctx.orgId, input.provider, input.branchId ?? null]);
      if (exists) throw conflict('connection_exists', 'This provider is already connected. Update or revoke the existing connection.', { id: exists.id });
      const { id } = await tx.one<{ id: string }>(
        `insert into integration_connections(org_id, branch_id, provider, category, auth_type, environment, status, credentials_encrypted,
            credentials_hint, config, source_of_truth, connected_by, connected_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, case when $13 then now() end) returning id`,
        [ctx.orgId, input.branchId ?? null, input.provider, d.category, d.authType, environment, status,
          hasCreds ? this.box.sealJson(input.credentials, `${ctx.orgId}:${input.provider}`) : null,
          credentialsHint(input.credentials), input.config, sot, ctx.userId, hasCreds || simulated]);
      await this.log(tx, ctx.orgId, id, 'info', `Connection created (${environment})`, { provider: input.provider, status });
      await this.audit.record(tx, ctx, { action: 'integration.connected', entityType: 'integration_connection', entityId: id, branchId: input.branchId ?? null,
        metadata: { provider: input.provider, environment } });
      return toView(await this.row(tx, ctx, id));
    });
  }

  async update(ctx: TenantContext, id: string, input: UpdateIntegrationConnection) {
    return this.db.scoped(ctx, async (tx) => {
      const r = await this.row(tx, ctx, id);
      if (r.status === 'revoked' && !input.credentials) throw conflict('connection_revoked', 'Reconnect with new credentials first');
      const simulated = adapterFor(r.provider)?.descriptor.readiness === 'simulated';
      if (input.credentials || input.config) this.requireFields(r.provider, input.credentials ?? null, input.config ?? r.config, simulated);
      const sets: string[] = [];
      const params: unknown[] = [id];
      const set = (sql: string, v: unknown) => { params.push(v); sets.push(sql.replace('?', `$${params.length}`)); };
      if (input.environment && !simulated) set('environment = ?', input.environment);
      if (input.config) set('config = ?', input.config);
      if (input.sourceOfTruth) set('source_of_truth = ?', this.sourceOfTruth({ ...r.source_of_truth, ...input.sourceOfTruth }));
      if (input.credentials) {
        set('credentials_encrypted = ?', Object.keys(input.credentials).length ? this.box.sealJson(input.credentials, `${ctx.orgId}:${r.provider}`) : null);
        set('credentials_hint = ?', credentialsHint(input.credentials));
        if (!simulated) set('status = ?', Object.keys(input.credentials).length ? 'pending' : 'not_configured');
        sets.push('last_error = null', 'connected_at = coalesce(connected_at, now())');
        set('connected_by = ?', ctx.userId);
      }
      if (sets.length) await tx.query(`update integration_connections set ${sets.join(', ')} where id = $1`, params);
      await this.log(tx, ctx.orgId, id, 'info', 'Connection updated', { fields: Object.keys(input) });
      await this.audit.record(tx, ctx, { action: 'integration.updated', entityType: 'integration_connection', entityId: id, branchId: r.branch_id,
        metadata: { provider: r.provider, fields: Object.keys(input) } });
      return toView(await this.row(tx, ctx, id));
    });
  }

  async setEnabled(ctx: TenantContext, id: string, enabled: boolean) {
    return this.db.scoped(ctx, async (tx) => {
      const r = await this.row(tx, ctx, id);
      if (r.status === 'revoked' && enabled) throw conflict('connection_revoked', 'Reconnect with new credentials first');
      await tx.query(`update integration_connections set enabled = $2 where id = $1`, [id, enabled]);
      await this.log(tx, ctx.orgId, id, 'info', enabled ? 'Connection enabled' : 'Connection disabled');
      await this.audit.record(tx, ctx, { action: enabled ? 'integration.enabled' : 'integration.disabled', entityType: 'integration_connection', entityId: id, branchId: r.branch_id });
      return toView(await this.row(tx, ctx, id));
    });
  }

  /** Destroys the stored credentials (they cannot be recovered) and switches the connection off. */
  async revoke(ctx: TenantContext, id: string) {
    return this.db.scoped(ctx, async (tx) => {
      const r = await this.row(tx, ctx, id);
      await tx.query(`update integration_connections set credentials_encrypted = null, credentials_hint = null, status = 'revoked', enabled = false,
          health = '{}'::jsonb where id = $1`, [id]);
      await this.log(tx, ctx.orgId, id, 'warn', 'Connection revoked; credentials deleted');
      await this.audit.record(tx, ctx, { action: 'integration.revoked', entityType: 'integration_connection', entityId: id, branchId: r.branch_id, metadata: { provider: r.provider } });
      return toView(await this.row(tx, ctx, id));
    });
  }

  async remove(ctx: TenantContext, id: string) {
    return this.db.scoped(ctx, async (tx) => {
      const r = await this.row(tx, ctx, id);
      if (r.status !== 'revoked' && r.status !== 'not_configured' && r.status !== 'sandbox') {
        throw conflict('revoke_first', 'Revoke the connection before deleting it');
      }
      await tx.query(`delete from integration_connections where id = $1`, [id]);
      await this.audit.record(tx, ctx, { action: 'integration.deleted', entityType: 'integration_connection', entityId: id, branchId: r.branch_id, metadata: { provider: r.provider } });
      return { id, deleted: true };
    });
  }

  /**
   * Decrypts a connection for an adapter call. Runs in tenant mode: member
   * sessions cannot select credentials_encrypted.
   */
  async load(orgId: string, where: { id?: string; provider?: string; category?: string }): Promise<LoadedConnection> {
    return this.db.withTenant(orgId, async (tx) => {
      const r = await tx.maybeOne<any>(
        `select id, org_id, provider, category, environment, status, enabled, config, source_of_truth, credentials_encrypted
           from integration_connections where org_id = $1 and ($2::uuid is null or id = $2) and ($3::text is null or provider = $3)
            and ($4::text is null or category = $4)
          order by (status = 'connected') desc, updated_at desc limit 1`,
        [orgId, where.id ?? null, where.provider ?? null, where.category ?? null]);
      if (!r) throw notFound('Connection');
      return this.materialise(r);
    }, 'integration');
  }

  /** Like load(), inside an existing tenant-mode transaction. */
  async loadInTx(tx: Tx, id: string): Promise<LoadedConnection> {
    if (tx.ctx.mode !== 'tenant') throw new Error('credentials can only be read in tenant mode');
    const r = await tx.maybeOne<any>(
      `select id, org_id, provider, category, environment, status, enabled, config, source_of_truth, credentials_encrypted from integration_connections where id = $1`, [id]);
    if (!r) throw notFound('Connection');
    return this.materialise(r);
  }

  private materialise(r: any): LoadedConnection {
    const credentials = r.credentials_encrypted ? this.box.openJson<Record<string, string>>(r.credentials_encrypted, `${r.org_id}:${r.provider}`) : {};
    return {
      id: r.id, orgId: r.org_id, provider: r.provider, category: r.category, environment: r.environment, status: r.status, enabled: r.enabled,
      config: r.config ?? {}, sourceOfTruth: { ...DEFAULT_INTEGRATION_SOURCE_OF_TRUTH, ...(r.source_of_truth ?? {}), orders: 'resuto' },
      adapter: { environment: r.environment, credentials, config: r.config ?? {}, fetch: this.http.fetch },
    };
  }

  /** Calls the adapter's healthCheck and records health/status/last_error. */
  async healthCheck(ctx: TenantContext, id: string) {
    const view = await this.get(ctx, id);
    if (view.status === 'revoked') throw conflict('connection_revoked', 'This connection was revoked');
    this.assertNotRateLimited(await this.rateLimit(ctx.orgId, id));
    const adapter = adapterFor(view.provider);
    const conn = await this.load(ctx.orgId, { id });
    let health: Record<string, unknown>;
    let status: string = view.status;
    let error: string | null = null;
    if (!adapter?.healthCheck) {
      health = { ok: null, note: 'This provider has no health check yet' };
    } else {
      try {
        const res = await adapter.healthCheck(conn.adapter);
        health = { ok: res.ok, ...(res.details ? { details: res.details } : {}) };
        if (adapter.descriptor.readiness === 'simulated') status = 'sandbox';
        else status = res.ok ? 'connected' : 'error';
        if (!res.ok) error = 'Provider reported the account as not ready';
      } catch (e) {
        error = e instanceof ProviderError ? e.message : `Health check failed: ${(e as Error).message}`;
        health = { ok: false, error };
        status = 'error';
        if (e instanceof ProviderError && e.status === 429) await this.markRateLimited(ctx.orgId, id, e.retryAfterMs);
      }
    }
    return this.db.withTenant(ctx.orgId, async (tx) => {
      await tx.query(`update integration_connections set health = $2, status = $3::integration_status, last_error = $4, last_health_check_at = now() where id = $1`,
        [id, { ...health, checkedAt: new Date().toISOString() }, status, error]);
      await this.log(tx, ctx.orgId, id, error ? 'error' : 'info', error ? `Health check failed: ${error}` : 'Health check passed', health);
      return toView(await tx.one(`select ${SAFE_COLUMNS} from integration_connections where id = $1`, [id]));
    }, `${ctx.actorType}:${ctx.actorId}`);
  }

  // ---------------------------------------------------------------------------
  // Rate limits: a provider 429 pauses calls on that connection until Retry-After.
  // ---------------------------------------------------------------------------
  async rateLimit(orgId: string, id: string): Promise<{ limitedUntil?: string } | null> {
    return this.db.withTenant(orgId, (tx) => tx.maybeOne<{ rate_limit: any }>(`select rate_limit from integration_connections where id = $1`, [id]))
      .then((r) => r?.rate_limit ?? null);
  }

  assertNotRateLimited(rl: { limitedUntil?: string } | null) {
    if (rl?.limitedUntil && new Date(rl.limitedUntil).getTime() > Date.now()) {
      throw new DomainError('provider_rate_limited', 'The provider asked us to slow down. Try again later.', 429,
        { retryAfterMs: new Date(rl.limitedUntil).getTime() - Date.now() });
    }
  }

  async markRateLimited(orgId: string, id: string, retryAfterMs?: number) {
    const until = new Date(Date.now() + Math.min(Math.max(retryAfterMs ?? 60_000, 1_000), 3_600_000)).toISOString();
    await this.db.withTenant(orgId, (tx) => tx.query(`update integration_connections set rate_limit = $2 where id = $1`,
      [id, { limitedUntil: until, lastStatus: 429, at: new Date().toISOString() }]));
  }

  async log(tx: Tx, orgId: string, connectionId: string | null, level: 'debug' | 'info' | 'warn' | 'error', message: string, details: Record<string, unknown> = {}) {
    await tx.query(`insert into integration_logs(org_id, connection_id, level, message, details) values ($1, $2, $3, $4, $5)`,
      [orgId, connectionId, level, message.slice(0, 1000), details]);
  }

  logs(ctx: TenantContext, connectionId: string | null, limit: number, before?: number) {
    return this.db.scoped(ctx, async (tx) => {
      if (connectionId) await this.row(tx, ctx, connectionId);
      const rows = await tx.query(
        `select l.id, l.connection_id, c.provider, l.level, l.message, l.details, l.created_at from integration_logs l
           left join integration_connections c on c.id = l.connection_id
          where l.org_id = $1 and ($2::uuid is null or l.connection_id = $2) and ($3::bigint is null or l.id < $3)
          order by l.id desc limit $4`, [ctx.orgId, connectionId, before ?? null, limit]);
      return {
        items: rows.map((r) => ({ id: Number(r.id), connectionId: r.connection_id, provider: r.provider, level: r.level, message: r.message, details: r.details, createdAt: iso(r.created_at) })),
        nextCursor: rows.length === limit ? String(rows[rows.length - 1].id) : null,
      };
    });
  }

  private sourceOfTruth(input?: IntegrationSourceOfTruth | null): Required<IntegrationSourceOfTruth> {
    return { menu: input?.menu ?? DEFAULT_INTEGRATION_SOURCE_OF_TRUTH.menu, orders: 'resuto' };
  }

  private requireFields(provider: string, credentials: Record<string, string> | null, config: Record<string, unknown>, simulated: boolean) {
    if (simulated) return;
    const spec = fieldsFor(provider);
    const missing = [
      ...(credentials && Object.keys(credentials).length ? spec.credentials.filter((f) => f.required && !credentials[f.key]).map((f) => f.key) : []),
      ...spec.config.filter((f) => f.required && (config[f.key] === undefined || config[f.key] === null || config[f.key] === '')).map((f) => f.key),
    ];
    if (missing.length) throw invalid('missing_fields', `Missing: ${missing.join(', ')}`, { missing });
  }
}
