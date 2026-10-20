import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { dictionaries } from './messages';

// VP-02: the Arabic brand name is ريسوتو (as in the original Resuto and its Arabic logo), never ريزوتو. The only
// legitimate ريزوتو is the dish "ريزوتو الفطر" (mushroom risotto) in the sample menus.
const MISSPELLED = /ريزوتو(?! الفطر)/;
const repo = join(__dirname, '..', '..', '..', '..');
const ROOTS = ['apps/web/app', 'apps/web/components', 'apps/web/lib', 'packages/contracts/src', 'packages/ui/src'];

function* files(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* files(p);
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\./.test(name)) yield p;
  }
}

describe('Arabic brand spelling (VP-02)', () => {
  it('dictionaries spell the brand ريسوتو', () => {
    expect(Object.entries(dictionaries.ar).filter(([, v]) => MISSPELLED.test(v)).map(([k]) => k)).toEqual([]);
    expect(dictionaries.ar['app.name']).toBe('ريسوتو');
  });

  it('no web or contracts source spells it ريزوتو', () => {
    const offenders: string[] = [];
    for (const root of ROOTS) for (const f of files(join(repo, root))) if (MISSPELLED.test(readFileSync(f, 'utf8'))) offenders.push(relative(repo, f));
    expect(offenders).toEqual([]);
  });
});
