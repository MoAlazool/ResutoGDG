import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import {
  convertQuantity, unitsCompatible, type InventoryItemInput, type InventoryUnit, type RecipeInput, type StockLevelView,
  type StockMovementInput, type StockMovementView, type SupplierInput,
} from '@resuto/contracts';
import { z } from 'zod';
import type { TenantContext } from '../../common/auth/context';
import type { Tx } from '../../common/db/db.service';
import { DomainError, conflict, invalid, notFound } from '../../common/errors/domain-error';
import { AuditService } from '../../common/platform/audit.service';
import { branchScope, int, iso, num, TZ } from '../analytics/scope';
import type { inventoryItemUpdate, movementListQuery, stocktakeInput, supplierUpdate, wasteReportQuery } from '@resuto/contracts';
import { StockAlertsService } from './stock-alerts.service';
import { escapeLike } from '../mcp/mcp.util';

interface ItemRow { id: string; name: string; unit: InventoryUnit; cost_per_unit_minor: number; reorder_level: string; is_active: boolean }

const round3 = (n: number) => Math.round(n * 1000) / 1000;

/** Inventory items, suppliers, stock levels, movements, stocktakes and recipes. */
@Injectable()
export class InventoryService {
  constructor(private readonly audit: AuditService, private readonly alerts: StockAlertsService) {}

  // -------------------------------------------------------------------------
  // Suppliers
  // -------------------------------------------------------------------------
  async listSuppliers(tx: Tx, ctx: TenantContext) {
    const rows = await tx.query(`select s.*, (select count(*)::int from inventory_items i where i.supplier_id = s.id and i.is_active) as item_count
                                   from suppliers s where s.org_id = $1 order by lower(s.name)`, [ctx.orgId]);
    return { items: rows.map(mapSupplier), nextCursor: null };
  }

  async createSupplier(tx: Tx, ctx: TenantContext, input: SupplierInput) {
    const row = await tx.one(`insert into suppliers(org_id, name, phone, email, notes) values ($1, $2, $3, $4, $5) returning *, 0 as item_count`,
      [ctx.orgId, input.name, input.phone ?? null, input.email ?? null, input.notes ?? null]);
    await this.audit.record(tx, ctx, { action: 'inventory.supplier_created', entityType: 'supplier', entityId: row.id, metadata: { name: input.name } });
    return mapSupplier(row);
  }

  async updateSupplier(tx: Tx, ctx: TenantContext, id: string, input: z.infer<typeof supplierUpdate>) {
    const row = await tx.maybeOne(
      `update suppliers set name = coalesce($3, name), phone = case when $4 then $5 else phone end,
              email = case when $6 then $7::citext else email end, notes = case when $8 then $9 else notes end
        where id = $1 and org_id = $2 returning *, 0 as item_count`,
      [id, ctx.orgId, input.name ?? null, input.phone !== undefined, input.phone ?? null, input.email !== undefined, input.email ?? null,
        input.notes !== undefined, input.notes ?? null]);
    if (!row) throw notFound('Supplier');
    await this.audit.record(tx, ctx, { action: 'inventory.supplier_updated', entityType: 'supplier', entityId: id, metadata: { fields: Object.keys(input) } });
    return mapSupplier(row);
  }

  // -------------------------------------------------------------------------
  // Items
  // -------------------------------------------------------------------------
  async listItems(tx: Tx, ctx: TenantContext, opts: { includeArchived?: boolean; q?: string }) {
    const scope = branchScope(ctx);
    const rows = await tx.query(
      `select i.*, s.name as supplier_name,
              coalesce((select sum(sl.quantity) from stock_levels sl where sl.item_id = i.id and ($3::uuid[] is null or sl.branch_id = any($3))), 0) as total_quantity
         from inventory_items i left join suppliers s on s.id = i.supplier_id
        where i.org_id = $1 and ($2 or i.is_active) and ($4::text is null or i.name ilike '%' || $4 || '%' or i.name_ar ilike '%' || $4 || '%' or i.sku ilike $4 || '%')
        order by lower(i.name)`, [ctx.orgId, !!opts.includeArchived, scope, opts.q?.trim() ? escapeLike(opts.q.trim()) : null]);
    return { items: rows.map(mapItem), nextCursor: null };
  }

