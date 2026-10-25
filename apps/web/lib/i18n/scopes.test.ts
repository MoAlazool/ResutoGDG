import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { dictionaries, inScope, messagesFor } from './messages';

// Guest routes receive only the guest message scope (lib/i18n/messages.ts GUEST_SCOPE). This test walks every guest
// route and the local modules it imports, collects the dictionary keys it can use (string literals that are keys,
// and `prefix.${…}` templates), and fails when one of them would be missing on a guest page.
const WEB = join(__dirname, '..', '..');
const GUEST_ROOTS = ['app/t', 'app/m', 'app/v', 'app/order', 'app/reserve', 'app/pay', 'app/s', 'app/o', 'app/l', 'app/r', 'app/pricing', 'app/page.tsx',
  'app/not-found.tsx', 'app/error.tsx', 'app/global-error.tsx'];
// The landing reads its own copy (platform.lp.*) from `dictionaries`, not from the scoped messages.
const LANDING_COPY = 'platform.lp.';
// Route groups with their own providers (StaffProviders) are not guest pages even when a guest file links to them.
const STAFF_DIRS = ['app/dashboard', 'app/kitchen', 'app/driver', 'app/admin', 'app/onboarding', 'app/invite', 'app/(auth)'];

function* walk(p: string): Generator<string> {
  if (!existsSync(p)) return;
  if (statSync(p).isDirectory()) { for (const n of readdirSync(p)) if (n !== 'node_modules') yield* walk(join(p, n)); }
  else if (/\.tsx?$/.test(p) && !/\.test\.tsx?$/.test(p)) yield p;
}
function resolveImport(from: string, spec: string): string | null {
  const base = spec.startsWith('@/') ? join(WEB, spec.slice(2)) : spec.startsWith('.') ? resolve(dirname(from), spec) : null;
  if (!base) return null;
  for (const c of [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts'), join(base, 'index.tsx')]) if (existsSync(c) && statSync(c).isFile()) return c;
  return null;
}

/** The route files under `roots` and every local module they import, stopping at other route groups' directories. */
function routeFiles(roots: string[], stopDirs: string[]): string[] {
  const seen = new Set<string>();
  const queue = roots.flatMap((r) => [...walk(join(WEB, r))]);
  while (queue.length) {
    const f = queue.pop()!;
    const rel = relative(WEB, f);
    if (seen.has(f) || rel.startsWith('lib/i18n/') || stopDirs.some((d) => rel.startsWith(d + '/'))) continue;
    seen.add(f);
    for (const m of readFileSync(f, 'utf8').matchAll(/(?:from|import)\s*\(?\s*'([^']+)'/g)) {
      const r = resolveImport(f, m[1]!);
      if (r) queue.push(r);
    }
  }
  return [...seen];
}
const guestFiles = () => routeFiles(GUEST_ROOTS, STAFF_DIRS);

/** Dictionary keys (literals) and key prefixes (`prefix.${…}` templates) a set of files can use. */
function usedKeys(files: string[]): Array<{ file: string; key?: string; prefix?: string }> {
  const out: Array<{ file: string; key?: string; prefix?: string }> = [];
  for (const f of files) {
    const src = readFileSync(f, 'utf8');
    for (const m of src.matchAll(/'([a-z][A-Za-z0-9]*(?:\.[A-Za-z0-9_-]+)+)'/g)) out.push({ file: relative(WEB, f), key: m[1]! });
    for (const m of src.matchAll(/`([a-z][A-Za-z0-9]*(?:\.[A-Za-z0-9_-]+)*\.)\$\{/g)) out.push({ file: relative(WEB, f), prefix: m[1]! });
  }
  return out;
}

describe('message scopes', () => {
  const en = dictionaries.en;
  const files = guestFiles();

  it('finds the guest routes', () => {
    expect(files.length).toBeGreaterThan(20);
  });

  it('every dictionary key a guest page can use is in the guest scope', () => {
    const missing: string[] = [];
    for (const f of files) {
      const src = readFileSync(f, 'utf8');
      for (const m of src.matchAll(/'([a-z][A-Za-z0-9]*(?:\.[A-Za-z0-9_-]+)+)'/g)) {
        const key = m[1]!;
        if (key in en && !key.startsWith(LANDING_COPY) && !inScope(key, 'guest')) missing.push(`${relative(WEB, f)}: ${key}`);
      }
      for (const m of src.matchAll(/`([a-z][A-Za-z0-9]*(?:\.[A-Za-z0-9_-]+)*\.)\$\{/g)) {
        const prefix = m[1]!;
        const keys = Object.keys(en).filter((k) => k.startsWith(prefix) && !k.startsWith(LANDING_COPY));
        for (const k of keys) if (!inScope(k, 'guest')) missing.push(`${relative(WEB, f)}: ${prefix}* (${k})`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('sign-in, sign-up and invitation pages get only the auth scope, and it covers what they use', () => {
    const AUTH_ROOTS = ['app/(auth)', 'app/invite'];
    const authFiles = routeFiles(AUTH_ROOTS, STAFF_DIRS.filter((d) => !AUTH_ROOTS.includes(d)));
    expect(authFiles.some((f) => f.endsWith('AuthForm.tsx'))).toBe(true);
    const ok = (k: string) => inScope(k, 'guest') || inScope(k, 'auth');
    const missing: string[] = [];
    for (const u of usedKeys(authFiles)) {
      if (u.key && u.key in en && !ok(u.key)) missing.push(`${u.file}: ${u.key}`);
      if (u.prefix) for (const k of Object.keys(en).filter((x) => x.startsWith(u.prefix!))) if (!ok(k)) missing.push(`${u.file}: ${u.prefix}* (${k})`);
    }
    expect(missing).toEqual([]);
    for (const locale of ['en', 'ar'] as const) {
      const a = messagesFor(locale, 'auth');
      const s = messagesFor(locale, 'staff');
      expect(Object.keys(a).every((k) => k in s)).toBe(true);
      // The point of the scope: the entry pages' HTML does not carry every module's copy (nor the wizard's).
      expect(JSON.stringify(a).length).toBeLessThan(JSON.stringify(s).length / 10);
      expect(Object.keys(a).some((k) => k.startsWith('onb.'))).toBe(false);
    }
    for (const l of ['app/(auth)/layout.tsx', 'app/invite/layout.tsx']) {
      expect(readFileSync(join(WEB, l), 'utf8')).toMatch(/<StaffProviders[^>]*scope="auth"/);
    }
  });

  it('the onboarding wizard gets the auth copy plus its own (onboarding scope), and it covers what the wizard uses', () => {
    const ROOTS = ['app/onboarding'];
    const files = routeFiles(ROOTS, STAFF_DIRS.filter((d) => !ROOTS.includes(d)));
    expect(files.some((f) => f.includes('/onboarding/'))).toBe(true);
    const ok = (k: string) => inScope(k, 'guest') || inScope(k, 'onboarding');
    const missing: string[] = [];
    for (const u of usedKeys(files)) {
      if (u.key && u.key in en && !ok(u.key)) missing.push(`${u.file}: ${u.key}`);
      if (u.prefix) for (const k of Object.keys(en).filter((x) => x.startsWith(u.prefix!))) if (!ok(k)) missing.push(`${u.file}: ${u.prefix}* (${k})`);
    }
    expect(missing).toEqual([]);
    for (const locale of ['en', 'ar'] as const) {
      const o = messagesFor(locale, 'onboarding');
      const s = messagesFor(locale, 'staff');
      expect(Object.keys(o).every((k) => k in s)).toBe(true);
      expect(Object.keys(messagesFor(locale, 'auth')).every((k) => k in o)).toBe(true);
      expect(JSON.stringify(o).length).toBeLessThan(JSON.stringify(s).length / 5);
    }
    // Every wizard key exists in both languages.
    const ar = dictionaries.ar;
    expect(Object.keys(en).filter((k) => k.startsWith('onb.') && !(k in ar))).toEqual([]);
    expect(Object.keys(ar).filter((k) => k.startsWith('onb.') && !(k in en))).toEqual([]);
    expect(readFileSync(join(WEB, 'app/onboarding/layout.tsx'), 'utf8')).toMatch(/<StaffProviders[^>]*scope="onboarding"/);
  });

  it('guest and staff scopes are disjoint and together cover every key except the landing copy', () => {
    for (const locale of ['en', 'ar'] as const) {
      const g = messagesFor(locale, 'guest');
      const s = messagesFor(locale, 'staff');
      expect(Object.keys(g).filter((k) => k in s)).toEqual([]);
      const all = Object.keys(dictionaries.en).filter((k) => !k.startsWith('platform.lp.'));
      expect(all.filter((k) => !(k in g) && !(k in s))).toEqual([]);
    }
  });

  it('applies English fallbacks inside one locale and keeps the guest scope small', () => {
    const ar = messagesFor('ar', 'guest');
    for (const k of Object.keys(messagesFor('en', 'guest'))) expect(typeof ar[k]).toBe('string');
    expect(JSON.stringify(ar).length).toBeLessThan(60_000);
  });
});
