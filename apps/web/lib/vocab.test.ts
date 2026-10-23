import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ALLERGENS, INVENTORY_UNITS } from '@resuto/contracts';
import { formatMessage } from './i18n/format-message';
import { integrations } from './i18n/dict/integrations';
import { allergens, vocab } from './i18n/dict/vocab';
import type { Locale } from './i18n/locale';
import { actionLabel, allergenLabel, capabilityLabel, entityLabel, forecastReason, invoiceStatusLabel, paymentProviderLabel, reconSourceLabel, reconStatusLabel, sourceLabel, stationLabel, subscriptionEventLabel, unitLabel, type Translate } from './vocab';

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

  it('labels every plan-history event the API writes, and every invoice status', () => {
    const types = new Set<string>(['created', 'demo_complimentary']); // organizations.service.ts insert, demo loader
    for (const f of sources(join(repo, 'apps/api/src/modules/billing'))) {
      for (const m of readFileSync(f, 'utf8').matchAll(/\.event\(tx,\s*[^,]+,\s*[^,]+,\s*(?:[^,?']+\?\s*'([a-z_]+)'\s*:\s*'([a-z_]+)'|'([a-z_]+)')/g)) {
        for (const x of m.slice(1)) if (x) types.add(x);
      }
    }
    expect(types.size).toBeGreaterThan(10);
    const missing = [...types].filter((x) => subscriptionEventLabel(ar, x) === subscriptionEventLabel(en, x)).sort();
    expect(missing).toEqual([]);
    for (const st of ['draft', 'open', 'paid', 'void', 'uncollectible']) expect(invoiceStatusLabel(ar, st)).toMatch(/[\u0600-\u06FF]/);
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

describe('integration capabilities and payment providers (REM-W06)', () => {
  /** Every capability code a provider adapter declares (packages/integrations descriptors). */
  const declared = () => {
    const codes = new Set<string>();
    for (const file of sources(join(repo, 'packages', 'integrations', 'src'))) {
      for (const m of readFileSync(file, 'utf8').matchAll(/capabilities:\s*\[([^\]]*)\]/g)) {
        for (const c of m[1]!.matchAll(/'([a-z0-9_]+)'/g)) codes.add(c[1]!);
      }
    }
    return [...codes].sort();
  };

  it('labels every capability an adapter declares, in both languages (no raw codes on Integrations)', () => {
    const codes = declared();
    expect(codes.length).toBeGreaterThan(50);
    for (const c of codes) {
      expect(capabilityLabel(en, c), c).not.toBe(c);
      expect(capabilityLabel(ar, c), c).toMatch(/[؀-ۿ]/);
    }
  });

  it('shows provider names, not ids, and reconciliation outcomes as words', () => {
    expect(paymentProviderLabel(en, 'simulated')).toBe('Simulated provider');
    expect(paymentProviderLabel(ar, 'simulated')).toMatch(/[؀-ۿ]/);
    expect(paymentProviderLabel(ar, 'paymob')).toBe('Paymob');
    expect(paymentProviderLabel(en, 'some_new_psp')).toBe('Some new psp');
    expect(paymentProviderLabel(en, null)).toBe('—');
    for (const s of ['matched', 'missing_in_provider', 'missing_in_resuto', 'amount_mismatch', 'status_mismatch', 'cash_count']) {
      expect(reconStatusLabel(ar, s), s).toMatch(/[؀-ۿ]/);
    }
    expect(reconSourceLabel(ar, 'statement_upload')).toMatch(/[؀-ۿ]/);
  });

  it('words every provider country restriction in both languages (the API sends English only)', () => {
    const countries = new Set<string>();
    for (const file of sources(join(repo, 'packages', 'integrations', 'src'))) {
      for (const m of readFileSync(file, 'utf8').matchAll(/\{\s*country:\s*'([A-Z]{2})',\s*reason:/g)) countries.add(m[1]!);
    }
    expect(countries.size).toBeGreaterThan(0);
    const dict = integrations as unknown as Record<Locale, Record<string, string>>;
    for (const c of countries) {
      expect(formatMessage(dict.en[`intg.restricted.${c}`]!, 'en', { provider: 'Stripe' }), c).toMatch(/^Stripe does not list /);
      expect(formatMessage(dict.ar[`intg.restricted.${c}`]!, 'ar', { provider: 'Stripe' }), c).toMatch(/[؀-ۿ].*Stripe/);
    }
  });
});
