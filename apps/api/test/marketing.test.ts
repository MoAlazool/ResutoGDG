import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TenantContext } from '../src/common/auth/context';
import { DbService } from '../src/common/db/db.service';
import { EventDispatcher } from '../src/common/events/dispatcher.service';
import { CampaignsService } from '../src/modules/marketing/campaigns.service';
import { ProviderHttp } from '../src/modules/integrations/provider-http';
import { OrdersKernelService } from '../src/modules/kernel/orders-kernel.service';
import { PaymentLedgerService } from '../src/modules/kernel/payment-ledger.service';
import { CAMPAIGNS_PORT, SEGMENTS_PORT, type CampaignsPort, type SegmentsPort } from '../src/modules/kernel/ports';
import { inbound, sandboxChannel, walkToMenu, scriptedFetch } from './growth-helpers';
import { addMember, auth, bootTestApp, createTenant, seedMenu, sql, type SeededMenu, type TestApp, type TestTenant } from './helpers';

let t: TestApp;
let tenant: TestTenant;
let menu: SeededMenu;
let channelId: string;
let db: DbService;
const phones = { a: '+201000000101', b: '+201000000102', c: '+201000000103' };
const ids: Record<'a' | 'b' | 'c', string> = { a: '', b: '', c: '' };
const m = (path: string) => `/v1/o/${tenant.orgId}/marketing${path}`;

beforeAll(async () => {
  t = await bootTestApp();
  db = t.app.get(DbService);
  tenant = await createTenant(t);
  menu = await seedMenu(tenant);
  channelId = (await sandboxChannel(t, tenant)).id;
  // A and B wrote to us on WhatsApp (sandbox); C never did.
  await inbound(t, tenant, channelId, phones.a, { text: 'hi', name: 'Amira' });
  await inbound(t, tenant, channelId, phones.b, { text: 'hi', name: 'Bassem' });
  const kernel = t.app.get(OrdersKernelService);
  const ctx = new TenantContext(tenant.orgId, 'owner', null, tenant.owner.userId, 'user', tenant.owner.userId);
  const place = (phone: string, consent: boolean, lines = [{ productId: menu.products.fries, quantity: 1 }]) => db.scoped(ctx, (tx) => kernel.place(tx, ctx, {
    branchId: tenant.branchId, channel: 'web', fulfillment: 'pickup', lines, customer: { name: 'x', phone, marketingConsent: consent } }));
  const a = await place(phones.a, true);
  await sql(`update orders set placed_at = now() - interval '40 days' where id = $1`, [a.id]);
  await sql(`update customers set last_seen_at = now() - interval '40 days' where id = $1`, [a.customerId]);
  await place(phones.b, false, [{ productId: menu.products.soda, quantity: 2 }]);
  for (let i = 0; i < 3; i++) await place(phones.c, true, [{ productId: menu.products.soda, quantity: 1 }]);
  for (const k of ['a', 'b', 'c'] as const) ids[k] = (await sql(`select id from customers where org_id = $1 and phone_e164 = $2`, [tenant.orgId, phones[k]]))[0].id;
  await sql(`update customers set tags = '{vip}' where id = $1`, [ids.b]);
});
afterAll(async () => { await t.close(); });

const preview = async (definition: unknown) => t.http.post(m('/segments/preview')).set(auth(tenant.owner)).send({ definition });
const count = async (definition: unknown) => (await preview(definition)).body.count;

