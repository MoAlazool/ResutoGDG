import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// Runtime (non-type) imports of a TypeScript source: `import x from`, `import { … } from` and `export … from`.
const runtimeImports = (source: string) =>
  [...source.matchAll(/^(?:import|export)\s+(?!type\b)(?:[^'";]*?\sfrom\s+)?'([^']+)'/gm)].map((m) => m[1]!);

function reachable(file: string, seen = new Set<string>()): Set<string> {
  if (seen.has(file)) return seen;
  seen.add(file);
  for (const spec of runtimeImports(readFileSync(file, 'utf8'))) {
    if (spec.startsWith('.')) reachable(path.resolve(path.dirname(file), `${spec}.ts`), seen);
    else seen.add(spec);
  }
  return seen;
}

describe('@resuto/contracts/lite', () => {
  const graph = reachable(path.join(__dirname, 'lite.ts'));

  it('reaches no zod at runtime', () => {
    expect([...graph].filter((f) => !f.startsWith('/'))).toEqual([]);
  });

  it('re-exports the helpers guest pages use', async () => {
    const lite = await import('./lite');
    for (const name of ['formatNumber', 'formatMoney', 'parseMajor', 'INTL_LOCALE', 'toWesternDigits', 'normalizePhone', 'PHONE_EXAMPLE', 'planSplit', 'SplitRuleError', 'ASSISTANT_ALLERGENS', 'TABLE_FEATURES', 'SOCIAL_NETWORKS', 'socialLinksOf', 'checkSocialLink', 'slugProblem', 'RESERVED_SLUGS', 'ONBOARDING_STEPS', 'resumeStep', 'THEME_PRESET_IDS', 'MENU_QR_POSTERS', 'parseCsv', 'toCsv']) {
      expect(lite, name).toHaveProperty(name);
    }
  });
});
