import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
// @ts-expect-error plain ESM script without type declarations
import { BASELINE, countInlineStyles } from '../../../scripts/ui/inline-styles.mjs';

// VS-31 / REM-W11: dashboard and admin pages use shared components, page stylesheets and the utility classes in
// app/globals.css instead of one-off inline styles. Inline styles that remain (run-time geometry, a few legacy
// layouts) are counted per file and may only go down.
describe('inline style ratchet (dashboard and admin)', () => {
  const baseline: Record<string, number> = JSON.parse(readFileSync(BASELINE, 'utf8')).files;
  const now: Record<string, number> = countInlineStyles();

  it('no file gains inline styles (use a component, a utility class or the page stylesheet)', () => {
    const grew = Object.entries(now).filter(([f, n]) => n > (baseline[f] ?? 0)).map(([f, n]) => `${f}: ${baseline[f] ?? 0} → ${n}`);
    expect(grew).toEqual([]);
  });

  it('the baseline is tightened whenever a file improves (run node scripts/ui/inline-styles.mjs --write)', () => {
    const loose = Object.entries(baseline).filter(([f, n]) => (now[f] ?? 0) < n).map(([f, n]) => `${f}: baseline ${n}, now ${now[f] ?? 0}`);
    expect(loose).toEqual([]);
  });

  it('keeps the migration: well under the 638 dashboard inline styles counted before REM-W11', () => {
    const total = Object.entries(now).filter(([f]) => f.startsWith('apps/web/app/dashboard/')).reduce((a, [, n]) => a + n, 0);
    expect(total).toBeLessThanOrEqual(256);
  });
});
