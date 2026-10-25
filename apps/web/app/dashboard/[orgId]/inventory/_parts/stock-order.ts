// Stock list order and filters (21-OPS: "low stock first"), pure so they are unit tested. Below zero comes first
// (a counting or recipe problem), then items at or under their reorder level, emptiest first, then the rest by name.
import { matchText } from '@resuto/ui';

export interface StockRow { itemId: string; branchId: string; name: string; nameAr: string | null; quantity: number; reorderLevel: number | null; low: boolean }

/** 0 = below zero, 1 = low, 2 = fine. */
export const stockRank = (l: Pick<StockRow, 'quantity' | 'low'>) => (l.quantity < 0 ? 0 : l.low ? 1 : 2);

/** How full a low item is against its reorder level (0 = empty, 1 = at the level). */
const fill = (l: Pick<StockRow, 'quantity' | 'reorderLevel'>) => (l.reorderLevel && l.reorderLevel > 0 ? l.quantity / l.reorderLevel : l.quantity);

export function lowStockFirst<T extends StockRow>(rows: readonly T[], locale: 'en' | 'ar' = 'en'): T[] {
  const name = (r: T) => (locale === 'ar' && r.nameAr ? r.nameAr : r.name);
  return [...rows].sort((a, b) => stockRank(a) - stockRank(b)
    || (stockRank(a) < 2 ? fill(a) - fill(b) : 0)
    || name(a).localeCompare(name(b), locale === 'ar' ? 'ar' : 'en'));
}

/** Search in both names, ignoring case, diacritics, hamza forms and Arabic-Indic digits. */
export function matchesStock(r: Pick<StockRow, 'name' | 'nameAr'>, q: string): boolean {
  const needle = matchText(q.trim());
  if (!needle) return true;
  return matchText(r.name).includes(needle) || (!!r.nameAr && matchText(r.nameAr).includes(needle));
}

/** Count of rows needing attention (below zero or low), for the "Low stock" filter chip. */
export const lowCount = (rows: readonly Pick<StockRow, 'quantity' | 'low'>[]) => rows.filter((r) => stockRank(r) < 2).length;
