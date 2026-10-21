// INT-24: Foodics app authorisation through the generic bound-state OAuth flow (server-side code exchange, sealed
// token, business confirmation, revocation) and the menu.updated webhook, which only schedules a debounced pull.
// Foodics calls are scripted; nothing reaches Foodics.
import { createHash, randomBytes } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { EventDispatcher } from '../src/common/events/dispatcher.service';
import { ProviderHttp } from '../src/modules/integrations/provider-http';
import { scriptedFetch, type RecordedRequest } from './growth-helpers';
import { auth, bootTestApp, createTenant, sql, type TestApp, type TestTenant } from './helpers';

const WEBHOOK_TOKEN = 'whk_foodics_0123456789abcdefghijkl';
let t: TestApp;
let http: ProviderHttp;
let original: typeof fetch;
beforeAll(async () => { t = await bootTestApp(); http = t.app.get(ProviderHttp); original = http.fetch; });
afterEach(() => { http.fetch = original; for (const k of ['FOODICS_CLIENT_ID', 'FOODICS_CLIENT_SECRET', 'FOODICS_OAUTH_ENV', 'FOODICS_WEBHOOK_TOKEN']) delete process.env[k]; });
afterAll(async () => { await t.close(); });

const configure = () => Object.assign(process.env, { FOODICS_CLIENT_ID: 'foodics-client-1', FOODICS_CLIENT_SECRET: 'foodics-secret-xyz', FOODICS_OAUTH_ENV: 'sandbox' });
const browser = () => { const nonce = randomBytes(32).toString('base64url'); return { nonce, binding: createHash('sha256').update(nonce).digest('hex') }; };
const route = (c: RecordedRequest) => `${c.method} ${c.url}`;
const whoamiFor = (reference: number) => ({ data: { business: { id: '9598b465-dd92', name: 'Olive Foodics', reference, country_iso_code: 'SA' } } });
const whoami = whoamiFor(526215);
const products = { data: [{ id: 'p1', name: 'Kabsa', name_localized: 'كبسة', price: 42.5, category: { name: 'Mains' } }], meta: { current_page: 1, last_page: 1 } };

async function connect(tenant: TestTenant, me = whoami) {
  const b = browser();
  const start = await t.http.post(`/v1/o/${tenant.orgId}/integrations/oauth/foodics/start`).set(auth(tenant.owner)).send({ browserBinding: b.binding });
  expect(start.status, JSON.stringify(start.body)).toBe(201);
  const url = new URL(start.body.url);
  const f = scriptedFetch([{ body: { token_type: 'Bearer', access_token: 'eyJ.foodics-sandbox-token' } }, { body: me }, { body: me }]);
  http.fetch = f.fetch;
  const done = await t.http.post(`/v1/o/${tenant.orgId}/integrations/oauth/foodics/complete`).set(auth(tenant.owner))
    .send({ code: 'def50200a27ea582', state: url.searchParams.get('state'), browserNonce: b.nonce });
  return { url, done, calls: f.calls };
}

