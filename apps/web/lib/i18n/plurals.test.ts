import { describe, expect, it } from 'vitest';
import { formatMessage, hasPlural } from './format-message';
import { dictionaries } from './messages';

// VS-22: counts read correctly in both languages ("1 booking", "حجزان", "11 حجزًا"), never "1 bookings" / "1 حجوزات".
// Every message that interpolates a count must use the plural syntax in Arabic (six forms) unless it is an ordinal or
// a reference number listed below.

const COUNT_VARS = ['n', 'count', 'covers', 'orders', 'days', 'guests', 'items'];
/** Ordinals, references and quantities with their own unit: "Order #{n}", "revision {n}", "up to {n}". */
const NOT_A_COUNT = new Set([
  'core.guest.upTo', 'core.guest.orderNumber', 'insights.customers.month', 'connect.templates.placeholders', 'connect.order.required',
  'connect.order.optional', 'connect.int.pos.preview', 'pay.receipt.splitPaid', 'pay.split.share', 'pay.split.unit', 'driver.order',
  'driver.dispatch.jobTitle', 'studio.floor.conflictRevision', 'studio.floor.selectedCount', 'studio.website.published', 'studio.publish.done',
  'studio.history.restoreTitle', 'studio.history.restored', 'mcp.form.maxCallsHint',
  'onb.progress', 'onb.sheet.row',
]);

const placeholders = (m: string) => [...m.matchAll(/\{(\w+)(?:\s*,\s*plural\s*,)?/g)].map((x) => x[1]!);

describe('plural-aware messages (VS-22)', () => {
  it('every Arabic count message uses the plural syntax', () => {
    const missing = Object.entries(dictionaries.ar)
      .filter(([k, m]) => !NOT_A_COUNT.has(k) && COUNT_VARS.some((v) => m.includes(`{${v}}`) && !hasPlural(m, v)))
      .map(([k, m]) => `${k}: ${m}`);
    expect(missing).toEqual([]);
  });

  it('plural messages resolve for every count without leaking the syntax, with Western digits', () => {
    const broken: string[] = [];
    for (const locale of ['en', 'ar'] as const) {
      for (const [k, m] of Object.entries(dictionaries[locale])) {
        if (!hasPlural(m)) continue;
        for (const n of [0, 1, 2, 3, 11, 100, 1250]) {
          const vars = Object.fromEntries(placeholders(m).map((v) => [v, n]));
          const out = formatMessage(m, locale, vars);
          if (/\{|\}/.test(out) || /[٠-٩]/.test(out)) broken.push(`${locale} ${k} (${n}): ${out}`);
        }
      }
    }
    expect(broken).toEqual([]);
  });

  it('reads naturally for the common cases', () => {
    const ar = (k: string, vars: Record<string, number>) => formatMessage(dictionaries.ar[k]!, 'ar', vars);
    const en = (k: string, vars: Record<string, number>) => formatMessage(dictionaries.en[k]!, 'en', vars);
    expect(en('core.resdash.subtitle', { n: 1, covers: 3 })).toBe('1 booking · 3 covers');
    expect(ar('core.resdash.subtitle', { n: 1, covers: 2 })).toBe('حجز واحد · ضيفان');
    expect(ar('core.res.guests', { n: 3 })).toBe('3 ضيوف');
    expect(ar('core.res.guests', { n: 11 })).toBe('11 ضيفًا');
    expect(ar('insights.overview.readyWaiting', { count: 1 })).toBe('طلب واحد جاهز للتسليم.');
    expect(en('insights.overview.readyWaiting', { count: 1 })).toBe('1 order is ready for hand-off.');
  });
});
