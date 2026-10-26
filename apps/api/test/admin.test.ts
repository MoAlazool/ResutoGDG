import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EntitlementsService } from '../src/common/entitlements/entitlements.service';
import { addMember, auth, bootTestApp, createTenant, signup, sql, unique, type TestApp, type TestUser } from './helpers';

let t: TestApp;
let entitlements: EntitlementsService;
let superadmin: TestUser;
let support: TestUser;
let finance: TestUser;
const insertedPriceIds: string[] = [];

async function platformAdmin(role: 'superadmin' | 'support' | 'finance') {
  const u = await signup(t, `pa-${role}`);
  await sql(`insert into platform_admins(user_id, role) values ($1, $2)`, [u.userId, role]);
  return u;
}

beforeAll(async () => {
  t = await bootTestApp();
  entitlements = t.app.get(EntitlementsService);
  superadmin = await platformAdmin('superadmin');
  support = await platformAdmin('support');
  finance = await platformAdmin('finance');
});
afterAll(async () => {
  // Test-only cleanup of the price rows this file inserted (the API itself never deletes history).
  if (insertedPriceIds.length) {
    await sql(`delete from plan_prices where id = any($1)`, [insertedPriceIds]);
    await sql(`delete from module_prices where id = any($1)`, [insertedPriceIds]);
  }
  await t.close();
});

const future = (days: number) => new Date(Date.now() + days * 864e5).toISOString();

describe('platform admin access', () => {
  it('rejects restaurant owners and anonymous callers', async () => {
    const tenant = await createTenant(t);
    expect((await t.http.get('/v1/admin/tenants')).status).toBe(401);
    expect((await t.http.get('/v1/admin/tenants').set(auth(tenant.owner))).status).toBe(403);
    expect((await t.http.get(`/v1/admin/tenants/${tenant.orgId}`).set(auth(tenant.owner))).status).toBe(403);
    expect((await t.http.post(`/v1/admin/tenants/${tenant.orgId}/suspend`).set(auth(tenant.owner)).send({ reason: 'nope' })).status).toBe(403);
    expect((await t.http.get('/v1/admin/me').set(auth(support))).body.role).toBe('support');
  });

  it('gives support read-only access without billing, finance billing reads, superadmin mutations', async () => {
    const tenant = await createTenant(t);
    const sDetail = await t.http.get(`/v1/admin/tenants/${tenant.orgId}`).set(auth(support));
    expect(sDetail.status).toBe(200);
    expect(sDetail.body).toMatchObject({ id: tenant.orgId, billingVisible: false, subscription: null, planId: 'pro' });
    expect((await t.http.get('/v1/admin/prices').set(auth(support))).status).toBe(403);
    expect((await t.http.post(`/v1/admin/tenants/${tenant.orgId}/suspend`).set(auth(support)).send({ reason: 'support tries' })).status).toBe(403);
    expect((await t.http.get('/v1/admin/operations').set(auth(support))).status).toBe(200);

    const fDetail = await t.http.get(`/v1/admin/tenants/${tenant.orgId}`).set(auth(finance));
    expect(fDetail.body.billingVisible).toBe(true);
    expect(fDetail.body.subscription).toMatchObject({ planId: 'pro', status: 'trialing' });
    expect((await t.http.get('/v1/admin/prices').set(auth(finance))).status).toBe(200);
    expect((await t.http.post('/v1/admin/prices/plans').set(auth(finance)).send({ planId: 'pro', country: 'EG', interval: 'month', amountMinor: 1 })).status).toBe(403);
    expect((await t.http.post(`/v1/admin/tenants/${tenant.orgId}/overrides`).set(auth(finance)).send({ module: 'mcp', reason: 'finance tries', expiresAt: future(1) })).status).toBe(403);
  });

  it('never returns integration credentials in tenant detail', async () => {
    const tenant = await createTenant(t);
    await sql(`insert into integration_connections(org_id, provider, category, auth_type, status, credentials_encrypted, credentials_hint, webhook_secret_hash)
               values ($1, 'paymob', 'payments', 'api_key', 'sandbox', 'v1:k:iv:tag:SECRET', 'pk_…42', 'hash-secret')`, [tenant.orgId]);
    const res = await t.http.get(`/v1/admin/tenants/${tenant.orgId}`).set(auth(superadmin));
    expect(res.body.integrations).toEqual([expect.objectContaining({ provider: 'paymob', status: 'sandbox', environment: 'sandbox' })]);
    expect(JSON.stringify(res.body)).not.toMatch(/SECRET|hash-secret|credentials/);
  });
});

