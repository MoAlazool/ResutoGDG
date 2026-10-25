// TikTok for Business — Marketing API v1.3 adapter.
// Docs: https://business-api.tiktok.com/portal/docs (Authorization, Campaign /campaign/create/,
//       Reporting /report/integrated/get/). TikTok returns HTTP 200 with a non-zero "code" on errors.
// Readiness: implemented_unverified (no TikTok developer app or advertiser account available).
import { providerRequest, ProviderError, type ProviderDescriptor } from '../core';
import {
  campaignNameWithToken, decimalToMinor, adsMinorToDecimal, parseGrantedScopes, requireConfig, requireCred, toInt, type AdAccountChoice, type AdInsightRow, type AdsAdapter, type AdsObjective,
  type OAuthAppConfig,
} from './types';

const API = 'https://business-api.tiktok.com/open_api/v1.3';

/** GET /oauth2/advertiser/get/ (app_id, secret, Access-Token): the advertisers that authorised the app. */
async function advertisers(ctx: { fetch: typeof fetch }, app: OAuthAppConfig, token: string): Promise<AdAccountChoice[]> {
  const u = new URL(`${API}/oauth2/advertiser/get/`);
  u.searchParams.set('app_id', app.clientId);
  u.searchParams.set('secret', app.clientSecret ?? '');
  const data = unwrapTikTok(await providerRequest<TikTokEnvelope<{ list?: Array<{ advertiser_id?: string | number; advertiser_name?: string }> }>>('tiktok_ads', ctx, u.toString(),
    { headers: { 'Access-Token': token }, retries: 1 }));
  return (data?.list ?? []).filter((a) => a.advertiser_id != null).map((a) => ({ id: String(a.advertiser_id), name: a.advertiser_name ?? null, currency: null, status: null }));
}

export const tiktokAdsDescriptor: ProviderDescriptor = {
  id: 'tiktok_ads',
  name: 'TikTok Ads',
  category: 'ads',
  countries: ['EG', 'SA'],
  authType: 'oauth',
  connectMethod: 'oauth',
  // TikTok returns granted permissions as numeric scope ids whose names are not in the documentation checked
  // (docs/OPEN_BLOCKERS.md B-21): they are stored and shown, but not compared with per-capability requirements.
  reviewRequirements: ['app_review', 'ad_account_access'],
  readiness: 'implemented_unverified',
  docsUrl: 'https://business-api.tiktok.com/portal/docs',
  capabilities: ['oauth', 'oauth_state_bound', 'advertiser_picker', 'provider_revoke', 'campaign_create_disabled', 'launch_idempotency', 'daily_reports'],
  activation: [
    'Register a TikTok for Business developer app and request the Ads Management and Reporting scopes (app review).',
    'Set TIKTOK_APP_ID, TIKTOK_APP_SECRET and the redirect https://<api-host>/v1/public/integrations/oauth/tiktok_ads/callback on the Resuto API server.',
    'The restaurant authorises from Resuto > Integrations and selects its advertiser id; the advertiser must have a funded balance.',
    'Campaigns are created with operation_status DISABLE; ad groups and creatives are completed in TikTok Ads Manager.',
  ],
};

const OBJECTIVE: Record<AdsObjective, string> = {
  awareness: 'REACH', traffic: 'TRAFFIC', engagement: 'ENGAGEMENT', sales: 'WEB_CONVERSIONS', leads: 'LEAD_GENERATION',
};

interface TikTokEnvelope<T> { code?: number; message?: string; request_id?: string; data?: T }

/** Unwraps TikTok's envelope; code 40100 (QPS limit) is retryable. */
export function unwrapTikTok<T>(res: TikTokEnvelope<T>): T {
  if (res.code !== 0) {
    throw new ProviderError('tiktok_ads', `code ${res.code ?? '?'}: ${res.message ?? 'unknown error'}`, res.code === 40100 || res.code === 50000, res.code === 40100 ? 429 : undefined);
  }
  return res.data as T;
}

