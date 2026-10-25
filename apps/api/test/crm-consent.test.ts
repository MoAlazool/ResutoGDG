// 21-CRM consent rules (plan §6.7):
// - Messaging a business never sets marketing consent: a WhatsApp chat (new or existing contact) leaves
//   customers.marketing_consent false and writes no customer_consent_events row.
// - Only an explicit opt-in (recorded in customer_consent_events) grants it.
// - Messaging contacts without consent are "contact allowed for service replies only" (Customer 360 contactBasis).
// - Campaign audiences exclude customers without consent: they are recorded skipped_no_consent and get no message.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inbound, sandboxChannel } from './growth-helpers';
import { auth, bootTestApp, createTenant, seedMenu, sql, type SeededMenu, type TestApp, type TestTenant } from './helpers';
import { placeOrder } from './insights-fixtures';

let t: TestApp;
let tenant: TestTenant;
let menu: SeededMenu;
let channelId: string;
const m = (path: string) => `/v1/o/${tenant.orgId}/marketing${path}`;
const consentOf = async (id: string) => (await sql(`select marketing_consent, marketing_consent_source from customers where id = $1`, [id]))[0];
const events = (id: string) => sql(`select granted, source from customer_consent_events where customer_id = $1 order by occurred_at, id`, [id]);

beforeAll(async () => {
  t = await bootTestApp();
  tenant = await createTenant(t);
  menu = await seedMenu(tenant);
  channelId = (await sandboxChannel(t, tenant, { displayName: 'WA' })).id;
});
afterAll(async () => { await t.close(); });