describe('tenant administration', () => {
  it('searches and paginates tenants with summaries', async () => {
    const name = `Searchable ${unique('cafe')}`;
    const a = await createTenant(t, { name });
    const b = await createTenant(t, { name, country: 'SA', planId: 'free' });
    const res = await t.http.get(`/v1/admin/tenants?q=${encodeURIComponent(name)}`).set(auth(support));
    expect(res.status).toBe(200);
    expect(res.body.items.map((r: any) => r.id)).toEqual([b.orgId, a.orgId]);
    expect(res.body.items[0]).toMatchObject({ country: 'SA', planId: 'free', subscriptionStatus: 'active', counts: { branches: 1, members: 1, orders30d: 0 }, lastOrderAt: null });
    const page1 = await t.http.get(`/v1/admin/tenants?q=${encodeURIComponent(name)}&limit=1`).set(auth(support));
    expect(page1.body.items).toHaveLength(1);
    const page2 = await t.http.get(`/v1/admin/tenants?q=${encodeURIComponent(name)}&limit=1&cursor=${page1.body.nextCursor}`).set(auth(support));
    expect(page2.body.items.map((r: any) => r.id)).toEqual([a.orgId]);
    const filtered = await t.http.get(`/v1/admin/tenants?q=${encodeURIComponent(name)}&country=SA`).set(auth(support));
    expect(filtered.body.items.map((r: any) => r.id)).toEqual([b.orgId]);
    expect((await t.http.get('/v1/admin/tenants?limit=500').set(auth(support))).status).toBe(400);
  });

  it('suspends a restaurant so members get 404, and reactivates it, with an audit trail', async () => {
    const tenant = await createTenant(t);
    const waiter = await addMember(t, tenant, 'waiter');
    expect((await t.http.post(`/v1/admin/tenants/${tenant.orgId}/suspend`).set(auth(superadmin)).send({ reason: '' })).status).toBe(400);
    const s = await t.http.post(`/v1/admin/tenants/${tenant.orgId}/suspend`).set(auth(superadmin)).send({ reason: 'Chargeback investigation' });
    expect(s.status).toBe(200);
    expect(s.body.status).toBe('suspended');
    for (const u of [tenant.owner, waiter]) {
      const res = await t.http.get(`/v1/o/${tenant.orgId}`).set(auth(u));
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('not_found');
    }
    expect((await t.http.get(`/v1/o/${tenant.orgId}/billing/entitlements`).set(auth(tenant.owner))).status).toBe(404);
    expect((await t.http.post(`/v1/admin/tenants/${tenant.orgId}/suspend`).set(auth(superadmin)).send({ reason: 'again please' })).body.error.code).toBe('already_suspended');
    // Platform staff still see the tenant summary.
    expect((await t.http.get(`/v1/admin/tenants/${tenant.orgId}`).set(auth(support))).body.status).toBe('suspended');

    const r = await t.http.post(`/v1/admin/tenants/${tenant.orgId}/reactivate`).set(auth(superadmin)).send({ reason: 'Resolved with owner' });
    expect(r.body.status).toBe('onboarding');
    expect((await t.http.get(`/v1/o/${tenant.orgId}`).set(auth(waiter))).status).toBe(200);
    const audit = await sql(`select actor_type, actor_id, action, metadata from audit_logs where org_id = $1 and actor_type = 'platform_admin' order by id`, [tenant.orgId]);
    expect(audit.map((a) => a.action)).toEqual(['admin.organization_suspended', 'admin.organization_reactivated']);
    expect(audit[0]).toMatchObject({ actor_id: superadmin.userId, metadata: { reason: 'Chargeback investigation', platformRole: 'superadmin' } });
  });

  it('grants and revokes entitlement overrides with reason and expiry', async () => {
    const tenant = await createTenant(t, { planId: 'free' });
    expect(await entitlements.isEnabled(tenant.orgId, 'pay')).toBe(false);
    const url = `/v1/admin/tenants/${tenant.orgId}/overrides`;
    expect((await t.http.post(url).set(auth(superadmin)).send({ module: 'pay', reason: 'Competition demo' })).status).toBe(400);
    expect((await t.http.post(url).set(auth(superadmin)).send({ module: 'pay', expiresAt: future(3) })).status).toBe(400);
    expect((await t.http.post(url).set(auth(superadmin)).send({ module: 'pay', reason: 'Competition demo', expiresAt: new Date(Date.now() - 1000).toISOString() })).body.error.code).toBe('expiry_in_past');

    const g = await t.http.post(url).set(auth(superadmin)).send({ module: 'pay', reason: 'Competition demo', expiresAt: future(3) });
    expect(g.status).toBe(201);
    expect(await entitlements.isEnabled(tenant.orgId, 'pay')).toBe(true);
    const view = await t.http.get(`/v1/o/${tenant.orgId}/billing/entitlements`).set(auth(tenant.owner));
    expect(view.body.modules.pay).toMatchObject({ enabled: true, source: 'override' });
    const detail = await t.http.get(`/v1/admin/tenants/${tenant.orgId}`).set(auth(support));
    expect(detail.body.overrides[0]).toMatchObject({ module: 'pay', active: true, reason: 'Competition demo' });
    expect(detail.body.modules.pay).toBe(true);

    const rv = await t.http.post(`${url}/${g.body.id}/revoke`).set(auth(superadmin)).send({ reason: 'Demo finished' });
    expect(rv.status).toBe(200);
    expect(await entitlements.isEnabled(tenant.orgId, 'pay')).toBe(false);
    expect((await t.http.post(`${url}/${g.body.id}/revoke`).set(auth(superadmin)).send({ reason: 'Demo finished' })).status).toBe(404);
    const audit = await sql(`select action from audit_logs where org_id = $1 and actor_type = 'platform_admin' order by id`, [tenant.orgId]);
    expect(audit.map((a) => a.action)).toEqual(['admin.entitlement_override_granted', 'admin.entitlement_override_revoked']);
  });

  it('returns 404 for unknown tenants', async () => {
    expect((await t.http.get('/v1/admin/tenants/00000000-0000-0000-0000-000000000000').set(auth(support))).status).toBe(404);
    expect((await t.http.get('/v1/admin/tenants/not-a-uuid').set(auth(support))).status).toBe(404);
  });
});

