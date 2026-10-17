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
  /** Ad accounts / advertisers granted to the app, when the provider returns them. */
  accountIds?: string[];
}

export interface CreateAdCampaignInput {
  name: string;
  objective: AdsObjective;
  /** Daily budget in minor units of the ad account currency; omitted → no campaign-level budget. */
  dailyBudgetMinor?: number | null;
  currency: string;
  /** ISO start time (required by some providers). */
  startTime?: string;
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
  buildAuthUrl(app: OAuthAppConfig, state: string): string;
  exchangeCode(ctx: Pick<AdapterContext, 'fetch'>, app: OAuthAppConfig, code: string): Promise<OAuthTokens>;
  createCampaign(ctx: AdapterContext, input: CreateAdCampaignInput): Promise<{ externalId: string; status: string }>;
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
