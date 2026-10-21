// PS-11 / INT-11: ads OAuth bound to the initiating browser and user; long-lived Meta tokens; account picker;
// Snapchat refresh; provider-side revocation. Provider calls are scripted; nothing reaches Meta, TikTok or Snap.
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { IntegrationConnectionsService } from '../src/modules/integrations/connections.service';
import { ProviderHttp } from '../src/modules/integrations/provider-http';
import { scriptedFetch, type RecordedRequest } from './growth-helpers';
import { addMember, auth, bootTestApp, createTenant, sql, type TestApp, type TestTenant } from './helpers';

const ENV = {
  META_APP_ID: 'meta-app-1', META_APP_SECRET: 'meta-app-secret-xyz', TIKTOK_APP_ID: 'tt-app-1', TIKTOK_APP_SECRET: 'tt-secret',
  SNAPCHAT_CLIENT_ID: 'snap-client', SNAPCHAT_CLIENT_SECRET: 'snap-secret',
};
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
afterAll(async () => { for (const k of Object.keys(ENV)) delete process.env[k]; await t.close(); });

const script = (responses: Parameters<typeof scriptedFetch>[0]) => { const f = scriptedFetch(responses); http.fetch = f.fetch; return f; };
const browser = () => { const nonce = randomBytes(32).toString('base64url'); return { nonce, binding: createHash('sha256').update(nonce).digest('hex') }; };
const route = (c: RecordedRequest) => `${c.method} ${new URL(c.url).pathname}`;

async function start(tenant: TestTenant, provider: string, user = tenant.owner) {
  const b = browser();
  const res = await t.http.post(`/v1/o/${tenant.orgId}/integrations/oauth/${provider}/start`).set(auth(user)).send({ browserBinding: b.binding });
  expect(res.status).toBe(200);
  const url = new URL(res.body.url);
  return { ...b, url, state: url.searchParams.get('state')! };
}
const complete = (tenant: TestTenant, provider: string, body: Record<string, unknown>, user = tenant.owner) =>
  t.http.post(`/v1/o/${tenant.orgId}/integrations/oauth/${provider}/complete`).set(auth(user)).send(body);

const metaExchange = (accounts: Array<Record<string, unknown>>) => [
  { body: { access_token: 'EAAB-short', expires_in: 3600 } },
  { body: { access_token: 'EAAB-long-lived', expires_in: 5183944 } },
  { body: { id: '10229', name: 'Mona' } },
  { body: { data: accounts } },
];

