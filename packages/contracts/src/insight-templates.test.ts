import { describe, expect, it } from 'vitest';
import { INSIGHT_TEMPLATE_KEYS, renderInsight, stripIsolates } from './insight-templates';

const params = {
  branch: { en: 'Main branch', ar: 'الفرع الرئيسي' }, product: { en: 'Smash burger', ar: null }, item: { en: 'Burrata', ar: 'بوراتا' },
  date: '2026-10-19', revenueMinor: 125050, baselineMinor: 250000, dropPct: 50, weeks: 4, currency: 'EGP', orders: 12,
  quantity: 1234.5, mean: 3.2, z: 3.4, windowDays: 28, stock: 3, averageDailySales: 1.9, coverDays: 1.6, reorderLevel: 5, unit: 'pcs',
  slowerPct: 160, medianMinutes: 26, baselineMedianMinutes: 10, baselineDays: 14, customers: 7, topSharePct: 20, spendMinor: 990000,
  changePct: 42.5, next7: 55.5, last7: 39, model: 'hist_gbm', isHeuristic: true,
};

describe('insight templates (FT-15)', () => {
  for (const key of INSIGHT_TEMPLATE_KEYS) {
    for (const locale of ['en', 'ar'] as const) {
      it(`${key} renders completely in ${locale}`, () => {
        const r = renderInsight(key, params, locale)!;
        const all = [r.title, r.body, ...r.evidence.flatMap((e) => [e.label, e.value])].join(' | ');
        expect(r.title.length).toBeGreaterThan(5);
        expect(r.evidence.length).toBeGreaterThan(0);
        expect(all).not.toMatch(/undefined|NaN|\[object|\{\w+\}/);
        // Western digits 0-9 in both languages.
        expect(all).not.toMatch(/[٠-٩۰-۹]/);
        if (locale === 'ar') expect(r.title).toMatch(/[؀-ۿ]/);
        else expect(stripIsolates(r.title)).not.toMatch(/[؀-ۿ]/);
      });
    }
  }

  it('isolates names so a Latin name keeps its direction inside Arabic text, with an Arabic name when there is one', () => {
    const ar = renderInsight('low_stock', params, 'ar')!;
    expect(ar.title).toContain('⁨بوراتا⁩');
    expect(renderInsight('item_spike', params, 'ar')!.title).toContain('⁨Smash burger⁩');
    expect(renderInsight('low_stock', params, 'en')!.body).toBe('1,234.5 pcs in stock at ⁨Main branch⁩; reorder level 5 pcs.');
  });

  it('formats money and dates with Western digits', () => {
    const en = renderInsight('revenue_drop', params, 'en')!;
    expect(stripIsolates(en.body)).toContain('EGP');
    expect(en.body).toContain('1,250.50');
    const ar = renderInsight('revenue_drop', params, 'ar')!;
    expect(ar.body).toMatch(/1,250\.50|1٬250٫50|1,250٫50/);
    expect(ar.body).toContain('2026');
  });

  it('returns null for unknown or missing keys so callers fall back to the stored text', () => {
    expect(renderInsight(null, params, 'en')).toBeNull();
    expect(renderInsight('nope', params, 'ar')).toBeNull();
  });
});
