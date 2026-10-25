import { Injectable } from '@nestjs/common';
import {
  FUNNEL_PAGE_VIEW_WEIGHT, RETENTION_CURVE_DAYS,
  type AnalyticsPeriodQuery, type FunnelNote, type FunnelReport, type FunnelStep, type RetentionReport,
} from '@resuto/contracts';
import type { TenantContext } from '../../common/auth/context';
import type { Tx } from '../../common/db/db.service';
import { EntitlementsService } from '../../common/entitlements/entitlements.service';
import { AnalyticsService, FIRST_ORDERS, SCOPED } from './analytics.service';
import { iso } from './scope';

const BEACON_SOURCE = 'attribution_events written by the public funnel beacon (POST /v1/public/funnel/beacon)';
const pct = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 10000) / 100 : null);

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Growth funnel and retention (21-CRM, plan §6.7). Every step is a count of its own records in the period, with the
 * table it comes from and how complete it is; nothing is modelled or filled in. The steps are not one group of people
 * moving through: each counts what happened in the period (note `not_same_people`).
 *
 *   visits     guest-page tab sessions with a page view beacon, scaled by the sampling weight (estimate: 1 in 4 tab
 *              sessions report page views, so the raw number of sampled sessions is in `measured`);
 *   qr_scans   tab sessions that opened a table or counter QR page (/t, /v);
 *   messages   conversations with at least one inbound message (sandbox channels excluded; needs the Connect module);
 *   leads      contacts first identified in the period (customers created then; merged duplicates excluded);
 *   orders     counted orders (confirmed and not cancelled), as in every other report;
 *   repeat     identified customers with a counted order in the period that was not their first.
 *
 * Beacon, message and lead dates are local dates in the report's timezone (the branch's with a branch filter, else the
 * organization's); orders use each branch's timezone, like the other reports. A branch filter (or a branch-scoped
 * caller) counts beacons and conversations of those branches only: website visits without a branch are left out.
 */
@Injectable()
export class FunnelsService {
  constructor(private readonly analytics: AnalyticsService, private readonly entitlements: EntitlementsService) {}

