import { Inject, Injectable, Optional } from '@nestjs/common';
import type { CartLine, GuestOrderRequest, PublicMenu, WebOrderRequest } from '@resuto/contracts';
import { TenantContext } from '../../common/auth/context';
import { DbService, type Tx } from '../../common/db/db.service';
import { conflict, invalid, notFound } from '../../common/errors/domain-error';
import { IdempotencyService } from '../../common/platform/idempotency.service';
import { OrdersKernelService } from '../kernel/orders-kernel.service';
import { CHECKOUT_PORT, requirePort, type CheckoutPort } from '../kernel/ports';
import { PricingService, type Quote } from '../kernel/pricing.service';
import { MenuService } from '../menu/menu.service';
import { VisitsService } from '../orders/visits.service';

const iso = (d: Date | null | undefined) => (d ? new Date(d).toISOString() : null);

/** Client-facing quote: totals and priced lines, never costs or stock. */
export const toQuoteView = (q: Quote) => ({
  currency: q.currency, fulfillment: q.fulfillment, subtotalMinor: q.subtotalMinor, discountMinor: q.discountMinor, deliveryFeeMinor: q.deliveryFeeMinor,
  serviceChargeMinor: q.serviceChargeMinor, taxMinor: q.taxMinor, taxInclusive: q.taxInclusive, vatRateBp: q.vatRateBp, totalMinor: q.totalMinor,
  promotion: q.promotion ? { code: q.promotion.code, name: q.promotion.name } : null,
  lines: q.lines.map((l) => ({
    productId: l.productId, name: l.name, nameAr: l.nameAr, quantity: l.quantity, unitPriceMinor: l.unitPriceMinor,
    modifiers: l.modifiers.map((m) => ({ groupId: m.groupId, optionId: m.optionId, option: m.option, optionAr: m.optionAr, priceDeltaMinor: m.priceDeltaMinor })),
    lineTotalMinor: l.lineTotalMinor, notes: l.notes,
  })),
});

const cartLines = (lines: CartLine[]) => lines.map((l) => ({ productId: l.productId, quantity: l.quantity, modifiers: l.modifiers, notes: l.notes ?? null }));

/**
 * Public guest flows: QR table ordering (bearer = visit token) and website
 * pickup/delivery ordering (channel `web`). Prices always come from the kernel
 * PricingService; orders are placed with OrdersKernelService.
 */
@Injectable()
export class GuestService {
  constructor(
    private readonly db: DbService,
    private readonly visits: VisitsService,
    private readonly kernel: OrdersKernelService,
    private readonly pricing: PricingService,
    private readonly menu: MenuService,
    private readonly idempotency: IdempotencyService,
    @Optional() @Inject(CHECKOUT_PORT) private readonly checkout?: CheckoutPort,
  ) {}

  // ---------------------------------------------------------------------------
  // QR table ordering
  // ---------------------------------------------------------------------------
  current(token: string | undefined) {
    return this.visits.withGuest(token, (tx, g) => this.visits.guestView(tx, g.visit));
  }

  visitMenu(token: string | undefined): Promise<PublicMenu> {
    return this.visits.withGuest(token, async (tx, g) => {
      const branch = await tx.one('select * from branches where id = $1', [g.visit.branch_id]);
      return this.menu.publicMenuFor(tx, g.ctx.orgId, branch);
    });
  }

  quote(token: string | undefined, body: { lines: CartLine[]; promotionCode?: string | null }) {
    return this.visits.withGuest(token, async (tx, g) => toQuoteView(await this.pricing.quote(tx, g.ctx.orgId, {
      branchId: g.visit.branch_id, fulfillment: 'dine_in', lines: cartLines(body.lines), promotionCode: body.promotionCode ?? null, channel: 'qr',
      customerId: g.visit.customer_id,
    })));
  }

