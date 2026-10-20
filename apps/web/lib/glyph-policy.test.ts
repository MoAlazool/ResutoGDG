import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

// VS-03: staff screens use the legacy monochrome glyph family (packages/ui NAV_GLYPHS: ◈ ▦ ▤ ☷ ⇄ ¤ …, rendered in
// currentColor), never colour emoji, which look like a different product and render differently per platform.
const ROOTS = ['apps/web/app/dashboard', 'apps/web/app/kitchen', 'apps/web/app/driver', 'apps/web/app/admin', 'apps/web/components/shell',
  'apps/web/lib/nav.ts', 'packages/ui/src'];
const repo = join(__dirname, '..', '..', '..');
/** Pictographs, emoticons, transport/map symbols and the clock/stopwatch emoji (U+23F0-23F3). */
const EMOJI = /[\u{1F300}-\u{1FAFF}\u{23F0}-\u{23F3}]/u;

function* files(p: string): Generator<string> {
  if (statSync(p).isFile()) { yield p; return; }
  for (const name of readdirSync(p)) {
    const q = join(p, name);
    if (statSync(q).isDirectory()) yield* files(q);
    else if (/\.(tsx?|css)$/.test(name) && !/\.test\./.test(name)) yield q;
  }
}

describe('monochrome glyphs on staff screens (VS-03)', () => {
  it('no colour emoji in staff sources', () => {
    const offenders: string[] = [];
    for (const root of ROOTS) {
      for (const f of files(join(repo, root))) {
        readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
          if (EMOJI.test(line)) offenders.push(`${relative(repo, f)}:${i + 1}: ${line.trim().slice(0, 100)}`);
        });
      }
    }
    expect(offenders).toEqual([]);
  });
});
