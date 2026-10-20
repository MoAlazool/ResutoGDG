// Meta (Facebook/Instagram) Marketing API adapter.
// Docs (checked 2026-10-20; version pin and sources in ../meta/graph.ts):
//   OAuth (manual flow, Facebook Login for Business config_id, long-lived tokens, revoke): see ../meta/oauth.ts
//   Ad accounts of the person:  GET /me/adaccounts   https://developers.facebook.com/docs/marketing-api/reference/ad-account
//   Campaigns                   https://developers.facebook.com/docs/marketing-api/reference/ad-account/campaigns
//   Insights                    https://developers.facebook.com/docs/marketing-api/insights
//   appsecret_proof             https://developers.facebook.com/docs/graph-api/securing-requests
// Readiness: implemented_unverified (no Meta app or ad account available). Acceptance checks: ../acceptance/meta.ts.
import { ProviderError, type AdapterContext, type ProviderDescriptor } from '../core';
import { graphList, graphRequest, MetaApiError, META_GRAPH_VERSION, metaAuth } from '../meta/graph';
import { metaExchangeCode, metaExchangeLongLived, metaLoginUrl, metaRevokePermissions, metaTokenIdentity } from '../meta/oauth';
import {
  campaignNameWithToken, decimalToMinor, requireConfig, toInt, type AdAccountChoice, type AdInsightRow, type AdsAdapter, type AdsObjective, type OAuthAppConfig,
} from './types';

export const META_ADS_SCOPES = ['ads_management', 'ads_read', 'business_management'];

export const metaAdsDescriptor: ProviderDescriptor = {
  id: 'meta_ads',
  name: 'Meta Ads (Facebook & Instagram)',
  category: 'ads',
  countries: ['EG', 'SA'],
  authType: 'oauth',
  readiness: 'implemented_unverified',
  docsUrl: 'https://developers.facebook.com/docs/marketing-apis',
  capabilities: ['oauth', 'oauth_state_bound', 'long_lived_token', 'ad_account_picker', 'appsecret_proof', 'provider_revoke', 'campaign_create_paused',
    'launch_idempotency', 'daily_insights', 'custom_audience_dry_run'],
  activation: [
    'Create a Meta app of type Business with the Marketing API product; request Advanced Access for ads_management, ads_read and business_management (App Review).',
    'Set META_APP_ID and META_APP_SECRET on the Resuto API server and add https://<api-host>/v1/public/integrations/oauth/meta_ads/callback as a valid OAuth redirect URI. Optional: META_ADS_LOGIN_CONFIG_ID (a Facebook Login for Business configuration for a business integration system user token, which does not expire).',
    'The restaurant connects from Resuto > Integrations, approves access in the Meta window, then picks its ad account (act_<id>) in Resuto. The ad account needs a payment method in Meta Ads Manager.',
    'Campaigns are created PAUSED; ad sets, creatives and activation are completed in Ads Manager until ad-set creation is added.',
  ],
};

const OBJECTIVE: Record<AdsObjective, string> = {
  awareness: 'OUTCOME_AWARENESS', traffic: 'OUTCOME_TRAFFIC', engagement: 'OUTCOME_ENGAGEMENT', sales: 'OUTCOME_SALES', leads: 'OUTCOME_LEADS',
};

const PURCHASE_ACTIONS = new Set(['purchase', 'omni_purchase', 'offsite_conversion.fb_pixel_purchase', 'onsite_web_purchase']);
export const act = (id: string) => (id.startsWith('act_') ? id : `act_${id}`);
/** Meta ad account_status: 1 ACTIVE, 2 DISABLED, 3 UNSETTLED, 7 PENDING_RISK_REVIEW, 8 PENDING_SETTLEMENT, 9 IN_GRACE_PERIOD, 100/101 CLOSED. */
const ACCOUNT_STATUS: Record<number, string> = { 1: 'ACTIVE', 2: 'DISABLED', 3: 'UNSETTLED', 7: 'PENDING_RISK_REVIEW', 8: 'PENDING_SETTLEMENT', 9: 'IN_GRACE_PERIOD', 100: 'PENDING_CLOSURE', 101: 'CLOSED' };

const toChoice = (a: { id?: string; account_id?: string; name?: string; currency?: string; account_status?: number }): AdAccountChoice => ({
  id: act(String(a.account_id ?? a.id ?? '')), name: a.name ?? null, currency: a.currency ?? null,
  status: typeof a.account_status === 'number' ? ACCOUNT_STATUS[a.account_status] ?? String(a.account_status) : null,
});

async function adAccounts(ctx: Pick<AdapterContext, 'fetch'>, token: string, appSecret: string | null): Promise<AdAccountChoice[]> {
  const rows = await graphList<{ id?: string; account_id?: string; name?: string; currency?: string; account_status?: number }>('meta_ads', ctx, 'me/adaccounts',
    { token, appSecret, query: { fields: 'account_id,name,currency,account_status', limit: 100 }, retries: 1, maxPages: 5 });
  return rows.map(toChoice).filter((a) => a.id !== 'act_');
}

