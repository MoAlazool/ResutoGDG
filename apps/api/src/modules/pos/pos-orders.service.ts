import { Injectable } from '@nestjs/common';
import type {
  OrderStatus, PosOrder, PosOrderSubmit, PosQuote, PosQuoteRequest, PosOrderSubmitted, PosPaymentRequest, PosPriceConflictDetails, PosRepricedLine, PosUnavailableDetails,
} from '@resuto/contracts';
import type { TenantContext } from '../../common/auth/context';
import { fingerprint } from '../../common/crypto/hash';
import { DbService, type Tx } from '../../common/db/db.service';
import { conflict, notFound } from '../../common/errors/domain-error';
import { AuditService } from '../../common/platform/audit.service';
import { PricingService } from '../kernel/pricing.service';
import { KitchenService } from '../kitchen/kitchen.service';
import { IN_STOCK_SQL, OFFERED_SQL, SOLD_OUT_SQL } from '../menu/availability';
import { OrdersService } from '../orders/orders.service';
import { deviceBranch } from './pos-feed.service';
import { PosSyncService } from './pos-sync.service';

/**
 * Orders from POS devices (21-POSAPI). Prices and availability are server-authoritative: the device says what it
 * showed, the kernel quote decides. Placement reuses the staff order path (OrdersService.placeStaffOrder → kernel),
 * so pricing, stock, inventory depletion, the order timeline, the outbox and the audit are the same as for every
 * other channel; the channel is `pos`.
 *
 * Exactly once per client order id (pos_order_submissions): the first submit stores its response in the order's own
 * transaction; a retry with the same id and body returns that response (Idempotent-Replayed: true); the same id with
 * another body is a 409 client_order_id_reused. A refused submit (conflict) commits nothing, so the device may retry
 * the same id with corrected expectations or repricing: accept.
 */
@Injectable()
export class PosOrdersService {
  constructor(
    private readonly db: DbService,
    private readonly orders: OrdersService,
    private readonly pricing: PricingService,
    private readonly kitchen: KitchenService,
    private readonly sync: PosSyncService,
    private readonly audit: AuditService,
  ) {}

