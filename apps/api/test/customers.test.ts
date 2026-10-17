import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addMember, auth, bootTestApp, createTenant, seedMenu, sql, testDb, type SeededMenu, type TestApp, type TestTenant, type TestUser } from './helpers';
import { addBranch, placeOrder } from './insights-fixtures';

let t: TestApp;
let tenant: TestTenant;
let menu: SeededMenu;
let base: string;
let mona: string;
let omar: string;
let sara: string;
let northBranch: string;
let zed: string;

const fries = (quantity = 1) => [{ productId: menu.products.fries, quantity }];

beforeAll(async () => {
  t = await bootTestApp();
  tenant = await createTenant(t, { country: 'EG' });
  menu = await seedMenu(tenant);
  base = `/v1/o/${tenant.orgId}/customers`;
  northBranch = await addBranch(t, tenant, 'North');
  // Mona: two orders (consented on the first), Omar: one, Sara: email only, one cancelled order.
  mona = (await placeOrder(t, tenant, { channel: 'web', fulfillment: 'pickup', lines: fries(2), customer: { name: 'Mona Adel', phone: '+201001111111', marketingConsent: true } })).customerId!;
  await placeOrder(t, tenant, { channel: 'qr', fulfillment: 'dine_in', tableId: menu.tableId, lines: fries(1), customer: { phone: '+201001111111' } });
  omar = (await placeOrder(t, tenant, { channel: 'whatsapp', fulfillment: 'pickup', lines: fries(1), customer: { name: 'Omar Farouk', phone: '+201002222222' } })).customerId!;
  const s = await placeOrder(t, tenant, { channel: 'web', fulfillment: 'pickup', lines: fries(3), customer: { name: 'Sara N', email: 'Sara@Example.test' } });
  sara = s.customerId!;
  const cancelled = await placeOrder(t, tenant, { channel: 'web', fulfillment: 'pickup', lines: fries(5), customer: { email: 'sara@example.test' } });
  const { DbService } = await import('../src/common/db/db.service');
  const { OrdersKernelService } = await import('../src/modules/kernel/orders-kernel.service');
  const { ownerCtx } = await import('./insights-fixtures');
  const ctx = ownerCtx(tenant);
  await t.app.get(DbService).scoped(ctx, (tx) => t.app.get(OrdersKernelService).transition(tx, ctx, cancelled.id, 'cancelled', { reason: 'test' }));
  zed = (await placeOrder(t, tenant, { branchId: northBranch, channel: 'web', fulfillment: 'pickup', lines: fries(1), customer: { name: 'Zed North', phone: '+201009999999' } })).customerId!;
});
afterAll(async () => { await t.close(); });

const owner = () => auth(tenant.owner);
const names = (res: any) => res.body.items.map((c: any) => c.displayName);

