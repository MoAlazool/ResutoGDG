import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TenantContext } from '../src/common/auth/context';
import { DbService } from '../src/common/db/db.service';
import { EntitlementsService } from '../src/common/entitlements/entitlements.service';
import { EventDispatcher } from '../src/common/events/dispatcher.service';
import { BillingLifecycleService } from '../src/modules/billing/lifecycle.service';
import { PlanLimitsService } from '../src/modules/billing/plan-limits.service';
import { UsageService } from '../src/modules/billing/usage.service';
import { OrdersKernelService } from '../src/modules/kernel/orders-kernel.service';
import { addMember, auth, bootTestApp, createTenant, seedMenu, sql, unique, type TestApp, type TestTenant } from './helpers';

let t: TestApp;
let entitlements: EntitlementsService;
let lifecycle: BillingLifecycleService;
beforeAll(async () => {
  t = await bootTestApp();
  entitlements = t.app.get(EntitlementsService);
  lifecycle = t.app.get(BillingLifecycleService);
});
afterAll(async () => { await t.close(); });

/** Current price straight from the database (the API must never hard-code amounts). */
async function planPrice(planId: string, country: string, interval: string) {
  const [r] = await sql(`select amount_minor from plan_prices where plan_id = $1 and country = $2 and billing_interval = $3 and active and valid_from <= now()
                          order by valid_from desc limit 1`, [planId, country, interval]);
  return Number(r.amount_minor);
}
async function modulePrice(module: string, country: string, interval: string) {
  const [r] = await sql(`select amount_minor from module_prices where module = $1 and country = $2 and billing_interval = $3 and active and valid_from <= now()
                          order by valid_from desc limit 1`, [module, country, interval]);
  return Number(r.amount_minor);
}
const sub = async (orgId: string) => (await sql(`select * from subscriptions where org_id = $1 order by created_at desc limit 1`, [orgId]))[0];
const makeActive = (orgId: string) => sql(`update subscriptions set status = 'active', trial_ends_at = null where org_id = $1`, [orgId]);
const ents = async (tenant: TestTenant) => (await t.http.get(`/v1/o/${tenant.orgId}/billing/entitlements`).set(auth(tenant.owner))).body;

