#!/usr/bin/env node
// EXPLAIN (ANALYZE, BUFFERS) suite for the hot queries, run as the API runs them: in a transaction with the tenant
// member context (request.jwt.claims, app.org_id, role resuto_member, jit off) for the owner of the main tenant.
//
//   node scripts/perf/explain.mjs --db postgres://postgres@127.0.0.1:54329/resuto_perf [--email owner@...] \
//        [--only Q1] [--runs 3] [--assert] [--out results.json]
//
// Each query runs `runs` times (default 3: the first warms the cache) and reports the best execution time,
// shared buffers hit/read, the top plan nodes and every Seq Scan on a large table. With --assert the run fails
// when a query breaks its `expect` budget (no seq scan on the named tables, execution time under maxMs): this is
// the regression check for the indexes and query shapes in docs/PERFORMANCE.md. Queries live in
// sql/explain-suite.mjs and mirror the SQL in the API services. Read-only (every transaction is rolled back).
import { writeFileSync } from 'node:fs';
import pg from 'pg';
import { args, assertLocalDatabase } from './lib/guard.mjs';
import { suite } from './sql/explain-suite.mjs';

const a = args();
const url = a.db ?? process.env.PERF_DATABASE_URL;
if (!url) { console.error('usage: node scripts/perf/explain.mjs --db <url> [--assert]'); process.exit(2); }
assertLocalDatabase(url);
const runs = Number(a.runs ?? 3);
const only = a.only ? new RegExp(String(a.only)) : null;

const client = new pg.Client({ connectionString: url });
await client.connect();
const email = String(a.email ?? 'owner@olive-room.demo.test');
const slug = String(a.slug ?? 'the-olive-room');
const ctx = (await client.query(
  `select o.id as org_id, u.id as user_id,
          (select b.id from branches b where b.org_id = o.id order by (b.code = 'main') desc, b.created_at limit 1) as branch_id,
          (select x.id from orders x where x.org_id = o.id order by x.placed_at desc limit 1) as order_id,
          (select x.id from orders x where x.org_id = o.id and x.payment_status = 'partially_refunded' order by x.placed_at desc limit 1) as refunded_order_id
     from organizations o, auth.users u where o.slug = $1 and u.email = $2`, [slug, email])).rows[0];
if (!ctx) throw new Error(`tenant ${slug} or user ${email} not found`);
const today = (await client.query(`select (now() at time zone 'Africa/Cairo')::date::text as d`)).rows[0].d;
const day = (n) => new Date(Date.parse(`${today}T00:00:00Z`) - n * 86_400_000).toISOString().slice(0, 10);
const p = { ...ctx, today, from30: day(29), from365: day(364) };

function walk(node, out, depth = 0) {
  out.push({ depth, type: node['Node Type'], relation: node['Relation Name'] ?? null, index: node['Index Name'] ?? null,
    rows: node['Actual Rows'], loops: node['Actual Loops'], ms: node['Actual Total Time'], sort: node['Sort Method'] ?? null,
    removed: (node['Rows Removed by Filter'] ?? 0) + (node['Rows Removed by Index Recheck'] ?? 0),
    disk: node['Sort Space Type'] === 'Disk' ? node['Sort Space Used'] : null });
  for (const child of node.Plans ?? []) walk(child, out, depth + 1);
  return out;
}

const results = [];
let failed = 0;
for (const q of suite) {
  if (only && !only.test(q.id)) continue;
  const sql = typeof q.sql === 'function' ? q.sql(p) : q.sql;
  const params = q.params ? q.params(p) : [];
  let best = null;
  for (let i = 0; i < runs; i++) {
    await client.query('begin');
    try {
      await client.query(
        `select set_config('request.jwt.claims', $1, true), set_config('app.org_id', $2, true), set_config('app.actor', $3, true), set_config('jit', 'off', true)`,
        [JSON.stringify({ sub: p.user_id, role: 'authenticated' }), p.org_id, `user:${p.user_id}`]);
      if (q.mode !== 'platform') await client.query(q.mode === 'tenant' ? 'set local role resuto_tenant' : 'set local role resuto_member');
      for (const s of q.setup ?? []) await client.query(s);
      const { rows } = await client.query(`explain (analyze, buffers, format json) ${sql}`, params);
      const plan = rows[0]['QUERY PLAN'][0];
      const r = { ms: plan['Execution Time'], planningMs: plan['Planning Time'], hit: plan.Plan['Shared Hit Blocks'], read: plan.Plan['Shared Read Blocks'], nodes: walk(plan.Plan, []) };
      if (!best || r.ms < best.ms) best = r;
    } finally {
      await client.query('rollback');
    }
  }
  const seqScans = best.nodes.filter((n) => n.type === 'Seq Scan' && ((n.rows + n.removed) * n.loops > 2000 || (q.expect?.noSeqScanOn ?? []).includes(n.relation)))
    .map((n) => `${n.relation} (${(n.rows + n.removed) * n.loops} rows)`);
  const indexes = [...new Set(best.nodes.filter((n) => n.index).map((n) => n.index))];
  const diskSorts = best.nodes.filter((n) => n.disk).map((n) => `${n.disk} kB`);
  // Rows the scans touched (returned + filtered out), over all loops: the cost a missing or unusable index shows up as.
  const rowsScanned = best.nodes.filter((n) => /Scan/.test(n.type)).reduce((s, n) => s + (n.rows + n.removed) * n.loops, 0);
  const violations = [];
  for (const rel of q.expect?.noSeqScanOn ?? []) if (best.nodes.some((n) => n.type === 'Seq Scan' && n.relation === rel)) violations.push(`seq scan on ${rel}`);
  if (q.expect?.maxMs !== undefined && best.ms > q.expect.maxMs) violations.push(`${best.ms.toFixed(1)} ms > ${q.expect.maxMs} ms`);
  for (const idx of q.expect?.usesIndex ?? []) if (!indexes.includes(idx)) violations.push(`does not use ${idx}`);
  if (violations.length) failed++;
  if (q.expect?.maxRowsScanned !== undefined && rowsScanned > q.expect.maxRowsScanned) violations.push(`${rowsScanned} rows scanned > ${q.expect.maxRowsScanned}`);
  results.push({ id: q.id, name: q.name, ms: +best.ms.toFixed(2), planningMs: +best.planningMs.toFixed(2), sharedHit: best.hit, sharedRead: best.read, rowsScanned,
    seqScans, indexes, diskSorts, violations });
  console.error(`${q.id} ${q.name}: ${best.ms.toFixed(2)} ms${violations.length ? `  VIOLATION ${violations.join('; ')}` : ''}`);
}
await client.end();

const lines = ['| id | query | exec ms | rows scanned | buffers hit/read | seq scans (large) | indexes used | disk sort |', '|---|---|---|---|---|---|---|---|'];
for (const r of results) {
  lines.push(`| ${r.id} | ${r.name} | ${r.ms} | ${r.rowsScanned} | ${r.sharedHit}/${r.sharedRead} | ${r.seqScans.join(', ') || '-'} | ${r.indexes.join(', ') || '-'} | ${r.diskSorts.join(', ') || '-'} |`);
}
console.log(lines.join('\n'));
if (a.out) writeFileSync(a.out, JSON.stringify({ at: new Date().toISOString(), db: new URL(url).pathname.slice(1), results }, null, 1));
if (a.assert && failed) { console.error(`${failed} quer${failed === 1 ? 'y' : 'ies'} broke their budget`); process.exit(1); }
