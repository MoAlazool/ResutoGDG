// REM-A07 (FT-15 / DF-15 / VS-21 remainder): the integrations catalogue sends activation steps with i18n keys
// (intg.activation.<provider>.<n>, connections.service catalog()); a key missing from the web dictionaries makes the
// Arabic page fall back to the API's English text. meta_pages, meta_capi and nine others had no entries, and the
// Twilio keys had drifted (the adapter gained a step, so steps 3 and 4 showed the wrong text in both languages).
// This test reads the web dictionaries as text (the API does not import web code) and checks every key the catalogue
// can emit has an English entry for the same step as the adapter's text and a non-empty Arabic entry.
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { catalogEntries } from '../src/modules/integrations/catalog';
import { isInsightTemplateKey, renderInsight } from '@resuto/contracts';

const DICT = path.resolve(__dirname, '../../web/lib/i18n/dict');
const files = readdirSync(DICT).filter((f) => f.endsWith('.ts')).map((f) => readFileSync(path.join(DICT, f), 'utf8'));
const unquote = (s: string) => s.replace(/\\'/g, '\'').replace(/\\\\/g, '\\');

/** Every value written for a key across the dictionaries, in file order (each file: the `en` block, then `ar`). */
function entries(key: string): { en: string[]; ar: string[] } {
  const out = { en: [] as string[], ar: [] as string[] };
  const re = new RegExp(`'${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}':\\s*'((?:[^'\\\\]|\\\\.)*)'`, 'g');
  for (const text of files) {
    const arStart = text.search(/^\s{2}ar:\s*\{/m);
    for (const m of text.matchAll(re)) (arStart >= 0 && m.index! > arStart ? out.ar : out.en).push(unquote(m[1]!));
  }
  return out;
}

/**
 * Share of the adapter step's words that the dictionary entry also uses. The UI copy may be edited (typographic quotes,
 * "here" instead of "in Integrations"), but an entry for another step (the Twilio drift) shares few words.
 */
function overlap(entry: string, adapter: string): number {
  const words = (s: string) => new Set(s.toLowerCase().normalize('NFKC').replace(/[“”‘’]/g, "'").split(/[^a-z0-9_]+/).filter((w) => w.length > 3));
  const a = words(adapter), e = words(entry);
  if (!a.size) return 1;
  return [...a].filter((w) => e.has(w)).length / a.size;
}

describe('activation steps are translated', () => {
  const steps = catalogEntries().flatMap((e) => e.activation.map((text, i) => ({ key: `intg.activation.${e.id}.${i + 1}`, text })));

  it('the catalogue emits activation steps', () => {
    expect(steps.length).toBeGreaterThan(80);
    expect(steps.some((s) => s.key === 'intg.activation.meta_pages.1')).toBe(true);
    expect(steps.some((s) => s.key === 'intg.activation.meta_capi.5')).toBe(true);
  });

  it('every emitted key has one English entry for the same step and one Arabic entry (Western digits)', () => {
    const problems: string[] = [];
    for (const { key, text } of steps) {
      const { en, ar } = entries(key);
      if (en.length !== 1) problems.push(`${key}: ${en.length} English entries`);
      else if (overlap(en[0]!, text) < 0.5) problems.push(`${key}: the English entry describes another step (overlap ${overlap(en[0]!, text).toFixed(2)})\n    dict:    ${en[0]}\n    adapter: ${text}`);
      if (ar.length !== 1 || !ar[0]!.trim()) problems.push(`${key}: ${ar.length} Arabic entries`);
      else if (!/[؀-ۿ]/.test(ar[0]!)) problems.push(`${key}: Arabic entry has no Arabic text`);
      else if (/[٠-٩۰-۹]/.test(ar[0]!)) problems.push(`${key}: Arabic entry uses Arabic-Indic digits`);
    }
    expect(problems, problems.join('\n')).toEqual([]);
  });
});

describe('insight templates', () => {
  it('every template the producers use renders in both languages', () => {
    // The producers' template keys are typed (InsightTemplateKey); this guards the renderer side for each key.
    for (const key of ['revenue_drop', 'item_spike', 'item_drop', 'stock_sold_out', 'stock_cover_low', 'low_stock', 'slow_kitchen',
      'inactive_valuable', 'demand_rise', 'demand_fall', 'churn_high']) {
      expect(isInsightTemplateKey(key)).toBe(true);
      expect(renderInsight(key, {}, 'ar')?.title).toMatch(/[؀-ۿ]/);
    }
  });
});
