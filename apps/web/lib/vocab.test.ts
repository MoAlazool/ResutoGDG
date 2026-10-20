import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ALLERGENS, INVENTORY_UNITS } from '@resuto/contracts';
import { formatMessage } from './i18n/format-message';
import { allergens, vocab } from './i18n/dict/vocab';
import type { Locale } from './i18n/locale';
import { actionLabel, allergenLabel, entityLabel, forecastReason, sourceLabel, stationLabel, unitLabel, type Translate } from './vocab';

// VS-21 / DF-15: codes the API stores in English are shown in the page language.

const repo = join(__dirname, '..', '..', '..');
const tFor = (locale: Locale): Translate => {
  const m: Record<string, string> = { ...vocab[locale], ...allergens[locale] };
  return (key, vars) => formatMessage(m[key] ?? key, locale, vars);
};
const en = tFor('en');
const ar = tFor('ar');

function* sources(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* sources(p);
    else if (/\.ts$/.test(name) && !/\.test\.ts$/.test(name)) yield p;
  }
}

describe('operator vocabulary', () => {
  it('has every key in both languages', () => {
    for (const part of [vocab, allergens]) {
      expect(Object.keys(part.ar).sort()).toEqual(Object.keys(part.en).sort());
      for (const [k, v] of Object.entries(part.ar)) expect(v, k).toMatch(/[؀-ۿ]/);
    }
  });

  it('labels every inventory unit and allergen key', () => {
    for (const u of INVENTORY_UNITS) {
      expect(unitLabel(en, u)).toBe(u);
      expect(unitLabel(ar, u)).toMatch(/^[؀-ۿ]+$/);
    }
    for (const a of ALLERGENS) expect(allergenLabel(ar, a)).toMatch(/^[؀-ۿ\s]+$/);
    expect(allergenLabel(ar, 'Tree nuts')).toBe(allergenLabel(ar, 'tree_nuts'));
    expect(allergenLabel(ar, 'كزبرة')).toBe('كزبرة');
  });

  it('translates default station names and keeps custom ones', () => {
    expect(stationLabel(ar, 'Cold kitchen')).toBe('المطبخ البارد');
    expect(stationLabel(ar, 'grill')).toBe('الشواية');
    expect(stationLabel(ar, 'Sushi counter')).toBe('Sushi counter');
  });

  it('labels every activity-log action the API writes (add a label when adding an audit action)', () => {
    const actions = new Set<string>();
    for (const f of sources(join(repo, 'apps/api/src'))) {
      const src = readFileSync(f, 'utf8');
      for (const m of src.matchAll(/\baction:\s*'([a-z_]+(?:\.[a-z_]+)+)'/g)) actions.add(m[1]!);
    }
    // Rows written by migrations and the legacy importer.
    for (const a of ['organization.migrated', 'demo.seeded', 'legacy.visit_opened']) actions.add(a);
    expect(actions.size).toBeGreaterThan(100);
    const missing = [...actions].filter((a) => !actionLabel(en, a) || !actionLabel(ar, a)).sort();
    expect(missing).toEqual([]);
  });

  it('labels every entity type the API writes and humanises unknown codes', () => {
    const types = new Set<string>();
    for (const f of sources(join(repo, 'apps/api/src'))) {
      for (const m of readFileSync(f, 'utf8').matchAll(/\bentityType:\s*'([a-z_]+)'/g)) types.add(m[1]!);
    }
    expect(types.size).toBeGreaterThan(30);
    const missing = [...types].filter((x) => entityLabel(ar, x) === entityLabel(en, x)).sort();
    expect(missing).toEqual([]);
    expect(entityLabel(en, 'loyalty_card')).toBe('Loyalty card');
    expect(sourceLabel(ar, 'mcp')).toBe('اتصال ذكاء اصطناعي');
  });

  it('turns forecast fallback reasons into sentences with Western digits', () => {
    const too = 'history_too_short: needs at least 98 days, has 58';
    expect(forecastReason(en, too)).toBe('needs at least 98 days of history, this item has 58 days');
    expect(forecastReason(ar, too)).toBe('يحتاج إلى سجل 98 يومًا على الأقل، والمتوفر 58 يومًا');
    expect(forecastReason(ar, 'insufficient_history_for_backtest: 3 days')).toBe('سجل المبيعات 3 أيام فقط، وهو غير كافٍ لاختبار النماذج');
    expect(forecastReason(en, 'baseline_outperformed_gbm_in_backtest')).toBe('the simpler model was more accurate on past weeks');
    // Unknown or reshaped codes never show the code or the {placeholders}.
    expect(forecastReason(ar, 'history_too_short')).toBe('لم يُستخدم النموذج المتقدم لهذا الصنف');
    expect(forecastReason(en, 'gpu_unavailable')).toBe('the advanced model was not used for this item');
  });

  it('knows every fallback reason the forecasting service emits', () => {
    const py = readFileSync(join(repo, 'apps/ai-service/app/core/forecast.py'), 'utf8');
    const codes = new Set([...py.matchAll(/["']([a-z]+(?:_[a-z]+){2,})(?::[^"']*)?["']/g)].map((m) => m[1]!)
      .filter((c) => /history|baseline|backtest/.test(c) && c !== 'lowest_backtest_wape' && !c.startsWith('empirical_')));
    expect(codes.size).toBeGreaterThan(0);
    for (const c of codes) expect(Object.keys(vocab.en), c).toContain(`vocab.forecast.${c}`);
  });
});
