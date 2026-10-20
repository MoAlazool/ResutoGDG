// Hot queries for scripts/perf/explain.mjs, taken from the built API (apps/api/dist) so the suite always runs the SQL
// the services send: exported query constants where a service has them, otherwise the statement a service method
// issues against a capturing transaction (same text, same parameters). Build first: pnpm --filter @resuto/api build.
// p = { org_id, user_id, branch_id, order_id, refunded_order_id, today, from30, from365 }.
// `expect` is the regression budget checked with --assert (rows scanned and plan shape, not wall time: the machine
// is shared, the plan is not).
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const api = createRequire(path.join(root, 'apps/api/package.json'));
let mods;
function load() {
  if (mods) return mods;
  try {
    api('reflect-metadata');
    mods = {
      TenantContext: api('./dist/common/auth/context.js').TenantContext,
      orders: api('./dist/modules/orders/orders.service.js'),
      kitchen: api('./dist/modules/kitchen/kitchen.service.js'),
      analytics: api('./dist/modules/analytics/analytics.service.js'),
      customers: api('./dist/modules/customers/customers.service.js'),
    };
  } catch (error) {
    throw new Error(`explain suite needs the built API (pnpm --filter @resuto/api build): ${error.message}`);
  }
  return mods;
}

/** Runs a service method against a transaction that records statements and returns neutral rows. */
async function captured(p, run, pick) {
  const m = load();
  const calls = [];
  const row = { timezone: 'Africa/Cairo', currency: 'EGP', tz: 'Africa/Cairo', n: 0, totals: {}, by_branch: [], by_channel: [], by_fulfillment: [],
    payments: [], daily: [], heat: [] };
  const tx = {
    ctx: { mode: 'member', orgId: p.org_id, userId: p.user_id, actor: `user:${p.user_id}` },
    query: async (sql, params = []) => { calls.push({ sql, params }); return []; },
    one: async (sql, params = []) => { calls.push({ sql, params }); return row; },
    maybeOne: async (sql, params = []) => { calls.push({ sql, params }); return row; },
  };
  const ctx = new m.TenantContext(p.org_id, 'owner', null, p.user_id, 'user', p.user_id);
  await run(m, tx, ctx);
  const hit = calls.find((c) => pick.test(c.sql));
  if (!hit) throw new Error(`no statement matched ${pick}`);
  return hit;
}

const OPEN = ['awaiting_payment', 'placed', 'accepted', 'preparing', 'ready'];
const ordersList = (p, branchId, status) => captured(p,
  (m, tx, ctx) => new m.orders.OrdersService().list(tx, ctx, { limit: 50, branchId, status }), /from orders o left join dining_tables/);
const customers = (p, q) => captured(p,
  (m, tx, ctx) => new m.customers.CustomersService(null).list(tx, ctx, { sort: 'last_order', limit: 50, ...q }), /order by/);
const analytics = (method, p, from, pick) => captured(p,
  (m, tx, ctx) => new m.analytics.AnalyticsService(null)[method](tx, ctx, { from, to: p.today }), pick);

export const suite = [
  { id: 'Q1', name: 'orders.active, one branch (Orders page, polled 5 s)', build: (p) => ordersList(p, p.branch_id, OPEN.join(',')),
    expect: { maxRowsScanned: 1000, noSeqScanOn: ['orders'] } },
  { id: 'Q1b', name: 'orders.active, all branches', build: (p) => ordersList(p, undefined, OPEN.join(',')),
    expect: { maxRowsScanned: 1000, noSeqScanOn: ['orders'] } },
  { id: 'Q2', name: 'orders.all first page', build: (p) => ordersList(p, undefined, undefined), expect: { maxRowsScanned: 1000 } },
  { id: 'Q4', name: 'overview live (open orders, any date)', build: (p) => ({ sql: load().analytics.OVERVIEW_LIVE_SQL, params: [p.org_id, null] }),
    expect: { maxRowsScanned: 1000, noSeqScanOn: ['orders'] } },
  { id: 'Q5', name: 'KDS change marker (polled 2 s per screen)', build: (p) => ({ sql: load().kitchen.KDS_MARKER_SQL, params: [p.branch_id] }),
    expect: { maxRowsScanned: 2000 } },
  { id: 'Q6', name: 'KDS tickets', build: (p) => ({ sql: load().kitchen.KDS_TICKETS_SQL, params: [p.branch_id, null] }),
    expect: { maxRowsScanned: 1000, noSeqScanOn: ['orders'] } },
  { id: 'Q7', name: 'order detail payments', build: (p) => ({ sql: load().orders.ORDER_PAYMENTS_SQL, params: [p.refunded_order_id ?? p.order_id] }),
    expect: { maxRowsScanned: 100, noSeqScanOn: ['payments', 'payment_allocations'] } },
  { id: 'Q8', name: 'analytics summary, 30 days (one statement)', build: (p) => analytics('summary', p, p.from30, /pay as/),
    expect: { noDiskSort: true } },
  { id: 'Q8b', name: 'analytics summary, 365 days (one statement)', build: (p) => analytics('summary', p, p.from365, /pay as/),
    expect: { noDiskSort: true, maxRowsScanned: 150_000 } },
  { id: 'Q9', name: 'analytics products, 30 days', build: (p) => analytics('products', p, p.from30, /sales_grain/), expect: { noDiskSort: true } },
  { id: 'Q9b', name: 'analytics products, 365 days', build: (p) => analytics('products', p, p.from365, /sales_grain/),
    expect: { noDiskSort: true, maxRowsScanned: 150_000 } },
  { id: 'C1', name: 'customers page 1 (sort last order)', build: (p) => customers(p, {}), expect: { maxRowsScanned: 2000 } },
  { id: 'C1b', name: 'customers sort=spend', build: (p) => customers(p, { sort: 'spend' }), expect: { maxRowsScanned: 2000 } },
  { id: 'C2', name: 'customers total count', build: async (p) => {
    const m = load();
    const calls = [];
    const tx = { query: async (sql, params) => { calls.push({ sql, params }); return []; }, one: async (sql, params) => { calls.push({ sql, params }); return { n: 0 }; } };
    await new m.customers.CustomersService(null).list(tx, new m.TenantContext(p.org_id, 'owner', null, p.user_id, 'user', p.user_id), { sort: 'last_order', limit: 50 });
    return calls.find((c) => /count\(\*\)/.test(c.sql));
  } },
  { id: 'M1', name: 'public menu branches', mode: 'tenant',
    sql: `select id, code, name, name_ar, accepts_dine_in, accepts_pickup, accepts_delivery, accepts_reservations, delivery_fee_minor, min_order_minor,
                 address, city, phone from branches where org_id = $1 and is_active order by created_at`, params: (p) => [p.org_id] },
  { id: 'A1', name: 'admin outbox counters', mode: 'platform',
    sql: `select count(*) filter (where published_at is null)::int as unpublished, min(created_at) filter (where published_at is null) as oldest,
                count(*) filter (where published_at is null and attempts > 0)::int as retrying
           from outbox_events where published_at is null` },
];