describe('public plans and quotes', () => {
  it('lists plans with database prices, modules and limits for a country and interval', async () => {
    const res = await t.http.get('/v1/public/plans?country=SA&interval=year');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ country: 'SA', currency: 'SAR', interval: 'year' });
    const ids = res.body.plans.map((p: any) => p.id);
    expect(ids).toEqual(expect.arrayContaining(['free', 'starter', 'growth', 'pro', 'custom']));
    const pro = res.body.plans.find((p: any) => p.id === 'pro');
    expect(pro.price.amountMinor).toBe(await planPrice('pro', 'SA', 'year'));
    expect(pro.prices.month.amountMinor).toBe(await planPrice('pro', 'SA', 'month'));
    expect(pro.modules).toEqual(expect.arrayContaining(['core', 'pay', 'driver', 'mcp']));
    expect(pro.limits.branches).toBeGreaterThan(1);
    const driver = res.body.modules.find((m: any) => m.key === 'driver');
    expect(driver.price.amountMinor).toBe(await modulePrice('driver', 'SA', 'year'));
    expect(res.body.externalCostsNote).toMatch(/not included/);
    expect((await t.http.get('/v1/public/plans?country=FR')).status).toBe(400);
  });

  it('carries Arabic plan copy with the brand spelled ريسوتو (VP-22, VP-02)', async () => {
    const res = await t.http.get('/v1/public/plans?country=EG&interval=month');
    const byId = Object.fromEntries(res.body.plans.map((p: any) => [p.id, p]));
    for (const id of ['free', 'starter', 'growth', 'pro', 'custom']) {
      expect(byId[id].descriptionAr, id).toMatch(/[؀-ۿ]/);
      expect(byId[id].descriptionAr).not.toBe(byId[id].description);
    }
    expect(byId.custom.nameAr).toBe('ابنِ ريسوتو الخاص بك');
    expect(JSON.stringify(res.body)).not.toMatch(/ريزوتو/);
  });

  it('quotes Egyptian plans with add-ons deterministically', async () => {
    const body = { planId: 'growth', country: 'EG', interval: 'month', addons: ['driver', 'connect', 'core', 'driver'] };
    const a = await t.http.post('/v1/public/pricing/quote').send(body);
    const b = await t.http.post('/v1/public/pricing/quote').send(body);
    expect(a.status).toBe(200);
    expect(a.body).toEqual(b.body);
    const growth = await planPrice('growth', 'EG', 'month');
    const driver = await modulePrice('driver', 'EG', 'month');
    expect(a.body.currency).toBe('EGP');
    expect(a.body.lines).toEqual([
      { kind: 'plan', key: 'growth', amountMinor: growth },
      { kind: 'module', key: 'connect', amountMinor: 0, included: true },
      { kind: 'module', key: 'driver', amountMinor: driver },
    ]);
    expect(a.body.subtotalMinor).toBe(growth + driver);
    expect(a.body.modules).toContain('driver');
    expect(a.body.externalCostsNote).toMatch(/WhatsApp/);
  });

  it('prices Build Your Resuto in Saudi Arabia as base plus each chosen module', async () => {
    const res = await t.http.post('/v1/public/pricing/quote').send({ planId: 'custom', country: 'SA', interval: 'year', addons: ['pay', 'mcp', 'finance'] });
    expect(res.status).toBe(200);
    const expected = await planPrice('custom', 'SA', 'year') + await modulePrice('pay', 'SA', 'year') + await modulePrice('mcp', 'SA', 'year') + await modulePrice('finance', 'SA', 'year');
    expect(res.body.currency).toBe('SAR');
    expect(res.body.subtotalMinor).toBe(expected);
    expect(res.body.lines.map((l: any) => l.key)).toEqual(['custom', 'pay', 'finance', 'mcp']);
    expect(res.body.modules).toEqual(['core', 'pay', 'finance', 'mcp']);
  });

  it('validates quote input', async () => {
    expect((await t.http.post('/v1/public/pricing/quote').send({ planId: 'nope-plan', country: 'EG', interval: 'month' })).body.error.code).toBe('unknown_plan');
    expect((await t.http.post('/v1/public/pricing/quote').send({ planId: 'pro', country: 'EG', interval: 'week' })).status).toBe(400);
    expect((await t.http.post('/v1/public/pricing/quote').send({ planId: 'pro', country: 'EG', interval: 'month', addons: ['teleport'] })).status).toBe(400);
  });
});

describe('entitlements view', () => {
  it('explains every module with its source, limits and usage', async () => {
    const tenant = await createTenant(t, { planId: 'starter' });
    let view = await ents(tenant);
    expect(view.planId).toBe('starter');
    expect(view.status).toBe('trialing');
    expect(view.modules.core).toEqual({ enabled: true, source: 'plan' });
    expect(view.modules.pay).toEqual({ enabled: true, source: 'plan' });
    expect(view.modules.driver).toEqual({ enabled: false, source: 'none' });
    expect(view.limits.branches).toBe(1);
    expect(view.usage).toMatchObject({ branches: 1, staff: 1, orders: 0, ai_requests: 0, mcp_calls: 0 });

    // add-on
    const add = await t.http.post(`/v1/o/${tenant.orgId}/billing/change-plan`).set(auth(tenant.owner)).send({ planId: 'starter', addons: ['driver'] });
    expect(add.status).toBe(200);
    expect(add.body.outcome).toBe('applied');
    view = await ents(tenant);
    expect(view.modules.driver).toEqual({ enabled: true, source: 'addon' });

    // overrides win over plan and add-ons, in both directions
    const expires = new Date(Date.now() + 864e5).toISOString();
    await sql(`insert into entitlement_overrides(org_id, module, enabled, reason, expires_at) values ($1, 'marketing', true, 'test grant', $2), ($1, 'pay', false, 'test block', $2)`, [tenant.orgId, expires]);
    await sql(`insert into entitlement_overrides(org_id, module, enabled, reason, expires_at) values ($1, 'finance', true, 'expired grant', now() - interval '1 minute')`, [tenant.orgId]);
    entitlements.invalidate(tenant.orgId);
    view = await ents(tenant);
    expect(view.modules.marketing).toMatchObject({ enabled: true, source: 'override' });
    expect(view.modules.pay).toMatchObject({ enabled: false, source: 'override' });
    expect(view.modules.finance).toEqual({ enabled: false, source: 'none' });
    expect(await entitlements.isEnabled(tenant.orgId, 'marketing')).toBe(true);
    expect(await entitlements.isEnabled(tenant.orgId, 'pay')).toBe(false);
  });

  it('is readable by any member but hides other tenants', async () => {
    const tenant = await createTenant(t);
    const other = await createTenant(t);
    const waiter = await addMember(t, tenant, 'waiter');
    expect((await t.http.get(`/v1/o/${tenant.orgId}/billing/entitlements`).set(auth(waiter))).status).toBe(200);
    expect((await t.http.get(`/v1/o/${other.orgId}/billing/entitlements`).set(auth(tenant.owner))).status).toBe(404);
    expect((await t.http.get(`/v1/o/${other.orgId}/billing/subscription`).set(auth(tenant.owner))).status).toBe(404);
    expect((await t.http.post(`/v1/o/${other.orgId}/billing/change-plan`).set(auth(tenant.owner)).send({ planId: 'free' })).status).toBe(404);
  });
});

