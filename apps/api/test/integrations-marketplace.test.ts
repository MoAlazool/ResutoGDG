// 21-INT marketplace (plan §6.3): every catalogue card carries its connect method, category and an honest status chip
// derived from readiness and the connection; OAuth connections store the scopes the provider granted and the Meta
// permission check names what is missing; "Pending provider review" until Resuto's operator records the approval.
// Provider calls are scripted; nothing reaches a provider.
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import { PlatformProviderAppsService } from '../src/modules/integrations/provider-apps.service';
import { ProviderHttp } from '../src/modules/integrations/provider-http';
import { scriptedFetch } from './growth-helpers';
import { addMember, auth, bootTestApp, createTenant, signup, sql, type TestApp, type TestTenant } from './helpers';

const ENV = { META_APP_ID: 'meta-app-mk', META_APP_SECRET: 'meta-app-secret-mk', SNAPCHAT_CLIENT_ID: 'snap-mk', SNAPCHAT_CLIENT_SECRET: 'snap-secret-mk' };
let t: TestApp;
let http: ProviderHttp;
let original: typeof fetch;
beforeAll(async () => {
  Object.assign(process.env, ENV);
  t = await bootTestApp();
  http = t.app.get(ProviderHttp);
  original = http.fetch;
});
afterEach(() => { http.fetch = original; });
afterAll(async () => {
  await sql(`delete from platform_provider_apps`);
  await t.app.get(PlatformProviderAppsService).refresh();
  for (const k of Object.keys(ENV)) delete process.env[k];
  await t.close();
});

const script = (responses: Parameters<typeof scriptedFetch>[0]) => { const f = scriptedFetch(responses); http.fetch = f.fetch; return f; };
const catalog = async (tn: TestTenant) => (await t.http.get(`/v1/o/${tn.orgId}/integrations/catalog`).set(auth(tn.owner))).body.items as any[];
const item = async (tn: TestTenant, id: string) => (await catalog(tn)).find((i) => i.id === id);

async function oauth(tn: TestTenant, provider: string, responses: Parameters<typeof scriptedFetch>[0]) {
  const nonce = randomBytes(32).toString('base64url');
  const start = await t.http.post(`/v1/o/${tn.orgId}/integrations/oauth/${provider}/start`).set(auth(tn.owner))
    .send({ browserBinding: createHash('sha256').update(nonce).digest('hex') });
  expect(start.status).toBe(200);
  const state = new URL(start.body.url).searchParams.get('state')!;
  script(responses);
  const done = await t.http.post(`/v1/o/${tn.orgId}/integrations/oauth/${provider}/complete`).set(auth(tn.owner)).send({ code: 'code-1', state, browserNonce: nonce });
  expect(done.status).toBe(200);
  return done.body;
}

