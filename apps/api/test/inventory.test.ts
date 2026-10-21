import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EventDispatcher } from '../src/common/events/dispatcher.service';
import { addMember, auth, bootTestApp, createTenant, seedMenu, sql, type SeededMenu, type TestApp, type TestTenant, type TestUser } from './helpers';
import { addBranch, placeOrder } from './insights-fixtures';

let t: TestApp;
let tenant: TestTenant;
let menu: SeededMenu;
let branchB: string;
let base: string;
const items: Record<string, string> = {};

beforeAll(async () => {
  t = await bootTestApp();
  tenant = await createTenant(t, { country: 'EG' });
  menu = await seedMenu(tenant);
  branchB = await addBranch(t, tenant, 'North');
  base = `/v1/o/${tenant.orgId}/inventory`;
});
afterAll(async () => { await t.close(); });

const owner = () => auth(tenant.owner);
const move = (body: Record<string, unknown>, who: { token: string } = tenant.owner, key?: string) => {
  const req = t.http.post(`${base}/movements`).set(auth(who));
  return (key ? req.set('Idempotency-Key', key) : req).send(body);
};
const level = async (branchId: string, itemId: string) => {
  const res = await t.http.get(`${base}/levels?branchId=${branchId}`).set(owner());
  expect(res.status).toBe(200);
  return res.body.items.find((l: any) => l.itemId === itemId)?.quantity as number;
};
/** Invariant: every stock level equals the sum of its movements. */
const assertLedgerConsistent = async () => {
  const rows = await sql(
    `select sl.branch_id, sl.item_id, sl.quantity::text as level, coalesce(sum(m.quantity_delta), 0)::text as moved
       from stock_levels sl left join stock_movements m on m.branch_id = sl.branch_id and m.item_id = sl.item_id
      where sl.org_id = $1 group by 1, 2, 3`, [tenant.orgId]);
  for (const r of rows) expect(Number(r.level)).toBeCloseTo(Number(r.moved), 3);
};

describe('items and suppliers', () => {
  it('creates suppliers and items and validates input', async () => {
    const sup = await t.http.post(`${base}/suppliers`).set(owner()).send({ name: 'Nile Mills', phone: '+20221234567' });
    expect(sup.status).toBe(201);
    const mk = async (name: string, unit: string, costPerUnitMinor: number, reorderLevel: number, supplierId?: string) => {
      const res = await t.http.post(`${base}/items`).set(owner()).send({ name, unit, costPerUnitMinor, reorderLevel, supplierId });
      expect(res.status).toBe(201);
      return res.body.id as string;
    };
    items.flour = await mk('Flour', 'kg', 3000, 2, sup.body.id);
    items.beef = await mk('Beef', 'kg', 40000, 1);
    items.buns = await mk('Buns', 'pcs', 500, 10);
    items.oil = await mk('Oil', 'l', 9000, 0);
    const bad = await t.http.post(`${base}/items`).set(owner()).send({ name: 'Salt', unit: 'cups', costPerUnitMinor: 1 });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('validation_failed');
    const dup = await t.http.post(`${base}/items`).set(owner()).send({ name: 'Flour', unit: 'kg', costPerUnitMinor: 1 });
    expect(dup.status).toBe(409);
    const list = await t.http.get(`${base}/items`).set(owner());
    expect(list.body.items.map((i: any) => i.name)).toEqual(['Beef', 'Buns', 'Flour', 'Oil']);
    expect(list.body.items.find((i: any) => i.name === 'Flour').supplierName).toBe('Nile Mills');
    const audit = await sql(`select action from audit_logs where org_id = $1 and action like 'inventory.%' order by id`, [tenant.orgId]);
    expect(audit.map((a) => a.action)).toContain('inventory.item_created');
  });
});

