import { Inject, Injectable, Optional } from '@nestjs/common';
import { applyBasisPoints, taxFromInclusive, type Fulfillment, type QuoteLoyalty } from '@resuto/contracts';
import type { Tx } from '../../common/db/db.service';
import { DomainError, invalid } from '../../common/errors/domain-error';
import { LOYALTY_PORT, type LoyaltyPort } from './ports';

export interface CartLineInput {
  productId: string;
  quantity: number;
  modifiers?: Array<{ groupId: string; optionId: string }>;
  notes?: string | null;
}

export interface PricedLine {
  productId: string;
  name: string;
  nameAr: string | null;
  unitPriceMinor: number;
  quantity: number;
  modifiers: Array<{ groupId: string; group: string; optionId: string; option: string; optionAr: string | null; priceDeltaMinor: number }>;
  modifiersTotalMinor: number;
  lineTotalMinor: number;
  costMinor: number | null;
  station: string;
  trackStock: boolean;
  notes: string | null;
}

export interface Quote {
  branchId: string;
  currency: 'EGP' | 'SAR';
  fulfillment: Fulfillment;
  lines: PricedLine[];
  subtotalMinor: number;
  discountMinor: number;
  deliveryFeeMinor: number;
  serviceChargeMinor: number;
  taxMinor: number;
  taxInclusive: boolean;
  vatRateBp: number;
  totalMinor: number;
  promotion: { id: string; code: string | null; name: string } | null;
  /** Loyalty reward applied (its discount is included in discountMinor), earn preview and balance; null when loyalty is off. */
  loyalty: QuoteLoyalty | null;
}

export interface QuoteInput {
  branchId: string;
  fulfillment: Fulfillment;
  lines: CartLineInput[];
  promotionCode?: string | null;
  channel?: string;
  customerId?: string | null;
  /** FT-03: redeem this loyalty reward (requires `customerIdentified`). */
  loyaltyRewardId?: string | null;
  /** The caller has established who `customerId` is (never true for an unverified phone typed on the website). */
  customerIdentified?: boolean;
}

const MAX_LINES = 60;

/**
 * Server-side pricing: the only place order totals are computed. Every channel
 * (QR, web, WhatsApp, staff, MCP) quotes through here, so client-supplied
 * prices are never trusted. Must run inside a tenant-scoped transaction.
 */
@Injectable()
export class PricingService {
  constructor(@Optional() @Inject(LOYALTY_PORT) private readonly loyalty?: LoyaltyPort) {}

