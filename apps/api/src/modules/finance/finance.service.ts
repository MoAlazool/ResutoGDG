import { Injectable } from '@nestjs/common';
import type { FinancePeriod, ProfitAndLoss, RevenueOverview, RevenueTotals } from '@resuto/contracts';
import type { TenantContext } from '../../common/auth/context';
import { DbService, type Tx } from '../../common/db/db.service';

/** Half-away-from-zero integer division (same rounding as contracts money helpers). */
export function roundDiv(n: number, d: number): number {
  if (d === 0) return 0;
  const q = Math.trunc(n / d);
  const r = n - q * d;
  return Math.abs(r) * 2 >= Math.abs(d) ? q + Math.sign(n) * Math.sign(d) : q;
}
const bp = (part: number, whole: number) => (whole > 0 ? roundDiv(part * 10_000, whole) : null);

const zero = (): RevenueTotals => ({ orderCount: 0, grossMinor: 0, discountsMinor: 0, refundsMinor: 0, netMinor: 0, vatMinor: 0, netExVatMinor: 0, collectedMinor: 0 });

interface OrderRow { id: string; branch_id: string; d: string; total_minor: number; discount_minor: number; refunded_minor: number; tax_minor: number; paid_minor: number }

export const METHODOLOGY = [
  'Revenue is recognised on the order\'s business date for every order that is not cancelled and not awaiting online payment.',
  'Gross sales = order totals before discounts (menu prices, delivery and service charges, VAT included). Net = gross − discounts − refunds.',
  'Refunds are attributed to the original order\'s business date. The VAT inside a refund is reversed proportionally (tax × refunded ÷ total, rounded half away from zero).',
  'Net revenue excludes VAT collected, which is a liability to the tax authority, not income.',
  'COGS = recorded cost of the items sold (order_lines.cost_minor, the line\'s total cost at order time) + expenses in categories of kind "cogs". If you record ingredient purchases as COGS expenses and also maintain item costs, both are counted: use one method.',
  'Expenses count net of the input VAT recorded on them (amount − tax), on their incurred date. Branch filters exclude organisation-wide expenses.',
  'Payment fees = fees reported by payment providers on payments captured in the period + expenses of kind "fees".',
  'Operating profit = net revenue − COGS − operating expenses − payment fees. All amounts are integer minor units; no estimates are added.',
];

/**
 * Deterministic finance read models over orders, payments and expenses. No
 * model or estimate is involved: every number is a sum over stored records.
 */
@Injectable()
export class FinanceService {
  constructor(private readonly db: DbService) {}

  private async orders(tx: Tx, p: FinancePeriod): Promise<OrderRow[]> {
    return tx.query<OrderRow>(
      `select id, branch_id, business_date::text as d, total_minor, discount_minor, refunded_minor, tax_minor, paid_minor from orders
        where org_id = app.current_org_id() and status not in ('cancelled', 'awaiting_payment') and business_date between $1::date and $2::date
          and ($3::uuid is null or branch_id = $3) order by business_date, placed_at`, [p.from, p.to, p.branchId ?? null]);
  }

  private add(t: RevenueTotals, o: OrderRow) {
    const refundVat = o.total_minor > 0 ? roundDiv(o.tax_minor * o.refunded_minor, o.total_minor) : 0;
    const vat = o.tax_minor - refundVat;
    const net = o.total_minor - o.refunded_minor;
    t.orderCount++;
    t.grossMinor += o.total_minor + o.discount_minor;
    t.discountsMinor += o.discount_minor;
    t.refundsMinor += o.refunded_minor;
    t.netMinor += net;
    t.vatMinor += vat;
    t.netExVatMinor += net - vat;
    t.collectedMinor += o.paid_minor - o.refunded_minor;
  }

  async overview(ctx: TenantContext, p: FinancePeriod): Promise<RevenueOverview> {
    if (p.branchId) ctx.assertBranch(p.branchId);
    return this.db.scoped(ctx, (tx) => this.overviewTx(tx, p));
  }

  async overviewTx(tx: Tx, p: FinancePeriod): Promise<RevenueOverview> {
    return (await this.overviewData(tx, p)).overview;
  }