  async funnel(tx: Tx, ctx: TenantContext, q: AnalyticsPeriodQuery): Promise<FunnelReport> {
    const { scope, tz } = await this.analytics.context(tx, ctx, q.branchId);
    const params = [ctx.orgId, scope, q.from, q.to, tz];
    const scoped = scope !== null;
    // Beacon events in the period, per kind: distinct tab sessions and their weight (one row per session and kind).
    const beacons = await tx.query<{ kind: string; sessions: number; weighted: number }>(
      `select kind, count(*)::int as sessions, coalesce(sum(w), 0)::int as weighted from (
         select e.kind, e.session_key, max(e.weight) as w from attribution_events e
          where e.org_id = $1 and e.kind in ('page_view', 'qr_scan', 'add_to_cart', 'checkout_started')
            and ($2::uuid[] is null or e.branch_id = any($2))
            and e.occurred_at >= (($3::date - 1)::timestamp at time zone 'UTC') and e.occurred_at < (($4::date + 2)::timestamp at time zone 'UTC')
            and (e.occurred_at at time zone $5)::date between $3::date and $4::date
          group by e.kind, e.session_key) s
        group by kind`, params);
    const since = await tx.maybeOne<{ at: Date | null }>(
      `select min(occurred_at) as at from attribution_events where org_id = $1 and kind in ('page_view', 'qr_scan', 'add_to_cart', 'checkout_started')`, [ctx.orgId]);
    const beaconsSince = iso(since?.at ?? null);
    const beforeBeacons = !beaconsSince || beaconsSince.slice(0, 10) > q.from;
    const b = new Map(beacons.map((r) => [r.kind, r]));
    const beaconNotes = (extra: FunnelNote[] = []): FunnelNote[] =>
      [...extra, 'needs_script', ...(scoped ? ['branch_unknown_excluded' as const] : []), ...(beforeBeacons ? ['before_beacons' as const] : [])];
    const beaconStep = (key: FunnelStep['key'], kind: string): FunnelStep => {
      const r = b.get(kind);
      return { key, value: r?.sessions ?? 0, unit: 'sessions', source: `${BEACON_SOURCE}, kind ${kind}: distinct tab sessions`,
        completeness: 'partial', notes: beaconNotes(), measured: r?.sessions ?? 0 };
    };
    const pv = b.get('page_view');
    const visits: FunnelStep = {
      key: 'visits', value: pv?.weighted ?? 0, unit: 'sessions',
      source: `${BEACON_SOURCE}, kind page_view: distinct sampled tab sessions × weight ${FUNNEL_PAGE_VIEW_WEIGHT}`,
      completeness: 'estimate', notes: beaconNotes(['sampled']), measured: pv?.sessions ?? 0,
    };

    // Conversations with an inbound message in the period (Connect module).
    let messages: FunnelStep;
    if (await this.entitlements.isEnabled(ctx.orgId, 'connect')) {
      const m = await tx.one<{ n: number; sandbox: number }>(
        `select count(distinct m.conversation_id) filter (where ch.transport <> 'sandbox')::int as n,
                count(distinct m.conversation_id) filter (where ch.transport = 'sandbox')::int as sandbox
           from messages m join conversations c on c.id = m.conversation_id join messaging_channels ch on ch.id = c.channel_id
          where m.org_id = $1 and m.direction = 'inbound' and ($2::uuid[] is null or c.branch_id = any($2))
            and m.created_at >= (($3::date - 1)::timestamp at time zone 'UTC') and m.created_at < (($4::date + 2)::timestamp at time zone 'UTC')
            and (m.created_at at time zone $5)::date between $3::date and $4::date`, params);
      messages = { key: 'messages', value: m.n, unit: 'conversations', measured: m.n,
        source: 'messages (direction inbound) joined to conversations: distinct conversations',
        completeness: scoped ? 'partial' : 'complete',
        notes: [...(m.sandbox ? ['sandbox_excluded' as const] : []), ...(scoped ? ['branch_unknown_excluded' as const] : [])] };
    } else {
      messages = { key: 'messages', value: null, unit: 'conversations', measured: null, source: 'messages (Connect module)',
        completeness: 'unavailable', notes: ['connect_not_entitled'] };
    }

    // New contacts: customers created in the period; with a branch scope, those with an order or a conversation there.
    const leads = await tx.one<{ n: number }>(
      `select count(*)::int as n from customers cu
        where cu.org_id = $1 and cu.merged_into_id is null
          and cu.created_at >= (($3::date - 1)::timestamp at time zone 'UTC') and cu.created_at < (($4::date + 2)::timestamp at time zone 'UTC')
          and (cu.created_at at time zone $5)::date between $3::date and $4::date
          and ($2::uuid[] is null
               or exists (select 1 from orders o where o.customer_id = cu.id and o.org_id = $1 and o.branch_id = any($2))
               or exists (select 1 from conversations c where c.customer_id = cu.id and c.org_id = $1 and c.branch_id = any($2)))`, params);

    // Counted orders, and customers whose counted order in the period was not their first (within the scope).
    const orders = await tx.one<{ orders: number; anonymous: number; repeat: number }>(
      `with ${SCOPED}
       , buyers as (select distinct customer_id from scoped where counted and customer_id is not null)
       , ranked as (
           select o.id, o.customer_id, row_number() over (partition by o.customer_id order by o.placed_at, o.id) as rn
             from orders o join buyers using (customer_id)
            where o.org_id = $1 and ($2::uuid[] is null or o.branch_id = any($2)) and o.status not in ('cancelled', 'awaiting_payment'))
       select (select count(*) from scoped where counted)::int as orders,
              (select count(*) from scoped where counted and customer_id is null)::int as anonymous,
              (select count(distinct r.customer_id) from ranked r join scoped s on s.id = r.id where s.counted and r.rn >= 2)::int as repeat`,
      params.slice(0, 4));

    const steps: FunnelStep[] = [
      visits,
      beaconStep('qr_scans', 'qr_scan'),
      messages,
      { key: 'leads', value: leads.n, unit: 'customers', measured: leads.n, source: 'customers created in the period (not merged)',
        completeness: scoped ? 'partial' : 'complete', notes: ['identified_only', ...(scoped ? ['branch_unknown_excluded' as const] : [])] },
      { key: 'orders', value: orders.orders, unit: 'orders', measured: orders.orders,
        source: 'orders: confirmed and not cancelled (not awaiting payment), by the branch\'s local date', completeness: 'complete', notes: [] },
      { key: 'repeat', value: orders.repeat, unit: 'customers', measured: orders.repeat,
        source: 'orders: identified customers whose counted order in the period was their second or later', completeness: 'complete',
        notes: ['identified_only'] },
    ];
    for (const s of steps) if (!s.notes.includes('not_same_people')) s.notes.push('not_same_people');
    return {
      from: q.from, to: q.to, branchId: q.branchId ?? null, steps,
      cart: [beaconStep('add_to_cart', 'add_to_cart'), beaconStep('checkout_started', 'checkout_started')],
      beaconsSince,
      meta: this.analytics.meta(tz, 'Each step counts its own records in the period (they are not the same people moving through). Visits = distinct guest-page tab sessions with a page-view beacon × 4 (1 in 4 tab sessions report page views; an estimate). QR scans = distinct tab sessions that opened a table or counter QR page. Messages = conversations with an inbound message (sandbox channels excluded). Leads = customers created in the period. Orders = counted orders. Repeat = identified customers whose counted order in the period was not their first. Beacons need the page\'s script and count only from the first beacon on; they store no personal data.', {
        sampledPageViewSessions: pv?.sessions ?? 0, pageViewWeight: FUNNEL_PAGE_VIEW_WEIGHT, beaconsSince,
        ordersWithoutCustomer: orders.anonymous, branchFiltered: scoped,
      }, [{ key: 'pageViewWeight', value: FUNNEL_PAGE_VIEW_WEIGHT, source: 'default' }], 'mixed'),
    };
  }

