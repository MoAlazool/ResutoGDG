import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EventDispatcher } from '../src/common/events/dispatcher.service';
import type { OutboxEvent } from '../src/common/events/events';
import type { EmailProvider } from '../src/modules/notifications/email.provider';
import { NotificationsHandlers } from '../src/modules/notifications/notifications.handlers';
import { NotificationsService } from '../src/modules/notifications/notifications.service';
import { addMember, auth, bootTestApp, createTenant, sql, type TestApp, type TestTenant, type TestUser } from './helpers';

let t: TestApp;
let A: TestTenant;
let B: TestTenant;
let kitchen: TestUser;
let cashier: TestUser;
let dispatcher: EventDispatcher;
const N = (tt: TestTenant, path = '') => `/v1/o/${tt.orgId}/notifications${path}`;
const list = async (tt: TestTenant, who: TestUser) => (await t.http.get(N(tt)).set(auth(who))).body;
const drain = async () => {
  await dispatcher.drain();
};

beforeAll(async () => {
  t = await bootTestApp();
  dispatcher = t.app.get(EventDispatcher);
  A = await createTenant(t, { country: 'SA', name: 'Riyadh Grill' });
  B = await createTenant(t, { country: 'EG' });
  kitchen = await addMember(t, A, 'kitchen');
  cashier = await addMember(t, A, 'cashier');
  await drain();
});
afterAll(async () => { await t.close(); });

