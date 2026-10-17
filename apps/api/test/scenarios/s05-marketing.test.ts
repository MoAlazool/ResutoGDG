// S05 — Marketing: real customer activity (WhatsApp + web orders, with and without
// consent) → DSL segment → campaign draft → submit → approval by a separate approver →
// sandbox send (non-consenting customers skipped) → tracking link click → attributed,
// paid order → attribution report (last touch, labelled not incremental). HTTP only.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EventDispatcher } from '../../src/common/events/dispatcher.service';
import { sandboxChannel, walkToMenu } from '../growth-helpers';
import { addMember, auth, bootTestApp, createTenant, sql, type TestApp, type TestTenant, type TestUser } from '../helpers';
import { buildMenuViaApi, key, PRICES, type ApiMenu } from './support';

let t: TestApp;
let tenant: TestTenant;
let menu: ApiMenu;
let marketer: TestUser;
let manager: TestUser;
let cashier: TestUser;
let channelId: string;
const phones = { amira: '+201000000501', bassem: '+201000000502', carla: '+201000000503' };
const customerIds: Record<keyof typeof phones, string> = { amira: '', bassem: '', carla: '' };
let segmentId: string;
let campaign: { id: string; utmCampaign: string };
let link: { id: string; code: string; shortUrl: string };
let sessionKey: string;
let destination: URL;

const mk = (p: string) => `/v1/o/${tenant.orgId}/marketing${p}`;

/** A WhatsApp pickup order with or without marketing consent, paid at the counter. */
async function whatsappOrder(from: string, consent: boolean, attribution?: Record<string, string>) {
  const { token } = await walkToMenu(t, tenant, channelId, from, 'pickup');
  const v = (await t.http.get(`/v1/public/connect/ordering/${token}`)).body;
  const cart = await t.http.post(`/v1/public/connect/ordering/${token}/cart`).send({ version: v.version, lines: [{ productId: menu.fries, quantity: 2 }] });
  await t.http.post(`/v1/public/connect/ordering/${token}/details`).send({ version: cart.body.version, marketingConsent: consent }).expect(201);
  const v2 = (await t.http.get(`/v1/public/connect/ordering/${token}`)).body;
  const done = await t.http.post(`/v1/public/connect/ordering/${token}/checkout`)
    .send({ version: v2.version, paymentMethod: 'cod', expectedTotalMinor: PRICES.fries * 2, ...(attribution ? { attribution } : {}) });
  expect(done.status, JSON.stringify(done.body)).toBe(201);
  return done.body.order as { id: string; totalMinor: number };
}

const collectCash = (orderId: string) =>
  t.http.post(`/v1/o/${tenant.orgId}/orders/${orderId}/collect`).set(auth(cashier)).set('Idempotency-Key', key('cash')).send({ method: 'cash' });

beforeAll(async () => {
  t = await bootTestApp();
  tenant = await createTenant(t, { country: 'EG' });
  menu = await buildMenuViaApi(t, tenant);
  marketer = await addMember(t, tenant, 'marketing');
  manager = await addMember(t, tenant, 'manager');
  cashier = await addMember(t, tenant, 'cashier');
  channelId = (await sandboxChannel(t, tenant)).id;
});
afterAll(async () => { await t.close(); });