  private async overviewData(tx: Tx, p: FinancePeriod): Promise<{ overview: RevenueOverview; unpaid: number }> {
    const org = await tx.one<any>('select currency from organizations where id = app.current_org_id()');
    const rows = await this.orders(tx, p);
    const totals = zero();
    const byDay = new Map<string, RevenueTotals>();
    const byBranch = new Map<string, RevenueTotals>();
    for (const o of rows) {
      this.add(totals, o);
      this.add(byDay.get(o.d) ?? byDay.set(o.d, zero()).get(o.d)!, o);
      this.add(byBranch.get(o.branch_id) ?? byBranch.set(o.branch_id, zero()).get(o.branch_id)!, o);
    }
    const branches = await tx.query<any>('select id, name from branches where org_id = app.current_org_id()');
    const methods = await tx.query<any>(
      `select p.method::text as method,
              coalesce(sum(a.amount_minor) filter (where a.kind = 'payment'), 0)::bigint as collected,
              coalesce(-sum(a.amount_minor) filter (where a.kind = 'refund'), 0)::bigint as refunded,
              count(distinct p.id)::int as n
         from payment_allocations a join payments p on p.id = a.payment_id join orders o on o.id = a.order_id
        where o.org_id = app.current_org_id() and o.status not in ('cancelled', 'awaiting_payment') and o.business_date between $1::date and $2::date
          and ($3::uuid is null or o.branch_id = $3)
        group by 1 order by 2 desc`, [p.from, p.to, p.branchId ?? null]);
    const warnings: string[] = [];
    const unpaid = rows.filter((o) => o.paid_minor - o.refunded_minor < o.total_minor - o.refunded_minor);
    if (unpaid.length) warnings.push(`${unpaid.length} order(s) in this period are not fully paid; revenue counts them, collected amounts do not.`);
    if (!rows.length) warnings.push('No orders in this period.');
    const overview: RevenueOverview = {
      period: { from: p.from, to: p.to, branchId: p.branchId ?? null }, currency: org.currency, totals,
      byDay: [...byDay.entries()].map(([date, t]) => ({ date, ...t })),
      byBranch: [...byBranch.entries()].map(([branchId, t]) => ({ branchId, name: branches.find((b) => b.id === branchId)?.name ?? '', ...t })),
      byMethod: methods.map((m) => ({ method: m.method, collectedMinor: Number(m.collected), refundedMinor: Number(m.refunded), count: m.n })),
      warnings,
    };
    return { overview, unpaid: unpaid.length };
  }

  async cogs(tx: Tx, p: FinancePeriod) {
    const sales = await tx.one<any>(
      `select coalesce(sum(l.cost_minor), 0)::bigint as cogs, count(*) filter (where l.cost_minor is null)::int as no_cost,
              coalesce(sum(l.line_total_minor) filter (where l.cost_minor is null), 0)::bigint as sales_no_cost
         from order_lines l join orders o on o.id = l.order_id
        where o.org_id = app.current_org_id() and o.status not in ('cancelled', 'awaiting_payment') and o.business_date between $1::date and $2::date
          and ($3::uuid is null or o.branch_id = $3)`, [p.from, p.to, p.branchId ?? null]);
    return { fromSales: Number(sales.cogs), linesWithoutCost: sales.no_cost, salesWithoutCostMinor: Number(sales.sales_no_cost) };
  }

  async expensesByKind(tx: Tx, p: FinancePeriod): Promise<Record<string, number>> {
    const rows = await tx.query<any>(
      `select c.kind, coalesce(sum(e.amount_minor - e.tax_minor), 0)::bigint as total from expenses e join expense_categories c on c.id = e.category_id
        where e.org_id = app.current_org_id() and e.incurred_on between $1::date and $2::date and ($3::uuid is null or e.branch_id = $3)
        group by c.kind`, [p.from, p.to, p.branchId ?? null]);
    return Object.fromEntries(rows.map((r) => [r.kind, Number(r.total)]));
  }

  async paymentFees(tx: Tx, p: FinancePeriod) {
    const rows = await tx.query<any>(
      `select p.provider, p.method::text as method, coalesce(sum(p.fee_minor), 0)::bigint as fees, count(*)::int as n,
              count(*) filter (where p.fee_minor is null and p.provider not in ('manual'))::int as unknown_fee,
              count(*) filter (where p.is_test)::int as test, coalesce(sum(p.amount_minor), 0)::bigint as volume
         from payments p join organizations org on org.id = p.org_id
        where p.org_id = app.current_org_id() and p.status in ('succeeded', 'partially_refunded', 'refunded')
          and (coalesce(p.captured_at, p.created_at) at time zone org.timezone)::date between $1::date and $2::date
          and ($3::uuid is null or p.branch_id = $3)
        group by 1, 2 order by 1, 2`, [p.from, p.to, p.branchId ?? null]);
    const items = rows.map((r) => ({ provider: r.provider, method: r.method, feesMinor: Number(r.fees), payments: r.n, volumeMinor: Number(r.volume), unknownFee: r.unknown_fee, test: r.test }));
    return {
      items,
      totalFeesMinor: items.reduce((s, i) => s + i.feesMinor, 0),
      paymentsWithUnknownFee: items.reduce((s, i) => s + i.unknownFee, 0),
      testPayments: items.reduce((s, i) => s + i.test, 0),
    };
  }

