// INT-21 / FT-05: Messenger and Instagram Direct channels on the Connect inbox. Ownership proven through the Graph API,
// signed webhooks (X-Hub-Signature-256, platform app secret) routed only to verified channels, the 24-hour window and
// the 7-day HUMAN_AGENT reply for staff, and webhook -> bot -> order on a Messenger channel.
import { createHmac } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { MessagingService } from '../src/modules/connect/messaging.service';
import { ProviderHttp } from '../src/modules/integrations/provider-http';
import { lastOutbound, outbound, scriptedFetch } from './growth-helpers';
import { auth, bootTestApp, createTenant, seedMenu, sql, unique, type TestApp, type TestTenant } from './helpers';

const APP_SECRET = 'meta-platform-app-secret-123';
process.env.META_APP_SECRET = APP_SECRET;
process.env.META_WEBHOOK_VERIFY_TOKEN = 'meta-verify-token-1';

let t: TestApp;
let http: ProviderHttp;
let original: typeof fetch;
beforeAll(async () => { t = await bootTestApp(); http = t.app.get(ProviderHttp); original = http.fetch; });
afterEach(() => { http.fetch = original; });
// Leave no queued Page messages behind for other files' sender-job assertions.
afterAll(async () => {
  await sql(`update messages m set status = 'failed', error = 'test cleanup', next_attempt_at = null from conversations c join messaging_channels ch on ch.id = c.channel_id
              where m.conversation_id = c.id and ch.transport = 'meta_page' and m.status = 'queued'`);
  await t.close();
});

