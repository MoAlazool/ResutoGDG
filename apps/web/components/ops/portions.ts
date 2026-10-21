import type { Product } from '@resuto/contracts';

/** Legacy "Portions" badge: low stock under 6 portions. */
export const LOW_STOCK = 6;

export type Portions = { count: number; source: 'dish' | 'recipe' } | null;

/**
 * Portions left of a dish at a branch, as the legacy menu table showed them (PAR-03): the dish's own stock count when
 * the restaurant counts it, otherwise what the ingredients on hand can make (its recipe). Null when neither is
 * tracked; the table then shows "—" and says why.
 */
export function portionsOf(p: Pick<Product, 'trackStock' | 'branchSettings' | 'recipePortions'>, branchId: string): Portions {
  const own = p.branchSettings.find((b) => b.branchId === branchId)?.stockQty;
  if (p.trackStock && typeof own === 'number') return { count: own, source: 'dish' };
  const fromRecipe = p.recipePortions?.find((r) => r.branchId === branchId)?.portions;
  return typeof fromRecipe === 'number' ? { count: Math.max(0, fromRecipe), source: 'recipe' } : null;
}
