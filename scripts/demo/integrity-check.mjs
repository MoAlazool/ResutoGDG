#!/usr/bin/env node
// Post-load integrity check for the demo tenant (audits DF-10, DF-11, VP-14). Read-only: every statement is a SELECT
// scoped to the demo organization, so it is safe to run against any database, including a shared staging one.
//
//   DATABASE_URL=… node scripts/demo/integrity-check.mjs [--slug the-olive-room] [--profile loader|migration] [--json]
//
// Profiles: `loader` (default) is every assertion, for a tenant built by scripts/demo/load-demo-data.mjs. `migration` is
// for a tenant built only by the legacy seed (scripts/db/seed.mjs): it has no finance history and no Smash & Co
// storefront, so those two assertions are not part of it.
//
// Exit codes: 0 every assertion holds · 1 at least one assertion failed · 2 usage (no demo tenant, no DATABASE_URL).
// The demo loader (scripts/demo/load-demo-data.mjs) and the legacy seed (scripts/db/seed.mjs) run it after every load,
// and scripts/demo/test/integrity.test.mjs proves that each assertion catches the defect it names.
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/** Hours after which "live" demo state (a visit, a confirmed booking, a call) is stale. */
export const LIVE_STALE_HOURS = 6;
/** Hours after which an active kitchen ticket or delivery job is stale. */
export const TICKET_STALE_HOURS = 12;
/** Fixed monthly costs every demo month carries (expense category kinds). */
export const FIXED_COST_KINDS = ['rent', 'utilities', 'fees', 'labor'];

const ACTIVE_ORDER = `('awaiting_payment', 'placed', 'accepted', 'preparing', 'ready')`;
const ACTIVE_JOB = `('unassigned', 'offered', 'assigned', 'accepted', 'picked_up', 'en_route')`;

/**
 * Each check is one SELECT returning `violations` (a count) and `sample` (up to five examples as text).
 * $1 = organization id, $2 = organization time zone. Statements use now() so the check is relative to when it runs.
 */
