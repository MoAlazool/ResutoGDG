import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DbService } from '../src/common/db/db.service';
import { OrdersKernelService } from '../src/modules/kernel/orders-kernel.service';
import { PaymentLedgerService } from '../src/modules/kernel/payment-ledger.service';
import { addMember, auth, bootTestApp, createTenant, seedMenu, sql, unique, type SeededMenu, type TestApp, type TestTenant } from './helpers';
import { addBranch, ownerCtx, placeOrder } from './insights-fixtures';

let t: TestApp;
beforeAll(async () => { t = await bootTestApp(); });
afterAll(async () => { await t.close(); });

const setPlacedAt = (orderId: string, isoUtc: string) => sql(`update orders set placed_at = $2 where id = $1`, [orderId, isoUtc]);
const transition = (tenant: TestTenant, orderId: string, to: any) => {
  const ctx = ownerCtx(tenant);
  return t.app.get(DbService).scoped(ctx, (tx) => t.app.get(OrdersKernelService).transition(tx, ctx, orderId, to));
};

/**
 * Controlled dataset (Egypt, VAT 14% inclusive, Cairo = UTC+2 in December).
 * Prices are multiples of 114 so VAT and ex-VAT amounts are exact.
 *
 *  O0  Mona   1 Koshari          11400  2026-11-28 (previous period)
 *  O1  Mona   2 Koshari          22800  2026-12-01 12:00 Cairo, web, real campaign
 *  O2  Mona   1 Koshari + 1 Tea  13680  2026-12-03 14:00 Cairo, qr dine-in, sandbox campaign
 *  O3  Omar   1 Tea               2280  2026-12-07 23:30 Cairo (= 00:30 Dec 8 in Riyadh), whatsapp
 *  O4  —      1 Koshari          11400  2026-12-08 00:30 Cairo (outside the period)
 *  O5  Omar   1 Koshari          11400  2026-12-02, cancelled
 *  O6  Sara   1 Koshari          11400  2026-12-05, paid in cash 11400, refunded 5700
 *
 * Koshari costs 3000 per unit; Tea has no cost data.
 */