  async createItem(tx: Tx, ctx: TenantContext, input: InventoryItemInput) {
    if (input.supplierId) await this.supplierExists(tx, ctx, input.supplierId);
    const row = await tx.one(
      `insert into inventory_items(org_id, name, name_ar, sku, unit, cost_per_unit_minor, reorder_level, supplier_id)
       values ($1, $2, $3, $4, $5, $6, $7, $8) returning *, null::text as supplier_name, 0 as total_quantity`,
      [ctx.orgId, input.name, input.nameAr ?? null, input.sku ?? null, input.unit, input.costPerUnitMinor, input.reorderLevel, input.supplierId ?? null]);
    await this.audit.record(tx, ctx, { action: 'inventory.item_created', entityType: 'inventory_item', entityId: row.id,
      metadata: { name: input.name, unit: input.unit, costPerUnitMinor: input.costPerUnitMinor } });
    return mapItem(row);
  }

  async updateItem(tx: Tx, ctx: TenantContext, id: string, input: z.infer<typeof inventoryItemUpdate>) {
    if (input.supplierId) await this.supplierExists(tx, ctx, input.supplierId);
    const before = await this.item(tx, ctx, id, true);
    const has = (k: keyof typeof input) => input[k] !== undefined;
    const row = await tx.one(
      `update inventory_items set name = coalesce($2, name), name_ar = case when $3 then $4 else name_ar end,
              sku = case when $5 then $6 else sku end, cost_per_unit_minor = coalesce($7, cost_per_unit_minor),
              reorder_level = coalesce($8, reorder_level), supplier_id = case when $9 then $10::uuid else supplier_id end,
              is_active = coalesce($11, is_active)
        where id = $1 returning *, null::text as supplier_name,
              coalesce((select sum(quantity) from stock_levels where item_id = $1), 0) as total_quantity`,
      [id, input.name ?? null, has('nameAr'), input.nameAr ?? null, has('sku'), input.sku ?? null, input.costPerUnitMinor ?? null,
        input.reorderLevel ?? null, has('supplierId'), input.supplierId ?? null, input.isActive ?? null]);
    await this.audit.record(tx, ctx, { action: 'inventory.item_updated', entityType: 'inventory_item', entityId: id,
      metadata: { fields: Object.keys(input), before: { costPerUnitMinor: before.cost_per_unit_minor, reorderLevel: num(before.reorder_level), isActive: before.is_active } } });
    if (has('reorderLevel') || has('isActive')) await this.alerts.evaluate(tx, ctx.orgId, null, [id]);
    return mapItem(row);
  }

  // -------------------------------------------------------------------------
  // Levels, valuation, alerts
  // -------------------------------------------------------------------------
  async levels(tx: Tx, ctx: TenantContext, branchId?: string): Promise<{ items: StockLevelView[]; nextCursor: null }> {
    const scope = branchScope(ctx, branchId);
    const rows = await tx.query(
      `select i.id as item_id, i.name, i.name_ar, i.unit, i.reorder_level, i.cost_per_unit_minor, b.id as branch_id,
              coalesce(sl.quantity, 0) as quantity,
              (select max(c.created_at) from stock_counts c where c.branch_id = b.id and c.item_id = i.id) as last_counted_at
         from inventory_items i
         cross join branches b
         left join stock_levels sl on sl.item_id = i.id and sl.branch_id = b.id
        where i.org_id = $1 and b.org_id = $1 and i.is_active and b.is_active and ($2::uuid[] is null or b.id = any($2))
        order by b.name, lower(i.name)`, [ctx.orgId, scope]);
    return {
      items: rows.map((r) => {
        const quantity = num(r.quantity);
        const reorderLevel = num(r.reorder_level);
        return {
          itemId: r.item_id, name: r.name, nameAr: r.name_ar, unit: r.unit, branchId: r.branch_id, quantity, reorderLevel,
          costPerUnitMinor: r.cost_per_unit_minor, valueMinor: Math.round(Math.max(quantity, 0) * r.cost_per_unit_minor),
          low: reorderLevel > 0 && quantity <= reorderLevel, lastCountedAt: iso(r.last_counted_at),
        };
      }),
      nextCursor: null,
    };
  }