describe('plan changes', () => {
  it('lets only billing managers see and change the subscription', async () => {
    const tenant = await createTenant(t);
    const manager = await addMember(t, tenant, 'manager');
    const admin = await addMember(t, tenant, 'admin');
    expect((await t.http.post(`/v1/o/${tenant.orgId}/billing/change-plan`).set(auth(manager)).send({ planId: 'free' })).status).toBe(403);
    expect((await t.http.post(`/v1/o/${tenant.orgId}/billing/change-plan`).set(auth(admin)).send({ planId: 'free' })).status).toBe(403);
    expect((await t.http.get(`/v1/o/${tenant.orgId}/billing/subscription`).set(auth(manager))).status).toBe(403);
    expect((await t.http.post(`/v1/o/${tenant.orgId}/billing/cancel`).set(auth(manager)).send({})).status).toBe(403);
    const view = await t.http.get(`/v1/o/${tenant.orgId}/billing/subscription`).set(auth(tenant.owner));
    expect(view.status).toBe(200);
    expect(view.body).toMatchObject({ planId: 'pro', status: 'trialing', billingProvider: { connected: false } });
    expect(view.body.recurring.subtotalMinor).toBe(await planPrice('pro', 'EG', 'month'));
  });

  it('validates plan change input', async () => {
    const tenant = await createTenant(t);
    expect((await t.http.post(`/v1/o/${tenant.orgId}/billing/change-plan`).set(auth(tenant.owner)).send({ planId: 'BAD PLAN' })).status).toBe(400);
    expect((await t.http.post(`/v1/o/${tenant.orgId}/billing/change-plan`).set(auth(tenant.owner)).send({ planId: 'imaginary' })).body.error.code).toBe('unknown_plan');
    expect((await t.http.post(`/v1/o/${tenant.orgId}/billing/change-plan`).set(auth(tenant.owner)).send({ planId: 'pro' })).body.error.code).toBe('no_change');
  });

  it('upgrades immediately and unlocks the module end to end', async () => {
    const tenant = await createTenant(t, { planId: 'free' });
    expect(await entitlements.isEnabled(tenant.orgId, 'pay')).toBe(false);
    await expect(entitlements.assert(tenant.orgId, 'pay')).rejects.toMatchObject({ status: 402, code: 'module_not_entitled' });
    const res = await t.http.post(`/v1/o/${tenant.orgId}/billing/change-plan`).set(auth(tenant.owner)).send({ planId: 'starter' });
    expect(res.status).toBe(200);
    expect(res.body.outcome).toBe('applied');
    // A free restaurant that never trialed gets the trial on its first paid plan.
    expect(res.body.subscription).toMatchObject({ planId: 'starter', status: 'trialing' });
    expect(await entitlements.isEnabled(tenant.orgId, 'pay')).toBe(true);
    expect((await ents(tenant)).modules.pay).toEqual({ enabled: true, source: 'plan' });
    const [ev] = await sql(`select event_type, from_plan_id, to_plan_id from subscription_events where org_id = $1 order by id desc limit 1`, [tenant.orgId]);
    expect(ev).toEqual({ event_type: 'upgraded', from_plan_id: 'free', to_plan_id: 'starter' });
    const [audit] = await sql(`select action from audit_logs where org_id = $1 and action like 'subscription.%'`, [tenant.orgId]);
    expect(audit.action).toBe('subscription.plan_changed');
  });

  it('refuses a downgrade the restaurant has outgrown, then schedules it for period end', async () => {
    const tenant = await createTenant(t);
    await makeActive(tenant.orgId);
    const second = await t.http.post(`/v1/o/${tenant.orgId}/branches`).set(auth(tenant.owner)).send({ name: 'Second' });
    expect(second.status).toBe(201);
    const blocked = await t.http.post(`/v1/o/${tenant.orgId}/billing/change-plan`).set(auth(tenant.owner)).send({ planId: 'starter' });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe('downgrade_blocked');
    expect(blocked.body.error.details.violations).toEqual([{ limit: 'branches', current: 2, allowed: 1 }]);

    await t.http.patch(`/v1/o/${tenant.orgId}/branches/${second.body.id}`).set(auth(tenant.owner)).send({ isActive: false });
    const scheduled = await t.http.post(`/v1/o/${tenant.orgId}/billing/change-plan`).set(auth(tenant.owner)).send({ planId: 'starter' });
    expect(scheduled.status).toBe(200);
    expect(scheduled.body.outcome).toBe('scheduled');
    expect(scheduled.body.subscription.planId).toBe('pro');
    expect(scheduled.body.subscription.pendingChange).toMatchObject({ planId: 'starter', interval: 'month' });
    expect(await entitlements.isEnabled(tenant.orgId, 'finance')).toBe(true);   // still on Pro until period end

    const before = await sub(tenant.orgId);
    const now = new Date(new Date(before.current_period_end).getTime() + 60_000);
    const stats = await lifecycle.run(now, { orgIds: [tenant.orgId] });
    expect(stats).toMatchObject({ changesApplied: 1, periodsRolled: 1, invoicesDrafted: 1 });
    const after = await sub(tenant.orgId);
    expect(after.plan_id).toBe('starter');
    expect(after.pending_plan_id).toBeNull();
    expect(new Date(after.current_period_start).getTime()).toBe(new Date(before.current_period_end).getTime());
    // Paid period, no billing provider: payment due with grace, modules still on during grace.
    expect(after.status).toBe('past_due');
    expect(new Date(after.grace_until).getTime()).toBe(now.getTime() + 7 * 864e5);
    expect(await entitlements.isEnabled(tenant.orgId, 'finance')).toBe(false);
    expect(await entitlements.isEnabled(tenant.orgId, 'pay')).toBe(true);
    const invoices = await sql(`select status, subtotal_minor, currency from platform_invoices where org_id = $1`, [tenant.orgId]);
    expect(invoices).toEqual([{ status: 'draft', subtotal_minor: await planPrice('starter', 'EG', 'month'), currency: 'EGP' }]);
    // Re-running at the same time is a no-op.
    expect(await lifecycle.run(now, { orgIds: [tenant.orgId] })).toMatchObject({ periodsRolled: 0, invoicesDrafted: 0 });
  });

  it('clears a scheduled change when the current plan is chosen again', async () => {
    const tenant = await createTenant(t);
    await makeActive(tenant.orgId);
    expect((await t.http.post(`/v1/o/${tenant.orgId}/billing/change-plan`).set(auth(tenant.owner)).send({ planId: 'growth' })).body.outcome).toBe('scheduled');
    const res = await t.http.post(`/v1/o/${tenant.orgId}/billing/change-plan`).set(auth(tenant.owner)).send({ planId: 'pro' });
    expect(res.body.outcome).toBe('cleared');
    expect(res.body.subscription.pendingChange).toBeNull();
  });

  it('cancels at period end and can resume before then', async () => {
    const tenant = await createTenant(t);
    await makeActive(tenant.orgId);
    const c = await t.http.post(`/v1/o/${tenant.orgId}/billing/cancel`).set(auth(tenant.owner)).send({ reason: 'closing season' });
    expect(c.status).toBe(200);
    expect(c.body.cancelAtPeriodEnd).toBe(true);
    expect((await t.http.post(`/v1/o/${tenant.orgId}/billing/cancel`).set(auth(tenant.owner)).send({})).body.error.code).toBe('already_canceling');
    const r = await t.http.post(`/v1/o/${tenant.orgId}/billing/resume`).set(auth(tenant.owner)).send({});
    expect(r.body.cancelAtPeriodEnd).toBe(false);
    expect((await t.http.post(`/v1/o/${tenant.orgId}/billing/resume`).set(auth(tenant.owner)).send({})).body.error.code).toBe('not_canceling');

    await t.http.post(`/v1/o/${tenant.orgId}/billing/cancel`).set(auth(tenant.owner)).send({});
    const s = await sub(tenant.orgId);
    await lifecycle.run(new Date(new Date(s.current_period_end).getTime() + 1000), { orgIds: [tenant.orgId] });
    expect((await sub(tenant.orgId)).status).toBe('canceled');
    expect(await entitlements.isEnabled(tenant.orgId, 'core')).toBe(false);

    const free = await createTenant(t, { planId: 'free' });
    expect((await t.http.post(`/v1/o/${free.orgId}/billing/cancel`).set(auth(free.owner)).send({})).body.error.code).toBe('free_plan_cannot_cancel');
  });
});

