import { z } from 'zod';
import { countryCode } from './common';
import { moduleKey } from './modules';

export const billingInterval = z.enum(['month', 'year']);

export const priceQuoteRequest = z.object({
  planId: z.string().regex(/^[a-z0-9_-]{2,40}$/),
  country: countryCode,
  interval: billingInterval,
  addons: z.array(moduleKey).max(10).default([]),
});
export type PriceQuoteRequest = z.infer<typeof priceQuoteRequest>;

export const changePlan = z.object({
  planId: z.string().regex(/^[a-z0-9_-]{2,40}$/),
  interval: billingInterval.optional(),
  addons: z.array(moduleKey).max(10).optional(),
});

export interface PriceQuote {
  planId: string;
  country: 'EG' | 'SA';
  currency: 'EGP' | 'SAR';
  interval: 'month' | 'year';
  lines: Array<{ kind: 'plan' | 'module'; key: string; amountMinor: number }>;
  subtotalMinor: number;
  /** Platform subscription fees only. Provider fees (payments, WhatsApp, ads) are billed by those providers. */
  externalCostsNote: string;
}

export interface EntitlementsView {
  planId: string | null;
  status: string | null;
  modules: Record<string, { enabled: boolean; source: 'plan' | 'addon' | 'override' | 'none' }>;
  limits: Record<string, number>;
  usage: Record<string, number>;
}