describe('segment rule DSL', () => {
  it('evaluates each rule and and/or groups correctly', async () => {
    expect(await count({ op: 'and', rules: [{ type: 'consent', value: true }] })).toBe(2);
    expect(await count({ op: 'and', rules: [{ type: 'inactive_days_gte', days: 30 }] })).toBe(1);
    expect(await count({ op: 'and', rules: [{ type: 'orders_gte', count: 3, withinDays: 60 }] })).toBe(1);
    expect(await count({ op: 'and', rules: [{ type: 'orders_gte', count: 1, withinDays: 30 }] })).toBe(2);
    expect(await count({ op: 'and', rules: [{ type: 'spent_gte', amountMinor: 7500 }] })).toBe(1); // C: 3 × 2500
    expect(await count({ op: 'and', rules: [{ type: 'has_tag', tag: 'vip' }] })).toBe(1);
    expect(await count({ op: 'and', rules: [{ type: 'purchased_product', productId: menu.products.fries }] })).toBe(1);
    expect(await count({ op: 'and', rules: [{ type: 'branch', branchId: tenant.branchId }] })).toBe(3);
    expect(await count({ op: 'and', rules: [{ type: 'channel', channel: 'web' }] })).toBe(3);
    expect(await count({ op: 'and', rules: [{ type: 'channel', channel: 'whatsapp' }] })).toBe(0);
    expect(await count({ op: 'or', rules: [{ type: 'has_tag', tag: 'vip' }, { type: 'orders_gte', count: 3 }] })).toBe(2);
    const nested = await preview({ op: 'and', rules: [{ type: 'consent', value: true }, { op: 'or', rules: [{ type: 'inactive_days_gte', days: 30 }, { type: 'orders_gte', count: 3 }] }] });
    expect(nested.body).toEqual({ count: 2, consentedCount: 2 });
  });

  it('binds values as parameters (SQL injection attempts match nothing and break nothing)', async () => {
    const before = (await sql(`select count(*)::int as n from customers where org_id = $1`, [tenant.orgId]))[0].n;
    expect(await count({ op: 'and', rules: [{ type: 'has_tag', tag: "x' or '1'='1" }] })).toBe(0);
    expect(await count({ op: 'or', rules: [{ type: 'has_tag', tag: "vip'); delete from customers; --" }] })).toBe(0);
    expect((await sql(`select count(*)::int as n from customers where org_id = $1`, [tenant.orgId]))[0].n).toBe(before);
    expect((await preview({ op: 'and', rules: [{ type: 'has_tag', tag: 'vip', sql: '1=1' }] })).status).toBe(400);
    expect((await preview({ op: 'and', rules: [{ type: 'raw_sql', where: 'true' }] })).status).toBe(400);
    expect((await preview({ op: 'xor', rules: [{ type: 'consent', value: true }] })).status).toBe(400);
    expect((await preview({ op: 'and', rules: [{ type: 'branch', branchId: "1' or 1=1 --" }] })).status).toBe(400);
    const deep = { op: 'and', rules: [{ op: 'and', rules: [{ op: 'and', rules: [{ op: 'and', rules: [{ type: 'consent', value: true }] }] }] }] };
    expect((await preview(deep)).status).toBe(400);
  });

  it('creates, computes and refreshes segments; SEGMENTS_PORT works for other modules', async () => {
    const res = await t.http.post(m('/segments')).set(auth(tenant.owner)).send({ name: 'Consented', definition: { op: 'and', rules: [{ type: 'consent', value: true }] } });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ memberCount: 2, source: 'manual' });
    const members = await t.http.get(m(`/segments/${res.body.id}/members`)).set(auth(tenant.owner));
    expect(members.body.items.map((x: any) => x.id).sort()).toEqual([ids.a, ids.c].sort());
    await sql(`update customers set marketing_consent = true where id = $1`, [ids.b]);
    expect((await t.http.post(m(`/segments/${res.body.id}/refresh`)).set(auth(tenant.owner))).body.memberCount).toBe(3);
    await sql(`update customers set marketing_consent = false where id = $1`, [ids.b]);
    const port = t.app.get<SegmentsPort>(SEGMENTS_PORT);
    const ctx = TenantContext.system(tenant.orgId, 'mcp-test', 'mcp');
    const viaPort = await db.withTenant(tenant.orgId, (tx) => port.create(tx, ctx, { name: 'Regulars (MCP)', definition: { op: 'and', rules: [{ type: 'orders_gte', count: 3 }] }, source: 'mcp' }));
    expect(viaPort.memberCount).toBe(1);
    await expect(db.withTenant(tenant.orgId, (tx) => port.create(tx, ctx, { name: 'Bad', definition: { op: 'and', rules: [] }, source: 'mcp' }))).rejects.toMatchObject({ code: 'invalid_segment' });
  });
});

