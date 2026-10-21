import { Injectable, Logger } from '@nestjs/common';
import type { FinancePayout, FinancePolicy } from '@resuto/contracts';
import { accountingAdapter, ACCOUNTING_ADAPTERS, type AccountRole, type JournalEntry, type JournalLine } from '@resuto/integrations';
import type { TenantContext } from '../../common/auth/context';
import { DbService, type Tx } from '../../common/db/db.service';
import { conflict, invalid, notFound } from '../../common/errors/domain-error';
import { AuditService } from '../../common/platform/audit.service';
import { PaymentProvidersService } from '../payments/providers.service';

const METHOD_ACCOUNT: Record<string, AccountRole> = {
  cash: 'cash', cod: 'cash', card: 'card_clearing', test: 'card_clearing', wallet: 'wallet_clearing', instapay: 'bank', bank_transfer: 'bank', deposit_credit: 'receivables',
};
/** FT-23: expense category kind -> debit account (purchases depend on the COGS policy). */
const EXPENSE_ACCOUNT: Record<string, AccountRole> = {
  labor: 'expenses_labor', rent: 'expenses_rent', utilities: 'expenses_utilities', marketing: 'expenses_marketing', delivery: 'expenses_delivery',
  fees: 'payment_fees', maintenance: 'expenses_maintenance', other: 'expenses_other',
};
/** How an expense was paid -> credit account (unpaid / on account -> payable). */
const EXPENSE_PAID_FROM: Record<string, AccountRole> = { cash: 'cash', bank: 'bank', bank_transfer: 'bank', card: 'bank', instapay: 'bank', wallet: 'bank' };
const sumBy = <T>(rows: T[], f: (r: T) => number) => rows.reduce((s, r) => s + f(r), 0);
/** VAT share of the delivery fee, rounded to the nearest minor unit. */
const share = (part: number, whole: number, of: number) => (whole > 0 ? Math.round((of * part) / whole) : 0);

/**
 * Journals for the restaurant's accounting system (Wafeq, Qoyod, Odoo), every entry balanced:
 * - RSJ daily sales: debits by settlement method (+ receivables for what is unpaid) against sales ex VAT, delivery
 *   income ex VAT and VAT output; refunds as separate balanced lines;
 * - RSE daily expenses (FT-23): expense account by category kind, input VAT, credited to cash/bank/payable;
 *   ingredient purchases debit inventory under the item-cost policy (DF-04) and COGS under the purchases policy;
 * - RSC daily cost of sales (item-cost policy): COGS against inventory from the recorded item costs;
 * - RSF daily payment fees (provider-reports policy): payment fees against the clearing account;
 * - RSP payouts: bank (+ fees withheld) against the clearing account the provider settled.
 */
@Injectable()
export class AccountingService {
  private readonly logger = new Logger('Accounting');

  constructor(private readonly db: DbService, private readonly providers: PaymentProvidersService, private readonly audit: AuditService) {}

  async journal(ctx: TenantContext, q: { from: string; to: string; branchId?: string }) {
    if (q.branchId) ctx.assertBranch(q.branchId);
    return this.db.scoped(ctx, (tx) => this.buildEntries(tx, ctx.orgId, q));
  }

