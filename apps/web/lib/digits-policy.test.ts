import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

// Guard for the Western-digits policy (docs/ui/ARABIC_NUMERALS.md): Arabic pages use 0-9 for every system-formatted
// number. Formatting must go through @resuto/contracts (INTL_LOCALE / format helpers), never a raw Arabic locale tag,
// which would render Arabic-Indic digits (٠-٩).
const ROOTS = ['apps/web/app', 'apps/web/components', 'apps/web/lib', 'packages/ui/src', 'apps/api/src'];
const repo = join(__dirname, '..', '..', '..');

function* files(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* files(p);
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) yield p;
  }
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

  it('no Eastern Arabic digits are hard-coded in source or dictionaries', () => {
    const offenders: string[] = [];
    for (const root of ROOTS) {
      for (const f of files(join(repo, root))) {
        if (/[٠-٩۰-۹]/.test(readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, ''))) offenders.push(relative(repo, f));
      }
    }
    expect(offenders).toEqual([]);
  });
});
