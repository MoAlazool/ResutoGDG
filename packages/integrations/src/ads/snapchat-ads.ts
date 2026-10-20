// Snapchat Marketing API v1 adapter.
// Docs: https://developers.snap.com/api/marketing-api/Ads-API/authentication
//       https://developers.snap.com/api/marketing-api/Ads-API/campaigns
//       https://developers.snap.com/api/marketing-api/Ads-API/measurement
//       https://developers.snap.com/api/marketing-api/Ads-API/organizations (ad accounts for the picker)
// Spend is reported in micro-currency (1e-6). Access tokens live 3600 s (authentication page) and are refreshed with
// the refresh token. Snap documents neither PKCE nor a revocation endpoint for this OAuth flow.
// Readiness: implemented_unverified (no Snap Business app or ad account available).
import { providerRequest, ProviderError, type ProviderDescriptor } from '../core';
import { campaignNameWithToken, requireConfig, requireCred, toInt, type AdAccountChoice, type AdInsightRow, type AdsAdapter, type AdsObjective, type OAuthAppConfig } from './types';

const API = 'https://adsapi.snapchat.com/v1';
const AUTH = 'https://accounts.snapchat.com/login/oauth2';

export const snapchatAdsDescriptor: ProviderDescriptor = {
  id: 'snapchat_ads',
  name: 'Snapchat Ads',
  category: 'ads',
  countries: ['EG', 'SA'],
  authType: 'oauth',
  readiness: 'implemented_unverified',
  docsUrl: 'https://developers.snap.com/api/marketing-api/Ads-API/introduction',
  capabilities: ['oauth', 'oauth_state_bound', 'token_refresh', 'ad_account_picker', 'campaign_create_paused', 'launch_idempotency', 'daily_stats'],
  activation: [
    'Create an OAuth app in Snapchat Business Manager (Business Details > OAuth Apps) with the snapchat-marketing-api scope.',
    'Set SNAPCHAT_CLIENT_ID, SNAPCHAT_CLIENT_SECRET and the redirect https://<api-host>/v1/public/integrations/oauth/snapchat_ads/callback on the Resuto API server.',
    'The restaurant authorises from Resuto > Integrations and selects its ad account id; the ad account needs an active funding source.',
    'Campaigns are created PAUSED; ad squads and creatives are completed in Snapchat Ads Manager.',
  ],
};

const OBJECTIVE: Record<AdsObjective, string> = {
  awareness: 'AWARENESS_AND_ENGAGEMENT', engagement: 'AWARENESS_AND_ENGAGEMENT', traffic: 'TRAFFIC', sales: 'SALES', leads: 'LEADS',
};

/** Micro-currency → minor units (2-decimal currencies): 1 minor = 10 000 micro. */
export const microToMinor = (micro: unknown) => Math.round(toInt(micro) / 10_000);

async function tokenRequest(ctx: { fetch: typeof fetch }, app: OAuthAppConfig, params: Record<string, string>) {
  if (!app.clientSecret) throw new ProviderError('snapchat_ads', 'client secret not configured', false);
  const body = new URLSearchParams({ client_id: app.clientId, client_secret: app.clientSecret, ...params });
  const res = await providerRequest<{ access_token?: string; refresh_token?: string; expires_in?: number }>('snapchat_ads', ctx, `${AUTH}/access_token`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body, retries: 0,
  });
  if (!res.access_token) throw new ProviderError('snapchat_ads', 'no access token in response', false);
  return { accessToken: res.access_token, refreshToken: res.refresh_token ?? null, expiresIn: res.expires_in ?? null };
}

/** GET /me/organizations?with_ad_accounts=true: every ad account the person can use, for the picker. */
async function snapAccounts(ctx: { fetch: typeof fetch }, token: string): Promise<AdAccountChoice[]> {
  const res = await providerRequest<{ organizations?: Array<{ organization?: { ad_accounts?: Array<{ id?: string; name?: string; currency?: string; status?: string }> } }> }>(
    'snapchat_ads', ctx, `${API}/me/organizations?with_ad_accounts=true`, { headers: { Authorization: `Bearer ${token}` }, retries: 1 });
  return (res.organizations ?? []).flatMap((o) => o.organization?.ad_accounts ?? []).filter((a) => a.id)
    .map((a) => ({ id: String(a.id), name: a.name ?? null, currency: a.currency ?? null, status: a.status ?? null }));
}

