import { Injectable } from '@nestjs/common';
import type { PosFloorSync, PosMenuProduct, PosMenuSync, PosOrder, PosOrdersSync } from '@resuto/contracts';
import { stableJson } from '@resuto/contracts/openapi';
import type { TenantContext } from '../../common/auth/context';
import { sha256 } from '../../common/crypto/hash';
import { DbService, type Tx } from '../../common/db/db.service';
import { notFound } from '../../common/errors/domain-error';
import { stableExpiry } from '../../common/storage/storage.service';
import { FloorService } from '../floor/floor.service';
import { MENU_IMAGE_TTL_SECONDS, MenuService, PUBLIC_BRANCH_COLUMNS } from '../menu/menu.service';
import { ORDER_SUMMARY_COLUMNS, toOrderSummary } from '../orders/orders.service';
import { deviceBranch, orderCursor, PosFeedService } from './pos-feed.service';

/** Open orders a device shows; at most this many in one full sync. */
const FULL_SYNC_LIMIT = 300;
/** Orders per delta answer. */
const DELTA_LIMIT = 200;

/**
 * An order is open while the kitchen has it, while its table's visit is open, or (for a day) while a fulfilled
 * order is still unpaid. Needs the orders alias `o`.
 */
const OPEN_SQL = `(o.status in ('awaiting_payment', 'placed', 'accepted', 'preparing', 'ready')
  or (o.status <> 'cancelled' and o.visit_id is not null and exists (select 1 from visits v where v.id = o.visit_id and v.status = 'open'))
  or (o.status in ('served', 'picked_up', 'delivered') and o.total_minor > o.paid_minor - o.refunded_minor and o.placed_at > now() - interval '24 hours'))`;

/**
 * Open orders of a branch: three index-backed parts (kitchen statuses through orders_open_branch_idx, the orders of
 * open visits, recent unpaid fulfilled orders through orders_branch_status_idx) instead of one OR over all history.
 */
const OPEN_ORDER_IDS_SQL = `select id from (
    select o.id, o.placed_at from orders o where o.branch_id = $1 and o.status in ('awaiting_payment', 'placed', 'accepted', 'preparing', 'ready')
    union
    select o.id, o.placed_at from visits v join orders o on o.visit_id = v.id where v.branch_id = $1 and v.status = 'open' and o.status <> 'cancelled'
    union
    select o.id, o.placed_at from orders o where o.branch_id = $1 and o.status in ('served', 'picked_up', 'delivered')
       and o.placed_at > now() - interval '24 hours' and o.total_minor > o.paid_minor - o.refunded_minor
  ) x order by placed_at, id limit $2`;

/**
 * Delta sync for POS devices (21-POSAPI), built on the existing read models:
 *
 * - menu: the branch menu of MenuService.publicMenuFor (current branch prices, sold-out and stock state, modifiers)
 *   plus each product's kitchen station and tracked stock. The cursor is the organization's menu version (bumped by
 *   triggers on every menu change) and the image URL window: unchanged → `unchanged: true` and no body.
 * - floor: FloorService.live (tables, open visits, bills, next reservation) and the layout geometry; the cursor is a
 *   digest of that answer.
 * - orders: no cursor = the open orders and a cursor at the current feed head; a cursor = every order with a feed
 *   event since (closed ones carry open: false), so a device applies changes it missed while offline.
 */
@Injectable()
export class PosSyncService {
  constructor(
    private readonly db: DbService,
    private readonly menus: MenuService,
    private readonly floors: FloorService,
    private readonly feed: PosFeedService,
  ) {}

  /** Current menu cursor of the organization (also carried by price and availability conflicts). */
  async menuCursor(tx: Tx, orgId: string): Promise<string> {
    const v = await tx.maybeOne<{ version: number }>('select version from menu_versions where org_id = $1', [orgId]);
    return `m1.${v?.version ?? 0}.${stableExpiry(MENU_IMAGE_TTL_SECONDS)}`;
  }

  async menu(ctx: TenantContext, since?: string): Promise<PosMenuSync> {
    const branchId = deviceBranch(ctx);
    const urls = this.menus.publicMediaUrls();
    const built = await this.db.scoped(ctx, async (tx) => {
      const cursor = await this.menuCursor(tx, ctx.orgId);
      if (since === cursor) return { cursor, unchanged: true as const };
      const branch = await tx.maybeOne<any>(`select ${PUBLIC_BRANCH_COLUMNS} from branches where id = $1 and org_id = $2`, [branchId, ctx.orgId]);
      if (!branch) throw notFound('Branch');
      const menu = await this.menus.publicMenuFor(tx, ctx.orgId, branch, [branch], urls);
      const ids = menu.categories.flatMap((c) => c.products.map((p) => p.id));
      const extra = ids.length ? await tx.query<{ id: string; station: string; track_stock: boolean; stock_qty: number | null }>(
        `select p.id, p.station, p.track_stock, s.stock_qty from products p
           left join product_branch_settings s on s.product_id = p.id and s.branch_id = $2 where p.id = any($1::uuid[])`, [ids, branchId]) : [];
      return { cursor, unchanged: false as const, menu, extra };
    });
    if (built.unchanged) return { cursor: built.cursor, unchanged: true };
    await urls.resolve();
    const byId = new Map(built.extra.map((e) => [e.id, e]));
    const categories = built.menu.categories.map((c) => ({
      id: c.id, name: c.name, nameAr: c.nameAr,
      products: c.products.map((p): PosMenuProduct => {
        const e = byId.get(p.id);
        return {
          id: p.id, categoryId: c.id, name: p.name, nameAr: p.nameAr, description: p.description, descriptionAr: p.descriptionAr,
          priceMinor: p.priceMinor, available: p.available, unavailableReason: p.unavailableReason ?? null, stockQty: e?.track_stock ? e.stock_qty ?? null : null,
          station: e?.station ?? 'Kitchen', prepMinutes: p.prepMinutes, spiceLevel: p.spiceLevel, allergens: p.allergens, dietary: p.dietary,
          imageUrl: p.imageUrl, modifierGroups: p.modifierGroups,
        };
      }),
    }));
    const stations = [...new Set(categories.flatMap((c) => c.products.map((p) => p.station)))].sort();
    return { cursor: built.cursor, unchanged: false, currency: built.menu.org.currency, categories, stations };
  }