describe('movements keep levels consistent', () => {
  it('records purchases with unit conversion and moving-average cost', async () => {
    const a = await move({ kind: 'purchase', branchId: tenant.branchId, itemId: items.flour, quantity: 10, unitCostMinor: 3000 });
    expect(a.status).toBe(201);
    expect(a.body.quantityAfter).toBe(10);
    // 500 g into a kg item, at 4000/kg: average (10 × 3000 + 0.5 × 4000) / 10.5 = 3047.6 → 3048
    const b = await move({ kind: 'purchase', branchId: tenant.branchId, itemId: items.flour, quantity: 500, unit: 'g', unitCostMinor: 4000 });
    expect(b.status).toBe(201);
    expect(b.body.quantityDelta).toBe(0.5);
    expect(b.body.itemCostPerUnitMinor).toBe(3048);
    expect(await level(tenant.branchId, items.flour)).toBe(10.5);
    const wrongUnit = await move({ kind: 'purchase', branchId: tenant.branchId, itemId: items.flour, quantity: 2, unit: 'pcs' });
    expect(wrongUnit.status).toBe(422);
    expect(wrongUnit.body.error.code).toBe('incompatible_unit');
  });

  it('records waste with a reason and refuses to go below zero', async () => {
    const noReason = await move({ kind: 'waste', branchId: tenant.branchId, itemId: items.flour, quantity: 1 });
    expect(noReason.status).toBe(400);
    const w = await move({ kind: 'waste', branchId: tenant.branchId, itemId: items.flour, quantity: 1, reason: 'expired', note: 'damp sacks' });
    expect(w.status).toBe(201);
    expect(w.body.quantityAfter).toBe(9.5);
    const tooMuch = await move({ kind: 'waste', branchId: tenant.branchId, itemId: items.flour, quantity: 100, reason: 'spoiled' });
    expect(tooMuch.status).toBe(409);
    expect(tooMuch.body.error.code).toBe('insufficient_stock');
    const adj = await move({ kind: 'adjustment', branchId: tenant.branchId, itemId: items.flour, quantityDelta: -0.5, note: 'spill' });
    expect(adj.status).toBe(201);
    expect(await level(tenant.branchId, items.flour)).toBe(9);
  });

  it('transfers between branches as two paired movements in one transaction', async () => {
    const tr = await move({ kind: 'transfer', fromBranchId: tenant.branchId, toBranchId: branchB, itemId: items.flour, quantity: 4 });
    expect(tr.status).toBe(201);
    expect(tr.body.out.quantityAfter).toBe(5);
    expect(tr.body.in.quantityAfter).toBe(4);
    const legs = await sql(`select branch_id, reason, quantity_delta::text as q from stock_movements where reference_type = 'transfer' and reference_id = $1 order by reason`,
      [tr.body.transferId]);
    expect(legs).toEqual([
      { branch_id: branchB, reason: 'transfer_in', q: '4.000' },
      { branch_id: tenant.branchId, reason: 'transfer_out', q: '-4.000' },
    ]);
    // An impossible transfer changes nothing on either side.
    const fail = await move({ kind: 'transfer', fromBranchId: tenant.branchId, toBranchId: branchB, itemId: items.flour, quantity: 50 });
    expect(fail.status).toBe(409);
    expect(await level(tenant.branchId, items.flour)).toBe(5);
    expect(await level(branchB, items.flour)).toBe(4);
    const same = await move({ kind: 'transfer', fromBranchId: branchB, toBranchId: branchB, itemId: items.flour, quantity: 1 });
    expect(same.status).toBe(400);
    await assertLedgerConsistent();
  });

  it('records a stocktake with its variance (including zero-variance counts)', async () => {
    const c = await move({ kind: 'count', branchId: tenant.branchId, itemId: items.flour, countedQuantity: 4.75 });
    expect(c.status).toBe(201);
    expect(c.body).toMatchObject({ expectedQuantity: 5, countedQuantity: 4.75, variance: -0.25, quantityAfter: 4.75 });
    expect(c.body.varianceValueMinor).toBe(Math.round(-0.25 * 3048));
    const take = await t.http.post(`${base}/stocktakes`).set(owner()).send({ branchId: branchB, lines: [{ itemId: items.flour, countedQuantity: 4000, unit: 'g' }] });
    expect(take.status).toBe(201);
    expect(take.body.lines[0]).toMatchObject({ variance: 0, movementId: null });
    const counts = await sql(`select branch_id, variance::text as v from stock_counts where item_id = $1 order by created_at`, [items.flour]);
    expect(counts).toEqual([{ branch_id: tenant.branchId, v: '-0.250' }, { branch_id: branchB, v: '0.000' }]);
    const lv = await t.http.get(`${base}/levels?branchId=${branchB}`).set(owner());
    expect(lv.body.items.find((l: any) => l.itemId === items.flour).lastCountedAt).toBeTruthy();
    await assertLedgerConsistent();
  });

  it('replays retried movements with the same idempotency key exactly once', async () => {
    const body = { kind: 'purchase', branchId: tenant.branchId, itemId: items.oil, quantity: 3, unitCostMinor: 9000 };
    const first = await move(body, tenant.owner, 'oil-purchase-0001');
    const retry = await move(body, tenant.owner, 'oil-purchase-0001');
    expect(first.status).toBe(201);
    expect(retry.body.movementId).toBe(first.body.movementId);
    expect(await level(tenant.branchId, items.oil)).toBe(3);
    const reused = await move({ ...body, quantity: 4 }, tenant.owner, 'oil-purchase-0001');
    expect(reused.status).toBe(409);
    expect(reused.body.error.code).toBe('idempotency_key_reused');
  });

  it('lists movements newest first with filters and a cursor', async () => {
    const page = await t.http.get(`${base}/movements?itemId=${items.flour}&branchId=${tenant.branchId}&limit=2`).set(owner());
    expect(page.status).toBe(200);
    expect(page.body.items.map((m: any) => m.reason)).toEqual(['count', 'transfer_out']);
    const next = await t.http.get(`${base}/movements?itemId=${items.flour}&branchId=${tenant.branchId}&limit=2&cursor=${page.body.nextCursor}`).set(owner());
    expect(next.body.items.map((m: any) => m.reason)).toEqual(['adjustment', 'waste']);
    const waste = await t.http.get(`${base}/movements?reason=waste`).set(owner());
    expect(waste.body.items[0]).toMatchObject({ wasteReason: 'expired', unitCostMinor: 3048, quantityDelta: -1 });
  });
});

