#!/usr/bin/env node
// API latency, query-count and payload-size runner (CR-16). Local or staging only, never production.
//
// Spawn mode (preferred: measures the cold start and counts DB statements per request):
//   node scripts/perf/api-latency.mjs --spawn --env <api.env> --accounts <demo-accounts.json> --label baseline \
//        [--db postgres://postgres@127.0.0.1:54329/resuto_perf] [--port 4570] [--n 40] [--out results.json]
//   Starts apps/api/dist/main.js (build it first) with the env file, PORT/DATABASE_URL overrides and the
//   lib/pg-probe.cjs preload, waits for /v1/health, then measures and stops the process.
// Attach mode (an API that is already running; no cold start, no statement counts unless it runs the probe):
//   node scripts/perf/api-latency.mjs --api http://127.0.0.1:4570 --accounts <file> --label staging
//
// Per endpoint it reports: the first request after process start ("cold": route warm-up, pool connect, plan
// cache), then N sequential warm requests after 5 warm-ups (p50/p95/p99/max), DB statements per request
// (median; "app" excludes begin/commit/set_config), DB time, response bytes on the wire and uncompressed, the
// Content-Encoding, Cache-Control and ETag the API sent, and whether If-None-Match revalidates (304).
// Numbers are single-client latencies on this machine: they compare code versions, they are not capacity.
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import { execSync } from 'node:child_process';
import { args, assertLocalDatabase, assertLocalUrl } from './lib/guard.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const a = args();
const N = Number(a.n ?? 40);
/** Per-endpoint sampling budget: slow endpoints stop after this many seconds (but never below 10 samples). */
const MAX_SECONDS = Number(a['max-seconds'] ?? 45);
const label = String(a.label ?? 'run');
const port = Number(a.port ?? 4570);

function parseEnv(file) {
  const env = {};
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)=(.*)$/);
    if (m) env[m[1]] = m[2].replace(/^"(.*)"$/, '$1');
  }
  return env;
}

let child = null;
let base;
let coldStartMs = null;
const stop = () => { if (child && child.exitCode === null) child.kill('SIGTERM'); };
process.on('exit', stop);
process.on('SIGINT', () => { stop(); process.exit(130); });

if (a.spawn) {
  if (!a.env) throw new Error('--spawn needs --env <file> (copy of the demo env with your own ports and database)');
  const env = { ...process.env, ...parseEnv(a.env), PORT: String(port), NODE_OPTIONS: `--require ${path.join(here, 'lib/pg-probe.cjs')}` };
  if (a.db) env.DATABASE_URL = a.db;
  env.API_ORIGIN = `http://127.0.0.1:${port}`;
  env.RUN_WORKER_IN_PROCESS = 'false';
  assertLocalDatabase(env.DATABASE_URL);
  base = `http://127.0.0.1:${port}`;
  const started = performance.now();
  child = spawn(process.execPath, ['dist/main.js'], { cwd: path.join(root, 'apps/api'), env, stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d; });
  child.on('exit', (code) => { if (code && coldStartMs === null) { console.error(stderr); process.exit(1); } });
  for (;;) {
    if (performance.now() - started > 60_000) throw new Error(`API did not become healthy within 60 s\n${stderr}`);
    const ok = await new Promise((resolve) => {
      const req = http.get(`${base}/v1/health`, (res) => { res.resume(); resolve(res.statusCode === 200); });
      req.on('error', () => resolve(false));
    });
    if (ok) break;
    await new Promise((r) => setTimeout(r, 25));
  }
  coldStartMs = Math.round(performance.now() - started);
} else {
  base = String(a.api ?? 'http://127.0.0.1:4570').replace(/\/(v1)?\/?$/, '');
  assertLocalUrl(base);
}

const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
function request(method, p, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const started = performance.now();
    const req = http.request(`${base}/v1${p}`, { method, agent, headers: { 'accept-encoding': 'gzip, br', ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const wire = Buffer.concat(chunks);
        const enc = res.headers['content-encoding'];
        const raw = enc === 'br' ? zlib.brotliDecompressSync(wire) : enc === 'gzip' ? zlib.gunzipSync(wire) : wire;
        resolve({ status: res.statusCode, ms: performance.now() - started, headers: res.headers, wireBytes: wire.length, raw });
      });
    });
    req.on('error', reject);
    if (body !== undefined) { req.setHeader('content-type', 'application/json'); req.end(JSON.stringify(body)); } else req.end();
  });
}
const json = (r) => JSON.parse(r.raw.toString('utf8') || 'null');

