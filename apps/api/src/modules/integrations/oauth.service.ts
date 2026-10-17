import { Inject, Injectable } from '@nestjs/common';
import { adsAdapterFor, type OAuthAppConfig } from '@resuto/integrations';
import type { TenantContext } from '../../common/auth/context';
import { newToken, sha256 } from '../../common/crypto/hash';
import { SecretBox } from '../../common/crypto/secret-box';
import { DbService } from '../../common/db/db.service';
import { DomainError, invalid } from '../../common/errors/domain-error';
import { AuditService } from '../../common/platform/audit.service';
import { ENV, type Env } from '../../config/env';
import { credentialsHint } from './catalog';
import { IntegrationConnectionsService } from './connections.service';
import { ProviderHttp } from './provider-http';

/**
 * Platform OAuth app credentials per provider. They are NOT in the validated env
 * schema yet (lead-owned config/env.ts); until they are added there they are read
 * from process.env here. Without them OAuth is refused with 503 and the activation
 * steps, and restaurants can still paste an access token into the connection form.
 */
const APP_ENV: Record<string, { id: string; secret: string }> = {
  meta_ads: { id: 'META_APP_ID', secret: 'META_APP_SECRET' },
  tiktok_ads: { id: 'TIKTOK_APP_ID', secret: 'TIKTOK_APP_SECRET' },
  snapchat_ads: { id: 'SNAPCHAT_CLIENT_ID', secret: 'SNAPCHAT_CLIENT_SECRET' },
};
const ACCOUNT_CONFIG_KEY: Record<string, string> = { meta_ads: 'adAccountId', tiktok_ads: 'advertiserId', snapchat_ads: 'adAccountId' };

@Injectable()
export class IntegrationOAuthService {
  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly db: DbService,
    private readonly box: SecretBox,
    private readonly audit: AuditService,
    private readonly http: ProviderHttp,
    private readonly connections: IntegrationConnectionsService,
  ) {}

  appConfig(provider: string): OAuthAppConfig | null {
    const keys = APP_ENV[provider];
    const id = keys ? process.env[keys.id] : undefined;
    const secret = keys ? process.env[keys.secret] : undefined;
    if (!id || !secret) return null;
    return { clientId: id, clientSecret: secret, redirectUri: `${this.env.API_ORIGIN}/v1/public/integrations/oauth/${provider}/callback` };
  }

  async start(ctx: TenantContext, provider: string, redirectAfter?: string) {
    const adapter = adsAdapterFor(provider);
    if (!adapter || adapter.descriptor.authType !== 'oauth') throw invalid('oauth_unsupported', `${provider} does not use OAuth`);
    const app = this.appConfig(provider);
    if (!app) {
      throw new DomainError('provider_app_not_configured', `${adapter.descriptor.name} OAuth is not configured on this Resuto server`, 503,
        { activation: adapter.descriptor.activation, env: Object.values(APP_ENV[provider] ?? {}) });
    }
    const state = newToken(24);
    await this.db.scoped(ctx, (tx) => tx.query(
      `insert into integration_oauth_states(state_hash, org_id, provider, environment, redirect_after, created_by, expires_at)
       values ($1, $2, $3, 'live', $4, $5, now() + interval '15 minutes')`, [sha256(state), ctx.orgId, provider, redirectAfter ?? null, ctx.userId]));
    return { url: adapter.buildAuthUrl(app, state), expiresInSeconds: 900 };
  }

  /** Public callback: resolves the tenant from the single-use state, exchanges the code, seals the tokens. */
  async callback(provider: string, code: string | undefined, state: string | undefined): Promise<string> {
    const fail = (reason: string) => `${this.env.APP_ORIGIN}/dashboard?integration_error=${encodeURIComponent(reason)}`;
    if (!code || !state || state.length > 200) return fail('missing_code');
    const adapter = adsAdapterFor(provider);
    const app = this.appConfig(provider);
    if (!adapter || !app) return fail('not_configured');
    const row = await this.db.withPlatform((tx) => tx.maybeOne<{ org_id: string; created_by: string | null; redirect_after: string | null }>(
      `update integration_oauth_states set used_at = now() where state_hash = $1 and provider = $2 and used_at is null and expires_at > now()
        returning org_id, created_by, redirect_after`, [sha256(state), provider]));
    if (!row) return fail('invalid_state');
    const orgId = row.org_id;
    let tokens;
    try {
      tokens = await adapter.exchangeCode({ fetch: this.http.fetch }, app, code);
    } catch (e) {
      await this.db.withTenant(orgId, (tx) => this.connections.log(tx, orgId, null, 'error', `OAuth exchange failed for ${provider}: ${(e as Error).message}`));
      return `${this.env.APP_ORIGIN}/dashboard/${orgId}/integrations?integration_error=exchange_failed`;
    }
    const creds: Record<string, string> = { accessToken: tokens.accessToken, ...(tokens.refreshToken ? { refreshToken: tokens.refreshToken } : {}) };
    const config: Record<string, string> = {};
    if (tokens.accountIds?.length === 1) config[ACCOUNT_CONFIG_KEY[provider]!] = tokens.accountIds[0]!;
    await this.db.withTenant(orgId, async (tx) => {
      const sealed = this.box.sealJson(creds, `${orgId}:${provider}`);
      const id = (await tx.one<{ id: string }>(
        `insert into integration_connections(org_id, provider, category, auth_type, environment, status, credentials_encrypted, credentials_hint, config,
            connected_by, connected_at)
         values ($1, $2, 'ads', 'oauth', 'live', 'pending', $3, $4, $5, $6, now())
         on conflict (org_id, provider, coalesce(branch_id, '00000000-0000-0000-0000-000000000000'::uuid))
         do update set credentials_encrypted = excluded.credentials_encrypted, credentials_hint = excluded.credentials_hint, status = 'pending', enabled = true,
           config = integration_connections.config || excluded.config, connected_at = now(), last_error = null
         returning id`, [orgId, provider, sealed, credentialsHint(creds), config, row.created_by])).id;
      await this.connections.log(tx, orgId, id, 'info', 'OAuth authorisation completed', { accounts: tokens.accountIds?.length ?? null });
      await tx.query(`insert into audit_logs(org_id, actor_type, actor_id, action, entity_type, entity_id, source, metadata)
                      values ($1, 'user', $2, 'integration.oauth_connected', 'integration_connection', $3, 'webhook', $4)`,
        [orgId, row.created_by, id, { provider }]);
    }, 'integration');
    return `${this.env.APP_ORIGIN}${row.redirect_after ?? `/dashboard/${orgId}/integrations`}?connected=${provider}`;
  }
}
