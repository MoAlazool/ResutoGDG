// PCL-11 guard: provider calls, storage writes and URL signing must not run inside a database transaction callback.
// A callback holds one of a few pooled connections for its whole duration and is re-run on 40001/40P01, so a network
// call inside it costs a connection for up to the call's timeout and can repeat a side effect. This test scans the
// API sources for transaction callbacks (db.scoped / withTenant / withMember / withPlatform, visits.withGuest) and
// fails when one contains such a call, except for the single-object staff paths listed below (known, bounded debt).
// A second check covers helpers: any function that receives a transaction (a `tx: Tx` parameter) must not make such a
// call either, so helpers that run inside a transaction take a MediaUrls collector and never resolve it (menu.service
// loadProducts / publicMenuFor, site-builder prepare / mediaMap); the caller resolves it after the transaction.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = path.resolve(__dirname, '../src');
const OPENERS = /\.(scoped|withTenant|withMember|withPlatform|withGuest)\(/g;
const FORBIDDEN: Array<[string, RegExp]> = [
  // messagingSandboxAdapter delivers locally (no network), so the sandbox send inside MessagingService.enqueue is fine.
  ['provider call', /\b(?!messagingSandboxAdapter\b)\w+Adapter\.(send|charge|refund|submitTemplate|createCampaign|launch)\(/],
  ['storage signing', /\bstorage\.signedUrls?\(/],
  ['storage upload', /\bstorage\.(store|put|writeVariants)\(/],
  ['raw fetch', /(?<![.\w])fetch\(/],
  // A MediaUrls collector resolved inside a transaction signs URLs there (Promise.resolve() is not a collector).
  ['URL batch resolve', /\b(?!Promise\b)\w+\.resolve\(\)/],
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

/** Blanks out comments (keeping line numbers), so prose that mentions a call is not mistaken for one. */
function withoutComments(src: string) {
  return src.replace(/\/\*[\s\S]*?\*\/|^\s*\/\/.*$/gm, (c) => c.replace(/[^\n]/g, ' '));
}

/** Index of the bracket that closes the one at `open`. */
function closing(src: string, open: number, o: string, c: string) {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === o) depth++;
    else if (src[i] === c && --depth === 0) return i;
  }
  return src.length - 1;
}

/**
 * Bodies of functions and methods declared with a `tx: Tx` parameter: the parameter list is followed by an optional
 * return type (whose own braces sit inside <...>) and then the body, or by `=>` and a body for arrow functions.
 */
function txFunctionBodies(src: string): Array<{ index: number; body: string }> {
  const out: Array<{ index: number; body: string }> = [];
  for (const m of src.matchAll(/\btx: Tx\b/g)) {
    // The "(" that opens this parameter list: walk back to the unmatched one.
    let depth = 0, open = -1;
    for (let i = m.index! - 1; i >= 0; i--) {
      if (src[i] === ')') depth++;
      else if (src[i] === '(') { if (depth === 0) { open = i; break; } depth--; }
    }
    if (open < 0) continue;
    let i = closing(src, open, '(', ')') + 1;
    let angle = 0;
    for (; i < src.length; i++) {
      if (src[i] === '=' && src[i + 1] === '>') { i++; continue; }
      if (src[i] === '<') angle++;
      else if (src[i] === '>') angle--;
      else if (src[i] === ';' && angle === 0) { i = -1; break; } // a declaration without a body (interface, type)
      else if (src[i] === '{' && angle === 0) break;
    }
    if (i < 0 || i >= src.length) continue;
    out.push({ index: m.index!, body: src.slice(i, closing(src, i, '{', '}') + 1) });
  }
  return out;
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

  it('finds none in helpers that receive a transaction (functions with a tx: Tx parameter)', () => {
    const violations: string[] = [];
    let scanned = 0;
    for (const file of files(SRC)) {
      const rel = path.relative(SRC, file).split(path.sep).join('/');
      if (rel.startsWith('common/db/')) continue;
      const src = withoutComments(readFileSync(file, 'utf8'));
      for (const { index, body } of txFunctionBodies(src)) {
        scanned++;
        for (const [kind, re] of FORBIDDEN) {
          if (re.test(body) && !(ALLOWED[rel] ?? []).includes(kind)) violations.push(`${rel}:${src.slice(0, index).split('\n').length} ${kind}`);
        }
      }
    }
    expect(scanned).toBeGreaterThan(100);
    expect(violations).toEqual([]);
  });

  it('the helper scan sees a signing call made through a helper', () => {
    const sample = `class X {
      async build(tx: Tx, id: string): Promise<{ a: string }> { const urls = this.storage.urls(); await urls.resolve(); return { a: '' }; }
      ok = async (tx: Tx) => { return tx.query('select 1'); };
      async other(tx: Tx) { await this.storage.signedUrl('p'); }
    }`;
    const hits = txFunctionBodies(sample).map(({ body }) => FORBIDDEN.filter(([, re]) => re.test(body)).map(([k]) => k));
    expect(hits).toEqual([['URL batch resolve'], [], ['storage signing']]);
  });
});
