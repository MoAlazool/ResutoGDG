import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

// Guard for the Western-digits policy (docs/ui/ARABIC_NUMERALS.md): Arabic pages use 0-9 for every system-formatted
// number. Formatting must go through @resuto/contracts (INTL_LOCALE / format helpers), never a raw Arabic locale tag,
// which would render Arabic-Indic digits (٠-٩).
const ROOTS = ['apps/web/app', 'apps/web/components', 'apps/web/lib', 'packages/ui/src', 'apps/api/src'];
/**
 * CR-04: digits also reach users through seeds, demo data, the MCP server, tools and the shared contracts. Text
 * ported from legacy/ (whose Arabic copy uses ٠-٩) must be converted to 0-9 when it is copied; this guard enforces it.
 */
const DATA_ROOTS = [...ROOTS, 'packages/contracts/src', 'packages/integrations/src', 'apps/mcp-server/src', 'scripts', 'supabase', 'tools'];
const repo = join(__dirname, '..', '..', '..');
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'coverage', '__pycache__']);

function* files(dir: string, ext = /\.(ts|tsx)$/): Generator<string> {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name) || name.startsWith('.')) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* files(p, ext);
    else if (ext.test(name) && !/\.test\.(tsx?|mjs|js)$/.test(name)) yield p;
  }
}
const SOURCE_AND_DATA = /\.(ts|tsx|mjs|cjs|js|sql|json)$/;
/** Comments, and the ٠-٩ / ۰-۹ ranges of the regexes that detect or normalise these digits. */
const stripAllowed = (src: string) => src.replace(/\/\*[\s\S]*?\*\/|\/\/.*$|^\s*--.*$/gm, '').replace(/٠-٩|۰-۹/g, '');

describe('Western digits policy', () => {
  it('no source file formats with a raw Arabic locale tag or the default browser locale', () => {
    const offenders: string[] = [];
    for (const root of ROOTS) {
      for (const f of files(join(repo, root))) {
        const src = readFileSync(f, 'utf8');
        const rel = relative(repo, f);
        for (const line of src.split('\n')) {
          if (/['"]ar-(EG|SA|AE)['"]/.test(line)) offenders.push(`${rel}: ${line.trim()}`);
          if (/toLocale(Date|Time)?String\(\s*\)/.test(line)) offenders.push(`${rel}: ${line.trim()}`);
          if (/(Intl\.(NumberFormat|DateTimeFormat)|toLocale(Date|Time)?String)\(\s*['"]ar['"]/.test(line)) offenders.push(`${rel}: ${line.trim()}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('no Eastern Arabic digits are hard-coded in source, dictionaries, seeds, demo data or tools', () => {
    const offenders: string[] = [];
    for (const root of DATA_ROOTS) {
      for (const f of files(join(repo, root), SOURCE_AND_DATA)) {
        const src = stripAllowed(readFileSync(f, 'utf8'));
        src.split('\n').forEach((line, i) => { if (/[٠-٩۰-۹]/.test(line)) offenders.push(`${relative(repo, f)}:${i + 1}: ${line.trim().slice(0, 120)}`); });
      }
    }
    expect(offenders).toEqual([]);
  });
});
