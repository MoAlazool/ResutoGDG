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
import { platformProofSecret } from './meta-platform';
import { oauthApp } from './oauth-apps';
import { newToken } from '../../common/crypto/hash';

/**
 * WhatsApp onboarding model (INT-13): a connection whose credentials include the app secret is a merchant-owned Meta
 * app ('own_app'): its webhooks arrive on /v1/webhooks/whatsapp/c/<id>, signed with that secret, with a generated
 * verify token. Without it the token belongs to Resuto's platform app ('platform'; Embedded Signup), whose webhooks
 * arrive on /v1/webhooks/whatsapp signed with WHATSAPP_APP_SECRET.
 */
export function whatsappConnectionConfig(credentials: Record<string, string> | null, config: Record<string, unknown>, previous: Record<string, unknown> = {}) {
  const next: Record<string, unknown> = { ...config };
  // Server-owned keys are never taken from the request.
  for (const k of ['appMode', 'webhookVerifyToken', 'tokenSource', 'onboarding']) delete next[k];
  // INT-12: the Graph version is pinned in code (META_GRAPH_VERSION); a connection cannot choose another one.
  delete next.graphVersion;
  const ownApp = credentials ? !!credentials.appSecret : previous.appMode === 'own_app';
  next.appMode = ownApp ? 'own_app' : 'platform';
  if (ownApp) next.webhookVerifyToken = typeof previous.webhookVerifyToken === 'string' ? previous.webhookVerifyToken : newToken(24);
  if (!credentials) for (const k of ['tokenSource', 'onboarding']) if (previous[k] !== undefined) next[k] = previous[k];
  return next;
}

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
    webhook: webhookFor(r.provider, r.id, apiOrigin, r.config ?? {}),
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
    if (input.provider === 'whatsapp_cloud') input = { ...input, config: whatsappConnectionConfig(input.credentials, input.config) as CreateIntegrationConnection['config'] };
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
      if (r.provider === 'whatsapp_cloud' && (input.config || input.credentials)) {
        input = { ...input, config: whatsappConnectionConfig(input.credentials ?? null, input.config ?? r.config ?? {}, r.config ?? {}) as UpdateIntegrationConnection['config'] };
      }
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

  /**
   * Destroys the stored credentials (they cannot be recovered) and switches the connection off. Providers with a
   * documented revocation (Meta user tokens, TikTok, WhatsApp webhook subscription) are asked to revoke the token
   * first (INT-11); the outcome is reported honestly — local credentials are deleted either way.
   */
  async revoke(ctx: TenantContext, id: string) {
    const before = await this.get(ctx, id);
    let providerRevocation: { attempted: boolean; revoked: boolean; note: string } | null = null;
    const revokeAccess = adapterFor(before.provider)?.revokeAccess as
      ((c: AdapterContext, app: ReturnType<typeof oauthApp>) => Promise<{ attempted: boolean; revoked: boolean; note: string }>) | undefined;
    if (before.status !== 'revoked' && typeof revokeAccess === 'function') {
      try {
        const conn = await this.load(ctx.orgId, { id });
        if (Object.keys(conn.adapter.credentials).length) providerRevocation = await revokeAccess(conn.adapter, oauthApp(conn.provider, this.env.API_ORIGIN));
      } catch (e) {
        providerRevocation = { attempted: true, revoked: false, note: `The provider did not confirm the revocation: ${redactedError(e).message}` };
      }
    }
    return this.db.scoped(ctx, async (tx) => {
      const r = await this.row(tx, ctx, id);
      await tx.query(`update integration_connections set credentials_encrypted = null, credentials_hint = null, status = 'revoked', enabled = false,
          health = '{}'::jsonb where id = $1`, [id]);
      await this.log(tx, ctx.orgId, id, 'warn', 'Connection revoked; credentials deleted', providerRevocation ? { providerRevocation } : {});
      await this.audit.record(tx, ctx, { action: 'integration.revoked', entityType: 'integration_connection', entityId: id, branchId: r.branch_id,
        metadata: { provider: r.provider, ...(providerRevocation ? { providerRevoked: providerRevocation.revoked, providerAttempted: providerRevocation.attempted } : {}) } });
      return { ...this.view(await this.row(tx, ctx, id)), providerRevocation };
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

  // ---------------------------------------------------------------------------
  // OAuth token lifetime (INT-11): refresh short-lived tokens, flag expiring ones
  // ---------------------------------------------------------------------------
  private refreshable(conn: LoadedConnection) {
    return typeof adapterFor(conn.provider)?.refreshAccessToken === 'function' && !!conn.adapter.credentials.refreshToken;
  }

  /**
   * Like load(), refreshing an OAuth access token that expires within 5 minutes (or now, with force) when the provider
   * supports refresh tokens (Snapchat access tokens live 3600 s). The new tokens are sealed before use.
   */
  async loadFresh(orgId: string, where: { id?: string; provider?: string; category?: string }, opts: { force?: boolean } = {}): Promise<LoadedConnection> {
    const conn = await this.load(orgId, where);
    if (!this.refreshable(conn)) return conn;
    const exp = typeof conn.config.tokenExpiresAt === 'string' ? Date.parse(conn.config.tokenExpiresAt) : NaN;
    if (!opts.force && !(Number.isFinite(exp) && exp - Date.now() < 5 * 60_000)) return conn;
    await this.refreshToken(conn);
    return this.load(orgId, { id: conn.id });
  }

  private async refreshToken(conn: LoadedConnection) {
    const app = oauthApp(conn.provider, this.env.API_ORIGIN);
    const refresh = adapterFor(conn.provider)?.refreshAccessToken as
      (c: { fetch: typeof fetch }, a: NonNullable<typeof app>, rt: string) => Promise<{ accessToken: string; refreshToken?: string | null; expiresIn?: number | null }>;
    if (!app) throw new DomainError('provider_app_not_configured', 'The provider app is not configured on this server; the token cannot be refreshed', 503);
    let tokens;
    try {
      tokens = await refresh({ fetch: this.http.fetch }, app, conn.adapter.credentials.refreshToken!);
    } catch (e) {
      const d = redactedError(e);
      if (!isTransientProviderFailure(e)) {
        await this.db.withTenant(conn.orgId, async (tx) => {
          await tx.query(`update integration_connections set status = 'error', last_error = $2, last_failure_at = now() where id = $1`,
            [conn.id, 'The provider refused the refresh token; reconnect this account']);
          await this.log(tx, conn.orgId, conn.id, 'error', 'Token refresh refused; reconnect needed', { error: d });
        }, 'integrations:token-refresh');
      }
      throw e;
    }
    await this.db.withTenant(conn.orgId, async (tx) => {
      const r = await tx.one<{ credentials_encrypted: string; config: Record<string, unknown> }>(
        `select credentials_encrypted, config from integration_connections where id = $1 for update`, [conn.id]);
      const stored = this.box.openJson<Record<string, string>>(r.credentials_encrypted, credentialsAad(conn.orgId, conn.provider));
      const creds = { ...stored, accessToken: tokens.accessToken, ...(tokens.refreshToken ? { refreshToken: tokens.refreshToken } : {}) };
      await tx.query(`update integration_connections set credentials_encrypted = $2, credentials_hint = $3, config = config || $4 where id = $1`,
        [conn.id, this.box.sealJson(creds, credentialsAad(conn.orgId, conn.provider)), credentialsHint(creds),
          { tokenExpiresAt: tokens.expiresIn ? new Date(Date.now() + tokens.expiresIn * 1000).toISOString() : null, lastTokenRefreshAt: new Date().toISOString() }]);
      await this.log(tx, conn.orgId, conn.id, 'info', 'Access token refreshed', { expiresIn: tokens.expiresIn ?? null });
    }, 'integrations:token-refresh');
  }

  /**
   * Worker (every 30 minutes): refreshes short-lived OAuth tokens that expire within 15 minutes, and flags Meta
   * long-lived user tokens (≈ 60 days, no server-side refresh) 7 days before they expire; an expired one marks the
   * connection as error so nothing silently fails at launch time.
   */
  @Scheduled('integrations.oauth-tokens', 1800)
  async maintainOAuthTokens(now = new Date(), scope: { orgId?: string } = {}) {
    const rows = await this.db.withPlatform((tx) => tx.query<{ id: string; org_id: string; provider: string; config: Record<string, unknown>; status: string }>(
      `select id, org_id, provider, config, status from integration_connections
        where enabled and status in ('connected', 'pending', 'error') and credentials_encrypted is not null and config ? 'tokenExpiresAt'
          and config->>'tokenExpiresAt' is not null and ($2::uuid is null or org_id = $2::uuid)
          and (config->>'tokenExpiresAt')::timestamptz < $1::timestamptz + interval '7 days'
        order by (config->>'tokenExpiresAt')::timestamptz limit 100`, [now, scope.orgId ?? null]));
    let refreshed = 0, flagged = 0, expired = 0, failed = 0;
    for (const r of rows) {
      const exp = new Date(String(r.config.tokenExpiresAt));
      if (typeof adapterFor(r.provider)?.refreshAccessToken === 'function') {
        if (exp.getTime() - now.getTime() > 15 * 60_000) continue;
        try { await this.loadFresh(r.org_id, { id: r.id }, { force: true }); refreshed++; } catch { failed++; }
        continue;
      }
      const isExpired = exp.getTime() <= now.getTime();
      await this.db.withTenant(r.org_id, async (tx) => {
        if (isExpired) {
          await tx.query(`update integration_connections set status = 'error', last_error = 'The access token expired; reconnect this account' where id = $1 and status <> 'error'`, [r.id]);
          await this.log(tx, r.org_id, r.id, 'error', 'Access token expired; reconnect needed', { expiredAt: exp.toISOString() });
        } else if (r.config.reconnectReminderAt === undefined || Date.parse(String(r.config.reconnectReminderAt)) < now.getTime() - 86_400_000) {
          await tx.query(`update integration_connections set config = config || $2 where id = $1`, [r.id, { reconnectBy: exp.toISOString(), reconnectReminderAt: now.toISOString() }]);
          await this.log(tx, r.org_id, r.id, 'warn', 'Access token expires soon; reconnect before it does', { expiresAt: exp.toISOString() });
        }
      }, 'integrations:token-check');
      if (isExpired) expired++; else flagged++;
    }
    return { checked: rows.length, refreshed, flagged, expired, failed };
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
    // appsecret_proof for Meta tokens issued to Resuto's platform app (never stored; own-app connections store theirs).
    const proof = platformProofSecret(r.provider, r.config);
    if (proof && !credentials.appSecret) credentials.appSecret = proof;
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
    let conn = await this.loadFresh(orgId, { id }).catch(() => this.load(orgId, { id }));
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
        let res;
        try {
          res = await adapter.healthCheck(conn.adapter);
        } catch (e) {
          // An expired short-lived OAuth token (Snapchat: 1 hour): refresh once and retry (INT-11).
          if (!(e instanceof ProviderError && e.status === 401 && this.refreshable(conn))) throw e;
          conn = await this.loadFresh(orgId, { id }, { force: true });
          res = await adapter.healthCheck(conn.adapter);
        }
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