  async submit(ctx: TenantContext, body: PosOrderSubmit): Promise<{ replayed: boolean; result: PosOrderSubmitted }> {
    const branchId = deviceBranch(ctx);
    const hash = fingerprint(body);
    return this.db.scoped(ctx, async (tx) => {
      const claimed = await tx.maybeOne(
        `insert into pos_order_submissions(org_id, client_order_id, branch_id, device_id, request_hash, taken_at)
         values ($1, $2, $3, $4, $5, $6) on conflict (org_id, client_order_id) do nothing returning client_order_id`,
        [ctx.orgId, body.clientOrderId, branchId, ctx.actorId, hash, body.takenAt ?? null]);
      if (!claimed) {
        // A concurrent first submit holds the row until it commits; this waits for it, then replays its answer.
        const prior = await tx.one<{ branch_id: string; request_hash: string; response: PosOrderSubmitted | null }>(
          'select branch_id, request_hash, response from pos_order_submissions where org_id = $1 and client_order_id = $2 for update',
          [ctx.orgId, body.clientOrderId]);
        if (prior.branch_id !== branchId || prior.request_hash !== hash || !prior.response) {
          throw conflict('client_order_id_reused', 'This client order id was already used for a different order.');
        }
        return { replayed: true, result: prior.response };
      }
      if (body.tableId && !(await tx.maybeOne('select 1 from dining_tables where id = $1 and branch_id = $2 and is_active', [body.tableId, branchId]))) {
        throw notFound('Table');
      }
      if (body.visitId && !(await tx.maybeOne('select 1 from visits where id = $1 and branch_id = $2', [body.visitId, branchId]))) throw notFound('Visit');
      await this.assertAvailable(tx, ctx, branchId, body);
      const lines = body.lines.map(({ expectedLineTotalMinor: _expected, ...l }) => l);
      const quote = await this.pricing.quote(tx, ctx.orgId, { branchId, fulfillment: body.fulfillment, lines, channel: 'pos' });
      const changed: PosRepricedLine[] = [];
      body.lines.forEach((l, index) => {
        const q = quote.lines[index]!;
        if (l.expectedLineTotalMinor !== undefined && l.expectedLineTotalMinor !== q.lineTotalMinor) {
          changed.push({ index, productId: q.productId, expectedLineTotalMinor: l.expectedLineTotalMinor, currentLineTotalMinor: q.lineTotalMinor,
            currentUnitPriceMinor: q.unitPriceMinor, currentModifiersTotalMinor: q.modifiersTotalMinor });
        }
      });
      const totalChanged = body.expectedTotalMinor !== undefined && body.expectedTotalMinor !== quote.totalMinor;
      let repriced: PosOrderSubmitted['repriced'] = null;
      if (changed.length || totalChanged) {
        if (body.repricing !== 'accept') {
          throw conflict('pos_price_changed', 'Prices changed since the device synced the menu. Review the order or resubmit with repricing: accept.', {
            currency: quote.currency, lines: changed, expectedTotalMinor: body.expectedTotalMinor ?? null, currentTotalMinor: quote.totalMinor,
            menuCursor: await this.sync.menuCursor(tx, ctx.orgId),
          } satisfies PosPriceConflictDetails);
        }
        repriced = { lines: changed, expectedTotalMinor: body.expectedTotalMinor ?? null, totalMinor: quote.totalMinor };
      }
      const placed = await this.orders.placeStaffOrder(tx, ctx, {
        branchId, channel: 'pos', fulfillment: body.fulfillment, tableId: body.tableId ?? null, visitId: body.visitId ?? null, lines,
        customer: body.customer ? { name: body.customer.name ?? null, phone: body.customer.phone ?? null } : null, notes: body.notes ?? null,
        partySize: body.guests, expectedTotalMinor: quote.totalMinor,
      });
      await tx.query('update pos_order_submissions set order_id = $3 where org_id = $1 and client_order_id = $2', [ctx.orgId, body.clientOrderId, placed.id]);
      const [order] = await this.sync.load(tx, branchId, [placed.id]);
      const result: PosOrderSubmitted = { clientOrderId: body.clientOrderId, order: order!, repriced };
      await tx.query('update pos_order_submissions set response = $3 where org_id = $1 and client_order_id = $2',
        [ctx.orgId, body.clientOrderId, JSON.stringify(result)]);
      await this.audit.record(tx, ctx, { action: 'pos.order.submitted', entityType: 'order', entityId: placed.id, branchId,
        metadata: { clientOrderId: body.clientOrderId, totalMinor: placed.totalMinor, repriced: !!repriced, takenAt: body.takenAt ?? null } });
      return { replayed: false, result };
    });
  }

  /** Current server pricing of a cart (nothing is created): the totals a device shows before submitting. */
  async quote(ctx: TenantContext, body: PosQuoteRequest): Promise<PosQuote> {
    const branchId = deviceBranch(ctx);
    return this.db.scoped(ctx, async (tx) => {
      await this.assertAvailable(tx, ctx, branchId, body);
      const q = await this.pricing.quote(tx, ctx.orgId, { branchId, fulfillment: body.fulfillment, lines: body.lines, channel: 'pos' });
      return {
        currency: q.currency,
        lines: q.lines.map((l, index) => ({ index, productId: l.productId, unitPriceMinor: l.unitPriceMinor, modifiersTotalMinor: l.modifiersTotalMinor,
          lineTotalMinor: l.lineTotalMinor })),
        subtotalMinor: q.subtotalMinor, discountMinor: q.discountMinor, serviceChargeMinor: q.serviceChargeMinor, deliveryFeeMinor: q.deliveryFeeMinor,
        taxMinor: q.taxMinor, taxInclusive: q.taxInclusive, totalMinor: q.totalMinor, menuCursor: await this.sync.menuCursor(tx, ctx.orgId),
      };
    });
  }

