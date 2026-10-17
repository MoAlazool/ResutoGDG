#!/usr/bin/env node
// Basic load smoke for a running API (local/staging only — never production).
//
//   API_URL=http://127.0.0.1:4191 node scripts/load/load-smoke.mjs
//
// Simulates many guests (distinct client IPs via X-Forwarded-For, because public
// endpoints are rate limited per IP) and checks correctness under contention:
//   1. public menu reads                 — latency percentiles, zero errors
//   2. concurrent website orders         — all succeed, order numbers unique
//   3. contended limited-stock item      — exactly `stock` orders succeed, never oversold
// Requires AUTH_DEV_MODE=true on the target API (creates its own test tenant).
const API = (process.env.API_URL ?? 'http://127.0.0.1:4191').replace(/\/$/, '');
const READS = Number(process.env.READS ?? 2000);
const ORDERS = Number(process.env.ORDERS ?? 300);
const STOCK = Number(process.env.STOCK ?? 50);
const CONCURRENCY = Number(process.env.CONCURRENCY ?? 40);

if (!/^http:\/\/(127\.0\.0\.1|localhost)/.test(API) && process.env.ALLOW_REMOTE !== '1') {
  console.error('Refusing to load-test a non-local API without ALLOW_REMOTE=1 (never point this at production).');
  process.exit(1);
}

let ipCounter = 0;
const ip = () => `10.${(++ipCounter >> 16) & 255}.${(ipCounter >> 8) & 255}.${ipCounter & 255}`;

async function call(method, path, { token, body, headers } = {}) {
  const started = performance.now();
  const res = await fetch(API + '/v1' + path, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ip(), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, ms: performance.now() - started };
}

async function must(method, path, opts) {
  const r = await call(method, path, opts);
  if (r.status >= 300) throw new Error(`${method} ${path} → ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
}

async function pool(n, worker) {
  const results = [];
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, n) }, async () => {
    while (next < n) { const i = next++; results[i] = await worker(i); }
  }));
  return results;
}

function stats(label, results) {
  const ms = results.map((r) => r.ms).sort((a, b) => a - b);
  const pct = (p) => ms[Math.min(ms.length - 1, Math.floor((p / 100) * ms.length))].toFixed(1);
  const byStatus = results.reduce((m, r) => ({ ...m, [r.status]: (m[r.status] ?? 0) + 1 }), {});
  console.log(`${label}: n=${results.length} p50=${pct(50)}ms p95=${pct(95)}ms p99=${pct(99)}ms max=${ms.at(-1).toFixed(1)}ms statuses=${JSON.stringify(byStatus)}`);
  return byStatus;
}

const failures = [];
const check = (ok, message) => { if (!ok) failures.push(message); console.log(`${ok ? '  ✓' : '  ✗'} ${message}`); };

// --- setup -------------------------------------------------------------------
const email = `load-${Date.now()}@example.test`;
const { accessToken: token } = await must('POST', '/auth/dev/signup', { body: { email, password: 'load-test-password-1', fullName: 'Load test' } });
const slug = `load-${Date.now().toString(36)}`;
const org = await must('POST', '/orgs', { token, body: { name: 'Load Test Kitchen', slug, country: 'EG', planId: 'pro', branch: { name: 'Main', acceptsDelivery: false } } });
const cat = await must('POST', `/o/${org.id}/menu/categories`, { token, body: { name: 'Mains' } });
const koshary = await must('POST', `/o/${org.id}/menu/products`, { token, body: { categoryId: cat.id, name: 'Koshary', nameAr: 'كشري', priceMinor: 6500 } });
const limited = await must('POST', `/o/${org.id}/menu/products`, { token, body: { categoryId: cat.id, name: 'Limited special', priceMinor: 20000, trackStock: true } });
await must('PUT', `/o/${org.id}/menu/products/${limited.id ?? limited.product?.id}/branches/${org.branchId}`, { token, body: { stockQty: STOCK } });
const kosharyId = koshary.id ?? koshary.product?.id;
const limitedId = limited.id ?? limited.product?.id;
console.log(`tenant ${slug} ready (reads=${READS}, orders=${ORDERS}, stock=${STOCK}, concurrency=${CONCURRENCY})`);

// --- 1. public reads -----------------------------------------------------------
const reads = await pool(READS, () => call('GET', `/public/menu/${slug}`));
const readStatus = stats('public menu GET', reads);
check((readStatus[200] ?? 0) === READS, `all ${READS} menu reads returned 200`);

// --- 2. concurrent web orders -----------------------------------------------------
const order = (productId, i) => call('POST', `/public/order/${slug}/orders`, {
  headers: { 'Idempotency-Key': `load-${slug}-${productId.slice(0, 8)}-${i}` },
  body: { branchId: org.branchId, fulfillment: 'pickup', payment: 'pay_at_pickup', lines: [{ productId, quantity: 1 }],
    customer: { name: `Guest ${i}`, phone: `+2010${String(10000000 + i).slice(-8)}` } },
});
const placed = await pool(ORDERS, (i) => order(kosharyId, i));
const placedStatus = stats('web order POST', placed);
check((placedStatus[201] ?? 0) === ORDERS, `all ${ORDERS} orders placed`);
const numbers = placed.filter((r) => r.status === 201).map((r) => r.body.order.number);
check(new Set(numbers).size === numbers.length, 'order numbers are unique under concurrency');

// --- 3. contended stock -------------------------------------------------------------
const contenders = STOCK * 2;
const race = await pool(contenders, (i) => order(limitedId, 100000 + i));
const raceStatus = stats('limited-stock POST', race);
check((raceStatus[201] ?? 0) === STOCK, `exactly ${STOCK} of ${contenders} limited orders succeeded`);
check((raceStatus[409] ?? 0) === contenders - STOCK, 'the rest were refused as out of stock (409)');
const editor = await must('GET', `/o/${org.id}/menu`, { token });
const product = editor.products.find((p) => p.id === limitedId);
const left = product?.branchSettings?.find((b) => b.branchId === org.branchId)?.stockQty;
check(left === 0, `stock ended at 0 (got ${left})`);
check(![...reads, ...placed, ...race].some((r) => r.status >= 500), 'no 5xx responses');

if (failures.length) {
  console.error(`\n${failures.length} check(s) failed`);
  process.exit(1);
}
console.log('\nload smoke passed');
