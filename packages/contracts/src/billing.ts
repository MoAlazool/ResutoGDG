// Plans, pricing quotes, subscriptions, usage and entitlements.
// Owner: Agent A (docs/architecture/MODULE_CONTRACTS.md).
import { z } from 'zod';
import { countryCode } from './common';
import { moduleKey, type ModuleKey } from './modules';

export const billingInterval = z.enum(['month', 'year']);
export type BillingInterval = z.infer<typeof billingInterval>;

const planId = z.string().regex(/^[a-z0-9_-]{2,40}$/);

/** `GET /v1/public/plans` query. */
export const publicPlansQuery = z.object({
  country: countryCode.default('EG'),
  interval: billingInterval.default('month'),
});

export const priceQuoteRequest = z.object({
  planId,
  country: countryCode,
  interval: billingInterval,
  addons: z.array(moduleKey).max(10).default([]),
});
export type PriceQuoteRequest = z.infer<typeof priceQuoteRequest>;

export const changePlan = z.object({
  planId,
  interval: billingInterval.optional(),
  addons: z.array(moduleKey).max(10).optional(),
});
export type ChangePlan = z.infer<typeof changePlan>;

export const cancelSubscription = z.object({
  reason: z.string().trim().max(500).optional(),
});

/** Plan limit keys used by plans.limits and the usage view. */
export const PLAN_LIMIT_KEYS = ['branches', 'staff', 'orders_per_month', 'ai_requests_per_month', 'mcp_calls_per_month'] as const;
export type PlanLimitKey = (typeof PLAN_LIMIT_KEYS)[number];

/** Usage metric → the plan limit that caps it (if any). */
export const USAGE_LIMIT_FOR: Record<string, PlanLimitKey | undefined> = {
  branches: 'branches',
  staff: 'staff',
  orders: 'orders_per_month',
  ai_requests: 'ai_requests_per_month',
  mcp_calls: 'mcp_calls_per_month',
};

export const EXTERNAL_COSTS_NOTE =
  'Resuto subscription fees only. Payment-provider fees, WhatsApp conversation fees and advertising spend are charged by those providers directly to your accounts and are not included.';
export const EXTERNAL_COSTS_NOTE_AR =
  'رسوم اشتراك ريسوتو فقط. رسوم مزودي الدفع ورسوم محادثات واتساب وتكاليف الإعلانات يحصّلها هؤلاء المزودون مباشرة من حساباتك ولا تشملها هذه الأسعار.';

export interface PriceTag {
  amountMinor: number;
  currency: 'EGP' | 'SAR';
  interval: 'month' | 'year';
  validFrom: string;
}

export interface PublicPlan {
  id: string;
  name: string;
  nameAr: string | null;
  description: string | null;
  /** Arabic description (null until a platform admin or the reference data provides one). */
  descriptionAr: string | null;
  isCustom: boolean;
  sortOrder: number;
  limits: Record<string, number>;
  modules: ModuleKey[];
  /** Price for the requested interval (null when no active price exists for the country). */
  price: PriceTag | null;
  /** Prices for both intervals so clients can show the annual saving. */
  prices: { month: PriceTag | null; year: PriceTag | null };
}

export interface PublicModulePrice {
  key: ModuleKey;
  name: string;
  nameAr: string;
  description: string;
  price: PriceTag | null;
  prices: { month: PriceTag | null; year: PriceTag | null };
}

export interface PublicPlansResponse {
  country: 'EG' | 'SA';
  currency: 'EGP' | 'SAR';
  interval: 'month' | 'year';
  plans: PublicPlan[];
  modules: PublicModulePrice[];
  externalCostsNote: string;
  externalCostsNoteAr: string;
}

export interface PriceQuote {
  planId: string;
  country: 'EG' | 'SA';
  currency: 'EGP' | 'SAR';
  interval: 'month' | 'year';
  /** `included` lines cost nothing because the plan already contains the module. */
  lines: Array<{ kind: 'plan' | 'module'; key: string; amountMinor: number; included?: boolean }>;
  subtotalMinor: number;
  /** Modules that would be enabled by this configuration (plan modules + chosen add-ons). */
  modules: ModuleKey[];
  /** Platform subscription fees only. Provider fees (payments, WhatsApp, ads) are billed by those providers. */
  externalCostsNote: string;
  externalCostsNoteAr: string;
}

