// Meta (Facebook/Instagram) Marketing API adapter.
// Docs: OAuth https://developers.facebook.com/docs/facebook-login/guides/advanced/manual-flow
//       Campaigns https://developers.facebook.com/docs/marketing-api/reference/ad-account/campaigns
//       Insights https://developers.facebook.com/docs/marketing-api/insights
// Readiness: implemented_unverified (no Meta app or ad account available).
import { providerRequest, ProviderError, type AdapterContext, type ProviderDescriptor } from '../core';
import { decimalToMinor, requireConfig, requireCred, toInt, type AdInsightRow, type AdsAdapter, type AdsObjective } from './types';

export const META_GRAPH_VERSION = 'v23.0';
const GRAPH = `https://graph.facebook.com/${META_GRAPH_VERSION}`;

export const metaAdsDescriptor: ProviderDescriptor = {
  id: 'meta_ads',
  name: 'Meta Ads (Facebook & Instagram)',
  category: 'ads',
  countries: ['EG', 'SA'],
  authType: 'oauth',
  readiness: 'implemented_unverified',
  docsUrl: 'https://developers.facebook.com/docs/marketing-apis',
  capabilities: ['oauth', 'campaign_create_paused', 'daily_insights'],
  activation: [
    'Create a Meta app of type Business with the Marketing API product; request Advanced Access for ads_management and ads_read (App Review).',
    'Set META_APP_ID, META_APP_SECRET and the OAuth redirect https://<api-host>/v1/public/integrations/oauth/meta_ads/callback on the Resuto API server.',
    'The restaurant connects from Resuto > Integrations and selects its ad account (act_<id>) — the ad account must have a payment method in Meta Ads Manager.',
    'Campaigns are created PAUSED; ad sets, creatives and activation are completed in Ads Manager until ad-set creation is added.',
  ],
};

const OBJECTIVE: Record<AdsObjective, string> = {
  awareness: 'OUTCOME_AWARENESS', traffic: 'OUTCOME_TRAFFIC', engagement: 'OUTCOME_ENGAGEMENT', sales: 'OUTCOME_SALES', leads: 'OUTCOME_LEADS',
};

const PURCHASE_ACTIONS = new Set(['purchase', 'omni_purchase', 'offsite_conversion.fb_pixel_purchase', 'onsite_web_purchase']);
const act = (id: string) => (id.startsWith('act_') ? id : `act_${id}`);

export const metaAdsAdapter: AdsAdapter = {
  descriptor: metaAdsDescriptor,

  buildAuthUrl(app, state) {
    const u = new URL(`https://www.facebook.com/${META_GRAPH_VERSION}/dialog/oauth`);
    u.searchParams.set('client_id', app.clientId);
    u.searchParams.set('redirect_uri', app.redirectUri);
    u.searchParams.set('state', state);
    u.searchParams.set('response_type', 'code');
    u.searchParams.set('scope', 'ads_management,ads_read,business_management');
    return u.toString();
  },

  async exchangeCode(ctx, app, code) {
    if (!app.clientSecret) throw new ProviderError('meta_ads', 'app secret not configured', false);
    const u = new URL(`${GRAPH}/oauth/access_token`);
    u.searchParams.set('client_id', app.clientId);
    u.searchParams.set('client_secret', app.clientSecret);
    u.searchParams.set('redirect_uri', app.redirectUri);
    u.searchParams.set('code', code);
    const res = await providerRequest<{ access_token?: string; expires_in?: number }>('meta_ads', ctx, u.toString(), { retries: 0 });
    if (!res.access_token) throw new ProviderError('meta_ads', 'no access token in response', false);
    return { accessToken: res.access_token, expiresIn: res.expires_in ?? null };
  },

  async createCampaign(ctx, input) {
    const token = requireCred('meta_ads', ctx, 'accessToken');
    const account = act(requireConfig('meta_ads', ctx, 'adAccountId'));
    const body = new URLSearchParams({
      name: input.name.slice(0, 400),
      objective: OBJECTIVE[input.objective],
      status: 'PAUSED',
      special_ad_categories: '[]',
      access_token: token,
    });
    if (input.dailyBudgetMinor) {
      // Meta budgets are in the account currency's minor unit (e.g. piastres/halalas).
      body.set('daily_budget', String(input.dailyBudgetMinor));
      body.set('bid_strategy', 'LOWEST_COST_WITHOUT_CAP');
    } else {
      body.set('is_adset_budget_sharing_enabled', 'false');
    }
    const res = await providerRequest<{ id?: string }>('meta_ads', ctx, `${GRAPH}/${account}/campaigns`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body, retries: 0,
    });
    if (!res.id) throw new ProviderError('meta_ads', 'campaign create returned no id', false);
    return { externalId: res.id, status: 'PAUSED' };
  },

  async fetchInsights(ctx, input) {
    const token = requireCred('meta_ads', ctx, 'accessToken');
    const u = new URL(`${GRAPH}/${encodeURIComponent(input.externalCampaignId)}/insights`);
    u.searchParams.set('fields', 'campaign_id,impressions,clicks,spend,actions,account_currency,date_start,date_stop');
    u.searchParams.set('time_increment', '1');
    u.searchParams.set('time_range', JSON.stringify({ since: input.since, until: input.until }));
    u.searchParams.set('limit', '100');
    const rows: AdInsightRow[] = [];
    let next: string | null = u.toString();
    for (let page = 0; next && page < 20; page++) {
      const res: { data?: any[]; paging?: { next?: string } } = await providerRequest('meta_ads', ctx, next, { headers: { Authorization: `Bearer ${token}` } });
      for (const r of res.data ?? []) rows.push(parseMetaInsight(r, input.externalCampaignId, input.currency));
      next = res.paging?.next ?? null;
    }
    return rows;
  },

  async healthCheck(ctx) {
    const token = requireCred('meta_ads', ctx, 'accessToken');
    const account = act(requireConfig('meta_ads', ctx, 'adAccountId'));
    const res = await providerRequest<{ id?: string; name?: string; currency?: string; account_status?: number }>('meta_ads', ctx,
      `${GRAPH}/${account}?fields=name,currency,account_status`, { headers: { Authorization: `Bearer ${token}` }, retries: 1 });
    // account_status 1 = ACTIVE
    return { ok: res.account_status === 1, details: { name: res.name ?? null, currency: res.currency ?? null, accountStatus: res.account_status ?? null } };
  },
};

export function parseMetaInsight(r: any, campaignId: string, currency: string): AdInsightRow {
  const conversions = (Array.isArray(r.actions) ? r.actions : [])
    .filter((a: any) => PURCHASE_ACTIONS.has(a?.action_type))
    .reduce((n: number, a: any) => Math.max(n, toInt(a.value)), 0); // purchase variants overlap; take the largest, never the sum
  return {
    externalCampaignId: String(r.campaign_id ?? campaignId),
    date: String(r.date_start),
    impressions: toInt(r.impressions),
    clicks: toInt(r.clicks),
    spendMinor: decimalToMinor(r.spend),
    currency: String(r.account_currency ?? currency),
    conversions,
  };
}