  async quote(tx: Tx, orgId: string, input: QuoteInput): Promise<Quote> {
    if (!input.lines.length) throw invalid('cart_empty', 'Add at least one item');
    if (input.lines.length > MAX_LINES) throw invalid('cart_too_large', `At most ${MAX_LINES} lines per order`);
    for (const l of input.lines) {
      if (!Number.isInteger(l.quantity) || l.quantity < 1 || l.quantity > 99) throw invalid('invalid_quantity', 'Quantities must be between 1 and 99');
    }

    const branch = await tx.maybeOne<any>(
      `select b.*, o.currency from branches b join organizations o on o.id = b.org_id where b.id = $1 and b.org_id = $2`, [input.branchId, orgId]);
    if (!branch || !branch.is_active) throw new DomainError('branch_unavailable', 'This branch is not taking orders', 409);
    const accepts = { dine_in: branch.accepts_dine_in, pickup: branch.accepts_pickup, delivery: branch.accepts_delivery }[input.fulfillment];
    if (!accepts) throw new DomainError('fulfillment_unavailable', `This branch does not offer ${input.fulfillment.replace('_', '-')}`, 409);

    const productIds = [...new Set(input.lines.map((l) => l.productId))];
    const products = await tx.query<any>(
      `select p.id, p.name, p.name_ar, p.price_minor, p.cost_minor, p.station, p.track_stock, p.is_active, p.currency,
              coalesce(s.is_available, true) as available, s.price_override_minor, s.stock_qty, c.is_active as category_active
         from products p
         join menu_categories c on c.id = p.category_id
         join menus m on m.id = c.menu_id
         left join product_branch_settings s on s.product_id = p.id and s.branch_id = $2
        where p.org_id = $1 and p.id = any($3::uuid[]) and m.is_active and (m.branch_id is null or m.branch_id = $2)`,
      [orgId, input.branchId, productIds]);
    const byId = new Map(products.map((p) => [p.id, p]));

    const groups = await tx.query<any>(
      `select pmg.product_id, g.id, g.name, g.min_select, g.max_select
         from product_modifier_groups pmg join modifier_groups g on g.id = pmg.group_id
        where pmg.product_id = any($1::uuid[]) and g.is_active`, [productIds]);
    const options = groups.length
      ? await tx.query<any>(`select id, group_id, name, name_ar, price_delta_minor, is_available from modifier_options where group_id = any($1::uuid[])`,
        [[...new Set(groups.map((g) => g.id))]])
      : [];
    const optionById = new Map(options.map((o) => [o.id, o]));

    const requested = new Map<string, number>();
    const lines: PricedLine[] = input.lines.map((l) => {
      const p = byId.get(l.productId);
      if (!p || !p.is_active || !p.category_active) throw new DomainError('item_unavailable', 'An item in your cart is no longer on the menu', 409, { productId: l.productId });
      if (!p.available) throw new DomainError('item_unavailable', `${p.name} is unavailable right now`, 409, { productId: p.id });
      if (p.currency !== branch.currency) throw new Error(`product ${p.id} currency mismatch`);
      const productGroups = groups.filter((g) => g.product_id === p.id);
      const chosen = l.modifiers ?? [];
      const mods: PricedLine['modifiers'] = [];
      for (const g of productGroups) {
        const picks = chosen.filter((c) => c.groupId === g.id);
        if (picks.length < g.min_select || picks.length > g.max_select) {
          throw invalid('invalid_modifiers', `Choose ${g.min_select === g.max_select ? g.min_select : `${g.min_select}–${g.max_select}`} option(s) for ${g.name}`, { productId: p.id, groupId: g.id });
        }
        if (new Set(picks.map((x) => x.optionId)).size !== picks.length) throw invalid('invalid_modifiers', `Duplicate option for ${g.name}`);
        for (const pick of picks) {
          const o = optionById.get(pick.optionId);
          if (!o || o.group_id !== g.id || !o.is_available) throw invalid('invalid_modifiers', `An option for ${g.name} is unavailable`, { optionId: pick.optionId });
          mods.push({ groupId: g.id, group: g.name, optionId: o.id, option: o.name, optionAr: o.name_ar, priceDeltaMinor: o.price_delta_minor });
        }
      }
      if (chosen.some((c) => !productGroups.some((g) => g.id === c.groupId))) throw invalid('invalid_modifiers', `Unknown option for ${p.name}`);
      const unit = p.price_override_minor ?? p.price_minor;
      const modsTotal = mods.reduce((a, m) => a + m.priceDeltaMinor, 0);
      if (p.track_stock) requested.set(p.id, (requested.get(p.id) ?? 0) + l.quantity);
      return {
        productId: p.id, name: p.name, nameAr: p.name_ar, unitPriceMinor: unit, quantity: l.quantity, modifiers: mods,
        modifiersTotalMinor: modsTotal, lineTotalMinor: (unit + modsTotal) * l.quantity, costMinor: p.cost_minor,
        station: p.station, trackStock: p.track_stock, notes: l.notes?.trim().slice(0, 200) || null,
      };
    });

    for (const [productId, qty] of requested) {
      const p = byId.get(productId)!;
      if (p.stock_qty !== null && p.stock_qty < qty) {
        throw new DomainError('out_of_stock', `Only ${p.stock_qty} × ${p.name} left`, 409, { productId, available: p.stock_qty });
      }
    }

    const subtotal = lines.reduce((a, l) => a + l.lineTotalMinor, 0);
    if (input.fulfillment === 'delivery' && subtotal < branch.min_order_minor) {
      throw new DomainError('below_minimum', 'The order is below the minimum for delivery', 409, { minOrderMinor: branch.min_order_minor });
    }
    const tax = await tx.maybeOne<{ vat_rate_bp: number; prices_include_tax: boolean; service_charge_bp: number }>(
      'select vat_rate_bp, prices_include_tax, service_charge_bp from tax_profiles where org_id = $1', [orgId]);
    const vatRateBp = tax?.vat_rate_bp ?? 0;
    const inclusive = tax?.prices_include_tax ?? true;

    let deliveryFee = input.fulfillment === 'delivery' ? Number(branch.delivery_fee_minor) : 0;
    let discount = 0;
    let promotion: Quote['promotion'] = null;
    if (input.promotionCode) {
      const promo = await this.findPromotion(tx, orgId, input.promotionCode, input.branchId, input.channel, input.customerId ?? null);
      if (subtotal < Number(promo.min_order_minor)) throw new DomainError('promotion_minimum', 'The order is below this offer’s minimum', 409);
      if (promo.kind === 'free_delivery') {
        discount = 0;
        deliveryFee = 0;
      } else {
        discount = promo.kind === 'percent' ? applyBasisPoints(subtotal, promo.value) : Number(promo.value);
        if (promo.max_discount_minor !== null) discount = Math.min(discount, Number(promo.max_discount_minor));
        discount = Math.min(discount, subtotal);
      }
      promotion = { id: promo.id, code: promo.code, name: promo.name };
    }
    let loyalty: QuoteLoyalty | null = null;
    if (this.loyalty) {
      loyalty = await this.loyalty.priceOrder(tx, orgId, {
        branchId: input.branchId, channel: input.channel, customerId: input.customerId ?? null, identified: !!input.customerIdentified,
        rewardId: input.loyaltyRewardId ?? null, lines: lines.map((l) => ({ productId: l.productId, lineTotalMinor: l.lineTotalMinor })),
        subtotalMinor: subtotal, discountMinor: discount,
      });
      if (loyalty?.reward) discount = Math.min(subtotal, discount + loyalty.reward.discountMinor);
    } else if (input.loyaltyRewardId) {
      throw new DomainError('module_unavailable', 'Loyalty is not available in this deployment', 503);
    }
    const serviceCharge = input.fulfillment === 'dine_in' ? applyBasisPoints(subtotal - discount, tax?.service_charge_bp ?? 0) : 0;
    const taxable = subtotal - discount + serviceCharge + deliveryFee;
    const taxMinor = inclusive ? taxFromInclusive(taxable, vatRateBp) : applyBasisPoints(taxable, vatRateBp);
    const total = subtotal - discount + deliveryFee + serviceCharge + (inclusive ? 0 : taxMinor);

    return {
      branchId: input.branchId, currency: branch.currency, fulfillment: input.fulfillment, lines,
      subtotalMinor: subtotal, discountMinor: discount, deliveryFeeMinor: deliveryFee, serviceChargeMinor: serviceCharge,
      taxMinor, taxInclusive: inclusive, vatRateBp, totalMinor: total, promotion, loyalty,
    };
  }