  async valuation(tx: Tx, ctx: TenantContext, branchId?: string) {
    const scope = branchScope(ctx, branchId);
    const rows = await tx.query(
      `select b.id as branch_id, b.name as branch_name,
              coalesce(sum(round(greatest(sl.quantity, 0) * i.cost_per_unit_minor)), 0)::bigint as value_minor,
              count(sl.item_id) filter (where sl.quantity > 0)::int as items_in_stock,
              count(sl.item_id) filter (where sl.quantity < 0)::int as negative_levels,
              count(sl.item_id) filter (where i.cost_per_unit_minor = 0 and sl.quantity > 0)::int as items_without_cost
         from branches b
         left join stock_levels sl on sl.branch_id = b.id
         left join inventory_items i on i.id = sl.item_id and i.is_active
        where b.org_id = $1 and b.is_active and ($2::uuid[] is null or b.id = any($2))
        group by b.id, b.name order by b.name`, [ctx.orgId, scope]);
    const branches = rows.map((r) => ({ branchId: r.branch_id, branchName: r.branch_name, valueMinor: int(r.value_minor),
      itemsInStock: r.items_in_stock, negativeLevels: r.negative_levels, itemsWithoutCost: r.items_without_cost }));
    const currency = (await tx.one<{ currency: string }>('select currency from organizations where id = $1', [ctx.orgId])).currency;
    return {
      currency,
      totalValueMinor: branches.reduce((a, b) => a + b.valueMinor, 0),
      branches,
      meta: {
        kind: 'measured', method: 'Sum over branches of max(stock level, 0) × current item cost per unit (moving-average purchase cost), rounded per item to minor units. Negative levels (sales recorded before purchases) are valued at zero and counted.',
        assumptions: [], dataCoverage: {
          negativeLevels: branches.reduce((a, b) => a + b.negativeLevels, 0),
          itemsWithoutCost: branches.reduce((a, b) => a + b.itemsWithoutCost, 0),
        },
        timezone: 'n/a', generatedAt: new Date().toISOString(),
      },
    };
  }

  async openAlerts(tx: Tx, ctx: TenantContext, branchId?: string) {
    const scope = branchScope(ctx, branchId);
    const rows = await tx.query(
      `select a.id, a.branch_id, a.item_id, a.quantity_at_open, a.reorder_level, a.opened_at, i.name, i.name_ar, i.unit,
              coalesce(sl.quantity, 0) as quantity, s.name as supplier_name, s.phone as supplier_phone
         from stock_alerts a join inventory_items i on i.id = a.item_id
         left join stock_levels sl on sl.branch_id = a.branch_id and sl.item_id = a.item_id
         left join suppliers s on s.id = i.supplier_id
        where a.org_id = $1 and a.status = 'open' and ($2::uuid[] is null or a.branch_id = any($2))
        order by a.opened_at desc limit 200`, [ctx.orgId, scope]);
    return {
      items: rows.map((r) => ({ id: r.id, branchId: r.branch_id, itemId: r.item_id, name: r.name, nameAr: r.name_ar, unit: r.unit,
        quantity: num(r.quantity), quantityAtOpen: num(r.quantity_at_open), reorderLevel: num(r.reorder_level), openedAt: iso(r.opened_at),
        supplierName: r.supplier_name, supplierPhone: r.supplier_phone })),
      nextCursor: null,
    };
  }

