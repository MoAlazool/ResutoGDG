import type { FiscalLine } from '@resuto/contracts';

/**
 * Largest-remainder allocation: splits `total` across `weights` in integer
 * minor units so the parts always sum to `total` exactly. Ties go to the
 * earliest index (deterministic).
 */
export function allocate(total: number, weights: number[]): number[] {
  if (!weights.length) return [];
  const sumW = weights.reduce((a, b) => a + b, 0);
  if (sumW <= 0) return weights.map((_, i) => (i === 0 ? total : 0));
  const raw = weights.map((w) => (total * w) / sumW);
  const parts = raw.map((r) => Math.floor(r));
  let remainder = total - parts.reduce((a, b) => a + b, 0);
  const order = raw.map((r, i) => ({ i, frac: r - Math.floor(r) })).sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (let k = 0; remainder > 0; k = (k + 1) % order.length, remainder--) parts[order[k]!.i]! += 1;
  return parts;
}

export interface OrderForFiscal {
  subtotal_minor: number;
  discount_minor: number;
  delivery_fee_minor: number;
  service_charge_minor: number;
  tax_minor: number;
  tax_inclusive: boolean;
  total_minor: number;
}

export interface OrderLineForFiscal {
  product_id: string | null;
  name: string;
  name_ar: string | null;
  quantity: number;
  unit_price_minor: number;
  modifiers_total_minor: number;
  line_total_minor: number;
}

/**
 * Builds fiscal lines that reconcile exactly to the order (integer minor
 * units, VAT taken from the order, never recomputed from a rate):
 *  1. the order discount is spread over item lines by value;
 *  2. the order's VAT is spread over every taxable line (items after discount,
 *     delivery fee, service charge) by value;
 *  3. tax-inclusive orders: net = base − VAT; exclusive: gross = base + VAT.
 * Σ net = total − tax, Σ VAT = order tax, Σ gross = order total.
 */
export function fiscalLinesForOrder(order: OrderForFiscal, lines: OrderLineForFiscal[], vatRateBp: number): FiscalLine[] {
  const items = lines.map((l) => ({
    name: l.name, nameAr: l.name_ar, kind: 'item' as const, quantity: l.quantity,
    unitPriceMinor: l.unit_price_minor + l.modifiers_total_minor, gross: l.line_total_minor, code: l.product_id,
  }));
  const itemsTotal = items.reduce((s, l) => s + l.gross, 0);
  const drafts: Array<{ code: string | null; name: string; nameAr: string | null; kind: FiscalLine['kind']; quantity: number; unitPriceMinor: number; base: number; discount: number }> = [];
  const discounts = allocate(Math.min(order.discount_minor, itemsTotal), items.map((l) => l.gross));
  items.forEach((l, i) => drafts.push({ code: l.code, name: l.name, nameAr: l.nameAr, kind: 'item', quantity: l.quantity, unitPriceMinor: l.unitPriceMinor, base: l.gross - discounts[i]!, discount: discounts[i]! }));
  // Order lines should always add up to the subtotal; keep the document reconciled if they do not.
  if (itemsTotal !== order.subtotal_minor) {
    drafts.push({ code: 'adjustment', name: 'Adjustment', nameAr: 'تسوية', kind: 'adjustment', quantity: 1, unitPriceMinor: order.subtotal_minor - itemsTotal, base: order.subtotal_minor - itemsTotal, discount: 0 });
  }
  if (order.delivery_fee_minor > 0) {
    drafts.push({ code: 'delivery', name: 'Delivery fee', nameAr: 'رسوم التوصيل', kind: 'delivery_fee', quantity: 1, unitPriceMinor: order.delivery_fee_minor, base: order.delivery_fee_minor, discount: 0 });
  }
  if (order.service_charge_minor > 0) {
    drafts.push({ code: 'service', name: 'Service charge', nameAr: 'رسوم الخدمة', kind: 'service_charge', quantity: 1, unitPriceMinor: order.service_charge_minor, base: order.service_charge_minor, discount: 0 });
  }
  const vat = allocate(order.tax_minor, drafts.map((d) => Math.max(d.base, 0)));
  return drafts.map((d, i) => {
    const v = vat[i]!;
    const net = order.tax_inclusive ? d.base - v : d.base;
    return { code: d.code, name: d.name, nameAr: d.nameAr, kind: d.kind, quantity: d.quantity, unitPriceMinor: d.unitPriceMinor, discountMinor: d.discount,
      netMinor: net, vatMinor: v, grossMinor: net + v, vatRateBp };
  });
}

/** Credit lines for refunding `amount` (gross) of an invoice. Full refunds copy the invoice lines. */
export function creditLines(invoice: { lines: FiscalLine[]; total_minor: number; tax_minor: number }, amount: number, fullyCredited: boolean): FiscalLine[] {
  if (fullyCredited && amount === invoice.total_minor) return invoice.lines.map((l) => ({ ...l }));
  const vat = Math.round((invoice.tax_minor * amount) / Math.max(invoice.total_minor, 1));
  const rate = invoice.lines[0]?.vatRateBp ?? 0;
  return [{ code: 'refund', name: 'Refund', nameAr: 'استرداد', kind: 'adjustment', quantity: 1, unitPriceMinor: amount, discountMinor: 0, netMinor: amount - vat, vatMinor: vat, grossMinor: amount, vatRateBp: rate }];
}
