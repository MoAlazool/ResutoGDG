import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { scriptedFetch } from '../messaging/testing/scripted-fetch';
import { metaAdsAdapter, parseMetaInsight } from './meta-ads';
import { adsSandboxAdapter } from './sandbox';
import { microToMinor, parseSnapStats, snapchatAdsAdapter } from './snapchat-ads';
import { tiktokAdsAdapter } from './tiktok-ads';
import { decimalToMinor } from './types';

const app = { clientId: 'app-1', clientSecret: 'sec-1', redirectUri: 'https://api.test/v1/public/integrations/oauth/x/callback' };
const ctxFor = (fetch: typeof globalThis.fetch, config: Record<string, unknown>) => ({ environment: 'live' as const, credentials: { accessToken: 'tok' }, config, fetch });

describe('money parsing', () => {
  it('converts decimal strings exactly', () => {
    expect(decimalToMinor('12.34')).toBe(1234);
    expect(decimalToMinor('7')).toBe(700);
    expect(decimalToMinor('0.5')).toBe(50);
    expect(decimalToMinor('0.125')).toBe(13);
    expect(decimalToMinor('19.99')).toBe(1999);
    expect(decimalToMinor(undefined)).toBe(0);
    expect(() => decimalToMinor('1e3')).toThrow();
    expect(microToMinor(12_340_000)).toBe(1234);
  });
});