describe('analytics on a controlled dataset', () => {
  let tenant: TestTenant;
  let menu: SeededMenu;
  let koshari: string;
  let tea: string;
  let base: string;
  const ids: Record<string, string> = {};
  const q = (path: string, params: Record<string, string>) => t.http.get(`${base}/${path}?${new URLSearchParams(params)}`).set(auth(tenant.owner));
  const week = { from: '2026-12-01', to: '2026-12-07' };

  beforeAll(async () => {
    tenant = await createTenant(t, { country: 'EG' });
    menu = await seedMenu(tenant);
    base = `/v1/o/${tenant.orgId}/analytics`;
    koshari = (await sql(`insert into products(org_id, category_id, name, price_minor, cost_minor, currency) values ($1, $2, 'Koshari', 11400, 3000, 'EGP') returning id`, [tenant.orgId, menu.categoryId]))[0].id;
    tea = (await sql(`insert into products(org_id, category_id, name, price_minor, cost_minor, currency) values ($1, $2, 'Tea', 2280, null, 'EGP') returning id`, [tenant.orgId, menu.categoryId]))[0].id;
    const [real] = await sql(`insert into campaigns(org_id, name, channel, utm_campaign, is_sandbox, status) values ($1, 'Ramadan WhatsApp', 'whatsapp', $2, false, 'sent') returning id`, [tenant.orgId, unique('utm')]);
    const [sandbox] = await sql(`insert into campaigns(org_id, name, channel, utm_campaign, is_sandbox, status) values ($1, 'Sandbox test', 'whatsapp', $2, true, 'sent') returning id`, [tenant.orgId, unique('utm')]);
    const mona = { name: 'Mona', phone: '+201005550001' };
    const place = async (key: string, at: string, lines: any[], extra: Record<string, unknown> = {}) => {
      const o = await placeOrder(t, tenant, { channel: 'staff', fulfillment: 'pickup', lines, ...extra } as any);
      await setPlacedAt(o.id, at);
      ids[key] = o.id;
      return o;
    };
    await place('O0', '2026-11-28T10:00:00Z', [{ productId: koshari, quantity: 1 }], { customer: mona });
    await place('O1', '2026-12-01T10:00:00Z', [{ productId: koshari, quantity: 2 }], { channel: 'web', customer: mona, campaignId: real.id });
    await place('O2', '2026-12-03T12:00:00Z', [{ productId: koshari, quantity: 1 }, { productId: tea, quantity: 1 }],
      { channel: 'qr', fulfillment: 'dine_in', tableId: menu.tableId, customer: mona, campaignId: sandbox.id });
    await place('O3', '2026-12-07T21:30:00Z', [{ productId: tea, quantity: 1 }], { channel: 'whatsapp', customer: { name: 'Omar', phone: '+201005550002' } });
    await place('O4', '2026-12-07T22:30:00Z', [{ productId: koshari, quantity: 1 }]);
    await place('O5', '2026-12-02T09:00:00Z', [{ productId: koshari, quantity: 1 }], { customer: { name: 'Omar', phone: '+201005550002' } });
    await transition(tenant, ids.O5!, 'cancelled');
    await place('O6', '2026-12-05T09:00:00Z', [{ productId: koshari, quantity: 1 }], { customer: { name: 'Sara', email: 'sara@cairo.test' } });
    const ctx = ownerCtx(tenant);
    const ledger = t.app.get(PaymentLedgerService);
    const payment = await t.app.get(DbService).scoped(ctx, (tx) => ledger.recordSucceeded(tx, ctx, {
      branchId: tenant.branchId, orderId: ids.O6, method: 'cash', provider: 'manual', amountMinor: 11400, currency: 'EGP', idempotencyKey: unique('cash'),
    }));
    await t.app.get(DbService).scoped(ctx, (tx) => ledger.applyRefund(tx, ctx, payment.id, 5700));

    // Marketing costs: real and sandbox ad spend, a marketing expense and an unrelated expense.
    const ad = (date: string, spend: number, sandboxRow: boolean) => sql(
      `insert into ad_campaign_reports(org_id, provider, external_campaign_id, report_date, spend_minor, clicks, impressions, currency, is_sandbox)
       values ($1, 'meta_ads', $2, $3, $4, 10, 1000, 'EGP', $5)`, [tenant.orgId, unique('ext'), date, spend, sandboxRow]);
    await ad('2026-12-02', 5000, false);
    await ad('2026-12-03', 99999, true);
    await ad('2026-11-15', 7777, false);
    const cat = async (kind: string) => (await sql(`select id from expense_categories where org_id = $1 and kind = $2 limit 1`, [tenant.orgId, kind]))[0].id;
    await sql(`insert into expenses(org_id, category_id, amount_minor, currency, incurred_on) values ($1, $2, 3000, 'EGP', '2026-12-03'), ($1, $3, 50000, 'EGP', '2026-12-03')`,
      [tenant.orgId, await cat('marketing'), await cat('rent')]);
  });

  it('computes revenue, refunds netting, VAT and AOV exactly, with a period comparison', async () => {
    const res = await q('summary', week);
    expect(res.status).toBe(200);
    expect(res.body.totals).toEqual({
      orders: 4, cancelledOrders: 1, grossMinor: 50160, discountsMinor: 0, refundsMinor: 5700, netMinor: 44460,
      // VAT 2800 + 1680 + 280 + 1400 × (5700 / 11400)
      vatMinor: 5460, netExVatMinor: 39000, deliveryFeesMinor: 0, serviceChargeMinor: 0, paidMinor: 5700, averageOrderMinor: 12540,
    });
    expect(res.body.comparison).toMatchObject({ from: '2026-11-24', to: '2026-11-30', totals: { orders: 1, netMinor: 11400 },
      changePct: { orders: 300, netMinor: 290 } });
    expect(res.body.byChannel.map((c: any) => [c.key, c.orders, c.netMinor])).toEqual([['web', 1, 22800], ['qr', 1, 13680], ['staff', 1, 5700], ['whatsapp', 1, 2280]]);
    expect(res.body.byFulfillment.map((c: any) => [c.key, c.orders])).toEqual([['pickup', 3], ['dine_in', 1]]);
    expect(res.body.byBranch).toEqual([expect.objectContaining({ key: tenant.branchId, label: 'Main branch', orders: 4, netMinor: 44460, sharePct: 100 })]);
    expect(res.body.byPaymentMethod).toEqual([{ method: 'cash', collectedMinor: 11400, refundedMinor: 5700, netMinor: 5700 }]);
    expect(res.body.daily.map((d: any) => [d.date, d.netMinor])).toEqual([
      ['2026-12-01', 22800], ['2026-12-02', 0], ['2026-12-03', 13680], ['2026-12-04', 0], ['2026-12-05', 5700], ['2026-12-06', 0], ['2026-12-07', 2280],
    ]);
    // 2026-12-07 is a Monday; O3 is at 23:30 Cairo time.
    expect(res.body.heatmap).toContainEqual({ isoDow: 1, hour: 23, orders: 1, netMinor: 2280 });
    expect(res.body.meta).toMatchObject({ kind: 'measured', timezone: 'Africa/Cairo', assumptions: [],
      dataCoverage: { cancelledOrders: 1, awaitingPaymentOrders: 0 } });
    expect(res.body.meta.method).toMatch(/branch's timezone/);
  });

  it('buckets by the branch timezone around midnight (Cairo vs Riyadh)', async () => {
    const dec8 = { from: '2026-12-08', to: '2026-12-08', compare: 'none' };
    let r = await q('summary', dec8);
    expect(r.body.totals.orders).toBe(1); // O4 at 00:30 Cairo
    expect(r.body.comparison).toBeNull();
    await sql(`update branches set timezone = 'Asia/Riyadh' where id = $1`, [tenant.branchId]);
    try {
      r = await q('summary', dec8);
      expect(r.body.totals.orders).toBe(2); // O3 (00:30 Riyadh) joins O4 (01:30 Riyadh)
      const w = await q('summary', { ...week, compare: 'none' });
      expect(w.body.totals.orders).toBe(3);
      expect(w.body.daily.at(-1)).toEqual({ date: '2026-12-07', orders: 0, netMinor: 0 });
      const scoped = await q('summary', { ...dec8, branchId: tenant.branchId });
      expect(scoped.body.meta.timezone).toBe('Asia/Riyadh');
      expect(scoped.body.heatmap).toContainEqual({ isoDow: 2, hour: 0, orders: 1, netMinor: 2280 });
    } finally {
      await sql(`update branches set timezone = null where id = $1`, [tenant.branchId]);
    }
  });

  it('computes product margins with partial cost coverage and flags missing cost data', async () => {
    const res = await q('products', week);
    expect(res.status).toBe(200);
    const k = res.body.all.find((p: any) => p.productId === koshari);
    expect(k).toMatchObject({ quantity: 4, revenueMinor: 45600, netExVatMinor: 40000, costData: 'complete', costMinor: 12000, grossMarginMinor: 28000, marginPct: 70 });
    const tp = res.body.all.find((p: any) => p.productId === tea);
    expect(tp).toMatchObject({ quantity: 2, revenueMinor: 4560, netExVatMinor: 4000, costData: 'none', costMinor: null, grossMarginMinor: null, marginPct: null });
    expect(res.body.grossMargin).toEqual({ netExVatMinor: 44000, costedNetExVatMinor: 40000, costMinor: 12000, grossMarginMinor: 28000, marginPct: 70, costCoveragePct: 90.91 });
    expect(res.body.top.map((p: any) => p.name)).toEqual(['Koshari', 'Tea']);
    // Products that did not sell are the most underperforming.
    expect(res.body.underperforming[0]).toMatchObject({ quantity: 0, revenueMinor: 0 });
    expect(res.body.meta.dataCoverage).toMatchObject({ orderLines: 5, orderLinesWithoutCost: 2, costCoverageByRevenuePct: 90.91, productsWithoutCostData: 1 });
  });

  it('computes new vs returning customers, repeat rate and cohorts', async () => {
    const res = await q('customers', week);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      customers: 3, newCustomers: 2, returningCustomers: 1, repeatCustomers: 1, repeatRatePct: 33.33,
      newCustomerNetMinor: 2280 + 5700, returningCustomerNetMinor: 22800 + 13680,
    });
    expect(res.body.cohorts).toEqual([{ cohort: '2026-12', size: 2, active: [2], retentionPct: [100] }]);
    expect(res.body.meta.dataCoverage).toMatchObject({ countedOrders: 4, ordersWithoutCustomer: 0 });
    const nov = await q('customers', { from: '2026-11-01', to: '2026-12-31' });
    expect(nov.body.cohorts).toEqual([
      { cohort: '2026-11', size: 1, active: [1, 1], retentionPct: [100, 100] },
      { cohort: '2026-12', size: 2, active: [2], retentionPct: [100] },
    ]);
    expect(nov.body.meta.dataCoverage.ordersWithoutCustomer).toBe(1);
  });

  it('attributes campaign revenue and marketing costs, excluding sandbox rows', async () => {
    const res = await q('marketing', week);
    expect(res.status).toBe(200);
    expect(res.body.attributed).toMatchObject({ orders: 1, netMinor: 22800, netExVatMinor: 20000 });
    expect(res.body.attributed.campaigns).toEqual([expect.objectContaining({ name: 'Ramadan WhatsApp', orders: 1, netMinor: 22800 })]);
    expect(res.body.costs).toMatchObject({ adSpendMinor: 5000, marketingExpensesMinor: 3000, totalMinor: 8000 });
    expect(res.body.returnOnSpend).toBe(2.85);
    expect(res.body.meta.dataCoverage).toMatchObject({ excludedSandboxCampaignOrders: 1, excludedSandboxCampaignNetMinor: 13680, excludedSandboxAdSpendMinor: 99999 });
    expect(res.body.meta.method).toMatch(/not proven incremental/);
  });

  it('runs a hypothetical ROI scenario that separates incremental revenue from profit', async () => {
    const res = await t.http.post(`${base}/roi`).set(auth(tenant.owner)).send({
      baselineMonthlyNetRevenueMinor: 1_000_000, expectedUpliftPct: 10, ingredientCostPct: 30, variableCostPct: 5,
      subscriptionMonthlyCostMinor: 20_000, otherMonthlyCostMinor: 5_000, months: 12,
    });
    expect(res.status).toBe(200);
    expect(res.body.kind).toBe('hypothetical');
    expect(res.body.label).toMatch(/not measured results/);
    expect(res.body.hypothetical.monthly).toEqual({ incrementalRevenueMinor: 100_000, ingredientCostMinor: 30_000, variableCostMinor: 5_000,
      incrementalGrossProfitMinor: 65_000, subscriptionAndOtherCostMinor: 25_000, incrementalNetProfitMinor: 40_000 });
    expect(res.body.hypothetical.total).toEqual({ incrementalRevenueMinor: 1_200_000, incrementalGrossProfitMinor: 780_000, costMinor: 300_000, incrementalNetProfitMinor: 480_000 });
    expect(res.body.hypothetical).toMatchObject({ roiPct: 160, breakEvenUpliftPct: 3.85, paybackMonths: 0 });
    expect(res.body.meta.kind).toBe('hypothetical');
    expect(res.body.meta.assumptions).toContainEqual({ key: 'expectedUpliftPct', value: 10, source: 'caller' });
    expect(res.body.meta.assumptions).toContainEqual({ key: 'baselineMonthlyNetRevenueMinor', value: 1_000_000, source: 'caller' });

    // Without a baseline the measured one is used — and refused when there is no data.
    const none = await t.http.post(`${base}/roi`).set(auth(tenant.owner)).send({ expectedUpliftPct: 10, subscriptionMonthlyCostMinor: 20_000 });
    expect(none.status).toBe(422);
    expect(none.body.error.code).toBe('baseline_required');
    const recent = await placeOrder(t, tenant, { channel: 'staff', fulfillment: 'pickup', lines: [{ productId: koshari, quantity: 1 }] });
    await sql(`update orders set placed_at = now() - interval '5 days' where id = $1`, [recent.id]);
    const measured = await t.http.post(`${base}/roi`).set(auth(tenant.owner)).send({ expectedUpliftPct: 10, subscriptionMonthlyCostMinor: 100 });
    expect(measured.status).toBe(200);
    expect(measured.body.measured).toMatchObject({ orders: 1, netExVatMinor: 10000, monthlyNetExVatMinor: 3333, ingredientCostPct: 30, costCoveragePct: 100 });
    expect(measured.body.meta.assumptions).toContainEqual({ key: 'baselineMonthlyNetRevenueMinor', value: 3333, source: 'measured' });
    expect(measured.body.meta.assumptions).toContainEqual({ key: 'ingredientCostPct', value: 30, source: 'measured' });
    expect(measured.body.hypothetical.monthly.incrementalRevenueMinor).toBe(333);
    const invalidInput = await t.http.post(`${base}/roi`).set(auth(tenant.owner)).send({ expectedUpliftPct: 150, subscriptionMonthlyCostMinor: 1 });
    expect(invalidInput.status).toBe(400);
  });

  it('validates periods and enforces permissions and tenant isolation', async () => {
    expect((await q('summary', { from: '2026-12-07', to: '2026-12-01' })).status).toBe(400);
    expect((await q('summary', { from: '2026-12-01' })).status).toBe(400);
    expect((await q('summary', { from: '2025-01-01', to: '2026-12-01' })).status).toBe(400);
    const kitchen = await addMember(t, tenant, 'kitchen');
    expect((await t.http.get(`${base}/summary?from=2026-12-01&to=2026-12-07`).set(auth(kitchen))).status).toBe(403);
    expect((await t.http.get(`${base}/overview`).set(auth(kitchen))).status).toBe(403);
    expect((await t.http.post(`${base}/roi`).set(auth(kitchen)).send({ expectedUpliftPct: 1, subscriptionMonthlyCostMinor: 1 })).status).toBe(403);
    const marketer = await addMember(t, tenant, 'marketing');
    expect((await t.http.get(`${base}/marketing?from=2026-12-01&to=2026-12-07`).set(auth(marketer))).status).toBe(200);
    const other = await createTenant(t);
    expect((await t.http.get(`${base}/summary?from=2026-12-01&to=2026-12-07`).set(auth(other.owner))).status).toBe(404);
    const foreignBranch = await t.http.get(`/v1/o/${other.orgId}/analytics/summary?from=2026-12-01&to=2026-12-07&branchId=${tenant.branchId}`).set(auth(other.owner));
    expect(foreignBranch.status).toBe(404);
  });
});

