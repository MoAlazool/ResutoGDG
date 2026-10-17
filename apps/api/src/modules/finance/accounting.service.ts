import { Injectable, Logger } from '@nestjs/common';
import { accountingAdapter, ACCOUNTING_ADAPTERS, type AccountRole, type JournalEntry, type JournalLine } from '@resuto/integrations';
import type { TenantContext } from '../../common/auth/context';
import { DbService, type Tx } from '../../common/db/db.service';
import { conflict, invalid, notFound } from '../../common/errors/domain-error';
import { AuditService } from '../../common/platform/audit.service';
import { PaymentProvidersService } from '../payments/providers.service';

const METHOD_ACCOUNT: Record<string, AccountRole> = {
  cash: 'cash', cod: 'cash', card: 'card_clearing', test: 'card_clearing', wallet: 'wallet_clearing', instapay: 'bank', bank_transfer: 'bank', deposit_credit: 'receivables',
};

/**
 * Daily sales journals for the restaurant's accounting system (Wafeq, Qoyod,
 * Odoo). Each business day becomes one balanced entry: debits by settlement
 * method (+ receivables for what is unpaid) against sales ex VAT and VAT output;
 * refunds as separate balanced lines.
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
    const days = await tx.query<any>(
      `select business_date::text as d, sum(total_minor)::bigint as total, sum(tax_minor)::bigint as tax, count(*)::int as n from orders
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
      if (Number(day.total) - Number(day.tax) > 0) lines.push({ role: 'sales', description: `Sales ex VAT (${day.n} orders)`, debitMinor: 0, creditMinor: Number(day.total) - Number(day.tax) });
      if (Number(day.tax) > 0) lines.push({ role: 'vat_output', description: 'VAT on sales', debitMinor: 0, creditMinor: Number(day.tax) });
      for (const r of alloc.filter((x) => x.d === day.d && x.kind === 'refund')) {
        const v = -Number(r.amount);
        if (v <= 0) continue;
        lines.push({ role: 'refunds', description: `Refunds (${r.method})`, debitMinor: v, creditMinor: 0 });
        lines.push({ role: METHOD_ACCOUNT[r.method] ?? 'receivables', description: `Refunds paid out (${r.method})`, debitMinor: 0, creditMinor: v });
      }
      if (unpaid < 0) lines.push({ role: 'receivables', description: 'Overpayment adjustment', debitMinor: 0, creditMinor: -unpaid });
      if (!lines.length) continue;
      entries.push({ reference: `RSJ-${org.slug}-${day.d}${q.branchId ? `-${q.branchId.slice(0, 8)}` : ''}`, date: day.d, currency: org.currency, memo: `Resuto daily sales ${day.d}`, lines });
    }
    return { currency: org.currency, entries };
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
