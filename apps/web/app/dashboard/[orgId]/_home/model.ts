// Pure logic of the overview command centre (21-HOME): periods, request paths, which sections a role can use and the
// "Next actions" links. No React here, so it is unit-tested directly (model.test.ts).
import type { Insight } from '@resuto/contracts';
import type { OverviewCompare, OverviewPreferences, OverviewSectionId } from '@resuto/contracts/home';

export type PeriodPreset = 'today' | '7d' | '30d' | 'custom';
export const PERIOD_PRESETS: readonly PeriodPreset[] = ['today', '7d', '30d', 'custom'];
export const COMPARES: readonly OverviewCompare[] = ['previous_period', 'last_year', 'none'];
/** The API's limit (MAX_ANALYTICS_DAYS): at most 400 days in one period. */
export const MAX_PERIOD_DAYS = 400;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const DAY = 86_400_000;

/** YYYY-MM-DD of `now` in a time zone (the restaurant's local date). */
export function localToday(timeZone: string, now = Date.now()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(now));
}

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

const validDate = (s: string | null | undefined): s is string => !!s && ISO_DATE.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`))
  && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;

/** A custom range the API accepts: two real dates, from ≤ to, at most 400 days. */
export function validRange(from: string | null | undefined, to: string | null | undefined): boolean {
  if (!validDate(from) || !validDate(to) || from > to) return false;
  return (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY < MAX_PERIOD_DAYS;
}

/** The local dates of a preset (today, the last 7 or 30 days including today), or the custom range when it is valid. */
export function periodRange(preset: PeriodPreset, timeZone: string, custom?: { from?: string | null; to?: string | null }, now = Date.now()): { from: string; to: string } {
  const today = localToday(timeZone, now);
  if (preset === 'custom' && custom && validRange(custom.from, custom.to)) return { from: custom.from!, to: custom.to! };
  if (preset === '7d') return { from: addDays(today, -6), to: today };
  if (preset === '30d') return { from: addDays(today, -29), to: today };
  if (preset === 'custom') return { from: addDays(today, -6), to: today };
  return { from: today, to: today };
}

const qs = (params: Record<string, string | null | undefined>) => {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) sp.set(k, v);
  const s = sp.toString();
  return s ? `?${s}` : '';
};

/** GET analytics/overview for the period (the branch comes from the shell; '' = all branches the caller can see). */
export function overviewPath(orgId: string, p: { branchId?: string | null; from: string; to: string; compare: OverviewCompare }): string {
  return `/o/${orgId}/analytics/overview${qs({ branchId: p.branchId, from: p.from, to: p.to, compare: p.compare })}`;
}

export function attentionPath(orgId: string, branchId?: string | null): string {
  return `/o/${orgId}/attention${qs({ branchId })}`;
}

/** What the signed-in member may use, as the shell knows it (role permissions and plan modules). */
export interface HomeAccess { can(permission: string): boolean; hasModule(module: string): boolean }

/** Whether a section has anything to show for this member (sections without access are not rendered or offered). */
export function sectionAvailable(id: OverviewSectionId, a: HomeAccess): boolean {
  switch (id) {
    case 'now': case 'performance': case 'customers': return a.can('analytics:read');
    case 'actions': return a.can('ai:use') && a.hasModule('intelligence');
    case 'attention': return true;
  }
}

/** The sections to render, in the member's order, without hidden or unavailable ones. */
export function shownSections(prefs: OverviewPreferences, a: HomeAccess): OverviewSectionId[] {
  return prefs.sections.filter((s) => s.visible && sectionAvailable(s.id, a)).map((s) => s.id);
}

/**
 * Moves a section past its nearest neighbour that this member can see (sections they cannot use keep their place
 * in the stored order, so a colleague-independent layout survives a role change). Unchanged at either end.
 */
export function moveAmong(prefs: OverviewPreferences, id: OverviewSectionId, delta: -1 | 1, a: HomeAccess): OverviewPreferences {
  const sections = [...prefs.sections];
  const i = sections.findIndex((s) => s.id === id);
  if (i < 0) return prefs;
  let j = i + delta;
  while (j >= 0 && j < sections.length && !sectionAvailable(sections[j]!.id, a)) j += delta;
  if (j < 0 || j >= sections.length) return prefs;
  [sections[i], sections[j]] = [sections[j]!, sections[i]!];
  return { sections };
}

export type NextActionKind = 'winBack' | 'promote' | 'dish' | 'stock' | 'kitchen' | 'sales';
export interface NextAction { kind: NextActionKind; href: string }

const nameOf = (n: unknown, locale: 'en' | 'ar'): string | null => {
  if (typeof n === 'string') return n;
  if (n && typeof n === 'object' && typeof (n as { en?: unknown }).en === 'string') {
    const v = n as { en: string; ar?: string | null };
    return locale === 'ar' && v.ar ? v.ar : v.en;
  }
  return null;
};
const idOf = (v: unknown) => (typeof v === 'string' && /^[0-9a-f-]{36}$/i.test(v) ? v : null);

/**
 * The one-click action of an insight: a link to the screen that resolves it, opening a prefilled draft where there is
 * one (a campaign draft in Marketing). It is only a link: nothing is created, sent or changed until the member saves
 * the draft there. Null when the member cannot use any target.
 */
export function insightAction(insight: Pick<Insight, 'templateKey' | 'params' | 'evidence'>, a: HomeAccess,
  names: { winBack: string; promote: (dish: string) => string }, locale: 'en' | 'ar' = 'en'): NextAction | null {
  const p = insight.params ?? {};
  const productId = idOf(insight.evidence?.productId) ?? idOf(p.productId);
  const draft = (objective: string, name: string) => `/marketing${qs({ draft: 'campaign', objective, name: name.slice(0, 120) })}`;
  const canDraft = a.can('marketing:write') && a.hasModule('marketing');
  switch (insight.templateKey) {
    case 'inactive_valuable': case 'churn_high':
      return canDraft ? { kind: 'winBack', href: draft('reactivation', names.winBack) } : null;
    case 'item_drop': case 'demand_fall': {
      const dish = nameOf(p.product, locale);
      if (canDraft && dish) return { kind: 'promote', href: draft('upsell', names.promote(dish)) };
      return productId && a.can('menu:read') ? { kind: 'dish', href: `/menu${qs({ product: productId })}` } : null;
    }
    case 'item_spike': case 'demand_rise': case 'stock_sold_out': case 'stock_cover_low':
      return productId && a.can('menu:read') ? { kind: 'dish', href: `/menu${qs({ product: productId })}` } : null;
    case 'low_stock':
      return a.can('inventory:read') ? { kind: 'stock', href: '/inventory?tab=alerts' } : null;
    case 'slow_kitchen':
      return a.can('kitchen:operate') ? { kind: 'kitchen', href: '/kitchen' } : null;
    case 'revenue_drop':
      // The Insights sales view (21-INSIGHTS; /analytics is the Insights overview).
      return a.can('analytics:read') ? { kind: 'sales', href: '/analytics/sales' } : null;
    default:
      return null;
  }
}

const SEVERITY_ORDER: Record<Insight['severity'], number> = { critical: 0, warning: 1, opportunity: 2, info: 3 };
/** Open insights (new or seen), most severe first, newest first within a severity. */
export function openInsights(items: Insight[], limit = 4): Insight[] {
  return items.filter((i) => i.status === 'new' || i.status === 'seen')
    .sort((x, y) => SEVERITY_ORDER[x.severity] - SEVERITY_ORDER[y.severity] || y.createdAt.localeCompare(x.createdAt))
    .slice(0, limit);
}

/** Provenance of an insight: a fixed rule over recorded data is live; a model or language model is an estimate. */
export const insightProvenance = (method: Insight['method']) => (method === 'deterministic' ? 'live' as const : 'estimated' as const);

/** Cumulative series for a sparkline (today's hourly revenue up to the current hour). */
export function cumulative(values: number[]): number[] {
  let sum = 0;
  return values.map((v) => (sum += v));
}

/** "Meta ads" from a provider id such as meta_ads (sample labels of integration attention items). */
export const providerName = (id: string) => id.split('_').map((w) => (w ? w[0]!.toUpperCase() + w.slice(1) : w)).join(' ');