  async retention(tx: Tx, ctx: TenantContext, q: AnalyticsPeriodQuery): Promise<RetentionReport> {
    const customers = await this.analytics.customers(tx, ctx, q);
    const { scope, tz } = await this.analytics.context(tx, ctx, q.branchId);
    const today = (await tx.one<{ d: string }>(`select (now() at time zone $1)::date::text as d`, [tz])).d;
    // New customers of the period (first counted order in scope inside it) and the gap in local days to their next one.
    const rows = await tx.query<{ first_day: string; gap: number | null; n: number }>(
      `with ${FIRST_ORDERS}
       , members as (select * from firsts where first_day between $3::date and $4::date)
       , nexts as (
           select m.customer_id, m.first_day,
                  (select min((o.placed_at at time zone coalesce(b.timezone, org.timezone))::date)
                     from orders o join branches b on b.id = o.branch_id join organizations org on org.id = o.org_id
                    where o.customer_id = m.customer_id and o.org_id = $1 and ($2::uuid[] is null or o.branch_id = any($2))
                      and o.status not in ('cancelled', 'awaiting_payment') and (o.placed_at, o.id) > (m.placed_at, m.order_id)) as next_day
             from members m)
       select first_day::text as first_day, (next_day - first_day)::int as gap, count(*)::int as n from nexts group by 1, 2`,
      [ctx.orgId, scope, q.from, q.to]);
    const points: RetentionReport['repeatCurve']['points'] = [];
    for (let day = 0; day <= RETENTION_CURVE_DAYS; day++) {
      let eligible = 0;
      let repeated = 0;
      for (const r of rows) {
        if (addDays(r.first_day, day) > today) continue;
        eligible += r.n;
        if (r.gap !== null && r.gap <= day) repeated += r.n;
      }
      points.push({ day, eligible, repeated, pct: pct(repeated, eligible) });
    }
    return {
      from: q.from, to: q.to, branchId: q.branchId ?? null,
      cohorts: customers.cohorts,
      repeatCurve: { asOf: today, newCustomers: rows.reduce((a, r) => a + r.n, 0), points },
      meta: this.analytics.meta(tz, `Cohorts group customers by the local month of their first counted order (first orders inside the period) and count those who ordered again in each later month up to the period end. The repeat-purchase curve follows the period's new customers up to today: for each day d, eligible = customers whose first order is at least d days before today; repeated = those whose next counted order came within d days. Counted orders are confirmed and not cancelled; orders without an identified customer cannot be followed.`,
        { ...customers.meta.dataCoverage, asOf: today }),
    };
  }
}
