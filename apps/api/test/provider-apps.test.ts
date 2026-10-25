// 21-INT operator console (/v1/admin/providers, plan §6.3): platform staff only, secrets sealed with the key ring and
// never returned after a save, the console app replaces the environment variables at runtime (OAuth start, Embedded
// Signup, Foodics webhook) and deleting it falls back to them. Nothing reaches a provider.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import { PlatformProviderAppsService } from '../src/modules/integrations/provider-apps.service';
import { addMember, auth, bootTestApp, createTenant, signup, sql, type TestApp, type TestTenant, type TestUser } from './helpers';

const META_SECRET = 'meta-console-secret-ABCDEFGH1234';
const VERIFY = 'meta-console-verify-token-0001';
const WA_VERIFY = 'whatsapp-console-verify-token-0002';
const FOODICS_TOKEN = 'foodics-console-webhook-token-0123456789';
const PROVIDER_ENV = ['META_APP_ID', 'META_APP_SECRET', 'WHATSAPP_ES_CONFIG_ID', 'WHATSAPP_APP_SECRET', 'WHATSAPP_VERIFY_TOKEN', 'META_WEBHOOK_VERIFY_TOKEN',
  'FOODICS_CLIENT_ID', 'FOODICS_CLIENT_SECRET', 'FOODICS_WEBHOOK_TOKEN', 'FOODICS_OAUTH_ENV', 'TIKTOK_APP_ID', 'TIKTOK_APP_SECRET', 'SNAPCHAT_CLIENT_ID', 'SNAPCHAT_CLIENT_SECRET'];

let t: TestApp;
let superadmin: TestUser;
let support: TestUser;
let tenant: TestTenant;
const saved: Record<string, string | undefined> = {};

async function platformAdmin(role: 'superadmin' | 'support' | 'finance') {
  const u = await signup(t, `pa-apps-${role}`);
  await sql(`insert into platform_admins(user_id, role) values ($1, $2)`, [u.userId, role]);
  return u;
}
const put = (u: TestUser, provider: string, body: unknown) => t.http.put(`/v1/admin/providers/${provider}`).set(auth(u)).send(body as object);

beforeAll(async () => {
  for (const k of PROVIDER_ENV) { saved[k] = process.env[k]; delete process.env[k]; }
  t = await bootTestApp();
  await sql(`delete from platform_provider_apps`);
  await t.app.get(PlatformProviderAppsService).refresh();
  superadmin = await platformAdmin('superadmin');
  support = await platformAdmin('support');
  tenant = await createTenant(t);
});
afterAll(async () => {
  // Leave no console app behind for other files (they configure providers through the environment).
  await sql(`delete from platform_provider_apps`);
  await t.app.get(PlatformProviderAppsService).refresh();
  for (const k of PROVIDER_ENV) if (saved[k] !== undefined) process.env[k] = saved[k];
  await t.close();
});

describe('operator console access', () => {
  it('refuses anonymous callers, restaurant owners and members; support reads, only superadmins write', async () => {
    expect((await t.http.get('/v1/admin/providers')).status).toBe(401);
    const manager = await addMember(t, tenant, 'manager');
    for (const u of [tenant.owner, manager]) {
      expect((await t.http.get('/v1/admin/providers').set(auth(u))).status).toBe(403);
      expect((await t.http.get('/v1/admin/providers/meta').set(auth(u))).status).toBe(403);
      expect((await put(u, 'meta', { appId: '1234' })).status).toBe(403);
      expect((await t.http.delete('/v1/admin/providers/meta').set(auth(u))).status).toBe(403);
    }
    const list = await t.http.get('/v1/admin/providers').set(auth(support));
    expect(list.status).toBe(200);
    expect(list.body.items.map((i: { provider: string }) => i.provider)).toEqual(['meta', 'tiktok_ads', 'snapchat_ads', 'foodics']);
    expect((await put(support, 'meta', { appId: '1234' })).status).toBe(403);
    expect((await t.http.delete('/v1/admin/providers/meta').set(auth(support))).status).toBe(403);
    expect((await t.http.get('/v1/admin/providers/stripe').set(auth(support))).status).toBe(404);
    expect((await sql(`select count(*)::int as n from platform_provider_apps`))[0].n).toBe(0);
  });

  it('shows the redirect and webhook URLs to register, the environment fallback and an honest checklist', async () => {
    const { body } = await t.http.get('/v1/admin/providers/meta').set(auth(support));
    expect(body).toMatchObject({ provider: 'meta', source: 'none', appId: null, reviewStatus: 'unknown', acceptance: { passed: 0, lastPassedAt: null } });
    expect(body.redirectUris).toEqual(['http://api.test/v1/public/integrations/oauth/meta_ads/callback', 'http://api.test/v1/public/integrations/oauth/meta_pages/callback']);
    expect(body.webhooks.map((w: { url: string }) => w.url)).toEqual(['http://api.test/v1/webhooks/whatsapp', 'http://api.test/v1/webhooks/meta']);
    expect(body.environmentFallback).toContainEqual({ name: 'META_APP_SECRET', set: false });
    expect(body.checklist.every((c: { done: boolean }) => c.done === false)).toBe(true);
    expect(body.blockers).toEqual(['B-4', 'B-5']);
    const foodics = (await t.http.get('/v1/admin/providers/foodics').set(auth(support))).body;
    expect(foodics.webhooks[0].url).toBe('http://api.test/v1/webhooks/foodics/<webhook token>');
  });
});

