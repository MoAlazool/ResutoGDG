import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { dictionaries, familyOf, inScope, messagesFor, routeMessages } from './messages';
import { ROUTE_FAMILIES, type RouteScope } from './route-families';
import { computeRouteFamilies, DASHBOARD, moduleDirs, renderRouteFamilies, routeRoots, runtimeClosure, WEB } from './scope-analysis';

// Staff screens get only the message families their own source can use (21-PERF): the dashboard shell's in
// app/dashboard/layout.tsx, each module's in its directory layout, the overview's in its page. Before, every staff
// document carried every module's copy (~300 KB of text, 110-130 kB gzip per document).
const FILE = join(__dirname, 'route-families.ts');

describe('route message scopes', () => {
  const computed = computeRouteFamilies();

  it('lib/i18n/route-families.ts is generated from the current sources', () => {
    const want = renderRouteFamilies(computed);
    if (process.env.UPDATE_ROUTE_FAMILIES === '1') writeFileSync(FILE, want);
    // Out of date: run UPDATE_ROUTE_FAMILIES=1 pnpm --filter @resuto/web exec vitest run lib/i18n/route-scopes.test.ts
    expect(readFileSync(FILE, 'utf8')).toBe(want);
  });

  it('every module directory, the overview and the staff route groups provide their scope', () => {
    for (const m of moduleDirs()) {
      const layout = join(WEB, DASHBOARD, m, 'layout.tsx');
      expect(existsSync(layout), `${m}/layout.tsx`).toBe(true);
      expect(readFileSync(layout, 'utf8'), m).toMatch(new RegExp(`<RouteMessages route="dashboard/${m}">`));
    }
    expect(readFileSync(join(WEB, DASHBOARD, 'page.tsx'), 'utf8')).toMatch(/<RouteMessages route="dashboard\/home">/);
    expect(readFileSync(join(WEB, 'app/dashboard/layout.tsx'), 'utf8')).toMatch(/<StaffProviders route="dashboard">/);
    expect(readFileSync(join(WEB, 'app/kitchen/layout.tsx'), 'utf8')).toMatch(/<StaffProviders route="kitchen">/);
    expect(readFileSync(join(WEB, 'app/driver/layout.tsx'), 'utf8')).toMatch(/<StaffProviders route="driver">/);
  });

  it('every file directly in the restaurant workspace belongs to a route scope', () => {
    const roots = new Set(Object.values(routeRoots()).flat());
    const loose = readdirSync(join(WEB, DASHBOARD)).filter((n) => statSync(join(WEB, DASHBOARD, n)).isFile() && /\.tsx?$/.test(n) && !/\.test\./.test(n));
    expect(loose.filter((n) => !roots.has(`${DASHBOARD}/${n}`))).toEqual([]);
  });

  it('every literal key and key prefix a staff route uses is in its documents', () => {
    const en = dictionaries.en;
    const missing: string[] = [];
    for (const [route, roots] of Object.entries(routeRoots())) {
      const shipped = (k: string) => inScope(k, 'base') || familiesOf('dashboard').has(familyOf(k)) && route.startsWith('dashboard')
        || familiesOf(route as RouteScope).has(familyOf(k));
      for (const file of runtimeClosure(roots)) {
        const src = readFileSync(join(WEB, file), 'utf8');
        for (const m of src.matchAll(/['"`]([a-z][A-Za-z0-9]*(?:\.[A-Za-z0-9_-]+)+)['"`]/g)) {
          const key = m[1]!;
          if (key in en && !key.startsWith('platform.lp.') && !shipped(key)) missing.push(`${route} ${file}: ${key}`);
        }
        for (const m of src.matchAll(/`([a-z][A-Za-z0-9]*(?:\.[A-Za-z0-9_-]+)*\.)\$\{/g)) {
          for (const k of Object.keys(en).filter((x) => x.startsWith(m[1]!) && !x.startsWith('platform.lp.'))) {
            if (!shipped(k)) missing.push(`${route} ${file}: ${m[1]}* (${k})`);
          }
        }
      }
    }
    expect(missing).toEqual([]);
  });

  it('a module ships only what the shell does not, and much less than the whole staff copy', () => {
    for (const locale of ['en', 'ar'] as const) {
      const staff = JSON.stringify(messagesFor(locale, 'staff')).length;
      const shell = routeMessages(locale, 'dashboard');
      expect(JSON.stringify(shell).length).toBeLessThan(staff / 5);
      for (const route of Object.keys(ROUTE_FAMILIES) as RouteScope[]) {
        if (!route.startsWith('dashboard/')) continue;
        const own = routeMessages(locale, route);
        expect(Object.keys(own).filter((k) => k in shell), route).toEqual([]);
        expect(JSON.stringify(own).length, route).toBeLessThan(staff / 3);
      }
    }
  });
});

const familiesOf = (route: RouteScope) => new Set<string>(ROUTE_FAMILIES[route]);
