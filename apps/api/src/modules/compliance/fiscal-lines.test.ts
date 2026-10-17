import { applyBasisPoints, taxFromInclusive } from '@resuto/contracts';
import { describe, expect, it } from 'vitest';
import { allocate, creditLines, fiscalLinesForOrder } from './fiscal-lines';

// Deterministic pseudo-random generator so failures are reproducible.
function rng(seed: number) {
  return () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
}

describe('fiscal line allocation', () => {
  it('allocates exactly with largest remainder', () => {
    expect(allocate(100, [1, 1, 1])).toEqual([34, 33, 33]);
    expect(allocate(0, [5, 5])).toEqual([0, 0]);
    expect(allocate(7, [0, 0])).toEqual([7, 0]);
    expect(allocate(10, [])).toEqual([]);
  });

  it('reconciles to the order for random inclusive and exclusive orders', () => {
    const r = rng(42);
    for (let n = 0; n < 500; n++) {
      const inclusive = r() > 0.5;
      const rate = r() > 0.5 ? 1500 : 1400;
      const lines = Array.from({ length: 1 + Math.floor(r() * 5) }, (_, i) => {
        const q = 1 + Math.floor(r() * 4), unit = 100 + Math.floor(r() * 20_000);
        return { product_id: `p${i}`, name: `Item ${i}`, name_ar: null, quantity: q, unit_price_minor: unit, modifiers_total_minor: 0, line_total_minor: unit * q };
      });
      const subtotal = lines.reduce((s, l) => s + l.line_total_minor, 0);
      const discount = Math.floor(r() * subtotal * 0.3);
      const fee = r() > 0.5 ? 1500 : 0;
      const service = r() > 0.7 ? applyBasisPoints(subtotal - discount, 1000) : 0;
      const taxable = subtotal - discount + fee + service;
      const tax = inclusive ? taxFromInclusive(taxable, rate) : applyBasisPoints(taxable, rate);
      const total = taxable + (inclusive ? 0 : tax);
      const order = { subtotal_minor: subtotal, discount_minor: discount, delivery_fee_minor: fee, service_charge_minor: service, tax_minor: tax, tax_inclusive: inclusive, total_minor: total };
      const out = fiscalLinesForOrder(order, lines, rate);
      expect(out.reduce((s, l) => s + l.grossMinor, 0)).toBe(total);
      expect(out.reduce((s, l) => s + l.vatMinor, 0)).toBe(tax);
      expect(out.reduce((s, l) => s + l.netMinor, 0)).toBe(total - tax);
      expect(out.reduce((s, l) => s + l.discountMinor, 0)).toBe(discount);
      for (const l of out) {
        expect(Number.isSafeInteger(l.netMinor) && Number.isSafeInteger(l.vatMinor)).toBe(true);
        expect(l.netMinor + l.vatMinor).toBe(l.grossMinor);
      }
    }
  });

  it('builds partial and full credit lines', () => {
    const invoice = { total_minor: 11500, tax_minor: 1500, lines: [{ code: 'p', name: 'X', nameAr: null, kind: 'item' as const, quantity: 1, unitPriceMinor: 11500, discountMinor: 0, netMinor: 10000, vatMinor: 1500, grossMinor: 11500, vatRateBp: 1500 }] };
    expect(creditLines(invoice, 11500, true)).toEqual(invoice.lines);
    const partial = creditLines(invoice, 2300, true);
    expect(partial).toEqual([expect.objectContaining({ grossMinor: 2300, vatMinor: 300, netMinor: 2000 })]);
  });
});