describe('sealed secrets', () => {
  it('stores secrets sealed, never returns them (masked hint only) and audits field names without values', async () => {
    const res = await put(superadmin, 'meta', {
      environment: 'live', appId: '987654321012345', secrets: { appSecret: META_SECRET, webhookVerifyToken: VERIFY, whatsappVerifyToken: WA_VERIFY },
      configIds: { whatsappSignupConfigId: '5550001112223', adsLoginConfigId: '5550001112224' }, reviewStatus: 'in_review', notes: 'Submitted 2026-10-25',
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      provider: 'meta', source: 'database', appId: '987654321012345', reviewStatus: 'in_review',
      secrets: { appSecret: { set: true, hint: '…1234' }, webhookVerifyToken: { set: true, hint: '…0001' }, whatsappVerifyToken: { set: true, hint: '…0002' } },
      configIds: { whatsappSignupConfigId: '5550001112223', adsLoginConfigId: '5550001112224', pagesLoginConfigId: null },
    });
    const all = JSON.stringify([res.body, (await t.http.get('/v1/admin/providers').set(auth(superadmin))).body, (await t.http.get('/v1/admin/providers/meta').set(auth(support))).body]);
    for (const secret of [META_SECRET, VERIFY, WA_VERIFY]) expect(all).not.toContain(secret);

    const [row] = await sql(`select secrets_sealed, secrets_hint::text as hint, updated_by from platform_provider_apps where provider = 'meta'`);
    expect(row.secrets_sealed).toMatch(/^v1:/);
    for (const secret of [META_SECRET, VERIFY, WA_VERIFY]) { expect(row.secrets_sealed).not.toContain(secret); expect(row.hint).not.toContain(secret); }
    expect(row.updated_by).toBe(superadmin.userId);
    const audits = await sql(`select actor_type, metadata::text as m from audit_logs where action = 'platform.provider_app_saved' and entity_id = 'meta'`);
    expect(audits.length).toBeGreaterThan(0);
    expect(audits[0].actor_type).toBe('platform_admin');
    for (const a of audits) for (const secret of [META_SECRET, VERIFY, WA_VERIFY]) expect(a.m).not.toContain(secret);

    // Omitted secrets are kept; null removes one.
    const kept = await put(superadmin, 'meta', { secrets: { webhookVerifyToken: null } });
    expect(kept.body.secrets).toMatchObject({ appSecret: { set: true }, webhookVerifyToken: { set: false, hint: null }, whatsappVerifyToken: { set: true } });
    await put(superadmin, 'meta', { secrets: { webhookVerifyToken: VERIFY } });
  });

  it('refuses unknown fields and weak webhook tokens', async () => {
    const unknown = await put(superadmin, 'tiktok_ads', { secrets: { webhookToken: 'abcdefghijklmnopqrstuvwxyz' } });
    expect(unknown.status).toBe(422);
    expect(unknown.body.error.code).toBe('provider_app_unknown_field');
    const weak = await put(superadmin, 'foodics', { secrets: { webhookToken: 'short' } });
    expect(weak.status).toBe(422);
    expect(weak.body.error.code).toBe('provider_app_webhook_token_weak');
    expect((await put(superadmin, 'meta', { appId: 'not an id' })).status).toBe(400);
    expect((await put(superadmin, 'meta', { reviewStatus: 'verified' })).status).toBe(400);
  });

  it('tenant views never carry the platform secrets', async () => {
    const catalog = await t.http.get(`/v1/o/${tenant.orgId}/integrations/catalog`).set(auth(tenant.owner));
    const signup = await t.http.get(`/v1/o/${tenant.orgId}/connect/whatsapp/embedded-signup`).set(auth(tenant.owner));
    for (const secret of [META_SECRET, VERIFY, WA_VERIFY]) {
      expect(JSON.stringify(catalog.body)).not.toContain(secret);
      expect(JSON.stringify(signup.body)).not.toContain(secret);
    }
  });
});

