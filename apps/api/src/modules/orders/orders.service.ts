import { Injectable } from '@nestjs/common';
import type { OrderDetail, OrderListQuery, OrderStatus, OrderSummary, StaffOrderRequest } from '@resuto/contracts';
import type { TenantContext } from '../../common/auth/context';
import { DbService, type Tx } from '../../common/db/db.service';
import { DomainError, conflict, invalid, notFound } from '../../common/errors/domain-error';
import { AuditService } from '../../common/platform/audit.service';
import { IdempotencyService } from '../../common/platform/idempotency.service';
import { OrdersKernelService } from '../kernel/orders-kernel.service';
import { PaymentLedgerService } from '../kernel/payment-ledger.service';
import type { OrdersQueryPort } from '../kernel/ports';
import { VisitsService } from './visits.service';

const iso = (d: Date | null | undefined) => (d ? new Date(d).toISOString() : null);

export const toOrderSummary = (r: any): OrderSummary => ({
  id: r.id, number: r.number, publicRef: r.public_ref, branchId: r.branch_id, channel: r.channel, fulfillment: r.fulfillment, status: r.status,
  paymentStatus: r.payment_status, tableId: r.table_id, tableLabel: r.table_label ?? null, visitId: r.visit_id, customerName: r.customer_name,
  currency: r.currency, totalMinor: r.total_minor, paidMinor: r.paid_minor, refundedMinor: r.refunded_minor,
  dueMinor: r.status === 'cancelled' ? 0 : Math.max(0, r.total_minor - (r.paid_minor - r.refunded_minor)), itemCount: Number(r.item_count ?? 0),
  placedAt: iso(r.placed_at)!, businessDate: r.business_date, version: r.version,
});

const csv = (s: string | undefined) => (s ? s.split(',').map((x) => x.trim()).filter(Boolean).slice(0, 20) : null);

function encodeCursor(placedAt: Date, id: string) {
  return Buffer.from(`${new Date(placedAt).toISOString()}|${id}`).toString('base64url');
}
function decodeCursor(c: string | undefined): [string, string] | null {
  if (!c) return null;
  const [at, id] = Buffer.from(c, 'base64url').toString().split('|');
  if (!at || !id || Number.isNaN(Date.parse(at)) || !/^[0-9a-f-]{36}$/i.test(id)) throw invalid('invalid_cursor', 'Invalid cursor');
  return [at, id];
}

/**
 * Staff order management and the ORDERS_QUERY_PORT read model. Order creation
 * and status changes always go through OrdersKernelService; payments through
 * PaymentLedgerService.
 */
@Injectable()
export class OrdersService implements OrdersQueryPort {
  constructor(
    private readonly db: DbService,
    private readonly kernel: OrdersKernelService,
    private readonly ledger: PaymentLedgerService,
    private readonly visits: VisitsService,
    private readonly audit: AuditService,
    private readonly idempotency: IdempotencyService,
  ) {}