describe('CRM list', () => {
  it('computes totals from orders and searches by name, phone and email', async () => {
    const all = await t.http.get(base).set(owner());
    expect(all.status).toBe(200);
    expect(all.body.total).toBe(4);
    const m = all.body.items.find((c: any) => c.id === mona);
    expect(m).toMatchObject({ orderCount: 2, totalSpendMinor: 3 * 4500, marketingConsent: true, marketingConsentSource: 'web' });
    // The cancelled order is not customer value.
    expect(all.body.items.find((c: any) => c.id === sara)).toMatchObject({ orderCount: 1, totalSpendMinor: 3 * 4500, email: 'sara@example.test' });
    expect(names(await t.http.get(`${base}?q=mon`).set(owner()))).toEqual(['Mona Adel']);
    expect(names(await t.http.get(`${base}?q=2222`).set(owner()))).toEqual(['Omar Farouk']);
    expect(names(await t.http.get(`${base}?q=example.test`).set(owner()))).toEqual(['Sara N']);
  });

  it('filters by consent, order count, spend, branch, last order date and tag', async () => {
    expect(names(await t.http.get(`${base}?consent=granted`).set(owner()))).toEqual(['Mona Adel']);
    expect(names(await t.http.get(`${base}?minOrders=2`).set(owner()))).toEqual(['Mona Adel']);
    expect(names(await t.http.get(`${base}?minSpendMinor=13500&sort=name`).set(owner()))).toEqual(['Mona Adel', 'Sara N']);
    expect(names(await t.http.get(`${base}?branchId=${northBranch}`).set(owner()))).toEqual(['Zed North']);
    expect((await t.http.get(`${base}?lastOrderBefore=2020-01-01`).set(owner())).body.items).toEqual([]);
    expect((await t.http.get(`${base}?lastOrderAfter=2020-01-01`).set(owner())).body.total).toBe(4);
    const tagged = await t.http.patch(`${base}/${omar}`).set(owner()).send({ tags: ['VIP', 'vip', 'late-night'], notes: 'Prefers extra lemon' });
    expect(tagged.status).toBe(200);
    expect(tagged.body.tags).toEqual(['vip', 'late-night']);
    expect(names(await t.http.get(`${base}?tag=vip`).set(owner()))).toEqual(['Omar Farouk']);
    const bad = await t.http.get(`${base}?minOrders=-1`).set(owner());
    expect(bad.status).toBe(400);
    const page = await t.http.get(`${base}?limit=2&sort=name`).set(owner());
    expect(page.body.nextCursor).toBe('2');
    const page2 = await t.http.get(`${base}?limit=2&sort=name&cursor=2`).set(owner());
    expect(names(page2)).toEqual(['Sara N', 'Zed North']);
  });
});

describe('profile and consent', () => {
  it('shows identities, order history, totals and consent history', async () => {
    const p = await t.http.get(`${base}/${mona}`).set(owner());
    expect(p.status).toBe(200);
    expect(p.body.identities.map((i: any) => i.kind)).toEqual(['phone']);
    expect(p.body.orders).toHaveLength(2);
    expect(p.body.totals).toMatchObject({ orderCount: 2, grossMinor: 13500, netMinor: 13500, averageOrderMinor: 6750, currency: 'EGP' });
    // Consent given while ordering online is recorded by the database trigger.
    expect(p.body.consentHistory).toHaveLength(1);
    expect(p.body.consentHistory[0]).toMatchObject({ granted: true, source: 'web' });
  });

  it('records explicit consent changes with source and never changes consent silently', async () => {
    const missing = await t.http.post(`${base}/${mona}/consent`).set(owner()).send({ granted: false });
    expect(missing.status).toBe(400);
    const revoke = await t.http.post(`${base}/${mona}/consent`).set(owner()).send({ granted: false, source: 'unsubscribe_request', note: 'Asked by phone' });
    expect(revoke.body).toMatchObject({ changed: true, marketingConsent: false });
    const again = await t.http.post(`${base}/${mona}/consent`).set(owner()).send({ granted: false, source: 'staff_verbal' });
    expect(again.body).toMatchObject({ changed: false });
    // Ordering again without ticking consent does not re-grant it.
    await placeOrder(t, tenant, { channel: 'web', fulfillment: 'pickup', lines: fries(1), customer: { phone: '+201001111111', marketingConsent: false } });
    const p = await t.http.get(`${base}/${mona}`).set(owner());
    expect(p.body.marketingConsent).toBe(false);
    expect(p.body.consentHistory.map((e: any) => [e.granted, e.source, e.note])).toEqual([
      [false, 'staff:unsubscribe_request', 'Asked by phone'],
      [true, 'web', null],
    ]);
    const audit = await sql(`select action, metadata from audit_logs where org_id = $1 and entity_id = $2 and action like 'customers.consent%'`, [tenant.orgId, mona]);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ action: 'customers.consent_revoked', metadata: { source: 'unsubscribe_request', previous: true } });
    // History is append-only for the application.
    const client = await testDb().connect();
    try {
      await client.query('begin');
      await client.query(`select set_config('app.org_id', $1, true)`, [tenant.orgId]);
      await client.query('set local role resuto_tenant');
      await expect(client.query(`update customer_consent_events set granted = true where customer_id = $1`, [mona])).rejects.toThrow(/append-only/);
    } finally {
      await client.query('rollback');
      client.release();
    }
  });
});