describe('runtime: the console app replaces the environment variables', () => {
  it('OAuth and Embedded Signup use the console Meta app; the WhatsApp webhook handshake its verify token', async () => {
    const catalog = await t.http.get(`/v1/o/${tenant.orgId}/integrations/catalog`).set(auth(tenant.owner));
    const meta = catalog.body.items.find((i: { id: string }) => i.id === 'meta_ads');
    expect(meta.oauthConfigured).toBe(true);
    expect(meta.marketplace.providerReview).toBe('pending');
    const nonce = randomBytes(32).toString('base64url');
    const start = await t.http.post(`/v1/o/${tenant.orgId}/integrations/oauth/meta_ads/start`).set(auth(tenant.owner))
      .send({ browserBinding: createHash('sha256').update(nonce).digest('hex') });
    expect(start.status).toBe(200);
    const url = new URL(start.body.url);
    expect(url.searchParams.get('client_id')).toBe('987654321012345');
    expect(url.searchParams.get('config_id')).toBe('5550001112224');
    const signup = await t.http.get(`/v1/o/${tenant.orgId}/connect/whatsapp/embedded-signup`).set(auth(tenant.owner));
    expect(signup.body).toMatchObject({ available: true, appId: '987654321012345', configId: '5550001112223', missing: [] });
    const handshake = await t.http.get('/v1/webhooks/whatsapp').query({ 'hub.mode': 'subscribe', 'hub.verify_token': WA_VERIFY, 'hub.challenge': '424242' });
    expect(handshake.status).toBe(200);
    expect(handshake.text).toBe('424242');
    expect((await t.http.get('/v1/webhooks/whatsapp').query({ 'hub.mode': 'subscribe', 'hub.verify_token': 'wrong', 'hub.challenge': '1' })).status).toBe(403);
  });

  it('the Foodics webhook accepts the console token only', async () => {
    const saved = await put(superadmin, 'foodics', { environment: 'sandbox', appId: 'foodics-client-1', secrets: { appSecret: 'foodics-secret-xyz-9876', webhookToken: FOODICS_TOKEN } });
    expect(saved.body).toMatchObject({ source: 'database', environment: 'sandbox' });
    expect(JSON.stringify(saved.body)).not.toContain(FOODICS_TOKEN);
    const nudge = { event: 'menu.updated', business: { reference: 123456 }, timestamp: 1 };
    expect((await t.http.post(`/v1/webhooks/foodics/${FOODICS_TOKEN}`).send(nudge)).status).toBe(200);
    expect((await t.http.post('/v1/webhooks/foodics/foodics-wrong-webhook-token-0123456789').send(nudge)).status).toBe(404);
  });

  it('deleting the console app falls back to the environment variables', async () => {
    const removed = await t.http.delete('/v1/admin/providers/meta').set(auth(superadmin));
    expect(removed.status).toBe(200);
    expect(removed.body).toMatchObject({ source: 'none', appId: null });
    let meta = (await t.http.get(`/v1/o/${tenant.orgId}/integrations/catalog`).set(auth(tenant.owner))).body.items.find((i: { id: string }) => i.id === 'meta_ads');
    expect(meta.oauthConfigured).toBe(false);
    process.env.META_APP_ID = 'env-app-1';
    process.env.META_APP_SECRET = 'env-secret-1';
    try {
      meta = (await t.http.get(`/v1/o/${tenant.orgId}/integrations/catalog`).set(auth(tenant.owner))).body.items.find((i: { id: string }) => i.id === 'meta_ads');
      expect(meta.oauthConfigured).toBe(true);
      expect((await t.http.get('/v1/admin/providers/meta').set(auth(support))).body).toMatchObject({ source: 'environment', appId: 'env-app-1',
        secrets: { appSecret: { set: true, hint: null } } });
    } finally {
      delete process.env.META_APP_ID;
      delete process.env.META_APP_SECRET;
    }
  });
});