export const tiktokAdsAdapter: AdsAdapter = {
  descriptor: tiktokAdsDescriptor,

  buildAuthUrl(app, state) {
    const u = new URL('https://business-api.tiktok.com/portal/auth');
    u.searchParams.set('app_id', app.clientId);
    u.searchParams.set('state', state);
    u.searchParams.set('redirect_uri', app.redirectUri);
    return u.toString();
  },

  async exchangeCode(ctx, app, code) {
    if (!app.clientSecret) throw new ProviderError('tiktok_ads', 'app secret not configured', false);
    const res = await providerRequest<TikTokEnvelope<{ access_token?: string; advertiser_ids?: string[]; scope?: number[] }>>('tiktok_ads', ctx, `${API}/oauth2/access_token/`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: app.clientId, secret: app.clientSecret, auth_code: code }), retries: 0,
    });
    const data = unwrapTikTok(res);
    if (!data?.access_token) throw new ProviderError('tiktok_ads', 'no access token in response', false);
    const ids = (data.advertiser_ids ?? []).map(String);
    // Names for the picker; the ids from the token response stay authoritative if the listing fails.
    let accounts = ids.map((id) => ({ id, name: null, currency: null, status: null } as AdAccountChoice));
    try {
      const listed = await advertisers({ fetch: ctx.fetch }, app, data.access_token);
      if (listed.length) accounts = ids.map((id) => listed.find((a) => a.id === id) ?? { id, name: null, currency: null, status: null });
    } catch { /* keep the bare ids */ }
    return { accessToken: data.access_token, accountIds: ids, accounts, tokenKind: 'advertiser', grantedScopes: parseGrantedScopes(data.scope) };
  },

  async listAccounts(ctx, app) {
    if (!app) throw new ProviderError('tiktok_ads', 'app credentials not configured', false);
    return advertisers(ctx, app, requireCred('tiktok_ads', ctx, 'accessToken'));
  },

  /**
   * POST /oauth2/revoke_token/ with the Access-Token header. The endpoint exists (an unauthenticated probe on
   * 2026-10-20 answered code 40105 "Access token is incorrect or has been revoked"); the body follows the
   * access_token exchange (app_id, secret, access_token) and is confirmed by the acceptance check tiktok_ads.revoke.
   */
  async revokeAccess(ctx, app) {
    if (!app?.clientSecret) return { attempted: false, revoked: false, note: 'TikTok app credentials are not configured on this server; remove Resuto in TikTok Business Center > Apps.' };
    const token = requireCred('tiktok_ads', ctx, 'accessToken');
    const res = await providerRequest<TikTokEnvelope<unknown>>('tiktok_ads', ctx, `${API}/oauth2/revoke_token/`, {
      method: 'POST', headers: { 'Access-Token': token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: app.clientId, secret: app.clientSecret, access_token: token }), retries: 0,
    });
    if (res.code === 0) return { attempted: true, revoked: true, note: 'TikTok confirmed the token was revoked.' };
    if (res.code === 40105) return { attempted: true, revoked: true, note: 'The token was already invalid at TikTok.' };
    return { attempted: true, revoked: false, note: `TikTok did not confirm the revocation (code ${res.code ?? '?'}).` };
  },

  async createCampaign(ctx, input) {
    const token = requireCred('tiktok_ads', ctx, 'accessToken');
    const advertiserId = requireConfig('tiktok_ads', ctx, 'advertiserId');
    const body: Record<string, unknown> = {
      advertiser_id: advertiserId,
      campaign_name: campaignNameWithToken(input.name, input.idempotencyToken, 512),
      objective_type: OBJECTIVE[input.objective],
      operation_status: 'DISABLE',
      budget_mode: input.dailyBudgetMinor ? 'BUDGET_MODE_DAY' : 'BUDGET_MODE_INFINITE',
    };
    if (input.dailyBudgetMinor) body.budget = Number(adsMinorToDecimal(input.dailyBudgetMinor)); // major units
    const res = await providerRequest<TikTokEnvelope<{ campaign_id?: string }>>('tiktok_ads', ctx, `${API}/campaign/create/`, {
      method: 'POST', headers: { 'Access-Token': token, 'Content-Type': 'application/json' }, body: JSON.stringify(body), retries: 0,
    });
    const data = unwrapTikTok(res);
    if (!data?.campaign_id) throw new ProviderError('tiktok_ads', 'campaign create returned no id', false);
    return { externalId: String(data.campaign_id), status: 'DISABLE' };
  },

  async fetchInsights(ctx, input) {
    const token = requireCred('tiktok_ads', ctx, 'accessToken');
    const advertiserId = requireConfig('tiktok_ads', ctx, 'advertiserId');
    const rows: AdInsightRow[] = [];
    for (let page = 1, total = 1; page <= total && page <= 20; page++) {
      const u = new URL(`${API}/report/integrated/get/`);
      u.searchParams.set('advertiser_id', advertiserId);
      u.searchParams.set('report_type', 'BASIC');
      u.searchParams.set('data_level', 'AUCTION_CAMPAIGN');
      u.searchParams.set('dimensions', JSON.stringify(['campaign_id', 'stat_time_day']));
      u.searchParams.set('metrics', JSON.stringify(['spend', 'impressions', 'clicks', 'conversion', 'currency']));
      u.searchParams.set('start_date', input.since);
      u.searchParams.set('end_date', input.until);
      u.searchParams.set('filtering', JSON.stringify([{ field_name: 'campaign_ids', filter_type: 'IN', filter_value: JSON.stringify([input.externalCampaignId]) }]));
      u.searchParams.set('page', String(page));
      u.searchParams.set('page_size', '200');
      const res = await providerRequest<TikTokEnvelope<{ list?: any[]; page_info?: { total_page?: number } }>>('tiktok_ads', ctx, u.toString(), { headers: { 'Access-Token': token } });
      const data = unwrapTikTok(res);
      for (const r of data?.list ?? []) rows.push(parseTikTokRow(r, input.externalCampaignId, input.currency));
      total = data?.page_info?.total_page ?? 1;
    }
    return rows;
  },

  async healthCheck(ctx) {
    const token = requireCred('tiktok_ads', ctx, 'accessToken');
    const advertiserId = requireConfig('tiktok_ads', ctx, 'advertiserId');
    const u = new URL(`${API}/advertiser/info/`);
    u.searchParams.set('advertiser_ids', JSON.stringify([advertiserId]));
    u.searchParams.set('fields', JSON.stringify(['name', 'currency', 'status']));
    const data = unwrapTikTok(await providerRequest<TikTokEnvelope<{ list?: Array<{ name?: string; currency?: string; status?: string }> }>>('tiktok_ads', ctx, u.toString(), { headers: { 'Access-Token': token }, retries: 1 }));
    const a = data?.list?.[0];
    return { ok: a?.status === 'STATUS_ENABLE', details: { name: a?.name ?? null, currency: a?.currency ?? null, status: a?.status ?? null } };
  },
};

export function parseTikTokRow(r: any, campaignId: string, currency: string): AdInsightRow {
  const day = String(r?.dimensions?.stat_time_day ?? '').slice(0, 10);
  const m = r?.metrics ?? {};
  return {
    externalCampaignId: String(r?.dimensions?.campaign_id ?? campaignId),
    date: day,
    impressions: toInt(m.impressions),
    clicks: toInt(m.clicks),
    spendMinor: decimalToMinor(m.spend),
    currency: String(m.currency || currency),
    conversions: toInt(m.conversion),
  };
}

