import { Inject, Injectable } from '@nestjs/common';
import type { IntegrationOauthComplete } from '@resuto/contracts';
import {
  adsAdapterFor, foodicsOAuth, metaPagesOAuth, pkcePair, ProviderError, type AdAccountChoice, type AdsAdapter, type AuthUrlOptions, type OAuthAppConfig, type OAuthTokens,
} from '@resuto/integrations';
import type { TenantContext } from '../../common/auth/context';
import { newToken, sha256 } from '../../common/crypto/hash';
import { SecretBox } from '../../common/crypto/secret-box';
import { DbService } from '../../common/db/db.service';
import { DomainError, conflict, invalid } from '../../common/errors/domain-error';
import { AuditService } from '../../common/platform/audit.service';
import { ENV, type Env } from '../../config/env';
import { ACCOUNT_CONFIG_KEY, credentialsHint } from './catalog';
import { credentialsAad, IntegrationConnectionsService, redactedError } from './connections.service';
import { metaPlatform } from './meta-platform';
import { foodicsOAuthEnv, OAUTH_APP_ENV, oauthApp } from './oauth-apps';
import { ProviderHttp } from './provider-http';

export { ACCOUNT_CONFIG_KEY };

/**
 * What the bound-state OAuth flow needs from a provider: the ads adapters, the Facebook Page connection (INT-21) and
 * Foodics (INT-24, through the generic helper in packages/integrations/src/oauth). `pkce` providers get an S256
 * challenge whose verifier is sealed with the state row; `environment` is the provider environment the app lives in.
 */
type OAuthProvider = {
  descriptor: AdsAdapter['descriptor'];
  buildAuthUrl(app: OAuthAppConfig, state: string, opts?: AuthUrlOptions & { codeChallenge?: string | null }): string;
  exchangeCode(ctx: { fetch: typeof fetch }, app: OAuthAppConfig, code: string, opts?: AuthUrlOptions & { codeVerifier?: string | null }): Promise<OAuthTokens>;
  listAccounts?: AdsAdapter['listAccounts'];
  pkce?: boolean;
  environment?: 'sandbox' | 'live';
};
const oauthProvider = (provider: string): OAuthProvider | null =>
  adsAdapterFor(provider) ?? (provider === 'meta_pages' ? metaPagesOAuth : provider === 'foodics' ? foodicsOAuth(foodicsOAuthEnv()) : null);
const MAX_CHOICES = 50;

const iso = (secondsFromNow: number | null | undefined) => (secondsFromNow ? new Date(Date.now() + secondsFromNow * 1000).toISOString() : null);