describe('marketplace catalogue', () => {
  it('every card has its connect method, category and a chip; nothing is "verified" without a recorded run', async () => {
    const tn = await createTenant(t, { country: 'EG' });
    const items = await catalog(tn);
    const by = Object.fromEntries(items.map((i) => [i.id, i]));
    expect(by.meta_ads).toMatchObject({ connectMethod: 'oauth', marketplaceCategory: 'ads_tracking', marketplace: { status: 'not_connected', connectionId: null } });
    expect(by.whatsapp_cloud).toMatchObject({ connectMethod: 'embedded_signup', marketplaceCategory: 'messaging' });
    expect(by.eta_ereceipt.connectMethod).toBe('guided_onboarding');
    expect(by.paymob).toMatchObject({ connectMethod: 'api_key', marketplaceCategory: 'payments' });
    expect(by.google_routes.marketplaceCategory).toBe('delivery_maps');
    expect(by.messaging_sandbox).toMatchObject({ connectMethod: 'platform_managed', marketplace: { status: 'sandbox', reasons: ['simulated'] } });
    // Stripe does not onboard businesses in Egypt (documented restriction): not available, whatever the connection.
    expect(by.stripe.marketplace.status).toBe('not_available');
    expect(by.meta_ads.reviewRequirements).toEqual(['app_review', 'business_verification', 'ad_account_access']);
    expect(by.meta_ads.requiredScopes.campaign_create_paused).toEqual(['ads_management']);
    for (const i of items) {
      expect(['not_connected', 'connected', 'needs_attention', 'sandbox', 'pending_review', 'not_available']).toContain(i.marketplace.status);
      for (const c of i.readinessDetail?.capabilities ?? []) expect(['official_test_verified', 'live_verified']).not.toContain(c.live);
    }
  });

  it('a pasted-key test connection needs attention until its first check, and is never "Connected" in test mode', async () => {
    const tn = await createTenant(t);
    const created = await t.http.post(`/v1/o/${tn.orgId}/integrations/connections`).set(auth(tn.owner))
      .send({ provider: 'gemini_byok', environment: 'sandbox', credentials: { apiKey: 'AIza-test-key-0000000000' } });
    expect(created.status).toBe(201);
    expect((await item(tn, 'gemini_byok')).marketplace).toMatchObject({ status: 'needs_attention', reasons: ['awaiting_check'], connectionId: created.body.id });
    await sql(`update integration_connections set status = 'connected' where id = $1`, [created.body.id]);
    expect((await item(tn, 'gemini_byok')).marketplace).toMatchObject({ status: 'sandbox', reasons: ['test_environment'] });
    await sql(`update integration_connections set environment = 'live' where id = $1`, [created.body.id]);
    expect((await item(tn, 'gemini_byok')).marketplace.status).toBe('connected');
    await t.http.post(`/v1/o/${tn.orgId}/integrations/connections/${created.body.id}/revoke`).set(auth(tn.owner)).send({});
    expect((await item(tn, 'gemini_byok')).marketplace).toMatchObject({ status: 'not_connected', reasons: ['revoked'] });
  });
});