  async buildEntries(tx: Tx, orgId: string, q: { from: string; to: string; branchId?: string }): Promise<{ currency: string; entries: JournalEntry[] }> {
    const org = await tx.one<any>('select currency, slug from organizations where id = $1', [orgId]);
    const suffix = q.branchId ? `-${q.branchId.slice(0, 8)}` : '';
    const days = await tx.query<any>(
      `select business_date::text as d, sum(total_minor)::bigint as total, sum(tax_minor)::bigint as tax, sum(delivery_fee_minor)::bigint as delivery, count(*)::int as n from orders
        where org_id = $1 and status not in ('cancelled', 'awaiting_payment') and business_date between $2::date and $3::date and ($4::uuid is null or branch_id = $4)
        group by 1 order by 1`, [orgId, q.from, q.to, q.branchId ?? null]);
    const alloc = await tx.query<any>(
      `select o.business_date::text as d, p.method::text as method, a.kind, sum(a.amount_minor)::bigint as amount
         from payment_allocations a join payments p on p.id = a.payment_id join orders o on o.id = a.order_id
        where o.org_id = $1 and o.status not in ('cancelled', 'awaiting_payment') and o.business_date between $2::date and $3::date and ($4::uuid is null or o.branch_id = $4)
        group by 1, 2, 3`, [orgId, q.from, q.to, q.branchId ?? null]);
    const entries: JournalEntry[] = [];
    for (const day of days) {
      const lines: JournalLine[] = [];
      const debit = new Map<AccountRole, number>();
      let paid = 0;
      for (const a of alloc.filter((x) => x.d === day.d && x.kind === 'payment')) {
        const role = METHOD_ACCOUNT[a.method] ?? 'receivables';
        debit.set(role, (debit.get(role) ?? 0) + Number(a.amount));
        paid += Number(a.amount);
      }
      const unpaid = Number(day.total) - paid;
      if (unpaid > 0) debit.set('receivables', (debit.get('receivables') ?? 0) + unpaid);
      for (const [role, v] of debit) if (v > 0) lines.push({ role, description: role === 'receivables' ? 'Unsettled sales / deposit credit' : `Collected (${role})`, debitMinor: v, creditMinor: 0 });
      // Delivery fees are income of their own (ex their VAT share), separate from food sales.
      const fee = Number(day.delivery);
      const deliveryExVat = fee > 0 ? fee - share(fee, Number(day.total), Number(day.tax)) : 0;
      const salesExVat = Number(day.total) - Number(day.tax) - deliveryExVat;
      if (salesExVat > 0) lines.push({ role: 'sales', description: `Sales ex VAT (${day.n} orders)`, debitMinor: 0, creditMinor: salesExVat });
      if (deliveryExVat > 0) lines.push({ role: 'delivery_income', description: 'Delivery fees ex VAT', debitMinor: 0, creditMinor: deliveryExVat });
      if (Number(day.tax) > 0) lines.push({ role: 'vat_output', description: 'VAT on sales', debitMinor: 0, creditMinor: Number(day.tax) });
      for (const r of alloc.filter((x) => x.d === day.d && x.kind === 'refund')) {
        const v = -Number(r.amount);
        if (v <= 0) continue;
        lines.push({ role: 'refunds', description: `Refunds (${r.method})`, debitMinor: v, creditMinor: 0 });
        lines.push({ role: METHOD_ACCOUNT[r.method] ?? 'receivables', description: `Refunds paid out (${r.method})`, debitMinor: 0, creditMinor: v });
      }
      if (unpaid < 0) lines.push({ role: 'receivables', description: 'Overpayment adjustment', debitMinor: 0, creditMinor: -unpaid });
      if (!lines.length) continue;
      entries.push({ reference: `RSJ-${org.slug}-${day.d}${suffix}`, date: day.d, currency: org.currency, memo: `Resuto daily sales ${day.d}`, lines });
    }
    entries.push(...await this.costEntries(tx, orgId, q, org, suffix));
    entries.sort((a, b) => a.date.localeCompare(b.date) || a.reference.localeCompare(b.reference));
    return { currency: org.currency, entries };
  }