describe('export', () => {
  let manager: TestUser;
  let cashier: TestUser;
  beforeAll(async () => {
    manager = await addMember(t, tenant, 'manager');
    cashier = await addMember(t, tenant, 'cashier');
  });

  it('exports minimal-PII CSV for owners and audits it', async () => {
    const res = await t.http.get(`${base}/export.csv?sort=name`).set(owner());
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    const lines = res.text.replace(/^﻿/, '').trim().split('\r\n');
    expect(lines[0]).toBe('id,display_name,phone,email,marketing_consent,marketing_consent_at,marketing_consent_source,tags,order_count,total_spend_minor,last_order_at');
    expect(lines).toHaveLength(5);
    expect(lines[1]).toContain('Mona Adel,+201001111111,,false');
    expect(res.text).not.toContain('Prefers extra lemon'); // notes are never exported
    const audit = await sql(`select metadata from audit_logs where org_id = $1 and action = 'customers.exported'`, [tenant.orgId]);
    expect(audit).toHaveLength(1);
    expect(audit[0].metadata).toMatchObject({ rows: 4, truncated: false });
  });

  it('requires customers:export', async () => {
    expect((await t.http.get(`${base}/export.csv`).set(auth(manager))).status).toBe(403);
    expect((await t.http.get(base).set(auth(cashier))).status).toBe(200);
    expect((await t.http.get(`${base}/export.csv`).set(auth(cashier))).status).toBe(403);
    expect((await t.http.patch(`${base}/${omar}`).set(auth(cashier)).send({ notes: 'x' })).status).toBe(403);
  });

  it('neutralises spreadsheet formulas in free text', async () => {
    await t.http.patch(`${base}/${sara}`).set(owner()).send({ displayName: '=HYPERLINK("http://x")' });
    const res = await t.http.get(`${base}/export.csv?q=example.test`).set(owner());
    expect(res.text).toContain(`"'=HYPERLINK(""http://x"")"`);
    await t.http.patch(`${base}/${sara}`).set(owner()).send({ displayName: 'Sara N' });
  });
});

describe('anonymise', () => {
  it('replaces PII but keeps order aggregates, and is audited', async () => {
    const manager = await addMember(t, tenant, 'manager');
    expect((await t.http.post(`${base}/${omar}/anonymise`).set(auth(manager)).send({ confirm: true, reason: 'GDPR request' })).status).toBe(403);
    expect((await t.http.post(`${base}/${omar}/anonymise`).set(owner()).send({ reason: 'GDPR request' })).status).toBe(400);
    const res = await t.http.post(`${base}/${omar}/anonymise`).set(owner()).send({ confirm: true, reason: 'Guest asked to be forgotten' });
    expect(res.status).toBe(201);
    expect(res.body.ordersRetained).toBe(1);
    const p = await t.http.get(`${base}/${omar}`).set(owner());
    expect(p.body).toMatchObject({ displayName: null, phone: null, email: null, notes: null, tags: [], identities: [], marketingConsent: false });
    expect(p.body.anonymisedAt).toBeTruthy();
    expect(p.body.totals).toMatchObject({ orderCount: 1, grossMinor: 4500 });
    const [order] = await sql(`select customer_name, customer_phone, customer_id from orders where customer_id = $1`, [omar]);
    expect(order).toEqual({ customer_name: null, customer_phone: null, customer_id: omar });
    expect((await t.http.get(base).set(owner())).body.items.map((c: any) => c.id)).not.toContain(omar);
    expect((await t.http.get(`${base}?includeAnonymised=true`).set(owner())).body.items.map((c: any) => c.id)).toContain(omar);
    expect((await t.http.post(`${base}/${omar}/anonymise`).set(owner()).send({ confirm: true, reason: 'again' })).status).toBe(409);
    expect((await t.http.patch(`${base}/${omar}`).set(owner()).send({ notes: 'x' })).status).toBe(409);
    const [audit] = await sql(`select metadata from audit_logs where action = 'customers.anonymised' and entity_id = $1`, [omar]);
    expect(audit.metadata).toMatchObject({ reason: 'Guest asked to be forgotten', identitiesRemoved: 1, ordersRedacted: 1 });
    expect(JSON.stringify(audit.metadata)).not.toContain('2222222');
  });
});