  async fees(ctx: TenantContext, p: FinancePeriod) {
    if (p.branchId) ctx.assertBranch(p.branchId);
    return this.db.scoped(ctx, (tx) => this.paymentFees(tx, p));
  }

  async pnl(ctx: TenantContext, p: FinancePeriod): Promise<ProfitAndLoss> {
    if (p.branchId) ctx.assertBranch(p.branchId);
    return this.db.scoped(ctx, (tx) => this.pnlTx(tx, p));
  }

  async pnlTx(tx: Tx, p: FinancePeriod): Promise<ProfitAndLoss> {
    const { overview: rev, unpaid } = await this.overviewData(tx, p);
    const cogs = await this.cogs(tx, p);
    const byKind = await this.expensesByKind(tx, p);
    const fees = await this.paymentFees(tx, p);
    const cogsExpenses = byKind.cogs ?? 0;
    const opexByKind = Object.fromEntries(Object.entries(byKind).filter(([k]) => k !== 'cogs' && k !== 'fees'));
    const opex = Object.values(opexByKind).reduce((s, v) => s + v, 0);
    const paymentFees = fees.totalFeesMinor + (byKind.fees ?? 0);
    const netRevenue = rev.totals.netExVatMinor;
    const cogsTotal = cogs.fromSales + cogsExpenses;
    const grossProfit = netRevenue - cogsTotal;
    const operatingProfit = grossProfit - opex - paymentFees;
    const warnings = rev.warnings.filter((w) => !w.startsWith('No orders'));
    if (cogs.linesWithoutCost) warnings.push(`${cogs.linesWithoutCost} sold line(s) have no recorded cost; COGS is understated for those items.`);
    if (cogs.fromSales > 0 && cogsExpenses > 0) warnings.push('Both item costs and COGS expenses are recorded; make sure ingredient purchases are not counted twice.');
    if (fees.paymentsWithUnknownFee) warnings.push(`${fees.paymentsWithUnknownFee} provider payment(s) have no fee reported yet; run reconciliation to capture fees.`);
    if (fees.testPayments) warnings.push(`${fees.testPayments} sandbox (test) payment(s) are in this period.`);
    if (p.branchId) warnings.push('Organisation-wide expenses (no branch) are excluded from a single-branch P&L.');
    if (!rev.totals.orderCount) warnings.push('No orders in this period.');
    return {
      period: rev.period, currency: rev.currency,
      lines: {
        grossSalesMinor: rev.totals.grossMinor, discountsMinor: rev.totals.discountsMinor, refundsMinor: rev.totals.refundsMinor, vatMinor: rev.totals.vatMinor,
        netRevenueMinor: netRevenue, cogsFromSalesMinor: cogs.fromSales, cogsExpensesMinor: cogsExpenses, cogsMinor: cogsTotal, grossProfitMinor: grossProfit,
        operatingExpensesMinor: opex, operatingExpensesByKind: opexByKind, paymentFeesMinor: paymentFees, operatingProfitMinor: operatingProfit,
      },
      grossMarginBp: bp(grossProfit, netRevenue), operatingMarginBp: bp(operatingProfit, netRevenue),
      methodology: METHODOLOGY,
      coverage: { linesWithoutCost: cogs.linesWithoutCost, salesWithoutCostMinor: cogs.salesWithoutCostMinor, unpaidOrders: unpaid,
        paymentsWithUnknownFee: fees.paymentsWithUnknownFee, testPayments: fees.testPayments },
      warnings,
    };
  }