describe('recipes and kernel sales', () => {
  it('validates recipe units and deducts ingredients when the kernel places an order', async () => {
    const bad = await t.http.put(`${base}/recipes/${menu.products.burger}`).set(owner()).send({ components: [{ itemId: items.beef, quantity: 150, unit: 'ml' }] });
    expect(bad.status).toBe(422);
    expect(bad.body.error.code).toBe('incompatible_unit');
    const set = await t.http.put(`${base}/recipes/${menu.products.burger}`).set(owner()).send({
      components: [{ itemId: items.beef, quantity: 150, unit: 'g' }, { itemId: items.buns, quantity: 1, unit: 'pcs' }],
    });
    expect(set.status).toBe(200);
    expect(set.body.components.find((c: any) => c.itemId === items.beef)).toMatchObject({ quantity: 0.15, unit: 'kg', costMinor: 6000 });
    expect(set.body.recipeCostMinor).toBe(6500);
    const list = await t.http.get(`${base}/recipes`).set(owner());
    expect(list.body.items.find((r: any) => r.productId === menu.products.burger)).toMatchObject({ components: 2, recipeCostMinor: 6500 });

    await move({ kind: 'purchase', branchId: tenant.branchId, itemId: items.beef, quantity: 1.2 });
    await move({ kind: 'purchase', branchId: tenant.branchId, itemId: items.buns, quantity: 13 });
    const order = await placeOrder(t, tenant, { channel: 'staff', fulfillment: 'pickup',
      lines: [{ productId: menu.products.burger, quantity: 2, modifiers: [{ groupId: menu.groups.size, optionId: menu.options.regular }] }] });
    const sales = await sql(`select item_id, quantity_delta::text as q from stock_movements where reference_id = $1 and reason = 'sale' order by item_id`, [order.id]);
    expect(Object.fromEntries(sales.map((s) => [s.item_id, s.q]))).toEqual({ [items.beef]: '-0.300', [items.buns]: '-2.000' });
    expect(await level(tenant.branchId, items.beef)).toBe(0.9);
    expect(await level(tenant.branchId, items.buns)).toBe(11);
    await assertLedgerConsistent();
  });

  it('shows on the menu how many portions the ingredients on hand can make, per branch (PAR-03)', async () => {
    const view = await t.http.get(`/v1/o/${tenant.orgId}/menu`).set(owner());
    expect(view.status).toBe(200);
    const burger = view.body.products.find((p: any) => p.id === menu.products.burger);
    // 0.9 kg beef / 0.15 kg = 6, 11 buns / 1 = 11: the scarcest ingredient decides. The North branch holds no stock.
    const byBranch = Object.fromEntries(burger.recipePortions.map((r: any) => [r.branchId, r.portions]));
    expect(byBranch[tenant.branchId]).toBe(6);
    expect(byBranch[branchB]).toBe(0);
    // A dish without a recipe is not tracked by ingredients: null, not zero.
    const other = view.body.products.find((p: any) => p.id !== menu.products.burger);
    expect(other.recipePortions).toBeNull();
    // A negative stock level (sold past zero) never reads as negative portions.
    await move({ kind: 'adjustment', branchId: branchB, itemId: items.buns, quantityDelta: -3, note: 'count correction' });
    const again = await t.http.get(`/v1/o/${tenant.orgId}/menu`).set(owner());
    const north = again.body.products.find((p: any) => p.id === menu.products.burger).recipePortions.find((r: any) => r.branchId === branchB);
    expect(north.portions).toBe(0);
  });
});

