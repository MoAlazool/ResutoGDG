// TikTok for Business — Marketing API v1.3 adapter.
// Docs: https://business-api.tiktok.com/portal/docs (Authorization, Campaign /campaign/create/,
//       Reporting /report/integrated/get/). TikTok returns HTTP 200 with a non-zero "code" on errors.
// Readiness: implemented_unverified (no TikTok developer app or advertiser account available).
import { providerRequest, ProviderError, type ProviderDescriptor } from '../core';
import { decimalToMinor, minorToDecimal, requireConfig, requireCred, toInt, type AdInsightRow, type AdsAdapter, type AdsObjective } from './types';

const API = 'https://business-api.tiktok.com/open_api/v1.3';

export const tiktokAdsDescriptor: ProviderDescriptor = {
  id: 'tiktok_ads',
  name: 'TikTok Ads',
  category: 'ads',
  countries: ['EG', 'SA'],
  authType: 'oauth',
  readiness: 'implemented_unverified',
  docsUrl: 'https://business-api.tiktok.com/portal/docs',
  capabilities: ['oauth', 'campaign_create_disabled', 'daily_reports'],
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
    const res = await providerRequest<TikTokEnvelope<{ access_token?: string; advertiser_ids?: string[] }>>('tiktok_ads', ctx, `${API}/oauth2/access_token/`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: app.clientId, secret: app.clientSecret, auth_code: code }), retries: 0,
    });
    const data = unwrapTikTok(res);
    if (!data?.access_token) throw new ProviderError('tiktok_ads', 'no access token in response', false);
    return { accessToken: data.access_token, accountIds: data.advertiser_ids ?? [] };
  },

  async createCampaign(ctx, input) {
    const token = requireCred('tiktok_ads', ctx, 'accessToken');
    const advertiserId = requireConfig('tiktok_ads', ctx, 'advertiserId');
    const body: Record<string, unknown> = {
      advertiser_id: advertiserId,
      campaign_name: input.name.slice(0, 512),
      objective_type: OBJECTIVE[input.objective],
      operation_status: 'DISABLE',
      budget_mode: input.dailyBudgetMinor ? 'BUDGET_MODE_DAY' : 'BUDGET_MODE_INFINITE',
    };
    if (input.dailyBudgetMinor) body.budget = Number(minorToDecimal(input.dailyBudgetMinor)); // major units
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

