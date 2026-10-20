#!/usr/bin/env node
// First-load JavaScript budget per route group (PCL-07), computed from a finished `next build` the same way Next
// prints "First Load JS": the gzip size of the unique JS files of the page entry and every layout above it.
//
//   node scripts/ui/bundle-budget.mjs [--next apps/web/.next] [--json out.json] [--report]
//
// Exits 1 when a route is over its group's budget (unless --report). Budgets are in kB (1000 bytes, as Next prints);
// the figures come out a few kB above Next's own table (every layout's chunks are counted), so they err on the safe side.
//
// `kb` is a ratchet at today's largest route plus a little headroom, so the bundles cannot silently grow back (the
// root layout used to ship every dictionary in both languages and supabase-js to every route). `targetKb` is the
// PCL-07 goal (guest 150 kB, staff 220 kB); routes above it are listed so they can be split further.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => {
  if (a.startsWith('--')) acc.push([a.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : true]);
  return acc;
}, []));
const NEXT = path.resolve(String(args.next ?? path.join(ROOT, 'apps/web/.next')));

/** Route groups, first match wins. Guest routes run on phones over mobile data at the table or the door. */
export const BUDGETS = [
  { group: 'guest', kb: 170, targetKb: 150, test: (r) => /^\/(t|order|reserve|pay|s|o|r)(\/|$)/.test(r) },
  { group: 'public', kb: 300, targetKb: 160, test: (r) => r === '/' || /^\/(pricing|legal|privacy|terms)(\/|$)/.test(r) },
  { group: 'staff', kb: 290, targetKb: 220, test: (r) => /^\/(dashboard|kitchen|driver|admin|onboarding|invite|login|signup)(\/|$)/.test(r) },
  { group: 'other', kb: 290, targetKb: 220, test: () => true },
];

const manifest = JSON.parse(readFileSync(path.join(NEXT, 'app-build-manifest.json'), 'utf8')).pages;
const sizes = new Map();
const gz = (file) => {
  if (!sizes.has(file)) {
    const p = path.join(NEXT, file);
    sizes.set(file, existsSync(p) ? gzipSync(readFileSync(p), { level: 9 }).length : 0);
  }
  return sizes.get(file);
};

/** "/dashboard/[orgId]/orders/page" -> ["/layout", "/dashboard/layout", "/dashboard/[orgId]/layout", …page]. */
function entriesFor(pageKey) {
  const segs = pageKey.replace(/\/page$/, '').split('/').filter(Boolean);
  const out = ['/layout'];
  for (let i = 1; i <= segs.length; i++) out.push(`/${segs.slice(0, i).join('/')}/layout`);
  out.push(pageKey);
  return out.filter((k) => manifest[k]);
}

const rows = [];
for (const key of Object.keys(manifest).filter((k) => k.endsWith('/page')).sort()) {
  const route = key.replace(/\/page$/, '').replace(/\/\([^)]+\)/g, '') || '/';
  const files = new Set(entriesFor(key).flatMap((k) => manifest[k]).filter((f) => f.endsWith('.js')));
  const bytes = [...files].reduce((n, f) => n + gz(f), 0);
  const budget = BUDGETS.find((b) => b.test(route));
  rows.push({ route, group: budget.group, firstLoadKb: Math.round(bytes / 100) / 10, budgetKb: budget.kb, targetKb: budget.targetKb,
    over: bytes / 1000 > budget.kb, aboveTarget: bytes / 1000 > budget.targetKb });
}

const over = rows.filter((r) => r.over);
for (const r of rows) console.log(`${r.over ? 'OVER' : r.aboveTarget ? 'tgt ' : 'ok  '}  ${r.group.padEnd(6)} ${String(r.firstLoadKb).padStart(6)} kB / ${r.budgetKb} kB (target ${r.targetKb})  ${r.route}`);
const byGroup = Object.fromEntries(BUDGETS.map((b) => {
  const g = rows.filter((r) => r.group === b.group);
  return [b.group, { routes: g.length, maxKb: g.length ? Math.max(...g.map((r) => r.firstLoadKb)) : 0, budgetKb: b.kb, targetKb: b.targetKb,
    aboveTarget: g.filter((r) => r.aboveTarget).length }];
}));
console.log(JSON.stringify(byGroup));
if (args.json) writeFileSync(String(args.json), JSON.stringify({ byGroup, rows }, null, 1));
if (over.length && !args.report) { console.error(`${over.length} route(s) over budget`); process.exit(1); }
