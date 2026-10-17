import { describe, expect, it } from 'vitest';
import { apportion, planSplit, SplitRuleError, type BillUnit } from './payments';

describe('split arithmetic (legacy rules)', () => {
  it('apportions by largest remainder and always sums to the total', () => {
    expect(apportion(10000, [1, 1, 1])).toEqual([3334, 3333, 3333]);
    expect(apportion(100, [1, 2])).toEqual([33, 67]);
    // 1000 by 3:3:1 → 428.57, 428.57, 142.86 → remainders .57 .57 .86 → third gets the extra unit first
    expect(apportion(1000, [3, 3, 1])).toEqual([429, 428, 143]);
    for (const [total, weights] of [[99999, [7, 3, 11]], [1, [5, 5]], [12345, [1, 2, 3, 4, 5]]] as const) {
      const a = apportion(total, weights);
      expect(a.reduce((s, x) => s + x, 0)).toBe(total);
    }
    expect(() => apportion(100, [0, 0])).toThrow();
  });

  it('equal: 2–20 people, never more people than minor units', () => {
    expect(planSplit(10000, { mode: 'equal', people: 3 }).amounts).toEqual([3334, 3333, 3333]);
    expect(() => planSplit(10000, { mode: 'equal', people: 1 })).toThrow(SplitRuleError);
    expect(() => planSplit(10000, { mode: 'equal', people: 21 })).toThrow(SplitRuleError);
    expect(() => planSplit(2, { mode: 'equal', people: 3 })).toThrow(SplitRuleError);
  });

  it('custom: must add up exactly to the balance', () => {
    expect(planSplit(10000, { mode: 'custom', amounts: [2500, 7500] }).amounts).toEqual([2500, 7500]);
    expect(() => planSplit(10000, { mode: 'custom', amounts: [2500, 7499] })).toThrow(/add up/);
    expect(() => planSplit(10000, { mode: 'custom', amounts: [10000] })).toThrow();
    expect(() => planSplit(10000, { mode: 'custom', amounts: [0, 10000] })).toThrow();
  });

  it('items: each unit exactly once, amounts apportioned of the balance', () => {
    const units: BillUnit[] = [
      { lineId: 'a', unit: 0, amountMinor: 4500 }, { lineId: 'a', unit: 1, amountMinor: 4500 }, { lineId: 'b', unit: 0, amountMinor: 2500 },
    ];
    const plan = planSplit(11500, { mode: 'items', allocations: [{ items: [{ lineId: 'a', unit: 0 }, { lineId: 'b', unit: 0 }] }, { items: [{ lineId: 'a', unit: 1 }] }] }, units);
    expect(plan.amounts).toEqual([7000, 4500]);
    // After a partial payment the remaining balance is apportioned by item weight.
    expect(planSplit(5750, { mode: 'items', allocations: [{ items: [{ lineId: 'a', unit: 0 }, { lineId: 'b', unit: 0 }] }, { items: [{ lineId: 'a', unit: 1 }] }] }, units).amounts).toEqual([3500, 2250]);
    expect(() => planSplit(11500, { mode: 'items', allocations: [{ items: [{ lineId: 'a', unit: 0 }] }, { items: [{ lineId: 'a', unit: 0 }] }] }, units)).toThrow(/exactly once/);
    expect(() => planSplit(11500, { mode: 'items', allocations: [{ items: [{ lineId: 'a', unit: 0 }] }, { items: [{ lineId: 'a', unit: 1 }] }] }, units)).toThrow(/exactly once/);
    expect(() => planSplit(11500, { mode: 'items', allocations: [{ items: [{ lineId: 'zz', unit: 0 }] }, { items: [{ lineId: 'a', unit: 1 }] }] }, units)).toThrow();
  });

  it('refuses to split a settled bill', () => {
    expect(() => planSplit(0, { mode: 'whole' })).toThrow(/settled/);
    expect(planSplit(4200, { mode: 'whole' }).amounts).toEqual([4200]);
  });
});