  // ---------------------------------------------------------------------------
  // Query port (E2 MCP, B2 analytics)
  // ---------------------------------------------------------------------------
  async list(tx: Tx, ctx: TenantContext, f: Omit<Partial<OrderListQuery>, 'status'> & { status?: string | string[] }): Promise<{ items: OrderSummary[]; nextCursor: string | null }> {
    if (f.branchId) ctx.assertBranch(f.branchId);
    const limit = Math.min(Math.max(Number(f.limit) || 50, 1), 200);
    const cursor = decodeCursor(f.cursor);
    const statuses = Array.isArray(f.status) ? f.status : csv(f.status);
    const rows = await tx.query<any>(
      `select o.*, t.label as table_label, (select coalesce(sum(quantity), 0) from order_lines l where l.order_id = o.id) as item_count
         from orders o left join dining_tables t on t.id = o.table_id
        where o.org_id = $1
          and ($2::uuid is null or o.branch_id = $2)
          and ($3::uuid[] is null or o.branch_id = any($3::uuid[]))
          and ($4::text[] is null or o.status::text = any($4::text[]))
          and ($5::text[] is null or o.channel::text = any($5::text[]))
          and ($6::text is null or o.fulfillment::text = $6)
          and ($7::date is null or o.business_date = $7)
          and ($8::timestamptz is null or o.placed_at >= $8)
          and ($9::timestamptz is null or o.placed_at < $9)
          and ($10::uuid is null or o.visit_id = $10)
          and ($11::text is null or o.number = $11)
          and ($12::timestamptz is null or (o.placed_at, o.id) < ($12::timestamptz, $13::uuid))
        order by o.placed_at desc, o.id desc limit $14`,
      [ctx.orgId, f.branchId ?? null, ctx.branchFilter, statuses, csv(f.channel), f.fulfillment ?? null, f.date ?? null, f.from ?? null, f.to ?? null,
        f.visitId ?? null, f.q?.replace(/^#/, '') || null, cursor?.[0] ?? null, cursor?.[1] ?? null, limit + 1]);
    const page = rows.slice(0, limit);
    return {
      items: page.map(toOrderSummary),
      nextCursor: rows.length > limit ? encodeCursor(page[page.length - 1].placed_at, page[page.length - 1].id) : null,
    };
  }

  async get(tx: Tx, ctx: TenantContext, orderId: string): Promise<OrderDetail> {
    const o = await tx.maybeOne<any>(
      `select o.*, t.label as table_label, (select coalesce(sum(quantity), 0) from order_lines l where l.order_id = o.id) as item_count
         from orders o left join dining_tables t on t.id = o.table_id where o.id = $1`, [orderId]);
    if (!o || !ctx.canAccessBranch(o.branch_id)) throw notFound('Order');
    const lines = await tx.query<any>('select * from order_lines where order_id = $1 order by line_seq', [orderId]);
    const events = await tx.query<any>('select * from order_events where order_id = $1 order by id', [orderId]);
    const payments = await tx.query<any>(
      `select distinct p.* from payments p left join payment_allocations a on a.payment_id = p.id
        where p.order_id = $1 or a.order_id = $1 order by p.created_at`, [orderId]);
    const allocations = await tx.query<any>('select * from payment_allocations where order_id = $1 order by id', [orderId]);
    // Customer contact details are only for roles with customers:read (kitchen sees the name, never the phone/address).
    const pii = ctx.can('customers:read');
    return {
      ...toOrderSummary(o),
      customerId: pii ? o.customer_id : null, customerPhone: pii ? o.customer_phone : null, deliveryAddress: pii ? o.delivery_address : null,
      notes: o.notes, subtotalMinor: o.subtotal_minor, discountMinor: o.discount_minor, deliveryFeeMinor: o.delivery_fee_minor,
      serviceChargeMinor: o.service_charge_minor, taxMinor: o.tax_minor, taxInclusive: o.tax_inclusive,
      acceptedAt: iso(o.accepted_at), readyAt: iso(o.ready_at), fulfilledAt: iso(o.fulfilled_at), cancelledAt: iso(o.cancelled_at),
      cancelReason: o.cancel_reason, scheduledFor: iso(o.scheduled_for),
      lines: lines.map((l) => ({
        id: l.id, productId: l.product_id, name: l.name, nameAr: l.name_ar, quantity: l.quantity, unitPriceMinor: l.unit_price_minor,
        modifiers: l.modifiers, modifiersTotalMinor: l.modifiers_total_minor, lineTotalMinor: l.line_total_minor, station: l.station,
        kitchenStatus: l.kitchen_status, notes: l.notes,
      })),
      events: events.map((e) => ({ id: Number(e.id), type: e.event_type, from: e.from_status, to: e.to_status, actorType: e.actor_type, at: iso(e.created_at)!, details: e.details })),
      payments: payments.map((p) => ({
        id: p.id, method: p.method, provider: p.provider, status: p.status, amountMinor: p.amount_minor, refundedMinor: p.refunded_minor,
        isTest: p.is_test, createdAt: iso(p.created_at)!,
      })),
      allocations: allocations.map((a) => ({ paymentId: a.payment_id, amountMinor: a.amount_minor, kind: a.kind, createdAt: iso(a.created_at)! })),
    };
  }

  listOrders(ctx: TenantContext, q: OrderListQuery) {
    return this.db.scoped(ctx, (tx) => this.list(tx, ctx, q));
  }

  detail(ctx: TenantContext, id: string) {
    return this.db.scoped(ctx, (tx) => this.get(tx, ctx, id));
  }

  // ---------------------------------------------------------------------------
  // Staff-created orders (channel staff/phone)
  // ---------------------------------------------------------------------------
  async create(ctx: TenantContext, body: StaffOrderRequest, key: string | undefined) {
    if (!key) throw invalid('idempotency_key_required', 'An Idempotency-Key header is required');
    ctx.assertBranch(body.branchId);
    return this.db.scoped(ctx, (tx) => this.idempotency.run(tx, ctx.orgId, 'staff-order', key, body, async () => {
      let tableId = body.tableId ?? null;
      let visitId = body.visitId ?? null;
      if (body.fulfillment === 'dine_in') {
        if (visitId) {
          const v = await tx.maybeOne<any>(`select table_id, branch_id, status from visits where id = $1`, [visitId]);
          if (!v || v.branch_id !== body.branchId) throw notFound('Visit');
          if (v.status !== 'open') throw conflict('visit_closed', 'This visit is closed.');
          tableId = v.table_id;
        } else if (tableId) {
          const open = await tx.maybeOne<{ id: string }>(`select id from visits where table_id = $1 and status = 'open'`, [tableId]);
          visitId = open ? open.id : (await this.visits.open(tx, ctx, { tableId, via: 'staff' })).visit.id;
        } else throw invalid('table_required', 'Dine-in orders need a table');
      }
      const placed = await this.kernel.place(tx, ctx, {
        branchId: body.branchId, channel: body.channel, fulfillment: body.fulfillment, lines: body.lines, tableId, visitId,
        customer: body.customer ?? null, deliveryAddress: body.deliveryAddress ?? null, notes: body.notes ?? null, promotionCode: body.promotionCode ?? null,
      });
      await this.audit.record(tx, ctx, { action: 'order.created', entityType: 'order', entityId: placed.id, branchId: body.branchId, metadata: { channel: body.channel, totalMinor: placed.totalMinor } });
      return { id: placed.id, number: placed.number, publicRef: placed.publicRef, status: placed.status, totalMinor: placed.totalMinor, currency: placed.currency, visitId };
    }));
  }

  async transition(ctx: TenantContext, orderId: string, to: OrderStatus, version?: number) {
    return this.db.scoped(ctx, async (tx) => {
      const before = await tx.maybeOne<{ branch_id: string }>('select branch_id from orders where id = $1', [orderId]);
      if (!before || !ctx.canAccessBranch(before.branch_id)) throw notFound('Order');
      const r = await this.kernel.transition(tx, ctx, orderId, to, { expectedVersion: version });
      if (r.changed) await this.audit.record(tx, ctx, { action: 'order.status_changed', entityType: 'order', entityId: orderId, branchId: before.branch_id, metadata: { to } });
      return r;
    });
  }

  /** Cancels an order. Paid orders are never cancelled silently: the refund must be issued first. */
  async cancel(ctx: TenantContext, orderId: string, reason: string, version?: number) {
    return this.db.scoped(ctx, async (tx) => {
      const o = await tx.maybeOne<any>('select * from orders where id = $1 for update', [orderId]);
      if (!o || !ctx.canAccessBranch(o.branch_id)) throw notFound('Order');
      const net = o.paid_minor - o.refunded_minor;
      if (net > 0) {
        const payments = await tx.query<any>(
          `select p.id, p.method, p.provider, sum(a.amount_minor)::bigint as allocated from payment_allocations a join payments p on p.id = a.payment_id
            where a.order_id = $1 group by p.id having sum(a.amount_minor) > 0`, [orderId]);
        throw new DomainError('refund_required', 'This order has been paid. Refund the payment before cancelling it.', 409, {
          paidMinor: net, currency: o.currency, payments: payments.map((p) => ({ id: p.id, method: p.method, provider: p.provider, allocatedMinor: p.allocated })),
        });
      }
      const r = await this.kernel.transition(tx, ctx, orderId, 'cancelled', { reason, expectedVersion: version });
      await this.audit.record(tx, ctx, { action: 'order.cancelled', entityType: 'order', entityId: orderId, branchId: o.branch_id, metadata: { reason, from: o.status } });
      return r;
    });
  }

  /** Counter collection for one order (pickup pay-at-counter, COD handed in, card terminal). */
  async collect(ctx: TenantContext, orderId: string, body: { amountMinor?: number; method: string; reference?: string | null }, key: string | undefined) {
    if (!key) throw invalid('idempotency_key_required', 'An Idempotency-Key header is required');
    return this.db.scoped(ctx, (tx) => this.idempotency.run(tx, ctx.orgId, `order-collect:${orderId}`, key, body, async () => {
      const o = await tx.maybeOne<any>('select * from orders where id = $1 for update', [orderId]);
      if (!o || !ctx.canAccessBranch(o.branch_id)) throw notFound('Order');
      if (o.status === 'cancelled') throw conflict('order_cancelled', 'This order is cancelled.');
      const { dueMinor } = await this.ledger.outstanding(tx, { orderId });
      const amount = body.amountMinor ?? dueMinor;
      if (amount <= 0) throw conflict('nothing_due', 'Nothing is due on this order.');
      const p = await this.ledger.recordSucceeded(tx, ctx, {
        branchId: o.branch_id, orderId, method: body.method as any, provider: 'manual', amountMinor: amount, currency: o.currency,
        idempotencyKey: `order-collect:${orderId}:${key}`, raw: body.reference ? { reference: body.reference } : {},
      });
      await this.audit.record(tx, ctx, { action: 'payment.collected', entityType: 'order', entityId: orderId, branchId: o.branch_id, metadata: { amountMinor: amount, method: body.method, paymentId: p.id } });
      const after = await tx.one<any>('select paid_minor, refunded_minor, total_minor, payment_status from orders where id = $1', [orderId]);
      return { paymentId: p.id, amountMinor: amount, paymentStatus: after.payment_status, dueMinor: Math.max(0, after.total_minor - (after.paid_minor - after.refunded_minor)) };
    }));
  }

  // ---------------------------------------------------------------------------
  // Service requests (waiter / bill) — staff side
  // ---------------------------------------------------------------------------
  async requests(ctx: TenantContext, branchId?: string) {
    if (branchId) ctx.assertBranch(branchId);
    return this.db.scoped(ctx, async (tx) => {
      const rows = await tx.query<any>(
        `select s.*, t.label as table_label, t.id as table_id from service_requests s join visits v on v.id = s.visit_id join dining_tables t on t.id = v.table_id
          where s.org_id = $1 and s.status <> 'resolved' and ($2::uuid is null or s.branch_id = $2) and ($3::uuid[] is null or s.branch_id = any($3::uuid[]))
          order by s.created_at`, [ctx.orgId, branchId ?? null, ctx.branchFilter]);
      return { items: rows.map((r) => ({ id: r.id, kind: r.kind, status: r.status, visitId: r.visit_id, tableId: r.table_id, tableLabel: r.table_label, branchId: r.branch_id, createdAt: iso(r.created_at) })) };
    });
  }

  async resolveRequest(ctx: TenantContext, id: string, status: 'acknowledged' | 'resolved') {
    if (!ctx.can('floor:seat') && !ctx.can('orders:status')) throw new DomainError('forbidden', 'Your role cannot resolve requests', 403);
    return this.db.scoped(ctx, async (tx) => {
      const r = await tx.maybeOne<any>('select * from service_requests where id = $1 for update', [id]);
      if (!r || !ctx.canAccessBranch(r.branch_id)) throw notFound('Request');
      await tx.query(`update service_requests set status = $2, resolved_at = case when $2 = 'resolved' then now() else resolved_at end where id = $1`, [id, status]);
      await this.audit.record(tx, ctx, { action: `service_request.${status}`, entityType: 'service_request', entityId: id, branchId: r.branch_id });
      return { id, status };
    });
  }
}
