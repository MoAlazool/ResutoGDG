// INT-03 (WhatsApp number ownership) and INT-13 (multi-tenant onboarding model: platform app with Embedded Signup,
// or a merchant-owned app with its own secret and callback URL). Provider calls are scripted; nothing reaches Meta.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { conflict } from '../src/common/errors/domain-error';
import { ChannelsService } from '../src/modules/connect/channels.service';
import { ProviderHttp } from '../src/modules/integrations/provider-http';
import { scriptedFetch, type RecordedRequest } from './growth-helpers';
import { addMember, auth, bootTestApp, createTenant, sql, type TestApp, type TestTenant } from './helpers';

const PLATFORM_SECRET = 'platform-app-secret-for-tests';
process.env.WHATSAPP_APP_SECRET = PLATFORM_SECRET;
process.env.WHATSAPP_VERIFY_TOKEN = 'verify-token-123';

let t: TestApp;
let http: ProviderHttp;
let original: typeof fetch;
let a: TestTenant;
let b: TestTenant;
let seq = 0;
const ids = () => { seq++; return { phone: `10654035${String(seq).padStart(4, '0')}`, waba: `10229012${String(seq).padStart(4, '0')}` }; };

beforeAll(async () => {
  t = await bootTestApp();
  http = t.app.get(ProviderHttp);
  original = http.fetch;
  a = await createTenant(t);
  b = await createTenant(t);
});
afterEach(() => { http.fetch = original; });
afterAll(async () => { await t.close(); });

const script = (responses: Parameters<typeof scriptedFetch>[0]) => { const f = scriptedFetch(responses); http.fetch = f.fetch; return f; };
const connect = async (tenant: TestTenant, phone: string, waba: string, extra: Record<string, string> = {}) => {
  const r = await t.http.post(`/v1/o/${tenant.orgId}/integrations/connections`).set(auth(tenant.owner))
    .send({ provider: 'whatsapp_cloud', environment: 'live', credentials: { accessToken: `EAAG-${tenant.orgId.slice(0, 8)}-token`, ...extra }, config: { phoneNumberId: phone, wabaId: waba } });
  expect(r.status).toBe(201);
  return r.body as { id: string; config: Record<string, unknown> };
};
const channel = (tenant: TestTenant, body: Record<string, unknown>) =>
  t.http.post(`/v1/o/${tenant.orgId}/connect/channels`).set(auth(tenant.owner)).send({ transport: 'meta_cloud', displayName: 'WhatsApp', ...body });