describe('Meta Ads', () => {
  it('builds the OAuth dialog URL (scope, or a Facebook Login for Business config_id) on the pinned version', () => {
    const u = new URL(metaAdsAdapter.buildAuthUrl(app, 'st4te'));
    expect(u.origin + u.pathname).toBe('https://www.facebook.com/v26.0/dialog/oauth');
    expect(Object.fromEntries(u.searchParams)).toEqual({ client_id: 'app-1', redirect_uri: app.redirectUri, state: 'st4te', response_type: 'code', scope: 'ads_management,ads_read,business_management' });
    const b = new URL(metaAdsAdapter.buildAuthUrl(app, 'st4te', { configId: '9001' }));
    expect(Object.fromEntries(b.searchParams)).toEqual({ client_id: 'app-1', redirect_uri: app.redirectUri, state: 'st4te', response_type: 'code', config_id: '9001', override_default_response_type: 'true' });
  });

  it('exchanges the code, upgrades to a long-lived token, reads the identity and the ad accounts (with appsecret_proof)', async () => {
    const f = scriptedFetch([
      { body: { access_token: 'EAAB-short', token_type: 'bearer', expires_in: 3600 } },
      { body: { access_token: 'EAAB-long', token_type: 'bearer', expires_in: 5183944 } },
      { body: { id: '10229', name: 'Mona' } },
      { body: { data: [{ id: 'act_111', account_id: '111', name: 'Olive Room', currency: 'EGP', account_status: 1 }, { id: 'act_222', account_id: '222', name: 'Old', currency: 'USD', account_status: 101 }] } },
    ]);
    const tokens = await metaAdsAdapter.exchangeCode({ fetch: f.fetch }, app, 'c0de');
    expect(tokens).toEqual({ accessToken: 'EAAB-long', expiresIn: 5183944, tokenKind: 'user', identity: { userId: '10229', businessId: null }, accountIds: ['act_111', 'act_222'],
      accounts: [{ id: 'act_111', name: 'Olive Room', currency: 'EGP', status: 'ACTIVE' }, { id: 'act_222', name: 'Old', currency: 'USD', status: 'CLOSED' }] });
    const exchange = new URL(f.calls[0]!.url);
    expect(exchange.pathname).toBe('/v26.0/oauth/access_token');
    expect(exchange.searchParams.get('code')).toBe('c0de');
    expect(exchange.searchParams.get('redirect_uri')).toBe(app.redirectUri);
    const longLived = new URL(f.calls[1]!.url);
    expect(Object.fromEntries(longLived.searchParams)).toEqual({ grant_type: 'fb_exchange_token', client_id: 'app-1', client_secret: 'sec-1', fb_exchange_token: 'EAAB-short' });
    const me = new URL(f.calls[2]!.url);
    expect(f.calls[2]!.headers.authorization).toBe('Bearer EAAB-long');
    // appsecret_proof = HMAC-SHA256(token, app secret), hex
    expect(me.searchParams.get('appsecret_proof')).toBe(createHmac('sha256', 'sec-1').update('EAAB-long').digest('hex'));
    expect(new URL(f.calls[3]!.url).pathname).toBe('/v26.0/me/adaccounts');
  });

  it('keeps a business integration system user token as is (no long-lived exchange) when a config id is used', async () => {
    const f = scriptedFetch([{ body: { access_token: 'EAAB-bisu' } }, { body: { id: '55', client_business_id: '777' } }, { body: { data: [] } }]);
    const tokens = await metaAdsAdapter.exchangeCode({ fetch: f.fetch }, app, 'c0de', { configId: '9001' });
    expect(tokens).toMatchObject({ accessToken: 'EAAB-bisu', expiresIn: null, tokenKind: 'system_user', identity: { userId: '55', businessId: '777' }, accounts: [] });
    expect(f.calls).toHaveLength(3);
    expect(new URL(f.calls[1]!.url).searchParams.get('fields')).toBe('id,client_business_id');
  });

  it('revokes user tokens with DELETE /{user-id}/permissions and says when Meta has no revocation API', async () => {
    const f = scriptedFetch([{ body: { success: true } }]);
    const ctx = { environment: 'live' as const, credentials: { accessToken: 'tok', appSecret: 'sec-1' }, config: { metaUserId: '10229', adAccountId: '1' }, fetch: f.fetch };
    expect(await metaAdsAdapter.revokeAccess!(ctx, app)).toMatchObject({ attempted: true, revoked: true });
    expect(f.calls[0]).toMatchObject({ method: 'DELETE' });
    expect(new URL(f.calls[0]!.url).pathname).toBe('/v26.0/10229/permissions');
    const gone = scriptedFetch([{ status: 400, body: { error: { message: 'Error validating access token', type: 'OAuthException', code: 190 } } }]);
    expect(await metaAdsAdapter.revokeAccess!({ ...ctx, fetch: gone.fetch }, app)).toMatchObject({ attempted: true, revoked: true });
    const bisu = await metaAdsAdapter.revokeAccess!({ ...ctx, config: { tokenKind: 'system_user' } }, app);
    expect(bisu).toMatchObject({ attempted: false, revoked: false });
    expect(bisu.note).toMatch(/Business Settings/);
  });

  it('creates a PAUSED campaign on the ad account with the token in the header, never in the body', async () => {
    const f = scriptedFetch([{ body: { id: '120210000000001' } }]);
    const res = await metaAdsAdapter.createCampaign(ctxFor(f.fetch, { adAccountId: '1234567890' }),
      { name: 'Reactivation', objective: 'sales', dailyBudgetMinor: 50000, currency: 'EGP', idempotencyToken: 'L7k2' });
    expect(res).toEqual({ externalId: '120210000000001', status: 'PAUSED' });
    expect(f.calls[0]!.url).toBe('https://graph.facebook.com/v26.0/act_1234567890/campaigns');
    expect(f.calls[0]!.headers.authorization).toBe('Bearer tok');
    const body = Object.fromEntries(new URLSearchParams(f.calls[0]!.body!));
    expect(body).toEqual({ name: 'Reactivation [rs:L7k2]', objective: 'OUTCOME_SALES', status: 'PAUSED', special_ad_categories: '[]', daily_budget: '50000', bid_strategy: 'LOWEST_COST_WITHOUT_CAP' });
  });

  it('finds the campaign an interrupted launch created, by its idempotency tag', async () => {
    const f = scriptedFetch([{ body: { data: [{ id: '1202', name: 'Reactivation [rs:L7k2]', status: 'PAUSED' }] } }]);
    expect(await metaAdsAdapter.findCampaignByToken!(ctxFor(f.fetch, { adAccountId: '1234567890' }), 'L7k2')).toEqual({ externalId: '1202', status: 'PAUSED' });
    expect(JSON.parse(new URL(f.calls[0]!.url).searchParams.get('filtering')!)).toEqual([{ field: 'name', operator: 'CONTAIN', value: '[rs:L7k2]' }]);
  });

  it('parses daily insights across pages without double counting purchase variants', async () => {
    const f = scriptedFetch([
      { body: { data: [{ campaign_id: '1201', impressions: '1520', clicks: '48', spend: '153.27', account_currency: 'EGP', date_start: '2026-10-01', date_stop: '2026-10-01',
        actions: [{ action_type: 'link_click', value: '48' }, { action_type: 'purchase', value: '3' }, { action_type: 'omni_purchase', value: '3' }] }],
        paging: { next: 'https://graph.facebook.com/v26.0/1201/insights?after=xyz' } } },
      { body: { data: [{ campaign_id: '1201', impressions: '900', clicks: '20', spend: '80', date_start: '2026-10-02', date_stop: '2026-10-02' }], paging: {} } },
    ]);
    const rows = await metaAdsAdapter.fetchInsights(ctxFor(f.fetch, {}), { externalCampaignId: '1201', since: '2026-10-01', until: '2026-10-02', currency: 'EGP' });
    expect(rows).toEqual([
      { externalCampaignId: '1201', date: '2026-10-01', impressions: 1520, clicks: 48, spendMinor: 15327, currency: 'EGP', conversions: 3 },
      { externalCampaignId: '1201', date: '2026-10-02', impressions: 900, clicks: 20, spendMinor: 8000, currency: 'EGP', conversions: 0 },
    ]);
    const first = new URL(f.calls[0]!.url);
    expect(first.searchParams.get('time_increment')).toBe('1');
    expect(JSON.parse(first.searchParams.get('time_range')!)).toEqual({ since: '2026-10-01', until: '2026-10-02' });
    expect(f.calls[1]!.url).toContain('after=xyz');
    expect(parseMetaInsight({ date_start: '2026-10-03' }, 'x', 'SAR')).toMatchObject({ spendMinor: 0, currency: 'SAR', externalCampaignId: 'x' });
  });

  it('surfaces Meta error codes: 190 is an invalid token (401), throttling is retryable', async () => {
    const bad = scriptedFetch([{ status: 400, body: { error: { message: 'Session has expired', type: 'OAuthException', code: 190, error_subcode: 463, fbtrace_id: 'AbC' } } }]);
    await expect(metaAdsAdapter.healthCheck(ctxFor(bad.fetch, { adAccountId: '1' }))).rejects.toMatchObject({ status: 401, retryable: false, code: 190, subcode: 463 });
    const slow = scriptedFetch([{ status: 400, body: { error: { message: 'User request limit reached', code: 17 } } }]);
    await expect(metaAdsAdapter.createCampaign(ctxFor(slow.fetch, { adAccountId: '1' }), { name: 'x', objective: 'traffic', currency: 'EGP' })).rejects.toMatchObject({ status: 429, retryable: true });
  });
});