  /** FT-23: expense, cost-of-sales, payment-fee and payout journals for the period (policy-aware, DF-04). */
  private async costEntries(tx: Tx, orgId: string, q: { from: string; to: string; branchId?: string }, org: { currency: string; slug: string }, suffix: string): Promise<JournalEntry[]> {
    const policy = await this.policy(tx, orgId);
    const out: JournalEntry[] = [];
    const b = q.branchId ?? null;
    const expenses = await tx.query<{ d: string; kind: string; amount: string; tax: string; paid: string | null }>(
      `select e.incurred_on::text as d, c.kind, e.amount_minor::text as amount, e.tax_minor::text as tax, e.payment_method as paid
         from expenses e join expense_categories c on c.id = e.category_id
        where e.org_id = $1 and e.incurred_on between $2::date and $3::date and ($4::uuid is null or e.branch_id = $4) order by e.incurred_on, e.id`,
      [orgId, q.from, q.to, b]);
    for (const d of [...new Set(expenses.map((e) => e.d))]) {
      const day = expenses.filter((e) => e.d === d);
      const debit = new Map<AccountRole, number>();
      const credit = new Map<AccountRole, number>();
      const add = (m: Map<AccountRole, number>, r: AccountRole, v: number) => m.set(r, (m.get(r) ?? 0) + v);
      for (const e of day) {
        const net = Number(e.amount) - Number(e.tax);
        // Fee expenses duplicate provider statements under the provider-reports policy: not journaled as fees again.
        if (e.kind === 'fees' && policy.feesMethod === 'provider_reports') continue;
        const role: AccountRole = e.kind === 'cogs' ? (policy.cogsMethod === 'item_cost' ? 'inventory' : 'cogs') : EXPENSE_ACCOUNT[e.kind] ?? 'expenses_other';
        add(debit, role, net);
        if (Number(e.tax) > 0) add(debit, 'vat_input', Number(e.tax));
        add(credit, EXPENSE_PAID_FROM[(e.paid ?? '').toLowerCase()] ?? 'accounts_payable', Number(e.amount));
      }
      const lines: JournalLine[] = [
        ...[...debit].filter(([, v]) => v > 0).map(([role, v]) => ({ role, description: role === 'vat_input' ? 'Input VAT on expenses' : `Expenses (${role})`, debitMinor: v, creditMinor: 0 })),
        ...[...credit].filter(([, v]) => v > 0).map(([role, v]) => ({ role, description: role === 'accounts_payable' ? 'Unpaid expenses (payable)' : `Expenses paid (${role})`, debitMinor: 0, creditMinor: v })),
      ];
      if (lines.length) out.push({ reference: `RSE-${org.slug}-${d}${suffix}`, date: d, currency: org.currency, memo: `Resuto expenses ${d}`, lines });
    }
    if (policy.cogsMethod === 'item_cost') {
      const cogs = await tx.query<{ d: string; cost: string }>(
        `select o.business_date::text as d, sum(l.cost_minor)::text as cost from order_lines l join orders o on o.id = l.order_id
          where o.org_id = $1 and o.status not in ('cancelled', 'awaiting_payment') and o.business_date between $2::date and $3::date
            and ($4::uuid is null or o.branch_id = $4) and l.cost_minor is not null group by 1 order by 1`, [orgId, q.from, q.to, b]);
      for (const c of cogs) {
        const v = Number(c.cost);
        if (v > 0) out.push({ reference: `RSC-${org.slug}-${c.d}${suffix}`, date: c.d, currency: org.currency, memo: `Resuto cost of sales ${c.d}`,
          lines: [{ role: 'cogs', description: 'Cost of items sold', debitMinor: v, creditMinor: 0 }, { role: 'inventory', description: 'Inventory used', debitMinor: 0, creditMinor: v }] });
      }
    }
    if (policy.feesMethod === 'provider_reports') {
      const fees = await tx.query<{ d: string; method: string; fee: string }>(
        `select (coalesce(p.captured_at, p.created_at) at time zone org.timezone)::date::text as d, p.method::text as method, sum(p.fee_minor)::text as fee
           from payments p join organizations org on org.id = p.org_id
          where p.org_id = $1 and p.status in ('succeeded', 'partially_refunded', 'refunded') and coalesce(p.fee_minor, 0) > 0
            and (coalesce(p.captured_at, p.created_at) at time zone org.timezone)::date between $2::date and $3::date and ($4::uuid is null or p.branch_id = $4)
          group by 1, 2 order by 1, 2`, [orgId, q.from, q.to, b]);
      for (const d of [...new Set(fees.map((f) => f.d))]) {
        const day = fees.filter((f) => f.d === d);
        const total = sumBy(day, (f) => Number(f.fee));
        const lines: JournalLine[] = [{ role: 'payment_fees', description: 'Payment provider fees', debitMinor: total, creditMinor: 0 },
          ...day.map((f) => ({ role: METHOD_ACCOUNT[f.method] ?? 'card_clearing', description: `Fees withheld (${f.method})`, debitMinor: 0, creditMinor: Number(f.fee) }))];
        out.push({ reference: `RSF-${org.slug}-${d}${suffix}`, date: d, currency: org.currency, memo: `Resuto payment fees ${d}`, lines });
      }
    }
    const payouts = await tx.query<any>(
      `select id, provider, clearing, paid_on::text as d, amount_minor, fee_minor, reference from finance_payouts
        where org_id = $1 and paid_on between $2::date and $3::date and ($4::uuid is null or branch_id = $4) order by paid_on, created_at`, [orgId, q.from, q.to, b]);
    for (const p of payouts) {
      const clearing: AccountRole = p.clearing === 'wallet' ? 'wallet_clearing' : 'card_clearing';
      const lines: JournalLine[] = [{ role: 'bank', description: `Payout from ${p.provider}${p.reference ? ` (${p.reference})` : ''}`, debitMinor: Number(p.amount_minor), creditMinor: 0 }];
      if (Number(p.fee_minor) > 0) lines.push({ role: 'payment_fees', description: `Fees withheld by ${p.provider}`, debitMinor: Number(p.fee_minor), creditMinor: 0 });
      lines.push({ role: clearing, description: `Settled by ${p.provider}`, debitMinor: 0, creditMinor: Number(p.amount_minor) + Number(p.fee_minor) });
      out.push({ reference: `RSP-${org.slug}-${String(p.id).slice(0, 8)}`, date: p.d, currency: org.currency, memo: `Resuto payout ${p.provider} ${p.d}`, lines });
    }
    return out;
  }