export const CHECKS = [
  {
    name: 'no_future_rows',
    description: 'No order, line, payment, refund, event, stock movement, visit, request, job, customer or expense is dated in the future',
    sql: `with f as (
        select 'orders.placed_at' as what, id::text as ref from orders where org_id = $1 and (placed_at > now() + interval '1 minute' or created_at > now() + interval '1 minute' or fulfilled_at > now() + interval '1 minute')
        union all select 'orders.business_date', id::text from orders where org_id = $1 and business_date > (now() at time zone $2)::date
        union all select 'order_lines.created_at', id::text from order_lines where org_id = $1 and created_at > now() + interval '1 minute'
        union all select 'order_events.created_at', id::text from order_events where org_id = $1 and created_at > now() + interval '1 minute'
        union all select 'payments.created_at', id::text from payments where org_id = $1 and (created_at > now() + interval '1 minute' or captured_at > now() + interval '1 minute')
        union all select 'refunds.created_at', id::text from refunds where org_id = $1 and created_at > now() + interval '1 minute'
        union all select 'stock_movements.created_at', id::text from stock_movements where org_id = $1 and created_at > now() + interval '1 minute'
        union all select 'visits.opened_at', id::text from visits where org_id = $1 and (opened_at > now() + interval '1 minute' or closed_at > now() + interval '1 minute')
        union all select 'service_requests.created_at', id::text from service_requests where org_id = $1 and created_at > now() + interval '1 minute'
        union all select 'delivery_jobs.created_at', id::text from delivery_jobs where org_id = $1 and (created_at > now() + interval '1 minute' or delivered_at > now() + interval '1 minute')
        union all select 'customers.last_seen_at', id::text from customers where org_id = $1 and (first_seen_at > now() + interval '1 minute' or last_seen_at > now() + interval '1 minute')
        union all select 'expenses.incurred_on', id::text from expenses where org_id = $1 and incurred_on > (now() at time zone $2)::date
      ) select count(*)::int as violations, coalesce((array_agg(what || ' ' || ref))[1:5], '{}') as sample from f`,
  },
  {
    name: 'reconciliation_period_not_in_future',
    description: 'Reconciliation runs never cover a period that ends after the run was made (the `to` is clamped at now)',
    sql: `select count(*)::int as violations, coalesce((array_agg(id::text || ' ends ' || period_end::text))[1:5], '{}') as sample
            from reconciliation_runs where org_id = $1 and (period_end > created_at + interval '1 minute' or period_start > period_end)`,
  },
  {
    name: 'no_negative_stock_running_balance',
    description: 'Replaying every stock movement in time order never takes an item below zero, and no alert opened at a negative quantity',
    sql: `with r as (
        select branch_id, item_id, created_at, sum(quantity_delta) over (partition by branch_id, item_id order by created_at, id) as running
          from stock_movements where org_id = $1
      ), neg as (
        select i.name || ' ' || round(min(r.running), 3)::text as what from r join inventory_items i on i.id = r.item_id
         where r.running < -0.0001 group by i.name
        union all select 'alert ' || id::text || ' opened at ' || quantity_at_open::text from stock_alerts where org_id = $1 and quantity_at_open < 0
      ) select count(*)::int as violations, coalesce((array_agg(what))[1:5], '{}') as sample from neg`,
  },
  {
    name: 'stock_levels_match_movements',
    description: 'Each stock level equals the sum of its movements (the ledger and the balance agree)',
    sql: `with m as (select branch_id, item_id, sum(quantity_delta) as q from stock_movements where org_id = $1 group by 1, 2),
           bad as (select coalesce(l.item_id, m.item_id)::text as what from stock_levels l full join m on m.branch_id = l.branch_id and m.item_id = l.item_id
                    where (l.org_id = $1 or l.org_id is null) and abs(coalesce(l.quantity, 0) - coalesce(m.q, 0)) > 0.0001)
      select count(*)::int as violations, coalesce((array_agg(what))[1:5], '{}') as sample from bad`,
  },
  {
    name: 'sale_movements_follow_their_order',
    description: 'Stock deducted for an order is dated with that order (not stamped at load time)',
    sql: `select count(*)::int as violations, coalesce((array_agg(m.id::text || ' order ' || o.id::text))[1:5], '{}') as sample
            from stock_movements m join orders o on o.org_id = m.org_id and o.id::text = m.reference_id
           where m.org_id = $1 and m.reference_type = 'order'
             and (m.created_at < o.placed_at - interval '1 minute' or m.created_at > o.placed_at + interval '1 day')`,
  },
  {
    name: 'checkout_sessions_follow_their_order',
    description: 'An order\'s online checkout session is dated with that order (not stamped at load time)',
    sql: `select count(*)::int as violations, coalesce((array_agg(s.id::text || ' order ' || o.id::text))[1:5], '{}') as sample
            from checkout_sessions s join orders o on o.id = s.order_id and o.org_id = s.org_id
           where s.org_id = $1 and (s.created_at < o.placed_at - interval '1 minute' or s.created_at > o.placed_at + interval '1 day')`,
  },
  {
    name: 'history_orders_unique',
    description: 'Each planned history order (date, index) exists once: an interrupted refresh never places a day twice',
    sql: `select count(*)::int as violations, coalesce((array_agg(external_ref || ' x' || n::text))[1:5], '{}') as sample
            from (select external_ref, count(*) as n from orders where org_id = $1 and external_ref like 'demo-hist:%' group by 1 having count(*) > 1) d`,
  },
  {
    name: 'fixed_costs_every_month',
    description: 'Every month from the first order to the current month books rent, utilities, fees and payroll (labor)',
    sql: `with bounds as (select date_trunc('month', min(business_date))::date as first, date_trunc('month', (now() at time zone $2)::date)::date as cur
                         from orders where org_id = $1),
           months as (select generate_series(first, cur, interval '1 month')::date as m from bounds where first is not null),
           kinds as (select unnest($3::text[]) as kind),
           missing as (
             select to_char(months.m, 'YYYY-MM') || ' ' || kinds.kind as what from months cross join kinds
              where not exists (select 1 from expenses e join expense_categories c on c.id = e.category_id
                                 where e.org_id = $1 and c.kind = kinds.kind and date_trunc('month', e.incurred_on)::date = months.m))
      select count(*)::int as violations, coalesce((array_agg(what order by what))[1:5], '{}') as sample from missing`,
    params: () => [FIXED_COST_KINDS],
  },
  {
    name: 'no_stale_reservations',
    description: `No booking is still held, awaiting a deposit or confirmed more than ${LIVE_STALE_HOURS} h after its start (or seated more than ${TICKET_STALE_HOURS} h after it)`,
    sql: `select count(*)::int as violations, coalesce((array_agg(code || ' ' || status::text || ' ' || starts_at::text))[1:5], '{}') as sample
            from reservations where org_id = $1
             and ((status in ('held', 'pending_deposit', 'confirmed') and starts_at < now() - make_interval(hours => ${LIVE_STALE_HOURS}))
               or (status = 'seated' and starts_at < now() - make_interval(hours => ${TICKET_STALE_HOURS})))`,
  },
  {
    name: 'no_stale_open_visits',
    description: `No table visit has been open for more than ${LIVE_STALE_HOURS} h`,
    sql: `select count(*)::int as violations, coalesce((array_agg(id::text || ' opened ' || opened_at::text))[1:5], '{}') as sample
            from visits where org_id = $1 and status = 'open' and opened_at < now() - make_interval(hours => ${LIVE_STALE_HOURS})`,
  },
  {
    name: 'no_stale_service_requests',
    description: `No waiter or bill call has been open for more than ${LIVE_STALE_HOURS} h`,
    sql: `select count(*)::int as violations, coalesce((array_agg(id::text || ' ' || kind))[1:5], '{}') as sample
            from service_requests where org_id = $1 and status = 'open' and created_at < now() - make_interval(hours => ${LIVE_STALE_HOURS})`,
  },
  {
    name: 'no_stale_kitchen_tickets',
    description: `No order is still active, and no kitchen line still queued, preparing or ready, more than ${TICKET_STALE_HOURS} h after it was placed`,
    sql: `with s as (
        select '#' || number || ' ' || status::text as what from orders
         where org_id = $1 and status in ${ACTIVE_ORDER} and placed_at < now() - make_interval(hours => ${TICKET_STALE_HOURS})
        union all
        select '#' || o.number || ' line ' || l.kitchen_status::text from order_lines l join orders o on o.id = l.order_id
         where l.org_id = $1 and l.kitchen_status in ('queued', 'preparing', 'ready') and o.status not in ('cancelled')
           and o.placed_at < now() - make_interval(hours => ${TICKET_STALE_HOURS})
      ) select count(*)::int as violations, coalesce((array_agg(what))[1:5], '{}') as sample from s`,
  },
  {
    name: 'no_stale_delivery_jobs',
    description: `No delivery job is still open more than ${TICKET_STALE_HOURS} h after it was created`,
    sql: `select count(*)::int as violations, coalesce((array_agg(id::text || ' ' || status::text))[1:5], '{}') as sample
            from delivery_jobs where org_id = $1 and status in ${ACTIVE_JOB} and created_at < now() - make_interval(hours => ${TICKET_STALE_HOURS})`,
  },
  {
    name: 'order_timeline_consistent',
    description: 'Order milestones never precede placement, and the business date is the local date of placement',
    sql: `select count(*)::int as violations, coalesce((array_agg('#' || number || ' ' || id::text))[1:5], '{}') as sample
            from orders where org_id = $1 and (
              accepted_at < placed_at - interval '1 second' or ready_at < placed_at - interval '1 second' or fulfilled_at < placed_at - interval '1 second'
              or cancelled_at < placed_at - interval '1 second' or business_date <> (placed_at at time zone $2)::date)`,
  },
  {
    name: 'arabic_names_present',
    description: 'The restaurant, its branches, menu categories, dishes and inventory ingredients all have Arabic names (Arabic pages never fall back to English)',
    sql: `with m as (
        select 'organization' as what from organizations where id = $1 and coalesce(btrim(name_ar), '') = ''
        union all select 'branch ' || name from branches where org_id = $1 and coalesce(btrim(name_ar), '') = ''
        union all select 'category ' || name from menu_categories where org_id = $1 and coalesce(btrim(name_ar), '') = ''
        union all select 'product ' || name from products where org_id = $1 and is_active and coalesce(btrim(name_ar), '') = ''
        union all select 'ingredient ' || name from inventory_items where org_id = $1 and is_active and coalesce(btrim(name_ar), '') = ''
      ) select count(*)::int as violations, coalesce((array_agg(what))[1:5], '{}') as sample from m`,
  },
  {
    name: 'photos_present',
    description: 'The website has a hero photo, every active dish has its own photo, and every photo row exists in the tenant',
    sql: `with m as (
        select 'website hero' as what from websites w where w.org_id = $1
           and not exists (select 1 from media_assets a where a.org_id = $1 and a.id::text = w.theme->>'heroMediaId')
        union all select 'no website' where not exists (select 1 from websites where org_id = $1)
        union all select 'product ' || p.name from products p where p.org_id = $1 and p.is_active
           and not exists (select 1 from media_assets a where a.org_id = $1 and a.id = p.image_media_id)
      ) select count(*)::int as violations, coalesce((array_agg(what))[1:5], '{}') as sample from m`,
  },
  {
    name: 'smash_storefront_present',
    description: 'The Smash & Co branch storefront is seeded and published with its own hero photo (audit VP-05)',
    sql: `select (case when exists (
              select 1 from branch_storefronts s join branches b on b.id = s.branch_id
               where s.org_id = $1 and s.slug = 'smash-and-co' and s.is_published and coalesce(btrim(s.brand_name_ar), '') <> ''
                 and exists (select 1 from media_assets a where a.org_id = $1 and a.id = s.hero_media_id))
            then 0 else 1 end) as violations, array['smash-and-co storefront missing, unpublished or without a hero']::text[] as sample`,
  },
];