describe('TikTok Ads', () => {
  it('builds the authorisation URL, exchanges the auth code and names the advertisers for the picker', async () => {
    const u = new URL(tiktokAdsAdapter.buildAuthUrl(app, 's1'));
    expect(u.origin + u.pathname).toBe('https://business-api.tiktok.com/portal/auth');
    expect(u.searchParams.get('app_id')).toBe('app-1');
    const f = scriptedFetch([
      { body: { code: 0, message: 'OK', data: { access_token: 'tt-token', advertiser_ids: ['7000000000001', '7000000000002'] } } },
      { body: { code: 0, message: 'OK', data: { list: [{ advertiser_id: 7000000000001, advertiser_name: 'Olive Room' }] } } },
    ]);
    expect(await tiktokAdsAdapter.exchangeCode({ fetch: f.fetch }, app, 'auth-code')).toEqual({ accessToken: 'tt-token', accountIds: ['7000000000001', '7000000000002'], tokenKind: 'advertiser',
      accounts: [{ id: '7000000000001', name: 'Olive Room', currency: null, status: null }, { id: '7000000000002', name: null, currency: null, status: null }] });
    expect(JSON.parse(f.calls[0]!.body!)).toEqual({ app_id: 'app-1', secret: 'sec-1', auth_code: 'auth-code' });
    expect(new URL(f.calls[1]!.url).pathname).toBe('/open_api/v1.3/oauth2/advertiser/get/');
    expect(f.calls[1]!.headers['access-token']).toBe('tt-token');
  });

  it('revokes the token at TikTok on disconnect and treats an already-invalid token as revoked', async () => {
    const f = scriptedFetch([{ body: { code: 0, message: 'OK', data: {} } }]);
    expect(await tiktokAdsAdapter.revokeAccess!(ctxFor(f.fetch, {}), app)).toMatchObject({ attempted: true, revoked: true });
    expect(new URL(f.calls[0]!.url).pathname).toBe('/open_api/v1.3/oauth2/revoke_token/');
    expect(f.calls[0]!.headers['access-token']).toBe('tok');
    const gone = scriptedFetch([{ body: { code: 40105, message: 'Access token is incorrect or has been revoked.' } }]);
    expect(await tiktokAdsAdapter.revokeAccess!(ctxFor(gone.fetch, {}), app)).toMatchObject({ revoked: true });
    expect(await tiktokAdsAdapter.revokeAccess!(ctxFor(gone.fetch, {}), null)).toMatchObject({ attempted: false, revoked: false });
  });

  it('treats a non-zero code in a 200 response as an error', async () => {
    const f = scriptedFetch([{ body: { code: 40001, message: 'Access token is incorrect', data: {} } }]);
    await expect(tiktokAdsAdapter.createCampaign(ctxFor(f.fetch, { advertiserId: '7000000000001' }), { name: 'x', objective: 'traffic', currency: 'SAR' }))
      .rejects.toMatchObject({ retryable: false });
  });

  it('creates a disabled campaign with a daily budget in major units and the launch tag in its name', async () => {
    const f = scriptedFetch([{ body: { code: 0, message: 'OK', data: { campaign_id: '1780000000000001' } } }]);
    const res = await tiktokAdsAdapter.createCampaign(ctxFor(f.fetch, { advertiserId: '7000000000001' }),
      { name: 'Weekend', objective: 'traffic', dailyBudgetMinor: 25050, currency: 'SAR', idempotencyToken: 'Z9' });
    expect(res).toEqual({ externalId: '1780000000000001', status: 'DISABLE' });
    expect(f.calls[0]!.headers['access-token']).toBe('tok');
    expect(JSON.parse(f.calls[0]!.body!)).toEqual({ advertiser_id: '7000000000001', campaign_name: 'Weekend [rs:Z9]', objective_type: 'TRAFFIC', operation_status: 'DISABLE', budget_mode: 'BUDGET_MODE_DAY', budget: 250.5 });
  });
  it('parses integrated reports', async () => {
    const f = scriptedFetch([{ body: { code: 0, message: 'OK', data: { list: [
      { dimensions: { campaign_id: '1780000000000001', stat_time_day: '2026-10-01 00:00:00' }, metrics: { spend: '41.20', impressions: '3000', clicks: '61', conversion: '2', currency: 'SAR' } },
    ], page_info: { page: 1, page_size: 200, total_number: 1, total_page: 1 } } } }]);
    const rows = await tiktokAdsAdapter.fetchInsights(ctxFor(f.fetch, { advertiserId: '7000000000001' }), { externalCampaignId: '1780000000000001', since: '2026-10-01', until: '2026-10-01', currency: 'SAR' });
    expect(rows).toEqual([{ externalCampaignId: '1780000000000001', date: '2026-10-01', impressions: 3000, clicks: 61, spendMinor: 4120, currency: 'SAR', conversions: 2 }]);
    const u = new URL(f.calls[0]!.url);
    expect(JSON.parse(u.searchParams.get('dimensions')!)).toEqual(['campaign_id', 'stat_time_day']);
    expect(JSON.parse(u.searchParams.get('filtering')!)[0]).toEqual({ field_name: 'campaign_ids', filter_type: 'IN', filter_value: '["1780000000000001"]' });
  });
});

