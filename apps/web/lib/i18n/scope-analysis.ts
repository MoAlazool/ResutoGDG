// Static analysis behind the per-route message scopes (lib/i18n/route-scopes.ts). Node only: tests and the scope
// generator import it, application code never does.
//
// A route's message families are found conservatively from its source: every file the route can load at run time
// (its route files and the local modules they import, `import()` included, `import type` excluded) is scanned for
// dotted tokens ('core.orders.subtitle', `pay.alert.action.${…}`, 'core.status' passed as a prefix, a comment naming a
// key), and each token keeps the family it names. A family is a key without its last segment, capped at two segments:
// 'core.orders.subtitle' -> 'core.orders', 'nav.orders' -> 'nav', 'pay.alert.action.refund' -> 'pay.alert'. So a key
// built at run time inside a family the route mentions is covered, and over-inclusion (a variable that happens to be
// called `nav.`) only costs bytes, never a missing string.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

import { dictionaries, familyOf } from './messages';

export const WEB = join(__dirname, '..', '..');

function* walk(p: string): Generator<string> {
  if (!existsSync(p)) return;
  if (statSync(p).isDirectory()) { for (const n of readdirSync(p).sort()) if (n !== 'node_modules') yield* walk(join(p, n)); }
  else if (/\.tsx?$/.test(p) && !/\.test\.tsx?$/.test(p)) yield p;
}

function resolveImport(from: string, spec: string): string | null {
  const base = spec.startsWith('@/') ? join(WEB, spec.slice(2)) : spec.startsWith('.') ? resolve(dirname(from), spec) : null;
  if (!base) return null;
  for (const c of [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts'), join(base, 'index.tsx')]) if (existsSync(c) && statSync(c).isFile()) return c;
  return null;
}

const source = new Map<string, string>();
const read = (f: string) => {
  let s = source.get(f);
  if (s === undefined) { s = readFileSync(f, 'utf8'); source.set(f, s); }
  return s;
};

/**
 * The files under `roots` (directories or files, relative to apps/web) and every local module they import at run time,
 * wherever it lives (a module screen that renders another module's component, or the restaurant site in the website
 * editor, runs that code under its own scope). lib/i18n itself is skipped.
 */
export function runtimeClosure(roots: string[]): string[] {
  const seen = new Set<string>();
  const queue = roots.flatMap((r) => [...walk(join(WEB, r))]);
  while (queue.length) {
    const f = queue.pop()!;
    const rel = relative(WEB, f);
    if (seen.has(f) || rel.startsWith('lib/i18n/')) continue;
    seen.add(f);
    const src = read(f).replace(/^\s*(?:import|export)\s+type\s[^;]*?from\s*'[^']+';?/gm, '');
    for (const m of src.matchAll(/(?:from|import)\s*\(?\s*'([^']+)'/g)) {
      const r = resolveImport(f, m[1]!);
      if (r) queue.push(r);
    }
  }
  return [...seen].map((f) => relative(WEB, f)).sort();
}

// Dotted tokens: 'a.b', 'a.b.c', and a quoted bare 'a.' followed by a quote, `${` or `+` (a key prefix built at run
// time: 'role.' + x, `role.${x}`). English prose ("cannot pay.'") is not a prefix: the word is not right after a quote.
const TOKEN = /(?<![\w$-])([a-z][A-Za-z0-9]*(?:\.[A-Za-z0-9_-]+)+)|(?<=['"`])([a-z][A-Za-z0-9]*\.)(?=['"`$+])/g;

/** The message families the given files can use, among `families` (every family of the dictionaries). */
export function familiesUsed(files: string[], families: ReadonlySet<string>): Set<string> {
  const byNamespace = new Map<string, string[]>();
  for (const f of families) {
    const ns = f.split('.')[0]!;
    byNamespace.set(ns, [...(byNamespace.get(ns) ?? []), f]);
  }
  const out = new Set<string>();
  for (const file of files) {
    for (const m of read(join(WEB, file)).matchAll(TOKEN)) {
      const token = (m[1] ?? m[2])!;
      if (token.endsWith('.')) {
        // 'role.' + x / `role.${x}`: every family of the namespace.
        for (const f of byNamespace.get(token.slice(0, -1)) ?? []) out.add(f);
        continue;
      }
      const fam = familyOf(token);
      if (families.has(fam)) out.add(fam);
      // A family named as a prefix argument ('core.status', 'insights.c360.kind').
      const asPrefix = token.split('.').slice(0, 2).join('.');
      if (families.has(asPrefix)) out.add(asPrefix);
      if (families.has(token)) out.add(token);
    }
  }
  return out;
}

/** Every message family of the dictionaries (both languages). */
export const allFamilies = (): Set<string> => new Set([...Object.keys(dictionaries.en), ...Object.keys(dictionaries.ar)].map(familyOf));

export const DASHBOARD = 'app/dashboard/[orgId]';
/** The module directories under the restaurant workspace: each one has a layout with its own route scope. */
export const moduleDirs = (): string[] =>
  readdirSync(join(WEB, DASHBOARD)).filter((n) => !n.startsWith('_') && !n.startsWith('(') && statSync(join(WEB, DASHBOARD, n)).isDirectory()).sort();

/**
 * The staff route scopes and the source each one is computed from. 'dashboard' is the shell (StaffProviders in
 * app/dashboard/layout.tsx: the workspace chrome, the restaurant picker, OAuth and MCP consent pages, the area loading
 * and error states); 'dashboard/<module>' is each module directory's layout; 'dashboard/home' the overview page.
 */
export function routeRoots(): Record<string, string[]> {
  const out: Record<string, string[]> = {
    dashboard: ['app/dashboard/layout.tsx', 'app/dashboard/page.tsx', 'app/dashboard/mcp-authorize', 'app/dashboard/oauth',
      `${DASHBOARD}/layout.tsx`, `${DASHBOARD}/loading.tsx`, `${DASHBOARD}/error.tsx`],
    'dashboard/home': [`${DASHBOARD}/page.tsx`, `${DASHBOARD}/_home`],
    kitchen: ['app/kitchen'],
    driver: ['app/driver'],
  };
  for (const m of moduleDirs()) out[`dashboard/${m}`] = [`${DASHBOARD}/${m}`];
  return out;
}

/** Families per route scope, sorted: the content of lib/i18n/route-families.ts. */
export function computeRouteFamilies(): Record<string, string[]> {
  const families = allFamilies();
  const out: Record<string, string[]> = {};
  for (const [route, roots] of Object.entries(routeRoots())) out[route] = [...familiesUsed(runtimeClosure(roots), families)].sort();
  return out;
}

export function renderRouteFamilies(data: Record<string, string[]>): string {
  const body = Object.keys(data).sort().map((r) => `  '${r}': [${data[r]!.map((f) => `'${f}'`).join(', ')}],`).join('\n');
  return `// Generated from the route sources by lib/i18n/route-scopes.test.ts; do not edit. After changing a staff screen's copy or
// imports, regenerate with: UPDATE_ROUTE_FAMILIES=1 pnpm --filter @resuto/web exec vitest run lib/i18n/route-scopes.test.ts
// The message families (lib/i18n/messages.ts familyOf) each staff route can use (lib/i18n/scope-analysis.ts).
export const ROUTE_FAMILIES = {
${body}
} as const satisfies Record<string, readonly string[]>;
export type RouteScope = keyof typeof ROUTE_FAMILIES;
`;
}