  // -------------------------------------------------------------------------
  // Movements
  // -------------------------------------------------------------------------
  async recordMovement(tx: Tx, ctx: TenantContext, input: StockMovementInput) {
    const item = await this.item(tx, ctx, input.itemId);
    if (!item.is_active) throw conflict('item_archived', 'This item is archived');
    const toItemUnit = (q: number) => (input.unit && input.unit !== item.unit ? this.convert(q, input.unit, item.unit) : round3(q));
    const actor = `${ctx.actorType}:${ctx.actorId}`;
    let result: Record<string, unknown>;
    switch (input.kind) {
      case 'purchase': {
        ctx.assertBranch(input.branchId);
        if (input.supplierId) await this.supplierExists(tx, ctx, input.supplierId);
        const q = toItemUnit(input.quantity);
        const unitCost = input.unitCostMinor ?? item.cost_per_unit_minor;
        // Moving weighted-average cost over the organization's on-hand quantity before this purchase.
        const onHand = await tx.one<{ q: string }>(`select coalesce(sum(greatest(quantity, 0)), 0) as q from stock_levels where item_id = $1`, [item.id]);
        const m = await this.applyDelta(tx, ctx, { branchId: input.branchId, item, delta: q, reason: 'purchase', unitCostMinor: unitCost,
          referenceType: input.supplierId ? 'supplier' : null, referenceId: input.supplierId ?? null, note: input.note ?? null, actor });
        if (input.unitCostMinor !== undefined && !input.keepItemCost) {
          const prevQty = num(onHand.q);
          const newCost = prevQty > 0 ? Math.round((prevQty * item.cost_per_unit_minor + q * unitCost) / (prevQty + q)) : unitCost;
          await tx.query(`update inventory_items set cost_per_unit_minor = $2 where id = $1`, [item.id, newCost]);
          m.itemCostPerUnitMinor = newCost;
        }
        result = m;
        break;
      }
      case 'waste': {
        ctx.assertBranch(input.branchId);
        const q = toItemUnit(input.quantity);
        result = await this.applyDelta(tx, ctx, { branchId: input.branchId, item, delta: -q, reason: 'waste', wasteReason: input.reason,
          unitCostMinor: item.cost_per_unit_minor, note: input.note ?? null, actor, requireAvailable: true });
        break;
      }
      case 'adjustment': {
        ctx.assertBranch(input.branchId);
        const d = input.unit && input.unit !== item.unit ? Math.sign(input.quantityDelta) * this.convert(Math.abs(input.quantityDelta), input.unit, item.unit) : round3(input.quantityDelta);
        if (d === 0) throw invalid('quantity_too_small', 'The adjustment rounds to zero in the item unit');
        result = await this.applyDelta(tx, ctx, { branchId: input.branchId, item, delta: d, reason: 'adjustment',
          unitCostMinor: item.cost_per_unit_minor, note: input.note ?? null, actor, requireAvailable: true });
        break;
      }
      case 'transfer': {
        ctx.assertBranch(input.fromBranchId);
        ctx.assertBranch(input.toBranchId);
        await this.branchExists(tx, ctx, input.toBranchId);
        const q = toItemUnit(input.quantity);
        const transferId = randomUUID();
        // Lock both level rows in a stable order so concurrent opposite transfers cannot deadlock.
        for (const b of [input.fromBranchId, input.toBranchId].sort()) await this.lockLevel(tx, ctx, b, item.id);
        const out = await this.applyDelta(tx, ctx, { branchId: input.fromBranchId, item, delta: -q, reason: 'transfer_out', unitCostMinor: item.cost_per_unit_minor,
          referenceType: 'transfer', referenceId: transferId, note: input.note ?? null, actor, requireAvailable: true });
        const inn = await this.applyDelta(tx, ctx, { branchId: input.toBranchId, item, delta: q, reason: 'transfer_in', unitCostMinor: item.cost_per_unit_minor,
          referenceType: 'transfer', referenceId: transferId, note: input.note ?? null, actor });
        result = { transferId, out, in: inn };
        break;
      }
      case 'count': {
        ctx.assertBranch(input.branchId);
        result = await this.count(tx, ctx, input.branchId, item, toItemUnit(input.countedQuantity), input.note ?? null);
        break;
      }
    }
    await this.audit.record(tx, ctx, {
      action: `inventory.movement_${input.kind}`, entityType: 'inventory_item', entityId: item.id,
      branchId: input.kind === 'transfer' ? input.fromBranchId : input.branchId,
      metadata: { ...input, itemUnit: item.unit },
    });
    const branches = input.kind === 'transfer' ? [input.fromBranchId, input.toBranchId] : [input.branchId];
    const low: string[] = [];
    for (const b of branches) low.push(...(await this.alerts.evaluate(tx, ctx.orgId, b, [item.id])).opened);
    return { kind: input.kind, itemId: item.id, unit: item.unit, ...result, lowStockAlertsOpened: low };
  }

