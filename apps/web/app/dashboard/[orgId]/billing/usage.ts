// Plan & billing usage meters (21-MONEY). Pure, so the maths is unit tested: the page only draws what this returns.
// Counts and limits come from GET /o/:id/billing/entitlements (usage = the current period's live counts and metered
// totals; limits = the current plan's own limits). Nothing here invents a limit the plan does not have.
import { INTL_LOCALE } from '@resuto/contracts/lite';

/** A date of the billing pages (medium style, Western digits in Arabic). */
export const day = (iso: string | null | undefined, locale: 'en' | 'ar') =>
  iso ? new Intl.DateTimeFormat(locale === 'ar' ? INTL_LOCALE.ar : 'en-GB', { dateStyle: 'medium' }).format(new Date(iso)) : '—';
/** Fills {name} placeholders of the page's own strings. */
export const fill = (s: string, v: Record<string, string>) => Object.entries(v).reduce((a, [k, x]) => a.replaceAll(`{${k}}`, x), s);

/** Usage metrics in display order, each with the plan limit that caps it (contracts USAGE_LIMIT_FOR). */
export const USAGE_METRICS = [
  { key: 'branches', limit: 'branches' },
  { key: 'staff', limit: 'staff' },
  { key: 'orders', limit: 'orders_per_month' },
  { key: 'ai_requests', limit: 'ai_requests_per_month' },
  { key: 'mcp_calls', limit: 'mcp_calls_per_month', module: 'mcp' },
] as const;
export type UsageMetric = (typeof USAGE_METRICS)[number]['key'];

/**
 * ok < 80 %, warn from 80 %, danger at or over the limit; `none` when the limit is 0 (the plan does not include it);
 * `unlimited` when the plan sets no limit.
 */
export type MeterState = 'ok' | 'warn' | 'danger' | 'none' | 'unlimited';

export interface Meter {
  used: number;
  /** null: the plan sets no limit for this metric. */
  limit: number | null;
  /** 0-100, whole percent; never shows 100 % while still under the limit. */
  pct: number;
  state: MeterState;
  /** null without a limit. */
  remaining: number | null;
  over: boolean;
}

const count = (n: unknown) => (typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.floor(n) : 0);

export function usageMeter(used: unknown, limit: unknown): Meter {
  const u = count(used);
  if (typeof limit !== 'number' || !Number.isFinite(limit) || limit < 0) return { used: u, limit: null, pct: 0, state: 'unlimited', remaining: null, over: false };
  const l = Math.floor(limit);
  if (l === 0) return { used: u, limit: 0, pct: u > 0 ? 100 : 0, state: u > 0 ? 'danger' : 'none', remaining: 0, over: u > 0 };
  const ratio = u / l;
  const pct = u >= l ? 100 : Math.min(99, Math.floor(ratio * 100));
  const state: MeterState = u >= l ? 'danger' : ratio >= 0.8 ? 'warn' : 'ok';
  return { used: u, limit: l, pct, state, remaining: Math.max(0, l - u), over: u > l };
}

/**
 * One meter per metric from the entitlements view (`usage` and `limits` as the API returns them). A metric that
 * belongs to a module the plan does not include (MCP calls without the MCP module) reads `none`, not "no limit".
 */
export function usageMeters(view: { usage: Record<string, number>; limits: Record<string, number>; modules?: Record<string, { enabled: boolean }> }): Array<{ key: UsageMetric } & Meter> {
  return USAGE_METRICS.map((m) => {
    const meter = usageMeter(view.usage[m.key], view.limits[m.limit]);
    const mod = 'module' in m ? view.modules?.[m.module] : undefined;
    if (mod && !mod.enabled && meter.state === 'unlimited') return { key: m.key, ...meter, limit: 0, pct: 0, state: 'none' as const, remaining: 0 };
    return { key: m.key, ...meter };
  });
}