// ---------------------------------------------------------------------------------------------------------------
// Sign in and discover ids
// ---------------------------------------------------------------------------------------------------------------
const accounts = a.accounts ? JSON.parse(readFileSync(a.accounts, 'utf8')) : null;
const email = process.env.PERF_EMAIL ?? accounts?.owner?.email;
const password = process.env.PERF_PASSWORD ?? accounts?.owner?.password;
if (!email || !password) throw new Error('Pass --accounts <demo-accounts.json> or PERF_EMAIL / PERF_PASSWORD');
const login = await request('POST', '/auth/dev/login', { body: { email, password } });
if (login.status !== 200) throw new Error(`dev login failed: ${login.status} ${login.raw}`);
const token = json(login).accessToken;
const auth = { authorization: `Bearer ${token}` };
const me = json(await request('GET', '/me', { headers: auth }));
const orgId = accounts?.orgId ?? me.memberships?.[0]?.orgId ?? me.orgs?.[0]?.id;
const org = json(await request('GET', `/o/${orgId}`, { headers: auth }));
const slug = accounts?.slug ?? org.slug;
const branchId = accounts?.branches?.main?.id ?? org.branches?.[0]?.id;
const recent = json(await request('GET', `/o/${orgId}/orders?limit=1`, { headers: auth }));
const orderId = recent.items?.[0]?.id;
const kds = json(await request('GET', `/o/${orgId}/kitchen/${branchId}`, { headers: auth }));
const page1 = json(await request('GET', `/o/${orgId}/customers?limit=50`, { headers: auth }));
const ordersPage1 = json(await request('GET', `/o/${orgId}/orders?limit=50`, { headers: auth }));
const today = new Date().toISOString().slice(0, 10);
const daysAgo = (d) => new Date(Date.now() - d * 86_400_000).toISOString().slice(0, 10);
const range = (d) => `from=${daysAgo(d - 1)}&to=${today}`;
const OPEN = 'awaiting_payment,placed,accepted,preparing,ready';

/** [name, path, authenticated, polled-by-UI (s, informational)] */
const endpoints = [
  ['health', '/health', false],
  ['me', '/me', true],
  ['org', `/o/${orgId}`, true],
  ['entitlements', `/o/${orgId}/billing/entitlements`, true],
  ['overview', `/o/${orgId}/analytics/overview`, true, 30],
  ['analytics.summary.30d', `/o/${orgId}/analytics/summary?${range(30)}`, true],
  ['analytics.summary.365d', `/o/${orgId}/analytics/summary?${range(365)}`, true],
  ['analytics.products.30d', `/o/${orgId}/analytics/products?${range(30)}`, true],
  ['analytics.products.365d', `/o/${orgId}/analytics/products?${range(365)}`, true],
  ['analytics.operations.30d', `/o/${orgId}/analytics/operations?${range(30)}`, true],
  ['orders.active.branch', `/o/${orgId}/orders?limit=50&status=${OPEN}&branchId=${branchId}`, true, 5],
  ['orders.active.org', `/o/${orgId}/orders?limit=50&status=${OPEN}`, true, 5],
  ['orders.all.page1', `/o/${orgId}/orders?limit=50`, true],
  ['orders.all.page2', `/o/${orgId}/orders?limit=50&cursor=${ordersPage1.nextCursor ?? ''}`, true],
  ['order.detail', `/o/${orgId}/orders/${orderId}`, true, 5],
  ['requests', `/o/${orgId}/requests?branchId=${branchId}`, true, 5],
  ['kds.full', `/o/${orgId}/kitchen/${branchId}`, true, 2],
  ['kds.since', `/o/${orgId}/kitchen/${branchId}?since=${kds.cursor}`, true, 2],
  ['floor.live', `/o/${orgId}/floor/${branchId}/live`, true, 5],
  ['customers.page1', `/o/${orgId}/customers?limit=50`, true],
  ['customers.page2', `/o/${orgId}/customers?limit=50&cursor=${encodeURIComponent(page1.nextCursor ?? '')}`, true],
  ['customers.spend', `/o/${orgId}/customers?limit=50&sort=spend`, true],
  ['customers.search', `/o/${orgId}/customers?limit=50&q=Guest%201234`, true],
  ['menu.editor', `/o/${orgId}/menu`, true],
  ['reservations.day', `/o/${orgId}/reservations?date=${today}&branchId=${branchId}`, true],
  ['inbox.list', `/o/${orgId}/connect/conversations`, true, 5],
  ['delivery.board', `/o/${orgId}/delivery/board`, true, 10],
  ['payments.list', `/o/${orgId}/payments`, true],
  ['public.menu', `/public/menu/${slug}`, false],
  ['public.order', `/public/order/${slug}`, false],
  ['public.site', `/public/sites/${slug}`, false],
];
const only = a.only ? new RegExp(String(a.only)) : null;

