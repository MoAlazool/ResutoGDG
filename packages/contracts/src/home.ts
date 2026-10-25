// Overview command centre (21-HOME, plan §6.1): request schemas and response shapes of the overview period, the
// attention aggregator and the per-user overview preferences. Zod-free helpers and constants: ./home-sections.ts.
// Subpath export '@resuto/contracts/home' (not in the main entry): the web resolves the main entry to one shared,
// scope-hoisted module on most staff routes, and only the overview uses these, importing the zod-free part from
// source (apps/web/lib/contracts-home.ts) and the rest as types.
import { z } from 'zod';
import type { AnalyticsMeta } from './analytics';
import { MAX_ANALYTICS_DAYS } from './analytics';
import { isoDate, uuid } from './common';
import type { ModuleKey } from './modules';
import type { Permission } from './permissions';
import { OVERVIEW_COMPARE, OVERVIEW_SECTIONS, type AttentionKind, type OverviewCompare, type OverviewPreferences } from './home-sections';

export * from './home-sections';

/**
 * GET /o/:orgId/analytics/overview. Without `from`/`to` the response is unchanged (today vs the same weekday last
 * week). With them it also carries `period`: the KPIs of those local dates, compared as `compare` says (default
 * previous_period), with customers, acquisition by channel and campaign conversion.
 */
export const overviewQuery = z.object({
  branchId: uuid.optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
  compare: z.enum(OVERVIEW_COMPARE).optional(),
}).refine((q) => (q.from === undefined) === (q.to === undefined), { message: 'from and to go together', path: ['to'] })
  .refine((q) => !q.from || !q.to || q.from <= q.to, { message: 'from must not be after to', path: ['to'] })
  .refine((q) => !q.from || !q.to || (Date.parse(q.to) - Date.parse(q.from)) / 86_400_000 < MAX_ANALYTICS_DAYS, { message: `at most ${MAX_ANALYTICS_DAYS} days`, path: ['from'] })
  .refine((q) => q.compare === undefined || q.from !== undefined, { message: 'compare needs from and to', path: ['compare'] });
export type OverviewQuery = z.infer<typeof overviewQuery>;

export interface OverviewPeriodKpis {
  orders: number; netMinor: number; averageOrderMinor: number;
  /** Identified customers with a counted order in the period, and those with two or more. */
  customers: number; repeatCustomers: number; repeatRatePct: number | null;
}

/** Acquisition channels of new customers (first counted order in the period). */
export const ACQUISITION_CHANNELS = ['campaign_link', 'instagram', 'facebook', 'tiktok', 'snapchat', 'google', 'whatsapp', 'qr', 'website',
  'in_venue', 'phone', 'assistant', 'other_source'] as const;
export type AcquisitionChannel = (typeof ACQUISITION_CHANNELS)[number];

export interface OverviewPeriod {
  from: string; to: string; days: number; compare: OverviewCompare;
  current: OverviewPeriodKpis;
  comparison: { from: string; to: string; kpis: OverviewPeriodKpis } | null;
  /** Percent change against the comparison (null without a base); repeatRatePts is the change in percentage points. */
  changePct: { orders: number | null; netMinor: number | null; averageOrderMinor: number | null; repeatRatePts: number | null } | null;
  daily: Array<{ date: string; orders: number; netMinor: number }>;
  comparisonDaily: Array<{ date: string; orders: number; netMinor: number }> | null;
  customers: { newCustomers: number; returningCustomers: number; newCustomerNetMinor: number; returningCustomerNetMinor: number; ordersWithoutCustomer: number };
  acquisition: {
    newCustomers: number;
    /** attributed = from recorded attribution (UTM or campaign on an event or the first order); inferred = the first order's channel. */
    channels: Array<{ channel: AcquisitionChannel; customers: number; attributed: number; inferred: number }>;
    attributed: number; inferred: number;
  };
  campaigns: {
    attributedOrders: number; attributedNetMinor: number;
    /** Non-sandbox campaigns with attributed orders or tracked clicks in the period. conversionPct = orders ÷ clicks. */
    items: Array<{ campaignId: string; name: string; channel: string; orders: number; netMinor: number; clicks: number | null; conversionPct: number | null }>;
    /** Clicks on tracked links are organization-wide; they are only counted without a branch filter. */
    clicksIncluded: boolean;
    excludedSandboxOrders: number;
  };
  meta: AnalyticsMeta;
}

export const attentionQuery = z.object({ branchId: uuid.optional() });

export type AttentionSeverity = 'critical' | 'warning' | 'info';
export interface AttentionSample {
  id: string;
  /** Display text from the record (an order number, item or provider name, a change title). User-entered text is untrusted. */
  label: string; labelAr?: string | null;
  at?: string | null; value?: number | null; branchId?: string | null;
}
export interface AttentionItem {
  kind: AttentionKind; severity: AttentionSeverity; count: number; samples: AttentionSample[];
  /** Dashboard path under /dashboard/:orgId that resolves it. */
  href: string;
  /** The table the count comes from. */
  source: string;
  /** live = this restaurant's records; sandbox = only test connections or campaigns are involved. */
  provenance: 'live' | 'sandbox';
}
export interface AttentionResponse {
  generatedAt: string; branchId: string | null;
  /** Kinds with something to do, most severe first. */
  items: AttentionItem[];
  /** Kinds that were checked (including the ones with nothing to do). */
  checked: AttentionKind[];
  /** Kinds the caller cannot see, with the reason; they were not read. */
  omitted: Array<{ kind: AttentionKind; reason: 'permission' | 'module'; permission?: Permission; module?: ModuleKey }>;
  rules: Record<string, number>;
}

/** PUT /o/:orgId/preferences/overview: every section once, in display order. */
export const overviewPreferencesInput = z.object({
  sections: z.array(z.object({ id: z.enum(OVERVIEW_SECTIONS), visible: z.boolean() }).strict()).min(1).max(OVERVIEW_SECTIONS.length)
    .refine((s) => new Set(s.map((x) => x.id)).size === s.length, { message: 'each section at most once' }),
}).strict();
export type OverviewPreferencesInput = z.infer<typeof overviewPreferencesInput>;

export interface OverviewPreferencesResponse {
  scope: 'overview'; value: OverviewPreferences;
  /** True when nothing is stored yet (the default layout). */
  isDefault: boolean; updatedAt: string | null;
}