export const snapchatAdsAdapter: AdsAdapter & { refreshAccessToken(ctx: { fetch: typeof fetch }, app: OAuthAppConfig, refreshToken: string): ReturnType<typeof tokenRequest> } = {
  descriptor: snapchatAdsDescriptor,

  buildAuthUrl(app, state) {
    const u = new URL(`${AUTH}/authorize`);
    u.searchParams.set('response_type', 'code');
    u.searchParams.set('client_id', app.clientId);
    u.searchParams.set('redirect_uri', app.redirectUri);
    u.searchParams.set('scope', 'snapchat-marketing-api');
    u.searchParams.set('state', state);
    return u.toString();
  },

  async exchangeCode(ctx, app, code) {
    const tokens = await tokenRequest(ctx, app, { grant_type: 'authorization_code', code, redirect_uri: app.redirectUri });
    let accounts: AdAccountChoice[] = [];
    try { accounts = await snapAccounts(ctx, tokens.accessToken); } catch { /* the owner can list them again from the connection */ }
    return { ...tokens, accounts, accountIds: accounts.map((a) => a.id), tokenKind: 'user' as const };
  },

  /** Access tokens last 3600 s; refreshed with the refresh token (before expiry, on 401 and by the scheduled job). */
  refreshAccessToken(ctx, app, refreshToken) {
    return tokenRequest(ctx, app, { grant_type: 'refresh_token', refresh_token: refreshToken });
  },

  async listAccounts(ctx) {
    return snapAccounts(ctx, requireCred('snapchat_ads', ctx, 'accessToken'));
  },

  /** Snap documents no token-revocation endpoint: the business removes the app in Snapchat Business Manager. */
  async revokeAccess() {
    return { attempted: false, revoked: false, note: 'Snapchat has no API to revoke this token: remove the Resuto app in Snapchat Business Manager > Business Details > Connected Apps.' };
  },

  async createCampaign(ctx, input) {
    const token = requireCred('snapchat_ads', ctx, 'accessToken');
    const adAccountId = requireConfig('snapchat_ads', ctx, 'adAccountId');
    const campaign: Record<string, unknown> = {
      name: campaignNameWithToken(input.name, input.idempotencyToken, 375),
      ad_account_id: adAccountId,
      status: 'PAUSED',
      start_time: input.startTime ?? new Date().toISOString(),
      objective_v2_properties: { objective_v2_type: OBJECTIVE[input.objective] },
    };
    if (input.dailyBudgetMinor) campaign.daily_budget_micro = input.dailyBudgetMinor * 10_000;
    const res = await providerRequest<{ request_status?: string; campaigns?: Array<{ sub_request_status?: string; sub_request_error_reason?: string; campaign?: { id?: string; status?: string } }> }>(
      'snapchat_ads', ctx, `${API}/adaccounts/${encodeURIComponent(adAccountId)}/campaigns`, {
        method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ campaigns: [campaign] }), retries: 0,
      });
    const sub = res.campaigns?.[0];
    if (res.request_status !== 'SUCCESS' || sub?.sub_request_status !== 'SUCCESS' || !sub.campaign?.id) {
      throw new ProviderError('snapchat_ads', `campaign create failed: ${sub?.sub_request_error_reason ?? res.request_status ?? 'unknown'}`, false);
    }
    return { externalId: sub.campaign.id, status: sub.campaign.status ?? 'PAUSED' };
  },

  async fetchInsights(ctx, input) {
    const token = requireCred('snapchat_ads', ctx, 'accessToken');
    const u = new URL(`${API}/campaigns/${encodeURIComponent(input.externalCampaignId)}/stats`);
    u.searchParams.set('granularity', 'DAY');
    u.searchParams.set('fields', 'impressions,swipes,spend,conversion_purchases');
    u.searchParams.set('start_time', `${input.since}T00:00:00.000Z`);
    u.searchParams.set('end_time', `${nextDay(input.until)}T00:00:00.000Z`);
    const res = await providerRequest<any>('snapchat_ads', ctx, u.toString(), { headers: { Authorization: `Bearer ${token}` } });
    return parseSnapStats(res, input.externalCampaignId, input.currency);
  },

  async healthCheck(ctx) {
    const token = requireCred('snapchat_ads', ctx, 'accessToken');
    const adAccountId = requireConfig('snapchat_ads', ctx, 'adAccountId');
    const res = await providerRequest<{ adaccounts?: Array<{ adaccount?: { id?: string; name?: string; currency?: string; status?: string } }> }>('snapchat_ads', ctx,
      `${API}/adaccounts/${encodeURIComponent(adAccountId)}`, { headers: { Authorization: `Bearer ${token}` }, retries: 1 });
    const a = res.adaccounts?.[0]?.adaccount;
    return { ok: a?.status === 'ACTIVE', details: { name: a?.name ?? null, currency: a?.currency ?? null, status: a?.status ?? null } };
  },
};

function nextDay(date: string) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

export function parseSnapStats(res: any, campaignId: string, currency: string): AdInsightRow[] {
  const rows: AdInsightRow[] = [];
  for (const wrapper of res?.timeseries_stats ?? []) {
    const ts = wrapper?.timeseries_stat;
    for (const point of ts?.timeseries ?? []) {
      const s = point?.stats ?? {};
      rows.push({
        externalCampaignId: String(ts?.id ?? campaignId),
        date: String(point?.start_time ?? '').slice(0, 10),
        impressions: toInt(s.impressions),
        clicks: toInt(s.swipes),
        spendMinor: microToMinor(s.spend),
        currency,
        conversions: toInt(s.conversion_purchases),
      });
    }
  }
  return rows;
}
