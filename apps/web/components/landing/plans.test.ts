import { describe, expect, it } from 'vitest';
import { BUSINESS_CARD, cardAmount, landingPlansFrom } from './plans';
import { PUBLIC_PLANS_EG } from './plans.fixture';

describe('landing pricing teaser (VP-03)', () => {
  it('reads monthly and yearly prices from the real /public/plans shape (prices.{month,year})', () => {
    const plans = landingPlansFrom(PUBLIC_PLANS_EG);
    expect(plans).not.toBeNull();
    expect(plans!.map((p) => p.id)).toEqual(['starter', 'growth', 'pro']);
    expect(plans!.map((p) => p.monthlyMinor)).toEqual([79900, 149900, 299900]);
    expect(plans!.map((p) => p.yearlyMinor)).toEqual([799000, 1499000, 2999000]);
    expect(plans!.every((p) => p.currency === 'EGP')).toBe(true);
    // Branch limits come from plan data, so the card states the real limit (Pro: 10, not the legacy copy's "three").
    expect(plans!.map((p) => p.branches)).toEqual([1, 2, 10]);
  });

  it('shows whole amounts per billing period from the published prices (never a hard-coded multiplier)', () => {
    const [starter] = landingPlansFrom(PUBLIC_PLANS_EG)!;
    expect(cardAmount(starter!, false)).toBe(799);
    expect(cardAmount(starter!, true)).toBe(7990);
    const odd = { ...starter!, yearlyMinor: 700000 };
    expect(cardAmount(odd, true)).toBe(7000);
    expect(cardAmount(BUSINESS_CARD, false)).toBeNull();
  });

  it('leaves out Free QR (zero price) and Build Your Resuto (custom), like the legacy four-card teaser', () => {
    const ids = landingPlansFrom(PUBLIC_PLANS_EG)!.map((p) => p.id);
    expect(ids).not.toContain('free');
    expect(ids).not.toContain('custom');
  });

  it('returns null instead of throwing for unusable bodies, so the page falls back to "See plans and prices"', () => {
    expect(landingPlansFrom(null)).toBeNull();
    expect(landingPlansFrom({})).toBeNull();
    expect(landingPlansFrom([{ id: 'starter', prices: [] }])).toBeNull();
    expect(landingPlansFrom({ ...PUBLIC_PLANS_EG, plans: PUBLIC_PLANS_EG.plans.map((p) => ({ ...p, prices: { month: null, year: null } })) })).toBeNull();
  });

  it('keeps a plan whose yearly price is not published, with a null yearly amount', () => {
    const body = { ...PUBLIC_PLANS_EG, plans: PUBLIC_PLANS_EG.plans.map((p) => (p.id === 'growth' ? { ...p, prices: { ...p.prices, year: null } } : p)) };
    const growth = landingPlansFrom(body)!.find((p) => p.id === 'growth')!;
    expect(growth.monthlyMinor).toBe(149900);
    expect(cardAmount(growth, true)).toBeNull();
  });
});