describe('low-stock detection', () => {
  const lowEvents = async (itemId: string) =>
    (await sql(`select payload from outbox_events where event_type = 'stock.low' and aggregate_id = $1 order by created_at`, [itemId])).map((r) => r.payload);

  it('emits stock.low once per item per breach, including breaches caused by kernel sales', async () => {
    const dispatcher = t.app.get(EventDispatcher);
    await dispatcher.drain();
    // Beef fell to 0.9 kg (reorder level 1) through the sale above: the worker reaction opens one alert.
    expect(await lowEvents(items.beef)).toHaveLength(1);
    expect((await lowEvents(items.beef))[0]).toMatchObject({ branchId: tenant.branchId, quantity: 0.9, reorderLevel: 1, itemName: 'Beef' });
    // Buns at 11 (reorder 10) are fine; one more order takes them to 9 → breach.
    await placeOrder(t, tenant, { channel: 'staff', fulfillment: 'pickup',
      lines: [{ productId: menu.products.burger, quantity: 2, modifiers: [{ groupId: menu.groups.size, optionId: menu.options.regular }] }] });
    await dispatcher.drain();
    expect(await lowEvents(items.buns)).toHaveLength(1);
    expect(await lowEvents(items.beef)).toHaveLength(1); // still the same breach: deduplicated
    // Re-processing the same events (at-least-once delivery) does not duplicate alerts.
    await sql(`update outbox_events set published_at = null where event_type = 'order.placed' and org_id = $1`, [tenant.orgId]);
    await sql(`delete from event_handlings where handler = 'inventory.low_stock_after_order'`);
    await dispatcher.drain();
    expect(await lowEvents(items.beef)).toHaveLength(1);

    const alerts = await t.http.get(`${base}/alerts`).set(owner());
    expect(alerts.body.items.map((a: any) => a.name).sort()).toEqual(['Beef', 'Buns']);

    // Restocking resolves the alert; the next breach is reported again.
    const restock = await move({ kind: 'purchase', branchId: tenant.branchId, itemId: items.buns, quantity: 20 });
    expect(restock.body.lowStockAlertsOpened).toEqual([]);
    expect((await t.http.get(`${base}/alerts`).set(owner())).body.items.map((a: any) => a.name)).toEqual(['Beef']);
    const drop = await move({ kind: 'waste', branchId: tenant.branchId, itemId: items.buns, quantity: 25, reason: 'damaged' });
    expect(drop.body.lowStockAlertsOpened).toHaveLength(1);
    expect(await lowEvents(items.buns)).toHaveLength(2);
    // Raising a reorder level is itself evaluated.
    await t.http.patch(`${base}/items/${items.oil}`).set(owner()).send({ reorderLevel: 5 });
    expect(await lowEvents(items.oil)).toHaveLength(1);
  });
});