  async stocktake(tx: Tx, ctx: TenantContext, input: z.infer<typeof stocktakeInput>) {
    ctx.assertBranch(input.branchId);
    await this.branchExists(tx, ctx, input.branchId);
    if (new Set(input.lines.map((l) => l.itemId)).size !== input.lines.length) throw invalid('duplicate_item', 'Each item may be counted once per stocktake');
    const lines = [];
    for (const l of input.lines) {
      const item = await this.item(tx, ctx, l.itemId);
      const counted = l.unit && l.unit !== item.unit ? this.convert(l.countedQuantity, l.unit, item.unit) : round3(l.countedQuantity);
      lines.push(await this.count(tx, ctx, input.branchId, item, counted, l.note ?? null));
    }
    const varianceValueMinor = lines.reduce((a, l) => a + l.varianceValueMinor, 0);
    await this.audit.record(tx, ctx, { action: 'inventory.stocktake', entityType: 'branch', entityId: input.branchId, branchId: input.branchId,
      metadata: { lines: lines.length, varianceValueMinor } });
    const alerts = await this.alerts.evaluate(tx, ctx.orgId, input.branchId, input.lines.map((l) => l.itemId));
    return { branchId: input.branchId, lines, varianceValueMinor, lowStockAlertsOpened: alerts.opened };
  }

  async listMovements(tx: Tx, ctx: TenantContext, q: z.infer<typeof movementListQuery>) {
    const scope = branchScope(ctx, q.branchId);
    const rows = await tx.query(
      `select m.*, i.name as item_name, i.unit from stock_movements m
         join inventory_items i on i.id = m.item_id
         join branches b on b.id = m.branch_id join organizations o on o.id = m.org_id
        where m.org_id = $1 and ($2::uuid[] is null or m.branch_id = any($2)) and ($3::uuid is null or m.item_id = $3)
          and ($4::text is null or m.reason = $4) and ($5::date is null or (m.created_at at time zone ${TZ})::date >= $5)
          and ($6::date is null or (m.created_at at time zone ${TZ})::date <= $6) and ($7::bigint is null or m.id < $7)
        order by m.id desc limit $8`,
      [ctx.orgId, scope, q.itemId ?? null, q.reason ?? null, q.from ?? null, q.to ?? null, q.cursor ? Number(q.cursor) : null, q.limit]);
    const items: StockMovementView[] = rows.map((r) => ({
      id: String(r.id), branchId: r.branch_id, itemId: r.item_id, itemName: r.item_name, unit: r.unit, quantityDelta: num(r.quantity_delta),
      reason: r.reason, wasteReason: r.waste_reason, unitCostMinor: r.unit_cost_minor, referenceType: r.reference_type,
      referenceId: r.reference_id, note: r.note, actorId: r.actor_id, createdAt: iso(r.created_at)!,
    }));
    return { items, nextCursor: rows.length === q.limit ? String(rows[rows.length - 1].id) : null };
  }

  // -------------------------------------------------------------------------
  // Recipes
  // -------------------------------------------------------------------------
  async listRecipes(tx: Tx, ctx: TenantContext) {
    const rows = await tx.query(
      `select p.id, p.name, p.name_ar, p.price_minor, p.cost_minor, p.is_active,
              count(rc.item_id)::int as components,
              coalesce(sum(round(rc.quantity * i.cost_per_unit_minor)), 0)::bigint as recipe_cost_minor
         from products p left join recipe_components rc on rc.product_id = p.id left join inventory_items i on i.id = rc.item_id
        where p.org_id = $1 and p.is_active group by p.id order by lower(p.name)`, [ctx.orgId]);
    return {
      items: rows.map((r) => ({ productId: r.id, name: r.name, nameAr: r.name_ar, priceMinor: r.price_minor, costMinor: r.cost_minor,
        components: r.components, recipeCostMinor: r.components ? int(r.recipe_cost_minor) : null })),
      nextCursor: null,
    };
  }

  async getRecipe(tx: Tx, ctx: TenantContext, productId: string) {
    const product = await tx.maybeOne<{ id: string; name: string; price_minor: number; cost_minor: number | null }>(
      `select id, name, price_minor, cost_minor from products where id = $1 and org_id = $2`, [productId, ctx.orgId]);
    if (!product) throw notFound('Product');
    const comps = await tx.query(
      `select rc.item_id, rc.quantity, i.name, i.name_ar, i.unit, i.cost_per_unit_minor from recipe_components rc
         join inventory_items i on i.id = rc.item_id where rc.product_id = $1 order by lower(i.name)`, [productId]);
    const components = comps.map((c) => ({ itemId: c.item_id, name: c.name, nameAr: c.name_ar, quantity: num(c.quantity), unit: c.unit as InventoryUnit,
      costMinor: Math.round(num(c.quantity) * c.cost_per_unit_minor) }));
    return { productId, name: product.name, priceMinor: product.price_minor, productCostMinor: product.cost_minor,
      recipeCostMinor: components.reduce((a, c) => a + c.costMinor, 0), components };
  }