  placeOrder(token: string | undefined, body: GuestOrderRequest, key: string | undefined) {
    if (!key || key.length < 8 || key.length > 200) throw invalid('idempotency_key_required', 'An Idempotency-Key header is required');
    return this.visits.withGuest(token, (tx, g) => this.idempotency.run(tx, g.ctx.orgId, `guest-order:${g.visit.id}`, key, body, async () => {
      if (await this.visits.settling(tx, g.visit.id)) {
        throw conflict('bill_settling', 'A payment is being processed. New orders resume as soon as it finishes.');
      }
      const placed = await this.kernel.place(tx, g.ctx, {
        branchId: g.visit.branch_id, channel: 'qr', fulfillment: 'dine_in', tableId: g.visit.table_id, visitId: g.visit.id,
        customerId: g.visit.customer_id, lines: cartLines(body.lines), notes: body.notes ?? null, promotionCode: body.promotionCode ?? null,
        expectedTotalMinor: body.expectedTotalMinor,
      });
      return { id: placed.id, number: placed.number, publicRef: placed.publicRef, status: placed.status, totalMinor: placed.totalMinor, currency: placed.currency };
    }));
  }

  orderStatus(token: string | undefined, orderId: string) {
    return this.visits.withGuest(token, async (tx, g) => {
      const o = await tx.maybeOne<any>('select * from orders where id = $1 and visit_id = $2', [orderId, g.visit.id]);
      if (!o) throw notFound('Order');
      return this.publicOrder(tx, o);
    });
  }

  request(token: string | undefined, kind: 'waiter' | 'bill') {
    return this.visits.withGuest(token, async (tx, g) => {
      // One open request per kind (legacy dedupe); repeats return the existing one.
      const inserted = await tx.maybeOne<any>(
        `insert into service_requests(org_id, branch_id, visit_id, kind) values ($1, $2, $3, $4)
         on conflict (visit_id, kind) where status <> 'resolved' do nothing returning *`, [g.ctx.orgId, g.visit.branch_id, g.visit.id, kind]);
      const row = inserted ?? await tx.one<any>(`select * from service_requests where visit_id = $1 and kind = $2 and status <> 'resolved'`, [g.visit.id, kind]);
      return { id: row.id, kind: row.kind, status: row.status, createdAt: iso(row.created_at), duplicate: !inserted };
    });
  }

  private async publicOrder(tx: Tx, o: any) {
    const lines = await tx.query<any>('select name, name_ar, quantity, line_total_minor, kitchen_status, modifiers, notes from order_lines where order_id = $1 order by line_seq', [o.id]);
    const events = await tx.query<any>(`select to_status, created_at from order_events where order_id = $1 and to_status is not null order by id`, [o.id]);
    return {
      id: o.id, number: o.number, publicRef: o.public_ref, status: o.status, paymentStatus: o.payment_status, fulfillment: o.fulfillment,
      currency: o.currency, subtotalMinor: o.subtotal_minor, deliveryFeeMinor: o.delivery_fee_minor, discountMinor: o.discount_minor,
      serviceChargeMinor: o.service_charge_minor, taxMinor: o.tax_minor, totalMinor: o.total_minor,
      dueMinor: o.status === 'cancelled' ? 0 : Math.max(0, o.total_minor - (o.paid_minor - o.refunded_minor)),
      placedAt: iso(o.placed_at), readyAt: iso(o.ready_at), fulfilledAt: iso(o.fulfilled_at), cancelledAt: iso(o.cancelled_at),
      lines: lines.map((l) => ({ name: l.name, nameAr: l.name_ar, quantity: l.quantity, lineTotalMinor: l.line_total_minor, kitchenStatus: l.kitchen_status,
        modifiers: (l.modifiers as any[]).map((m) => m.option), notes: l.notes })),
      timeline: events.map((e) => ({ status: e.to_status, at: iso(e.created_at) })),
    };
  }

  // ---------------------------------------------------------------------------
  // Website pickup / delivery ordering (/v1/public/order/:slug)
  // ---------------------------------------------------------------------------
  private async webTenant<T>(slug: string, fn: (tx: Tx, ctx: TenantContext) => Promise<T>): Promise<T> {
    const org = await this.menu.resolveOrgBySlug(slug);
    return this.db.withTenant(org.id, (tx) => fn(tx, new TenantContext(org.id, 'waiter', null, null, 'guest', 'web', 'web')), 'guest:web-order');
  }

  async webMenu(slug: string, branchCode?: string) {
    const menu = await this.menu.publicMenu(slug, branchCode);
    return {
      ...menu,
      payment: {
        payAtPickup: menu.branch.acceptsPickup,
        cashOnDelivery: menu.branch.acceptsDelivery,
        online: !!this.checkout,
      },
    };
  }

