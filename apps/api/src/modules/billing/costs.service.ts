import { Injectable } from '@nestjs/common';
import type { CostsMonth, CostsView, PassThroughLine } from '@resuto/contracts';
import type { Tx } from '../../common/db/db.service';

/**
 * FT-19: what the restaurant pays Resuto (platform invoices) kept apart from the costs it pays other providers
 * directly (pass-through): payment-provider fees, advertising spend, WhatsApp template messages and any metered
 * usage recorded with an external cost. Resuto never adds these to its own invoices.
 *
 * Amounts come only from recorded facts: fees reported on payments, spend in imported ad reports, external costs on
 * usage_events. WhatsApp template messages are counted (Meta prices them by its own per-country rate card, which
 * Resuto does not hold), so their amount is null rather than an estimate. Sandbox/test traffic is excluded.
 */
@Injectable()
export class CostsService {
  async view(tx: Tx, orgId: string, months: number): Promise<CostsView> {
    const { tz, start } = await tx.one<{ tz: string; start: string }>(
      `select coalesce(timezone, 'UTC') as tz,
              to_char(date_trunc('month', now() at time zone coalesce(timezone, 'UTC')) - make_interval(months => $2::int - 1), 'YYYY-MM-DD') as start
         from organizations where id = $1`, [orgId, months]);
    const local = (col: string) => `to_char(${col} at time zone $3, 'YYYY-MM')`;
    const since = (col: string) => `(${col} at time zone $3)::date >= $2::date`;

    const fees = await tx.query<{ m: string; detail: string; n: number; amount: string; currency: string }>(
      `select ${local('coalesce(captured_at, created_at)')} as m, provider || ':' || method::text as detail, count(*)::int as n,
              sum(fee_minor)::text as amount, currency::text as currency
         from payments
        where org_id = $1 and not is_test and coalesce(fee_minor, 0) > 0 and status in ('succeeded', 'partially_refunded', 'refunded')
          and ${since('coalesce(captured_at, created_at)')}
        group by 1, 2, 5`, [orgId, start, tz]);
    const ads = await tx.query<{ m: string; detail: string; n: number; amount: string; currency: string }>(
      `select to_char(report_date, 'YYYY-MM') as m, provider as detail, count(distinct coalesce(campaign_id::text, external_campaign_id))::int as n,
              sum(spend_minor)::text as amount, currency::text as currency
         from ad_campaign_reports
        where org_id = $1 and not is_sandbox and spend_minor > 0 and report_date >= $2::date and $3::text is not null
        group by 1, 2, 5`, [orgId, start, tz]);
    const msgs = await tx.query<{ m: string; detail: string; n: number }>(
      `select ${local('m.created_at')} as m, coalesce(lower(t.category), 'unknown') as detail, count(*)::int as n
         from messages m
         left join lateral (select category from message_templates t
                             where t.org_id = m.org_id and t.name = m.payload->>'templateName' and t.language = m.payload->>'language' limit 1) t on true
        where m.org_id = $1 and m.direction = 'outbound' and m.kind = 'template' and m.status in ('sent', 'delivered', 'read')
          and coalesce((m.payload->>'sandbox')::boolean, false) = false and ${since('m.created_at')}
        group by 1, 2`, [orgId, start, tz]);
    const metered = await tx.query<{ m: string; detail: string; n: number; amount: string | null; currency: string | null }>(
      `select ${local('occurred_at')} as m, metric as detail, sum(quantity)::int as n, sum(external_cost_minor)::text as amount, currency::text as currency
         from usage_events
        where org_id = $1 and cost_owner = 'merchant' and ${since('occurred_at')}
        group by 1, 2, 5`, [orgId, start, tz]);
    const invoices = await tx.query<{ m: string; amount: string; currency: string; statuses: string[] }>(
      `select ${local('period_start')} as m, sum(total_minor)::text as amount, min(currency::text) as currency, array_agg(distinct status::text order by status::text) as statuses
         from platform_invoices
        where org_id = $1 and ${since('period_start')}
        group by 1`, [orgId, start, tz]);

    const byMonth = new Map<string, CostsMonth>();
    for (let i = 0; i < months; i++) {
      const [y, mo] = start.split('-').map(Number);
      const d = new Date(Date.UTC(y, mo - 1 + i, 1));
      const key = d.toISOString().slice(0, 7);
      byMonth.set(key, { month: key, platform: { invoicedMinor: 0, currency: null, invoiceStatuses: [] }, passThrough: [] });
    }
    const push = (m: string, line: PassThroughLine) => byMonth.get(m)?.passThrough.push(line);
    for (const r of fees) push(r.m, { category: 'payment_fees', detail: r.detail, quantity: r.n, amountMinor: Number(r.amount), currency: r.currency, basis: 'provider_reported', billedBy: r.detail.split(':')[0] });
    for (const r of ads) push(r.m, { category: 'ad_spend', detail: r.detail, quantity: r.n, amountMinor: Number(r.amount), currency: r.currency, basis: 'provider_reported', billedBy: r.detail });
    for (const r of msgs) push(r.m, { category: 'messaging', detail: r.detail, quantity: r.n, amountMinor: null, currency: null, basis: 'count_only', billedBy: 'meta' });
    for (const r of metered) push(r.m, { category: 'metered_external', detail: r.detail, quantity: r.n, amountMinor: r.amount === null ? null : Number(r.amount), currency: r.currency, basis: 'metered', billedBy: 'provider' });
    for (const r of invoices) {
      const e = byMonth.get(r.m);
      if (e) e.platform = { invoicedMinor: Number(r.amount), currency: r.currency, invoiceStatuses: r.statuses };
    }
    for (const e of byMonth.values()) e.passThrough.sort((a, b) => a.category.localeCompare(b.category) || a.detail.localeCompare(b.detail));
    const notes: CostsView['notes'] = ['ai_included_in_plan', 'sandbox_excluded'];
    if (msgs.length) notes.unshift('messaging_rate_card_not_known');
    return { months: [...byMonth.values()].reverse(), notes };
  }
}
