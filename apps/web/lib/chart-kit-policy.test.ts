import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

// 21-INSIGHTS (plan §4/§5, docs/ui/DESIGN_SYSTEM.md §5): one chart kit, packages/ui/src/charts. Every chart a page
// draws is imported from '@resuto/ui' (or, inside packages/ui, from its charts modules); the two former kits
// (apps/web/components/charts and intelligence/_components/charts) are gone and no page defines a chart of its own.
const repo = join(__dirname, '..', '..', '..');
const KIT = 'packages/ui/src/charts';
const ROOTS = ['apps/web/app', 'apps/web/components', 'apps/web/lib', 'packages/ui/src'];

/** The kit's chart components and chart helpers (what a page could otherwise copy or import from elsewhere). */
export const CHART_NAMES = ['LineChart', 'AreaChart', 'BarChart', 'BarList', 'DonutChart', 'FunnelChart', 'Heatmap', 'CohortHeatmap', 'Sparkline', 'ForecastChart', 'RouteMap',
  'SeriesLegend', 'ChartLegend', 'ChartTable', 'Legend', 'RouteStop', 'projectRoute', 'niceScale', 'chartColor', 'CHART_COLORS'];

function* files(p: string): Generator<string> {
  if (!existsSync(p)) return;
  if (statSync(p).isFile()) { yield p; return; }
  for (const name of readdirSync(p)) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const q = join(p, name);
    if (statSync(q).isDirectory()) yield* files(q);
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) && !/\.d\.ts$/.test(name)) yield q;
  }
}

/** `file: problem` for each chart imported from outside the kit, or defined outside it, in one source. */
export function chartKitViolations(rel: string, src: string): string[] {
  const out: string[] = [];
  const inKit = rel.startsWith(`${KIT}/`);
  for (const m of src.matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+'([^']+)'/g)) {
    const names = m[1]!.split(',').map((n) => n.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0]!.trim()).filter(Boolean);
    const from = m[2]!;
    const kitSource = from === '@resuto/ui' || (rel.startsWith('packages/ui/') && /(^|\/)charts(\/[\w-]+)?$/.test(from)) || (inKit && from.startsWith('./'));
    for (const n of names) if (CHART_NAMES.includes(n) && !kitSource) out.push(`${rel}: ${n} imported from '${from}' (import charts from '@resuto/ui')`);
  }
  if (/from\s+'@\/components\/charts'/.test(src) || /_components\/charts'/.test(src)) out.push(`${rel}: imports a retired chart kit`);
  if (!inKit) {
    for (const m of src.matchAll(/export\s+(?:function|const)\s+(\w+)/g)) {
      if (CHART_NAMES.includes(m[1]!) || /^\w+(Chart|Heatmap|Sparkline)$/.test(m[1]!)) out.push(`${rel}: defines chart ${m[1]} outside the kit`);
    }
  }
  return out;
}

describe('one chart kit (21-INSIGHTS)', () => {
  it('detects charts imported from elsewhere, retired kits and charts defined outside the kit', () => {
    expect(chartKitViolations('apps/web/app/x/page.tsx', "import { LineChart, Badge } from '@resuto/ui';")).toEqual([]);
    expect(chartKitViolations('apps/web/app/x/page.tsx', "import { LineChart } from '@/components/charts';")).toHaveLength(2);
    expect(chartKitViolations('apps/web/app/x/page.tsx', "import { RouteMap as Map } from '../_components/charts';")).toHaveLength(2);
    expect(chartKitViolations('apps/web/app/x/page.tsx', "import { BarList } from './my-bars';")).toHaveLength(1);
    expect(chartKitViolations('apps/web/app/x/page.tsx', 'export function RevenueChart() { return null; }')).toHaveLength(1);
    expect(chartKitViolations('apps/web/app/x/page.tsx', 'export function SalesPanel() { return null; }')).toEqual([]);
    expect(chartKitViolations('packages/ui/src/stat.tsx', "import { Sparkline } from './charts/sparkline';")).toEqual([]);
    expect(chartKitViolations('packages/ui/src/charts/index.ts', "export { LineChart } from './line';")).toEqual([]);
    expect(chartKitViolations('packages/ui/src/charts/bar.tsx', "import { chartColor } from './shared';\nexport function BarChart() {}")).toEqual([]);
  });

  it('every chart in the web app and the design system comes from the kit', () => {
    const offenders: string[] = [];
    for (const root of ROOTS) {
      for (const f of files(join(repo, root))) offenders.push(...chartKitViolations(relative(repo, f).split('\\').join('/'), readFileSync(f, 'utf8')));
    }
    expect(offenders).toEqual([]);
  });

  it('the retired kits are gone and the kit exports every chart', () => {
    expect(existsSync(join(repo, 'apps/web/components/charts/index.tsx'))).toBe(false);
    expect(existsSync(join(repo, 'apps/web/app/dashboard/[orgId]/intelligence/_components/charts.tsx'))).toBe(false);
    const index = readFileSync(join(repo, KIT, 'index.ts'), 'utf8');
    for (const m of ['line', 'bar', 'bar-list', 'donut', 'funnel', 'heatmap', 'sparkline', 'forecast', 'route-map']) expect(index).toContain(`'./${m}'`);
  });
});