  private async policy(tx: Tx, orgId: string): Promise<FinancePolicy> {
    const r = await tx.maybeOne<any>('select cogs_method, fees_method, updated_at from finance_settings where org_id = $1', [orgId]);
    return { cogsMethod: r?.cogs_method ?? 'item_cost', feesMethod: r?.fees_method ?? 'provider_reports', updatedAt: r ? new Date(r.updated_at).toISOString() : null };
  }

  // ---------------------------------------------------------------------------
  // DF-04 policy, FT-23 account mapping and payouts
  // ---------------------------------------------------------------------------
  getPolicy(ctx: TenantContext) {
    return this.db.scoped(ctx, (tx) => this.policy(tx, ctx.orgId));
  }

  savePolicy(ctx: TenantContext, input: { cogsMethod: FinancePolicy['cogsMethod']; feesMethod: FinancePolicy['feesMethod'] }) {
    return this.db.scoped(ctx, async (tx) => {
      const before = await this.policy(tx, ctx.orgId);
      await tx.query(
        `insert into finance_settings(org_id, cogs_method, fees_method, updated_at, updated_by) values ($1, $2, $3, now(), $4)
         on conflict (org_id) do update set cogs_method = excluded.cogs_method, fees_method = excluded.fees_method, updated_at = now(), updated_by = excluded.updated_by`,
        [ctx.orgId, input.cogsMethod, input.feesMethod, ctx.userId]);
      await this.audit.record(tx, ctx, { action: 'finance.policy_saved', entityType: 'finance_settings', entityId: ctx.orgId,
        metadata: { before: { cogsMethod: before.cogsMethod, feesMethod: before.feesMethod }, after: input } });
      return this.policy(tx, ctx.orgId);
    });
  }

  /** Accounting connections the finance team can map and push to (no credentials, only status and mapped roles). */
  connections(ctx: TenantContext) {
    return this.db.scoped(ctx, async (tx) => {
      const rows = await tx.query<any>(
        `select id, provider, status, environment, config from integration_connections where org_id = $1 and category = 'accounting' order by created_at`, [ctx.orgId]);
      return { items: rows.map((r) => ({ id: r.id, provider: r.provider, status: r.status, environment: r.environment,
        mappedRoles: Object.keys(r.config?.accounts ?? {}).length })) };
    });
  }

