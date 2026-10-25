import { describe, expect, it } from 'vitest';
import type { Category, Product } from '@resuto/contracts';
import {
  categoryCounts, changedPrice, filterItems, menuItems, moveId, NO_FILTERS, parsePercent, pricePreview, roundToStep, runBulk, searchText,
  type PriceChange,
} from './model';

const B1 = 'b1', B2 = 'b2';
const cat = (id: string, sortOrder: number, isActive = true): Category => ({ id, menuId: 'm', name: id, nameAr: null, description: null, defaultStation: null, sortOrder, isActive });
const dish = (id: string, over: Partial<Product> = {}): Product => ({
  id, categoryId: 'mains', name: id, nameAr: null, description: null, descriptionAr: null, priceMinor: 10000, costMinor: null, currency: 'EGP',
  station: 'Grill', prepMinutes: null, spiceLevel: 0, dietary: [], allergens: [], ingredients: [], calories: null, imageUrl: null, imageMediaId: null,
  isActive: true, trackStock: false, sortOrder: 0, externalRef: null, version: 3, branchSettings: [], modifierGroupIds: [], ...over,
});
const CATS = [cat('drinks', 1), cat('mains', 0), cat('old', 2, false)];

describe('menu items and filters', () => {
  const items = menuItems([
    dish('Tea', { categoryId: 'drinks', sortOrder: 1 }), dish('Koshari', { nameAr: 'كشري', sortOrder: 1 }), dish('Fattah', { sortOrder: 0 }),
    dish('Archived', { isActive: false }), dish('Gone', { categoryId: 'old' }), dish('Coffee', { categoryId: 'drinks', sortOrder: 0 }),
  ], CATS);

  it('lists active dishes of active categories in rail order, then dish order', () => {
    expect(items.map((p) => p.name)).toEqual(['Fattah', 'Koshari', 'Coffee', 'Tea']);
    expect([...categoryCounts(items)]).toEqual([['mains', 2], ['drinks', 2]]);
  });

  it('filters by category and by search in both languages (diacritics, hamza, Arabic-Indic digits ignored)', () => {
    expect(filterItems(items, { ...NO_FILTERS, category: 'drinks' }, B1).map((p) => p.name)).toEqual(['Coffee', 'Tea']);
    expect(filterItems(items, { ...NO_FILTERS, q: 'كشرى' }, B1).map((p) => p.name)).toEqual(['Koshari']);
    expect(filterItems(items, { ...NO_FILTERS, q: 'KOSH' }, B1).map((p) => p.name)).toEqual(['Koshari']);
    expect(searchText('Café ١٢ أحمد')).toBe('cafe 12 احمد');
    expect(filterItems(items, { ...NO_FILTERS, q: 'zzz' }, B1)).toEqual([]);
  });

  it('filters availability, sold out and counted portions at the shell branch only', () => {
    const list = [
      dish('Offered'),
      dish('NotHere', { branchSettings: [{ branchId: B1, isAvailable: false, priceOverrideMinor: null, stockQty: null }] }),
      dish('EightySixed', { branchSettings: [{ branchId: B1, isAvailable: true, priceOverrideMinor: null, stockQty: null, soldOut: true }] }),
      dish('NoStock', { trackStock: true, branchSettings: [{ branchId: B1, isAvailable: true, priceOverrideMinor: null, stockQty: 0 }] }),
      dish('SoldOutElsewhere', { branchSettings: [{ branchId: B2, isAvailable: true, priceOverrideMinor: null, stockQty: null, soldOut: true }] }),
    ];
    const names = (f: Partial<typeof NO_FILTERS>, b = B1) => filterItems(list, { ...NO_FILTERS, ...f }, b).map((p) => p.name);
    expect(names({ availability: 'offered' })).toEqual(['Offered', 'EightySixed', 'NoStock', 'SoldOutElsewhere']);
    expect(names({ availability: 'not_offered' })).toEqual(['NotHere']);
    expect(names({ soldOut: true })).toEqual(['EightySixed', 'NoStock']);
    expect(names({ soldOut: true }, B2)).toEqual(['SoldOutElsewhere']);
    expect(names({ tracked: true })).toEqual(['NoStock']);
    expect(names({ soldOut: true, tracked: true })).toEqual(['NoStock']);
  });
});

describe('category reorder', () => {
  it('moves one id to a new place and clamps; the same array when nothing moves', () => {
    const ids = ['a', 'b', 'c', 'd'];
    expect(moveId(ids, 0, 2)).toEqual(['b', 'c', 'a', 'd']);
    expect(moveId(ids, 3, 0)).toEqual(['d', 'a', 'b', 'c']);
    expect(moveId(ids, 1, 99)).toEqual(['a', 'c', 'd', 'b']);
    expect(moveId(ids, 0, -1)).toBe(ids);
    expect(moveId(ids, 2, 2)).toBe(ids);
  });
});