describe('valuation and waste report', () => {
  it('values stock at quantity × cost per branch', async () => {
    const v = await t.http.get(`${base}/valuation`).set(owner());
    expect(v.status).toBe(200);
    const lv = (await t.http.get(`${base}/levels`).set(owner())).body.items as any[];
    const expected = (b: string) => lv.filter((l) => l.branchId === b).reduce((a, l) => a + Math.round(Math.max(l.quantity, 0) * l.costPerUnitMinor), 0);
    const main = v.body.branches.find((b: any) => b.branchId === tenant.branchId);
    expect(main.valueMinor).toBe(expected(tenant.branchId));
    // North: 4 kg flour at 3048
    expect(v.body.branches.find((b: any) => b.branchId === branchB).valueMinor).toBe(4 * 3048);
    expect(v.body.totalValueMinor).toBe(expected(tenant.branchId) + 4 * 3048);
    expect(v.body.meta).toMatchObject({ kind: 'measured' });
  });

  it('reports measured waste only, with value and mass', async () => {
    const today = (await sql(`select (now() at time zone 'Africa/Cairo')::date::text as d`))[0].d;
    const r = await t.http.get(`${base}/waste-report?from=${today}&to=${today}`).set(owner());
    expect(r.status).toBe(200);
    // 1 kg flour at 3048 + 25 buns at 500
    expect(r.body.totals).toMatchObject({ valueMinor: 3048 + 12500, massKg: 1, pieces: 25, entries: 2 });
    expect(r.body.byReason).toEqual([{ reason: 'damaged', valueMinor: 12500 }, { reason: 'expired', valueMinor: 3048 }]);
    expect(r.body.meta.method).toMatch(/Only waste movements/);
    const north = await t.http.get(`${base}/waste-report?from=${today}&to=${today}&branchId=${branchB}`).set(owner());
    expect(north.body.totals.valueMinor).toBe(0);
  });
});

describe('access control', () => {
  let kitchen: TestUser;
  let waiter: TestUser;
  let northManager: TestUser;
  beforeAll(async () => {
    kitchen = await addMember(t, tenant, 'kitchen');
    waiter = await addMember(t, tenant, 'waiter');
    northManager = await addMember(t, tenant, 'manager', [branchB]);
  });

  it('lets kitchen read but not write, and blocks roles without inventory access', async () => {
    expect((await t.http.get(`${base}/levels`).set(auth(kitchen))).status).toBe(200);
    expect((await move({ kind: 'waste', branchId: tenant.branchId, itemId: items.flour, quantity: 0.1, reason: 'spoiled' }, kitchen)).status).toBe(403);
    expect((await t.http.get(`${base}/levels`).set(auth(waiter))).status).toBe(403);
  });

  it('limits branch-scoped managers to their branches', async () => {
    const lv = await t.http.get(`${base}/levels`).set(auth(northManager));
    expect(lv.status).toBe(200);
    expect(new Set(lv.body.items.map((l: any) => l.branchId))).toEqual(new Set([branchB]));
    expect((await t.http.get(`${base}/levels?branchId=${tenant.branchId}`).set(auth(northManager))).status).toBe(403);
    expect((await move({ kind: 'purchase', branchId: tenant.branchId, itemId: items.flour, quantity: 1 }, northManager)).status).toBe(403);
    expect((await move({ kind: 'transfer', fromBranchId: branchB, toBranchId: tenant.branchId, itemId: items.flour, quantity: 1 }, northManager)).status).toBe(403);
    const ok = await move({ kind: 'purchase', branchId: branchB, itemId: items.flour, quantity: 1 }, northManager);
    expect(ok.status).toBe(201);
    const alerts = await t.http.get(`${base}/alerts`).set(auth(northManager));
    expect(alerts.body.items).toEqual([]);
  });

  it('hides other tenants behind 404', async () => {
    const other = await createTenant(t);
    expect((await t.http.get(`${base}/items`).set(auth(other.owner))).status).toBe(404);
    const foreign = await t.http.post(`/v1/o/${other.orgId}/inventory/movements`).set(auth(other.owner))
      .send({ kind: 'purchase', branchId: other.branchId, itemId: items.flour, quantity: 1 });
    expect(foreign.status).toBe(404);
    const foreignRecipe = await t.http.get(`/v1/o/${other.orgId}/inventory/recipes/${menu.products.burger}`).set(auth(other.owner));
    expect(foreignRecipe.status).toBe(404);
  });
});
