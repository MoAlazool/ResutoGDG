import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  DEFAULT_INTEGRATION_SOURCE_OF_TRUTH, type CreateIntegrationConnection, type IntegrationConnectionView, type IntegrationSourceOfTruth,
  type UpdateIntegrationConnection,
} from '@resuto/contracts';
import { ProviderError, type AdapterContext } from '@resuto/integrations';
import type { TenantContext } from '../../common/auth/context';
import { ENV, type Env } from '../../config/env';
import { Scheduled } from '../../common/events/events';
import { SecretBox } from '../../common/crypto/secret-box';
import { DbService, type Tx } from '../../common/db/db.service';
import { DomainError, conflict, invalid, notFound } from '../../common/errors/domain-error';
import { AuditService } from '../../common/platform/audit.service';
import { adapterFor, catalogEntries, credentialsHint, fieldsFor, webhookFor } from './catalog';
import { providerReadiness, type VerificationRow } from './readiness';
import { ProviderHttp } from './provider-http';

/** Columns member sessions may read (credentials_encrypted is not among them). */
export const SAFE_COLUMNS = `id, org_id, branch_id, provider, category, auth_type, environment, status, enabled, credentials_hint, config, scopes,
  source_of_truth, health, last_health_check_at, last_error, rate_limit, connected_by, connected_at, created_at, updated_at,
  last_success_at, last_failure_at, last_webhook_at, account_identity`;

/** AAD every connection's credentials are sealed with (INT-04: payments and accounting read them with the same AAD). */
export const credentialsAad = (orgId: string, provider: string) => `${orgId}:${provider}`;

/**
 * Health checks run every 6 hours per connection; failing ones back off to 12 hours (FT-26, INT-17). Connections
 * still waiting for their first successful check (pending, e.g. after a transient error right after setup) retry hourly.
 */
export const HEALTH_INTERVAL_HOURS = { ok: 6, failing: 12, pending: 1 } as const;

/** A provider failure that says nothing about the credentials (network, timeout, 5xx, 429): it never changes a connection's status. */
export const isTransientProviderFailure = (e: unknown) => e instanceof ProviderError && e.retryable;

/**
 * Structured, redacted diagnostics from a provider failure (INT-17): HTTP status, retryability, a short message
 * with anything key- or contact-like removed. Never the raw provider body.
 */
export function redactedError(e: unknown): { code: string; status: number | null; retryable: boolean; message: string } {
  const pe = e instanceof ProviderError ? e : null;
  const raw = (e as Error)?.message ?? String(e);
  const message = raw
    .replace(/HTTP (\d{3}):.*/s, 'HTTP $1')
    .replace(/\b(sk|pk|rk|whsec|egy_sk|egy_pk|sau_sk|sau_pk)_[A-Za-z0-9_\-]+/g, '[key]')
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[email]')
    .replace(/\+?\d[\d\s-]{8,}\d/g, '[number]')
    .slice(0, 200);
  return { code: pe ? (pe.status ? `http_${pe.status}` : pe.retryable ? 'network' : 'provider_rejected') : 'error', status: pe?.status ?? null, retryable: pe?.retryable ?? false, message };
}

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

/** Diagnostics and activation details for one connection (INT-17, CR-09): exact webhook URL and events, last success/webhook, account. */
export function diagnostics(r: any, apiOrigin: string) {
  return {
    webhook: webhookFor(r.provider, r.id, apiOrigin),
    lastSuccessAt: iso(r.last_success_at), lastFailureAt: iso(r.last_failure_at), lastWebhookAt: iso(r.last_webhook_at),
    account: r.account_identity && Object.keys(r.account_identity).length ? r.account_identity : null,
  };
}

/**
 * Per-tenant provider connections. Credentials are sealed with SecretBox
 * (aad = "<orgId>:<provider>") and only ever decrypted in tenant mode for an
 * adapter call; API responses carry credentials_hint only.
 */
@Injectable()
export class IntegrationConnectionsService {
  private readonly logger = new Logger('IntegrationConnections');

  constructor(
    private readonly db: DbService,
    private readonly box: SecretBox,
    private readonly audit: AuditService,
    private readonly http: ProviderHttp,
    @Inject(ENV) private readonly env: Env,
  ) {}