  async setRecipe(tx: Tx, ctx: TenantContext, productId: string, input: RecipeInput) {
    const product = await tx.maybeOne(`select id from products where id = $1 and org_id = $2 for update`, [productId, ctx.orgId]);
    if (!product) throw notFound('Product');
    const items = input.components.length
      ? await tx.query<ItemRow>(`select id, name, unit, cost_per_unit_minor, reorder_level, is_active from inventory_items where org_id = $1 and id = any($2::uuid[])`,
        [ctx.orgId, input.components.map((c) => c.itemId)])
      : [];
    const byId = new Map(items.map((i) => [i.id, i]));
    const rows = input.components.map((c, index) => {
      const item = byId.get(c.itemId);
      if (!item) throw invalid('unknown_item', 'An ingredient does not exist', { index });
      if (!item.is_active) throw invalid('item_archived', `${item.name} is archived`, { index });
      if (!unitsCompatible(c.unit, item.unit)) {
        throw invalid('incompatible_unit', `${item.name} is measured in ${item.unit}; ${c.unit} cannot be converted`, { index, itemUnit: item.unit, unit: c.unit });
      }
      const q = convertQuantity(c.quantity, c.unit, item.unit);
      if (q <= 0) throw invalid('quantity_too_small', `${item.name}: quantity rounds to zero in ${item.unit}`, { index });
      return { itemId: item.id, quantity: q };
    });
    await tx.query(`delete from recipe_components where product_id = $1`, [productId]);
    for (const r of rows) {
      await tx.query(`insert into recipe_components(org_id, product_id, item_id, quantity) values ($1, $2, $3, $4)`, [ctx.orgId, productId, r.itemId, r.quantity]);
    }
    await this.audit.record(tx, ctx, { action: 'inventory.recipe_set', entityType: 'product', entityId: productId, metadata: { components: rows } });
    return this.getRecipe(tx, ctx, productId);
  }