describe('promotions', () => {
  it('CRUD with validation; the kernel applies the code at pricing', async () => {
    expect((await t.http.post(m('/promotions')).set(auth(tenant.owner)).send({ code: 'BIG', name: 'Too big', kind: 'percent', value: 20000 })).status).toBe(400);
    const p = await t.http.post(m('/promotions')).set(auth(tenant.owner)).send({ code: 'SAVE15', name: 'Save 15%', kind: 'percent', value: 1500, maxDiscountMinor: 3000 });
    expect(p.status).toBe(201);
    expect((await t.http.post(m('/promotions')).set(auth(tenant.owner)).send({ code: 'SAVE15', name: 'Dup', kind: 'fixed', value: 100 })).status).toBe(409);
    const up = await t.http.patch(m(`/promotions/${p.body.id}`)).set(auth(tenant.owner)).send({ isActive: false });
    expect(up.body.isActive).toBe(false);
    expect((await t.http.get(m('/promotions')).set(auth(tenant.owner))).body.items.map((x: any) => x.code)).toContain('SAVE15');
    expect((await t.http.delete(m(`/promotions/${p.body.id}`)).set(auth(tenant.owner))).body).toMatchObject({ deleted: true });
  });
});

describe('campaigns', () => {
  let segmentId: string;
  beforeAll(async () => {
    segmentId = (await t.http.post(m('/segments')).set(auth(tenant.owner)).send({ name: 'Everyone who ordered', definition: { op: 'and', rules: [{ type: 'orders_gte', count: 1 }] } })).body.id;
  });

  it('requires approval, filters by consent and labels sandbox delivery', async () => {
    const c = await t.http.post(m('/campaigns')).set(auth(tenant.owner)).send({ name: 'Weekend offer', channel: 'whatsapp', segmentId, content: { text: 'This weekend only: free fries!' } });
    expect(c.status).toBe(201);
    expect(c.body).toMatchObject({ status: 'draft', isSandbox: true });
    const early = await t.http.post(m(`/campaigns/${c.body.id}/send`)).set(auth(tenant.owner));
    expect(early.status).toBe(409);
    expect(early.body.error.code).toBe('campaign_not_approved');
    expect((await t.http.post(m(`/campaigns/${c.body.id}/submit`)).set(auth(tenant.owner))).body.status).toBe('pending_approval');
    expect((await t.http.post(m(`/campaigns/${c.body.id}/send`)).set(auth(tenant.owner))).status).toBe(409);
    const cashier = await addMember(t, tenant, 'cashier');
    expect((await t.http.post(m(`/campaigns/${c.body.id}/approve`)).set(auth(cashier))).status).toBe(403);
    const approved = await t.http.post(m(`/campaigns/${c.body.id}/approve`)).set(auth(tenant.owner));
    expect(approved.body).toMatchObject({ status: 'approved', approvedBy: tenant.owner.userId });
    expect((await t.http.patch(m(`/campaigns/${c.body.id}`)).set(auth(tenant.owner)).send({ name: 'Changed' })).body.error.code).toBe('campaign_not_editable');

    const sent = await t.http.post(m(`/campaigns/${c.body.id}/send`)).set(auth(tenant.owner));
    expect(sent.status).toBe(200);
    expect(sent.body).toMatchObject({ status: 'sent', isSandbox: true, delivery: { recipients: 3, queued: 1, skippedNoConsent: 1, failed: 1, sandbox: 1, live: 0 } });
    const deliveries = (await t.http.get(m(`/campaigns/${c.body.id}/deliveries`)).set(auth(tenant.owner))).body.items;
    const by = Object.fromEntries(deliveries.map((d: any) => [d.customerId, d]));
    expect(by[ids.a]).toMatchObject({ status: 'delivered' });
    expect(by[ids.b]).toMatchObject({ status: 'skipped_no_consent' }); // has a conversation but no consent
    expect(by[ids.c]).toMatchObject({ status: 'failed', error: 'no_channel' });
    const [msg] = await sql(`select payload from messages where id = $1`, [by[ids.a].messageId]);
    expect(msg.payload).toMatchObject({ sandbox: true, reason: `campaign:${c.body.id}`, body: 'This weekend only: free fries!' });
    expect((await sql(`select count(*)::int as n from messages m join conversations c on c.id = m.conversation_id
      where c.customer_id = $1 and m.payload->>'reason' like 'campaign:%'`, [ids.b]))[0].n).toBe(0);
    const report = (await t.http.get(m(`/campaigns/${c.body.id}/report`)).set(auth(tenant.owner))).body;
    expect(report).toMatchObject({ model: 'last_touch', isSandbox: true, messages: { sent: 1, skippedNoConsent: 1, failed: 1 }, costMinor: 0, roas: null });
    expect(report.disclaimer).toMatch(/not incremental/);
    expect((await t.http.post(m(`/campaigns/${c.body.id}/send`)).set(auth(tenant.owner))).status).toBe(409); // never twice
  });

  it('schedules approved campaigns and the dispatcher sends them when due', async () => {
    const c = (await t.http.post(m('/campaigns')).set(auth(tenant.owner)).send({ name: 'Later', channel: 'whatsapp', segmentId, content: { text: 'Hello later' } })).body;
    await t.http.post(m(`/campaigns/${c.id}/submit`)).set(auth(tenant.owner)).expect(200);
    await t.http.post(m(`/campaigns/${c.id}/approve`)).set(auth(tenant.owner)).expect(200);
    expect((await t.http.post(m(`/campaigns/${c.id}/schedule`)).set(auth(tenant.owner)).send({ scheduledAt: '2020-01-01T00:00:00Z' })).status).toBe(422);
    const s = await t.http.post(m(`/campaigns/${c.id}/schedule`)).set(auth(tenant.owner)).send({ scheduledAt: new Date(Date.now() + 3600_000).toISOString() });
    expect(s.body.status).toBe('scheduled');
    await sql(`update campaigns set scheduled_at = now() - interval '1 minute' where id = $1`, [c.id]);
    await t.app.get(CampaignsService).dispatchDue();
    expect((await t.http.get(m(`/campaigns/${c.id}`)).set(auth(tenant.owner))).body.status).toBe('sent');
  });

  it('CAMPAIGNS_PORT creates drafts that never send', async () => {
    const port = t.app.get<CampaignsPort>(CAMPAIGNS_PORT);
    const ctx = TenantContext.system(tenant.orgId, 'mcp-test', 'mcp');
    const d = await db.withTenant(tenant.orgId, (tx) => port.createDraft(tx, ctx, { name: 'From MCP', channel: 'whatsapp', segmentId, content: { text: 'x' }, source: 'mcp' }));
    expect(d.status).toBe('draft');
    expect((await sql(`select count(*)::int as n from campaign_deliveries where campaign_id = $1`, [d.id]))[0].n).toBe(0);
    expect((await sql(`select source from campaigns where id = $1`, [d.id]))[0].source).toBe('mcp');
  });

  it('CAMPAIGN_SEND_PORT (MCP after human approval) applies approval, consent and scheduling rules', async () => {
    const send = t.app.get<any>(Symbol.for('resuto.CAMPAIGN_SEND_PORT'));
    const mcpCtx = (role: 'marketing' | 'cashier') => new TenantContext(tenant.orgId, role, null, null, 'mcp_client', 'mcp-client-1', 'mcp');
    const mk = async (name: string) => (await t.http.post(m('/campaigns')).set(auth(tenant.owner)).send({ name, channel: 'whatsapp', segmentId, content: { text: `Hi from ${name}` } })).body.id as string;
    const id = await mk('MCP now');
    await expect(db.withTenant(tenant.orgId, (tx) => send.requestSend(tx, mcpCtx('cashier'), { campaignId: id, approvedBy: tenant.owner.userId, source: 'mcp' })))
      .rejects.toMatchObject({ code: 'forbidden' });
    const now = await db.withTenant(tenant.orgId, (tx) => send.requestSend(tx, mcpCtx('marketing'), { campaignId: id, approvedBy: tenant.owner.userId, source: 'mcp' }));
    expect(now).toEqual({ campaignId: id, status: 'sent', scheduledAt: null });
    const deliveries = await sql(`select customer_id, status from campaign_deliveries where campaign_id = $1`, [id]);
    expect(deliveries.find((d: any) => d.customer_id === ids.b).status).toBe('skipped_no_consent');
    expect((await sql(`select approved_by, is_sandbox from campaigns where id = $1`, [id]))[0]).toEqual({ approved_by: tenant.owner.userId, is_sandbox: true });
    expect((await sql(`select count(*)::int as n from audit_logs where entity_id = $1 and action = 'marketing.campaign_send_requested'`, [id]))[0].n).toBe(1);
    await expect(db.withTenant(tenant.orgId, (tx) => send.requestSend(tx, mcpCtx('marketing'), { campaignId: id, approvedBy: null, source: 'mcp' })))
      .rejects.toMatchObject({ code: 'invalid_campaign_transition' });
    const later = await mk('MCP later');
    const at = new Date(Date.now() + 7200_000).toISOString();
    const sched = await db.withTenant(tenant.orgId, (tx) => send.requestSend(tx, mcpCtx('marketing'), { campaignId: later, scheduledAt: at, approvedBy: tenant.owner.userId, source: 'mcp' }));
    expect(sched).toEqual({ campaignId: later, status: 'scheduled', scheduledAt: at });
    const other = await createTenant(t);
    await expect(db.withTenant(other.orgId, (tx) => send.requestSend(tx, new TenantContext(other.orgId, 'marketing', null, null, 'mcp_client', 'x', 'mcp'), { campaignId: later, approvedBy: null, source: 'mcp' })))
      .rejects.toMatchObject({ code: 'not_found' });
  });

  it('launches ad campaigns only when approved and connected; sandbox rows never count as cost', async () => {
    const make = async (name: string) => {
      const c = (await t.http.post(m('/campaigns')).set(auth(tenant.owner)).send({ name, channel: 'meta_ads', objective: 'acquisition', budgetMinor: 50000 })).body;
      return c.id as string;
    };
    const id = await make('Meta sandbox');
    expect((await t.http.post(m(`/campaigns/${id}/launch`)).set(auth(tenant.owner))).body.error.code).toBe('campaign_not_approved');
    await t.http.post(m(`/campaigns/${id}/submit`)).set(auth(tenant.owner)).expect(200);
    await t.http.post(m(`/campaigns/${id}/approve`)).set(auth(tenant.owner)).expect(200);
    const none = await t.http.post(m(`/campaigns/${id}/launch`)).set(auth(tenant.owner));
    expect(none.status).toBe(409);
    expect(none.body.error.code).toBe('ad_account_required');
    await t.http.post(`/v1/o/${tenant.orgId}/integrations/connections`).set(auth(tenant.owner)).send({ provider: 'ads_sandbox' }).expect(201);
    // INT-14: the sandbox is used only when asked for explicitly (it used to be a silent fallback).
    const launched = await t.http.post(m(`/campaigns/${id}/launch`)).set(auth(tenant.owner)).send({ mode: 'sandbox' });
    expect(launched.body).toMatchObject({ status: 'sent', isSandbox: true });
    expect(launched.body.externalCampaignId).toMatch(/^sandbox_/);
    expect(launched.body.note).toMatch(/nothing was published/);
    const ins = await t.http.post(m(`/campaigns/${id}/insights/sync`)).set(auth(tenant.owner)).send({ since: '2026-10-01', until: '2026-10-03' });
    expect(ins.body).toEqual({ imported: 3, sandbox: true });
    const rep = (await t.http.get(m(`/campaigns/${id}/report`)).set(auth(tenant.owner))).body;
    expect(rep).toMatchObject({ costMinor: 0, sandboxRowsExcluded: 3, roas: null, isSandbox: true });
    expect(rep.adReports.every((r: any) => r.isSandbox && r.spendMinor === 0)).toBe(true);

    // A live, verified Meta ad account takes precedence over the sandbox.
    const http = t.app.get(ProviderHttp);
    const original = http.fetch;
    try {
      const conn = (await t.http.post(`/v1/o/${tenant.orgId}/integrations/connections`).set(auth(tenant.owner))
        .send({ provider: 'meta_ads', environment: 'live', credentials: { accessToken: 'EAAB-meta-live-token' }, config: { adAccountId: '1234567890' } })).body;
      // Not yet health-checked → still not "connected": a live launch would be refused (never sent to the sandbox).
      http.fetch = scriptedFetch([{ body: { id: 'act_1234567890', name: 'Resto', currency: 'EGP', account_status: 1 } }]).fetch;
      expect((await t.http.post(`/v1/o/${tenant.orgId}/integrations/connections/${conn.id}/health`).set(auth(tenant.owner))).body.status).toBe('connected');
      const liveId = await make('Meta live');
      await t.http.post(m(`/campaigns/${liveId}/submit`)).set(auth(tenant.owner)).expect(200);
      await t.http.post(m(`/campaigns/${liveId}/approve`)).set(auth(tenant.owner)).expect(200);
      const f = scriptedFetch([{ body: { id: '120210000000777' } }]);
      http.fetch = f.fetch;
      const live = await t.http.post(m(`/campaigns/${liveId}/launch`)).set(auth(tenant.owner));
      expect(live.body).toMatchObject({ isSandbox: false, externalCampaignId: '120210000000777' });
      expect(f.calls[0]!.url).toBe('https://graph.facebook.com/v26.0/act_1234567890/campaigns');
      http.fetch = scriptedFetch([{ body: { data: [{ campaign_id: '120210000000777', impressions: '1000', clicks: '40', spend: '200.00', date_start: '2026-10-01' }] } }]).fetch;
      await t.http.post(m(`/campaigns/${liveId}/insights/sync`)).set(auth(tenant.owner)).send({ since: '2026-10-01', until: '2026-10-01' }).expect(200);
      expect((await t.http.get(m(`/campaigns/${liveId}/report`)).set(auth(tenant.owner))).body).toMatchObject({ costMinor: 20000, sandboxRowsExcluded: 0, revenueMinor: 0, roas: 0 });
    } finally {
      http.fetch = original;
    }
  });
});

