#!/usr/bin/env node
// Equivalence check for performance refactors: saves the JSON bodies of the read endpoints touched by the perf work
// (analytics, orders, customers, KDS, overview), or compares a running API against a saved snapshot. Volatile fields
// (generatedAt, serverTime, ageSeconds, isNew, localTime, cursors, signed URLs) are normalised before comparing.
//
//   node scripts/perf/snapshot-responses.mjs --api http://127.0.0.1:4570 --accounts <file> --save before.json
//   node scripts/perf/snapshot-responses.mjs --api http://127.0.0.1:4570 --accounts <file> --compare before.json
//
// Run both against the same database state (no writes in between). Exit code 1 when any response differs.
import { readFileSync, writeFileSync } from 'node:fs';
import { args, assertLocalUrl } from './lib/guard.mjs';

const a = args();
const API = String(a.api ?? 'http://127.0.0.1:4570').replace(/\/(v1)?\/?$/, '');
assertLocalUrl(API);
const acct = JSON.parse(readFileSync(a.accounts, 'utf8'));
const login = await (await fetch(`${API}/v1/auth/dev/login`, { method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify(acct.owner) })).json();
const H = { authorization: `Bearer ${login.accessToken}` };
const org = acct.orgId;
const br = acct.branches.main.id;
const today = String(a.today ?? new Date().toISOString().slice(0, 10));
const day = (n) => new Date(Date.parse(`${today}T00:00:00Z`) - n * 86_400_000).toISOString().slice(0, 10);
const OPEN = 'awaiting_payment,placed,accepted,preparing,ready';

const paths = {
  'summary.30d': `/o/${org}/analytics/summary?from=${day(29)}&to=${today}&compare=previous`,
  'summary.365d': `/o/${org}/analytics/summary?from=${day(364)}&to=${today}`,
  'summary.90d.branch': `/o/${org}/analytics/summary?from=${day(89)}&to=${day(5)}&branchId=${br}`,
  'products.30d': `/o/${org}/analytics/products?from=${day(29)}&to=${today}`,
  'products.365d': `/o/${org}/analytics/products?from=${day(364)}&to=${today}`,
  'roi': null,
  'orders.active': `/o/${org}/orders?limit=50&status=${OPEN}&branchId=${br}`,
  'orders.active.org': `/o/${org}/orders?limit=50&status=${OPEN}`,
  'orders.unknown-status': `/o/${org}/orders?limit=50&status=nonsense`,
  'orders.all': `/o/${org}/orders?limit=50`,
  'kds': `/o/${org}/kitchen/${br}`,
  'overview': `/o/${org}/analytics/overview`,
  'customers.last_order': `/o/${org}/customers?limit=50`,
  'customers.spend': `/o/${org}/customers?limit=50&sort=spend`,
  'customers.orders': `/o/${org}/customers?limit=50&sort=orders`,
  'customers.name': `/o/${org}/customers?limit=50&sort=name`,
  'customers.created': `/o/${org}/customers?limit=50&sort=created`,
  'customers.branch': `/o/${org}/customers?limit=50&branchId=${br}`,
  'customers.filters': `/o/${org}/customers?limit=50&minOrders=3&minSpendMinor=20000&lastOrderAfter=${day(60)}`,
  'customers.search': `/o/${org}/customers?limit=50&q=Guest%20123`,
};
delete paths.roi;

function normalise(v, key = '') {
  if (Array.isArray(v)) return v.map((x) => normalise(x));
  if (v && typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v).sort()) {
      // Clock-dependent fields: the overview compares "last week up to the same local time", which moves with now().
      if (['generatedAt', 'serverTime', 'ageSeconds', 'isNew', 'localTime', 'nextCursor', 'cursor', 'imageUrl', 'lastWeekSameTime', 'changePct'].includes(k)) continue;
      out[k] = normalise(v[k], k);
    }
    return out;
  }
  return v;
}