  /**
   * The provider catalogue for one tenant with computed per-capability readiness (INT-16): implementation facts from
   * the adapters, the tenant's connections and country, and recorded acceptance results (integration_verifications).
   */
  async catalog(ctx: TenantContext) {
    const { country, connected } = await this.db.scoped(ctx, async (tx) => ({
      country: (await tx.one<{ country: string }>('select country from organizations where id = $1', [ctx.orgId])).country,
      connected: new Set((await tx.query<{ provider: string }>(`select distinct provider from integration_connections where org_id = $1 and status <> 'revoked'`, [ctx.orgId])).map((r) => r.provider)),
    }));
    const verifications = await this.db.withPlatform((tx) => tx.query<VerificationRow>(
      `select provider, capability, environment, status, ran_at, commit_sha from integration_verifications where status = 'passed'`));
    return catalogEntries().map((e) => {
      const adapter = adapterFor(e.id)!;
      return {
        ...e,
        fields: fieldsFor(e.id),
        activationKeys: e.activation.map((_, i) => `intg.activation.${e.id}.${i + 1}`),
        webhookEvents: adapter.setup?.webhookEvents ?? [],
        readinessDetail: providerReadiness(adapter, { country, configured: connected.has(e.id), verifications }),
      };
    });
  }

  /** Connection view plus diagnostics (webhook URL, last success/webhook, account identity). */
  view(r: any) {
    return { ...toView(r), ...diagnostics(r, this.env.API_ORIGIN) };
  }

  list(ctx: TenantContext, filter: { category?: string } = {}) {
    return this.db.scoped(ctx, async (tx) => {
      const rows = await tx.query(`select ${SAFE_COLUMNS} from integration_connections where org_id = $1 and ($2::text is null or category = $2)
         order by category, provider`, [ctx.orgId, filter.category ?? null]);
      return { items: rows.filter((r) => ctx.canAccessBranch(r.branch_id)).map((r) => this.view(r)), nextCursor: null };
    });
  }