/** Assertions that do not apply to a profile. */
export const PROFILES = { loader: [], migration: ['fixed_costs_every_month', 'smash_storefront_present'] };

/**
 * Runs every check against the demo tenant. `query(text, params)` returns rows (a pg Pool or Client `query` wrapper).
 * Returns { ok, orgId, results: [{ name, description, ok, violations, sample }] }.
 */
export async function checkDemoIntegrity(query, { slug = 'the-olive-room', only = null, profile = 'loader' } = {}) {
  if (!PROFILES[profile]) throw new Error(`unknown integrity profile "${profile}" (known: ${Object.keys(PROFILES).join(', ')})`);
  const [org] = await query(`select id, timezone from organizations where slug = $1`, [slug]);
  if (!org) throw Object.assign(new Error(`no organization with slug "${slug}"`), { code: 'NO_TENANT' });
  const results = [];
  for (const c of CHECKS) {
    if (only && !only.includes(c.name)) continue;
    if (PROFILES[profile].includes(c.name)) continue;
    const all = [org.id, org.timezone ?? 'Africa/Cairo', ...(c.params?.() ?? [])];
    const used = Math.max(...[...c.sql.matchAll(/\$(\d+)/g)].map((m) => Number(m[1])));
    const [row] = await query(c.sql, all.slice(0, used));
    results.push({ name: c.name, description: c.description, ok: row.violations === 0, violations: row.violations, sample: row.sample ?? [] });
  }
  return { ok: results.every((r) => r.ok), orgId: org.id, profile, results };
}