describe('tracking links and attribution', () => {
  it('counts clicks, returns utm destinations and attributes orders (last touch)', async () => {
    const c = (await t.http.post(m('/campaigns')).set(auth(tenant.owner)).send({ name: 'Instagram bio', channel: 'organic', objective: 'acquisition' })).body;
    expect((await t.http.post(m('/links')).set(auth(tenant.owner)).send({ destinationPath: '//evil.example.com' })).status).toBe(400);
    expect((await t.http.post(m('/links')).set(auth(tenant.owner)).send({ destinationPath: 'https://evil.example.com' })).status).toBe(400);
    const link = await t.http.post(m('/links')).set(auth(tenant.owner)).send({ campaignId: c.id, destinationPath: `/order/${tenant.slug}?menu=1`, utm: { content: 'bio' } });
    expect(link.status).toBe(201);
    expect(link.body.shortUrl).toBe(`http://app.test/l/${link.body.code}`);
    const click = await t.http.get(`/v1/public/l/${link.body.code}`);
    expect(click.status).toBe(200);
    const dest = new URL(click.body.destination, 'http://app.test');
    expect(dest.pathname).toBe(`/order/${tenant.slug}`);
    expect(Object.fromEntries(dest.searchParams)).toMatchObject({ menu: '1', utm_source: 'resuto', utm_medium: 'organic', utm_campaign: c.utmCampaign, utm_content: 'bio', rcid: c.id });
    const sessionKey = dest.searchParams.get('rsid')!;
    expect(sessionKey).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
    expect((await t.http.get(`/v1/public/l/nope!!`)).status).toBe(404);
    expect((await t.http.get(`/v1/public/l/ZZZZZZZZ`)).status).toBe(404);
    expect((await sql(`select click_count from tracking_links where id = $1`, [link.body.id]))[0].click_count).toBe(1);
    expect((await sql(`select count(*)::int as n from attribution_events where campaign_id = $1 and kind = 'link_click' and session_key = $2`, [c.id, sessionKey]))[0].n).toBe(1);

    // The hosted ordering page forwards rcid/rsid/utm into the order's attribution.
    const { token } = await walkToMenu(t, tenant, channelId, '+201000000199');
    const v = (await t.http.get(`/v1/public/connect/ordering/${token}`)).body;
    const cart = await t.http.post(`/v1/public/connect/ordering/${token}/cart`).send({ version: v.version, lines: [{ productId: menu.products.soda, quantity: 2 }] });
    const done = await t.http.post(`/v1/public/connect/ordering/${token}/checkout`).send({ version: cart.body.version, paymentMethod: 'cod', expectedTotalMinor: 5000,
      attribution: { campaignId: c.id, sessionKey, utm_source: 'resuto', utm_campaign: c.utmCampaign } });
    expect(done.status).toBe(201);
    const [order] = await sql(`select campaign_id, attribution from orders where id = $1`, [done.body.order.id]);
    expect(order.campaign_id).toBe(c.id);
    expect(order.attribution).toMatchObject({ session_key: sessionKey, utm_campaign: c.utmCampaign });
    // Cash collected (staff/driver path) → paid → order_paid attribution.
    const ledger = t.app.get(PaymentLedgerService);
    const ctx = new TenantContext(tenant.orgId, 'owner', null, tenant.owner.userId, 'user', tenant.owner.userId);
    await db.scoped(ctx, (tx) => ledger.recordSucceeded(tx, ctx, { branchId: tenant.branchId, orderId: done.body.order.id, method: 'cash', provider: 'manual', amountMinor: 5000, currency: 'EGP' }));
    await t.app.get(EventDispatcher).drain();
    expect((await sql(`select count(*)::int as n from attribution_events where order_id = $1 and kind = 'order_paid'`, [done.body.order.id]))[0].n).toBe(1);
    const report = (await t.http.get(m(`/campaigns/${c.id}/report`)).set(auth(tenant.owner))).body;
    expect(report).toMatchObject({ clicks: 1, orders: 1, revenueMinor: 5000, orderValueMinor: 5000, costMinor: 0, roas: null });
  });
});