/** Live operations, delivery/kitchen performance, sustainability and branch scope, on today's data. */
describe('operations, overview and branch scope', () => {
  let tenant: TestTenant;
  let menu: SeededMenu;
  let north: string;
  let base: string;
  let today: string;
  const tz = 'Africa/Cairo';
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    tenant = await createTenant(t, { country: 'EG' });
    menu = await seedMenu(tenant);
    north = await addBranch(t, tenant, 'North');
    base = `/v1/o/${tenant.orgId}/analytics`;
    today = (await sql(`select (now() at time zone $1)::date::text as d`, [tz]))[0].d;
    const soda = [{ productId: menu.products.soda, quantity: 1 }];
    const fries = [{ productId: menu.products.fries, quantity: 1 }];
    ids.P1 = (await placeOrder(t, tenant, { channel: 'staff', fulfillment: 'pickup', lines: soda })).id;
    for (const s of ['accepted', 'preparing', 'ready']) await transition(tenant, ids.P1, s);
    ids.P2 = (await placeOrder(t, tenant, { channel: 'web', fulfillment: 'delivery', lines: fries, customer: { phone: '+201007770001' }, deliveryAddress: { line1: '1 Nile St' } })).id;
    for (const s of ['accepted', 'preparing', 'ready']) await transition(tenant, ids.P2, s);
    ids.P3 = (await placeOrder(t, tenant, { channel: 'whatsapp', fulfillment: 'delivery', lines: fries, customer: { phone: '+201007770002' }, deliveryAddress: { line1: '2 Nile St' } })).id;
    ids.P4 = (await placeOrder(t, tenant, { branchId: north, channel: 'staff', fulfillment: 'pickup', lines: soda })).id;
    await sql(`update orders set accepted_at = placed_at + interval '2 minutes', ready_at = placed_at + interval '12 minutes' where id = $1`, [ids.P1]);
    await sql(`update orders set accepted_at = placed_at + interval '4 minutes', ready_at = placed_at + interval '20 minutes' where id = $1`, [ids.P2]);
    // Delivery jobs (ResutoDriver data) for P2 (delivered on time) and P3 (failed).
    const [driver] = await sql(`insert into drivers(org_id, display_name, status) values ($1, 'Karim', 'active') returning id`, [tenant.orgId]);
    await sql(
      `insert into delivery_jobs(org_id, branch_id, order_id, driver_id, status, dropoff, created_at, assigned_at, picked_up_at, delivered_at, eta_at)
       values ($1, $2, $3, $5, 'delivered', '{}', now() - interval '60 minutes', now() - interval '55 minutes', now() - interval '45 minutes', now() - interval '20 minutes', now() - interval '15 minutes'),
              ($1, $2, $4, $5, 'failed', '{}', now() - interval '60 minutes', now() - interval '50 minutes', null, null, null)`,
      [tenant.orgId, tenant.branchId, ids.P2, ids.P3, driver.id]);
    // Last week: one order at the start of the same weekday (counts towards "same time") and one at its very end (full day only).
    for (const [key, offset] of [['L1', '1 second'], ['L2', '23 hours 59 minutes 59 seconds']] as const) {
      ids[key] = (await placeOrder(t, tenant, { channel: 'staff', fulfillment: 'pickup', lines: fries })).id;
      for (const s of ['accepted', 'preparing', 'ready', 'picked_up']) await transition(tenant, ids[key]!, s);
      await sql(`update orders set placed_at = ((now() at time zone $2)::date - 7)::timestamp at time zone $2 + $3::interval where id = $1`, [ids[key], tz, offset]);
    }
    await sql(`insert into visits(org_id, branch_id, table_id, guest_token_hash) values ($1, $2, $3, md5(random()::text))`, [tenant.orgId, tenant.branchId, menu.tableId]);
    await sql(
      `insert into reservations(org_id, branch_id, guest_name, party_size, starts_at, ends_at, blocked_until, status)
       select $1, $2, 'Guest', 4, s, s + interval '90 minutes', s + interval '105 minutes', 'confirmed'
         from (select ((now() at time zone $3)::date)::timestamp at time zone $3 + interval '12 hours' as s) x`, [tenant.orgId, tenant.branchId, tz]);
    const inv = `/v1/o/${tenant.orgId}/inventory`;
    const item = await t.http.post(`${inv}/items`).set(auth(tenant.owner)).send({ name: 'Lemons', unit: 'kg', costPerUnitMinor: 1000, reorderLevel: 5 });
    await t.http.post(`${inv}/movements`).set(auth(tenant.owner)).send({ kind: 'purchase', branchId: tenant.branchId, itemId: item.body.id, quantity: 2 });
    await t.http.post(`${inv}/movements`).set(auth(tenant.owner)).send({ kind: 'waste', branchId: tenant.branchId, itemId: item.body.id, quantity: 500, unit: 'g', reason: 'spoiled' });
  });

  it('serves the owner home: today vs the same weekday last week, live orders, visits, reservations, low stock', async () => {
    const res = await t.http.get(`${base}/overview`).set(auth(tenant.owner));
    expect(res.status).toBe(200);
    expect(res.body.date).toBe(today);
    // P1 2500 + P2 (4500 + 2500 delivery) + P3 7000 + P4 2500
    expect(res.body.today).toMatchObject({ orders: 4, netMinor: 19000, averageOrderMinor: 4750 });
    expect(res.body.lastWeekSameTime).toMatchObject({ orders: 1, netMinor: 4500 });
    expect(res.body.lastWeekFullDay).toMatchObject({ orders: 2, netMinor: 9000 });
    expect(res.body.changePct.orders).toBe(300);
    expect(res.body.hourly.reduce((a: number, h: any) => a + h.todayNetMinor, 0)).toBe(19000);
    expect(res.body.live).toMatchObject({ openOrders: 4, byStatus: { ready: 2, placed: 2 }, openVisits: 1 });
    expect(res.body.reservationsToday).toMatchObject({ total: 1, guests: 4 });
    expect(res.body.lowStock.count).toBe(1);
    expect(res.body.lowStock.items[0]).toMatchObject({ name: 'Lemons', quantity: 1.5 });
    expect(res.body.meta.method).toMatch(/same weekday/);
  });

  it('measures kitchen and delivery performance', async () => {
    const res = await t.http.get(`${base}/operations?from=${today}&to=${today}`).set(auth(tenant.owner));
    expect(res.status).toBe(200);
    expect(res.body.kitchen).toMatchObject({ ordersMeasured: 2, placedToReadyAvgMinutes: 16, placedToReadyP50Minutes: 16, placedToAcceptedAvgMinutes: 3 });
    expect(res.body.delivery).toMatchObject({ jobs: 2, delivered: 1, failed: 1, failureRatePct: 50, assignmentAvgMinutes: 7.5,
      pickupToDeliveredAvgMinutes: 25, onTimePct: 100, onTimeMeasured: 1 });
    expect(res.body.meta.dataCoverage).toMatchObject({ countedOrders: 4, ordersWithoutReadyTime: 2 });
  });

  it('reports measured food waste and a labelled paper indicator', async () => {
    const plain = await t.http.get(`${base}/sustainability?from=${today}&to=${today}`).set(auth(tenant.owner));
    expect(plain.status).toBe(200);
    expect(plain.body.foodWaste).toMatchObject({ valueMinor: 500, massKg: 0.5 });
    expect(plain.body.paper).toMatchObject({ digitalOrders: 2, electronicFiscalDocuments: 0, printedTicketsAvoidedIndicator: 2, estimatedPaperGrams: null });
    expect(plain.body.meta).toMatchObject({ kind: 'measured', assumptions: [] });
    const est = await t.http.get(`${base}/sustainability?from=${today}&to=${today}&gramsPerSheet=4.5`).set(auth(tenant.owner));
    expect(est.body.paper).toMatchObject({ estimatedPaperGrams: 9, estimateLabel: expect.stringMatching(/not a measurement/) });
    expect(est.body.meta.kind).toBe('mixed');
    expect(est.body.meta.assumptions).toContainEqual({ key: 'gramsPerSheet', value: 4.5, source: 'caller' });
  });

  it('shows a branch-scoped manager only their branch', async () => {
    const manager = await addMember(t, tenant, 'manager', [tenant.branchId]);
    const ov = await t.http.get(`${base}/overview`).set(auth(manager));
    expect(ov.body.today.orders).toBe(3);
    const sum = await t.http.get(`${base}/summary?from=${today}&to=${today}`).set(auth(manager));
    expect(sum.body.totals.orders).toBe(3);
    expect(sum.body.byBranch.map((b: any) => b.key)).toEqual([tenant.branchId]);
    const owner = await t.http.get(`${base}/summary?from=${today}&to=${today}`).set(auth(tenant.owner));
    expect(owner.body.totals.orders).toBe(4);
    expect((await t.http.get(`${base}/summary?from=${today}&to=${today}&branchId=${north}`).set(auth(manager))).status).toBe(403);
    expect((await t.http.get(`${base}/overview?branchId=${north}`).set(auth(manager))).status).toBe(403);
  });
});