const listed = (phone: string, name = 'The Olive Room') => ({ body: { data: [{ id: phone, display_phone_number: '+20 100 555 0001', verified_name: name, quality_rating: 'GREEN' }] } });
const sign = (body: string, secret = PLATFORM_SECRET) => `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
const inbound = (waba: string, phone: string, id: string, from = '201005550001') => JSON.stringify({
  object: 'whatsapp_business_account',
  entry: [{ id: waba, changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', metadata: { phone_number_id: phone },
    contacts: [{ wa_id: from, profile: { name: 'Karim' } }], messages: [{ from, id, timestamp: '1750000000', type: 'text', text: { body: 'hello' } }] } }] }],
});
const post = (path: string, body: string, sig: string) => t.http.post(path).set('Content-Type', 'application/json').set('X-Hub-Signature-256', sig).send(body);
const orgOf = async (wamid: string) => (await sql(`select org_id from messages where provider_message_id = $1`, [wamid]))[0]?.org_id ?? null;

describe('INT-03: WhatsApp channel ownership', () => {
  it('refuses a channel whose ids differ from its connection, before any provider call', async () => {
    const { phone, waba } = ids(); const a = await createTenant(t);
    const conn = await connect(a, phone, waba);
    const f = script([{ body: {} }]);
    const res = await channel(a, { phoneNumberId: '999999999999', wabaId: waba, connectionId: conn.id });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('channel_connection_mismatch');
    expect(f.calls).toHaveLength(0);
    expect((await sql(`select count(*)::int as n from messaging_channels where phone_number_id = '999999999999'`))[0].n).toBe(0);
  });

  it('refuses a number the WABA does not list, or a WABA the token cannot read, and stores nothing', async () => {
    const { phone, waba } = ids(); const a = await createTenant(t);
    const conn = await connect(a, phone, waba);
    const f = script([{ body: { data: [{ id: '5550000000001' }] } }]);
    const res = await channel(a, { phoneNumberId: phone, wabaId: waba, connectionId: conn.id });
    expect(res.status).toBe(422);
    expect(res.body.error).toMatchObject({ code: 'phone_number_not_verified', details: { reason: 'not_in_waba' } });
    const u = new URL(f.calls[0]!.url);
    expect(u.pathname).toBe(`/v26.0/${waba}/phone_numbers`);
    expect(f.calls[0]!.headers.authorization).toMatch(/^Bearer EAAG-/);
    script([{ status: 400, body: { error: { message: 'Unsupported get request. Object does not exist, cannot be loaded due to missing permissions', code: 100, error_subcode: 33 } } }]);
    const foreign = await channel(a, { phoneNumberId: phone, wabaId: waba, connectionId: conn.id });
    expect(foreign.body.error).toMatchObject({ code: 'phone_number_not_verified', details: { reason: 'no_access' } });
    expect((await sql(`select count(*)::int as n from messaging_channels where phone_number_id = $1`, [phone]))[0].n).toBe(0);
    const logs = await sql(`select level, message from integration_logs where connection_id = $1 order by id`, [conn.id]);
    expect(logs.filter((l: any) => /not proven/.test(l.message))).toHaveLength(2);
  });

  it('never assumes ownership when Meta cannot be reached or rejects the token', async () => {
    const { phone, waba } = ids(); const a = await createTenant(t);
    const conn = await connect(a, phone, waba);
    script([{ status: 500, body: { error: { message: 'An unknown error occurred', code: 1 } } }]);
    const down = await channel(a, { phoneNumberId: phone, wabaId: waba, connectionId: conn.id });
    expect(down.status).toBe(502);
    expect(down.body.error.code).toBe('verification_unavailable');
    script([{ status: 400, body: { error: { message: 'Session has expired', code: 190 } } }]);
    const expired = await channel(a, { phoneNumberId: phone, wabaId: waba, connectionId: conn.id });
    expect(expired.status).toBe(422);
    expect(expired.body.error.code).toBe('connection_token_invalid');
    expect((await sql(`select count(*)::int as n from messaging_channels where phone_number_id = $1`, [phone]))[0].n).toBe(0);
  });

  it('creates a verified channel after proving ownership and subscribing the app to the WABA webhooks', async () => {
    const { phone, waba } = ids(); const a = await createTenant(t);
    const conn = await connect(a, phone, waba);
    const f = script([listed(phone), { body: { success: true } }]);
    const res = await channel(a, { phoneNumberId: phone, wabaId: waba, connectionId: conn.id });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ verified: true, webhookSubscribed: true, displayPhone: '+20 100 555 0001', phoneNumberId: phone, wabaId: waba });
    expect(f.calls.map((c: RecordedRequest) => `${c.method} ${new URL(c.url).pathname}`)).toEqual([`GET /v26.0/${waba}/phone_numbers`, `POST /v26.0/${waba}/subscribed_apps`]);
    const [row] = await sql(`select verified_at, verification from messaging_channels where id = $1`, [res.body.id]);
    expect(row.verified_at).toBeTruthy();
    expect(row.verification).toMatchObject({ method: 'graph_waba_phone_numbers', wabaId: waba, phoneNumberId: phone, subscribedApp: true });
  });

  it('a verified number cannot be claimed by another tenant; an unverified legacy claim never blocks the real owner', async () => {
    const { phone, waba } = ids(); const a = await createTenant(t); const b = await createTenant(t);
    // Tenant B squatted the id before INT-03 (no verification).
    const squat = (await sql(`insert into messaging_channels(org_id, kind, transport, display_name, phone_number_id, waba_id, status)
                              values ($1, 'whatsapp', 'meta_cloud', 'Squatter', $2, $3, 'pending') returning id`, [b.orgId, phone, waba]))[0].id;
    // The squatted row receives nothing.
    const early = inbound(waba, phone, `wamid.SQ-${seq}`);
    expect((await post('/v1/webhooks/whatsapp', early, sign(early))).body).toMatchObject({ received: 1, ignored: 1, processed: 0 });
    expect(await orgOf(`wamid.SQ-${seq}`)).toBeNull();

    const conn = await connect(a, phone, waba);
    script([listed(phone), { body: { success: true } }]);
    const mine = await channel(a, { phoneNumberId: phone, wabaId: waba, connectionId: conn.id });
    expect(mine.status).toBe(201);
    const [old] = await sql(`select phone_number_id, status, verification from messaging_channels where id = $1`, [squat]);
    expect(old).toMatchObject({ phone_number_id: null, status: 'disabled' });
    expect(old.verification.supersededAt).toBeTruthy();
    expect((await sql(`select count(*)::int as n from audit_logs where org_id = $1 and action = 'connect.channel_superseded' and entity_id = $2`, [b.orgId, squat]))[0].n).toBe(1);

    // B now tries to claim A's verified number with its own connection: refused before any provider call.
    const bConn = await connect(b, phone, waba);
    const f = script([listed(phone)]);
    const again = await channel(b, { phoneNumberId: phone, wabaId: waba, connectionId: bConn.id });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('phone_number_in_use');
    expect(f.calls).toHaveLength(0);
  });

  it('routes webhooks only to verified channels whose WABA matches the event', async () => {
    const { phone, waba } = ids(); const a = await createTenant(t);
    const conn = await connect(a, phone, waba);
    script([listed(phone), { body: { success: true } }]);
    expect((await channel(a, { phoneNumberId: phone, wabaId: waba, connectionId: conn.id })).status).toBe(201);
    const wrongWaba = inbound('777777777777', phone, `wamid.W-${seq}`);
    expect((await post('/v1/webhooks/whatsapp', wrongWaba, sign(wrongWaba))).body).toMatchObject({ ignored: 1, processed: 0 });
    expect(await orgOf(`wamid.W-${seq}`)).toBeNull();
    const right = inbound(waba, phone, `wamid.R-${seq}`);
    expect((await post('/v1/webhooks/whatsapp', right, sign(right))).body).toMatchObject({ processed: 1 });
    expect(await orgOf(`wamid.R-${seq}`)).toBe(a.orgId);
  });

  it('verify re-proves a channel: success verifies it, a failed proof stops its webhooks, an outage changes nothing', async () => {
    const { phone, waba } = ids(); const a = await createTenant(t);
    const conn = await connect(a, phone, waba);
    const legacy = (await sql(`insert into messaging_channels(org_id, kind, transport, connection_id, display_name, phone_number_id, waba_id, status)
                               values ($1, 'whatsapp', 'meta_cloud', $2, 'Legacy', $3, $4, 'pending') returning id`, [a.orgId, conn.id, phone, waba]))[0].id;
    const listBefore = (await t.http.get(`/v1/o/${a.orgId}/connect/channels`).set(auth(a.owner))).body.items.find((c: any) => c.id === legacy);
    expect(listBefore).toMatchObject({ verified: false, status: 'unverified' });
    script([listed(phone), { body: { success: true } }]);
    const ok = await t.http.post(`/v1/o/${a.orgId}/connect/channels/${legacy}/verify`).set(auth(a.owner));
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ verified: true, webhookSubscribed: true });
    script([{ status: 503, body: { error: { message: 'Service unavailable', code: 2 } } }]);
    expect((await t.http.post(`/v1/o/${a.orgId}/connect/channels/${legacy}/verify`).set(auth(a.owner))).status).toBe(502);
    expect((await sql(`select verified_at is not null as v from messaging_channels where id = $1`, [legacy]))[0].v).toBe(true);
    script([{ body: { data: [] } }]);
    const gone = await t.http.post(`/v1/o/${a.orgId}/connect/channels/${legacy}/verify`).set(auth(a.owner));
    expect(gone.status).toBe(422);
    expect(gone.body.error).toMatchObject({ code: 'phone_number_not_verified', details: { channel: { verified: false } } });
    const msg = inbound(waba, phone, `wamid.G-${seq}`);
    expect((await post('/v1/webhooks/whatsapp', msg, sign(msg))).body).toMatchObject({ ignored: 1 });
  });

  it('only connect:manage staff create or verify channels', async () => {
    const cashier = await addMember(t, a, 'cashier');
    expect((await t.http.post(`/v1/o/${a.orgId}/connect/channels`).set(auth(cashier)).send({ transport: 'sandbox', displayName: 'x' })).status).toBe(403);
    expect((await t.http.post(`/v1/o/${a.orgId}/connect/whatsapp/embedded-signup`).set(auth(cashier)).send({})).status).toBe(403);
  });
});

describe('INT-13: merchant-owned Meta app (own secret, own callback URL)', () => {
  it('marks the connection own_app, shows its callback URL and verify token, and verifies webhooks with that secret only', async () => {
    const { phone, waba } = ids(); const a = await createTenant(t);
    const own = await connect(a, phone, waba, { appSecret: 'merchant-own-app-secret' });
    expect(own.config).toMatchObject({ appMode: 'own_app', phoneNumberId: phone, wabaId: waba });
    const verifyToken = own.config.webhookVerifyToken as string;
    expect(verifyToken).toMatch(/^[A-Za-z0-9_-]{20,}$/);
    const view = (await t.http.get(`/v1/o/${a.orgId}/integrations/connections/${own.id}`).set(auth(a.owner))).body;
    expect(view.webhook).toEqual({ url: `http://api.test/v1/webhooks/whatsapp/c/${own.id}`, events: ['messages', 'message_template_status_update'], registeredByMerchant: true, verifyToken });
    expect(JSON.stringify(view)).not.toContain('merchant-own-app-secret');
    // A client cannot choose the mode or the token.
    const forged = await t.http.patch(`/v1/o/${a.orgId}/integrations/connections/${own.id}`).set(auth(a.owner)).send({ config: { phoneNumberId: phone, wabaId: waba, appMode: 'platform', webhookVerifyToken: 'mine', graphVersion: 'v17.0' } });
    expect(forged.body.config).toMatchObject({ appMode: 'own_app', webhookVerifyToken: verifyToken });
    expect(forged.body.config.graphVersion).toBeUndefined(); // INT-12: the version is pinned in code

    const hs = await t.http.get(`/v1/webhooks/whatsapp/c/${own.id}`).query({ 'hub.mode': 'subscribe', 'hub.verify_token': verifyToken, 'hub.challenge': '4242' });
    expect(hs.status).toBe(200);
    expect(hs.text).toBe('4242');
    expect((await t.http.get(`/v1/webhooks/whatsapp/c/${own.id}`).query({ 'hub.mode': 'subscribe', 'hub.verify_token': 'verify-token-123', 'hub.challenge': '1' })).status).toBe(403);

    const f = script([listed(phone), { body: { success: true } }]);
    expect((await channel(a, { phoneNumberId: phone, wabaId: waba, connectionId: own.id })).status).toBe(201);
    // The merchant's app secret signs appsecret_proof on its own token.
    expect(new URL(f.calls[0]!.url).searchParams.get('appsecret_proof')).toBe(createHmac('sha256', 'merchant-own-app-secret').update(`EAAG-${a.orgId.slice(0, 8)}-token`).digest('hex'));

    const body = inbound(waba, phone, `wamid.OWN-${seq}`);
    // Signed by the platform app, or sent to the platform endpoint: not this connection's events.
    expect((await post(`/v1/webhooks/whatsapp/c/${own.id}`, body, sign(body))).status).toBe(401);
    expect((await post('/v1/webhooks/whatsapp', body, sign(body))).body).toMatchObject({ ignored: 1, processed: 0 });
    expect(await orgOf(`wamid.OWN-${seq}`)).toBeNull();
    const ok = await post(`/v1/webhooks/whatsapp/c/${own.id}`, body, sign(body, 'merchant-own-app-secret'));
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ processed: 1 });
    expect(await orgOf(`wamid.OWN-${seq}`)).toBe(a.orgId);
    // Unknown or platform-mode connections have no own-app endpoint.
    expect((await post(`/v1/webhooks/whatsapp/c/00000000-0000-0000-0000-000000000000`, body, sign(body, 'merchant-own-app-secret'))).status).toBe(404);
  });
});