let seq = 0;
const ids = () => { seq++; const base = `${Date.now()}`.slice(-9); return { pageId: `5${base}${seq}`, igId: `17${base}${seq}` }; };
const sign = (body: string, secret = APP_SECRET) => `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
const deliver = (payload: unknown, secret?: string) => {
  const body = JSON.stringify(payload);
  return t.http.post('/v1/webhooks/meta').set('Content-Type', 'application/json').set('X-Hub-Signature-256', sign(body, secret)).send(body);
};
const pageEvent = (object: 'page' | 'instagram', accountId: string, from: string, message: Record<string, unknown>) =>
  ({ object, entry: [{ id: accountId, time: Date.now(), messaging: [{ sender: { id: from }, recipient: { id: accountId }, timestamp: Date.now(), message: { mid: unique('mid'), ...message } }] }] });

async function pagesConnection(tenant: TestTenant, cfg: { pageId: string; igId?: string }) {
  const res = await t.http.post(`/v1/o/${tenant.orgId}/integrations/connections`).set(auth(tenant.owner))
    .send({ provider: 'meta_pages', environment: 'live', credentials: { accessToken: 'EAAPage-token-123456' }, config: { pageId: cfg.pageId, ...(cfg.igId ? { instagramAccountId: cfg.igId } : {}) } });
  expect(res.status).toBe(201);
  await sql(`update integration_connections set status = 'connected' where id = $1`, [res.body.id]);
  return res.body.id as string;
}

async function messengerChannel(tenant: TestTenant, pageId: string, connectionId: string, kind: 'messenger' | 'instagram' = 'messenger', igId?: string) {
  const f = scriptedFetch(kind === 'messenger'
    ? [{ body: { id: pageId, name: 'Olive Room' } }, { body: { success: true } }]
    : [{ body: { id: pageId, name: 'Olive Room' } }, { body: { instagram_business_account: { id: igId, username: 'oliveroom' } } }, { body: { success: true } }]);
  http.fetch = f.fetch;
  const res = await t.http.post(`/v1/o/${tenant.orgId}/connect/channels`).set(auth(tenant.owner))
    .send({ transport: 'meta_page', kind, displayName: kind === 'messenger' ? 'Messenger' : 'Instagram', connectionId });
  return { res, calls: f.calls };
}

describe('channel ownership', () => {
  it('a Messenger channel exists only after the token proves it is that Page\'s token; the Page is subscribed to messages', async () => {
    const tenant = await createTenant(t);
    const { pageId } = ids();
    const conn = await pagesConnection(tenant, { pageId });
    // Token of another Page: refused, nothing stored.
    http.fetch = scriptedFetch([{ body: { id: '999999', name: 'Someone else' } }]).fetch;
    const bad = await t.http.post(`/v1/o/${tenant.orgId}/connect/channels`).set(auth(tenant.owner)).send({ transport: 'meta_page', kind: 'messenger', displayName: 'M', connectionId: conn });
    expect(bad.status).toBe(422);
    expect(bad.body.error).toMatchObject({ code: 'page_not_verified', details: { reason: 'token_not_for_page' } });
    expect(await sql(`select 1 from messaging_channels where org_id = $1`, [tenant.orgId])).toHaveLength(0);

    const { res, calls } = await messengerChannel(tenant, pageId, conn);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ kind: 'messenger', transport: 'meta_page', pageId, externalAccountId: pageId, verified: true, webhookSubscribed: true });
    expect(calls.map((c) => `${c.method} ${new URL(c.url).pathname}`)).toEqual(['GET /v26.0/me', `POST /v26.0/${pageId}/subscribed_apps`]);
    // Instagram needs the account id on the connection.
    const ig = await t.http.post(`/v1/o/${tenant.orgId}/connect/channels`).set(auth(tenant.owner)).send({ transport: 'meta_page', kind: 'instagram', displayName: 'IG', connectionId: conn });
    expect(ig.body.error.code).toBe('instagram_account_required');
  });

  it('another restaurant cannot claim a connected Page (no provider call), and request ids cannot override the connection', async () => {
    const a = await createTenant(t);
    const b = await createTenant(t);
    const { pageId } = ids();
    await messengerChannel(a, pageId, await pagesConnection(a, { pageId }));
    const connB = await pagesConnection(b, { pageId });
    const f = scriptedFetch([{ body: { id: pageId } }]);
    http.fetch = f.fetch;
    const res = await t.http.post(`/v1/o/${b.orgId}/connect/channels`).set(auth(b.owner)).send({ transport: 'meta_page', kind: 'messenger', displayName: 'M', connectionId: connB });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('account_in_use');
    expect(f.calls).toHaveLength(0);
    const extra = await t.http.post(`/v1/o/${b.orgId}/connect/channels`).set(auth(b.owner)).send({ transport: 'meta_page', kind: 'messenger', displayName: 'M', connectionId: connB, pageId: '123' });
    expect(extra.status).toBe(400);
  });

  it('an Instagram channel requires the account linked to the Page', async () => {
    const tenant = await createTenant(t);
    const { pageId, igId } = ids();
    const conn = await pagesConnection(tenant, { pageId, igId });
    http.fetch = scriptedFetch([{ body: { id: pageId } }, { body: { instagram_business_account: { id: '1700000000' } } }]).fetch;
    const bad = await t.http.post(`/v1/o/${tenant.orgId}/connect/channels`).set(auth(tenant.owner)).send({ transport: 'meta_page', kind: 'instagram', displayName: 'IG', connectionId: conn });
    expect(bad.body.error).toMatchObject({ code: 'page_not_verified', details: { reason: 'instagram_not_linked' } });
    const { res } = await messengerChannel(tenant, pageId, conn, 'instagram', igId);
    expect(res.body).toMatchObject({ kind: 'instagram', externalAccountId: igId, pageId, verified: true });
  });
});

describe('webhooks', () => {
  it('verifies the subscription handshake and refuses unsigned or mis-signed deliveries', async () => {
    const ok = await t.http.get('/v1/webhooks/meta').query({ 'hub.mode': 'subscribe', 'hub.verify_token': 'meta-verify-token-1', 'hub.challenge': '771' });
    expect(ok.status).toBe(200);
    expect(ok.text).toBe('771');
    expect((await t.http.get('/v1/webhooks/meta').query({ 'hub.mode': 'subscribe', 'hub.verify_token': 'nope', 'hub.challenge': '1' })).status).toBe(403);
    const body = JSON.stringify(pageEvent('page', '123', '900', { text: 'hi' }));
    expect((await t.http.post('/v1/webhooks/meta').set('Content-Type', 'application/json').send(body)).status).toBe(401);
    expect((await deliver(JSON.parse(body), 'wrong-secret')).status).toBe(401);
  });

  it('routes Messenger and Instagram messages only to the verified channel of that account; never resolves a PSID as a phone', async () => {
    const tenant = await createTenant(t);
    await sql(`update branches set accepts_pickup = true where org_id = $1`, [tenant.orgId]);
    const { pageId, igId } = ids();
    const conn = await pagesConnection(tenant, { pageId, igId });
    const m = (await messengerChannel(tenant, pageId, conn)).res.body;
    const i = (await messengerChannel(tenant, pageId, conn, 'instagram', igId)).res.body;
    await t.http.patch(`/v1/o/${tenant.orgId}/connect/channels/${m.id}`).set(auth(tenant.owner)).send({ orderingEnabled: false }).expect(200);
    await t.http.patch(`/v1/o/${tenant.orgId}/connect/channels/${i.id}`).set(auth(tenant.owner)).send({ orderingEnabled: false }).expect(200);

    const r1 = await deliver(pageEvent('page', pageId, '2010012345678', { text: 'Do you have a table tonight?' }));
    expect(r1.body).toMatchObject({ received: 1, processed: 1 });
    const r2 = await deliver(pageEvent('instagram', igId, 'IGSID77', { text: 'مرحبا' }));
    expect(r2.body).toMatchObject({ received: 1, processed: 1 });
    const unknown = await deliver(pageEvent('page', '424242', '1', { text: 'x' }));
    expect(unknown.body).toMatchObject({ received: 1, ignored: 1 });
    // An Instagram event naming the Page id is not a Messenger message (kind and account must both match).
    expect((await deliver(pageEvent('instagram', pageId, '1', { text: 'x' }))).body).toMatchObject({ ignored: 1 });

    const convs = await sql(`select c.external_contact, c.customer_id, ch.kind from conversations c join messaging_channels ch on ch.id = c.channel_id where c.org_id = $1 order by ch.kind`, [tenant.orgId]);
    expect(convs).toEqual([{ external_contact: 'IGSID77', customer_id: null, kind: 'instagram' }, { external_contact: '2010012345678', customer_id: null, kind: 'messenger' }]);
    const list = (await t.http.get(`/v1/o/${tenant.orgId}/connect/conversations`).set(auth(tenant.owner))).body.items;
    expect(list.map((c: any) => c.channelKind).sort()).toEqual(['instagram', 'messenger']);
  });

  it('webhook -> bot -> order on Messenger: quick replies, a typed address, the menu link as a button, the order on channel messenger', async () => {
    const tenant = await createTenant(t);
    const menu = await seedMenu(tenant);
    const { pageId } = ids();
    const conn = await pagesConnection(tenant, { pageId });
    await messengerChannel(tenant, pageId, conn);
    const psid = '7700112233445566';
    await deliver(pageEvent('page', pageId, psid, { text: 'order' }));
    const [conv] = await sql(`select id from conversations where org_id = $1`, [tenant.orgId]);
    await deliver(pageEvent('page', pageId, psid, { text: 'Delivery', quick_reply: { payload: 'ful:delivery' } }));
    await deliver(pageEvent('page', pageId, psid, { text: 'Mona Adel' }));
    await deliver(pageEvent('page', pageId, psid, { text: '26 July St, building 4, floor 2' }));
    const link = await lastOutbound(conv.id);
    const token = String(link.payload.url).split('/o/')[1]!;
    expect(token).toBeTruthy();

    // The sender job turns the queued messages into Send API calls on the Page.
    const sent: any[] = [];
    http.fetch = (async (url: string, init: RequestInit) => {
      sent.push({ url: String(url), body: JSON.parse(String(init.body)) });
      return new Response(JSON.stringify({ recipient_id: psid, message_id: unique('m.out') }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    await t.app.get(MessagingService).runSender(100);
    // The job serves every tenant; keep this Page's calls (other files may leave WhatsApp messages queued).
    const all = sent.splice(0);
    sent.push(...all.filter((x) => x.url.includes(`/${pageId}/`)));
    expect(sent.length).toBeGreaterThan(2);
    expect(sent.every((s) => new URL(s.url).pathname === `/v26.0/${pageId}/messages` && s.body.recipient.id === psid && s.body.messaging_type === 'RESPONSE')).toBe(true);
    expect(sent.some((s) => s.body.message.quick_replies?.some((q: any) => q.payload === 'ful:delivery'))).toBe(true);
    expect(sent.some((s) => s.body.message.attachment?.payload?.buttons?.[0]?.url?.includes('/o/'))).toBe(true);
    expect(JSON.stringify(sent)).not.toContain('"type":"location_request"');
    expect((await outbound(conv.id)).every((m) => m.status === 'sent')).toBe(true);

    const v0 = (await t.http.get(`/v1/public/connect/ordering/${token}`)).body;
    const cart = await t.http.post(`/v1/public/connect/ordering/${token}/cart`).send({ version: v0.version, lines: [{ productId: menu.products.fries, quantity: 2 }] });
    expect(cart.status).toBe(201);
    const v1 = (await t.http.get(`/v1/public/connect/ordering/${token}`)).body;
    // Messenger gives no phone number: a delivery order asks for one on the hosted page.
    expect(v1).toMatchObject({ channel: 'messenger', needsPhone: true, customerPhone: null });
    const noPhone = await t.http.post(`/v1/public/connect/ordering/${token}/checkout`).send({ version: v1.version, paymentMethod: 'cod', expectedTotalMinor: v1.quote.totalMinor });
    expect(noPhone.body.error.code).toBe('phone_required');
    const v2 = (await t.http.post(`/v1/public/connect/ordering/${token}/details`).send({ version: v1.version, phone: '+201005554444' })).body;
    expect(v2.customerPhone).toBe('+201005554444');
    const done = await t.http.post(`/v1/public/connect/ordering/${token}/checkout`).send({ version: v2.version, paymentMethod: 'cod', expectedTotalMinor: v1.quote.totalMinor });
    if (done.status !== 201) throw new Error(JSON.stringify(done.body));
    const [order] = await sql(`select channel::text as channel, customer_phone, conversation_id from orders where org_id = $1`, [tenant.orgId]);
    expect(order).toEqual({ channel: 'messenger', customer_phone: '+201005554444', conversation_id: conv.id });
    const [session] = await sql(`select channel from ordering_sessions where conversation_id = $1`, [conv.id]);
    expect(session.channel).toBe('messenger');
  });
});

describe('the 24-hour window and handoff', () => {
  it('after 24 hours only staff can reply, with HUMAN_AGENT, for 7 days; templates do not exist on Messenger', async () => {
    const tenant = await createTenant(t);
    const { pageId } = ids();
    const conn = await pagesConnection(tenant, { pageId });
    const ch = (await messengerChannel(tenant, pageId, conn)).res.body;
    await t.http.patch(`/v1/o/${tenant.orgId}/connect/channels/${ch.id}`).set(auth(tenant.owner)).send({ orderingEnabled: false }).expect(200);
    await deliver(pageEvent('page', pageId, '880', { text: 'Is my order coming?' }));
    const [conv] = await sql(`select id from conversations where org_id = $1`, [tenant.orgId]);
    const reply = (body: Record<string, unknown>) => t.http.post(`/v1/o/${tenant.orgId}/connect/conversations/${conv.id}/reply`).set(auth(tenant.owner)).send({ key: unique('k'), ...body });

    expect((await reply({ templateName: 'order_update', variables: ['1'] })).body.error.code).toBe('template_not_supported');
    await sql(`update conversations set last_inbound_at = now() - interval '2 days' where id = $1`, [conv.id]);
    const detail = (await t.http.get(`/v1/o/${tenant.orgId}/connect/conversations/${conv.id}`).set(auth(tenant.owner))).body;
    expect(detail.window.open).toBe(false);
    expect(new Date(detail.humanReplyUntil).getTime()).toBeGreaterThan(Date.now());
    expect((await reply({ text: 'Sorry for the wait, it is on its way' })).status).toBe(201);
    const s = scriptedFetch([{ body: { recipient_id: '880', message_id: 'm.human' } }]);
    http.fetch = s.fetch;
    await t.app.get(MessagingService).runSender(100);
    const mine = s.calls.map((c) => JSON.parse(c.body!)).filter((b) => b.recipient.id === '880');
    expect(mine).toEqual([expect.objectContaining({ messaging_type: 'MESSAGE_TAG', tag: 'HUMAN_AGENT', message: { text: 'Sorry for the wait, it is on its way' } })]);

    await sql(`update conversations set last_inbound_at = now() - interval '8 days' where id = $1`, [conv.id]);
    expect((await reply({ text: 'Hello?' })).body.error.code).toBe('outside_window');
  });
});