export function formatIntegrity(report) {
  const lines = [`demo integrity for organization ${report.orgId} (profile ${report.profile ?? 'loader'}):`];
  for (const r of report.results) {
    lines.push(`  ${r.ok ? 'ok  ' : 'FAIL'} ${r.name.padEnd(36)} ${r.ok ? '' : `${r.violations} violation(s): ${r.sample.join('; ')}`}`.trimEnd());
  }
  lines.push(report.ok ? 'all assertions hold.' : `${report.results.filter((r) => !r.ok).length} assertion(s) failed.`);
  return lines.join('\n');
}

async function main() {
  const args = process.argv.slice(2);
  const slug = args.includes('--slug') ? args[args.indexOf('--slug') + 1] : 'the-olive-room';
  const profile = args.includes('--profile') ? args[args.indexOf('--profile') + 1] : 'loader';
  if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is required'); process.exit(2); }
  const { default: pg } = await import('pg');
  const { pgClientConfig } = await import('../db/pg-tls.mjs');
  const client = new pg.Client(pgClientConfig(process.env.DATABASE_URL));
  await client.connect();
  try {
    await client.query('set default_transaction_read_only = on');   // belt and braces: this script never writes
    const report = await checkDemoIntegrity(async (t, p) => (await client.query(t, p)).rows, { slug, profile });
    console.log(args.includes('--json') ? JSON.stringify(report, null, 2) : formatIntegrity(report));
    process.exitCode = report.ok ? 0 : 1;
  } catch (e) {
    console.error(`integrity check failed to run: ${e.message}`);
    process.exitCode = e.code === 'NO_TENANT' ? 2 : 3;
  } finally {
    await client.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) await main();