describe('Snapchat Ads', () => {
  it('builds the authorize URL and exchanges the code (form-encoded)', async () => {
    const u = new URL(snapchatAdsAdapter.buildAuthUrl(app, 's2'));
    expect(u.origin + u.pathname).toBe('https://accounts.snapchat.com/login/oauth2/authorize');
    expect(u.searchParams.get('scope')).toBe('snapchat-marketing-api');
    const f = scriptedFetch([
      { body: { access_token: 'snap-at', refresh_token: 'snap-rt', expires_in: 3600, token_type: 'Bearer' } },
      { body: { request_status: 'SUCCESS', organizations: [{ sub_request_status: 'SUCCESS', organization: { id: 'org-1', ad_accounts: [{ id: 'acc-1', name: 'Olive Room', currency: 'SAR', status: 'ACTIVE' }] } }] } },
    ]);
    expect(await snapchatAdsAdapter.exchangeCode({ fetch: f.fetch }, app, 'code9')).toEqual({ accessToken: 'snap-at', refreshToken: 'snap-rt', expiresIn: 3600, tokenKind: 'user',
      accountIds: ['acc-1'], accounts: [{ id: 'acc-1', name: 'Olive Room', currency: 'SAR', status: 'ACTIVE' }] });
    expect(Object.fromEntries(new URLSearchParams(f.calls[0]!.body!))).toMatchObject({ grant_type: 'authorization_code', code: 'code9', client_id: 'app-1', client_secret: 'sec-1' });
    expect(f.calls[1]!.url).toBe('https://adsapi.snapchat.com/v1/me/organizations?with_ad_accounts=true');
    expect(f.calls[1]!.headers.authorization).toBe('Bearer snap-at');
  });

  it('refreshes the 1-hour access token with the refresh token; no revocation API is documented', async () => {
    const f = scriptedFetch([{ body: { access_token: 'snap-at-2', refresh_token: 'snap-rt-2', expires_in: 3600 } }]);
    expect(await snapchatAdsAdapter.refreshAccessToken({ fetch: f.fetch }, app, 'snap-rt')).toEqual({ accessToken: 'snap-at-2', refreshToken: 'snap-rt-2', expiresIn: 3600 });
    expect(Object.fromEntries(new URLSearchParams(f.calls[0]!.body!))).toEqual({ client_id: 'app-1', client_secret: 'sec-1', grant_type: 'refresh_token', refresh_token: 'snap-rt' });
    expect(await snapchatAdsAdapter.revokeAccess!(ctxFor(f.fetch, {}), app)).toMatchObject({ attempted: false, revoked: false });
  });

  it('creates a paused campaign and checks sub-request status', async () => {
    const ok = scriptedFetch([{ body: { request_status: 'SUCCESS', campaigns: [{ sub_request_status: 'SUCCESS', campaign: { id: 'c-uuid-1', status: 'PAUSED' } }] } }]);
    const res = await snapchatAdsAdapter.createCampaign(ctxFor(ok.fetch, { adAccountId: 'acc-1' }), { name: 'Iftar', objective: 'awareness', dailyBudgetMinor: 10000, currency: 'SAR', startTime: '2026-10-20T00:00:00.000Z' });
    expect(res).toEqual({ externalId: 'c-uuid-1', status: 'PAUSED' });
    expect(JSON.parse(ok.calls[0]!.body!).campaigns[0]).toEqual({ name: 'Iftar', ad_account_id: 'acc-1', status: 'PAUSED', start_time: '2026-10-20T00:00:00.000Z',
      objective_v2_properties: { objective_v2_type: 'AWARENESS_AND_ENGAGEMENT' }, daily_budget_micro: 100_000_000 });
    const bad = scriptedFetch([{ body: { request_status: 'ERROR', campaigns: [{ sub_request_status: 'ERROR', sub_request_error_reason: 'Invalid start_time' }] } }]);
    await expect(snapchatAdsAdapter.createCampaign(ctxFor(bad.fetch, { adAccountId: 'acc-1' }), { name: 'x', objective: 'traffic', currency: 'SAR' })).rejects.toThrow(/Invalid start_time/);
  });

  it('parses timeseries stats with micro-currency spend', () => {
    const rows = parseSnapStats({ request_status: 'SUCCESS', timeseries_stats: [{ timeseries_stat: { id: 'c-uuid-1', type: 'CAMPAIGN', granularity: 'DAY', timeseries: [
      { start_time: '2026-10-01T00:00:00.000+03:00', end_time: '2026-10-02T00:00:00.000+03:00', stats: { impressions: 5000, swipes: 120, spend: 52_340_000, conversion_purchases: 4 } },
    ] } }] }, 'c-uuid-1', 'SAR');
    expect(rows).toEqual([{ externalCampaignId: 'c-uuid-1', date: '2026-10-01', impressions: 5000, clicks: 120, spendMinor: 5234, currency: 'SAR', conversions: 4 }]);
  });
});

describe('ads sandbox', () => {
  it('records without a network call and never invents delivery', async () => {
    const created = await adsSandboxAdapter.createCampaign(ctxFor(undefined as any, {}), { name: 'x', objective: 'traffic', currency: 'EGP' });
    expect(created.externalId).toMatch(/^sandbox_/);
    const rows = await adsSandboxAdapter.fetchInsights(ctxFor(undefined as any, {}), { externalCampaignId: created.externalId, since: '2026-10-01', until: '2026-10-03', currency: 'EGP' });
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.spendMinor === 0 && r.impressions === 0 && r.clicks === 0 && r.conversions === 0)).toBe(true);
  });
});