  /** Account mapping of an accounting connection (config.accounts) and the roles the period's journals need. */
  mapping(ctx: TenantContext, connectionId: string, period?: { from: string; to: string }) {
    return this.db.scoped(ctx, async (tx) => {
      const conn = await tx.maybeOne<any>(`select id, provider, config from integration_connections where id = $1 and org_id = $2 and category = 'accounting'`, [connectionId, ctx.orgId]);
      if (!conn) throw notFound('Accounting connection');
      const accounts = (conn.config?.accounts ?? {}) as Record<string, string>;
      let needed: string[] = [];
      if (period) {
        const { entries } = await this.buildEntries(tx, ctx.orgId, period);
        needed = [...new Set(entries.flatMap((e) => e.lines.map((l) => l.role as string)))].sort();
      }
      return { connectionId: conn.id, provider: conn.provider, accounts, needed, missing: needed.filter((r) => !accounts[r]) };
    });
  }

  saveMapping(ctx: TenantContext, connectionId: string, accounts: Record<string, string | undefined>) {
    return this.db.scoped(ctx, async (tx) => {
      const conn = await tx.maybeOne<any>(`select id, config from integration_connections where id = $1 and org_id = $2 and category = 'accounting' for update`, [connectionId, ctx.orgId]);
      if (!conn) throw notFound('Accounting connection');
      const clean = Object.fromEntries(Object.entries(accounts).filter(([, v]) => typeof v === 'string' && v.trim()).map(([k, v]) => [k, (v as string).trim()]));
      await tx.query(`update integration_connections set config = jsonb_set(config, '{accounts}', $2::jsonb) where id = $1`, [connectionId, JSON.stringify(clean)]);
      await this.audit.record(tx, ctx, { action: 'accounting.mapping_saved', entityType: 'integration_connection', entityId: connectionId,
        metadata: { before: conn.config?.accounts ?? {}, after: clean } });
      return { connectionId, accounts: clean };
    });
  }

  listPayouts(ctx: TenantContext, q: { from: string; to: string; branchId?: string }): Promise<{ items: FinancePayout[] }> {
    if (q.branchId) ctx.assertBranch(q.branchId);
    return this.db.scoped(ctx, async (tx) => {
      const rows = await tx.query<any>(
        `select * from finance_payouts where org_id = $1 and paid_on between $2::date and $3::date and ($4::uuid is null or branch_id = $4) order by paid_on desc, created_at desc`,
        [ctx.orgId, q.from, q.to, q.branchId ?? null]);
      return { items: rows.map(toPayout) };
    });
  }

  recordPayout(ctx: TenantContext, input: { provider: string; clearing: 'card' | 'wallet'; paidOn: string; amountMinor: number; feeMinor: number; reference?: string | null; branchId?: string | null }) {
    if (input.branchId) ctx.assertBranch(input.branchId);
    return this.db.scoped(ctx, async (tx) => {
      const org = await tx.one<{ currency: string }>('select currency from organizations where id = $1', [ctx.orgId]);
      const row = await tx.one<any>(
        `insert into finance_payouts(org_id, branch_id, provider, clearing, paid_on, amount_minor, fee_minor, currency, reference, created_by)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) returning *`,
        [ctx.orgId, input.branchId ?? null, input.provider, input.clearing, input.paidOn, input.amountMinor, input.feeMinor, org.currency, input.reference ?? null, ctx.userId]);
      await this.audit.record(tx, ctx, { action: 'finance.payout_recorded', entityType: 'finance_payout', entityId: row.id,
        metadata: { provider: input.provider, amountMinor: input.amountMinor, feeMinor: input.feeMinor, paidOn: input.paidOn } });
      return toPayout(row);
    });
  }


