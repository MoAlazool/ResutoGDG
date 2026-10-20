#!/usr/bin/env node
// First-load JavaScript budget per route group (PCL-07), computed from a finished `next build` the same way Next
// prints "First Load JS": the gzip size of the unique JS files of the page entry and every layout above it.
//
//   node scripts/ui/bundle-budget.mjs [--next apps/web/.next] [--json out.json] [--report]
//   node scripts/ui/bundle-budget.mjs --web http://127.0.0.1:3530 [--org <orgId>] [--json out.json] [--report]
//
// With --web it also measures the HTML documents of a running build (`next start`), in English and Arabic: the RSC
// payload inside each document carries the route group's dictionary, which first-load JS does not count, and HTML is
// not cached across full page loads the way hashed chunks are. Document budgets are gzip kB per route group.
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

/**
 * HTML document budgets (gzip kB, ratchets at the largest of EN/AR plus headroom). Sign-in/onboarding pages carry
 * only their own copy (auth scope): /login went from 182 kB raw / 47.5 kB gz to 46 kB / 12.5 kB in English. Staff
 * documents still carry every module's copy (~48 kB gz EN, ~57 kB AR); splitting it per module is the next step.
 */
export const DOC_BUDGETS = [
  { group: 'auth', kb: 18, test: (r) => /^\/(login|signup|onboarding)(\/|$)/.test(r) },
  { group: 'staff', kb: 62, test: (r) => /^\/(dashboard|kitchen|driver|admin)(\/|$)/.test(r) },
  { group: 'public', kb: 42, test: () => true },
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

const docs = [];
if (args.web) {
  const WEB = String(args.web).replace(/\/$/, '');
  const routes = ['/login', '/signup', '/onboarding', '/', '/pricing'];
  if (args.org) routes.push(`/dashboard/${args.org}`, `/dashboard/${args.org}/orders`, `/kitchen/${args.org}`);
  for (const route of routes) for (const locale of ['en', 'ar']) {
    const res = await fetch(WEB + route, { headers: { Cookie: `resuto_locale=${locale}`, 'Accept-Encoding': 'identity' }, redirect: 'manual' });
    const body = Buffer.from(await res.arrayBuffer());
    const budget = DOC_BUDGETS.find((b) => b.test(route));
    const gzKb = Math.round(gzipSync(body, { level: 9 }).length / 100) / 10;
    docs.push({ route: route.replace(String(args.org ?? '\0'), '[orgId]'), locale, status: res.status, rawKb: Math.round(body.length / 100) / 10, gzipKb: gzKb,
      group: budget.group, budgetKb: budget.kb, over: gzKb > budget.kb });
  }
  for (const d of docs) console.log(`${d.over ? 'OVER' : 'ok  '}  doc ${d.group.padEnd(6)} ${String(d.gzipKb).padStart(6)} kB gz (${d.rawKb} kB raw) / ${d.budgetKb} kB  ${d.locale} ${d.route} [${d.status}]`);
}

const over = [...rows.filter((r) => r.over), ...docs.filter((d) => d.over)];
for (const r of rows) console.log(`${r.over ? 'OVER' : r.aboveTarget ? 'tgt ' : 'ok  '}  ${r.group.padEnd(6)} ${String(r.firstLoadKb).padStart(6)} kB / ${r.budgetKb} kB (target ${r.targetKb})  ${r.route}`);
const byGroup = Object.fromEntries(BUDGETS.map((b) => {
  const g = rows.filter((r) => r.group === b.group);
  return [b.group, { routes: g.length, maxKb: g.length ? Math.max(...g.map((r) => r.firstLoadKb)) : 0, budgetKb: b.kb, targetKb: b.targetKb,
    aboveTarget: g.filter((r) => r.aboveTarget).length }];
}));
console.log(JSON.stringify(byGroup));
if (args.json) writeFileSync(String(args.json), JSON.stringify({ byGroup, rows, docs }, null, 1));
if (over.length && !args.report) { console.error(`${over.length} route(s) over budget`); process.exit(1); }