describe('INT-13: Embedded Signup with Resuto as Tech Provider', () => {
  const env = { META_APP_ID: 'platform-app-id', META_APP_SECRET: PLATFORM_SECRET, WHATSAPP_ES_CONFIG_ID: '880011' };
  const withEnv = async (fn: () => Promise<void>) => {
    Object.assign(process.env, env);
    try { await fn(); } finally { for (const k of Object.keys(env)) delete process.env[k]; }
  };

  it('reports what is missing when the platform app is not configured, and refuses to complete', async () => {
    const cfg = (await t.http.get(`/v1/o/${a.orgId}/connect/whatsapp/embedded-signup`).set(auth(a.owner))).body;
    expect(cfg).toMatchObject({ available: false, graphVersion: 'v26.0', sdkUrl: 'https://connect.facebook.net/en_US/sdk.js' });
    expect(cfg.missing).toEqual(expect.arrayContaining(['META_APP_ID', 'META_APP_SECRET', 'WHATSAPP_ES_CONFIG_ID']));
    const res = await t.http.post(`/v1/o/${a.orgId}/connect/whatsapp/embedded-signup`).set(auth(a.owner))
      .send({ code: 'es-code-123456', wabaId: '1022', phoneNumberId: '1065', displayName: 'WA' });
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('provider_app_not_configured');
  });

  it('exchanges the code, proves ownership, subscribes, registers, then stores a connected connection and a verified channel', async () => {
    await withEnv(async () => {
      const { phone, waba } = ids();
      const tenant = await createTenant(t);
      const cfg = (await t.http.get(`/v1/o/${tenant.orgId}/connect/whatsapp/embedded-signup`).set(auth(tenant.owner))).body;
      expect(cfg).toMatchObject({ available: true, appId: 'platform-app-id', configId: '880011', missing: [] });
      const f = script([{ body: { access_token: 'EAAG-business-token-xyz' } }, listed(phone, 'Smash & Co'), { body: { success: true } }, { body: { success: true } }]);
      const res = await t.http.post(`/v1/o/${tenant.orgId}/connect/whatsapp/embedded-signup`).set(auth(tenant.owner))
        .send({ code: 'es-code-123456', wabaId: waba, phoneNumberId: phone, businessId: '4455', displayName: 'Smash WhatsApp' });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      expect(res.body).toMatchObject({ registered: true, channel: { verified: true, webhookSubscribed: true, status: 'connected', phoneNumberId: phone, wabaId: waba } });
      expect(f.calls.map((c: RecordedRequest) => `${c.method} ${new URL(c.url).pathname}`)).toEqual([
        'GET /v26.0/oauth/access_token', `GET /v26.0/${waba}/phone_numbers`, `POST /v26.0/${waba}/subscribed_apps`, `POST /v26.0/${phone}/register`]);
      expect(Object.fromEntries(new URL(f.calls[0]!.url).searchParams)).toEqual({ client_id: 'platform-app-id', client_secret: PLATFORM_SECRET, code: 'es-code-123456' });
      const pin = JSON.parse(f.calls[3]!.body!).pin as string;
      expect(pin).toMatch(/^\d{6}$/);
      // Platform-app token: appsecret_proof with the platform secret on every call after the exchange.
      expect(new URL(f.calls[1]!.url).searchParams.get('appsecret_proof')).toBe(createHmac('sha256', PLATFORM_SECRET).update('EAAG-business-token-xyz').digest('hex'));
      const conn = (await t.http.get(`/v1/o/${tenant.orgId}/integrations/connections/${res.body.connectionId}`).set(auth(tenant.owner))).body;
      expect(conn).toMatchObject({ provider: 'whatsapp_cloud', status: 'connected', environment: 'live',
        config: { phoneNumberId: phone, wabaId: waba, businessId: '4455', appMode: 'platform', onboarding: 'embedded_signup', tokenSource: 'platform_app' } });
      expect(conn.webhook).toBeNull(); // no callback for the merchant to register
      expect(JSON.stringify(conn)).not.toContain('EAAG-business-token-xyz');
      expect(JSON.stringify(conn)).not.toContain(pin);
      // The platform webhook now reaches this tenant.
      const body = inbound(waba, phone, `wamid.ES-${seq}`);
      expect((await post('/v1/webhooks/whatsapp', body, sign(body))).body).toMatchObject({ processed: 1 });
      expect(await orgOf(`wamid.ES-${seq}`)).toBe(tenant.orgId);
    });
  });

  it('stores nothing when any onboarding step fails, and skips registration for WhatsApp Business app coexistence', async () => {
    await withEnv(async () => {
      const { phone, waba } = ids();
      const tenant = await createTenant(t);
      const send = (extra: Record<string, unknown> = {}) => t.http.post(`/v1/o/${tenant.orgId}/connect/whatsapp/embedded-signup`).set(auth(tenant.owner))
        .send({ code: 'es-code-123456', wabaId: waba, phoneNumberId: phone, displayName: 'WA', ...extra });
      script([{ status: 400, body: { error: { message: 'This authorization code has expired.', code: 100, type: 'OAuthException' } } }]);
      expect((await send()).body.error.code).toBe('signup_exchange_failed');
      script([{ body: { access_token: 'EAAG-b' } }, listed(phone), { status: 400, body: { error: { message: 'Permissions error', code: 200 } } }]);
      const sub = await send();
      expect(sub.status).toBe(502);
      expect(sub.body.error.code).toBe('webhook_subscription_failed');
      expect((await sql(`select count(*)::int as n from integration_connections where org_id = $1`, [tenant.orgId]))[0].n).toBe(0);
      expect((await sql(`select count(*)::int as n from messaging_channels where org_id = $1`, [tenant.orgId]))[0].n).toBe(0);
      const f = script([{ body: { access_token: 'EAAG-b' } }, listed(phone), { body: { success: true } }]);
      const coex = await send({ event: 'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING' });
      expect(coex.status).toBe(201);
      expect(coex.body.registered).toBe(false);
      expect(f.calls.some((c: RecordedRequest) => c.url.includes('/register'))).toBe(false);
    });
  });

  it('refuses a number another tenant has verified before spending the code, and stores nothing', async () => {
    await withEnv(async () => {
      const { phone, waba } = ids();
      const owner = await createTenant(t);
      const c = await connect(owner, phone, waba);
      script([listed(phone), { body: { success: true } }]);
      expect((await channel(owner, { phoneNumberId: phone, wabaId: waba, connectionId: c.id })).status).toBe(201);
      const intruder = await createTenant(t);
      const f = script([{ body: { access_token: 'EAAG-x' } }]);
      const res = await t.http.post(`/v1/o/${intruder.orgId}/connect/whatsapp/embedded-signup`).set(auth(intruder.owner))
        .send({ code: 'es-code-123456', wabaId: waba, phoneNumberId: phone, displayName: 'WA' });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('phone_number_in_use');
      expect(f.calls).toHaveLength(0); // no code exchange, no subscribe, no register
      expect((await sql(`select count(*)::int as n from integration_connections where org_id = $1`, [intruder.orgId]))[0].n).toBe(0);
    });
  });

  it('a channel conflict after the provider steps rolls back the connection upsert (previous connection kept as it was)', async () => {
    await withEnv(async () => {
      const { phone, waba } = ids();
      const other = ids();
      const tenant = await createTenant(t);
      const before = await connect(tenant, other.phone, other.waba); // the org's earlier connection, no channel on it yet
      const snapshot = (await sql(`select config, credentials_hint, credentials_encrypted from integration_connections where id = $1`, [before.id]))[0];
      const channels = t.app.get(ChannelsService);
      const spy = vi.spyOn(channels, 'insertVerifiedWhatsApp').mockRejectedValueOnce(conflict('phone_number_in_use', 'This WhatsApp phone number is already registered with Resuto'));
      try {
        script([{ body: { access_token: 'EAAG-race-token' } }, listed(phone), { body: { success: true } }, { body: { success: true } }]);
        const res = await t.http.post(`/v1/o/${tenant.orgId}/connect/whatsapp/embedded-signup`).set(auth(tenant.owner))
          .send({ code: 'es-code-123456', wabaId: waba, phoneNumberId: phone, displayName: 'WA' });
        expect(res.status).toBe(409);
        expect(res.body.error.code).toBe('phone_number_in_use');
      } finally { spy.mockRestore(); }
      const rows = await sql(`select id, config, credentials_hint, credentials_encrypted from integration_connections where org_id = $1`, [tenant.orgId]);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ id: before.id, config: snapshot.config, credentials_hint: snapshot.credentials_hint });
      expect(rows[0].credentials_encrypted).toEqual(snapshot.credentials_encrypted);
      expect((await sql(`select count(*)::int as n from audit_logs where org_id = $1 and action = 'integration.whatsapp_embedded_signup'`, [tenant.orgId]))[0].n).toBe(0);
    });
  });

  it('disconnecting unsubscribes the app from the WABA webhooks and reports what Meta confirmed', async () => {
    await withEnv(async () => {
      const { phone, waba } = ids();
      const tenant = await createTenant(t);
      script([{ body: { access_token: 'EAAG-b2' } }, listed(phone), { body: { success: true } }, { body: { success: true } }]);
      const done = await t.http.post(`/v1/o/${tenant.orgId}/connect/whatsapp/embedded-signup`).set(auth(tenant.owner))
        .send({ code: 'es-code-123456', wabaId: waba, phoneNumberId: phone, displayName: 'WA' });
      const f = script([{ body: { success: true } }]);
      const rev = await t.http.post(`/v1/o/${tenant.orgId}/integrations/connections/${done.body.connectionId}/revoke`).set(auth(tenant.owner));
      expect(rev.status).toBe(200);
      expect(rev.body).toMatchObject({ status: 'revoked', providerRevocation: { attempted: true, revoked: true } });
      expect(f.calls[0]).toMatchObject({ method: 'DELETE' });
      expect(new URL(f.calls[0]!.url).pathname).toBe(`/v26.0/${waba}/subscribed_apps`);
    });
  });
});