describe('notification centre (FT-06)', () => {
  it('turns stock.low into one notification for people who can see inventory, idempotently', async () => {
    const inv = `/v1/o/${A.orgId}/inventory`;
    const item = await t.http.post(`${inv}/items`).set(auth(A.owner)).send({ name: 'Burrata', nameAr: 'بوراتا', unit: 'pcs', costPerUnitMinor: 500, reorderLevel: 5 });
    expect(item.status).toBe(201);
    const move = (body: object) => t.http.post(`${inv}/movements`).set(auth(A.owner)).send({ branchId: A.branchId, itemId: item.body.id, ...body });
    expect((await move({ kind: 'purchase', quantity: 10, unitCostMinor: 500 })).status).toBe(201);
    expect((await move({ kind: 'waste', quantity: 8, reason: 'spoiled' })).status).toBe(201);
    await drain();

    const owner = await list(A, A.owner);
    const stock = owner.items.filter((n: any) => n.kind === 'stock_low');
    expect(stock).toHaveLength(1);
    expect(stock[0]).toMatchObject({ templateKey: 'stock_low', severity: 'warning', link: '/inventory', readAt: null, branchId: A.branchId,
      params: { item: 'Burrata', itemAr: 'بوراتا', quantity: 2, reorderLevel: 5, unit: 'pcs' } });
    // Email is attempted and honestly recorded as not configured (no provider) — never "sent".
    expect(stock[0].deliveries).toEqual([expect.objectContaining({ channel: 'email', status: 'not_configured' })]);
    // The kitchen (inventory:read) sees it; a cashier does not.
    expect((await list(A, kitchen)).items.some((n: any) => n.kind === 'stock_low')).toBe(true);
    expect((await list(A, cashier)).items.some((n: any) => n.kind === 'stock_low')).toBe(false);

    // A redelivered event changes nothing.
    const [ev] = await sql(`select id, org_id, event_type, aggregate_type, aggregate_id, payload, created_at from outbox_events
                             where org_id = $1 and event_type = 'stock.low' order by created_at desc limit 1`, [A.orgId]);
    await t.app.get(NotificationsHandlers).onStockLow({ id: ev.id, orgId: ev.org_id, type: ev.event_type, aggregateType: ev.aggregate_type,
      aggregateId: ev.aggregate_id, payload: ev.payload, createdAt: ev.created_at } as OutboxEvent);
    expect(await sql(`select 1 from notifications where org_id = $1 and kind = 'stock_low'`, [A.orgId])).toHaveLength(1);
    expect(await sql(`select 1 from notification_deliveries d join notifications n on n.id = d.notification_id where n.org_id = $1 and n.kind = 'stock_low'`, [A.orgId])).toHaveLength(1);
  });

  it('tracks read state per user (bell count, mark one, mark all) and hides other tenants', async () => {
    const before = (await t.http.get(N(A, '/unread-count')).set(auth(A.owner))).body.unread;
    expect(before).toBeGreaterThanOrEqual(1);
    const { items } = await list(A, A.owner);
    const read = await t.http.post(N(A, `/${items[0].id}/read`)).set(auth(A.owner));
    expect(read.status).toBe(200);
    expect(read.body.unread).toBe(before - 1);
    // Reading is per person: the kitchen user still has it unread.
    const k = await list(A, kitchen);
    expect(k.items.find((n: any) => n.id === items[0].id)?.readAt ?? null).toBeNull();
    expect((await t.http.get(N(A)).query({ unread: 'true' }).set(auth(A.owner))).body.items.some((n: any) => n.id === items[0].id)).toBe(false);
    await t.http.post(N(A, '/read-all')).set(auth(A.owner));
    expect((await t.http.get(N(A, '/unread-count')).set(auth(A.owner))).body.unread).toBe(0);
    // Another tenant cannot see or mark it; a cashier cannot mark one not addressed to them.
    expect((await t.http.post(`/v1/o/${B.orgId}/notifications/${items[0].id}/read`).set(auth(B.owner))).status).toBe(404);
    expect((await t.http.get(N(A)).set(auth(B.owner))).status).toBe(404);
    const stockId = items.find((n: any) => n.kind === 'stock_low').id;
    expect((await t.http.post(N(A, `/${stockId}/read`)).set(auth(cashier))).status).toBe(404);
  });

  it('notifies the team managers when someone is invited (email masked)', async () => {
    const inv = await t.http.post(`/v1/o/${A.orgId}/invitations`).set(auth(A.owner)).send({ email: 'new.waiter@example.test', role: 'waiter' });
    expect(inv.status).toBe(201);
    await drain();
    const n = (await list(A, A.owner)).items.find((x: any) => x.kind === 'member_invited' && x.params.role === 'waiter');
    expect(n).toMatchObject({ templateKey: 'member_invited', link: '/team', params: { email: 'n***@example.test' } });
    expect((await list(A, kitchen)).items.some((x: any) => x.kind === 'member_invited')).toBe(false);
  });

  it('licence reminders: raised in the centre, "sent" only when an email provider accepted them', async () => {
    const [{ soon }] = await sql(`select ((now() at time zone 'Asia/Riyadh')::date + 5)::text as soon`);
    const doc = await t.http.post(`/v1/o/${A.orgId}/compliance/documents`).set(auth(A.owner))
      .send({ kind: 'municipal_license', title: 'Balady licence', expiresOn: soon });
    expect(doc.status).toBe(201);
    await dispatcher.runDueJobs(Date.now(), true);
    await drain();
    const reminder = async () => (await sql(`select status from compliance_reminders where document_id = $1 and days_before = 7`, [doc.body.id]))[0].status;
    expect(await reminder()).toBe('raised');
    const n = (await list(A, A.owner)).items.find((x: any) => x.kind === 'licence_expiring');
    expect(n).toMatchObject({ severity: 'critical', link: '/compliance', params: { title: 'Balady licence', daysLeft: 5, expiresOn: soon } });
    expect(n.deliveries[0].status).toBe('not_configured');
    expect((await list(A, cashier)).items.some((x: any) => x.kind === 'licence_expiring')).toBe(false);

    // With a provider that accepts the message, the delivery and the reminder become 'sent'.
    const svc = t.app.get(NotificationsService) as any;
    const original = svc.email;
    const sent: string[] = [];
    svc.email = { name: 'test', configured: true, async send(m: { to: string }) { sent.push(m.to); return { messageId: `m-${sent.length}` }; } } satisfies EmailProvider;
    try {
      const doc2 = await t.http.post(`/v1/o/${A.orgId}/compliance/documents`).set(auth(A.owner))
        .send({ kind: 'health_certificate', title: 'Health certificate', expiresOn: soon });
      await dispatcher.runDueJobs(Date.now(), true);
      await drain();
      expect((await sql(`select status from compliance_reminders where document_id = $1 and days_before = 7`, [doc2.body.id]))[0].status).toBe('sent');
      expect(sent).toContain(A.owner.email);
      const n2 = (await list(A, A.owner)).items.find((x: any) => x.kind === 'licence_expiring' && x.params.title === 'Health certificate');
      expect(n2.deliveries[0]).toMatchObject({ status: 'sent', recipientHint: expect.stringMatching(/^o\*\*\*@example\.test/) });

      // A provider failure is recorded as failed and the reminder stays 'raised'.
      svc.email = { name: 'test', configured: true, async send() { throw new Error('smtp 451'); } } satisfies EmailProvider;
      const doc3 = await t.http.post(`/v1/o/${A.orgId}/compliance/documents`).set(auth(A.owner))
        .send({ kind: 'civil_defense', title: 'Civil defense', expiresOn: soon });
      await dispatcher.runDueJobs(Date.now(), true);
      await drain();
      expect((await sql(`select status from compliance_reminders where document_id = $1 and days_before = 7`, [doc3.body.id]))[0].status).toBe('raised');
      const n3 = (await list(A, A.owner)).items.find((x: any) => x.params.title === 'Civil defense');
      expect(n3.deliveries[0]).toMatchObject({ status: 'failed' });
    } finally {
      svc.email = original;
    }
  });

  it('MCP approval requests reach people who can approve', async () => {
    const h = t.app.get(NotificationsHandlers);
    const approvalId = '00000000-0000-4000-8000-000000000123';
    const ev = { id: '00000000-0000-4000-8000-000000000999', orgId: A.orgId, type: 'mcp.approval_requested', aggregateType: 'mcp_approval',
      aggregateId: approvalId, payload: { tool: 'request_campaign_send', clientId: 'c' }, createdAt: new Date().toISOString() } as OutboxEvent;
    await h.onMcpApproval(ev);
    await h.onMcpApproval(ev);
    const n = (await list(A, A.owner)).items.filter((x: any) => x.kind === 'mcp_approval_requested');
    expect(n).toHaveLength(1);
    expect(n[0]).toMatchObject({ link: '/mcp/approvals', params: { tool: 'request_campaign_send', toolTitle: 'Request campaign send', toolTitleAr: 'طلب إرسال حملة' } });
    expect((await list(A, kitchen)).items.some((x: any) => x.kind === 'mcp_approval_requested')).toBe(false);
  });

  it('turns each open payment alert into one notification for reconcilers', async () => {
    await sql(`insert into payment_alerts(org_id, branch_id, kind, provider, details) values ($1, $2, 'amount_mismatch', 'paymob', '{}')`, [A.orgId, A.branchId]);
    const h = t.app.get(NotificationsHandlers);
    const first = await h.scanPaymentAlerts();
    expect(first.raised).toBeGreaterThanOrEqual(1);
    expect((await h.scanPaymentAlerts()).raised).toBe(0);
    const n = (await list(A, A.owner)).items.filter((x: any) => x.kind === 'payment_alert');
    expect(n).toHaveLength(1);
    expect(n[0]).toMatchObject({ severity: 'critical', params: { alertKind: 'amount_mismatch', provider: 'paymob' } });
    expect((await list(A, cashier)).items.some((x: any) => x.kind === 'payment_alert')).toBe(false);
    expect((await list(B, B.owner)).items.some((x: any) => x.kind === 'payment_alert')).toBe(false);
  });

  it('respects branch scope', async () => {
    const [b2] = await sql(`insert into branches(org_id, name, code) values ($1, 'Second', 'second') returning id`, [A.orgId]);
    const scoped = await addMember(t, A, 'manager', [b2.id]);
    await sql(`insert into notifications(org_id, branch_id, audience_permission, kind, severity, template_key, params, dedupe_key)
               values ($1, $2, 'inventory:read', 'stock_low', 'warning', 'stock_low', '{"item":"Main only"}', 'test:main-only')`, [A.orgId, A.branchId]);
    expect((await list(A, scoped)).items.some((x: any) => x.params.item === 'Main only')).toBe(false);
    expect((await list(A, A.owner)).items.some((x: any) => x.params.item === 'Main only')).toBe(true);
  });
});
