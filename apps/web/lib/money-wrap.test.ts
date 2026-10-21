import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { formatMoney, hasEasternDigits } from '@resuto/contracts';
import { describe, expect, it } from 'vitest';
import { money } from './format';

// PAR-06 guard: a money value is one unit. The amount and its currency ("7,420 ج.م.", "EGP 7,420") must never wrap
// apart in a narrow KPI tile: the formatter joins them with a no-break space, and a KPI figure never breaks (it scales
// down instead). The layout itself is checked in Chromium by lib/kpi-values.test.ts.
// Every space a line may break at (not U+00A0 / U+202F, the no-break spaces).
const BREAKABLE = new RegExp('[\\t\\n\\r \\u1680\\u2000-\\u200a\\u2028\\u2029\\u205f\\u3000]');

describe('money values never wrap (PAR-06)', () => {
  it('joins amount and currency with a no-break space, Western digits, in both languages', () => {
    for (const currency of ['EGP', 'SAR'] as const) for (const locale of ['en', 'ar'] as const) {
      for (const minor of [0, 4500, 742000, 1234567, 98765432, 14500]) {
        for (const s of [formatMoney(minor, currency, locale), formatMoney(minor, currency, locale, { decimals: 'always' }), money(minor, currency, locale)]) {
          expect(BREAKABLE.test(s), `${JSON.stringify(s)} has a breakable space`).toBe(false);
          expect(hasEasternDigits(s)).toBe(false);
        }
      }
    }
  });

  it('KPI figures never break inside a value and scale with the tile; text values still wrap', () => {
    const css = readFileSync(join(__dirname, '..', 'app', 'globals.css'), 'utf8');
    const rule = (sel: string) => css.split('\n').find((l) => l.startsWith(`${sel} {`)) ?? '';
    // Only figures (.is-fig, set by Stat/StatsStrip) are held on one line; a date or a sentence wraps (review of PAR-06).
    expect(rule(':is(.stat strong, .stats-value).is-fig')).toMatch(/white-space:\s*nowrap/);
    for (const sel of ['.stats-value', '.stat strong']) {
      expect(rule(sel), sel).not.toMatch(/white-space:\s*nowrap|text-overflow/);
      expect(rule(sel), sel).not.toMatch(/overflow-wrap:\s*anywhere/);
      expect(rule(sel), sel).toMatch(/calc\(\d+cqi \/ var\(--chars, 1\)\)/);
    }
    expect(rule('.stats-value')).toMatch(/font-size:\s*min\(\d+px,\s*\d+cqi/);
    expect(css).toMatch(/\.stats-cell \{[^}]*container-type:\s*inline-size/);
  });
});
