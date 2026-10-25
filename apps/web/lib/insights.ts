// The Insights area (21-INSIGHTS, plan §3 and §5): one area for analytics and intelligence, one URL format for a view.
// A view is a section (a route) plus `?period=…&compare=…` (custom dates as from/to), the shell's branch (`branch=<id>`
// or `branch=all` in a link, applied to the branch switcher on arrival) and the section's own filters. The overview
// command centre (21-HOME) uses the same period and comparison names, so a drill-down keeps them; a saved report
// (saved_reports) reopens through the same URL. Pure: unit-tested in lib/insights.test.ts.
import {
  REPORT_COMPARE, REPORT_FILTERS, REPORT_PERIODS, validReportFilter,
  type ReportCompare, type ReportPeriod, type ReportSection, type ReportView, type SavedReport,
} from './contracts-reports';

/** Every Insights view: the savable sections plus the ROI calculator, the research results and the route planner. */
export type InsightsSection = ReportSection | 'roi' | 'research' | 'routes';

/** Route of each view, relative to /dashboard/[orgId]. */
export const INSIGHTS_PATHS: Record<InsightsSection, string> = {
  overview: '/analytics', sales: '/analytics/sales', menu: '/analytics/menu', customers: '/analytics/customers',
  ratings: '/analytics/ratings', marketing: '/analytics/marketing', operations: '/analytics/operations',
  sustainability: '/analytics/sustainability', roi: '/analytics/roi',
  findings: '/intelligence', forecast: '/intelligence/forecast', recommendations: '/intelligence/recommendations',
  research: '/intelligence/research', routes: '/intelligence/routes',
};

/**
 * The analytics views served by the one dynamic route /analytics/[section] (each view's code loads on demand, so a
 * view ships only its own panel and charts, and the area adds one route, not eight).
 */
export const ANALYTICS_VIEWS = ['sales', 'menu', 'customers', 'ratings', 'marketing', 'operations', 'sustainability', 'roi'] as const satisfies readonly InsightsSection[];
export type AnalyticsView = (typeof ANALYTICS_VIEWS)[number];
export const isAnalyticsView = (v: string | undefined | null): v is AnalyticsView => !!v && (ANALYTICS_VIEWS as readonly string[]).includes(v);

/** Views whose figures depend on the period (the toolbar shows the period and comparison there). */
export const PERIOD_SECTIONS: readonly InsightsSection[] = ['overview', 'sales', 'menu', 'customers', 'ratings', 'marketing', 'operations', 'sustainability'];
/** Views that compare the period with another one (the others ignore `compare`). */
export const COMPARE_SECTIONS: readonly InsightsSection[] = ['overview', 'sales'];

/**
 * The former Analytics tabs (`/analytics?tab=guests`, still linked by the attention list and older bookmarks) and the
 * section that replaced each one. The intelligence customers screen (segments and churn) merged into Customers.
 */
export const LEGACY_ANALYTICS_TABS: Record<string, InsightsSection> = {
  sales: 'sales', products: 'menu', customers: 'customers', guests: 'ratings', marketing: 'marketing',
  operations: 'operations', sustainability: 'sustainability', roi: 'roi',
};

export const DEFAULT_PERIOD: ReportPeriod = '30d';
export const DEFAULT_COMPARE: ReportCompare = 'previous_period';
const MAX_DAYS = 400;
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** YYYY-MM-DD of `now` in a time zone (the restaurant's local date). */
export function localToday(timeZone: string, now = Date.now()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(now));
}

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

const realDate = (s: string | null | undefined): s is string => !!s && ISO.test(s) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;

