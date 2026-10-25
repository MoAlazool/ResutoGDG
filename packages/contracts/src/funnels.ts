// Growth funnel and retention (21-CRM, plan §6.7): the beacon body and the response shapes of
// GET /o/:orgId/analytics/funnel and GET /o/:orgId/analytics/retention.
import { z } from 'zod';
import type { AnalyticsMeta } from './analytics';
import { uuid } from './common';
import {
  FUNNEL_BEACON_EVENTS, FUNNEL_SESSION_ID, FUNNEL_SURFACES, funnelEventAllowed,
} from './funnel-beacon';

export * from './funnel-beacon';

/**
 * POST /v1/public/funnel/beacon (text/plain JSON from navigator.sendBeacon, or fetch keepalive). Short keys keep the
 * body tiny. Strict: an unknown key, a malformed value or an event the page group cannot send is refused (400).
 */
export const funnelBeacon = z.object({
  e: z.enum(FUNNEL_BEACON_EVENTS),
  s: z.enum(FUNNEL_SURFACES),
  /** The restaurant's public slug. */
  o: z.string().regex(/^[a-z0-9-]{1,60}$/),
  /** The branch the page shows, when it knows one (dropped when it is not the restaurant's). */
  b: uuid.optional(),
  /** Random per-tab id (sessionStorage); only its hash is stored. */
  sid: z.string().regex(FUNNEL_SESSION_ID),
}).strict().refine((v) => funnelEventAllowed(v.e, v.s), { message: 'this page cannot send this event', path: ['e'] });
export type FunnelBeacon = z.infer<typeof funnelBeacon>;

export const FUNNEL_STEPS = ['visits', 'qr_scans', 'messages', 'leads', 'orders', 'repeat'] as const;
/** Guest cart activity from the same beacons, shown beside the funnel. */
export const FUNNEL_CART_STEPS = ['add_to_cart', 'checkout_started'] as const;
export type FunnelStepKey = (typeof FUNNEL_STEPS)[number] | (typeof FUNNEL_CART_STEPS)[number];

/**
 * How complete a step's number is:
 *   complete     every qualifying record in scope is counted;
 *   partial      a lower bound (beacons need the page's script to run; branch filters leave out rows without a branch);
 *   estimate     scaled from a sample (page views: 1 in FUNNEL_PAGE_VIEW_WEIGHT sessions);
 *   unavailable  not measured for this restaurant or caller (value null).
 */
export const FUNNEL_COMPLETENESS = ['complete', 'partial', 'estimate', 'unavailable'] as const;
export type FunnelCompleteness = (typeof FUNNEL_COMPLETENESS)[number];

/** Why a step is partial or unavailable (several can apply). */
export const FUNNEL_NOTES = ['needs_script', 'sampled', 'branch_unknown_excluded', 'connect_not_entitled', 'sandbox_excluded',
  'identified_only', 'before_beacons', 'not_same_people'] as const;
export type FunnelNote = (typeof FUNNEL_NOTES)[number];

export interface FunnelStep {
  key: FunnelStepKey;
  /** null when unavailable. */
  value: number | null;
  unit: 'sessions' | 'conversations' | 'customers' | 'orders';
  /** The table and record kind the number is counted from (plain text, English, for the method panel). */
  source: string;
  completeness: FunnelCompleteness;
  notes: FunnelNote[];
  /** Raw rows behind an estimate (sampled sessions before weighting); equals value otherwise. */
  measured: number | null;
}

export interface FunnelReport {
  from: string; to: string; branchId: string | null;
  /** visits → QR scans → messages → leads → orders → repeat, in that order. */
  steps: FunnelStep[];
  /** Sessions that added to a cart and that opened the checkout (guest pages with a cart). */
  cart: FunnelStep[];
  /** When this restaurant's first funnel beacon arrived (null: none yet). Steps from beacons count from then on. */
  beaconsSince: string | null;
  meta: AnalyticsMeta;
}

export interface RetentionReport {
  from: string; to: string; branchId: string | null;
  /** Customers by the local month of their first counted order (inside the period); active[i] ordered in month i after it. */
  cohorts: Array<{ cohort: string; size: number; active: number[]; retentionPct: Array<number | null> }>;
  /**
   * Repeat-purchase curve of the period's new customers: for day d, `eligible` = customers whose first order is at least
   * d days before `asOf` (so they had d days to come back), `repeated` = those of them whose second counted order came
   * within d days, pct = repeated ÷ eligible.
   */
  repeatCurve: { asOf: string; newCustomers: number; points: Array<{ day: number; eligible: number; repeated: number; pct: number | null }> };
  meta: AnalyticsMeta;
}

export const RETENTION_CURVE_DAYS = 90;

/** Customer 360 / overview: how a messaging contact may be contacted without marketing consent. */
export const CONTACT_BASES = ['marketing_consent', 'service_replies_only'] as const;
export type ContactBasis = (typeof CONTACT_BASES)[number];
