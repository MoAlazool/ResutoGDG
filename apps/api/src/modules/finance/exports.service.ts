import { Injectable } from '@nestjs/common';
import type { CreateExport } from '@resuto/contracts';
import { accountingMinorToDecimal } from '@resuto/integrations';
import type { TenantContext } from '../../common/auth/context';
import { sha256 } from '../../common/crypto/hash';
import { DbService, type Tx } from '../../common/db/db.service';
import { DomainError, notFound } from '../../common/errors/domain-error';
import { AuditService } from '../../common/platform/audit.service';
import { FinanceService } from './finance.service';

/** CSV cell: quoted when needed; text that a spreadsheet would evaluate as a formula is neutralised. */
export function csvCell(v: unknown, numeric = false): string {
  if (v === null || v === undefined) return '';
  let s = String(v);
  if (!numeric && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
const amt = (m: number | null | undefined) => (m === null || m === undefined ? '' : accountingMinorToDecimal(Number(m)));

interface Sheet { header: string[]; rows: Array<Array<{ v: unknown; n?: boolean }>> }
const toCsv = (s: Sheet) => [s.header.map((h) => csvCell(h)).join(','), ...s.rows.map((r) => r.map((c) => csvCell(c.v, c.n)).join(','))].join('\r\n') + '\r\n';
const n = (v: unknown) => ({ v, n: true });
const tx_ = (v: unknown) => ({ v });

/** Finance CSV exports. Every file is stored with its SHA-256 checksum and re-served byte for byte. */
@Injectable()
export class ExportsService {
  constructor(private readonly db: DbService, private readonly finance: FinanceService, private readonly audit: AuditService) {}

  async create(ctx: TenantContext, body: CreateExport) {
    if (body.branchId) ctx.assertBranch(body.branchId);
    if ((Date.parse(body.to) - Date.parse(body.from)) / 864e5 > 366) throw new DomainError('period_too_long', 'Export at most one year at a time', 422);
    return this.db.scoped(ctx, async (tx) => {
      const sheet = await this.build(tx, body);
      const content = toCsv(sheet);
      const checksum = sha256(content);
      const org = await tx.one<any>('select slug from organizations where id = $1', [ctx.orgId]);
      const filename = `${org.slug}-${body.kind}-${body.from}_${body.to}.csv`;
      const row = await tx.one<any>(
        `insert into financial_exports(org_id, kind, format, period_start, period_end, row_count, checksum, destination, status, created_by, branch_id, filename, content)
         values ($1, $2, 'csv', $3, $4, $5, $6, 'download', 'completed', $7, $8, $9, $10) returning id, created_at`,
        [ctx.orgId, body.kind, body.from, body.to, sheet.rows.length, checksum, ctx.userId, body.branchId ?? null, filename, content]);
      await this.audit.record(tx, ctx, { action: 'finance.export_created', entityType: 'financial_export', entityId: row.id, branchId: body.branchId ?? null,
        metadata: { kind: body.kind, from: body.from, to: body.to, rows: sheet.rows.length, checksum } });
      return { id: row.id, kind: body.kind, format: 'csv', filename, rowCount: sheet.rows.length, checksum, periodStart: body.from, periodEnd: body.to,
        createdAt: new Date(row.created_at).toISOString(), content };
    });
  }

  async list(ctx: TenantContext) {
    return this.db.scoped(ctx, async (tx) => {
      const rows = await tx.query<any>(
        `select id, kind, format, filename, row_count, checksum, period_start, period_end, branch_id, created_by, created_at from financial_exports
          where org_id = $1 order by created_at desc limit 100`, [ctx.orgId]);
      return { items: rows.map((r) => ({ id: r.id, kind: r.kind, format: r.format, filename: r.filename, rowCount: r.row_count, checksum: r.checksum,
        periodStart: r.period_start, periodEnd: r.period_end, branchId: r.branch_id, createdBy: r.created_by, createdAt: new Date(r.created_at).toISOString() })) };
    });
  }

  async download(ctx: TenantContext, id: string) {
    return this.db.scoped(ctx, async (tx) => {
      const r = await tx.maybeOne<any>('select filename, content, checksum, branch_id from financial_exports where id = $1', [id]);
      if (!r || r.content === null) throw notFound('Export');
      ctx.assertBranch(r.branch_id);
      if (sha256(r.content) !== r.checksum) throw new DomainError('export_corrupted', 'The stored export does not match its checksum', 500);
      return { filename: r.filename as string, content: r.content as string, checksum: r.checksum as string };
    });
  }

  private async build(tx: Tx, p: CreateExport): Promise<Sheet> {
    const b = p.branchId ?? null;
    switch (p.kind) {
      case 'sales': {
        const rows = await tx.query<any>(
          `select o.business_date::text as d, o.number, br.code as branch, o.channel, o.fulfillment, o.status, o.payment_status, o.currency, o.subtotal_minor,
                  o.discount_minor, o.delivery_fee_minor, o.service_charge_minor, o.tax_minor, o.tax_inclusive, o.total_minor, o.paid_minor, o.refunded_minor, o.public_ref
             from orders o join branches br on br.id = o.branch_id
            where o.org_id = app.current_org_id() and o.business_date between $1::date and $2::date and ($3::uuid is null or o.branch_id = $3)
            order by o.business_date, br.code, o.placed_at`, [p.from, p.to, b]);
        return { header: ['business_date', 'order_number', 'order_ref', 'branch', 'channel', 'fulfillment', 'status', 'payment_status', 'currency', 'subtotal', 'discount',
          'delivery_fee', 'service_charge', 'vat', 'vat_inclusive', 'total', 'paid', 'refunded'],
        rows: rows.map((r) => [tx_(r.d), tx_(r.number), tx_(r.public_ref), tx_(r.branch), tx_(r.channel), tx_(r.fulfillment), tx_(r.status), tx_(r.payment_status), tx_(r.currency),
          n(amt(r.subtotal_minor)), n(amt(r.discount_minor)), n(amt(r.delivery_fee_minor)), n(amt(r.service_charge_minor)), n(amt(r.tax_minor)), tx_(r.tax_inclusive),
          n(amt(r.total_minor)), n(amt(r.paid_minor)), n(amt(r.refunded_minor))]) };
      }
      case 'payments': {
        const rows = await tx.query<any>(
          `select p.id, coalesce(p.captured_at, p.created_at) as at, br.code as branch, p.method, p.provider, p.provider_payment_id, p.status, p.currency, p.amount_minor,
                  p.fee_minor, p.net_minor, p.refunded_minor, p.is_test,
                  (select string_agg(distinct o.number, ' ') from payment_allocations a join orders o on o.id = a.order_id where a.payment_id = p.id) as orders
             from payments p join branches br on br.id = p.branch_id join organizations org on org.id = p.org_id
            where p.org_id = app.current_org_id() and (coalesce(p.captured_at, p.created_at) at time zone org.timezone)::date between $1::date and $2::date
              and ($3::uuid is null or p.branch_id = $3) order by 2`, [p.from, p.to, b]);
        return { header: ['captured_at', 'payment_id', 'branch', 'method', 'provider', 'provider_reference', 'status', 'currency', 'amount', 'fee', 'net', 'refunded', 'test', 'orders'],
          rows: rows.map((r) => [tx_(new Date(r.at).toISOString()), tx_(r.id), tx_(r.branch), tx_(r.method), tx_(r.provider), tx_(r.provider_payment_id), tx_(r.status), tx_(r.currency),
            n(amt(r.amount_minor)), n(amt(r.fee_minor)), n(amt(r.net_minor)), n(amt(r.refunded_minor)), tx_(r.is_test), tx_(r.orders)]) };
      }
      case 'expenses': {
        const rows = await tx.query<any>(
          `select e.incurred_on::text as d, c.name as category, c.kind, e.vendor, e.description, e.currency, e.amount_minor, e.tax_minor, e.payment_method,
                  br.code as branch, e.external_ref, e.receipt_media_id is not null as has_receipt, e.id
             from expenses e join expense_categories c on c.id = e.category_id left join branches br on br.id = e.branch_id
            where e.org_id = app.current_org_id() and e.incurred_on between $1::date and $2::date and ($3::uuid is null or e.branch_id = $3)
            order by e.incurred_on, e.id`, [p.from, p.to, b]);
        return { header: ['incurred_on', 'category', 'kind', 'vendor', 'description', 'currency', 'amount', 'input_vat', 'net', 'payment_method', 'branch', 'external_ref', 'receipt', 'expense_id'],
          rows: rows.map((r) => [tx_(r.d), tx_(r.category), tx_(r.kind), tx_(r.vendor), tx_(r.description), tx_(r.currency), n(amt(r.amount_minor)), n(amt(r.tax_minor)),
            n(amt(r.amount_minor - r.tax_minor)), tx_(r.payment_method), tx_(r.branch ?? 'organisation'), tx_(r.external_ref), tx_(r.has_receipt), tx_(r.id)]) };
      }
      case 'pnl': {
        const pl = await this.finance.pnlTx(tx, { from: p.from, to: p.to, branchId: p.branchId });
        const L = pl.lines;
        const lines: Array<[string, number]> = [
          ['gross_sales', L.grossSalesMinor], ['discounts', -L.discountsMinor], ['refunds', -L.refundsMinor], ['vat_collected', -L.vatMinor],
          ['net_revenue', L.netRevenueMinor], ['cogs_from_sales', -L.cogsFromSalesMinor], ['cogs_expenses', -L.cogsExpensesMinor], ['gross_profit', L.grossProfitMinor],
          ...Object.entries(L.operatingExpensesByKind).sort().map(([k, v]) => [`opex_${k}`, -v] as [string, number]),
          ['payment_fees', -L.paymentFeesMinor], ['operating_profit', L.operatingProfitMinor],
        ];
        return { header: ['line', 'amount', 'currency'], rows: lines.map(([k, v]) => [tx_(k), n(amt(v)), tx_(pl.currency)]) };
      }
      case 'tax': {
        const out = await tx.query<any>(
          `select o.business_date::text as d, sum(o.tax_minor)::bigint as tax, sum(o.total_minor)::bigint as total, sum(o.refunded_minor)::bigint as refunded,
                  sum(case when o.total_minor > 0 then round(o.tax_minor::numeric * o.refunded_minor / o.total_minor) else 0 end)::bigint as refund_tax
             from orders o where o.org_id = app.current_org_id() and o.status not in ('cancelled', 'awaiting_payment')
              and o.business_date between $1::date and $2::date and ($3::uuid is null or o.branch_id = $3) group by 1 order by 1`, [p.from, p.to, b]);
        const input = await tx.one<any>(
          `select coalesce(sum(tax_minor), 0)::bigint as tax from expenses where org_id = app.current_org_id() and incurred_on between $1::date and $2::date
              and ($3::uuid is null or branch_id = $3)`, [p.from, p.to, b]);
        const rows = out.map((r) => [tx_(r.d), tx_('output_vat'), n(amt(Number(r.total) - Number(r.refunded))), n(amt(Number(r.tax) - Number(r.refund_tax)))]);
        const outputTotal = out.reduce((s, r) => s + Number(r.tax) - Number(r.refund_tax), 0);
        rows.push([tx_(`${p.from}..${p.to}`), tx_('input_vat_expenses'), n(''), n(amt(-Number(input.tax)))]);
        rows.push([tx_(`${p.from}..${p.to}`), tx_('net_vat_payable'), n(''), n(amt(outputTotal - Number(input.tax)))]);
        return { header: ['date', 'line', 'taxable_amount_incl_vat', 'vat'], rows };
      }
    }
  }
}
