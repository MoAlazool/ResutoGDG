import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

// Plan §4 RTL: the design system uses logical CSS only (margin-inline, padding-inline-start, inset-inline-end,
// text-align: start …), so components lay out correctly in Arabic without per-direction overrides. Physical
// left/right properties are rejected in every packages/ui/src file (CSS, CSS-in-TS strings and style objects).
// A value that is genuinely physical (a tooltip placed at an SVG x coordinate) carries `logical-exempt` on its line.
// Later workstreams add the CSS files they migrate to ROOTS.
const ROOTS = [
  'packages/ui/src',
  // 21-INBOX increment 2: the Inbox workspace, the Customer 360 panel and Settings › Messaging.
  'apps/web/app/dashboard/[orgId]/inbox', 'apps/web/components/customers', 'apps/web/app/dashboard/[orgId]/settings/messaging',
  // 21-HOME: the overview command centre.
  'apps/web/app/dashboard/[orgId]/_home',
  // 21-STUDIO: the Studio workspace and its canvas document.
  'apps/web/app/dashboard/[orgId]/website', 'apps/web/app/studio-canvas',
  // 21-OPS: the Orders board and list, the shared ticket board and kitchen display.
  'apps/web/app/dashboard/[orgId]/orders', 'apps/web/components/ops', 'apps/web/app/kitchen', 'apps/web/app/dashboard/[orgId]/kitchen',
  'apps/web/app/dashboard/[orgId]/floor', 'apps/web/app/dashboard/[orgId]/host', 'apps/web/app/dashboard/[orgId]/reservations',
  'apps/web/components/floor/LiveFloor.tsx', 'apps/web/components/floor/WalkInSheet.tsx', 'apps/web/components/floor/areas.ts',
  'apps/web/app/dashboard/[orgId]/delivery', 'apps/web/app/dashboard/[orgId]/inventory',
  // 21-CRM: the funnel, retention and segment views, the Customers page, the Insights page shell and the guest beacon.
  'apps/web/components/crm', 'apps/web/app/dashboard/[orgId]/customers', 'apps/web/app/dashboard/[orgId]/analytics/page.tsx',
  'apps/web/lib/funnel-beacon.ts', 'apps/web/components/guest/FunnelView.tsx',
  // 21-MENU: the menu workspace and the assisted import it links to.
  'apps/web/app/dashboard/[orgId]/menu', 'apps/web/app/dashboard/[orgId]/menu-import',
  // 21-INSIGHTS: the Insights area (analytics and intelligence views, its shell and saved reports).
  'apps/web/app/dashboard/[orgId]/analytics', 'apps/web/app/dashboard/[orgId]/intelligence', 'apps/web/components/insights',
  // 21-MONEY: the Settings cluster (SettingsPage template) and the Money area.
  'apps/web/app/dashboard/[orgId]/settings', 'apps/web/app/dashboard/[orgId]/team', 'apps/web/app/dashboard/[orgId]/billing',
  'apps/web/app/dashboard/[orgId]/data', 'apps/web/app/dashboard/[orgId]/audit', 'apps/web/components/settings',
  'apps/web/app/dashboard/[orgId]/finance', 'apps/web/app/dashboard/[orgId]/payments', 'apps/web/app/dashboard/[orgId]/compliance',
  // 21-ADMIN: the operator console (shell, restaurants, operations, prices, provider apps).
  'apps/web/app/admin',
];
const SKIP = [/tokens\.css$/];
const repo = join(__dirname, '..', '..', '..');

const RULES: Array<[RegExp, string]> = [
  [/(?<![\w-])(margin|padding|border|scroll-margin|scroll-padding)-(left|right)\b/, 'use margin/padding/border-inline-start|end'],
  [/(?<![\w.$-])(left|right)\s*:/, 'use inset-inline-start|end'],
  [/text-align\s*:\s*['"]?(left|right)\b/, 'use text-align: start|end'],
  [/\bfloat\s*:\s*['"]?(left|right)\b/, 'use float: inline-start|inline-end'],
  [/\bclear\s*:\s*['"]?(left|right)\b/, 'use clear: inline-start|inline-end'],
  [/border-(top|bottom)-(left|right)-radius/, 'use border-start-start-radius …'],
  [/\b(margin|padding|border)(Left|Right)\b/, 'use marginInlineStart / paddingInlineEnd …'],
  [/\btextAlign\s*:\s*['"](left|right)['"]/, "use textAlign: 'start' | 'end'"],
];

function* files(p: string): Generator<string> {
  if (statSync(p).isFile()) { yield p; return; }
  for (const name of readdirSync(p)) {
    const q = join(p, name);
    if (statSync(q).isDirectory()) yield* files(q);
    else if (/\.(css|tsx?)$/.test(name) && !/\.test\./.test(name) && !/\.d\.ts$/.test(name)) yield q;
  }
}

/** `file:line: text (hint)` for each physical-direction declaration in one source. */
export function physicalDeclarations(rel: string, src: string): string[] {
  const out: string[] = [];
  src.split('\n').forEach((line, i) => {
    if (line.includes('logical-exempt')) return;
    const t = line.trim();
    if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return;
    for (const [re, hint] of RULES) if (re.test(line)) { out.push(`${rel}:${i + 1}: ${t.slice(0, 120)} (${hint})`); break; }
  });
  return out;
}

describe('logical CSS properties in the design system (RTL)', () => {
  it('detects physical properties in CSS, CSS strings and style objects', () => {
    expect(physicalDeclarations('a.css', '.x { margin-left: 4px; }')).toHaveLength(1);
    expect(physicalDeclarations('a.css', '.x { padding-right: 4px }')).toHaveLength(1);
    expect(physicalDeclarations('a.css', '.x { left: 0; }')).toHaveLength(1);
    expect(physicalDeclarations('a.css', '.x { text-align: right; }')).toHaveLength(1);
    expect(physicalDeclarations('a.css', '.x { border-top-left-radius: 4px; }')).toHaveLength(1);
    expect(physicalDeclarations('a.tsx', "<div style={{ marginLeft: 4, textAlign: 'left' }} />")).toHaveLength(1);
    expect(physicalDeclarations('a.tsx', '<div style={{ right: 0 }} />')).toHaveLength(1);
    expect(physicalDeclarations('a.css', '.x { margin-inline-start: 4px; inset-inline-end: 0; text-align: end; }')).toEqual([]);
    expect(physicalDeclarations('a.tsx', 'const px = e.clientX - rect.left;')).toEqual([]);
    expect(physicalDeclarations('a.tsx', "style={{ left: '50%' /* logical-exempt: svg */ }}")).toEqual([]);
    expect(physicalDeclarations('a.css', '@media (max-width: 700px) { .x { max-inline-size: none } }')).toEqual([]);
  });

  it('packages/ui/src and the migrated screens use logical properties only', () => {
    const offenders: string[] = [];
    for (const root of ROOTS) {
      for (const f of files(join(repo, root))) {
        const rel = relative(repo, f);
        if (SKIP.some((re) => re.test(rel))) continue;
        offenders.push(...physicalDeclarations(rel, readFileSync(f, 'utf8')));
      }
    }
    expect(offenders).toEqual([]);
  });
});
