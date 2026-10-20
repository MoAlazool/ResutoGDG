// PCL-11 guard: provider calls, storage writes and URL signing must not run inside a database transaction callback.
// A callback holds one of a few pooled connections for its whole duration and is re-run on 40001/40P01, so a network
// call inside it costs a connection for up to the call's timeout and can repeat a side effect. This test scans the
// API sources for transaction callbacks (db.scoped / withTenant / withMember / withPlatform, visits.withGuest) and
// fails when one contains such a call, except for the single-object staff paths listed below (known, bounded debt).
// It sees calls written inside the callback text, not calls made through helper methods: helpers that run inside a
// transaction take a MediaUrls collector instead of signing (menu.service loadProducts / publicMenuFor).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = path.resolve(__dirname, '../src');
const OPENERS = /\.(scoped|withTenant|withMember|withPlatform|withGuest)\(/g;
const FORBIDDEN: Array<[string, RegExp]> = [
  ['provider call', /\b\w+Adapter\.(send|charge|refund|submitTemplate|createCampaign|launch)\(/],
  ['storage signing', /\bstorage\.signedUrls?\(/],
  ['storage upload', /\bstorage\.(store|put|writeVariants)\(/],
  ['raw fetch', /(?<![.\w])fetch\(/],
];
/**
 * Known single-object exceptions (file → kinds allowed): one upload or one short-lived signature on a staff action,
 * not a list or a guest path. Shrink this list; never grow it for list endpoints or guest routes.
 */
const ALLOWED: Record<string, string[]> = {
  'modules/delivery/driver-app.service.ts': ['storage upload', 'storage signing'],
  'modules/delivery/delivery.service.ts': ['storage signing'],
  'modules/compliance/licences.service.ts': ['storage upload', 'storage signing'],
  'modules/finance/expenses.service.ts': ['storage upload'],
};

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = path.join(dir, f);
    return statSync(p).isDirectory() ? files(p) : p.endsWith('.ts') && !p.endsWith('.test.ts') ? [p] : [];
  });
}

/** Text of the argument list that starts at `open` (the index of "("), by bracket depth. */
function argumentText(src: string, open: number) {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === '(') depth++;
    else if (c === ')' && --depth === 0) return src.slice(open, i + 1);
  }
  return src.slice(open);
}

describe('transaction callbacks have no external side effects (PCL-11)', () => {
  it('finds no provider call, upload or URL signing inside a transaction outside the allowed list', () => {
    const violations: string[] = [];
    let scanned = 0;
    for (const file of files(SRC)) {
      const rel = path.relative(SRC, file).split(path.sep).join('/');
      if (rel.startsWith('common/db/')) continue;
      const src = readFileSync(file, 'utf8');
      for (const m of src.matchAll(OPENERS)) {
        scanned++;
        const body = argumentText(src, m.index! + m[0].length - 1);
        for (const [kind, re] of FORBIDDEN) {
          if (re.test(body) && !(ALLOWED[rel] ?? []).includes(kind)) {
            violations.push(`${rel}:${src.slice(0, m.index).split('\n').length} ${kind}`);
          }
        }
      }
    }
    expect(scanned).toBeGreaterThan(200);
    expect(violations).toEqual([]);
  });
});
