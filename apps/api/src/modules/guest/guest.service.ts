import { createHash } from 'node:crypto';
import { Inject, Injectable, Optional } from '@nestjs/common';
import { normalizePhone, type CartLine, type GuestOrderRequest, type GuestVisitPoll, type PublicMenu, type WebOrderRequest } from '@resuto/contracts';
import { TenantContext } from '../../common/auth/context';
import { DbService, type Tx } from '../../common/db/db.service';
import { conflict, invalid, notFound } from '../../common/errors/domain-error';
import { IdempotencyService } from '../../common/platform/idempotency.service';
import { EntitlementsService } from '../../common/entitlements/entitlements.service';
import { StorageService } from '../../common/storage/storage.service';
import { OrdersKernelService } from '../kernel/orders-kernel.service';
import { CHECKOUT_PORT, requirePort, type CheckoutPort } from '../kernel/ports';
import { PricingService, type Quote } from '../kernel/pricing.service';
import { MenuService } from '../menu/menu.service';
import { guestCoverPath, signGuestCover } from '../orders/guest-cover';
import { orgCountry } from '../orders/org-country';
import { VisitsService } from '../orders/visits.service';

const iso = (d: Date | null | undefined) => (d ? new Date(d).toISOString() : null);

/** Client-facing quote: totals and priced lines, never costs or stock. */
export const toQuoteView = (q: Quote) => ({
  currency: q.currency, fulfillment: q.fulfillment, subtotalMinor: q.subtotalMinor, discountMinor: q.discountMinor, deliveryFeeMinor: q.deliveryFeeMinor,
  serviceChargeMinor: q.serviceChargeMinor, taxMinor: q.taxMinor, taxInclusive: q.taxInclusive, vatRateBp: q.vatRateBp, totalMinor: q.totalMinor,
  promotion: q.promotion ? { code: q.promotion.code, name: q.promotion.name } : null,
  // FT-03: the reward applied (already in discountMinor), points this order earns once paid, and the balance only
  // when the channel identified the customer.
  loyalty: q.loyalty ? { reward: q.loyalty.reward ? { id: q.loyalty.reward.id, name: q.loyalty.reward.name, nameAr: q.loyalty.reward.nameAr,
    pointsCost: q.loyalty.reward.pointsCost, discountMinor: q.loyalty.reward.discountMinor } : null, earnPreview: q.loyalty.earnPreview, balance: q.loyalty.balance } : null,
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
    private readonly entitlements: EntitlementsService,
    private readonly storage: StorageService,
    @Optional() @Inject(CHECKOUT_PORT) private readonly checkout?: CheckoutPort,
  ) {}

  // ---------------------------------------------------------------------------
  // QR table ordering
  // ---------------------------------------------------------------------------
  /** The table view; with the version the guest already has, an unchanged visit answers in a few bytes (PCL-18). */
  current(token: string | undefined, version?: string): Promise<GuestVisitPoll> {
    return this.visits.withGuestRead(token, async (tx, g) => {
      const view = await this.visits.guestView(tx, g.visit);
      return version && version === view.version ? { unchanged: true as const, version } : view;
    });
  }

  async visitMenu(token: string | undefined): Promise<PublicMenu> {
    // Image URLs are signed in one batch after the guest transaction (PCL-11, PS-18).
    const urls = this.menu.publicMediaUrls();
    const menu = await this.visits.withGuestRead(token, async (tx, g) => {
      const branch = await tx.one('select * from branches where id = $1', [g.visit.branch_id]);
      return this.menu.publicMenuFor(tx, g.ctx.orgId, branch, undefined, urls);
    });
    await urls.resolve();
    return menu;
  }

  quote(token: string | undefined, body: { lines: CartLine[]; promotionCode?: string | null; loyaltyRewardId?: string | null }) {
    return this.visits.withGuest(token, async (tx, g) => toQuoteView(await this.pricing.quote(tx, g.ctx.orgId, {
      branchId: g.visit.branch_id, fulfillment: 'dine_in', lines: cartLines(body.lines), promotionCode: body.promotionCode ?? null, channel: 'qr',
      // A visit's customer is linked by staff (reservation/host), so the table may see that balance and redeem.
      customerId: g.visit.customer_id, customerIdentified: !!g.visit.customer_id, loyaltyRewardId: body.loyaltyRewardId ?? null,
    })));
  }

  /** Active rewards of the restaurant (public names and costs only) for the guest checkout. */
  async rewards(tx: Tx, orgId: string) {
    const rows = await tx.query<any>(
      `select r.id, r.name, r.name_ar, r.points_cost, r.kind, r.value, r.max_discount_minor, r.min_order_minor from loyalty_rewards r
         join loyalty_programs p on p.org_id = r.org_id and p.is_active where r.org_id = $1 and r.is_active order by r.points_cost`, [orgId]);
    return rows.map((r) => ({ id: r.id, name: r.name, nameAr: r.name_ar, pointsCost: r.points_cost, kind: r.kind, value: Number(r.value),
      maxDiscountMinor: r.max_discount_minor === null ? null : Number(r.max_discount_minor), minOrderMinor: Number(r.min_order_minor) }));
  }

  visitRewards(token: string | undefined) {
    return this.visits.withGuestRead(token, async (tx, g) => ({ identified: !!g.visit.customer_id, rewards: g.visit.customer_id ? await this.rewards(tx, g.ctx.orgId) : [] }));
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
        customerIdentified: !!g.visit.customer_id, loyaltyRewardId: body.loyaltyRewardId ?? null,
        expectedTotalMinor: body.expectedTotalMinor,
      });
      return { id: placed.id, number: placed.number, publicRef: placed.publicRef, status: placed.status, totalMinor: placed.totalMinor, currency: placed.currency };
    }));
  }

  orderStatus(token: string | undefined, orderId: string) {
    return this.visits.withGuestRead(token, async (tx, g) => {
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
    return (await this.cachedWebMenu(slug, branchCode)).body;
  }

  /** Web-order menu with a validator (PCL-15): the public menu's version plus the online-payment flag. */
  async cachedWebMenu(slug: string, branchCode?: string) {
    const { menu, etag, orgId } = await this.menu.cachedPublicMenu(slug, branchCode);
    // Offer online payment only when ResutoPay is deployed and this restaurant's plan includes it.
    const online = !!this.checkout && (await this.entitlements.isEnabled(orgId, 'pay'));
    // The cover is the published site's hero; its path is read in a short transaction and signed afterwards (PCL-11).
    // The validator covers it too, so a new hero image is not hidden behind a 304.
    const coverPath = await this.db.withTenant(orgId, (tx) => guestCoverPath(tx, orgId), 'guest:cover');
    const cover = await signGuestCover(this.storage, coverPath);
    const coverTag = coverPath ? createHash('sha1').update(coverPath).digest('hex').slice(0, 8) : '0';
    return { etag: etag && etag.replace(/"$/, `-${online ? 1 : 0}-${coverTag}"`).replace('W/"pm', 'W/"po'), body: {
      ...menu,
      cover,
      payment: {
        payAtPickup: menu.branch.acceptsPickup,
        cashOnDelivery: menu.branch.acceptsDelivery,
        online,
      },
    } };
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

  /** `onPhone` sees the customer's number once normalised to E.164 (the controller's per-number abuse limit). */
  webOrder(slug: string, body: WebOrderRequest, key: string | undefined, onPhone?: (e164: string) => void) {
    if (!key || key.length < 8 || key.length > 200) throw invalid('idempotency_key_required', 'An Idempotency-Key header is required');
    if (body.payment === 'pay_at_pickup' && body.fulfillment !== 'pickup') throw invalid('payment_unavailable', 'Pay at pickup is only for pickup orders');
    if (body.payment === 'cod' && body.fulfillment !== 'delivery') throw invalid('payment_unavailable', 'Cash on delivery is only for delivery orders');
    if (body.fulfillment === 'delivery' && !body.deliveryAddress) throw invalid('address_required', 'Delivery orders need an address');
    const checkout = body.payment === 'online' ? requirePort(this.checkout, 'Online payment (ResutoPay)') : null;
    return this.webTenant(slug, async (tx, ctx) => {
      await this.assertBranch(tx, ctx.orgId, body.branchId);
      // CR-06: the phone as typed (01x…, Arabic-Indic digits) becomes E.164 for the restaurant's country.
      const phone = normalizePhone(body.customer.phone, await orgCountry(tx, ctx.orgId));
      if (!phone) throw invalid('phone_invalid', 'Enter a phone number the restaurant can call, e.g. 010 0123 4567.');
      onPhone?.(phone);
      body = { ...body, customer: { ...body.customer, phone } };
      const { returnUrl: _r, ...payload } = body;
      const order = await this.idempotency.run(tx, ctx.orgId, 'web-order', key, payload, async () => {
        // Tracking links (Marketing) append rcid=<campaignId>; only this restaurant's campaigns count.
        const rcid = body.attribution?.campaignId ?? body.attribution?.rcid;
        const campaign = rcid && /^[0-9a-f-]{36}$/i.test(rcid)
          ? await tx.maybeOne<{ id: string }>('select id from campaigns where id = $1 and org_id = $2', [rcid, ctx.orgId]) : null;
        const placed = await this.kernel.place(tx, ctx, {
          campaignId: campaign?.id ?? null,
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