describe('PS-11: state bound to the initiating browser and user', () => {
  it('requires a browser binding to start', async () => {
    const tenant = await createTenant(t);
    const res = await t.http.post(`/v1/o/${tenant.orgId}/integrations/oauth/meta_ads/start`).set(auth(tenant.owner)).send({});
    expect(res.status).toBe(400);
  });

  it('the public callback completes nothing: it forwards code and state to the web app without caching', async () => {
    const tenant = await createTenant(t);
    const s = await start(tenant, 'meta_ads');
    expect(s.url.origin + s.url.pathname).toBe('https://www.facebook.com/v26.0/dialog/oauth');
    expect(s.url.searchParams.get('redirect_uri')).toBe('http://api.test/v1/public/integrations/oauth/meta_ads/callback');
    const f = script([{ body: {} }]);
    const cb = await t.http.get(`/v1/public/integrations/oauth/meta_ads/callback?code=victim-code&state=${s.state}`);
    expect(cb.status).toBe(302);
    expect(cb.headers.location).toBe(`http://app.test/dashboard/oauth/meta_ads?code=victim-code&state=${s.state}`);
    expect(cb.headers['cache-control']).toBe('no-store');
    expect(cb.headers['referrer-policy']).toBe('no-referrer');
    expect(f.calls).toHaveLength(0);
    expect((await sql(`select count(*)::int as n from integration_connections where org_id = $1`, [tenant.orgId]))[0].n).toBe(0);
    const denied = await t.http.get(`/v1/public/integrations/oauth/meta_ads/callback?error=access_denied&state=${s.state}`);
    expect(denied.headers.location).toBe('http://app.test/dashboard/oauth/meta_ads?integration_error=access_denied');
  });

  it('refuses another user, another browser or another organisation; the state is not consumed by a refusal', async () => {
    const attacker = await createTenant(t);
    const victim = await createTenant(t);
    const s = await start(attacker, 'meta_ads');
    const f = script(metaExchange([]));
    // The victim's browser lands with the attacker's state: wrong user, wrong nonce, wrong org.
    const v1 = await complete(victim, 'meta_ads', { code: 'victim-code', state: s.state, browserNonce: browser().nonce }, victim.owner);
    expect(v1.status).toBe(403);
    expect(v1.body.error.code).toBe('oauth_state_invalid');
    expect((await complete(attacker, 'meta_ads', { code: 'victim-code', state: s.state, browserNonce: s.nonce }, victim.owner)).status).toBe(404); // not a member: the org is hidden
    // Another member of the same org, even with the nonce.
    const colleague = await addMember(t, attacker, 'admin');
    expect((await complete(attacker, 'meta_ads', { code: 'c', state: s.state, browserNonce: s.nonce }, colleague)).body.error.code).toBe('oauth_state_invalid');
    // The starter from another browser (different nonce).
    expect((await complete(attacker, 'meta_ads', { code: 'c', state: s.state, browserNonce: browser().nonce })).body.error.code).toBe('oauth_state_invalid');
    expect(f.calls).toHaveLength(0);
    expect((await sql(`select count(*)::int as n from integration_connections where org_id in ($1, $2)`, [attacker.orgId, victim.orgId]))[0].n).toBe(0);
    expect((await sql(`select count(*)::int as n from audit_logs where org_id = $1 and action = 'integration.oauth_state_rejected'`, [victim.orgId]))[0].n).toBe(1);
    // The real starter, in the real browser, still can (state not consumed by the refusals) — and only once.
    script(metaExchange([{ id: 'act_1', account_id: '1', name: 'Only', currency: 'EGP', account_status: 1 }, { id: 'act_2', account_id: '2', name: 'Two', currency: 'EGP', account_status: 1 }]));
    const ok = await complete(attacker, 'meta_ads', { code: 'own-code', state: s.state, browserNonce: s.nonce });
    expect(ok.status).toBe(200);
    expect((await complete(attacker, 'meta_ads', { code: 'own-code', state: s.state, browserNonce: s.nonce })).body.error.code).toBe('oauth_state_invalid');
  });
});

