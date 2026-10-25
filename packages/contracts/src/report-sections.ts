// Insights area (21-INSIGHTS, plan §3 and §5): the views a saved report can reopen and what each one keeps. Zod-free,
// so the staff Insights pages import this module directly (apps/web/lib/contracts-reports.ts) without the schema
// library. Request schemas: ./reports.ts (subpath '@resuto/contracts/reports').

/**
 * Insights views a report can be saved from. The ROI calculator (a form of assumptions), the delivery route planner
 * (an action) and the research results (fixed evaluations) have nothing to save.
 */
export const REPORT_SECTIONS = [
  'overview', 'sales', 'menu', 'customers', 'ratings', 'marketing', 'operations', 'sustainability',
  'findings', 'forecast', 'recommendations',
] as const;
export type ReportSection = (typeof REPORT_SECTIONS)[number];

/** Period presets of the Insights toolbar (the overview command centre's today / 7d / 30d / custom are a subset). */
export const REPORT_PERIODS = ['today', '7d', '30d', 'month', 'lastMonth', '90d', 'custom'] as const;
export type ReportPeriod = (typeof REPORT_PERIODS)[number];

/** Comparison of the period (the same values as the overview's: previous_period = the same number of days just before). */
export const REPORT_COMPARE = ['previous_period', 'last_year', 'none'] as const;
export type ReportCompare = (typeof REPORT_COMPARE)[number];

/** Saved reports one member may keep per restaurant (their own; colleagues' shared reports do not count). */
export const SAVED_REPORT_LIMIT_PER_USER = 50;
export const SAVED_REPORT_NAME_MAX = 80;

const POSITIVE_UP_TO_100 = (v: string) => /^\d{1,3}(\.\d{1,2})?$/.test(v) && Number(v) > 0 && Number(v) <= 100;

/**
 * The page filters each view keeps, with what a valid value looks like. Anything else is not part of a report (the
 * API refuses it, the web drops it), so a saved report can only ever set a filter the page itself offers.
 */
export const REPORT_FILTERS: Record<ReportSection, Record<string, (value: string) => boolean>> = {
  overview: {}, sales: {}, menu: {}, customers: {}, ratings: {}, marketing: {}, operations: {},
  sustainability: { gramsPerSheet: POSITIVE_UP_TO_100 },
  findings: { status: (v) => v === 'open' || v === 'all' || v === 'dismissed' },
  forecast: { horizon: (v) => v === '7' || v === '14' },
  recommendations: {},
};

/** Whether `key=value` is a filter the section keeps. */
export const validReportFilter = (section: ReportSection, key: string, value: string) =>
  Object.prototype.hasOwnProperty.call(REPORT_FILTERS[section], key) && REPORT_FILTERS[section][key]!(value);

/** What a report reopens: the period, the comparison and the page filters (the branch is stored beside it). */
export interface ReportView {
  period: ReportPeriod;
  /** Local dates, only with period 'custom'. */
  from?: string;
  to?: string;
  compare: ReportCompare;
  filters: Record<string, string>;
}

export interface SavedReport {
  id: string;
  name: string;
  section: ReportSection;
  view: ReportView;
  /** null: every branch the viewer can see. */
  branchId: string | null;
  /** Visible to colleagues who may read analytics (only the author changes or deletes it). */
  shared: boolean;
  /** The caller saved it (false: a colleague's shared report). */
  mine: boolean;
  /** Who saved it (profile name or email), for colleagues' shared reports; null for the caller's own. */
  authorName: string | null;
  createdAt: string;
  updatedAt: string;
}