  // -------------------------------------------------------------------------
  // Waste report (measured; SDG 12.3 food-loss indicators)
  // -------------------------------------------------------------------------
  async wasteReport(tx: Tx, ctx: TenantContext, q: z.infer<typeof wasteReportQuery>) {
    if (q.from > q.to) throw invalid('invalid_period', 'from must not be after to');
    const scope = branchScope(ctx, q.branchId);
    const params = [ctx.orgId, scope, q.from, q.to];
    const where = `m.org_id = $1 and ($2::uuid[] is null or m.branch_id = any($2))
      and (m.created_at at time zone ${TZ})::date between $3::date and $4::date`;
    const byItem = await tx.query(
      `select i.id as item_id, i.name, i.name_ar, i.unit, m.waste_reason,
              sum(-m.quantity_delta) as quantity,
              sum(round(-m.quantity_delta * coalesce(m.unit_cost_minor, i.cost_per_unit_minor)))::bigint as value_minor,
              count(*)::int as entries, count(*) filter (where m.unit_cost_minor is null)::int as without_cost_snapshot
         from stock_movements m join inventory_items i on i.id = m.item_id
         join branches b on b.id = m.branch_id join organizations o on o.id = m.org_id
        where ${where} and m.reason = 'waste'
        group by i.id, i.name, i.name_ar, i.unit, m.waste_reason order by value_minor desc`, params);
    const purchases = await tx.one<{ value_minor: string; entries: number }>(
      `select coalesce(sum(round(m.quantity_delta * coalesce(m.unit_cost_minor, i.cost_per_unit_minor))), 0)::bigint as value_minor, count(*)::int as entries
         from stock_movements m join inventory_items i on i.id = m.item_id
         join branches b on b.id = m.branch_id join organizations o on o.id = m.org_id
        where ${where} and m.reason = 'purchase'`, params);
    const tz = await this.timezone(tx, ctx, q.branchId);
    const totalValue = byItem.reduce((a, r) => a + int(r.value_minor), 0);
    const toBase = (unit: string, qty: number) => (unit === 'kg' || unit === 'l' ? qty : unit === 'g' || unit === 'ml' ? qty / 1000 : qty);
    const sumFamily = (units: string[]) => round3(byItem.filter((r) => units.includes(r.unit)).reduce((a, r) => a + toBase(r.unit, num(r.quantity)), 0));
    const byReason = new Map<string, number>();
    for (const r of byItem) byReason.set(r.waste_reason, (byReason.get(r.waste_reason) ?? 0) + int(r.value_minor));
    const purchasesValue = int(purchases.value_minor);
    return {
      from: q.from, to: q.to, branchId: q.branchId ?? null,
      totals: {
        valueMinor: totalValue, entries: byItem.reduce((a, r) => a + r.entries, 0),
        massKg: sumFamily(['g', 'kg']), volumeL: sumFamily(['ml', 'l']), pieces: sumFamily(['pcs']),
        purchasesValueMinor: purchasesValue,
        wasteToPurchasesPct: purchasesValue > 0 ? Math.round((totalValue / purchasesValue) * 10000) / 100 : null,
      },
      byReason: [...byReason.entries()].map(([reason, valueMinor]) => ({ reason, valueMinor })).sort((a, b) => b.valueMinor - a.valueMinor),
      byItem: byItem.map((r) => ({ itemId: r.item_id, name: r.name, nameAr: r.name_ar, unit: r.unit, reason: r.waste_reason,
        quantity: num(r.quantity), valueMinor: int(r.value_minor), entries: r.entries })),
      meta: {
        kind: 'measured',
        method: 'Only waste movements recorded by staff (reason = waste) in the period, by local date in the branch timezone. Value = wasted quantity × the item cost snapshot stored on the movement. Mass and volume are summed in kg and litres; pieces are counted separately. Waste-to-purchases compares waste value with purchase value recorded in the same period (an SDG 12.3 food-loss proxy, not a full food-loss index). Nothing is estimated: unrecorded waste is not included.',
        assumptions: [],
        dataCoverage: { wasteEntries: byItem.reduce((a, r) => a + r.entries, 0), purchaseEntries: purchases.entries,
          entriesWithoutCostSnapshot: byItem.reduce((a, r) => a + r.without_cost_snapshot, 0) },
        timezone: tz, generatedAt: new Date().toISOString(),
      },
    };
  }

  // -------------------------------------------------------------------------
  // internals
  // -------------------------------------------------------------------------
  private convert(q: number, from: InventoryUnit, to: InventoryUnit) {
    if (!unitsCompatible(from, to)) throw invalid('incompatible_unit', `This item is measured in ${to}; ${from} cannot be converted`, { itemUnit: to, unit: from });
    const v = convertQuantity(q, from, to);
    if (v === 0) throw invalid('quantity_too_small', `The quantity rounds to zero in ${to}`);
    return v;
  }

  private async item(tx: Tx, ctx: TenantContext, id: string, lock = false): Promise<ItemRow> {
    const row = await tx.maybeOne<ItemRow>(
      `select id, name, unit, cost_per_unit_minor, reorder_level, is_active from inventory_items where id = $1 and org_id = $2${lock ? ' for update' : ''}`, [id, ctx.orgId]);
    if (!row) throw notFound('Inventory item');
    return row;
  }

  private async supplierExists(tx: Tx, ctx: TenantContext, id: string) {
    if (!(await tx.maybeOne(`select 1 from suppliers where id = $1 and org_id = $2`, [id, ctx.orgId]))) throw invalid('unknown_supplier', 'Supplier not found');
  }

  private async branchExists(tx: Tx, ctx: TenantContext, id: string) {
    if (!(await tx.maybeOne(`select 1 from branches where id = $1 and org_id = $2 and is_active`, [id, ctx.orgId]))) throw notFound('Branch');
  }

  private async lockLevel(tx: Tx, ctx: TenantContext, branchId: string, itemId: string): Promise<number> {
    await tx.query(`insert into stock_levels(org_id, branch_id, item_id, quantity) values ($1, $2, $3, 0) on conflict (branch_id, item_id) do nothing`,
      [ctx.orgId, branchId, itemId]);
    const row = await tx.one<{ quantity: string }>(`select quantity from stock_levels where branch_id = $1 and item_id = $2 for update`, [branchId, itemId]);
    return num(row.quantity);
  }