describe('subscription lifecycle job', () => {
  it('moves an ended trial to past_due with grace, then to unpaid when grace expires', async () => {
    const tenant = await createTenant(t, { planId: 'growth' });
    const s0 = await sub(tenant.orgId);
    const trialEnd = new Date(s0.trial_ends_at);
    // Not due yet.
    expect(await lifecycle.run(new Date(trialEnd.getTime() - 1000), { orgIds: [tenant.orgId] })).toMatchObject({ trialsEnded: 0 });

    const t1 = new Date(trialEnd.getTime() + 5 * 60_000);
    expect(await lifecycle.run(t1, { orgIds: [tenant.orgId] })).toMatchObject({ trialsEnded: 1, invoicesDrafted: 1 });
    const s1 = await sub(tenant.orgId);
    expect(s1.status).toBe('past_due');
    expect(new Date(s1.grace_until).getTime()).toBe(t1.getTime() + 7 * 864e5);
    expect(new Date(s1.current_period_start).getTime()).toBe(trialEnd.getTime());
    expect(await entitlements.isEnabled(tenant.orgId, 'marketing')).toBe(true);    // within grace
    const [inv] = await sql(`select status, subtotal_minor from platform_invoices where org_id = $1`, [tenant.orgId]);
    expect(inv).toEqual({ status: 'draft', subtotal_minor: await planPrice('growth', 'EG', 'month') });

    // The grace window is measured against real time by app.module_enabled; move it into the past.
    await sql(`update subscriptions set grace_until = now() - interval '1 minute' where id = $1`, [s1.id]);
    expect(await lifecycle.run(new Date(), { orgIds: [tenant.orgId] })).toMatchObject({ graceExpired: 1 });
    expect((await sub(tenant.orgId)).status).toBe('unpaid');
    expect(await entitlements.isEnabled(tenant.orgId, 'core')).toBe(false);
    const types = (await sql(`select event_type from subscription_events where org_id = $1 order by id`, [tenant.orgId])).map((r) => r.event_type);
    expect(types).toEqual(['created', 'trial_ended', 'period_rolled', 'grace_expired']);

    // An unpaid restaurant can always fall back to the free plan immediately.
    const down = await t.http.post(`/v1/o/${tenant.orgId}/billing/change-plan`).set(auth(tenant.owner)).send({ planId: 'free' });
    expect(down.body).toMatchObject({ outcome: 'applied', subscription: { planId: 'free', status: 'active' } });
    expect(await entitlements.isEnabled(tenant.orgId, 'core')).toBe(true);
  });

  it('rolls the period of a free plan and stays active without invoices', async () => {
    const tenant = await createTenant(t, { planId: 'free' });
    const s0 = await sub(tenant.orgId);
    const end = new Date(s0.current_period_end);
    // Two months late: the job rolls forward until the period contains "now".
    const now = new Date(end.getTime() + 40 * 864e5);
    expect(await lifecycle.run(now, { orgIds: [tenant.orgId] })).toMatchObject({ periodsRolled: 1, invoicesDrafted: 0 });
    const s1 = await sub(tenant.orgId);
    expect(s1.status).toBe('active');
    expect(new Date(s1.current_period_start).getTime()).toBeLessThanOrEqual(now.getTime());
    expect(new Date(s1.current_period_end).getTime()).toBeGreaterThan(now.getTime());
    expect(new Date(s1.current_period_start).getTime()).toBeGreaterThan(end.getTime());
    expect(await sql(`select 1 from platform_invoices where org_id = $1`, [tenant.orgId])).toHaveLength(0);
  });
});