  webQuote(slug: string, body: { branchId: string; fulfillment: 'pickup' | 'delivery'; lines: CartLine[]; promotionCode?: string | null }) {
    return this.webTenant(slug, async (tx, ctx) => {
      await this.assertBranch(tx, ctx.orgId, body.branchId);
      return toQuoteView(await this.pricing.quote(tx, ctx.orgId, {
        branchId: body.branchId, fulfillment: body.fulfillment, lines: cartLines(body.lines), promotionCode: body.promotionCode ?? null, channel: 'web',
      }));
    });
  }

  private async assertBranch(tx: Tx, orgId: string, branchId: string) {
    const b = await tx.maybeOne('select 1 from branches where id = $1 and org_id = $2 and is_active', [branchId, orgId]);
    if (!b) throw notFound('Branch');
  }

  webOrder(slug: string, body: WebOrderRequest, key: string | undefined) {
    if (!key || key.length < 8 || key.length > 200) throw invalid('idempotency_key_required', 'An Idempotency-Key header is required');
    if (body.payment === 'pay_at_pickup' && body.fulfillment !== 'pickup') throw invalid('payment_unavailable', 'Pay at pickup is only for pickup orders');
    if (body.payment === 'cod' && body.fulfillment !== 'delivery') throw invalid('payment_unavailable', 'Cash on delivery is only for delivery orders');
    if (body.fulfillment === 'delivery' && !body.deliveryAddress) throw invalid('address_required', 'Delivery orders need an address');
    const checkout = body.payment === 'online' ? requirePort(this.checkout, 'Online payment (ResutoPay)') : null;
    return this.webTenant(slug, async (tx, ctx) => {
      await this.assertBranch(tx, ctx.orgId, body.branchId);
      const { returnUrl: _r, ...payload } = body;
      const order = await this.idempotency.run(tx, ctx.orgId, 'web-order', key, payload, async () => {
        const placed = await this.kernel.place(tx, ctx, {
          branchId: body.branchId, channel: 'web', fulfillment: body.fulfillment, lines: cartLines(body.lines),
          customer: { name: body.customer.name, phone: body.customer.phone, email: body.customer.email ?? null, marketingConsent: body.customer.marketingConsent },
          deliveryAddress: body.deliveryAddress ?? null, notes: body.notes ?? null, promotionCode: body.promotionCode ?? null,
          scheduledFor: body.scheduledFor ?? null, attribution: body.attribution ?? {}, expectedTotalMinor: body.expectedTotalMinor,
          initialStatus: body.payment === 'online' ? 'awaiting_payment' : 'placed',
        });
        if (body.payment !== 'online') {
          await this.kernel.event(tx, ctx, placed.id, 'payment_method_selected', null, null, { method: body.payment });
        }
        return { id: placed.id, number: placed.number, publicRef: placed.publicRef, status: placed.status, totalMinor: placed.totalMinor, currency: placed.currency, customerId: placed.customerId };
      });
      let session: { id: string; url: string; token: string; expiresAt: string } | null = null;
      if (checkout) {
        const current = await tx.one<{ status: string }>('select status from orders where id = $1', [order.id]);
        // The checkout token is a bearer credential: it is never stored in the idempotency record, so a retry gets a fresh link.
        if (current.status === 'awaiting_payment') {
          const s = await checkout.createSession(tx, ctx, {
            purpose: 'order', orderId: order.id, channel: 'web', returnUrl: body.returnUrl ?? null, customerId: order.customerId ?? null,
          });
          session = { id: s.id, url: s.url, token: s.token, expiresAt: s.expiresAt };
        }
      }
      const { customerId: _c, ...publicOrder } = order;
      return { order: publicOrder, payment: body.payment, checkout: session };
    });
  }

  webOrderStatus(slug: string, publicRef: string) {
    if (!/^[0-9a-f]{12,64}$/.test(publicRef)) throw notFound('Order');
    return this.webTenant(slug, async (tx) => {
      const o = await tx.maybeOne<any>(`select * from orders where public_ref = $1 and channel = 'web'`, [publicRef]);
      if (!o) throw notFound('Order');
      return this.publicOrder(tx, o);
    });
  }
}