describe('INT-11: Meta long-lived token, account picker, appsecret_proof, revocation', () => {
  it('stores a long-lived token with its expiry, lets the owner pick a granted account, then checks health with appsecret_proof', async () => {
    const tenant = await createTenant(t);
    const s = await start(tenant, 'meta_ads');
    const f = script(metaExchange([{ id: 'act_111', account_id: '111', name: 'Olive Room', currency: 'EGP', account_status: 1 },
      { id: 'act_222', account_id: '222', name: 'Old brand', currency: 'USD', account_status: 101 }]));
    const res = await complete(tenant, 'meta_ads', { code: 'c0de', state: s.state, browserNonce: s.nonce });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ needsAccountSelection: true, accounts: [{ id: 'act_111', name: 'Olive Room' }, { id: 'act_222', status: 'CLOSED' }],
      connection: { provider: 'meta_ads', status: 'pending', config: { tokenSource: 'platform_app', tokenKind: 'user', metaUserId: '10229' } } });
    expect(f.calls.map(route)).toEqual(['GET /v26.0/oauth/access_token', 'GET /v26.0/oauth/access_token', 'GET /v26.0/me', 'GET /v26.0/me/adaccounts']);
    const days = (Date.parse(res.body.connection.config.tokenExpiresAt) - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(59);
    expect(days).toBeLessThan(61);
    const id = res.body.connection.id;
    expect(JSON.stringify(res.body)).not.toContain('EAAB-long-lived');
    const [row] = await sql(`select credentials_hint, credentials_encrypted from integration_connections where id = $1`, [id]);
    expect(row.credentials_encrypted).not.toContain('EAAB');

    // An account that was not granted is refused (after re-listing it from Meta).
    script([{ body: { data: [{ id: 'act_111', account_id: '111', name: 'Olive Room', currency: 'EGP', account_status: 1 }] } }]);
    const bad = await t.http.post(`/v1/o/${tenant.orgId}/integrations/connections/${id}/account`).set(auth(tenant.owner)).send({ accountId: 'act_999' });
    expect(bad.status).toBe(422);
    expect(bad.body.error.code).toBe('account_not_granted');
    const h = script([{ body: { id: 'act_111', name: 'Olive Room', currency: 'EGP', account_status: 1 } }]);
    const picked = await t.http.post(`/v1/o/${tenant.orgId}/integrations/connections/${id}/account`).set(auth(tenant.owner)).send({ accountId: 'act_111' });
    expect(picked.status).toBe(200);
    expect(picked.body).toMatchObject({ status: 'connected', config: { adAccountId: 'act_111' } });
    const hu = new URL(h.calls[0]!.url);
    expect(hu.pathname).toBe('/v26.0/act_111');
    expect(hu.searchParams.get('appsecret_proof')).toBe(createHmac('sha256', 'meta-app-secret-xyz').update('EAAB-long-lived').digest('hex'));

    // Disconnect: Meta revokes the user's permissions for the app, local credentials are destroyed.
    const r = script([{ body: { success: true } }]);
    const rev = await t.http.post(`/v1/o/${tenant.orgId}/integrations/connections/${id}/revoke`).set(auth(tenant.owner));
    expect(rev.body).toMatchObject({ status: 'revoked', providerRevocation: { attempted: true, revoked: true } });
    expect(route(r.calls[0]!)).toBe('DELETE /v26.0/10229/permissions');
    expect(new URL(r.calls[0]!.url).searchParams.get('appsecret_proof')).toMatch(/^[0-9a-f]{64}$/);
    expect((await sql(`select credentials_encrypted from integration_connections where id = $1`, [id]))[0].credentials_encrypted).toBeNull();
  });

  it('a pasted token (unknown app) gets no appsecret_proof, and a failed provider revocation is reported, not hidden', async () => {
    const tenant = await createTenant(t);
    const c = (await t.http.post(`/v1/o/${tenant.orgId}/integrations/connections`).set(auth(tenant.owner))
      .send({ provider: 'meta_ads', environment: 'live', credentials: { accessToken: 'EAAB-pasted-token' }, config: { adAccountId: '123', metaUserId: '55' } })).body;
    const h = script([{ body: { id: 'act_123', account_status: 1 } }]);
    await t.http.post(`/v1/o/${tenant.orgId}/integrations/connections/${c.id}/health`).set(auth(tenant.owner)).expect(200);
    expect(new URL(h.calls[0]!.url).searchParams.get('appsecret_proof')).toBeNull();
    script([{ status: 500, body: { error: { message: 'unknown', code: 1 } } }]);
    const rev = await t.http.post(`/v1/o/${tenant.orgId}/integrations/connections/${c.id}/revoke`).set(auth(tenant.owner));
    expect(rev.body).toMatchObject({ status: 'revoked', providerRevocation: { attempted: true, revoked: false } });
    expect(rev.body.providerRevocation.note).toMatch(/did not confirm/);
  });

  it('flags a Meta token 7 days before it expires and marks an expired one as needing reconnection', async () => {
    const tenant = await createTenant(t);
    const s = await start(tenant, 'meta_ads');
    script(metaExchange([{ id: 'act_7', account_id: '7', name: 'Only one', currency: 'EGP', account_status: 1 }, { id: 'act_7b', account_id: '7b', name: 'b', currency: 'EGP', account_status: 1 }]));
    const id = (await complete(tenant, 'meta_ads', { code: 'c', state: s.state, browserNonce: s.nonce })).body.connection.id;
    const svc = t.app.get(IntegrationConnectionsService);
    await sql(`update integration_connections set config = config || jsonb_build_object('tokenExpiresAt', (now() + interval '3 days')::text) where id = $1`, [id]);
    expect(await svc.maintainOAuthTokens(new Date(), { orgId: tenant.orgId })).toMatchObject({ flagged: 1, expired: 0 });
    expect((await sql(`select config->>'reconnectBy' as r from integration_connections where id = $1`, [id]))[0].r).toBeTruthy();
    await sql(`update integration_connections set config = config || jsonb_build_object('tokenExpiresAt', (now() - interval '1 hour')::text) where id = $1`, [id]);
    expect(await svc.maintainOAuthTokens(new Date(), { orgId: tenant.orgId })).toMatchObject({ expired: 1 });
    expect((await sql(`select status, last_error from integration_connections where id = $1`, [id]))[0]).toMatchObject({ status: 'error', last_error: expect.stringMatching(/expired/) });
  });
});

