// Landing pricing teaser data: the priced plans from GET /v1/public/plans (PublicPlansResponse), reduced to what
// the four legacy cards show (legacy/public/landing-pricing.js). Kept free of React so it can be unit tested with the
// real payload shape (plans.test.ts) and cannot drift from the contract again (audit VP-03).
import type { PublicPlan, PublicPlansResponse } from '@resuto/contracts';

export interface LandingPlan {
  id: string;
  name: string;
  nameAr: string | null;
  /** Minor units for one month / one year; null when no price is published (shown as "Let's talk"). */
  monthlyMinor: number | null;
  yearlyMinor: number | null;
  currency: string;
  description?: string | null;
  /** Branch limit from the plan's published limits (the teaser states it from data, not copy). */
  branches?: number | null;
}

/** Teaser cards: the first three priced, fixed plans (Starter, Growth, Pro); Free QR and Build Your Resuto live on /pricing. */
const TEASER_PRICED = 3;

const amount = (tag: { amountMinor?: unknown } | null | undefined): number | null =>
  typeof tag?.amountMinor === 'number' && Number.isFinite(tag.amountMinor) ? tag.amountMinor : null;

/**
 * Parses the public plans payload. Returns null (the teaser then links to /pricing instead of showing numbers) when the
 * body is not a plans response or contains no priced plan.
 */
export function landingPlansFrom(body: unknown): LandingPlan[] | null {
  if (!body || typeof body !== 'object' || !Array.isArray((body as PublicPlansResponse).plans)) return null;
  const res = body as PublicPlansResponse;
  const plans = res.plans
    .filter((p): p is PublicPlan => !!p && typeof p.id === 'string' && !p.isCustom)
    .map((p): LandingPlan => ({
      id: p.id,
      name: p.name,
      nameAr: p.nameAr ?? null,
      monthlyMinor: amount(p.prices?.month),
      yearlyMinor: amount(p.prices?.year),
      currency: p.prices?.month?.currency ?? res.currency ?? 'EGP',
      description: p.description ?? null,
      branches: typeof p.limits?.branches === 'number' ? p.limits.branches : null,
    }))
    // Free QR has a zero price; the teaser shows the paid ladder like the legacy page.
    .filter((p) => p.monthlyMinor !== null && p.monthlyMinor > 0)
    .slice(0, TEASER_PRICED);
  return plans.length ? plans : null;
}

/** The fourth card: Business is scoped and quoted by the sales team (legacy "Let’s talk"), not a published price. */
export const BUSINESS_CARD: LandingPlan = { id: 'business', name: 'Business', nameAr: null, monthlyMinor: null, yearlyMinor: null, currency: 'EGP' };

/** Whole currency units for a card, for the chosen billing period. Yearly uses the published yearly price, never ×10 or ×12. */
export function cardAmount(p: LandingPlan, yearly: boolean): number | null {
  const minor = yearly ? p.yearlyMinor : p.monthlyMinor;
  return minor === null ? null : Math.round(minor / 100);
}
