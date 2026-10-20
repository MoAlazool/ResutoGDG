import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
// @ts-expect-error plain ESM script without type declarations
import { BASELINE, countHexLiterals } from '../../../scripts/ui/hex-literals.mjs';
// @ts-expect-error plain ESM script without type declarations
import { renderTokens, SOURCE, TARGET } from '../../../scripts/ui/build-tokens.mjs';

// VS-01 token policy: docs/ui/design-tokens.json is the single source of design tokens; scripts/ui/build-tokens.mjs
// generates packages/ui/src/tokens.css from it, and apps/web uses var(--…) instead of new hex colours.
describe('design token policy', () => {
  it('packages/ui/src/tokens.css is generated from docs/ui/design-tokens.json (run node scripts/ui/build-tokens.mjs)', () => {
    expect(readFileSync(TARGET, 'utf8')).toBe(renderTokens(JSON.parse(readFileSync(SOURCE, 'utf8'))));
  });

  it('no file gains hex colour literals (add a token to docs/ui/design-tokens.json instead)', () => {
    const baseline: Record<string, number> = JSON.parse(readFileSync(BASELINE, 'utf8')).files;
    const now: Record<string, number> = countHexLiterals();
    const grew = Object.entries(now)
      .filter(([f, n]) => n > (baseline[f] ?? 0))
      .map(([f, n]) => `${f}: ${baseline[f] ?? 0} → ${n}`);
    expect(grew).toEqual([]);
  });

  it('the baseline is tightened whenever a file improves (run node scripts/ui/hex-literals.mjs --write)', () => {
    const baseline: Record<string, number> = JSON.parse(readFileSync(BASELINE, 'utf8')).files;
    const now: Record<string, number> = countHexLiterals();
    const loose = Object.entries(baseline)
      .filter(([f, n]) => (now[f] ?? 0) < n)
      .map(([f, n]) => `${f}: baseline ${n}, now ${now[f] ?? 0}`);
    expect(loose).toEqual([]);
  });

  it('the workspace tokens are not shadowed by the landing scope', () => {
    const landing = readFileSync(`${__dirname}/../components/landing/landing.css`, 'utf8');
    expect(landing).not.toMatch(/--(ink|paper|muted|line|card|sand)(-[a-z0-9]+)?\s*:/);
  });
});