// Orders detail: the most recent partly refunded order (payments + allocations) and the newest order.
const refunded = await (await fetch(`${API}/v1/o/${org}/orders?limit=200`, { headers: H })).json();
const detailIds = refunded.items.slice(0, 3).map((o) => o.id);
const out = {};
for (const [name, p] of Object.entries(paths)) {
  const res = await fetch(`${API}/v1${p}`, { headers: H });
  out[name] = { status: res.status, body: normalise(await res.json()) };
}
for (const [i, id] of detailIds.entries()) {
  const res = await fetch(`${API}/v1/o/${org}/orders/${id}`, { headers: H });
  out[`order.detail.${i}`] = { status: res.status, body: normalise(await res.json()) };
}
// Second customers page through each API's own cursor.
for (const sort of ['last_order', 'spend', 'name']) {
  const p1 = await (await fetch(`${API}/v1/o/${org}/customers?limit=50&sort=${sort}`, { headers: H })).json();
  const p2 = await fetch(`${API}/v1/o/${org}/customers?limit=50&sort=${sort}&cursor=${encodeURIComponent(p1.nextCursor)}`, { headers: H });
  out[`customers.${sort}.page2`] = { status: p2.status, body: normalise(await p2.json()) };
}

if (a.save) {
  writeFileSync(a.save, JSON.stringify(out, null, 1));
  console.log(`saved ${Object.keys(out).length} responses to ${a.save}`);
} else if (a.compare) {
  // Normalise the saved side again, so a snapshot taken with older normalisation rules still compares.
  const before = Object.fromEntries(Object.entries(JSON.parse(readFileSync(a.compare, 'utf8'))).map(([k, v]) => [k, normalise(v)]));
  let diffs = 0;
  // Arrays whose order the API never specified (products.all comes from a FULL JOIN without ORDER BY).
  const canon = (k, v) => {
    if (k.startsWith('products.') && v?.body?.all) return { ...v, body: { ...v.body, all: [...v.body.all].sort((p, q) => String(p.productId).localeCompare(String(q.productId))) } };
    return v;
  };
  // Customer lists: ties on the sort key may be ordered differently (the keyset tie-break runs on the id in the same
  // direction as the key). Equivalent = same total, same sequence of sort keys, identical rows for every id on both.
  const SORT_FIELD = { last_order: 'lastOrderAt', spend: 'totalSpendMinor', orders: 'orderCount', name: 'displayName', created: 'createdAt' };
  const equivalentCustomers = (k, x, y) => {
    if (!k.startsWith('customers.') || x?.status !== 200 || y?.status !== 200) return false;
    const sort = Object.keys(SORT_FIELD).find((s) => k.includes(s)) ?? 'last_order';
    const f = SORT_FIELD[sort];
    if (x.body.total !== y.body.total) return false;
    if (JSON.stringify(x.body.items.map((i) => i[f])) !== JSON.stringify(y.body.items.map((i) => i[f]))) return false;
    const yById = new Map(y.body.items.map((i) => [i.id, i]));
    let shared = 0;
    for (const i of x.body.items) if (yById.has(i.id)) { shared++; if (JSON.stringify(i) !== JSON.stringify(yById.get(i.id))) return false; }
    return `${shared}/${x.body.items.length} rows shared, the rest are ties on ${f}`;
  };
  for (const k of Object.keys(before)) {
    const x = JSON.stringify(canon(k, before[k]));
    const y = JSON.stringify(canon(k, normalise(out[k])));
    if (x === y) { console.log(`same   ${k}`); continue; }
    const eq = equivalentCustomers(k, before[k], normalise(out[k]));
    if (eq) { console.log(`same*  ${k} (${eq})`); continue; }
    diffs++;
    let i = 0;
    while (i < x.length && x[i] === y?.[i]) i++;
    console.log(`DIFF   ${k}\n  before …${x.slice(Math.max(0, i - 120), i + 160)}\n  after  …${y?.slice(Math.max(0, i - 120), i + 160)}`);
  }
  console.log(diffs ? `${diffs} response(s) differ` : 'all responses identical');
  process.exit(diffs ? 1 : 0);
}