describe('price management', () => {
  it('adds a new price row (history untouched) that quotes use immediately', async () => {
    const before = await sql(`select id, amount_minor, valid_from from plan_prices where plan_id = 'growth' and country = 'SA' and billing_interval = 'year' order by valid_from`);
    const oldQuote = await t.http.post('/v1/public/pricing/quote').send({ planId: 'growth', country: 'SA', interval: 'year' });
    const amount = oldQuote.body.subtotalMinor + 12345;
    const res = await t.http.post('/v1/admin/prices/plans').set(auth(superadmin)).send({ planId: 'growth', country: 'SA', interval: 'year', amountMinor: amount });
    expect(res.status).toBe(201);
    insertedPriceIds.push(res.body.id);
    expect(res.body).toMatchObject({ key: 'growth', currency: 'SAR', amountMinor: amount, current: true });
    const after = await sql(`select id, amount_minor, valid_from from plan_prices where plan_id = 'growth' and country = 'SA' and billing_interval = 'year' order by valid_from`);
    expect(after).toHaveLength(before.length + 1);
    expect(after.slice(0, before.length)).toEqual(before);
    const quote = await t.http.post('/v1/public/pricing/quote').send({ planId: 'growth', country: 'SA', interval: 'year' });
    expect(quote.body.subtotalMinor).toBe(amount);
    const prices = await t.http.get('/v1/admin/prices?country=SA').set(auth(finance));
    const growthYear = prices.body.plans.filter((p: any) => p.key === 'growth' && p.interval === 'year');
    expect(growthYear.filter((p: any) => p.current).map((p: any) => p.id)).toEqual([res.body.id]);
    const [audit] = await sql(`select org_id, actor_type, action from audit_logs where entity_id = $1`, [res.body.id]);
    expect(audit).toEqual({ org_id: null, actor_type: 'platform_admin', action: 'admin.plan_price_added' });
  });

  it('schedules future module prices and rejects back-dated ones', async () => {
    const validFrom = future(30);
    const res = await t.http.post('/v1/admin/prices/modules').set(auth(superadmin)).send({ module: 'driver', country: 'EG', interval: 'month', amountMinor: 1, validFrom });
    expect(res.status).toBe(201);
    insertedPriceIds.push(res.body.id);
    expect(res.body.current).toBe(false);
    const quote = await t.http.post('/v1/public/pricing/quote').send({ planId: 'free', country: 'EG', interval: 'month', addons: ['driver'] });
    expect(quote.body.lines[1].amountMinor).not.toBe(1);   // future row does not apply yet
    const past = await t.http.post('/v1/admin/prices/modules').set(auth(superadmin)).send({ module: 'driver', country: 'EG', interval: 'month', amountMinor: 1, validFrom: '2026-01-01T00:00:00Z' });
    expect(past.body.error.code).toBe('price_in_past');
    expect((await t.http.post('/v1/admin/prices/plans').set(auth(superadmin)).send({ planId: 'ghost', country: 'EG', interval: 'month', amountMinor: 5 })).body.error.code).toBe('unknown_plan');
  });
});

describe('operations view', () => {
  it('summarises outbox, handler failures, webhooks, jobs and usage without payloads', async () => {
    await sql(`insert into webhook_inbox(provider, event_key, signature_valid, payload, status, error) values ('stripe', $1, false, '{"card":"PAYLOAD-4242-SECRET"}', 'rejected', 'bad signature')`, [unique('evt')]);
    const res = await t.http.get('/v1/admin/operations').set(auth(support));
    expect(res.status).toBe(200);
    expect(res.body.outbox).toEqual(expect.objectContaining({ unpublished: expect.any(Number) }));
    expect(res.body.webhooks.rejected).toBeGreaterThanOrEqual(1);
    expect(res.body.webhooks.recent[0]).toMatchObject({ provider: 'stripe', status: 'rejected', error: 'bad signature' });
    // A marker no id or hex value can contain by chance (a bare "4242" matched random UUIDs now and then).
    expect(JSON.stringify(res.body)).not.toContain('PAYLOAD-4242');
    expect(Array.isArray(res.body.jobs)).toBe(true);
    expect(Array.isArray(res.body.usage30d)).toBe(true);
  });
});
