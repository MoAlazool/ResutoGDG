import { ProviderError, type AdapterContext, type ProviderDescriptor } from '../core';

/** Provider-neutral objective; each adapter maps it to its own enum. */
export type AdsObjective = 'awareness' | 'traffic' | 'engagement' | 'sales' | 'leads';

export interface OAuthAppConfig {
  clientId: string;
  clientSecret?: string;
  redirectUri: string;
}

export interface OAuthTokens {
  accessToken: string;
  refreshToken?: string | null;
  expiresIn?: number | null;
  /** Seconds until the refresh token expires, when the provider says. */
  refreshExpiresIn?: number | null;
  /** Ad accounts / advertisers granted to the app, when the provider returns them. */
  accountIds?: string[];
  /** Same accounts with what the owner needs to pick one (name, currency, status), when the provider returns them. */
  accounts?: AdAccountChoice[];
  /** Provider-side identity of the token (used to revoke it on disconnect). */
  identity?: { userId?: string | null; businessId?: string | null } | null;
  /** 'user' tokens expire (Meta long-lived ≈ 60 days); 'system_user' business integration tokens do not. */
  tokenKind?: 'user' | 'system_user' | 'advertiser';
  /**
   * 21-INT: the scopes the provider reports as granted in the token response (RFC 6749 §5.1 `scope`; Snapchat's
   * space-separated string; TikTok's numeric permission ids as strings). Absent when the provider reports none.
   */
  grantedScopes?: string[];
}

/** A token response `scope` (string separated by spaces or commas, or an array) as a sorted list; undefined when absent. */
export function parseGrantedScopes(scope: unknown): string[] | undefined {
  const raw = Array.isArray(scope) ? scope.map((v) => String(v)) : typeof scope === 'string' ? scope.split(/[\s,]+/) : null;
  if (!raw) return undefined;
  const list = [...new Set(raw.map((s) => s.trim()).filter((s) => /^[A-Za-z0-9_.:\/-]{1,120}$/.test(s)))].sort();
  return list.length ? list.slice(0, 100) : undefined;
}

/** An ad account the authorising person can grant (shown in the account picker). */
export interface AdAccountChoice { id: string; name: string | null; currency: string | null; status: string | null }

/** Options of the authorisation URL (no provider in scope documents PKCE; state is bound to the browser and user instead). */
export interface AuthUrlOptions {
  /** Meta: Facebook Login for Business configuration id (business integration system user token). */
  configId?: string | null;
}

/** Result of revoking a token at the provider on disconnect. */
export interface ProviderRevocation { attempted: boolean; revoked: boolean; note: string }

export interface CreateAdCampaignInput {
  name: string;
  objective: AdsObjective;
  /** Daily budget in minor units of the ad account currency; omitted → no campaign-level budget. */
  dailyBudgetMinor?: number | null;
  currency: string;
  /** ISO start time (required by some providers). */
  startTime?: string;
  /** Launch idempotency token (PS-14), appended to the provider-side campaign name as "[rs:<token>]". */
  idempotencyToken?: string | null;
}

/** The provider-side campaign name carrying the launch token, within the provider's name limit. */
export function campaignNameWithToken(name: string, token: string | null | undefined, max: number): string {
  if (!token) return name.slice(0, max);
  const tag = ` [rs:${token}]`;
  return `${name.slice(0, Math.max(1, max - tag.length))}${tag}`;
}

export interface AdInsightRow {
  externalCampaignId: string;
  /** YYYY-MM-DD */
  date: string;
  impressions: number;
  clicks: number;
  spendMinor: number;
  currency: string;
  conversions: number;
}

export interface AdsAdapter {
  descriptor: ProviderDescriptor;
  buildAuthUrl(app: OAuthAppConfig, state: string, opts?: AuthUrlOptions): string;
  exchangeCode(ctx: Pick<AdapterContext, 'fetch'>, app: OAuthAppConfig, code: string, opts?: AuthUrlOptions): Promise<OAuthTokens>;
  /** Re-lists the ad accounts this connection's token can use (account picker). */
  listAccounts?(ctx: AdapterContext, app: OAuthAppConfig | null): Promise<AdAccountChoice[]>;
  /** Exchanges a refresh token for a new access token (providers with short-lived access tokens). */
  refreshAccessToken?(ctx: Pick<AdapterContext, 'fetch'>, app: OAuthAppConfig, refreshToken: string): Promise<OAuthTokens>;
  /** Revokes the connection's token at the provider (disconnect). Never throws for "already revoked". */
  revokeAccess?(ctx: AdapterContext, app: OAuthAppConfig | null): Promise<ProviderRevocation>;
  /**
   * Creates the campaign PAUSED/disabled. `idempotencyName` is a stable token derived from the launch attempt that
   * the adapter puts into the provider-side name, so an operator can match (and a retry can find) the campaign.
   */
  createCampaign(ctx: AdapterContext, input: CreateAdCampaignInput): Promise<{ externalId: string; status: string }>;
  /** Finds a campaign created by an earlier attempt of the same launch (by the idempotency token in its name). */
  findCampaignByToken?(ctx: AdapterContext, token: string): Promise<{ externalId: string; status: string } | null>;
  fetchInsights(ctx: AdapterContext, input: { externalCampaignId: string; since: string; until: string; currency: string }): Promise<AdInsightRow[]>;
  healthCheck(ctx: AdapterContext): Promise<{ ok: boolean; details: Record<string, unknown> }>;
}

/**
 * Exact decimal string ("12.34", "7", "0.5") → integer minor units. Avoids
 * float rounding on provider spend values. EGP/SAR/USD have 2 decimals.
 */
export function decimalToMinor(value: unknown, decimals = 2): number {
  if (value === null || value === undefined || value === '') return 0;
  const s = String(value).trim();
  const m = /^(-)?(\d+)(?:\.(\d+))?$/.exec(s);
  if (!m) throw new ProviderError('ads', `unparseable amount "${s.slice(0, 20)}"`, false);
  const frac = (m[3] ?? '').padEnd(decimals + 1, '0');
  let minor = Number(m[2]) * 10 ** decimals + Number(frac.slice(0, decimals) || '0');
  if (Number(frac[decimals]) >= 5) minor += 1; // half-up on the first dropped digit
  return m[1] ? -minor : minor;
}

export const adsMinorToDecimal = (minor: number, decimals = 2) => (minor / 10 ** decimals).toFixed(decimals);

export const toInt = (v: unknown) => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? Math.round(n) : 0;
};

export function requireCred(provider: string, ctx: AdapterContext, key: string): string {
  const v = ctx.credentials[key];
  if (!v) throw new ProviderError(provider, `missing credential ${key}`, false);
  return v;
}

export function requireConfig(provider: string, ctx: AdapterContext, key: string): string {
  const v = ctx.config[key];
  if (typeof v !== 'string' || !v) throw new ProviderError(provider, `missing configuration ${key}`, false);
  return v;
}
