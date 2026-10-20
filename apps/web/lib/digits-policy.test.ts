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
/**
 * What may mention these digits: comments that start a line (`//`, `/* … *\/` blocks, SQL `--`), and the ٠-٩ / ۰-۹
 * ranges inside the `[…]` character classes that detect or normalise them. Everything else is checked, including
 * code that follows a string holding `//` (a URL) and comments that trail code on the same line, so a string literal
 * can never be hidden by being mistaken for a comment. Lines keep their numbers (stripped lines become empty).
 */
export function stripAllowed(src: string): string {
  let inBlock = false;
  return src.split('\n').map((line) => {
    let rest = line;
    if (inBlock) {
      const end = rest.indexOf('*/');
      if (end < 0) return '';
      inBlock = false;
      rest = rest.slice(end + 2);
    }
    const t = rest.trimStart();
    if (t.startsWith('//') || t.startsWith('--')) return '';
    if (t.startsWith('/*')) {
      const end = t.indexOf('*/', 2);
      if (end < 0) { inBlock = true; return ''; }
      rest = t.slice(end + 2);
    }
    return rest.replace(/\[(?:[^\]\n\\]|\\.)*\]/g, (cls) => cls.replace(/٠-٩|۰-۹/g, ''));
  }).join('\n');
}

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

  it('the comment and regex allowance cannot hide a string literal', () => {
    const flagged = (src: string) => /[٠-٩۰-۹]/.test(stripAllowed(src));
    // Review finding: a URL's `//` used to start a "comment" that swallowed the rest of the line.
    expect(flagged("const link = 'https://resuto.app/menu'; const promo = 'خصم ١٠٪';")).toBe(true);
    expect(flagged("const promo = 'خصم ١٠٪'; // promo")).toBe(true);
    expect(flagged("const range = 'أرقام ٠-٩ فقط';")).toBe(true);
    expect(flagged('/* ١٠ */ const x = "٣";')).toBe(true);
    expect(flagged('// Arabic keyboards type ٠١٢…\nconst ok = 1;')).toBe(false);
    expect(flagged('/**\n * Normalises ٠-٩ and ۰-۹ digits\n */\nconst re = /[٠-٩۰-۹]/g;')).toBe(false);
    expect(flagged("-- seed note ١٢\nINSERT INTO t VALUES ('10%');")).toBe(false);
    expect(stripAllowed('a\n/*\n x ١\n*/ b\nc').split('\n')).toEqual(['a', '', '', ' b', 'c']);
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
