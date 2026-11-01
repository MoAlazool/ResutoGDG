import type { PublicPlansResponse } from '@resuto/contracts';
import { PUBLIC_PLANS_EG } from '../../web/components/landing/plans.fixture';

export const EGYPT_CATALOG: PublicPlansResponse = PUBLIC_PLANS_EG;

const saPlanPrices: Record<string, [number, number]> = {
  free: [0, 0], starter: [19900, 199000], growth: [39900, 399000], pro: [79900, 799000], custom: [9900, 99000],
};
const price = (tag: NonNullable<PublicPlansResponse['plans'][number]['prices']['month']>, amountMinor: number) => ({ ...tag, amountMinor, currency: 'SAR' as const });

/** Versioned from supabase/migrations/20261017000700_reference_data_storage.sql. */
export const SAUDI_CATALOG: PublicPlansResponse = {
  ...PUBLIC_PLANS_EG,
  country: 'SA', currency: 'SAR',
  plans: PUBLIC_PLANS_EG.plans.map((plan) => {
    const [month, year] = saPlanPrices[plan.id] ?? [0, 0];
    return { ...plan, price: price(plan.prices.month!, month), prices: { month: price(plan.prices.month!, month), year: price(plan.prices.year!, year) } };
  }),
  modules: PUBLIC_PLANS_EG.modules.map((module) => {
    const month = Math.round((module.prices.month?.amountMinor ?? 0) / 4);
    const year = Math.round((module.prices.year?.amountMinor ?? 0) / 4);
    return { ...module, price: price(module.prices.month!, month), prices: { month: price(module.prices.month!, month), year: price(module.prices.year!, year) } };
  }),
};