  get(ctx: TenantContext, id: string) {
    return this.db.scoped(ctx, async (tx) => this.view(await this.row(tx, ctx, id)));
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
    this.assertCredentialEnvironment(input.provider, input.credentials, environment);
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
          hasCreds ? this.box.sealJson(input.credentials, credentialsAad(ctx.orgId, input.provider)) : null,
          credentialsHint(input.credentials), input.config, sot, ctx.userId, hasCreds || simulated]);
      await this.log(tx, ctx.orgId, id, 'info', `Connection created (${environment})`, { provider: input.provider, status });
      await this.audit.record(tx, ctx, { action: 'integration.connected', entityType: 'integration_connection', entityId: id, branchId: input.branchId ?? null,
        metadata: { provider: input.provider, environment } });
      return this.view(await this.row(tx, ctx, id));
    });
  }

  async update(ctx: TenantContext, id: string, input: UpdateIntegrationConnection) {
    return this.db.scoped(ctx, async (tx) => {
      const r = await this.row(tx, ctx, id);
      if (r.status === 'revoked' && !input.credentials) throw conflict('connection_revoked', 'Reconnect with new credentials first');
      const simulated = adapterFor(r.provider)?.descriptor.readiness === 'simulated';
      if (input.credentials || input.config) this.requireFields(r.provider, input.credentials ?? null, input.config ?? r.config, simulated);
      const environment = simulated ? 'sandbox' : input.environment ?? r.environment;
      if (input.credentials) this.assertCredentialEnvironment(r.provider, input.credentials, environment);
      else if (input.environment && input.environment !== r.environment && adapterFor(r.provider)?.credentialEnvironment) {
        // Keys are mode-specific: switching test <-> live needs the other environment's credentials (PAY-02).
        throw invalid('credentials_required', 'Switching between test and live needs that environment\'s keys. Enter them with the change.');
      }
      const sets: string[] = [];
      const params: unknown[] = [id];
      const set = (sql: string, v: unknown) => { params.push(v); sets.push(sql.replace('?', `$${params.length}`)); };
      if (input.environment && !simulated) set('environment = ?', input.environment);
      if (input.config) set('config = ?', input.config);
      if (input.config && !input.credentials && !simulated && adapterFor(r.provider)?.descriptor.category === 'payments' && r.status === 'connected') {
        // Payment settings (integration ids, region) bind webhooks to this connection: re-run the health check.
        set('status = ?', 'pending');
      }
      if (input.sourceOfTruth) set('source_of_truth = ?', this.sourceOfTruth({ ...r.source_of_truth, ...input.sourceOfTruth }));
      if (input.credentials) {
        set('credentials_encrypted = ?', Object.keys(input.credentials).length ? this.box.sealJson(input.credentials, credentialsAad(ctx.orgId, r.provider)) : null);
        set('credentials_hint = ?', credentialsHint(input.credentials));
        if (!simulated) set('status = ?', Object.keys(input.credentials).length ? 'pending' : 'not_configured');
        sets.push('last_error = null', 'connected_at = coalesce(connected_at, now())', `account_identity = '{}'::jsonb`, `health = '{}'::jsonb`);
        set('connected_by = ?', ctx.userId);
      }
      if (sets.length) await tx.query(`update integration_connections set ${sets.join(', ')} where id = $1`, params);
      await this.log(tx, ctx.orgId, id, 'info', 'Connection updated', { fields: Object.keys(input) });
      await this.audit.record(tx, ctx, { action: 'integration.updated', entityType: 'integration_connection', entityId: id, branchId: r.branch_id,
        metadata: { provider: r.provider, fields: Object.keys(input) } });
      return this.view(await this.row(tx, ctx, id));
    });
  }

  async setEnabled(ctx: TenantContext, id: string, enabled: boolean) {
    return this.db.scoped(ctx, async (tx) => {
      const r = await this.row(tx, ctx, id);
      if (r.status === 'revoked' && enabled) throw conflict('connection_revoked', 'Reconnect with new credentials first');
      await tx.query(`update integration_connections set enabled = $2 where id = $1`, [id, enabled]);
      await this.log(tx, ctx.orgId, id, 'info', enabled ? 'Connection enabled' : 'Connection disabled');
      await this.audit.record(tx, ctx, { action: enabled ? 'integration.enabled' : 'integration.disabled', entityType: 'integration_connection', entityId: id, branchId: r.branch_id });
      return this.view(await this.row(tx, ctx, id));
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
      return this.view(await this.row(tx, ctx, id));
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
    const credentials = r.credentials_encrypted ? this.box.openJson<Record<string, string>>(r.credentials_encrypted, credentialsAad(r.org_id, r.provider)) : {};
    return {
      id: r.id, orgId: r.org_id, provider: r.provider, category: r.category, environment: r.environment, status: r.status, enabled: r.enabled,
      config: r.config ?? {}, sourceOfTruth: { ...DEFAULT_INTEGRATION_SOURCE_OF_TRUTH, ...(r.source_of_truth ?? {}), orders: 'resuto' },
      adapter: { environment: r.environment, credentials, config: r.config ?? {}, fetch: this.http.fetch },
    };
  }

  /**
   * Calls the adapter's healthCheck and records health/status/last_error. A connection becomes "connected" only after
   * an authenticated provider call succeeded AND (payments) the provider evidence shows the connection's environment.
   * Diagnostics are structured and redacted (INT-05, INT-17).
   */
  async healthCheck(ctx: TenantContext, id: string) {
    const view = await this.get(ctx, id);
    if (view.status === 'revoked') throw conflict('connection_revoked', 'This connection was revoked');
    this.assertNotRateLimited(await this.rateLimit(ctx.orgId, id));
    return this.runHealth(ctx.orgId, id, `${ctx.actorType}:${ctx.actorId}`);
  }

  private async runHealth(orgId: string, id: string, actor: string) {
    const conn = await this.load(orgId, { id });
    const adapter = adapterFor(conn.provider);
    let health: Record<string, unknown>;
    let status: string = conn.status;
    let error: string | null = null;
    let account: Record<string, unknown> | null = null;
    let outcome: 'success' | 'failure' | null = null;
    let keepError = false;
    if (!adapter?.healthCheck) {
      health = { ok: null, note: 'This provider has no health check yet' };
    } else {
      try {
        const res = await adapter.healthCheck(conn.adapter);
        const envMismatch = res.environment !== undefined && res.environment !== null && res.environment !== conn.environment;
        const envUnknown = adapter.descriptor.category === 'payments' && adapter.descriptor.readiness !== 'simulated' && !res.environment;
        const ok = res.ok && !envMismatch && !envUnknown;
        health = { ok, ...(res.details ? { details: res.details } : {}), ...(res.environment !== undefined ? { environment: res.environment } : {}) };
        account = res.account ? Object.fromEntries(Object.entries(res.account).filter(([, v]) => v !== null && v !== undefined)) : null;
        if (adapter.descriptor.readiness === 'simulated') status = 'sandbox';
        else status = ok ? 'connected' : 'error';
        if (envMismatch) error = `The provider reports ${res.environment === 'live' ? 'live' : 'test'} credentials on this ${conn.environment === 'live' ? 'live' : 'test'} connection`;
        else if (envUnknown) error = 'The credentials do not show which environment (test or live) they belong to';
        else if (!res.ok) error = 'Provider reported the account as not ready';
        outcome = ok ? 'success' : 'failure';
      } catch (e) {
        const d = redactedError(e);
        outcome = 'failure';
        if (isTransientProviderFailure(e)) {
          // The provider could not answer (outage, timeout, rate limit). That is no evidence about the credentials:
          // keep the status (and last_error) and record the failure in health and last_failure_at only. Payments in
          // flight never depend on this anyway (PaymentProvidersService.credentials does not gate on health).
          health = { ok: false, transient: true, error: d };
          keepError = true;
        } else {
          error = d.message;
          health = { ok: false, error: d };
          status = 'error';
        }
        if (e instanceof ProviderError && e.status === 429) await this.markRateLimited(orgId, id, e.retryAfterMs);
      }
    }
    return this.db.withTenant(orgId, async (tx) => {
      await tx.query(
        `update integration_connections set health = $2, status = $3::integration_status,
            last_error = case when $7 then last_error else $4 end, last_health_check_at = now(),
            last_success_at = case when $5 = 'success' then now() else last_success_at end,
            last_failure_at = case when $5 = 'failure' then now() else last_failure_at end,
            account_identity = case when $6::jsonb is not null then account_identity || $6::jsonb else account_identity end
          where id = $1`,
        [id, { ...health, checkedAt: new Date().toISOString() }, status, error, outcome, account ? JSON.stringify(account) : null, keepError]);
      const failed = error !== null || keepError;
      await this.log(tx, orgId, id, keepError ? 'warn' : failed ? 'error' : 'info',
        keepError ? `Health check could not reach the provider (status kept): ${(health.error as { message: string }).message}`
          : failed ? `Health check failed: ${error}` : 'Health check passed', { ...health, ...(account ? { account } : {}) });
      return this.view(await tx.one(`select ${SAFE_COLUMNS} from integration_connections where id = $1`, [id]));
    }, actor);
  }

  /**
   * Worker: re-checks enabled connections every 6 h (12 h while failing, hourly while still pending), skipping
   * rate-limited ones, so a revoked key or a suspended account shows up before a guest hits it, and a connection
   * whose check hit a provider outage is verified again without anyone pressing "Check" (INT-17, FT-26).
   */
  @Scheduled('integrations.health', 900)
  async scheduledHealth(now = new Date(), scope: { orgId?: string } = {}) {
    const due = await this.db.withPlatform((tx) => tx.query<{ id: string; org_id: string; provider: string }>(
      `select id, org_id, provider from integration_connections
        where enabled and status in ('connected', 'error', 'pending') and credentials_encrypted is not null
          and ($5::uuid is null or org_id = $5::uuid)
          and (rate_limit->>'limitedUntil' is null or (rate_limit->>'limitedUntil')::timestamptz < $1)
          and (last_health_check_at is null or last_health_check_at < $1::timestamptz - make_interval(hours => case status when 'error' then $2::int when 'pending' then $4::int else $3::int end))
        order by last_health_check_at nulls first limit 50`,
      [now, HEALTH_INTERVAL_HOURS.failing, HEALTH_INTERVAL_HOURS.ok, HEALTH_INTERVAL_HOURS.pending, scope.orgId ?? null]));
    let checked = 0, failed = 0, unreachable = 0;
    for (const c of due) {
      if (!adapterFor(c.provider)?.healthCheck) continue;
      try {
        const v = await this.runHealth(c.org_id, c.id, 'integrations:health');
        checked++;
        if (v.status === 'error') failed++;
        else if ((v.health as { transient?: boolean })?.transient) unreachable++;
      } catch (e) {
        this.logger.warn(`scheduled health ${c.id}: ${(e as Error).message}`);
      }
    }
    return { checked, failed, unreachable };
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
    // Provider-declared formats (key prefixes, numeric integration ids, region list) — checked here and in the form.
    const malformed = [
      ...spec.credentials.filter((f) => f.pattern && credentials?.[f.key] && !new RegExp(f.pattern).test(credentials[f.key]!)).map((f) => f.key),
      ...spec.config.filter((f) => {
        const v = config[f.key];
        if (v === undefined || v === null || v === '') return false;
        if (f.options && !f.options.includes(String(v))) return true;
        return !!f.pattern && !new RegExp(f.pattern).test(String(v));
      }).map((f) => f.key),
    ];
    if (malformed.length) throw invalid('invalid_fields', `Invalid format: ${malformed.join(', ')}`, { invalid: malformed });
  }

  /**
   * Payment keys are environment-specific (documented prefixes). A test key on a live connection, a live key on a
   * test connection, or a key whose environment cannot be told are all refused (PAY-02, INT-08 — fail closed).
   */
  private assertCredentialEnvironment(provider: string, credentials: Record<string, string>, environment: 'sandbox' | 'live') {
    const a = adapterFor(provider);
    if (!a?.credentialEnvironment || a.descriptor.readiness === 'simulated' || !Object.keys(credentials).length) return;
    const env = a.credentialEnvironment(credentials);
    if (!env) throw invalid('credential_environment_unknown', 'These keys do not show whether they are test or live keys. Copy them again from the provider dashboard.');
    if (env !== environment) {
      throw invalid('credential_environment_mismatch', environment === 'live'
        ? 'These are TEST keys. A live connection needs the live keys.'
        : 'These are LIVE keys. A test connection needs the test keys.', { credentialsEnvironment: env, connectionEnvironment: environment });
    }
  }
}