describe('usage metering and plan limits', () => {
  it('meters placed orders once per order and enforces the monthly order cap', async () => {
    const tenant = await createTenant(t, { planId: 'free' });
    const menu = await seedMenu(tenant);
    const db = t.app.get(DbService);
    const orders = t.app.get(OrdersKernelService);
    const limits = t.app.get(PlanLimitsService);
    const usage = t.app.get(UsageService);
    const ctx = new TenantContext(tenant.orgId, 'owner', null, tenant.owner.userId, 'user', tenant.owner.userId);
    const capPlan = unique('cap').toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 40);
    await sql(`insert into plans(id, name, is_public, limits) values ($1, 'Test cap', false, '{"branches":1,"staff":2,"orders_per_month":1}')`, [capPlan]);
    await sql(`insert into plan_modules(plan_id, module) values ($1, 'core')`, [capPlan]);
    await sql(`update subscriptions set plan_id = $2 where org_id = $1`, [tenant.orgId, capPlan]);

    await db.scoped(ctx, (tx) => limits.assertCanPlaceOrder(tx, tenant.orgId));
    const placed = await db.scoped(ctx, (tx) => orders.place(tx, ctx, { branchId: tenant.branchId, channel: 'staff', fulfillment: 'pickup', lines: [{ productId: menu.products.soda, quantity: 1 }] }));
    await expect(db.scoped(ctx, (tx) => limits.assertCanPlaceOrder(tx, tenant.orgId)))
      .rejects.toMatchObject({ status: 402, code: 'plan_limit_reached', details: { limit: 'orders_per_month', current: 1, allowed: 1 } });

    await t.app.get(EventDispatcher).drain();
    const rows = await sql(`select metric, quantity, source_ref from usage_events where org_id = $1`, [tenant.orgId]);
    expect(rows).toEqual([{ metric: 'orders', quantity: 1, source_ref: placed.id }]);
    // A redelivered event does not double count.
    await usage.onOrderPlaced({ id: 'x', orgId: tenant.orgId, type: 'order.placed', aggregateType: 'order', aggregateId: placed.id, payload: {}, createdAt: new Date().toISOString() });
    expect(await sql(`select 1 from usage_events where org_id = $1`, [tenant.orgId])).toHaveLength(1);
    expect((await ents(tenant)).usage.orders).toBe(1);
  });

  it('FT-10: enforces ai_requests_per_month from metered ai_requests in the current period', async () => {
    const tenant = await createTenant(t, { planId: 'pro' });
    const db = t.app.get(DbService);
    const limits = t.app.get(PlanLimitsService);
    const ctx = new TenantContext(tenant.orgId, 'owner', null, tenant.owner.userId, 'user', tenant.owner.userId);
    const capPlan = unique('aicap').toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 40);
    await sql(`insert into plans(id, name, is_public, limits) values ($1, 'AI cap', false, '{"branches":1,"staff":2,"ai_requests_per_month":2}')`, [capPlan]);
    await sql(`insert into plan_modules(plan_id, module) values ($1, 'core'), ($1, 'intelligence')`, [capPlan]);
    await sql(`update subscriptions set plan_id = $2 where org_id = $1`, [tenant.orgId, capPlan]);
    const quota = () => db.scoped(ctx, (tx) => limits.assertAiQuota(tx, tenant.orgId));

    await quota();
    // Usage from before the current period does not count.
    await sql(`insert into usage_events(org_id, metric, quantity, occurred_at) values ($1, 'ai_requests', 5, now() - interval '400 days')`, [tenant.orgId]);
    await quota();
    await sql(`insert into usage_events(org_id, metric, quantity) values ($1, 'ai_requests', 1)`, [tenant.orgId]);
    await quota();
    await sql(`insert into usage_events(org_id, metric, quantity) values ($1, 'ai_requests', 1)`, [tenant.orgId]);
    await expect(quota()).rejects.toMatchObject({ status: 402, code: 'plan_limit_reached', details: { limit: 'ai_requests_per_month', current: 2, allowed: 2 } });
    // Other metrics never count against the AI quota.
    await sql(`update plans set limits = '{"ai_requests_per_month":3}' where id = $1`, [capPlan]);
    await sql(`insert into usage_events(org_id, metric, quantity) values ($1, 'mcp_calls', 50)`, [tenant.orgId]);
    await quota();
    // A plan without the limit is unlimited; a zero limit refuses every model call.
    await sql(`update plans set limits = '{}' where id = $1`, [capPlan]);
    await quota();
    await sql(`update plans set limits = '{"ai_requests_per_month":0}' where id = $1`, [capPlan]);
    await expect(quota()).rejects.toMatchObject({ status: 402, details: { limit: 'ai_requests_per_month', allowed: 0 } });
  });
});
