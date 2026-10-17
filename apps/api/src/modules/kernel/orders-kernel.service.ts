import { Injectable } from '@nestjs/common';
import { canTransitionOrder, type Fulfillment, type OrderStatus } from '@resuto/contracts';
import type { TenantContext } from '../../common/auth/context';
import type { Tx } from '../../common/db/db.service';
import { DomainError, invalid, notFound } from '../../common/errors/domain-error';
import { OutboxService } from '../../common/platform/outbox.service';
import { PricingService, type CartLineInput, type Quote } from './pricing.service';

export type OrderChannel = 'qr' | 'web' | 'whatsapp' | 'staff' | 'pos' | 'mcp' | 'phone';

export interface PlaceOrderInput {
  branchId: string;
  channel: OrderChannel;
  fulfillment: Fulfillment;
  lines: CartLineInput[];
  tableId?: string | null;
  visitId?: string | null;
  customer?: { name?: string | null; phone?: string | null; email?: string | null; marketingConsent?: boolean } | null;
  customerId?: string | null;
  deliveryAddress?: { line1: string; area?: string | null; city?: string | null; notes?: string | null; latitude?: number | null; longitude?: number | null } | null;
  notes?: string | null;
  promotionCode?: string | null;
  scheduledFor?: string | null;
  attribution?: Record<string, unknown>;
  conversationId?: string | null;
  campaignId?: string | null;
  /** 'awaiting_payment' for prepaid online channels: the kitchen does not see it until payment is verified. */
  initialStatus?: 'placed' | 'awaiting_payment';
  /** Client price expectation; if it differs from the server quote the order is rejected (legacy 409 behaviour). */
  expectedTotalMinor?: number;
}

export interface PlacedOrder {
  id: string;
  number: string;
  publicRef: string;
  status: OrderStatus;
  totalMinor: number;
  currency: string;
  customerId: string | null;
  quote: Quote;
}

const TIMESTAMP_FOR: Partial<Record<OrderStatus, string>> = {
  accepted: 'accepted_at', ready: 'ready_at', served: 'fulfilled_at', picked_up: 'fulfilled_at', delivered: 'fulfilled_at', cancelled: 'cancelled_at',
};

/**
 * Shared order kernel (lead-owned). Creates orders from any channel with
 * server-side pricing, stock decrement, customer resolution, events and
 * outbox, and enforces the order state machine for every transition.
 */
@Injectable()
export class OrdersKernelService {
  constructor(private readonly pricing: PricingService, private readonly outbox: OutboxService) {}