describe('INT-11: TikTok and Snapchat', () => {
  it('TikTok: a single advertiser is selected automatically; disconnect revokes the token at TikTok', async () => {
    const tenant = await createTenant(t);
    const s = await start(tenant, 'tiktok_ads');
    expect(s.url.origin + s.url.pathname).toBe('https://business-api.tiktok.com/portal/auth');
    script([
      { body: { code: 0, message: 'OK', data: { access_token: 'tt-access', advertiser_ids: ['7000000000001'] } } },
      { body: { code: 0, message: 'OK', data: { list: [{ advertiser_id: '7000000000001', advertiser_name: 'Olive Room' }] } } },
      { body: { code: 0, message: 'OK', data: { list: [{ name: 'Olive Room', currency: 'EGP', status: 'STATUS_ENABLE' }] } } },
    ]);
    const res = await complete(tenant, 'tiktok_ads', { code: 'auth-code', state: s.state, browserNonce: s.nonce });
    expect(res.body).toMatchObject({ needsAccountSelection: false, connection: { status: 'connected', config: { advertiserId: '7000000000001' } } });
    const r = script([{ body: { code: 0, message: 'OK', data: {} } }]);
    const rev = await t.http.post(`/v1/o/${tenant.orgId}/integrations/connections/${res.body.connection.id}/revoke`).set(auth(tenant.owner));
    expect(rev.body.providerRevocation).toMatchObject({ attempted: true, revoked: true });
    expect(route(r.calls[0]!)).toBe('POST /open_api/v1.3/oauth2/revoke_token/');
  });

  it('Snapchat: refreshes the 1-hour token before use and after a 401; a refused refresh token asks for reconnection', async () => {
    const tenant = await createTenant(t);
    const s = await start(tenant, 'snapchat_ads');
    script([
      { body: { access_token: 'snap-at-1', refresh_token: 'snap-rt-1', expires_in: 3600 } },
      { body: { organizations: [{ organization: { ad_accounts: [{ id: 'acc-1', name: 'Olive Room', currency: 'EGP', status: 'ACTIVE' }] } }] } },
      { body: { adaccounts: [{ adaccount: { id: 'acc-1', name: 'Olive Room', currency: 'EGP', status: 'ACTIVE' } }] } },
    ]);
    const res = await complete(tenant, 'snapchat_ads', { code: 'code9', state: s.state, browserNonce: s.nonce });
    expect(res.body.connection).toMatchObject({ status: 'connected', config: { adAccountId: 'acc-1' } });
    const id = res.body.connection.id;
    const sealed1 = (await sql(`select credentials_encrypted from integration_connections where id = $1`, [id]))[0].credentials_encrypted;

    // Expiring token: refreshed before the health check call.
    await sql(`update integration_connections set config = config || jsonb_build_object('tokenExpiresAt', (now() + interval '1 minute')::text) where id = $1`, [id]);
    const f = script([{ body: { access_token: 'snap-at-2', refresh_token: 'snap-rt-2', expires_in: 3600 } }, { body: { adaccounts: [{ adaccount: { id: 'acc-1', status: 'ACTIVE' } }] } }]);
    expect((await t.http.post(`/v1/o/${tenant.orgId}/integrations/connections/${id}/health`).set(auth(tenant.owner))).body.status).toBe('connected');
    expect(f.calls.map(route)).toEqual(['POST /login/oauth2/access_token', 'GET /v1/adaccounts/acc-1']);
    expect(Object.fromEntries(new URLSearchParams(f.calls[0]!.body!))).toMatchObject({ grant_type: 'refresh_token', refresh_token: 'snap-rt-1' });
    expect(f.calls[1]!.headers.authorization).toBe('Bearer snap-at-2');
    expect((await sql(`select credentials_encrypted from integration_connections where id = $1`, [id]))[0].credentials_encrypted).not.toBe(sealed1);

    // A 401 with a token that should still be valid: refresh once and retry.
    const g = script([{ status: 401, body: { request_status: 'ERROR', debug_message: 'Unauthorized' } }, { body: { access_token: 'snap-at-3', refresh_token: 'snap-rt-3', expires_in: 3600 } },
      { body: { adaccounts: [{ adaccount: { id: 'acc-1', status: 'ACTIVE' } }] } }]);
    expect((await t.http.post(`/v1/o/${tenant.orgId}/integrations/connections/${id}/health`).set(auth(tenant.owner))).body.status).toBe('connected');
    expect(g.calls.map(route)).toEqual(['GET /v1/adaccounts/acc-1', 'POST /login/oauth2/access_token', 'GET /v1/adaccounts/acc-1']);

    // The scheduled job refreshes tokens about to expire; a refused refresh token marks the connection for reconnection.
    await sql(`update integration_connections set config = config || jsonb_build_object('tokenExpiresAt', (now() + interval '5 minutes')::text) where id = $1`, [id]);
    script([{ status: 400, body: { error: 'invalid_grant' } }]);
    const svc = t.app.get(IntegrationConnectionsService);
    expect(await svc.maintainOAuthTokens(new Date(), { orgId: tenant.orgId })).toMatchObject({ failed: 1 });
    expect((await sql(`select status, last_error from integration_connections where id = $1`, [id]))[0]).toMatchObject({ status: 'error', last_error: expect.stringMatching(/reconnect/) });
    const rev = await t.http.post(`/v1/o/${tenant.orgId}/integrations/connections/${id}/revoke`).set(auth(tenant.owner));
    expect(rev.body.providerRevocation).toMatchObject({ attempted: false, revoked: false });
    expect(rev.body.providerRevocation.note).toMatch(/Snapchat Business Manager/);
  });
});