  /** Every requested item that cannot be sold at the branch right now, in one 409 (the kernel would stop at the first). */
  private async assertAvailable(tx: Tx, ctx: TenantContext, branchId: string, body: { lines: Array<{ productId: string; quantity: number }> }) {
    const ids = [...new Set(body.lines.map((l) => l.productId))];
    const rows = await tx.query<any>(
      `select p.id, p.is_active and c.is_active and m.id is not null as on_menu, ${OFFERED_SQL} as offered, ${SOLD_OUT_SQL} as sold_out,
              ${IN_STOCK_SQL} as in_stock, case when p.track_stock then s.stock_qty end as stock_qty
         from products p join menu_categories c on c.id = p.category_id
         left join menus m on m.id = c.menu_id and m.is_active and (m.branch_id is null or m.branch_id = $2)
         left join product_branch_settings s on s.product_id = p.id and s.branch_id = $2
        where p.org_id = $1 and p.id = any($3::uuid[])`, [ctx.orgId, branchId, ids]);
    const byId = new Map(rows.map((r) => [r.id, r]));
    const wanted = new Map<string, number>();
    for (const l of body.lines) wanted.set(l.productId, (wanted.get(l.productId) ?? 0) + l.quantity);
    const items: PosUnavailableDetails['items'] = [];
    body.lines.forEach((l, index) => {
      const r = byId.get(l.productId);
      const reason = !r || !r.on_menu ? 'not_on_menu' : !r.offered ? 'not_offered' : r.sold_out ? 'sold_out'
        : !r.in_stock || (r.stock_qty !== null && r.stock_qty < wanted.get(l.productId)!) ? 'out_of_stock' : null;
      if (reason) items.push({ index, productId: l.productId, reason, availableQty: r?.stock_qty ?? null });
    });
    if (items.length) {
      throw conflict('pos_items_unavailable', 'Some items cannot be sold right now.', { items, menuCursor: await this.sync.menuCursor(tx, ctx.orgId) } satisfies PosUnavailableDetails);
    }
  }

  async get(ctx: TenantContext, orderId: string): Promise<PosOrder> {
    const branchId = deviceBranch(ctx);
    return this.db.scoped(ctx, async (tx) => {
      const [order] = await this.sync.load(tx, branchId, [orderId]);
      if (!order) throw notFound('Order');
      return order;
    });
  }

  private async assertOrder(ctx: TenantContext, orderId: string) {
    const branchId = deviceBranch(ctx);
    const found = await this.db.scoped(ctx, (tx) => tx.maybeOne('select 1 from orders where id = $1 and branch_id = $2', [orderId, branchId]));
    if (!found) throw notFound('Order');
  }

  /** Order status change with the version the device saw (409 stale_order with the current version otherwise). */
  async transition(ctx: TenantContext, orderId: string, to: OrderStatus, version: number) {
    await this.assertOrder(ctx, orderId);
    return this.orders.transition(ctx, orderId, to, version);
  }

  /** Records a payment taken on the device (cash, card terminal, InstaPay); the client payment id makes it exactly once. */
  async payment(ctx: TenantContext, orderId: string, body: PosPaymentRequest) {
    await this.assertOrder(ctx, orderId);
    return this.orders.collect(ctx, orderId, { amountMinor: body.amountMinor, method: body.method, reference: body.reference ?? null }, body.clientPaymentId);
  }

  // Kitchen (acting role kitchen): the KDS feed and bumps of KitchenService, scoped to the device's branch.
  tickets(ctx: TenantContext, q: { station?: string; since?: string }) {
    return this.kitchen.feed(ctx, deviceBranch(ctx), q);
  }

  bump(ctx: TenantContext, orderId: string, to: OrderStatus, version: number) {
    return this.kitchen.bump(ctx, orderId, to, version);
  }

  line(ctx: TenantContext, lineId: string, status: 'queued' | 'preparing' | 'ready') {
    return this.kitchen.line(ctx, lineId, status);
  }

  /** Kitchen routing: which station prepares which products (product station; a category's default station for new products). */
  async routing(ctx: TenantContext) {
    return this.db.scoped(ctx, async (tx) => {
      const rows = await tx.query<{ station: string; product_ids: string[] }>(
        `select p.station, array_agg(p.id order by p.sort_order, p.created_at, p.id) as product_ids from products p
          where p.org_id = $1 and p.is_active group by p.station order by p.station`, [ctx.orgId]);
      return { stations: rows.map((r) => ({ station: r.station, productIds: r.product_ids })) };
    });
  }
}
