// INT-28 / FT-27: email and SMS through the restaurant's own Resend / Twilio account. Consent, opt-out and quiet
// hours are enforced before anything is queued; the queue retries with backoff, never re-sends an SMS whose outcome
// is unknown, and signed provider webhooks move statuses forward. Provider calls are scripted; nothing leaves the box.
import { createHmac } from 'node:crypto';
import { twilioSignature } from '@resuto/integrations';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { SecretBox } from '../src/common/crypto/secret-box';
import { ProviderHttp } from '../src/modules/integrations/provider-http';
import { NotificationsService } from '../src/modules/notifications/notifications.service';
import { OutboundChannelsService } from '../src/modules/notifications/outbound.service';
import { DbService } from '../src/common/db/db.service';
import { ENV, type Env } from '../src/config/env';
import { scriptedFetch, type RecordedRequest } from './growth-helpers';
import { auth, bootTestApp, createTenant, sql, type TestApp, type TestTenant } from './helpers';

const WHSEC = `whsec_${Buffer.from('resuto-test-webhook-secret-32byt').toString('base64')}`;
const SID = `AC${'1'.repeat(32)}`;
let t: TestApp;
let http: ProviderHttp;
let original: typeof fetch;
beforeAll(async () => { t = await bootTestApp(); http = t.app.get(ProviderHttp); original = http.fetch; });
afterEach(() => { http.fetch = original; });
afterAll(async () => { await t.close(); });

const m = (tenant: TestTenant, p: string) => `/v1/o/${tenant.orgId}/marketing${p}`;
const resendOk = () => scriptedFetch([(req: RecordedRequest) => ({ body: { id: `em_${JSON.parse(req.body!).to[0].replace(/[^a-z0-9]/g, '').slice(0, 20)}` } })]);

async function connect(tenant: TestTenant, provider: 'resend' | 'twilio_sms', opts: { environment?: 'live' | 'sandbox'; status?: string } = {}) {
  const creds = provider === 'resend' ? { apiKey: 're_test_0123456789', webhookSecret: WHSEC } : { accountSid: SID, authToken: 'twilio-auth-token' };
  const config = provider === 'resend' ? { from: 'Olive Room <hello@olive.example>' } : { from: 'OLIVE' };
  const [c] = await sql(
    `insert into integration_connections(org_id, provider, category, auth_type, environment, status, credentials_encrypted, config)
     values ($1, $2, 'messaging', 'api_key', $3, $4, $5, $6) returning id`,
    [tenant.orgId, provider, opts.environment ?? 'live', opts.status ?? 'connected', t.app.get(SecretBox).sealJson(creds, `${tenant.orgId}:${provider}`), config]);
  return c.id as string;
}
async function customers(tenant: TestTenant) {
  const rows = await sql(
    `insert into customers(org_id, display_name, email, phone_e164, marketing_consent, marketing_consent_source, locale, tags) values
       ($1, 'Mona', 'mona@guest.example', '+201001110001', true, 'test', 'ar', '{vip}'),
       ($1, 'Omar', 'omar@guest.example', '+201001110002', false, null, 'en', '{vip}'),
       ($1, 'Sara', null, '+201001110003', true, 'test', 'en', '{vip}')
     returning id, display_name`, [tenant.orgId]);
  return Object.fromEntries(rows.map((r: any) => [r.display_name, r.id as string])) as Record<'Mona' | 'Omar' | 'Sara', string>;
}
async function approvedCampaign(tenant: TestTenant, channel: 'email' | 'sms') {
  const seg = await t.http.post(m(tenant, '/segments')).set(auth(tenant.owner)).send({ name: `VIP ${Math.random().toString(36).slice(2, 8)}`, definition: { op: 'and', rules: [{ type: 'has_tag', tag: 'vip' }] } });
  const c = await t.http.post(m(tenant, '/campaigns')).set(auth(tenant.owner))
    .send({ name: 'Weekend offer', channel, segmentId: seg.body.id, content: { text: 'Free dessert this weekend.', ...(channel === 'email' ? { subject: 'A weekend treat' } : {}) } });
  expect(c.status, JSON.stringify(c.body)).toBe(201);
  await t.http.post(m(tenant, `/campaigns/${c.body.id}/submit`)).set(auth(tenant.owner)).expect(201);
  await t.http.post(m(tenant, `/campaigns/${c.body.id}/approve`)).set(auth(tenant.owner)).expect(201);
  return c.body.id as string;
}
const noQuietHours = (tenant: TestTenant) => t.http.put(`/v1/o/${tenant.orgId}/messaging/policy`).set(auth(tenant.owner)).send({ quietHoursStart: null, quietHoursEnd: null }).expect(200);
const outboundRows = (campaignId: string) => sql(`select * from outbound_messages where campaign_id = $1 order by created_at`, [campaignId]);
const svixHeaders = (body: string, id = `msg_${Math.random().toString(36).slice(2)}`) => {
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = createHmac('sha256', Buffer.from(WHSEC.slice(6), 'base64')).update(`${id}.${ts}.${body}`).digest('base64');
  return { 'svix-id': id, 'svix-timestamp': ts, 'svix-signature': `v1,${sig}`, 'content-type': 'application/json' };
};