  private async applyDelta(tx: Tx, ctx: TenantContext, m: {
    branchId: string; item: ItemRow; delta: number; reason: string; unitCostMinor: number | null; wasteReason?: string;
    referenceType?: string | null; referenceId?: string | null; note: string | null; actor: string; requireAvailable?: boolean;
  }) {
    const before = await this.lockLevel(tx, ctx, m.branchId, m.item.id);
    if (m.requireAvailable && m.delta < 0 && round3(before + m.delta) < 0) {
      throw new DomainError('insufficient_stock', `Only ${before} ${m.item.unit} of ${m.item.name} recorded in this branch. Record a count first if the level is wrong.`, 409,
        { available: before, unit: m.item.unit });
    }
    const mv = await tx.one<{ id: string }>(
      `insert into stock_movements(org_id, branch_id, item_id, quantity_delta, reason, waste_reason, unit_cost_minor, reference_type, reference_id, note, actor_id)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) returning id`,
      [ctx.orgId, m.branchId, m.item.id, m.delta, m.reason, m.wasteReason ?? null, m.unitCostMinor, m.referenceType ?? null, m.referenceId ?? null, m.note, m.actor]);
    const level = await tx.one<{ quantity: string }>(
      `update stock_levels set quantity = quantity + $3, updated_at = now() where branch_id = $1 and item_id = $2 returning quantity`,
      [m.branchId, m.item.id, m.delta]);
    return { movementId: String(mv.id), branchId: m.branchId, quantityDelta: m.delta, quantityBefore: before, quantityAfter: num(level.quantity) } as Record<string, unknown> & { quantityAfter: number };
  }

  private async count(tx: Tx, ctx: TenantContext, branchId: string, item: ItemRow, counted: number, note: string | null) {
    const expected = await this.lockLevel(tx, ctx, branchId, item.id);
    const variance = round3(counted - expected);
    let movementId: string | null = null;
    if (variance !== 0) {
      const mv = await tx.one<{ id: string }>(
        `insert into stock_movements(org_id, branch_id, item_id, quantity_delta, reason, unit_cost_minor, reference_type, note, actor_id)
         values ($1, $2, $3, $4, 'count', $5, 'stock_count', $6, $7) returning id`,
        [ctx.orgId, branchId, item.id, variance, item.cost_per_unit_minor, note, `${ctx.actorType}:${ctx.actorId}`]);
      movementId = String(mv.id);
      await tx.query(`update stock_levels set quantity = $3, updated_at = now() where branch_id = $1 and item_id = $2`, [branchId, item.id, counted]);
    }
    const c = await tx.one<{ id: string }>(
      `insert into stock_counts(org_id, branch_id, item_id, expected_quantity, counted_quantity, unit_cost_minor, movement_id, note, counted_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning id`,
      [ctx.orgId, branchId, item.id, expected, counted, item.cost_per_unit_minor, movementId, note, `${ctx.actorType}:${ctx.actorId}`]);
    if (movementId) await tx.query(`update stock_movements set reference_id = $2 where id = $1`, [movementId, c.id]);
    return { countId: c.id, itemId: item.id, unit: item.unit, branchId, expectedQuantity: expected, countedQuantity: counted, variance,
      varianceValueMinor: Math.round(variance * item.cost_per_unit_minor), movementId, quantityAfter: counted };
  }

  async timezone(tx: Tx, ctx: TenantContext, branchId?: string | null): Promise<string> {
    const row = await tx.one<{ tz: string }>(
      `select coalesce((select b.timezone from branches b where b.id = $2::uuid and b.org_id = $1), o.timezone) as tz from organizations o where o.id = $1`,
      [ctx.orgId, branchId ?? null]);
    return row.tz;
  }
}

function mapSupplier(r: any) {
  return { id: r.id, name: r.name, phone: r.phone, email: r.email, notes: r.notes, itemCount: r.item_count ?? 0, createdAt: iso(r.created_at) };
}

function mapItem(r: any) {
  return { id: r.id, name: r.name, nameAr: r.name_ar, sku: r.sku, unit: r.unit, costPerUnitMinor: r.cost_per_unit_minor,
    reorderLevel: num(r.reorder_level), supplierId: r.supplier_id, supplierName: r.supplier_name ?? null, isActive: r.is_active,
    totalQuantity: num(r.total_quantity) };
}