/** A custom range the API accepts: two real dates, from ≤ to, at most 400 days. */
export function validRange(from: string | null | undefined, to: string | null | undefined): boolean {
  if (!realDate(from) || !realDate(to) || from > to) return false;
  return (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000 < MAX_DAYS;
}

/** The local dates of a period preset, or of the custom range when it is valid (otherwise the last 7 days). */
export function periodRange(period: ReportPeriod, timeZone: string, custom?: { from?: string | null; to?: string | null }, now = Date.now()) {
  const today = localToday(timeZone, now);
  switch (period) {
    case 'today': return { from: today, to: today };
    case '7d': return { from: addDays(today, -6), to: today };
    case '30d': return { from: addDays(today, -29), to: today };
    case '90d': return { from: addDays(today, -89), to: today };
    case 'month': return { from: `${today.slice(0, 8)}01`, to: today };
    case 'lastMonth': {
      const lastPrev = addDays(`${today.slice(0, 8)}01`, -1);
      return { from: `${lastPrev.slice(0, 8)}01`, to: lastPrev };
    }
    case 'custom':
      return custom && validRange(custom.from, custom.to) ? { from: custom.from!, to: custom.to! } : { from: addDays(today, -6), to: today };
  }
}

const pick = <T extends string>(v: string | null, allowed: readonly T[], fallback: T): T => (v !== null && (allowed as readonly string[]).includes(v) ? v as T : fallback);

/** The branch a link names: a branch id, 'all', or null (keep the shell's current branch). */
export function branchParam(v: string | null): string | null {
  if (v === 'all') return 'all';
  return v && UUID.test(v) ? v.toLowerCase() : null;
}

/** A view as the URL describes it (unknown values fall back to the defaults; filters the section does not keep are dropped). */
export function readView(section: InsightsSection, params: URLSearchParams): ReportView {
  const period = pick(params.get('period'), REPORT_PERIODS, DEFAULT_PERIOD);
  const compare = pick(params.get('compare'), REPORT_COMPARE, DEFAULT_COMPARE);
  const view: ReportView = { period, compare, filters: {} };
  if (period === 'custom' && validRange(params.get('from'), params.get('to'))) { view.from = params.get('from')!; view.to = params.get('to')!; }
  if (section in REPORT_FILTERS) {
    for (const key of Object.keys(REPORT_FILTERS[section as ReportSection])) {
      const v = params.get(key);
      if (v !== null && validReportFilter(section as ReportSection, key, v)) view.filters[key] = v;
    }
  }
  return view;
}

/** Search params of a view (defaults left out so plain links stay clean); `branch` is a branch id, 'all' or omitted. */
export function viewParams(view: Pick<ReportView, 'period' | 'compare'> & Partial<ReportView>, branch?: string | null): URLSearchParams {
  const q = new URLSearchParams();
  if (view.period !== DEFAULT_PERIOD) q.set('period', view.period);
  if (view.period === 'custom' && view.from && view.to) { q.set('from', view.from); q.set('to', view.to); }
  if (view.compare !== DEFAULT_COMPARE) q.set('compare', view.compare);
  if (branch) q.set('branch', branch);
  for (const [k, v] of Object.entries(view.filters ?? {})) q.set(k, v);
  return q;
}

const withQuery = (path: string, q: URLSearchParams) => (q.toString() ? `${path}?${q}` : path);

/** Link to a view (relative to /dashboard/[orgId]). */
export function insightsHref(section: InsightsSection, view: Pick<ReportView, 'period' | 'compare'> & Partial<ReportView>, branch?: string | null): string {
  return withQuery(INSIGHTS_PATHS[section], viewParams(view, branch));
}

/** The URL that reopens a saved report (its branch included: 'all' when it covers every branch). */
export function reportHref(report: Pick<SavedReport, 'id' | 'section' | 'view' | 'branchId'>): string {
  const q = viewParams(report.view, report.branchId ?? 'all');
  q.set('report', report.id);
  return withQuery(INSIGHTS_PATHS[report.section], q);
}

/**
 * Drill-down from the overview command centre (21-HOME): the same period (its today / 7d / 30d / custom), the same
 * comparison and the shell's branch ('' = All branches), always written out so the link means the same anywhere.
 */
export function drillDownHref(section: InsightsSection, home: { preset: string; compare: string; from: string; to: string; branchId: string }): string {
  const period = pick(home.preset, REPORT_PERIODS, 'today');
  const q = new URLSearchParams({ period });
  if (period === 'custom') { q.set('from', home.from); q.set('to', home.to); }
  q.set('compare', pick(home.compare, REPORT_COMPARE, DEFAULT_COMPARE));
  q.set('branch', home.branchId || 'all');
  return `${INSIGHTS_PATHS[section]}?${q}`;
}

/**
 * Where an old Analytics URL goes: `/analytics?tab=guests&x=1` → `/analytics/ratings?x=1`. Null when there is no
 * (known) tab, so the overview renders.
 */
export function legacyAnalyticsTarget(search: string): string | null {
  const q = new URLSearchParams(search);
  const target = LEGACY_ANALYTICS_TABS[q.get('tab') ?? ''];
  if (!target) return null;
  q.delete('tab');
  return withQuery(INSIGHTS_PATHS[target], q);
}

/** The analytics API's name for a comparison (`previous_period` is the API's `previous`). */
export const apiCompare = (c: ReportCompare): 'previous' | 'last_year' | 'none' => (c === 'previous_period' ? 'previous' : c);


/**
 * Server redirects of the routes that merged (next.config.ts): the former Analytics tabs and the intelligence
 * customers screen. The query string is passed through, so period, comparison and branch survive the redirect.
 */
export function insightsRedirects() {
  return [
    { source: '/dashboard/:orgId/intelligence/customers', destination: `/dashboard/:orgId${INSIGHTS_PATHS.customers}`, permanent: false },
    ...Object.entries(LEGACY_ANALYTICS_TABS).map(([tab, section]) => ({
      source: '/dashboard/:orgId/analytics', has: [{ type: 'query' as const, key: 'tab', value: tab }],
      destination: `/dashboard/:orgId${INSIGHTS_PATHS[section]}`, permanent: false,
    })),
  ];
}
