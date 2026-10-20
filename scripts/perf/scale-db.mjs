#!/usr/bin/env node
// Builds a large, multi-tenant copy of the demo database for performance measurement (CR-16).
//
//   node scripts/perf/scale-db.mjs --target postgres://postgres@127.0.0.1:54329/resuto_perf \
//        [--source postgres://postgres@127.0.0.1:54329/resuto_demo] [--no-copy] \
//        [--orders 200000] [--customers 60000] [--noise-orgs 4] [--noise-orders 12500] [--noise-customers 2500] \
//        [--days 365] [--job-runs 300000] [--seed 0.42] [--main-slug the-olive-room]
//
// Steps: (1) unless --no-copy, recreate the target as a pg_dump copy of --source (the source is only read);
// (2) apply pending migrations; (3) run sql/scale.sql and sql/after-scale.sql in one transaction (the latter rebuilds
// the read models that triggers maintain, since the bulk load bypasses triggers); (4) VACUUM ANALYZE.
// Defaults give about 250k orders and 70k customers. Deterministic for a given seed and source.
// Local databases only; refuses resuto, resuto_demo, resuto_e2e_* and the system databases as targets.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { migrate } from '../db/migrate.mjs';
import { args, assertLocalDatabase } from './lib/guard.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const a = args();
const target = a.target ?? process.env.PERF_DATABASE_URL;
if (!target) {
  console.error('usage: node scripts/perf/scale-db.mjs --target postgres://postgres@127.0.0.1:54329/<own_db> [--source ...]');
  process.exit(2);
}
const targetName = assertLocalDatabase(target, { write: true });
const source = a.source ?? 'postgres://postgres@127.0.0.1:54329/resuto_demo';
const num = (v, d, { min = 0, max = 10_000_000 } = {}) => {
  const n = v === undefined ? d : Number(v);
  if (!Number.isFinite(n) || n < min || n > max) throw new Error(`invalid number ${v}`);
  return n;
};
const params = {
  main_slug: String(a['main-slug'] ?? 'the-olive-room'),
  main_orders: num(a.orders, 200_000),
  main_customers: num(a.customers, 60_000),
  noise_orgs: num(a['noise-orgs'], 4, { max: 200 }),
  noise_orders: num(a['noise-orders'], 12_500),
  noise_customers: num(a['noise-customers'], 2_500, { max: 99_999 }),
  days: num(a.days, 365, { min: 1, max: 3650 }),
  job_runs: num(a['job-runs'], 300_000),
  seed: num(a.seed, 0.42, { min: -1, max: 1 }),
};
if (!/^[a-z0-9-]{1,60}$/.test(params.main_slug)) throw new Error('invalid --main-slug');

function run(cmd, argv, opts = {}) {
  const r = spawnSync(cmd, argv, { stdio: ['ignore', 'inherit', 'inherit'], ...opts });
  if (r.status !== 0) throw new Error(`${cmd} ${argv.join(' ')} exited ${r.status}`);
}

const t0 = Date.now();
const step = (label) => console.log(`[scale ${((Date.now() - t0) / 1000).toFixed(1)}s] ${label}`);

if (!a['no-copy']) {
  assertLocalDatabase(source);
  const s = new URL(source);
  const t = new URL(target);
  const conn = (u) => ['-h', u.hostname, '-p', u.port || '5432', '-U', decodeURIComponent(u.username || 'postgres')];
  step(`recreate ${targetName} from ${s.pathname.slice(1)}`);
  run('dropdb', [...conn(t), '--if-exists', targetName]);
  run('createdb', [...conn(t), targetName]);
  const dump = spawnSync('pg_dump', [...conn(s), '--no-owner', s.pathname.slice(1)], { maxBuffer: 1 << 30 });
  if (dump.status !== 0) throw new Error(`pg_dump failed: ${dump.stderr}`);
  const restore = spawnSync('psql', [...conn(t), '-q', '-v', 'ON_ERROR_STOP=1', '-d', targetName], { input: dump.stdout, maxBuffer: 1 << 30 });
  if (restore.status !== 0) throw new Error(`restore failed: ${restore.stderr}`);
}

step('migrate');
await migrate({ url: target, log: (m) => console.log(`  ${m}`) });

const sql = readFileSync(path.join(here, 'sql/scale.sql'), 'utf8').replace(/\{\{(\w+)\}\}/g, (_, k) => {
  if (!(k in params)) throw new Error(`unknown placeholder ${k}`);
  return String(params[k]);
});
const client = new pg.Client({ connectionString: target });
await client.connect();
try {
  step(`generate ${JSON.stringify(params)}`);
  await client.query('begin');
  await client.query('set local statement_timeout = 0; set local jit = off');
  await client.query(sql);
  step('rebuild trigger-maintained read models (sql/after-scale.sql)');
  await client.query(readFileSync(path.join(here, 'sql/after-scale.sql'), 'utf8'));
  await client.query('commit');
  step('vacuum analyze');
  await client.query('vacuum analyze');
  const { rows } = await client.query(`select (select count(*) from orders)::int as orders, (select count(*) from order_lines)::int as lines,
      (select count(*) from customers)::int as customers, (select count(*) from organizations)::int as orgs, (select count(*) from payments)::int as payments,
      (select count(*) from outbox_events)::int as outbox, (select pg_size_pretty(pg_database_size(current_database()))) as size`);
  step(`done ${JSON.stringify(rows[0])}`);
} catch (error) {
  await client.query('rollback').catch(() => undefined);
  throw error;
} finally {
  await client.end();
}