describe('permission verification', () => {
  it('Snapchat: scopes from the token response are stored and compared per capability', async () => {
    const tn = await createTenant(t);
    const body = await oauth(tn, 'snapchat_ads', [
      { body: { access_token: 'snap-at', refresh_token: 'snap-rt', expires_in: 3600, scope: 'snapchat-marketing-api' } },
      { body: { organizations: [{ organization: { ad_accounts: [{ id: 'acc-1', name: 'Olive', currency: 'SAR', status: 'ACTIVE' }] } }] } },
      { body: { adaccounts: [{ adaccount: { id: 'acc-1', name: 'Olive', currency: 'SAR', status: 'ACTIVE' } }] } },
    ]);
    const view = (await t.http.get(`/v1/o/${tn.orgId}/integrations/connections/${body.connection.id}`).set(auth(tn.owner))).body;
    expect(view.grantedScopes).toEqual(['snapchat-marketing-api']);
    expect(view.permissions).toMatchObject({ checked: true, missing: [], checkable: false, source: 'token_response' });
    // Snap does not let Resuto re-read the grant: reconnecting refreshes it.
    const check = await t.http.post(`/v1/o/${tn.orgId}/integrations/connections/${body.connection.id}/permissions`).set(auth(tn.owner)).send({});
    expect(check.status).toBe(422);
    expect(check.body.error.code).toBe('permissions_not_checkable');
  });

  it('Snapchat without the marketing scope: "needs permission snapchat-marketing-api" and Needs attention', async () => {
    const tn = await createTenant(t);
    const body = await oauth(tn, 'snapchat_ads', [
      { body: { access_token: 'snap-at', refresh_token: 'snap-rt', expires_in: 3600, scope: 'snapchat-profile-api' } },
      { body: { organizations: [] } },
    ]);
    const view = (await t.http.get(`/v1/o/${tn.orgId}/integrations/connections/${body.connection.id}`).set(auth(tn.owner))).body;
    expect(view.permissions.missing).toContainEqual({ capability: 'campaign_create_paused', scopes: ['snapchat-marketing-api'] });
    const card = await item(tn, 'snapchat_ads');
    expect(card.marketplace.status).toBe('needs_attention');
    expect(card.marketplace.reasons).toEqual(expect.arrayContaining(['missing_permissions', 'choose_account']));
  });

  it('Meta: the existing code exchange is unchanged; the permission check reads /me/permissions and names what is missing', async () => {
    const tn = await createTenant(t);
    const body = await oauth(tn, 'meta_ads', [
      { body: { access_token: 'EAAB-short', expires_in: 3600 } },
      { body: { access_token: 'EAAB-long-lived', expires_in: 5183944 } },
      { body: { id: '10229', name: 'Mona' } },
      { body: { data: [{ account_id: '111', name: 'Olive Ads', currency: 'EGP', account_status: 1 }] } },
      { body: { id: 'act_111', name: 'Olive Ads', currency: 'EGP', account_status: 1 } },
    ]);
    const id = body.connection.id;
    const before = (await t.http.get(`/v1/o/${tn.orgId}/integrations/connections/${id}`).set(auth(tn.owner))).body;
    expect(before.permissions).toMatchObject({ checked: false, checkable: true, source: 'permissions_api', granted: [] });

    const manager = await addMember(t, tn, 'manager');
    expect((await t.http.post(`/v1/o/${tn.orgId}/integrations/connections/${id}/permissions`).set(auth(manager)).send({})).status).toBe(403);
    const outsider = await createTenant(t);
    expect((await t.http.post(`/v1/o/${tn.orgId}/integrations/connections/${id}/permissions`).set(auth(outsider.owner)).send({})).status).toBe(404);

    const f = script([{ body: { data: [{ permission: 'ads_read', status: 'granted' }, { permission: 'ads_management', status: 'declined' }] } }]);
    const checked = await t.http.post(`/v1/o/${tn.orgId}/integrations/connections/${id}/permissions`).set(auth(tn.owner)).send({});
    expect(checked.status).toBe(200);
    expect(new URL(f.calls[0]!.url).pathname).toMatch(/\/me\/permissions$/);
    expect(f.calls[0]!.headers.authorization).toBe('Bearer EAAB-long-lived');
    expect(checked.body.grantedScopes).toEqual(['ads_read']);
    expect(checked.body.permissions.missing).toEqual(expect.arrayContaining([
      { capability: 'campaign_create_paused', scopes: ['ads_management'] }, { capability: 'custom_audience_dry_run', scopes: ['ads_management'] },
    ]));
    expect(JSON.stringify(checked.body)).not.toContain('EAAB-long-lived');
    let card = await item(tn, 'meta_ads');
    expect(card.marketplace.reasons).toContain('missing_permissions');

    script([{ body: { data: ['ads_read', 'ads_management', 'business_management'].map((permission) => ({ permission, status: 'granted' })) } }]);
    await t.http.post(`/v1/o/${tn.orgId}/integrations/connections/${id}/permissions`).set(auth(tn.owner)).send({});
    await sql(`update integration_connections set status = 'connected' where id = $1`, [id]);
    // Through Resuto's app, with App Review not recorded as approved by the operator: pending provider review.
    card = await item(tn, 'meta_ads');
    expect(card.marketplace).toMatchObject({ status: 'pending_review', reasons: ['review_pending'], providerReview: 'unknown' });

    const admin = await signup(t, 'pa-mk');
    await sql(`insert into platform_admins(user_id, role) values ($1, 'superadmin')`, [admin.userId]);
    const approved = await t.http.put('/v1/admin/providers/meta').set(auth(admin)).send({ reviewStatus: 'approved' });
    expect(approved.status).toBe(200);
    // Review recorded, but the console app has no id or secret: the environment app still serves OAuth.
    expect(approved.body.source).toBe('environment');
    card = await item(tn, 'meta_ads');
    expect(card.marketplace).toMatchObject({ status: 'connected', providerReview: 'approved' });
  });
});