  async place(tx: Tx, ctx: TenantContext, input: PlaceOrderInput): Promise<PlacedOrder> {
    ctx.assertBranch(input.branchId);
    if (input.fulfillment === 'dine_in' && !input.tableId) throw invalid('table_required', 'Dine-in orders need a table');
    if (input.fulfillment === 'delivery' && !input.deliveryAddress?.line1) throw invalid('address_required', 'Delivery orders need an address');
    if (input.fulfillment === 'delivery' && !input.customer?.phone && !input.customerId) throw invalid('phone_required', 'Delivery orders need a phone number');

    if (input.tableId) {
      const table = await tx.maybeOne('select id from dining_tables where id = $1 and branch_id = $2 and is_active', [input.tableId, input.branchId]);
      if (!table) throw notFound('Table');
    }
    if (input.visitId) {
      const visit = await tx.maybeOne<{ status: string; table_id: string }>('select status, table_id from visits where id = $1 for update', [input.visitId]);
      if (!visit || visit.status !== 'open') throw new DomainError('visit_closed', 'This table session has ended', 409);
      if (input.tableId && visit.table_id !== input.tableId) throw invalid('visit_table_mismatch', 'Visit belongs to another table');
    }

    const customerId = input.customerId ?? (input.customer ? await this.resolveCustomer(tx, ctx.orgId, input.customer, input.channel) : null);
    const quote = await this.pricing.quote(tx, ctx.orgId, {
      branchId: input.branchId, fulfillment: input.fulfillment, lines: input.lines, promotionCode: input.promotionCode,
      channel: input.channel, customerId,
    });
    if (input.expectedTotalMinor !== undefined && input.expectedTotalMinor !== quote.totalMinor) {
      throw new DomainError('price_changed', 'Prices changed since you opened the menu. Review your cart.', 409, { totalMinor: quote.totalMinor });
    }

    // Atomic stock decrement for unit-tracked products.
    const qtyByProduct = new Map<string, number>();
    for (const l of quote.lines) if (l.trackStock) qtyByProduct.set(l.productId, (qtyByProduct.get(l.productId) ?? 0) + l.quantity);
    for (const [productId, qty] of qtyByProduct) {
      const updated = await tx.maybeOne(
        `update product_branch_settings set stock_qty = stock_qty - $3, updated_at = now()
          where product_id = $1 and branch_id = $2 and (stock_qty is null or stock_qty >= $3) returning stock_qty`,
        [productId, input.branchId, qty]);
      if (!updated) {
        const exists = await tx.maybeOne('select 1 from product_branch_settings where product_id = $1 and branch_id = $2', [productId, input.branchId]);
        if (exists) throw new DomainError('out_of_stock', 'An item sold out while you were ordering', 409, { productId });
      }
    }

    const counter = await tx.one<{ value: number; day: string }>(
      `update order_counters c set
          value = case when c.day = (now() at time zone coalesce(b.timezone, o.timezone))::date then c.value + 1 else 1 end,
          day = (now() at time zone coalesce(b.timezone, o.timezone))::date
        from branches b join organizations o on o.id = b.org_id
       where c.branch_id = $1 and b.id = c.branch_id returning c.value, c.day::text as day`, [input.branchId]);

    const status = input.initialStatus ?? 'placed';
    const order = await tx.one<{ id: string; public_ref: string }>(
      `insert into orders(org_id, branch_id, number, business_date, channel, fulfillment, status, visit_id, table_id, customer_id,
          customer_name, customer_phone, delivery_address, currency, subtotal_minor, discount_minor, delivery_fee_minor,
          service_charge_minor, tax_minor, tax_inclusive, total_minor, notes, scheduled_for, promotion_id, campaign_id,
          attribution, conversation_id)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27)
       returning id, public_ref`,
      [ctx.orgId, input.branchId, String(counter.value), counter.day, input.channel, input.fulfillment, status, input.visitId ?? null,
        input.tableId ?? null, customerId, input.customer?.name?.trim() || null, input.customer?.phone ?? null,
        input.deliveryAddress ? JSON.stringify(input.deliveryAddress) : null, quote.currency, quote.subtotalMinor, quote.discountMinor,
        quote.deliveryFeeMinor, quote.serviceChargeMinor, quote.taxMinor, quote.taxInclusive, quote.totalMinor,
        input.notes?.trim().slice(0, 500) || null, input.scheduledFor ?? null, quote.promotion?.id ?? null, input.campaignId ?? null,
        input.attribution ?? {}, input.conversationId ?? null]);

    for (const l of quote.lines) {
      await tx.query(
        `insert into order_lines(org_id, order_id, product_id, name, name_ar, unit_price_minor, quantity, modifiers,
            modifiers_total_minor, line_total_minor, cost_minor, station, notes)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
        [ctx.orgId, order.id, l.productId, l.name, l.nameAr, l.unitPriceMinor, l.quantity, JSON.stringify(l.modifiers),
          l.modifiersTotalMinor, l.lineTotalMinor, l.costMinor === null ? null : l.costMinor * l.quantity, l.station, l.notes]);
    }

    // Ingredient-level inventory: record sale movements from recipes.
    await tx.query(
      `with used as (
         select rc.item_id, sum(rc.quantity * ol.quantity) as qty
           from order_lines ol join recipe_components rc on rc.product_id = ol.product_id
          where ol.order_id = $1 group by rc.item_id)
       , moved as (
         insert into stock_movements(org_id, branch_id, item_id, quantity_delta, reason, reference_type, reference_id, actor_id)
         select $2, $3, item_id, -qty, 'sale', 'order', $5, $4 from used returning item_id, quantity_delta)
       insert into stock_levels(org_id, branch_id, item_id, quantity)
       select $2, $3, item_id, quantity_delta from moved
       on conflict (branch_id, item_id) do update set quantity = stock_levels.quantity + excluded.quantity, updated_at = now()`,
      [order.id, ctx.orgId, input.branchId, `${ctx.actorType}:${ctx.actorId}`, order.id]);

    if (quote.promotion) {
      await tx.query(`insert into promotion_redemptions(org_id, promotion_id, order_id, customer_id, discount_minor) values ($1, $2, $3, $4, $5)`,
        [ctx.orgId, quote.promotion.id, order.id, customerId, quote.discountMinor]);
      await tx.query(`update promotions set redemption_count = redemption_count + 1 where id = $1`, [quote.promotion.id]);
    }
    if (input.campaignId || Object.keys(input.attribution ?? {}).length) {
      await tx.query(
        `insert into attribution_events(org_id, kind, campaign_id, customer_id, order_id, utm, value_minor) values ($1, 'order_placed', $2, $3, $4, $5, $6)`,
        [ctx.orgId, input.campaignId ?? null, customerId, order.id, input.attribution ?? {}, quote.totalMinor]);
    }
    await this.event(tx, ctx, order.id, 'created', null, status, { channel: input.channel, totalMinor: quote.totalMinor });
    await this.outbox.publish(tx, ctx.orgId, {
      type: 'order.placed', aggregateType: 'order', aggregateId: order.id,
      payload: { branchId: input.branchId, channel: input.channel, fulfillment: input.fulfillment, status, totalMinor: quote.totalMinor, customerId },
    });
    return { id: order.id, number: String(counter.value), publicRef: order.public_ref, status, totalMinor: quote.totalMinor, currency: quote.currency, customerId, quote };
  }

  /** Applies a validated status transition. Use for every order status change. */
  async transition(tx: Tx, ctx: TenantContext, orderId: string, to: OrderStatus, opts: { reason?: string; expectedVersion?: number } = {}) {
    const o = await tx.maybeOne<any>('select id, branch_id, status, fulfillment, version from orders where id = $1 for update', [orderId]);
    if (!o) throw notFound('Order');
    ctx.assertBranch(o.branch_id);
    if (opts.expectedVersion !== undefined && o.version !== opts.expectedVersion) {
      throw new DomainError('stale_order', 'This order changed. Refresh and try again.', 409, { version: o.version });
    }
    if (o.status === to) return { id: o.id, status: o.status as OrderStatus, version: o.version as number, changed: false };
    if (!canTransitionOrder(o.status, to, o.fulfillment)) {
      throw new DomainError('invalid_transition', `Cannot move an order from ${o.status} to ${to}`, 409, { from: o.status, to });
    }
    const column = TIMESTAMP_FOR[to];
    const row = await tx.one<{ version: number }>(
      `update orders set status = $2, version = version + 1${column ? `, ${column} = now()` : ''}${to === 'cancelled' ? ', cancel_reason = $3' : ''}
        where id = $1 returning version`, to === 'cancelled' ? [orderId, to, opts.reason ?? null] : [orderId, to]);
    if (to === 'cancelled') await this.restoreStock(tx, ctx, orderId, o.branch_id);
    await tx.query(
      `update order_lines set kitchen_status = case when $2 = 'cancelled' then 'cancelled'::kitchen_status
              when $2 in ('served', 'picked_up', 'delivered') then 'served'::kitchen_status
              when $2 = 'ready' and kitchen_status in ('queued', 'preparing') then 'ready'::kitchen_status
              when $2 = 'preparing' and kitchen_status = 'queued' then 'preparing'::kitchen_status
              else kitchen_status end
        where order_id = $1`, [orderId, to]);
    await this.event(tx, ctx, orderId, 'status_changed', o.status, to, opts.reason ? { reason: opts.reason } : {});
    await this.outbox.publish(tx, ctx.orgId, {
      type: to === 'cancelled' ? 'order.cancelled' : 'order.status_changed', aggregateType: 'order', aggregateId: orderId,
      payload: { from: o.status, to, branchId: o.branch_id, fulfillment: o.fulfillment },
    });
    return { id: orderId, status: to, version: row.version, changed: true };
  }

  async event(tx: Tx, ctx: TenantContext, orderId: string, type: string, from: string | null, to: string | null, details: Record<string, unknown> = {}) {
    await tx.query(
      `insert into order_events(org_id, order_id, event_type, from_status, to_status, actor_type, actor_id, details) values ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [ctx.orgId, orderId, type, from, to, ctx.actorType, ctx.actorId, details]);
  }

  /** Finds or creates a customer by phone/email; updates last-seen and consent (never revokes silently). */
  async resolveCustomer(tx: Tx, orgId: string, c: NonNullable<PlaceOrderInput['customer']>, channel: string): Promise<string | null> {
    const phone = c.phone?.replace(/[\s-]/g, '') || null;
    const email = c.email?.trim().toLowerCase() || null;
    if (!phone && !email) return null;
    if (phone && !/^\+[1-9][0-9]{6,14}$/.test(phone)) throw invalid('invalid_phone', 'Use an international phone number, e.g. +201001234567');
    const existing = await tx.maybeOne<{ id: string }>(
      `select id from customers where org_id = $1 and ((phone_e164 is not null and phone_e164 = $2) or (email is not null and email = $3)) limit 1`,
      [orgId, phone, email]);
    if (existing) {
      await tx.query(
        `update customers set last_seen_at = now(), display_name = coalesce(display_name, $2),
            marketing_consent = marketing_consent or $3, marketing_consent_at = case when $3 and not marketing_consent then now() else marketing_consent_at end,
            marketing_consent_source = case when $3 and not marketing_consent then $4 else marketing_consent_source end
          where id = $1`, [existing.id, c.name?.trim() || null, !!c.marketingConsent, channel]);
      return existing.id;
    }
    const row = await tx.one<{ id: string }>(
      `insert into customers(org_id, display_name, phone_e164, email, marketing_consent, marketing_consent_at, marketing_consent_source)
       values ($1, $2, $3, $4, $5, case when $5 then now() end, case when $5 then $6 end) returning id`,
      [orgId, c.name?.trim() || null, phone, email, !!c.marketingConsent, channel]);
    if (phone) await tx.query(`insert into customer_identities(org_id, customer_id, kind, value) values ($1, $2, 'phone', $3) on conflict do nothing`, [orgId, row.id, phone]);
    if (email) await tx.query(`insert into customer_identities(org_id, customer_id, kind, value) values ($1, $2, 'email', $3) on conflict do nothing`, [orgId, row.id, email]);
    return row.id;
  }

  private async restoreStock(tx: Tx, ctx: TenantContext, orderId: string, branchId: string) {
    await tx.query(
      `update product_branch_settings s set stock_qty = s.stock_qty + l.qty, updated_at = now()
         from (select ol.product_id, sum(ol.quantity) as qty from order_lines ol join products p on p.id = ol.product_id
                where ol.order_id = $1 and p.track_stock group by ol.product_id) l
        where s.product_id = l.product_id and s.branch_id = $2 and s.stock_qty is not null`, [orderId, branchId]);
    await tx.query(
      `with back as (
         insert into stock_movements(org_id, branch_id, item_id, quantity_delta, reason, reference_type, reference_id, actor_id)
         select org_id, branch_id, item_id, -quantity_delta, 'return', 'order', reference_id, $3
           from stock_movements where reference_type = 'order' and reference_id = $1::text and reason = 'sale'
         returning item_id, quantity_delta)
       update stock_levels sl set quantity = sl.quantity + b.quantity_delta, updated_at = now()
         from back b where sl.branch_id = $2 and sl.item_id = b.item_id`, [orderId, branchId, `${ctx.actorType}:${ctx.actorId}`]);
  }
}