describe('consent rules', () => {
  const ids: Record<string, string> = {};

  it('a new WhatsApp contact is created without marketing consent and without a consent event, whatever they write', async () => {
    for (const text of ['hello', 'yes please send me offers', 'subscribe', 'نعم أرسلوا العروض']) {
      const phone = `+2010099900${String(ids.n ?? 10).padStart(2, '0')}`;
      ids.n = String(Number(ids.n ?? 10) + 1);
      const conv = await inbound(t, tenant, channelId, phone, { text, name: 'Chat' });
      const id = conv.conversation.customer.id as string;
      expect(await consentOf(id)).toEqual({ marketing_consent: false, marketing_consent_source: null });
      expect(await events(id)).toEqual([]);
      ids.chat ??= id;
    }
  });

  it('an existing customer without consent who messages stays without consent; one with consent keeps it unchanged', async () => {
    const none = await placeOrder(t, tenant, { channel: 'qr', fulfillment: 'dine_in', tableId: menu.tableId, lines: [{ productId: menu.products.fries, quantity: 1 }],
      customer: { name: 'Diner', phone: '+201009991001' } });
    ids.diner = none.customerId!;
    await inbound(t, tenant, channelId, '+201009991001', { text: 'Can I get offers?' });
    await inbound(t, tenant, channelId, '+201009991001', { text: 'thanks' });
    expect((await consentOf(ids.diner)).marketing_consent).toBe(false);
    expect(await events(ids.diner)).toEqual([]);
    // A customer who opted in at checkout: messaging changes nothing (no new event, consent kept).
    const opted = await placeOrder(t, tenant, { channel: 'web', fulfillment: 'pickup', lines: [{ productId: menu.products.fries, quantity: 1 }],
      customer: { name: 'Opted', phone: '+201009991002', marketingConsent: true } });
    ids.opted = opted.customerId!;
    expect(await events(ids.opted)).toEqual([{ granted: true, source: 'web' }]);
    await inbound(t, tenant, channelId, '+201009991002', { text: 'stop' });
    expect((await consentOf(ids.opted)).marketing_consent).toBe(true);
    expect(await events(ids.opted)).toEqual([{ granted: true, source: 'web' }]);
  });

  it('only an explicit opt-in grants consent, and it is recorded as an event', async () => {
    const res = await t.http.post(`/v1/o/${tenant.orgId}/customers/${ids.diner}/consent`).set(auth(tenant.owner))
      .send({ granted: true, source: 'customer_request', note: 'Asked in person' });
    expect(res.status).toBe(200);
    expect(await consentOf(ids.diner)).toEqual({ marketing_consent: true, marketing_consent_source: 'staff:customer_request' });
    expect(await events(ids.diner)).toEqual([{ granted: true, source: 'staff:customer_request' }]);
  });

  it('shows messaging contacts without consent as "service replies only" in Customer 360', async () => {
    const chat = (await t.http.get(`/v1/o/${tenant.orgId}/customers/${ids.chat}/360`).set(auth(tenant.owner))).body;
    expect(chat.consent.marketing.granted).toBe(false);
    const wa = chat.consent.channels.find((c: any) => c.channel === 'whatsapp');
    expect(wa).toMatchObject({ granted: false, contactBasis: 'service_replies_only', serviceWindow: { open: true } });
    const opted = (await t.http.get(`/v1/o/${tenant.orgId}/customers/${ids.opted}/360`).set(auth(tenant.owner))).body;
    expect(opted.consent.channels.find((c: any) => c.channel === 'whatsapp')).toMatchObject({ granted: true, contactBasis: 'marketing_consent' });
    for (const ch of chat.consent.channels) expect(ch.contactBasis).toBe('service_replies_only');
  });

  it('excludes customers without consent from a campaign audience (recorded skipped, no message)', async () => {
    // Everyone with a WhatsApp conversation or an order: chat-only contacts, the opted-in customer and the diner (opted in above).
    const seg = await t.http.post(m('/segments')).set(auth(tenant.owner)).send({ name: 'Everyone', definition: { op: 'or', rules: [
      { type: 'orders_gte', count: 1 }, { type: 'consent', value: false }] } });
    expect(seg.status).toBe(201);
    const preview = await t.http.post(m('/segments/preview')).set(auth(tenant.owner)).send({ definition: seg.body.definition });
    const all = (await sql(`select count(*)::int as n, count(*) filter (where marketing_consent)::int as c from customers where org_id = $1`, [tenant.orgId]))[0];
    expect(preview.body).toEqual({ count: all.n, consentedCount: all.c });
    expect(all.c).toBe(2);
    const c = await t.http.post(m('/campaigns')).set(auth(tenant.owner)).send({ name: 'Offer', channel: 'whatsapp', segmentId: seg.body.id, content: { text: 'Offer!' } });
    await t.http.post(m(`/campaigns/${c.body.id}/submit`)).set(auth(tenant.owner)).expect(200);
    await t.http.post(m(`/campaigns/${c.body.id}/approve`)).set(auth(tenant.owner)).expect(200);
    const sent = await t.http.post(m(`/campaigns/${c.body.id}/send`)).set(auth(tenant.owner));
    expect(sent.status).toBe(200);
    const deliveries = (await t.http.get(m(`/campaigns/${c.body.id}/deliveries`)).set(auth(tenant.owner))).body.items;
    const consented = new Set((await sql(`select id from customers where org_id = $1 and marketing_consent`, [tenant.orgId])).map((r) => r.id));
    expect(deliveries.length).toBe(all.n);
    for (const d of deliveries) {
      if (consented.has(d.customerId)) expect(d.status, d.customerId).not.toBe('skipped_no_consent');
      else expect(d.status, d.customerId).toBe('skipped_no_consent');
    }
    // No campaign message reached any customer without consent.
    const leaked = await sql(`select count(*)::int as n from messages msg join conversations cv on cv.id = msg.conversation_id join customers cu on cu.id = cv.customer_id
      where cu.org_id = $1 and not cu.marketing_consent and msg.payload->>'reason' like 'campaign:%'`, [tenant.orgId]);
    expect(leaked[0].n).toBe(0);
    // And the chat-only contacts are among the skipped.
    expect(deliveries.find((d: any) => d.customerId === ids.chat)).toMatchObject({ status: 'skipped_no_consent' });
  });
});