  async reconciliationSummary(ctx: TenantContext, p: FinancePeriod) {
    return this.db.scoped(ctx, async (tx) => {
      const runs = await tx.query<any>(
        `select id, provider, source, totals, period_start, period_end, created_at from reconciliation_runs
          where org_id = $1 and period_start::date <= $3::date and period_end::date >= $2::date and ($4::uuid is null or branch_id = $4 or branch_id is null)
          order by created_at desc limit 100`, [ctx.orgId, p.from, p.to, p.branchId ?? null]);
      const open = await tx.one<any>(
        `select count(*)::int as n from reconciliation_items i join reconciliation_runs r on r.id = i.run_id
          where r.org_id = $1 and i.status <> 'matched' and i.resolution = 'open'`, [ctx.orgId]);
      return {
        runs: runs.map((r) => ({ id: r.id, provider: r.provider, source: r.source, totals: r.totals, periodStart: new Date(r.period_start).toISOString(),
          periodEnd: new Date(r.period_end).toISOString(), createdAt: new Date(r.created_at).toISOString() })),
        openExceptions: open.n,
      };
    });
  }

  /**
   * Deterministic insights: monthly gross/operating margin for the six months
   * ending with `to`, and the expense category growing fastest versus the
   * previous period of the same length.
   */
  async insights(ctx: TenantContext, p: FinancePeriod) {
    if (p.branchId) ctx.assertBranch(p.branchId);
    return this.db.scoped(ctx, async (tx) => {
      const end = new Date(`${p.to}T00:00:00Z`);
      const months: Array<{ month: string; from: string; to: string }> = [];
      for (let i = 5; i >= 0; i--) {
        const start = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - i, 1));
        const last = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0));
        months.push({ month: start.toISOString().slice(0, 7), from: start.toISOString().slice(0, 10), to: last.toISOString().slice(0, 10) });
      }
      const trend = [];
      for (const m of months) {
        const pl = await this.pnlTx(tx, { from: m.from, to: m.to, branchId: p.branchId });
        trend.push({ month: m.month, netRevenueMinor: pl.lines.netRevenueMinor, grossProfitMinor: pl.lines.grossProfitMinor, operatingProfitMinor: pl.lines.operatingProfitMinor,
          grossMarginBp: pl.grossMarginBp, operatingMarginBp: pl.operatingMarginBp });
      }
      const withData = trend.filter((x) => x.grossMarginBp !== null);
      const firstM = withData[0], lastM = withData[withData.length - 1];
      const deltaBp = withData.length >= 2 ? lastM!.grossMarginBp! - firstM!.grossMarginBp! : null;
      const direction = deltaBp === null ? 'insufficient_data' : deltaBp > 50 ? 'improving' : deltaBp < -50 ? 'declining' : 'flat';

      const days = Math.round((Date.parse(p.to) - Date.parse(p.from)) / 864e5) + 1;
      const prevTo = new Date(Date.parse(p.from) - 864e5).toISOString().slice(0, 10);
      const prevFrom = new Date(Date.parse(p.from) - days * 864e5).toISOString().slice(0, 10);
      const byCat = async (from: string, to: string) => new Map((await tx.query<any>(
        `select c.id, c.name, c.name_ar, c.kind, coalesce(sum(e.amount_minor - e.tax_minor), 0)::bigint as total from expense_categories c
           left join expenses e on e.category_id = c.id and e.incurred_on between $1::date and $2::date and ($3::uuid is null or e.branch_id = $3)
          where c.org_id = app.current_org_id() group by c.id`, [from, to, p.branchId ?? null])).map((r) => [r.id, r]));
      const cur = await byCat(p.from, p.to);
      const prev = await byCat(prevFrom, prevTo);
      const growth = [...cur.values()].map((c) => {
        const before = Number(prev.get(c.id)?.total ?? 0), now = Number(c.total);
        return { categoryId: c.id, name: c.name, nameAr: c.name_ar, kind: c.kind, currentMinor: now, previousMinor: before, increaseMinor: now - before,
          growthBp: before > 0 ? roundDiv((now - before) * 10_000, before) : null };
      }).filter((g) => g.increaseMinor > 0)
        // Categories with prior spend rank by % growth; categories new this period (no base) come after them.
        .sort((a, b) => (a.growthBp === null) !== (b.growthBp === null) ? (a.growthBp === null ? 1 : -1)
          : (b.growthBp ?? 0) - (a.growthBp ?? 0) || b.increaseMinor - a.increaseMinor || a.name.localeCompare(b.name));
      return {
        marginTrend: { months: trend, direction, deltaBp },
        fastestGrowingExpense: growth[0] ?? null,
        comparedPeriod: { from: prevFrom, to: prevTo },
      };
    });
  }
}
