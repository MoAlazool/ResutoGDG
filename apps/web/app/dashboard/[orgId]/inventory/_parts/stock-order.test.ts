import { describe, expect, it } from 'vitest';
import { lowCount, lowStockFirst, matchesStock, stockRank, type StockRow } from './stock-order';

const row = (name: string, quantity: number, reorderLevel: number | null, nameAr: string | null = null): StockRow =>
  ({ itemId: name, branchId: 'b', name, nameAr, quantity, reorderLevel, low: reorderLevel !== null && quantity <= reorderLevel });

describe('stock list: low stock first', () => {
  const rows = [row('Tomatoes', 40, 10), row('Oil', 2, 10), row('Buns', -4, 20), row('Cheese', 5, 10), row('Salt', 3, null), row('Beef', 0, 15, 'لحم')];
  it('below zero, then low (emptiest first), then the rest by name', () => {
    expect(lowStockFirst(rows).map((r) => r.name)).toEqual(['Buns', 'Beef', 'Oil', 'Cheese', 'Salt', 'Tomatoes']);
    expect(rows.map(stockRank)).toEqual([2, 1, 0, 1, 2, 1]);
    expect(lowCount(rows)).toBe(4);
  });
  it('sorts the healthy rows by the Arabic name in Arabic', () => {
    const ar = [row('Zaatar', 10, 1, 'زعتر'), row('Anise', 10, 1, 'يانسون'), row('Bay', 10, 1, 'غار')];
    expect(lowStockFirst(ar, 'ar').map((r) => r.nameAr)).toEqual(['زعتر', 'غار', 'يانسون']);
  });
  it('search matches either name, ignoring case and hamza forms', () => {
    expect(matchesStock(row('Olive oil', 1, 1, 'زيت زيتون'), 'OLIVE')).toBe(true);
    expect(matchesStock(row('Flour', 1, 1, 'دقيق أبيض'), 'ابيض')).toBe(true);
    expect(matchesStock(row('Flour', 1, 1), 'rice')).toBe(false);
    expect(matchesStock(row('Flour', 1, 1), '  ')).toBe(true);
  });
});