describe('recommendations', () => {
  it('returns deterministic evidence and creates a draft in one click', async () => {
    const recs = (await t.http.get(m('/recommendations')).set(auth(tenant.owner))).body;
    const reactivation = recs.items.find((r: any) => r.key === 'reactivation_inactive_30');
    expect(reactivation.evidence).toMatchObject({ matchingCustomers: 1, method: 'deterministic_rule' });
    expect(reactivation.rationale).toMatch(/^1 customer/);
    const applied = await t.http.post(m('/recommendations/reactivation_inactive_30/apply')).set(auth(tenant.owner));
    expect(applied.status).toBe(201);
    expect(applied.body).toMatchObject({ memberCount: 1, campaign: { status: 'draft', source: 'ai', channel: 'whatsapp', objective: 'reactivation' } });
    expect(applied.body.campaign.content.recommendation.generatedBy).toBe('deterministic_rules');
    expect((await t.http.post(m('/recommendations/unknown_rule/apply')).set(auth(tenant.owner))).status).toBe(404);
  });
});

describe('marketing access control', () => {
  it('enforces permissions, tenant isolation and the module entitlement', async () => {
    const waiter = await addMember(t, tenant, 'waiter');
    expect((await t.http.get(m('/campaigns')).set(auth(waiter))).status).toBe(403);
    const marketer = await addMember(t, tenant, 'marketing');
    expect((await t.http.get(m('/campaigns')).set(auth(marketer))).status).toBe(200);
    const other = await createTenant(t);
    const someCampaign = (await t.http.get(m('/campaigns')).set(auth(tenant.owner))).body.items[0].id;
    expect((await t.http.get(`/v1/o/${other.orgId}/marketing/campaigns/${someCampaign}`).set(auth(other.owner))).status).toBe(404);
    expect((await t.http.get(m(`/campaigns/${someCampaign}`)).set(auth(other.owner))).status).toBe(404);
    const free = await createTenant(t, { planId: 'free' });
    const denied = await t.http.get(`/v1/o/${free.orgId}/marketing/segments`).set(auth(free.owner));
    expect(denied.status).toBe(402);
    expect(denied.body.error.code).toBe('module_not_entitled');
    expect((await t.http.post(m('/campaigns')).set(auth(tenant.owner)).send({ name: '', channel: 'fax' })).status).toBe(400);
  });
});