describe('merge', () => {
  it('moves orders and identities to the surviving customer in one transaction', async () => {
    // A second profile for Mona created from an email-only web order.
    const dup = (await placeOrder(t, tenant, { channel: 'web', fulfillment: 'pickup', lines: fries(2), customer: { name: 'Mona A.', email: 'mona@example.test', marketingConsent: true } })).customerId!;
    expect(dup).not.toBe(mona);
    const before = await t.http.get(`${base}/${mona}`).set(owner());
    const res = await t.http.post(`${base}/${mona}/merge`).set(owner()).send({ duplicateId: dup });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ survivorId: mona, moved: { orders: 1, customer_identities: 1 }, consentConflict: true });
    const after = await t.http.get(`${base}/${mona}`).set(owner());
    expect(after.body.totals.orderCount).toBe(before.body.totals.orderCount + 1);
    expect(after.body).toMatchObject({ email: 'mona@example.test', phone: '+201001111111', displayName: 'Mona Adel' });
    // The survivor's consent is not changed by the merge.
    expect(after.body.marketingConsent).toBe(false);
    expect(after.body.identities.map((i: any) => i.kind).sort()).toEqual(['email', 'phone']);
    const gone = await t.http.get(`${base}/${dup}`).set(owner());
    expect(gone.status).toBe(409);
    expect(gone.body.error).toMatchObject({ code: 'customer_merged', details: { mergedIntoId: mona } });
    // Future orders by email resolve to the survivor.
    const next = await placeOrder(t, tenant, { channel: 'web', fulfillment: 'pickup', lines: fries(1), customer: { email: 'mona@example.test' } });
    expect(next.customerId).toBe(mona);
    expect((await t.http.post(`${base}/${mona}/merge`).set(owner()).send({ duplicateId: mona })).status).toBe(422);
    expect((await t.http.post(`${base}/${mona}/merge`).set(owner()).send({ duplicateId: dup })).status).toBe(409);
    const [audit] = await sql(`select metadata from audit_logs where action = 'customers.merged' and entity_id = $1`, [mona]);
    expect(audit.metadata).toMatchObject({ duplicateId: dup, consentConflict: true });
  });
});

describe('scope and isolation', () => {
  it('shows branch-scoped staff only customers of their branches', async () => {
    const northManager = await addMember(t, tenant, 'manager', [northBranch]);
    const list = await t.http.get(base).set(auth(northManager));
    expect(list.status).toBe(200);
    expect(list.body.items.map((c: any) => c.id)).toEqual([zed]);
    expect((await t.http.get(`${base}/${mona}`).set(auth(northManager))).status).toBe(404);
    expect((await t.http.get(`${base}/${zed}`).set(auth(northManager))).status).toBe(200);
    expect((await t.http.patch(`${base}/${mona}`).set(auth(northManager)).send({ notes: 'x' })).status).toBe(404);
  });

  it('hides other tenants behind 404', async () => {
    const other = await createTenant(t);
    expect((await t.http.get(base).set(auth(other.owner))).status).toBe(404);
    expect((await t.http.get(`/v1/o/${other.orgId}/customers/${mona}`).set(auth(other.owner))).status).toBe(404);
    expect((await t.http.post(`/v1/o/${other.orgId}/customers/${mona}/consent`).set(auth(other.owner)).send({ granted: true, source: 'other' })).status).toBe(404);
  });
});