export type EntitlementSource = 'plan' | 'addon' | 'override' | 'none';

export interface EntitlementsView {
  planId: string | null;
  status: string | null;
  modules: Record<string, { enabled: boolean; source: EntitlementSource; overrideExpiresAt?: string | null }>;
  limits: Record<string, number>;
  usage: Record<string, number>;
  period?: { start: string; end: string } | null;
  trialEndsAt?: string | null;
  graceUntil?: string | null;
  cancelAtPeriodEnd?: boolean;
  pendingPlanId?: string | null;
}

export interface SubscriptionView {
  id: string;
  planId: string;
  plan: { id: string; name: string; nameAr: string | null; limits: Record<string, number>; modules: ModuleKey[] };
  status: 'trialing' | 'active' | 'past_due' | 'unpaid' | 'canceled' | 'paused';
  interval: 'month' | 'year';
  country: 'EG' | 'SA';
  currency: 'EGP' | 'SAR';
  currentPeriodStart: string;
  currentPeriodEnd: string;
  trialEndsAt: string | null;
  graceUntil: string | null;
  cancelAtPeriodEnd: boolean;
  pendingChange: null | { planId: string; interval: 'month' | 'year'; addons: ModuleKey[]; effectiveAt: string };
  addons: ModuleKey[];
  /** Recurring Resuto fee for the current configuration (from current price rows). */
  recurring: PriceQuote | null;
  /** No billing provider is integrated yet: fees cannot be collected automatically. */
  billingProvider: { connected: false; note: string };
  invoices: Array<{ id: string; number: string; status: string; currency: string; totalMinor: number; periodStart: string; periodEnd: string; createdAt: string }>;
  events: Array<{ id: number; type: string; fromPlanId: string | null; toPlanId: string | null; details: Record<string, unknown>; createdAt: string }>;
}

export interface ChangePlanResult {
  /** `applied` = effective now; `scheduled` = effective at the end of the current period. */
  outcome: 'applied' | 'scheduled' | 'cleared';
  subscription: SubscriptionView;
}

export interface DowngradeViolation {
  limit: string;
  current: number;
  allowed: number;
}

// ---------------------------------------------------------------------------
// FT-19: platform fees vs pass-through costs
// ---------------------------------------------------------------------------
export const PASS_THROUGH_CATEGORIES = ['payment_fees', 'ad_spend', 'messaging', 'metered_external'] as const;
export type PassThroughCategory = (typeof PASS_THROUGH_CATEGORIES)[number];
/**
 * How an amount is known. provider_reported: the provider reported the money (payment fees, ad reports);
 * count_only: Resuto knows how many billable units were sent but not their price (Meta bills by its own rate card);
 * metered: recorded on usage_events with an external cost.
 */
export type CostBasis = 'provider_reported' | 'count_only' | 'metered';
export interface PassThroughLine {
  category: PassThroughCategory;
  /** Sub-category: payment method, ad provider, WhatsApp template category, metric. */
  detail: string;
  quantity: number;
  /** Null when only a count is known (count_only). */
  amountMinor: number | null;
  currency: string | null;
  basis: CostBasis;
  /** Who charges it: always the provider, never Resuto. */
  billedBy: string;
}
export interface CostsMonth {
  month: string; // YYYY-MM
  /** Resuto's own fees: platform invoices whose period starts in this month (draft until a billing provider settles them). */
  platform: { invoicedMinor: number; currency: string | null; invoiceStatuses: string[] };
  passThrough: PassThroughLine[];
}
export interface CostsView {
  months: CostsMonth[];
  /** Short notes on what is and is not included (codes; the UI localises them). */
  notes: Array<'messaging_rate_card_not_known' | 'ai_included_in_plan' | 'sandbox_excluded'>;
}
export const costsQuery = z.object({ months: z.coerce.number().int().min(1).max(12).default(3) });