describe('provider catalogue (INT-28)', () => {
  it('lists Resend and Twilio SMS with their fields, and shows the status webhook URL on a connection', async () => {
    const tenant = await createTenant(t);
    const cat = await t.http.get(`/v1/o/${tenant.orgId}/integrations/catalog`).set(auth(tenant.owner));
    const ids = cat.body.items.map((p: any) => p.id);
    expect(ids).toEqual(expect.arrayContaining(['resend', 'twilio_sms']));
    const id = await connect(tenant, 'resend');
    const view = await t.http.get(`/v1/o/${tenant.orgId}/integrations/connections/${id}`).set(auth(tenant.owner));
    expect(view.body.webhook).toMatchObject({ url: `http://api.test/v1/webhooks/resend/${id}`, registeredByMerchant: true });
    expect(JSON.stringify(view.body)).not.toContain('re_test_0123456789');
  });
});

describe('email campaigns through Resend (INT-28)', () => {
  it('refuses to send without a connected email provider (nothing queued)', async () => {
    const tenant = await createTenant(t);
    await customers(tenant);
    const id = await approvedCampaign(tenant, 'email');
    await connect(tenant, 'resend', { status: 'error' });
    const res = await t.http.post(m(tenant, `/campaigns/${id}/send`)).set(auth(tenant.owner));
    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({ code: 'channel_unavailable', details: { provider: 'resend' } });
    expect(await outboundRows(id)).toHaveLength(0);
  });

  it('sends to consenting customers with an address, with one-click unsubscribe; skips the rest honestly', async () => {
    const tenant = await createTenant(t);
    const c = await customers(tenant);
    await connect(tenant, 'resend');
    await noQuietHours(tenant);
    const id = await approvedCampaign(tenant, 'email');
    const f = resendOk();
    http.fetch = f.fetch;
    const res = await t.http.post(m(tenant, `/campaigns/${id}/send`)).set(auth(tenant.owner));
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body).toMatchObject({ status: 'sent', isSandbox: false, delivery: { recipients: 3, queued: 1, skippedNoConsent: 1, failed: 1, live: 1, sandbox: 0 } });
    expect(f.calls).toHaveLength(1);
    const call = f.calls[0]!;
    expect(call.url).toBe('https://api.resend.com/emails');
    const [row] = await outboundRows(id);
    expect(call.headers['idempotency-key']).toBe(`resuto-outbound-${row.id}`);
    const body = JSON.parse(call.body!);
    expect(body).toMatchObject({ from: 'Olive Room <hello@olive.example>', to: ['mona@guest.example'], subject: 'A weekend treat' });
    expect(body.headers['List-Unsubscribe']).toMatch(/^<http:\/\/api\.test\/v1\/public\/unsubscribe\/[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{22}>$/);
    expect(body.headers['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
    // Mona's locale is Arabic: the footer is Arabic with the web confirmation page.
    expect(body.text).toMatch(/^Free dessert this weekend\.\n\nلإلغاء الاشتراك: http:\/\/app\.test\/unsubscribe\?t=/);
    expect(row).toMatchObject({ status: 'accepted', provider_message_id: 'em_monaguestexample', recipient_hint: 'm***@guest.example', attempts: 1, customer_id: c.Mona });
    expect(row.recipient_sealed).not.toContain('mona');
    const deliveries = await sql(`select customer_id, status, error from campaign_deliveries where campaign_id = $1`, [id]);
    expect(Object.fromEntries(deliveries.map((d: any) => [d.customer_id, [d.status, d.error]]))).toEqual({
      [c.Mona]: ['sent', null], [c.Omar]: ['skipped_no_consent', null], [c.Sara]: ['failed', 'no_address'],
    });
    const log = await t.http.get(`/v1/o/${tenant.orgId}/messaging/outbound?campaignId=${id}`).set(auth(tenant.owner));
    expect(log.body.items).toEqual([expect.objectContaining({ channel: 'email', status: 'accepted', recipientHint: 'm***@guest.example' })]);
    expect(JSON.stringify(log.body)).not.toContain('mona@guest.example');
  });

  it('retries a provider outage with backoff and fails for good on a rejection', async () => {
    const tenant = await createTenant(t);
    await customers(tenant);
    await connect(tenant, 'resend');
    await noQuietHours(tenant);
    const id = await approvedCampaign(tenant, 'email');
    http.fetch = scriptedFetch([{ status: 503, body: { name: 'service_unavailable' } }]).fetch;
    await t.http.post(m(tenant, `/campaigns/${id}/send`)).set(auth(tenant.owner)).expect(201);
    let [row] = await outboundRows(id);
    expect(row).toMatchObject({ status: 'deferred', defer_reason: 'retry', attempts: 1, last_error: 'resend: HTTP 503 (service_unavailable)' });
    const wait = (new Date(row.next_attempt_at).getTime() - Date.now()) / 1000;
    expect(wait).toBeGreaterThan(50);
    expect(wait).toBeLessThan(70);
    // Not due yet: the job leaves it alone.
    const outbound = t.app.get(OutboundChannelsService);
    expect((await outbound.send({ orgId: tenant.orgId })).claimed).toBe(0);
    await sql(`update outbound_messages set next_attempt_at = now() where id = $1`, [row.id]);
    const f = scriptedFetch([{ status: 422, body: { name: 'validation_error' } }]);
    http.fetch = f.fetch;
    await outbound.send({ orgId: tenant.orgId });
    [row] = await outboundRows(id);
    expect(row).toMatchObject({ status: 'failed', attempts: 2, last_error: 'resend: HTTP 422 (validation_error)' });
    // The retry reused the same idempotency key.
    expect(f.calls[0]!.headers['idempotency-key']).toBe(`resuto-outbound-${row.id}`);
    expect((await sql(`select status, error from campaign_deliveries where outbound_id = $1`, [row.id]))[0]).toMatchObject({ status: 'failed' });
  });

  it('holds marketing in quiet hours (organisation time zone) and sends nothing until they end', async () => {
    const tenant = await createTenant(t);
    await customers(tenant);
    await connect(tenant, 'resend');
    // A window covering "now" in Cairo time.
    const [{ now }] = await sql(`select to_char((now() at time zone 'Africa/Cairo') - interval '1 hour', 'HH24:MI') as now`);
    const [{ end }] = await sql(`select to_char((now() at time zone 'Africa/Cairo') + interval '2 hours', 'HH24:MI') as end`);
    await t.http.put(`/v1/o/${tenant.orgId}/messaging/policy`).set(auth(tenant.owner)).send({ quietHoursStart: now, quietHoursEnd: end }).expect(200);
    const id = await approvedCampaign(tenant, 'email');
    const f = resendOk();
    http.fetch = f.fetch;
    await t.http.post(m(tenant, `/campaigns/${id}/send`)).set(auth(tenant.owner)).expect(201);
    expect(f.calls).toHaveLength(0);
    const [row] = await outboundRows(id);
    expect(row).toMatchObject({ status: 'deferred', defer_reason: 'quiet_hours', attempts: 0 });
    const hours = (new Date(row.next_attempt_at).getTime() - Date.now()) / 3_600_000;
    expect(hours).toBeGreaterThan(1.9);
    expect(hours).toBeLessThan(2.1);
    const policy = await t.http.get(`/v1/o/${tenant.orgId}/messaging/policy`).set(auth(tenant.owner));
    expect(policy.body).toMatchObject({ quietHoursStart: now, quietHoursEnd: end, timezone: 'Africa/Cairo', isDefault: false });
    expect((await t.http.put(`/v1/o/${tenant.orgId}/messaging/policy`).set(auth(tenant.owner)).send({ quietHoursStart: '22:00', quietHoursEnd: null })).status).toBe(400);
  });

  it('tracks delivery from signed Resend webhooks; a complaint opts the address out of email', async () => {
    const tenant = await createTenant(t);
    const c = await customers(tenant);
    const conn = await connect(tenant, 'resend');
    await noQuietHours(tenant);
    const id = await approvedCampaign(tenant, 'email');
    http.fetch = resendOk().fetch;
    const sendRes = await t.http.post(m(tenant, `/campaigns/${id}/send`)).set(auth(tenant.owner));
    expect(sendRes.status, JSON.stringify(sendRes.body)).toBe(201);
    const event = (type: string) => JSON.stringify({ type, created_at: new Date().toISOString(), data: { email_id: 'em_monaguestexample', to: ['mona@guest.example'] } });
    const post = (body: string, headers: Record<string, string>) => t.http.post(`/v1/webhooks/resend/${conn}`).set(headers).send(body);

    const delivered = event('email.delivered');
    expect((await post(delivered, { ...svixHeaders(delivered), 'svix-signature': 'v1,AAAA' })).status).toBe(401);
    expect((await t.http.post(`/v1/webhooks/resend/${'0'.repeat(8)}-0000-4000-8000-000000000000`).set(svixHeaders(delivered)).send(delivered)).status).toBe(404);
    const ok = await post(delivered, svixHeaders(delivered));
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body).toEqual({ ok: true, applied: true, status: 'delivered' });
    expect((await sql(`select status from campaign_deliveries where campaign_id = $1 and customer_id = $2`, [id, c.Mona]))[0].status).toBe('delivered');
    // Out of order: an older "sent" never moves it back.
    const sent = event('email.sent');
    expect((await post(sent, svixHeaders(sent))).body).toEqual({ ok: true, applied: false, reason: 'not_newer' });
    const complained = event('email.complained');
    expect((await post(complained, svixHeaders(complained))).body).toMatchObject({ applied: true, status: 'complained' });
    expect(await sql(`select channel, source, customer_id from channel_unsubscribes where org_id = $1`, [tenant.orgId]))
      .toEqual([{ channel: 'email', source: 'provider_complaint', customer_id: c.Mona }]);

    // The next email campaign skips her as unsubscribed; nothing reaches Resend.
    await sql(`update campaigns set name = 'old' where id = $1`, [id]);
    const next = await approvedCampaign(tenant, 'email');
    const f = resendOk();
    http.fetch = f.fetch;
    const res = await t.http.post(m(tenant, `/campaigns/${next}/send`)).set(auth(tenant.owner));
    expect(res.body.delivery).toMatchObject({ skippedUnsubscribed: 1, queued: 0 });
    expect(f.calls).toHaveLength(0);
  });
});

describe('unsubscribe link (INT-28)', () => {
  it('shows status, accepts the RFC 8058 one-click POST, sends browsers to the confirmation page and rejects forged tokens', async () => {
    const tenant = await createTenant(t, { name: 'Olive Room' });
    await customers(tenant);
    await connect(tenant, 'resend');
    await noQuietHours(tenant);
    const id = await approvedCampaign(tenant, 'email');
    const f = resendOk();
    http.fetch = f.fetch;
    await t.http.post(m(tenant, `/campaigns/${id}/send`)).set(auth(tenant.owner)).expect(201);
    const url = new URL(JSON.parse(f.calls[0]!.body!).headers['List-Unsubscribe'].slice(1, -1));
    const path = url.pathname;
    expect((await t.http.get(path)).body).toEqual({ channel: 'email', restaurant: 'Olive Room', unsubscribed: false });
    const browser = await t.http.get(path).set('Accept', 'text/html');
    expect(browser.status).toBe(302);
    expect(browser.headers.location).toMatch(/^http:\/\/app\.test\/unsubscribe\?t=[A-Za-z0-9_.-]+$/);
    const one = await t.http.post(path).type('form').send('List-Unsubscribe=One-Click');
    expect(one.status).toBe(200);
    expect(one.body).toEqual({ channel: 'email', restaurant: 'Olive Room', unsubscribed: true });
    expect(await sql(`select source from channel_unsubscribes where org_id = $1`, [tenant.orgId])).toEqual([{ source: 'one_click' }]);
    const token = path.split('/').pop()!;
    const forged = `${token.split('.')[0]}.${'A'.repeat(22)}`;
    expect((await t.http.get(`/v1/public/unsubscribe/${forged}`)).status).toBe(404);
    expect((await t.http.post(`/v1/public/unsubscribe/not-a-token`)).status).toBe(404);
  });
});

describe('opt-outs survive key rotation (INT-28 review)', () => {
  it('an opt-out recorded before SIGNING_KEY is rotated still suppresses marketing, and after the old key is dropped', async () => {
    const env = t.app.get<Env>(ENV);
    const saved = { SIGNING_KEY: env.SIGNING_KEY, CREDENTIALS_KEYS: env.CREDENTIALS_KEYS };
    const OLD = 'o'.repeat(40);
    const NEW = 'n'.repeat(40);
    try {
      Object.assign(env, { SIGNING_KEY: OLD, CREDENTIALS_KEYS: undefined });
      const tenant = await createTenant(t);
      await customers(tenant);
      await connect(tenant, 'resend');
      await noQuietHours(tenant);
      const first = await approvedCampaign(tenant, 'email');
      const f = resendOk();
      http.fetch = f.fetch;
      await t.http.post(m(tenant, `/campaigns/${first}/send`)).set(auth(tenant.owner)).expect(201);
      const path = new URL(JSON.parse(f.calls[0]!.body!).headers['List-Unsubscribe'].slice(1, -1)).pathname;
      expect((await t.http.post(path).type('form').send('List-Unsubscribe=One-Click')).body).toMatchObject({ unsubscribed: true });

      // Routine rotation: the new key is prepended. The old link still verifies and still reports the opt-out.
      env.SIGNING_KEY = `${NEW},${OLD}`;
      expect((await t.http.get(path)).body).toMatchObject({ unsubscribed: true });
      await sql(`update campaigns set name = 'old' where id = $1`, [first]);
      const second = await approvedCampaign(tenant, 'email');
      const g = resendOk();
      http.fetch = g.fetch;
      const res = await t.http.post(m(tenant, `/campaigns/${second}/send`)).set(auth(tenant.owner));
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      expect(res.body.delivery).toMatchObject({ skippedUnsubscribed: 1, queued: 0 });
      expect(g.calls).toHaveLength(0);
      // The match under the old key was re-recorded under the active key...
      expect(await sql(`select count(*)::int as n from channel_unsubscribes where org_id = $1`, [tenant.orgId])).toEqual([{ n: 2 }]);

      // ...so dropping the old key later keeps the opt-out.
      env.SIGNING_KEY = NEW;
      await sql(`update campaigns set name = 'older' where id = $1`, [second]);
      const third = await approvedCampaign(tenant, 'email');
      const h = resendOk();
      http.fetch = h.fetch;
      const res3 = await t.http.post(m(tenant, `/campaigns/${third}/send`)).set(auth(tenant.owner));
      expect(res3.body.delivery).toMatchObject({ skippedUnsubscribed: 1, queued: 0 });
      expect(h.calls).toHaveLength(0);
    } finally {
      Object.assign(env, saved);
    }
  });
});

describe('SMS campaigns through Twilio (INT-28)', () => {
  it('sends with a signed status callback, applies delivery updates and never re-sends an SMS with an unknown outcome', async () => {
    const tenant = await createTenant(t);
    const c = await customers(tenant);
    const conn = await connect(tenant, 'twilio_sms');
    await noQuietHours(tenant);
    const id = await approvedCampaign(tenant, 'sms');
    const f = scriptedFetch([(req) => ({ status: 201, body: { sid: `SM${new URLSearchParams(req.body!).get('To')!.slice(-4)}`, status: 'queued' } })]);
    http.fetch = f.fetch;
    const res = await t.http.post(m(tenant, `/campaigns/${id}/send`)).set(auth(tenant.owner));
    expect(res.body.delivery).toMatchObject({ queued: 2, skippedNoConsent: 1 });
    expect(f.calls.map((x) => x.url)).toEqual(Array(2).fill(`https://api.twilio.com/2010-04-01/Accounts/${SID}/Messages.json`));
    const form = Object.fromEntries(new URLSearchParams(f.calls.find((x) => x.body!.includes('0001'))!.body!));
    expect(form).toMatchObject({ To: '+201001110001', From: 'OLIVE', StatusCallback: `http://api.test/v1/webhooks/twilio/status/${conn}` });
    expect(form.Body).toMatch(/^Free dessert this weekend\.\nلإيقاف الرسائل: http:\/\/app\.test\/unsubscribe\?t=[A-Za-z0-9_.-]{45}$/);

    const params = { MessageSid: 'SM0001', MessageStatus: 'delivered', AccountSid: SID };
    const cb = `/v1/webhooks/twilio/status/${conn}`;
    expect((await t.http.post(cb).type('form').set('X-Twilio-Signature', 'bad').send(params)).status).toBe(401);
    const good = await t.http.post(cb).type('form').set('X-Twilio-Signature', twilioSignature('twilio-auth-token', `http://api.test${cb}`, params)).send(params);
    expect(good.body).toEqual({ ok: true, applied: true, status: 'delivered' });
    expect((await sql(`select status from campaign_deliveries where campaign_id = $1 and customer_id = $2`, [id, c.Mona]))[0].status).toBe('delivered');
    const undelivered = { MessageSid: 'SM0003', MessageStatus: 'undelivered', ErrorCode: '30003', AccountSid: SID };
    await t.http.post(cb).type('form').set('X-Twilio-Signature', twilioSignature('twilio-auth-token', `http://api.test${cb}`, undelivered)).send(undelivered).expect(200);
    expect((await sql(`select status, last_error from outbound_messages where provider_message_id = 'SM0003'`))[0])
      .toEqual({ status: 'undelivered', last_error: 'provider_error_30003' });

    // A sender that died mid-call: email would be retried (idempotent at Resend); SMS becomes 'unknown', not re-sent.
    const [row] = await sql(
      `insert into outbound_messages(org_id, channel, purpose, provider, connection_id, recipient_sealed, recipient_hint, address_hash, body_text, status, attempts, lease_until, idempotency_key)
       values ($1, 'sms', 'transactional', 'twilio_sms', $2, 'x', '+201••••01', repeat('a', 64), 'hi', 'sending', 1, now() - interval '1 minute', 'stale-sms-0001') returning id`,
      [tenant.orgId, conn]);
    const g = scriptedFetch([{ status: 201, body: { sid: 'SMX', status: 'queued' } }]);
    http.fetch = g.fetch;
    await t.app.get(OutboundChannelsService).send({ orgId: tenant.orgId });
    expect(g.calls).toHaveLength(0);
    expect((await sql(`select status, last_error from outbound_messages where id = $1`, [row.id]))[0])
      .toEqual({ status: 'unknown', last_error: 'outcome_unknown_after_interruption' });
  });

  it('a test (sandbox) Resend connection only writes to Resend\'s test inbox', async () => {
    const tenant = await createTenant(t);
    await customers(tenant);
    await connect(tenant, 'resend', { environment: 'sandbox' });
    await noQuietHours(tenant);
    const id = await approvedCampaign(tenant, 'email');
    const f = resendOk();
    http.fetch = f.fetch;
    const res = await t.http.post(m(tenant, `/campaigns/${id}/send`)).set(auth(tenant.owner));
    expect(res.body).toMatchObject({ isSandbox: true, delivery: { sandbox: 1, live: 0 } });
    expect(JSON.parse(f.calls[0]!.body!).to[0]).toMatch(/^delivered\+[0-9a-f]{8}@resend\.dev$/);
  });
});

describe('staff notification email through the restaurant\'s Resend (INT-28)', () => {
  it('queues per recipient, sends right away and records sent only after Resend accepted', async () => {
    const tenant = await createTenant(t);
    const notifications = t.app.get(NotificationsService);
    const db = t.app.get(DbService);
    const raise = (key: string) => db.withTenant(tenant.orgId, (tx) => notifications.raise(tx, tenant.orgId, {
      audienceUserId: tenant.owner.userId, kind: 'stock_low', severity: 'warning', templateKey: 'notifications.stockLow', params: {}, dedupeKey: key,
    }), 'test');
    const first = await raise('stock:1');
    expect(await notifications.deliverEmail(tenant.orgId, first.id, { subject: 'Low stock', text: 'Rice is low.' })).toBe('not_configured');
    await connect(tenant, 'resend');
    const f = resendOk();
    http.fetch = f.fetch;
    const second = await raise('stock:2');
    expect(await notifications.deliverEmail(tenant.orgId, second.id, { subject: 'Low stock', text: 'Rice is low.' })).toBe('sent');
    expect(f.calls).toHaveLength(1);
    const body = JSON.parse(f.calls[0]!.body!);
    expect(body.subject).toBe('Low stock');
    expect(body.headers).toBeUndefined(); // staff mail is not marketing: no unsubscribe headers
    const [d] = await sql(`select status, provider, provider_message_id from notification_deliveries where notification_id = $1`, [second.id]);
    expect(d).toMatchObject({ status: 'sent', provider: 'resend', provider_message_id: expect.stringMatching(/^em_/) });
    // Redelivery of the same event: no second email.
    expect(await notifications.deliverEmail(tenant.orgId, second.id, { subject: 'Low stock', text: 'Rice is low.' })).toBe('sent');
    expect(f.calls).toHaveLength(1);
  });
});
