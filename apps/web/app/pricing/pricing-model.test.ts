import { hasEasternDigits, type PublicPlansResponse } from '@resuto/contracts';
import { describe, expect, it } from 'vitest';
import { PUBLIC_PLANS_EG } from '../../components/landing/plans.fixture';
import { addOns, comparison, faq, fromPrice, pricingCards, yearlyIsTenMonths } from './pricing-model';

const allText = (x: unknown) => JSON.stringify(x);

describe('/pricing model (VP-09, VP-22)', () => {
  it('builds the four legacy cards from the live plans: Starter, Growth (featured), Pro, then Business', () => {
    const cards = pricingCards(PUBLIC_PLANS_EG, 'en');
    expect(cards.map((c) => c.id)).toEqual(['starter', 'growth', 'pro', 'business']);
    expect(cards.map((c) => c.monthly)).toEqual([799, 1499, 2999, null]);
    expect(cards.map((c) => c.yearly)).toEqual([7990, 14990, 29990, null]);
    expect(cards.find((c) => c.featured)?.id).toBe('growth');
  });

  it('states limits from data, not legacy copy (Pro: up to 10 branches, 100 staff)', () => {
    const pro = pricingCards(PUBLIC_PLANS_EG, 'en').find((c) => c.id === 'pro')!;
    expect(pro.bullets).toContain('Up to 10 branches');
    expect(pro.bullets).toContain('100 staff accounts');
    expect(pro.bullets[0]).toBe('Everything in Growth');
    const starter = pricingCards(PUBLIC_PLANS_EG, 'en')[0]!;
    expect(starter.bullets).toEqual(expect.arrayContaining(['1 branch', '5 staff accounts', 'Payment links and split bills']));
  });

  it('uses the Arabic plan description on the Arabic page, with Western digits throughout', () => {
    const cards = pricingCards(PUBLIC_PLANS_EG, 'ar');
    expect(cards[0]!.blurb).toBe(PUBLIC_PLANS_EG.plans.find((p) => p.id === 'starter')!.descriptionAr);
    expect(cards[2]!.bullets).toContain('حتى 10 فروع');
    expect(cards[1]!.bullets).toContain('حتى فرعين');
    for (const x of [cards, comparison(PUBLIC_PLANS_EG, true, 'ar'), faq(PUBLIC_PLANS_EG, 'ar'), addOns(PUBLIC_PLANS_EG, false, 'ar')]) {
      expect(hasEasternDigits(allText(x))).toBe(false);
    }
  });

  it('derives every module cell from plan modules and module prices; Business is by agreement', () => {
    const groups = comparison(PUBLIC_PLANS_EG, false, 'en');
    const rows = groups.flatMap((g) => g.rows);
    const connect = rows.find((r) => r.label === 'Resuto Connect')!;
    expect(connect.cells.starter).toEqual({ kind: 'text', text: 'Add-on · 400 EGP / month' });
    expect(connect.cells.growth).toEqual({ kind: 'yes' });
    expect(connect.cells.business).toEqual({ kind: 'quote' });
    const core = rows.find((r) => r.label === 'Resuto Core')!;
    expect(['starter', 'growth', 'pro'].every((id) => core.cells[id]!.kind === 'yes')).toBe(true);
    const branches = rows.find((r) => r.label === 'Branches')!;
    expect(branches.cells).toMatchObject({ starter: { text: '1' }, growth: { text: 'Up to 2' }, pro: { text: 'Up to 10' } });
    const yearly = comparison(PUBLIC_PLANS_EG, true, 'en').flatMap((g) => g.rows).find((r) => r.label === 'Yearly billing')!;
    expect(yearly.cells.starter).toEqual({ kind: 'text', text: '7,990 EGP / year (10 months)' });
  });

  it('keeps the Foodics column facts for Egypt only', () => {
    const monthly = comparison(PUBLIC_PLANS_EG, false, 'en').flatMap((g) => g.rows).find((r) => r.label === 'Monthly price')!;
    expect(monthly.rival).toEqual({ kind: 'text', text: 'EGP 3,019.89 / month, billed quarterly' });
    const sa: PublicPlansResponse = { ...PUBLIC_PLANS_EG, country: 'SA', currency: 'SAR' };
    const saMonthly = comparison(sa, false, 'en').flatMap((g) => g.rows).find((r) => r.label === 'Monthly price')!;
    expect(saMonthly.rival).toEqual({ kind: 'unknown' });
  });

  it('only promises "ten months" while yearly = 10 x monthly', () => {
    expect(yearlyIsTenMonths(PUBLIC_PLANS_EG)).toBe(true);
    const changed: PublicPlansResponse = { ...PUBLIC_PLANS_EG, plans: PUBLIC_PLANS_EG.plans.map((p) => (p.id === 'pro' ? { ...p, prices: { ...p.prices, year: { ...p.prices.year!, amountMinor: 3200000 } } } : p)) };
    expect(yearlyIsTenMonths(changed)).toBe(false);
    expect(faq(changed, 'en')[0]![1]).not.toMatch(/ten months/);
    expect(faq(PUBLIC_PLANS_EG, 'en')[0]![1]).toMatch(/^Starter is 799 EGP, Growth is 1,499 EGP and Pro is 2,999 EGP a month\. Paying yearly costs ten months/);
  });

  it('lists module add-ons with their published prices and the page title price', () => {
    const names = addOns(PUBLIC_PLANS_EG, false, 'en').map((a) => `${a.name}: ${a.price}`);
    expect(names).toEqual(expect.arrayContaining(['Resuto Connect: 400 EGP / month']));
    expect(names.at(-1)).toBe('Premium onboarding and custom integrations: Quoted separately');
    expect(fromPrice(PUBLIC_PLANS_EG)).toBe(799);
  });
});