describe('S05 marketing: segment → approved campaign → send → click → attributed revenue', () => {
  it('1. customers build up activity: Amira (WhatsApp, consents), Bassem (WhatsApp, declines), Carla (web, consents)', async () => {
    const a = await whatsappOrder(phones.amira, true);
    const b = await whatsappOrder(phones.bassem, false);
    for (const o of [a, b]) expect((await collectCash(o.id)).status).toBe(201);
    const web = await t.http.post(`/v1/public/order/${tenant.slug}/orders`).set('Idempotency-Key', key('web')).send({
      branchId: tenant.branchId, fulfillment: 'pickup', payment: 'pay_at_pickup', lines: [{ productId: menu.soda, quantity: 3 }],
      customer: { name: 'Carla', phone: phones.carla, marketingConsent: true }, expectedTotalMinor: PRICES.soda * 3,
    });
    expect(web.status, JSON.stringify(web.body)).toBe(201);
    const list = await t.http.get(`/v1/o/${tenant.orgId}/customers`).set(auth(tenant.owner));
    expect(list.status).toBe(200);
    for (const k of Object.keys(phones) as Array<keyof typeof phones>) {
      const c = list.body.items.find((x: any) => x.phone === phones[k] || x.phoneE164 === phones[k]);
      expect(c, `customer ${k}`).toBeTruthy();
      customerIds[k] = c.id;
    }
    const consent = (await sql(`select phone_e164, marketing_consent from customers where org_id = $1 order by phone_e164`, [tenant.orgId]))
      .map((r) => [r.phone_e164, r.marketing_consent]);
    expect(consent).toEqual([[phones.amira, true], [phones.bassem, false], [phones.carla, true]]);
  });

  it('2. a DSL segment counts its members exactly; invalid rules are rejected', async () => {
    const definition = { op: 'and', rules: [{ type: 'orders_gte', count: 1, withinDays: 30 }] };
    const preview = await t.http.post(mk('/segments/preview')).set(auth(marketer)).send({ definition });
    expect(preview.status).toBe(201);
    expect(preview.body).toEqual({ count: 3, consentedCount: 2 });
    const whatsappOnly = await t.http.post(mk('/segments/preview')).set(auth(marketer))
      .send({ definition: { op: 'and', rules: [{ type: 'consent', value: true }, { type: 'channel', channel: 'web' }] } });
    expect(whatsappOnly.body.count).toBe(1); // Carla
    expect((await t.http.post(mk('/segments/preview')).set(auth(marketer)).send({ definition: { op: 'and', rules: [{ type: 'raw_sql', where: 'true' }] } })).status).toBe(400);
    const seg = await t.http.post(mk('/segments')).set(auth(marketer)).send({ name: 'Ordered this month', definition });
    expect(seg.status).toBe(201);
    expect(seg.body).toMatchObject({ memberCount: 3, source: 'manual' });
    segmentId = seg.body.id;
    const members = await t.http.get(mk(`/segments/${segmentId}/members`)).set(auth(marketer));
    expect(members.body.items.map((x: any) => x.id).sort()).toEqual(Object.values(customerIds).sort());
  });

  it('3. the marketer drafts and submits a WhatsApp campaign; sending before approval is refused', async () => {
    const c = await t.http.post(mk('/campaigns')).set(auth(marketer)).send({
      name: 'Friday fries', channel: 'whatsapp', segmentId, objective: 'retention', content: { text: 'Fries are on us this Friday — order here!' },
    });
    expect(c.status, JSON.stringify(c.body)).toBe(201);
    expect(c.body).toMatchObject({ status: 'draft', isSandbox: true });
    campaign = c.body;
    expect((await t.http.post(mk(`/campaigns/${campaign.id}/send`)).set(auth(marketer))).body.error.code).toBe('campaign_not_approved');
    const submitted = await t.http.post(mk(`/campaigns/${campaign.id}/submit`)).set(auth(marketer));
    expect(submitted.body.status, JSON.stringify(submitted.body)).toBe('pending_approval');
    expect((await t.http.post(mk(`/campaigns/${campaign.id}/send`)).set(auth(marketer))).status).toBe(409);
    expect((await t.http.post(mk(`/campaigns/${campaign.id}/approve`)).set(auth(cashier))).status).toBe(403);
  });

  it('4. a separate approver (manager) approves; the campaign is locked', async () => {
    const approved = await t.http.post(mk(`/campaigns/${campaign.id}/approve`)).set(auth(manager));
    expect(approved.status).toBe(201);
    expect(approved.body).toMatchObject({ status: 'approved', approvedBy: manager.userId });
    expect(approved.body.approvedBy).not.toBe(marketer.userId);
    expect((await t.http.patch(mk(`/campaigns/${campaign.id}`)).set(auth(marketer)).send({ name: 'Changed' })).body.error.code).toBe('campaign_not_editable');
  });

  it('5. sending on the sandbox channel reaches only consenting customers with a WhatsApp conversation', async () => {
    const sent = await t.http.post(mk(`/campaigns/${campaign.id}/send`)).set(auth(marketer));
    expect(sent.status, JSON.stringify(sent.body)).toBe(201);
    expect(sent.body).toMatchObject({ status: 'sent', isSandbox: true, delivery: { recipients: 3, queued: 1, skippedNoConsent: 1, failed: 1, sandbox: 1, live: 0 } });
    const deliveries = (await t.http.get(mk(`/campaigns/${campaign.id}/deliveries`)).set(auth(marketer))).body.items;
    const by = Object.fromEntries(deliveries.map((d: any) => [d.customerId, d]));
    expect(by[customerIds.amira]).toMatchObject({ status: 'delivered' });
    expect(by[customerIds.bassem]).toMatchObject({ status: 'skipped_no_consent' });
    expect(by[customerIds.carla]).toMatchObject({ status: 'failed', error: 'no_channel' });
    const toBassem = await sql(`select count(*)::int as n from messages m join conversations c on c.id = m.conversation_id
                                 where c.customer_id = $1 and m.payload->>'reason' like 'campaign:%'`, [customerIds.bassem]);
    expect(toBassem[0].n).toBe(0);
    expect((await t.http.post(mk(`/campaigns/${campaign.id}/send`)).set(auth(marketer))).status).toBe(409); // never twice
  });

  it('6. the campaign tracking link records a click and hands back a utm-tagged destination', async () => {
    const l = await t.http.post(mk('/links')).set(auth(marketer)).send({ campaignId: campaign.id, destinationPath: `/order/${tenant.slug}`, utm: { content: 'friday' } });
    expect(l.status, JSON.stringify(l.body)).toBe(201);
    link = l.body;
    expect(link.shortUrl).toBe(`http://app.test/l/${link.code}`);
    const click = await t.http.get(`/v1/public/l/${link.code}`);
    expect(click.status).toBe(200);
    destination = new URL(click.body.destination, 'http://app.test');
    expect(destination.pathname).toBe(`/order/${tenant.slug}`);
    expect(Object.fromEntries(destination.searchParams)).toMatchObject({ utm_source: 'resuto', utm_medium: 'whatsapp', utm_campaign: campaign.utmCampaign, utm_content: 'friday', rcid: campaign.id });
    sessionKey = destination.searchParams.get('rsid')!;
    expect(sessionKey).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
    expect((await sql(`select click_count from tracking_links where id = $1`, [link.id]))[0].click_count).toBe(1);
  });

  it('7. Amira orders with the link attribution and pays; the report shows the order and revenue, not incremental', async () => {
    const order = await whatsappOrder(phones.amira, true, { campaignId: campaign.id, sessionKey, utm_source: 'resuto', utm_campaign: campaign.utmCampaign });
    const [row] = await sql(`select campaign_id, attribution from orders where id = $1`, [order.id]);
    expect(row.campaign_id).toBe(campaign.id);
    expect(row.attribution).toMatchObject({ session_key: sessionKey });
    expect((await collectCash(order.id)).status).toBe(201);
    await t.app.get(EventDispatcher).drain();
    expect((await sql(`select count(*)::int as n from attribution_events where order_id = $1 and kind = 'order_paid'`, [order.id]))[0].n).toBe(1);
    const report = await t.http.get(mk(`/campaigns/${campaign.id}/report`)).set(auth(marketer));
    expect(report.status).toBe(200);
    expect(report.body).toMatchObject({
      model: 'last_touch', isSandbox: true, clicks: 1, orders: 1, revenueMinor: order.totalMinor, orderValueMinor: order.totalMinor,
      messages: { sent: 1, skippedNoConsent: 1, failed: 1 }, costMinor: 0, roas: null,
    });
    expect(report.body.disclaimer).toMatch(/not incremental/);
  });

  // DEFECT: G-01 A web order placed from a tracking-link destination (/order/<slug>?rcid=…&rsid=…) is never attributed to the campaign.
  it.fails('8. a web order placed from the link destination (rcid/rsid forwarded) is attributed to the campaign', async () => {
    const attribution = Object.fromEntries([...destination.searchParams.entries()]);
    const web = await t.http.post(`/v1/public/order/${tenant.slug}/orders`).set('Idempotency-Key', key('web-attr')).send({
      branchId: tenant.branchId, fulfillment: 'pickup', payment: 'pay_at_pickup', lines: [{ productId: menu.soda, quantity: 2 }],
      customer: { name: 'Carla', phone: phones.carla, marketingConsent: true }, expectedTotalMinor: PRICES.soda * 2, attribution,
    });
    expect(web.status, JSON.stringify(web.body)).toBe(201);
    const [row] = await sql(`select campaign_id, attribution from orders where id = $1`, [web.body.order.id]);
    expect(row.attribution).toMatchObject({ rcid: campaign.id, rsid: sessionKey });
    expect(row.campaign_id).toBe(campaign.id);
  });
});