  async floor(ctx: TenantContext, since?: string): Promise<PosFloorSync> {
    const branchId = deviceBranch(ctx);
    const layout = await this.floors.get(ctx, branchId);
    const live = await this.floors.live(ctx, branchId);
    const body = {
      layout: { revision: layout.revision, width: layout.width, height: layout.height, zones: layout.zones, objects: layout.objects },
      tables: live.tables,
    };
    const cursor = `f1.${sha256(stableJson(body)).slice(0, 32)}`;
    return since === cursor ? { cursor, unchanged: true } : { cursor, unchanged: false, ...body };
  }

  async orders(ctx: TenantContext, cursor?: string): Promise<PosOrdersSync> {
    const branchId = deviceBranch(ctx);
    return this.db.scoped(ctx, async (tx) => {
      const pos = await this.feed.position(tx, branchId);
      if (!cursor) {
        // The position is read first: anything that changes after it is in the next delta.
        const ids = (await tx.query<{ id: string }>(OPEN_ORDER_IDS_SQL, [branchId, FULL_SYNC_LIMIT + 1])).map((r) => r.id);
        const orders = await this.load(tx, branchId, ids.slice(0, FULL_SYNC_LIMIT));
        return { cursor: orderCursor(pos.epoch, pos.head), mode: 'full', orders, hasMore: false, truncated: ids.length > FULL_SYNC_LIMIT };
      }
      const after = this.feed.decodeOrderCursor(pos, cursor);
      const changed = await this.feed.changedOrders(tx, branchId, after, pos.head, DELTA_LIMIT);
      return { cursor: orderCursor(pos.epoch, changed.upto), mode: 'delta', orders: await this.load(tx, branchId, changed.ids), hasMore: changed.hasMore };
    });
  }

  /** POS views of orders of the branch, in the order of `ids` (unknown ids and other branches' orders are skipped). */
  async load(tx: Tx, branchId: string, ids: string[]): Promise<PosOrder[]> {
    if (!ids.length) return [];
    const rows = await tx.query<any>(
      `select ${ORDER_SUMMARY_COLUMNS}, o.subtotal_minor, o.discount_minor, o.service_charge_minor, o.delivery_fee_minor, o.tax_minor, o.tax_inclusive,
              o.notes, o.updated_at, t.label as table_label, s.client_order_id, ${OPEN_SQL} as is_open,
              (select coalesce(sum(quantity), 0) from order_lines l where l.order_id = o.id) as item_count
         from orders o left join dining_tables t on t.id = o.table_id left join pos_order_submissions s on s.order_id = o.id
        where o.id = any($1::uuid[]) and o.branch_id = $2`, [ids, branchId]);
    const lines = await tx.query<any>(
      `select id, order_id, product_id, name, name_ar, quantity, unit_price_minor, modifiers, modifiers_total_minor, line_total_minor, station,
              kitchen_status, notes
         from order_lines where order_id = any($1::uuid[]) order by order_id, line_seq`, [rows.map((r) => r.id)]);
    const byId = new Map(rows.map((r) => [r.id, r]));
    return ids.filter((id) => byId.has(id)).map((id) => {
      const r = byId.get(id);
      const s = toOrderSummary(r);
      return {
        id: s.id, clientOrderId: r.client_order_id ?? null, number: s.number, branchId: s.branchId, channel: s.channel, fulfillment: s.fulfillment,
        status: s.status, paymentStatus: s.paymentStatus, tableId: s.tableId, tableLabel: s.tableLabel, visitId: s.visitId, customerName: s.customerName,
        currency: s.currency, subtotalMinor: r.subtotal_minor, discountMinor: r.discount_minor, serviceChargeMinor: r.service_charge_minor,
        deliveryFeeMinor: r.delivery_fee_minor, taxMinor: r.tax_minor, taxInclusive: r.tax_inclusive, totalMinor: s.totalMinor, paidMinor: s.paidMinor,
        refundedMinor: s.refundedMinor, dueMinor: s.dueMinor, notes: r.notes, placedAt: s.placedAt, updatedAt: new Date(r.updated_at).toISOString(),
        version: s.version, open: !!r.is_open,
        lines: lines.filter((l) => l.order_id === id).map((l) => ({
          id: l.id, productId: l.product_id, name: l.name, nameAr: l.name_ar, quantity: l.quantity, unitPriceMinor: l.unit_price_minor,
          modifiers: l.modifiers, modifiersTotalMinor: l.modifiers_total_minor, lineTotalMinor: l.line_total_minor, station: l.station,
          kitchenStatus: l.kitchen_status, notes: l.notes,
        })),
      };
    });
  }
}