/**
 * Ads OAuth (Meta, TikTok, Snapchat) — PS-11 / INT-11.
 *
 *   start     (signed-in user)  stores sha256(state) with the org, the user and the SHA-256 of a browser nonce;
 *   provider  → redirects to the registered API callback, which only forwards code + state to the web app;
 *   complete  (signed-in user)  the web app posts code + state + nonce; the state must belong to this org, this user
 *             and this browser, unused and unexpired. Only then is the code exchanged.
 *
 * None of the three providers documents PKCE for these flows (Facebook Login manual flow, TikTok for Business
 * authorization, Snapchat Marketing API OAuth — sources in the adapters), so the binding above is the CSRF control.
 * Meta user tokens are exchanged for long-lived ones (expiry stored, reconnect reminder); a Facebook Login for
 * Business configuration (META_ADS_LOGIN_CONFIG_ID) yields a non-expiring system user token. The provider's granted
 * accounts are stored as choices and the owner picks one; a single grant is selected automatically.
 */
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
    return oauthApp(provider, this.env.API_ORIGIN);
  }

  private configId(provider: string) {
    if (provider === 'meta_ads') return metaPlatform().adsLoginConfigId;
    if (provider === 'meta_pages') return metaPlatform().pagesLoginConfigId;
    return null;
  }

  async start(ctx: TenantContext, provider: string, input: { redirectAfter?: string; browserBinding: string }) {
    const adapter = oauthProvider(provider);
    if (!adapter || adapter.descriptor.authType !== 'oauth') throw invalid('oauth_unsupported', `${provider} does not use OAuth`);
    const app = this.appConfig(provider);
    if (!app) {
      throw new DomainError('provider_app_not_configured', `${adapter.descriptor.name} OAuth is not configured on this Resuto server`, 503,
        { activation: adapter.descriptor.activation, env: Object.values(OAUTH_APP_ENV[provider] ?? {}) });
    }
    if (!ctx.userId) throw new DomainError('forbidden', 'Only a signed-in person can authorise an account', 403);
    const state = newToken(24);
    const pkce = adapter.pkce ? pkcePair() : null;
    const environment = adapter.environment ?? 'live';
    await this.db.scoped(ctx, (tx) => tx.query(
      `insert into integration_oauth_states(state_hash, org_id, provider, environment, redirect_after, created_by, expires_at, browser_binding_hash, pkce_verifier_sealed)
       values ($1, $2, $3, $7, $4, $5, now() + interval '15 minutes', $6, $8)`,
      [sha256(state), ctx.orgId, provider, input.redirectAfter ?? null, ctx.userId, input.browserBinding, environment,
        pkce ? this.box.seal(pkce.verifier, `oauth-pkce:${sha256(state)}`) : null]));
    return { url: adapter.buildAuthUrl(app, state, { configId: this.configId(provider), codeChallenge: pkce?.challenge ?? null }), expiresInSeconds: 900 };
  }

  /**
   * Public provider callback. It no longer completes anything (PS-11): it forwards code and state to the web app's
   * completion page, where the signed-in user who started the flow, in the browser that holds the nonce, completes it.
   */
  callbackRedirect(provider: string, query: { code?: string; state?: string; error?: string; error_description?: string }): string {
    const page = `${this.env.APP_ORIGIN}/dashboard/oauth/${encodeURIComponent(provider)}`;
    const fail = (reason: string) => `${page}?integration_error=${encodeURIComponent(reason)}`;
    if (!this.appConfig(provider)) return fail('not_configured');
    if (query.error) return fail(query.error === 'access_denied' ? 'access_denied' : 'provider_error');
    // TikTok sends auth_code; Meta and Snapchat send code.
    const code = query.code;
    if (!code || !query.state || code.length > 2000 || query.state.length > 200) return fail('missing_code');
    return `${page}?${new URLSearchParams({ code, state: query.state })}`;
  }

  async complete(ctx: TenantContext, provider: string, input: IntegrationOauthComplete) {
    const adapter = oauthProvider(provider);
    const app = this.appConfig(provider);
    if (!adapter || adapter.descriptor.authType !== 'oauth') throw invalid('oauth_unsupported', `${provider} does not use OAuth`);
    if (!app) throw new DomainError('provider_app_not_configured', `${adapter.descriptor.name} OAuth is not configured on this Resuto server`, 503);
    if (!ctx.userId) throw new DomainError('forbidden', 'Only a signed-in person can authorise an ad account', 403);
    // Single use; bound to org, user and browser. A mismatch does not consume the state.
    const row = await this.db.scoped(ctx, (tx) => tx.maybeOne<{ redirect_after: string | null; environment: 'sandbox' | 'live'; pkce_verifier_sealed: string | null }>(
      `update integration_oauth_states set used_at = now()
        where state_hash = $1 and provider = $2 and org_id = $3 and created_by = $4 and browser_binding_hash = $5 and used_at is null and expires_at > now()
        returning redirect_after, environment, pkce_verifier_sealed`, [sha256(input.state), provider, ctx.orgId, ctx.userId, sha256(input.browserNonce)]));
    if (!row) {
      await this.db.scoped(ctx, (tx) => this.audit.record(tx, ctx, { action: 'integration.oauth_state_rejected', entityType: 'integration_oauth_state', metadata: { provider } }));
      throw new DomainError('oauth_state_invalid', 'This authorisation was not started by you in this browser, was already used or has expired. Start again from Integrations.', 403);
    }
    let tokens: OAuthTokens;
    try {
      const codeVerifier = row.pkce_verifier_sealed ? this.box.open(row.pkce_verifier_sealed, `oauth-pkce:${sha256(input.state)}`) : null;
      tokens = await adapter.exchangeCode({ fetch: this.http.fetch }, app, input.code, { configId: this.configId(provider), codeVerifier });
    } catch (e) {
      await this.db.withTenant(ctx.orgId, (tx) => this.connections.log(tx, ctx.orgId, null, 'error', `OAuth exchange failed for ${provider}`, { error: redactedError(e) }));
      throw new DomainError('oauth_exchange_failed', 'The provider did not accept the authorisation. Start again from Integrations.', 502, { provider: redactedError(e) });
    }
    const choices: AdAccountChoice[] = (tokens.accounts?.length ? tokens.accounts : (tokens.accountIds ?? []).map((id) => ({ id, name: null, currency: null, status: null })))
      .slice(0, MAX_CHOICES);
    const pages = provider === 'meta_pages';
    // Messenger / Instagram: the user token only lists Pages and reads the chosen Page's token (stored as accessToken
    // once a Page is chosen); messaging always uses the Page's own token.
    let creds: Record<string, string> = pages ? { userAccessToken: tokens.accessToken }
      : { accessToken: tokens.accessToken, ...(tokens.refreshToken ? { refreshToken: tokens.refreshToken } : {}) };
    const key = ACCOUNT_CONFIG_KEY[provider]!;
    const config: Record<string, unknown> = {
      tokenSource: 'platform_app', tokenKind: tokens.tokenKind ?? 'user', accountChoices: choices,
      tokenExpiresAt: iso(tokens.expiresIn), refreshTokenExpiresAt: iso(tokens.refreshExpiresIn),
      ...(tokens.identity?.userId ? { metaUserId: tokens.identity.userId } : {}), ...(tokens.identity?.businessId ? { businessId: tokens.identity.businessId } : {}),
      lastTokenRefreshAt: new Date().toISOString(),
    };
    // Exactly one granted account: select it. Several: the owner picks (the previous selection is kept if still granted).
    const autoPick = choices.length === 1 ? choices[0]!.id : null;
    const prev = await this.db.withTenant(ctx.orgId, (tx) => tx.maybeOne<{ config: Record<string, unknown> }>(
      `select config from integration_connections where org_id = $1 and provider = $2 and branch_id is null`, [ctx.orgId, provider]));
    const kept = prev?.config?.[key] && choices.some((c) => c.id === prev.config[key]) ? String(prev.config[key]) : null;
    const selected = autoPick ?? kept;
    let pageExtra: Record<string, unknown> = {};
    if (pages && selected) {
      const page = await this.pageAccess(provider, tokens.accessToken, selected);
      creds = { ...creds, accessToken: page.pageToken };
      pageExtra = page.instagramAccountId ? { instagramAccountId: page.instagramAccountId } : {};
    }
    const id = await this.db.withTenant(ctx.orgId, async (tx) => {
      const sealed = this.box.sealJson(creds, credentialsAad(ctx.orgId, provider));
      const cfg = { ...config, ...(selected ? { [key]: selected } : {}), ...pageExtra };
      // Keys that belong to the previous grant are dropped (the Page's Instagram account is re-read with the new one).
      const dropped = pages ? [key, 'instagramAccountId'] : [key];
      const connId = (await tx.one<{ id: string }>(
        `insert into integration_connections(org_id, provider, category, auth_type, environment, status, credentials_encrypted, credentials_hint, config,
            connected_by, connected_at, scopes)
         values ($1, $2, $8, 'oauth', $9, 'pending', $3, $4, $5, $6, now(), $10)
         on conflict (org_id, provider, coalesce(branch_id, '00000000-0000-0000-0000-000000000000'::uuid))
         do update set credentials_encrypted = excluded.credentials_encrypted, credentials_hint = excluded.credentials_hint, status = 'pending', enabled = true,
           environment = excluded.environment,
           config = (integration_connections.config - $7::text[]) || excluded.config, connected_by = excluded.connected_by, connected_at = now(), last_error = null,
           account_identity = '{}'::jsonb, health = '{}'::jsonb, scopes = excluded.scopes
         returning id`, [ctx.orgId, provider, sealed, credentialsHint(creds), cfg, ctx.userId, dropped, adapter.descriptor.category, row.environment ?? 'live',
           // 21-INT: the scopes the provider reported in the token response (Snapchat, TikTok, RFC 6749); Meta is read back
           // separately (POST …/permissions) so the code exchange makes exactly the calls it always made.
           tokens.grantedScopes ?? []])).id;
      await tx.query(`update integration_oauth_states set connection_id = $2 where state_hash = $1`, [sha256(input.state), connId]);
      await this.connections.log(tx, ctx.orgId, connId, 'info', 'OAuth authorisation completed', { accounts: choices.length, tokenKind: config.tokenKind,
        expiresAt: config.tokenExpiresAt });
      await this.audit.record(tx, ctx, { action: 'integration.oauth_connected', entityType: 'integration_connection', entityId: connId,
        metadata: { provider, accounts: choices.length, autoSelected: !!autoPick } });
      return connId;
    }, `${ctx.actorType}:${ctx.actorId}`);
    const needsAccountSelection = !(await this.connections.get(ctx, id)).config[key];
    const view = needsAccountSelection ? await this.connections.get(ctx, id) : await this.connections.healthCheck(ctx, id).catch(() => this.connections.get(ctx, id));
    return { connection: view, needsAccountSelection, accounts: choices, redirectAfter: row.redirect_after };
  }

  /** The owner picks one of the granted accounts (validated against the provider's grant, re-listed when needed). */
  async selectAccount(ctx: TenantContext, connectionId: string, accountId: string) {
    const view = await this.connections.get(ctx, connectionId);
    const key = ACCOUNT_CONFIG_KEY[view.provider];
    if (!key) throw invalid('not_an_ad_account_connection', 'This connection has no ad account to choose');
    if (view.status === 'revoked') throw conflict('connection_revoked', 'Reconnect first');
    let choices = ((view.config.accountChoices as AdAccountChoice[] | undefined) ?? []);
    if (!choices.some((c) => c.id === accountId)) choices = await this.listAccounts(ctx, connectionId).then((r) => r.accounts);
    if (!choices.some((c) => c.id === accountId)) throw invalid('account_not_granted', 'That account was not granted to Resuto. Reconnect and grant it, or pick another.');
    // Messenger / Instagram: the chosen Page's own token replaces the previous one (read with the Login user token).
    let sealed: string | null = null;
    let extra: Record<string, unknown> = {};
    let dropIg = false;
    if (view.provider === 'meta_pages') {
      const conn = await this.connections.loadFresh(ctx.orgId, { id: connectionId });
      const userToken = conn.adapter.credentials.userAccessToken;
      if (!userToken) {
        if (view.config.pageId !== accountId) throw invalid('reconnect_required', 'This connection uses a pasted Page token. Connect with Facebook to choose another Page.');
      } else {
        const page = await this.pageAccess(view.provider, userToken, accountId);
        sealed = this.box.sealJson({ userAccessToken: userToken, accessToken: page.pageToken }, credentialsAad(ctx.orgId, view.provider));
        extra = page.instagramAccountId ? { instagramAccountId: page.instagramAccountId } : {};
        dropIg = !page.instagramAccountId;
      }
    }
    await this.db.withTenant(ctx.orgId, async (tx) => {
      await tx.query(`update integration_connections set config = (case when $4 then config - 'instagramAccountId' else config end) || $2,
          credentials_encrypted = coalesce($3, credentials_encrypted), status = case when status = 'revoked' then status else 'pending' end where id = $1`,
        [connectionId, { [key]: accountId, ...extra }, sealed, dropIg]);
      await this.connections.log(tx, ctx.orgId, connectionId, 'info', 'Ad account selected', { accountId });
      await this.audit.record(tx, ctx, { action: 'integration.account_selected', entityType: 'integration_connection', entityId: connectionId, metadata: { provider: view.provider } });
    }, `${ctx.actorType}:${ctx.actorId}`);
    return this.connections.healthCheck(ctx, connectionId);
  }

  /** The Page's own token for a Page the Login user granted (INT-21). Errors never carry a token. */
  private async pageAccess(provider: string, userToken: string, pageId: string) {
    const ctxA = { environment: 'live' as const, credentials: { userAccessToken: userToken, appSecret: metaPlatform().appSecret ?? '' }, config: {}, fetch: this.http.fetch };
    try {
      return await metaPagesOAuth.pageAccess(ctxA, pageId);
    } catch (e) {
      if (e instanceof ProviderError && !e.retryable) throw invalid('account_not_granted', 'Meta did not give Resuto access to that Page. Reconnect and grant it.', { provider: redactedError(e) });
      throw new DomainError('provider_error', 'Meta could not be reached to read the Page. Try again.', 502, { provider: redactedError(e), provider_name: provider });
    }
  }

  /** Re-lists the accounts the connection's token can use (fresh from the provider) and stores them as choices. */
  async listAccounts(ctx: TenantContext, connectionId: string) {
    const view = await this.connections.get(ctx, connectionId);
    const adapter = oauthProvider(view.provider);
    if (!adapter?.listAccounts) throw invalid('not_supported', 'This provider cannot list accounts');
    if (view.status === 'revoked') throw conflict('connection_revoked', 'Reconnect first');
    const conn = await this.connections.loadFresh(ctx.orgId, { id: connectionId });
    let accounts: AdAccountChoice[];
    try {
      accounts = (await adapter.listAccounts(conn.adapter, this.appConfig(view.provider))).slice(0, MAX_CHOICES);
    } catch (e) {
      throw new DomainError('provider_error', e instanceof ProviderError ? redactedError(e).message : 'Could not list accounts', 502);
    }
    await this.db.withTenant(ctx.orgId, (tx) => tx.query(`update integration_connections set config = config || $2 where id = $1`, [connectionId, { accountChoices: accounts }]));
    return { accounts };
  }
}