export const metaAdsAdapter: AdsAdapter = {
  descriptor: metaAdsDescriptor,

  buildAuthUrl(app, state, opts = {}) {
    return metaLoginUrl(app, opts.configId ? { state, configId: opts.configId, systemUserToken: true } : { state, scope: META_ADS_SCOPES });
  },

  /**
   * Code → token. Classic Facebook Login gives a short-lived user token, which is exchanged for a long-lived one
   * (≈ 60 days, expiry stored); a Facebook Login for Business configuration gives a business integration system user
   * token (no expiry). Then reads the token's identity (to revoke it on disconnect) and the ad accounts it can use.
   */
  async exchangeCode(ctx, app, code, opts = {}) {
    const systemUser = !!opts.configId;
    const first = await metaExchangeCode('meta_ads', ctx, app, code);
    const token = systemUser ? first : await metaExchangeLongLived('meta_ads', ctx, app, first.accessToken);
    const proof = app.clientSecret ?? null;
    const identity = await metaTokenIdentity('meta_ads', ctx, token.accessToken, proof, systemUser);
    const accounts = await adAccounts(ctx, token.accessToken, proof);
    return {
      accessToken: token.accessToken, expiresIn: systemUser ? null : token.expiresIn, tokenKind: systemUser ? 'system_user' : 'user',
      identity: { userId: identity.userId, businessId: identity.clientBusinessId }, accountIds: accounts.map((a) => a.id), accounts,
    };
  },

  async listAccounts(ctx) {
    const { token, appSecret } = metaAuth('meta_ads', ctx);
    return adAccounts(ctx, token, appSecret);
  },

  /**
   * Disconnect: user tokens are de-authorised with DELETE /{user-id}/permissions (documented). Meta documents no API
   * to revoke a business integration system user token: the business removes the app in Business Settings.
   */
  async revokeAccess(ctx) {
    const userId = typeof ctx.config.metaUserId === 'string' ? ctx.config.metaUserId : null;
    if (ctx.config.tokenKind === 'system_user' || !userId) {
      return { attempted: false, revoked: false, note: 'Meta has no API to revoke this token: remove the Resuto app in Meta Business Settings > Integrations > Connected apps.' };
    }
    const { token, appSecret } = metaAuth('meta_ads', ctx);
    try {
      const ok = await metaRevokePermissions('meta_ads', ctx, userId, token, appSecret);
      return { attempted: true, revoked: ok, note: ok ? 'Meta confirmed the permissions were removed.' : 'Meta did not confirm the revocation.' };
    } catch (e) {
      if (e instanceof MetaApiError && e.tokenInvalid) return { attempted: true, revoked: true, note: 'The token was already invalid at Meta.' };
      throw e;
    }
  },

  async createCampaign(ctx, input) {
    const { token, appSecret } = metaAuth('meta_ads', ctx);
    const account = act(requireConfig('meta_ads', ctx, 'adAccountId'));
    const form: Record<string, string> = {
      name: campaignNameWithToken(input.name, input.idempotencyToken, 400),
      objective: OBJECTIVE[input.objective],
      status: 'PAUSED',
      special_ad_categories: '[]',
    };
    if (input.dailyBudgetMinor) {
      // Meta budgets are in the account currency's minor unit (e.g. piastres/halalas).
      form.daily_budget = String(input.dailyBudgetMinor);
      form.bid_strategy = 'LOWEST_COST_WITHOUT_CAP';
    } else {
      form.is_adset_budget_sharing_enabled = 'false';
    }
    const res = await graphRequest<{ id?: string }>('meta_ads', ctx, `${account}/campaigns`, { method: 'POST', token, appSecret, form, retries: 0 });
    if (!res.id) throw new ProviderError('meta_ads', 'campaign create returned no id', false);
    return { externalId: res.id, status: 'PAUSED' };
  },

  /** Finds a campaign whose name carries this launch's "[rs:<token>]" tag (crash recovery between create and commit). */
  async findCampaignByToken(ctx, idemToken) {
    const { token, appSecret } = metaAuth('meta_ads', ctx);
    const account = act(requireConfig('meta_ads', ctx, 'adAccountId'));
    const rows = await graphList<{ id?: string; name?: string; status?: string }>('meta_ads', ctx, `${account}/campaigns`, {
      token, appSecret, retries: 1, maxPages: 3,
      query: { fields: 'id,name,status', limit: 50, filtering: JSON.stringify([{ field: 'name', operator: 'CONTAIN', value: `[rs:${idemToken}]` }]) },
    });
    const hit = rows.find((r) => r.id && r.name?.includes(`[rs:${idemToken}]`));
    return hit ? { externalId: String(hit.id), status: hit.status ?? 'PAUSED' } : null;
  },

  async fetchInsights(ctx, input) {
    const { token, appSecret } = metaAuth('meta_ads', ctx);
    const rows = await graphList<any>('meta_ads', ctx, `${encodeURIComponent(input.externalCampaignId)}/insights`, {
      token, appSecret, retries: 2, maxPages: 20,
      query: { fields: 'campaign_id,impressions,clicks,spend,actions,account_currency,date_start,date_stop', time_increment: 1,
        time_range: JSON.stringify({ since: input.since, until: input.until }), limit: 100 },
    });
    return rows.map((r) => parseMetaInsight(r, input.externalCampaignId, input.currency));
  },

  async healthCheck(ctx) {
    const { token, appSecret } = metaAuth('meta_ads', ctx);
    const account = act(requireConfig('meta_ads', ctx, 'adAccountId'));
    const res = await graphRequest<{ id?: string; name?: string; currency?: string; account_status?: number }>('meta_ads', ctx, account,
      { token, appSecret, query: { fields: 'name,currency,account_status' }, retries: 1 });
    // account_status 1 = ACTIVE
    return { ok: res.account_status === 1, details: { name: res.name ?? null, currency: res.currency ?? null, accountStatus: res.account_status ?? null, graphVersion: META_GRAPH_VERSION },
      account: { id: account, name: res.name ?? null, currency: res.currency ?? null } };
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

/** For callers that only have the app config (re-exported for the API's OAuth service). */
export type { OAuthAppConfig };