  async push(ctx: TenantContext, body: { connectionId: string; from: string; to: string; branchId?: string; key: string }) {
    if (body.branchId) ctx.assertBranch(body.branchId);
    const existing = await this.db.scoped(ctx, (tx) => tx.maybeOne<any>('select * from accounting_pushes where org_id = $1 and idempotency_key = $2', [ctx.orgId, body.key]));
    if (existing) return this.toPush(existing);
    const conn = await this.db.scoped(ctx, (tx) => tx.maybeOne<any>(
      `select id, provider, status from integration_connections where id = $1 and category = 'accounting'`, [body.connectionId]));
    if (!conn) throw notFound('Accounting connection');
    const adapter = accountingAdapter(conn.provider);
    if (!adapter) throw invalid('unsupported_provider', `Resuto cannot push to ${conn.provider}`);
    if (!['connected', 'sandbox'].includes(conn.status)) throw conflict('not_connected', 'Finish connecting this accounting system first');
    const creds = await this.providers.credentials(ctx.orgId, conn.id);
    if (!creds) throw conflict('not_connected', 'The connection has no usable credentials');
    const { entries } = await this.db.scoped(ctx, (tx) => this.buildEntries(tx, ctx.orgId, body));
    const results: Array<{ reference: string; externalId: string | null; error: string | null }> = [];
    for (const e of entries) {
      try {
        const r = await adapter.pushJournalEntry({ environment: creds.environment, credentials: creds.credentials, config: creds.config, fetch }, e);
        results.push({ reference: e.reference, externalId: r.externalId, error: null });
      } catch (error) {
        this.logger.warn(`accounting push ${e.reference} failed: ${(error as Error).message}`);
        results.push({ reference: e.reference, externalId: null, error: (error as Error).message.slice(0, 300) });
      }
    }
    const ok = results.filter((r) => !r.error).length;
    const status = !entries.length || ok === results.length ? 'succeeded' : ok ? 'partial' : 'failed';
    return this.db.scoped(ctx, async (tx) => {
      const row = await tx.one<any>(
        `insert into accounting_pushes(org_id, connection_id, provider, kind, period_start, period_end, status, entries, external_ids, error, idempotency_key, created_by)
         values ($1, $2, $3, 'journal', $4, $5, $6, $7, $8, $9, $10, $11)
         on conflict (org_id, idempotency_key) do update set idempotency_key = excluded.idempotency_key returning *`,
        [ctx.orgId, conn.id, conn.provider, body.from, body.to, status,
          JSON.stringify(entries.map((e) => ({ reference: e.reference, date: e.date, debitMinor: e.lines.reduce((s, l) => s + l.debitMinor, 0) }))),
          JSON.stringify(results), results.find((r) => r.error)?.error ?? null, body.key, ctx.userId]);
      await this.audit.record(tx, ctx, { action: 'accounting.pushed', entityType: 'accounting_push', entityId: row.id, metadata: { provider: conn.provider, status, entries: entries.length } });
      return this.toPush(row);
    });
  }

  async listPushes(ctx: TenantContext) {
    return this.db.scoped(ctx, async (tx) => {
      const rows = await tx.query<any>('select * from accounting_pushes where org_id = $1 order by created_at desc limit 50', [ctx.orgId]);
      return { items: rows.map((r) => this.toPush(r)), providers: Object.values(ACCOUNTING_ADAPTERS).map((a) => a.descriptor) };
    });
  }

  private toPush(r: any) {
    return { id: r.id, connectionId: r.connection_id, provider: r.provider, kind: r.kind, periodStart: r.period_start, periodEnd: r.period_end, status: r.status,
      entries: r.entries, results: r.external_ids, error: r.error, createdAt: new Date(r.created_at).toISOString() };
  }
}

function toPayout(r: any): FinancePayout {
  return { id: r.id, provider: r.provider, clearing: r.clearing, paidOn: typeof r.paid_on === 'string' ? r.paid_on : new Date(r.paid_on).toISOString().slice(0, 10),
    amountMinor: Number(r.amount_minor), feeMinor: Number(r.fee_minor), currency: r.currency, reference: r.reference, branchId: r.branch_id, createdAt: new Date(r.created_at).toISOString() };
}
