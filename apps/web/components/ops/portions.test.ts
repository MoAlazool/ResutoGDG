import { describe, expect, it } from 'vitest';
import { LOW_STOCK, portionsOf } from './portions';

const B = 'branch-1';
const dish = (over: object = {}) => ({ trackStock: false, branchSettings: [], recipePortions: null, ...over });

describe('menu portions (PAR-03)', () => {
  it('uses the dish’s own stock count when the restaurant counts it', () => {
    expect(portionsOf(dish({ trackStock: true, branchSettings: [{ branchId: B, isAvailable: true, priceOverrideMinor: null, stockQty: 18 }] }), B)).toEqual({ count: 18, source: 'dish' });
  });

  it('otherwise counts what the ingredients on hand can make at this branch', () => {
    const p = dish({ recipePortions: [{ branchId: B, portions: 24 }, { branchId: 'other', portions: 3 }] });
    expect(portionsOf(p, B)).toEqual({ count: 24, source: 'recipe' });
    expect(portionsOf(p, 'other')).toEqual({ count: 3, source: 'recipe' });
  });

  it('is null (shown as "—") only when neither the dish nor a recipe is tracked', () => {
    expect(portionsOf(dish(), B)).toBeNull();
    expect(portionsOf(dish({ recipePortions: [{ branchId: 'other', portions: 4 }] }), B)).toBeNull();
    // A dish that tracks stock but has no count at this branch falls back to its recipe.
    expect(portionsOf(dish({ trackStock: true, recipePortions: [{ branchId: B, portions: 2 }] }), B)).toEqual({ count: 2, source: 'recipe' });
  });

  it('flags low stock under six portions, as legacy did', () => {
    expect(LOW_STOCK).toBe(6);
  });
});