describe('INT-21: the Facebook Page (Messenger / Instagram) connects with Facebook Login, bound like the ads flows', () => {
  const pages = [{ id: '1111111111', name: 'Olive Room' }, { id: '2222222222', name: 'Smash & Co', instagram_business_account: { id: '1784000', username: 'smash' } }];

  it('start uses the Pages Login for Business configuration (or the documented scopes) and the same bound state', async () => {
    const tenant = await createTenant(t);
    const classic = await start(tenant, 'meta_pages');
    expect(classic.url.searchParams.get('scope')).toContain('pages_messaging');
    expect(classic.url.searchParams.get('redirect_uri')).toBe('http://api.test/v1/public/integrations/oauth/meta_pages/callback');
    process.env.META_PAGES_LOGIN_CONFIG_ID = '5550001';
    try {
      const s = await start(tenant, 'meta_pages');
      expect(s.url.searchParams.get('config_id')).toBe('5550001');
      expect(s.url.searchParams.get('scope')).toBeNull();
      // Another browser (wrong nonce) cannot complete it.
      const f = script([{ body: {} }]);
      expect((await complete(tenant, 'meta_pages', { code: 'c', state: s.state, browserNonce: browser().nonce })).status).toBe(403);
      expect(f.calls).toHaveLength(0);
    } finally { delete process.env.META_PAGES_LOGIN_CONFIG_ID; }
  });

  it('complete lists the granted Pages; choosing one stores that Page\'s own token, and the channel proof then passes', async () => {
    const tenant = await createTenant(t);
    const s = await start(tenant, 'meta_pages');
    const f = script(metaExchange(pages));
    const done = await complete(tenant, 'meta_pages', { code: 'auth-code', state: s.state, browserNonce: s.nonce });
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(f.calls.map(route)).toEqual(['GET /v26.0/oauth/access_token', 'GET /v26.0/oauth/access_token', 'GET /v26.0/me', 'GET /v26.0/me/accounts']);
    expect(done.body).toMatchObject({ needsAccountSelection: true, connection: { provider: 'meta_pages', authType: 'oauth', category: 'messaging', status: 'pending' } });
    expect(done.body.accounts.map((a: any) => a.id)).toEqual(['1111111111', '2222222222']);
    const id = done.body.connection.id as string;
    const conns = t.app.get(IntegrationConnectionsService);
    let fresh = await conns.loadFresh(tenant.orgId, { id });
    expect(fresh.adapter.credentials.userAccessToken).toBe('EAAB-long-lived');
    expect(fresh.adapter.credentials.accessToken).toBeUndefined(); // no Page chosen yet: nothing can message

    // A Page the person did not grant is refused before any provider call; a granted one fetches its token.
    script([{ body: { data: pages } }]);
    expect((await t.http.post(`/v1/o/${tenant.orgId}/integrations/connections/${id}/account`).set(auth(tenant.owner)).send({ accountId: '9999999999' })).body.error.code)
      .toBe('account_not_granted');
    const sel = script([
      { body: { id: '2222222222', name: 'Smash & Co', access_token: 'EAAPage-smash-own', instagram_business_account: { id: '1784000' } } },
      { body: { id: '2222222222', name: 'Smash & Co' } },
      { body: { instagram_business_account: { id: '1784000', username: 'smash' } } },
    ]);
    const chosen = await t.http.post(`/v1/o/${tenant.orgId}/integrations/connections/${id}/account`).set(auth(tenant.owner)).send({ accountId: '2222222222' });
    expect(chosen.status, JSON.stringify(chosen.body)).toBe(200);
    expect(sel.calls.map(route)).toEqual(['GET /v26.0/2222222222', 'GET /v26.0/me', 'GET /v26.0/2222222222']);
    expect(sel.calls[0]!.headers.authorization).toBe('Bearer EAAB-long-lived');
    expect(sel.calls[1]!.headers.authorization).toBe('Bearer EAAPage-smash-own');
    expect(new URL(sel.calls[1]!.url).searchParams.get('appsecret_proof')).toBe(createHmac('sha256', ENV.META_APP_SECRET).update('EAAPage-smash-own').digest('hex'));
    expect(chosen.body).toMatchObject({ status: 'connected', config: { pageId: '2222222222', instagramAccountId: '1784000', tokenSource: 'platform_app' } });
    expect(JSON.stringify(chosen.body)).not.toMatch(/EAAPage|EAAB-long/);
    fresh = await conns.loadFresh(tenant.orgId, { id });
    expect(fresh.adapter.credentials).toMatchObject({ accessToken: 'EAAPage-smash-own', userAccessToken: 'EAAB-long-lived' });

    // The Messenger channel's ownership proof runs on the stored Page token.
    const ch = script([{ body: { id: '2222222222', name: 'Smash & Co' } }, { body: { success: true } }]);
    const channel = await t.http.post(`/v1/o/${tenant.orgId}/connect/channels`).set(auth(tenant.owner))
      .send({ transport: 'meta_page', kind: 'messenger', displayName: 'Messenger', connectionId: id });
    expect(channel.status, JSON.stringify(channel.body)).toBe(201);
    expect(channel.body).toMatchObject({ kind: 'messenger', verified: true });
    expect(ch.calls[0]!.headers.authorization).toBe('Bearer EAAPage-smash-own');

    // Disconnect de-authorises the Login user at Meta (which also invalidates the Page token).
    const rv = script([{ body: { success: true } }]);
    const revoked = await t.http.post(`/v1/o/${tenant.orgId}/integrations/connections/${id}/revoke`).set(auth(tenant.owner));
    expect(revoked.body).toMatchObject({ status: 'revoked', providerRevocation: { attempted: true, revoked: true } });
    expect(route(rv.calls[0]!)).toBe('DELETE /v26.0/10229/permissions');
    expect(rv.calls[0]!.headers.authorization).toBe('Bearer EAAB-long-lived');
  });

  it('a single granted Page is selected at once; a pasted Page token keeps working and offers only its own Page', async () => {
    const tenant = await createTenant(t);
    const s = await start(tenant, 'meta_pages');
    script([...metaExchange([pages[0]!]), { body: { id: '1111111111', name: 'Olive Room', access_token: 'EAAPage-olive-own' } }, { body: { id: '1111111111', name: 'Olive Room' } }]);
    const done = await complete(tenant, 'meta_pages', { code: 'auth-code', state: s.state, browserNonce: s.nonce });
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(done.body).toMatchObject({ needsAccountSelection: false, connection: { status: 'connected', config: { pageId: '1111111111' } } });
    expect(done.body.connection.config.instagramAccountId).toBeUndefined();

    const other = await createTenant(t);
    const manual = await t.http.post(`/v1/o/${other.orgId}/integrations/connections`).set(auth(other.owner))
      .send({ provider: 'meta_pages', environment: 'live', credentials: { accessToken: 'EAAPage-pasted-123456' }, config: { pageId: '3333333333' } });
    expect(manual.status).toBe(201);
    script([{ body: { id: '3333333333', name: 'Pasted Page' } }]);
    const listed = await t.http.get(`/v1/o/${other.orgId}/integrations/connections/${manual.body.id}/accounts`).set(auth(other.owner));
    expect(listed.body.accounts).toEqual([{ id: '3333333333', name: 'Pasted Page', currency: null, status: null }]);
    const switchPage = await t.http.post(`/v1/o/${other.orgId}/integrations/connections/${manual.body.id}/account`).set(auth(other.owner)).send({ accountId: '3333333334' });
    expect(switchPage.status).toBe(422);
  });
});