describe('Foodics OAuth (INT-24)', () => {
  it('without the Foodics app on this server: the button is reported unavailable and start is refused (paste-token stays possible)', async () => {
    const tenant = await createTenant(t, { country: 'SA' });
    const cat = await t.http.get(`/v1/o/${tenant.orgId}/integrations/catalog`).set(auth(tenant.owner));
    expect(cat.body.items.find((p: any) => p.id === 'foodics')).toMatchObject({ authType: 'oauth', oauthConfigured: false });
    const res = await t.http.post(`/v1/o/${tenant.orgId}/integrations/oauth/foodics/start`).set(auth(tenant.owner)).send({ browserBinding: browser().binding });
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('provider_app_not_configured');
    expect(res.body.error.details.env).toEqual(['FOODICS_CLIENT_ID', 'FOODICS_CLIENT_SECRET']);
  });

  it('authorises in the sandbox console, exchanges the code server-side, seals the token and confirms the business', async () => {
    configure();
    const tenant = await createTenant(t, { country: 'SA' });
    const cat = await t.http.get(`/v1/o/${tenant.orgId}/integrations/catalog`).set(auth(tenant.owner));
    expect(cat.body.items.find((p: any) => p.id === 'foodics').oauthConfigured).toBe(true);
    const { url, done, calls } = await connect(tenant);
    expect(url.origin + url.pathname).toBe('https://console-sandbox.foodics.com/authorize');
    expect([...url.searchParams.keys()].sort()).toEqual(['client_id', 'state']);
    expect(done.status, JSON.stringify(done.body)).toBe(201);
    expect(calls.map(route)).toEqual(['POST https://api-sandbox.foodics.com/oauth/token', 'GET https://api-sandbox.foodics.com/v5/whoami', 'GET https://api-sandbox.foodics.com/v5/whoami']);
    expect(JSON.parse(calls[0]!.body!)).toMatchObject({ grant_type: 'authorization_code', code: 'def50200a27ea582', client_id: 'foodics-client-1',
      redirect_uri: 'http://api.test/v1/public/integrations/oauth/foodics/callback' });
    expect(done.body.needsAccountSelection).toBe(false);
    expect(done.body.accounts).toEqual([{ id: '526215', name: 'Olive Foodics', currency: null, status: 'SA' }]);
    expect(done.body.connection).toMatchObject({ provider: 'foodics', environment: 'sandbox', authType: 'oauth', status: 'connected' });
    expect(done.body.connection.config).toMatchObject({ businessReference: '526215', tokenSource: 'platform_app' });
    const [row] = await sql(`select credentials_encrypted::text as c, credentials_hint from integration_connections where org_id = $1 and provider = 'foodics'`, [tenant.orgId]);
    expect(row.c).not.toContain('foodics-sandbox-token');
    expect(JSON.stringify(done.body)).not.toContain('foodics-sandbox-token');
    // The state is single use.
    const again = await t.http.post(`/v1/o/${tenant.orgId}/integrations/oauth/foodics/complete`).set(auth(tenant.owner))
      .send({ code: 'def50200a27ea582', state: url.searchParams.get('state'), browserNonce: 'x'.repeat(43) });
    expect(again.body.error.code).toBe('oauth_state_invalid');
  });

  it('disconnecting revokes the token at Foodics (DELETE /tokens/client)', async () => {
    configure();
    const tenant = await createTenant(t, { country: 'SA' });
    const { done } = await connect(tenant);
    const f = scriptedFetch([{ body: {} }]);
    http.fetch = f.fetch;
    const rv = await t.http.post(`/v1/o/${tenant.orgId}/integrations/connections/${done.body.connection.id}/revoke`).set(auth(tenant.owner));
    expect(rv.status, JSON.stringify(rv.body)).toBe(201);
    expect(f.calls.map(route)).toEqual(['DELETE https://api-sandbox.foodics.com/v5/tokens/client']);
    expect(f.calls[0]!.headers.authorization).toBe('Bearer eyJ.foodics-sandbox-token');
  });
});

describe('Foodics menu.updated webhook (INT-24)', () => {
  const post = (token: string, body: object) => t.http.post(`/v1/webhooks/foodics/${token}`).send(body);
  const nudge = { timestamp: 1760000000, event: 'menu.updated', business: { name: 'Olive Foodics', reference: 771234 } };

  it('fails closed without the configured secret or with a wrong one', async () => {
    expect((await post(WEBHOOK_TOKEN, nudge)).status).toBe(404);
    process.env.FOODICS_WEBHOOK_TOKEN = WEBHOOK_TOKEN;
    expect((await post('whk_wrong_token_0000000000000000', nudge)).status).toBe(404);
  });

  it('schedules one debounced pull for the connection of that business; the pull reads Foodics with the restaurant token', async () => {
    configure();
    const tenant = await createTenant(t, { country: 'SA' });
    const { done } = await connect(tenant, whoamiFor(771234));
    process.env.FOODICS_WEBHOOK_TOKEN = WEBHOOK_TOKEN;
    await sql(`update outbox_events set published_at = now() where published_at is null`);
    const first = await post(WEBHOOK_TOKEN, nudge);
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ ok: true, connections: 1, scheduled: 1 });
    expect((await post(WEBHOOK_TOKEN, nudge)).body).toMatchObject({ connections: 1, scheduled: 0 });
    // Other events and other businesses: acknowledged (so Foodics keeps the endpoint), nothing scheduled.
    expect((await post(WEBHOOK_TOKEN, { ...nudge, event: 'order.created' })).body).toEqual({ ok: true, ignored: 'ignored_event' });
    expect((await post(WEBHOOK_TOKEN, { ...nudge, business: { reference: 999 } })).body).toMatchObject({ connections: 0, scheduled: 0 });
    const f = scriptedFetch([{ body: products }]);
    http.fetch = f.fetch;
    await t.app.get(EventDispatcher).drain();
    expect(f.calls.map(route)).toEqual(['GET https://api-sandbox.foodics.com/v5/products?include=category&page=1']);
    const runs = await sql(`select status, stats from integration_sync_runs where connection_id = $1`, [done.body.connection.id]);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ status: 'succeeded', stats: expect.objectContaining({ fetched: 1, importable: 1 }) });
    // Nothing was published by the webhook: the row waits for review and products are untouched.
    expect((await sql(`select count(*)::int as n from products where org_id = $1 and external_ref = 'p1'`, [tenant.orgId]))[0].n).toBe(0);
  });
});