describe('bulk price change (integer minor units)', () => {
  const pct = (value: number, direction: 'up' | 'down' = 'up', round: PriceChange['round'] = 0): PriceChange => ({ mode: 'percent', direction, value, round });

  it('parses percentages to basis points, accepting Arabic digits and separators', () => {
    expect(parsePercent('10')).toBe(1000);
    expect(parsePercent('12.5')).toBe(1250);
    expect(parsePercent('٧٫٥')).toBe(750);
    expect(parsePercent('15 %')).toBe(1500);
    expect(parsePercent('0.01')).toBe(1);
    expect(parsePercent('')).toBeNull();
    for (const bad of ['0', '-5', '1.234', 'abc', '1001', '10.5.1']) expect(parsePercent(bad)).toBe('invalid');
  });

  it('applies a percentage with half-away-from-zero rounding to the minor unit', () => {
    expect(changedPrice(10000, pct(1000))).toBe(11000);
    // 9.99 × 1.125 = 11.23875 → 11.24; 9.99 × 0.875 = 8.74125 → 8.74
    expect(changedPrice(999, pct(1250))).toBe(1124);
    expect(changedPrice(999, pct(1250, 'down'))).toBe(874);
    // Halves round away from zero: 0.05 × 1.10 = 0.055 → 0.06, and 0.05 × 0.90 = 0.045 → 0.05 (unchanged).
    expect(changedPrice(5, pct(1000))).toBe(6);
    expect(changedPrice(5, pct(1000, 'down'))).toBe(5);
    expect(changedPrice(15, pct(5000, 'down'))).toBe(8); // 0.075 → 0.08
    expect(changedPrice(100, pct(100_000, 'down'))).toBe(-900); // −1000 %: refused by the preview
    expect(Number.isInteger(changedPrice(12345, pct(333)))).toBe(true);
  });

  it('applies an amount, and rounds to a step when asked', () => {
    expect(changedPrice(4500, { mode: 'amount', direction: 'up', value: 250, round: 0 })).toBe(4750);
    expect(changedPrice(4500, { mode: 'amount', direction: 'down', value: 250, round: 0 })).toBe(4250);
    expect(changedPrice(999, pct(1250, 'up', 100))).toBe(1100); // 11.24 → 11.00
    expect(changedPrice(999, pct(1250, 'up', 50))).toBe(1100); // 11.24 → 11.00 (11.25 would round up to 11.50)
    expect(changedPrice(1125, { mode: 'amount', direction: 'up', value: 0, round: 50 })).toBe(1150);
    expect(roundToStep(1124, 25)).toBe(1125);
    expect(roundToStep(1112, 25)).toBe(1100);
    expect(roundToStep(1113, 25)).toBe(1125);
    expect(roundToStep(1234, 0)).toBe(1234);
  });

  it('previews each dish: changed, unchanged, refused, branch prices kept, discounts ended', () => {
    const list = [
      dish('Burger', { priceMinor: 18500 }),
      dish('Water', { priceMinor: 0 }),
      dish('Cheap', { priceMinor: 100 }),
      dish('Local', { priceMinor: 5000, branchSettings: [{ branchId: B1, isAvailable: true, priceOverrideMinor: 5500, stockQty: null }] }),
      dish('Promo', { priceMinor: 3825, compareAtMinor: 4500 }),
    ];
    const down = pricePreview(list, { mode: 'amount', direction: 'down', value: 500, round: 0 }, B1);
    expect(down.rows.map((r) => [r.name, r.outcome, r.toMinor])).toEqual([
      ['Burger', 'change', 18000], ['Water', 'below_zero', -500], ['Cheap', 'below_zero', -400], ['Local', 'change', 4500], ['Promo', 'change', 3325],
    ]);
    expect(down).toMatchObject({ changed: 3, unchanged: 0, refused: 2, endsDiscount: 1, overridden: 1 });
    expect(down.rows.find((r) => r.name === 'Local')!.branchOverrideMinor).toBe(5500);
    expect(down.rows[0]!.version).toBe(3);
    const up = pricePreview(list, pct(1000), B1);
    expect(up.rows.find((r) => r.name === 'Water')!.outcome).toBe('same');
    expect(pricePreview([dish('Max', { priceMinor: 99_000_000 })], pct(2000), B1).rows[0]!.outcome).toBe('too_high');
  });
});

describe('runBulk', () => {
  it('runs every item, counts failures and keeps the first error, a few at a time', async () => {
    let live = 0, peak = 0;
    const r = await runBulk([1, 2, 3, 4, 5, 6, 7], async (n) => {
      live++; peak = Math.max(peak, live);
      await new Promise((res) => setTimeout(res, 1));
      live--;
      if (n % 3 === 0) throw new Error(`no ${n}`);
    }, 3);
    expect(r).toEqual({ ok: 5, failed: 2, firstError: 'no 3' });
    expect(peak).toBeLessThanOrEqual(3);
  });
});
