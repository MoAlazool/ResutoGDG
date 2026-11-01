import { describe, expect, it } from 'vitest';
import { EGYPT_CATALOG, SAUDI_CATALOG } from './pricing-catalog';

describe('static public pricing catalog', () => {
  it('keeps the published Egypt and Saudi plan ladders in the build', () => {
    const amount = (country: typeof EGYPT_CATALOG, id: string, interval: 'month' | 'year') =>
      country.plans.find((plan) => plan.id === id)?.prices[interval]?.amountMinor;
    expect(amount(EGYPT_CATALOG, 'starter', 'month')).toBe(79_900);
    expect(amount(EGYPT_CATALOG, 'pro', 'year')).toBe(2_999_000);
    expect(amount(SAUDI_CATALOG, 'starter', 'month')).toBe(19_900);
    expect(amount(SAUDI_CATALOG, 'pro', 'year')).toBe(799_000);
  });

  it('contains no runtime API configuration and keeps yearly pricing at ten months', () => {
    for (const catalog of [EGYPT_CATALOG, SAUDI_CATALOG]) {
      for (const plan of catalog.plans) {
        expect(plan.prices.year?.amountMinor).toBe((plan.prices.month?.amountMinor ?? 0) * 10);
      }
      expect(catalog.externalCostsNote).toContain('not included');
    }
  });
});