  private async findPromotion(tx: Tx, orgId: string, code: string, branchId: string, channel: string | undefined, customerId: string | null) {
    const p = await tx.maybeOne<any>(
      `select * from promotions where org_id = $1 and code = $2 and is_active
          and (starts_at is null or starts_at <= now()) and (ends_at is null or ends_at > now())`, [orgId, code.trim()]);
    if (!p) throw new DomainError('promotion_invalid', 'This offer code is not valid', 409);
    if (p.branch_ids && !p.branch_ids.includes(branchId)) throw new DomainError('promotion_invalid', 'This offer is not valid at this branch', 409);
    if (p.channels && channel && !p.channels.includes(channel)) throw new DomainError('promotion_invalid', 'This offer is not valid for this channel', 409);
    if (p.max_redemptions !== null && p.redemption_count >= p.max_redemptions) throw new DomainError('promotion_exhausted', 'This offer has been fully redeemed', 409);
    if (p.per_customer_limit !== null && customerId) {
      const { n } = await tx.one<{ n: number }>('select count(*)::int as n from promotion_redemptions where promotion_id = $1 and customer_id = $2', [p.id, customerId]);
      if (n >= p.per_customer_limit) throw new DomainError('promotion_limit', 'You have already used this offer', 409);
    }
    return p;
  }
}