const pct = (arr, p) => arr[Math.min(arr.length - 1, Math.max(0, Math.ceil((p / 100) * arr.length) - 1))];
const median = (arr) => { const s = [...arr].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : null; };
const probe = (h) => {
  const v = h['x-perf-db'];
  if (!v) return null;
  return Object.fromEntries(String(v).split(';').map((kv) => { const [k, n] = kv.split('='); return [k, Number(n)]; }));
};

const rows = [];
for (const [name, p, isAuth, pollSeconds] of endpoints) {
  if (only && !only.test(name)) continue;
  const headers = isAuth ? auth : {};
  const cold = await request('GET', p, { headers });
  for (let i = 0; i < 5; i++) await request('GET', p, { headers });
  const times = [];
  const probes = [];
  let last = cold;
  const budgetStart = performance.now();
  for (let i = 0; i < N; i++) {
    if (i >= 10 && performance.now() - budgetStart > MAX_SECONDS * 1000) break;
    last = await request('GET', p, { headers });
    times.push(last.ms);
    const pr = probe(last.headers);
    if (pr) probes.push(pr);
  }
  times.sort((x, y) => x - y);
  let revalidate = '-';
  const etag = last.headers.etag;
  if (etag) revalidate = String((await request('GET', p, { headers: { ...headers, 'if-none-match': etag } })).status);
  const gzipBytes = zlib.gzipSync(last.raw).length;
  rows.push({
    name, status: last.status, samples: times.length, coldMs: +cold.ms.toFixed(1),
    p50: +pct(times, 50).toFixed(1), p95: +pct(times, 95).toFixed(1), p99: +pct(times, 99).toFixed(1), max: +times.at(-1).toFixed(1),
    queries: probes.length ? median(probes.map((x) => x.q)) : null, appQueries: probes.length ? median(probes.map((x) => x.app)) : null,
    dbMs: probes.length ? +median(probes.map((x) => x.ms)).toFixed(2) : null,
    rawBytes: last.raw.length, wireBytes: last.wireBytes, gzipBytes, encoding: last.headers['content-encoding'] ?? '-',
    cacheControl: last.headers['cache-control'] ?? '-', etag: etag ? 'yes' : 'no', ifNoneMatch: revalidate, pollSeconds: pollSeconds ?? null,
  });
  process.stderr.write(`${name} p50=${rows.at(-1).p50}ms\n`);
}

let commit = null;
try { commit = execSync('git rev-parse --short HEAD', { cwd: root }).toString().trim(); } catch { /* not a checkout */ }
const result = { label, commit, at: new Date().toISOString(), base, n: N, coldStartMs, db: a.db ?? null, rows };
const header = '| endpoint | status | cold ms | p50 | p95 | p99 | max | queries (app) | db ms | bytes raw → wire | encoding | Cache-Control | ETag → INM |';
const lines = [header, '|' + '---|'.repeat(13)];
for (const r of rows) {
  lines.push(`| ${r.name} | ${r.status} | ${r.coldMs} | ${r.p50} | ${r.p95} | ${r.p99} | ${r.max} | ${r.queries ?? '-'} (${r.appQueries ?? '-'}) | ${r.dbMs ?? '-'} | ${r.rawBytes} → ${r.wireBytes} | ${r.encoding} | ${r.cacheControl} | ${r.etag} → ${r.ifNoneMatch} |`);
}
const md = `API latency "${label}" at ${result.commit ?? '?'} (${result.at}); N=${N} warm samples per endpoint; cold start ${coldStartMs ?? 'n/a'} ms\n\n${lines.join('\n')}\n`;
console.log(md);
if (a.out) {
  mkdirSync(path.dirname(path.resolve(a.out)), { recursive: true });
  writeFileSync(a.out, JSON.stringify(result, null, 1));
  writeFileSync(String(a.out).replace(/\.json$/, '') + '.md', md);
}
stop();
agent.destroy();
