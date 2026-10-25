'use client';
import Link from 'next/link';
import { useState } from 'react';
import type { AnalyticsMeta, RevenueTotals } from '@resuto/contracts';
import { Badge, BarList, DataTable, EmptyState, Heatmap, LineChart, Notice, Skeleton, Stat } from '@resuto/ui';
import { Delta, LoadError, MetaPanel, qs, Section, useBranchName, useFormat, type Period } from '@/components/charts/insights';
import a from './analytics.module.css';
import { useT } from '@/lib/i18n/client';
import { useOrg } from '@/lib/org-context';
import { useApi } from '@/lib/use-api';

/** `compare` (sales only): the analytics API's comparison, from the Insights toolbar (default: the days just before). */
export interface PanelProps { period: Period; branchId: string; compare?: 'previous' | 'last_year' | 'none' }

function usePanel<T>(path: string, props: PanelProps | null, extra: Record<string, string | number | undefined> = {}) {
  const { org } = useOrg();
  return useApi<T & { meta: AnalyticsMeta }>(props
    ? `/o/${org.id}/analytics/${path}${qs({ from: props.period.from, to: props.period.to, branchId: props.branchId, ...extra })}` : null);
}

function Loading() {
  return <div className="card"><Skeleton lines={6} /></div>;
}

// ---------------------------------------------------------------------------
// Sales
// ---------------------------------------------------------------------------
interface Breakdown { key: string; label: string | null; orders: number; netMinor: number; averageOrderMinor: number; sharePct: number | null }
interface Summary {
  totals: RevenueTotals;
  comparison: null | { from: string; to: string; totals: RevenueTotals; changePct: Record<string, number | null> };
  byBranch: Breakdown[]; byChannel: Breakdown[]; byFulfillment: Breakdown[];
  byPaymentMethod: Array<{ method: string; collectedMinor: number; refundedMinor: number; netMinor: number }>;
  daily: Array<{ date: string; orders: number; netMinor: number }>;
  heatmap: Array<{ isoDow: number; hour: number; orders: number; netMinor: number }>;
}

export function SalesPanel(props: PanelProps) {
  const { t, dir } = useT();
  const f = useFormat();
  const branchName = useBranchName();
  const { data, error, loading, reload } = usePanel<Summary>('summary', props, { compare: props.compare });
  const lastYear = props.compare === 'last_year';
  const prevPath = data?.comparison ? { period: { ...props.period, from: data.comparison.from, to: data.comparison.to }, branchId: props.branchId } : null;
  const prev = usePanel<Summary>('summary', prevPath, { compare: 'none' });
  if (error) return <LoadError error={error} retry={reload} />;
  if (loading && !data) return <Loading />;
  if (!data) return null;
  const tot = data.totals;
  const ch = data.comparison?.changePct ?? {};
  const prevDaily = prevPath && prev.data ? prev.data.daily : null;
  const days = data.daily.length;
  return (
    <div className="stack gap-16">
      {tot.orders === 0 && <Notice>{t('insights.empty.period')}</Notice>}
      <div className="grid grid-4">
        <Stat label={t('insights.kpi.net')} value={f.money(tot.netMinor)} hint={<Delta value={ch.netMinor} />} />
        <Stat label={t('insights.kpi.netExVat')} value={f.money(tot.netExVatMinor)} hint={<Delta value={ch.netExVatMinor} />} />
        <Stat label={t('insights.kpi.orders')} value={f.num(tot.orders)} hint={<Delta value={ch.orders} />} />
        <Stat label={t('insights.kpi.aov')} value={f.money(tot.averageOrderMinor)} hint={<Delta value={ch.averageOrderMinor} />} />
        <Stat label={t('insights.kpi.gross')} value={f.money(tot.grossMinor)} />
        <Stat label={t('insights.kpi.discounts')} value={f.money(tot.discountsMinor)} />
        <Stat label={t('insights.kpi.refunds')} value={f.money(tot.refundsMinor)} hint={<Delta value={ch.refundsMinor} inverse />} />
        <Stat label={t('insights.kpi.vat')} value={f.money(tot.vatMinor)} hint={t('insights.kpi.cancelled', { count: tot.cancelledOrders })} />
      </div>
      {data.comparison && <p className="fine m-0">{t(lastYear ? 'insights.area.compareLastYear' : 'insights.compare.note', { from: f.date(data.comparison.from), to: f.date(data.comparison.to) })}</p>}
      <Section title={t('insights.sales.daily')}>
        <LineChart title={t('insights.sales.daily')} rtl={dir === 'rtl'} labels={data.daily.map((d) => f.date(d.date))}
          series={[{ name: t('insights.series.thisPeriod'), values: data.daily.map((d) => d.netMinor) },
            ...(prevDaily && prevDaily.length === days ? [{ name: t(lastYear ? 'insights.area.series.lastYear' : 'insights.series.previousPeriod'), values: prevDaily.map((d) => d.netMinor) }] : [])]}
          format={f.money} compactFormat={f.compactMoney} xLabel={t('insights.chart.date')} tableCaption={t('insights.chart.showTable')} />
      </Section>
      <div className="grid grid-2">
        <Section title={t('insights.sales.byChannel')}>
          <BarList format={f.money} empty={t('insights.empty.none')} items={data.byChannel.map((b) => ({ key: b.key, label: t(`insights.channel.${b.key}`), value: b.netMinor, hint: t('insights.ordersCount', { count: b.orders }) }))} />
        </Section>
        <Section title={t('insights.sales.byFulfillment')}>
          <BarList format={f.money} empty={t('insights.empty.none')} items={data.byFulfillment.map((b) => ({ key: b.key, label: t(`insights.fulfillment.${b.key}`), value: b.netMinor, hint: t('insights.ordersCount', { count: b.orders }) }))} />
        </Section>
        <Section title={t('insights.sales.byBranch')}>
          <BarList format={f.money} empty={t('insights.empty.none')} items={data.byBranch.map((b) => ({ key: b.key, label: branchName(b.key) !== '—' ? branchName(b.key) : b.label ?? '—', value: b.netMinor, hint: f.pct(b.sharePct) }))} />
        </Section>
        <Section title={t('insights.sales.byPayment')}>
          <BarList format={f.money} empty={t('insights.sales.noPayments')} items={data.byPaymentMethod.map((p) => ({ key: p.method, label: t(`insights.payment.${p.method}`), value: p.netMinor,
            hint: p.refundedMinor ? t('insights.sales.refundedHint', { value: f.money(p.refundedMinor) }) : undefined }))} />
        </Section>
      </div>
      <Section title={t('insights.sales.heatmap')}>
        <Heatmap title={t('insights.sales.heatmap')} cells={data.heatmap.map((h) => ({ isoDow: h.isoDow, hour: h.hour, value: h.netMinor, orders: h.orders }))}
          dayLabels={[1, 2, 3, 4, 5, 6, 7].map((d) => t(`insights.dow.${d}`))} format={f.money} tableCaption={t('insights.chart.showTable')}
          hourLabel={t('insights.chart.hour')} dayLabel={t('insights.chart.day')} />
      </Section>
      <MetaPanel meta={data.meta} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Products
// ---------------------------------------------------------------------------
interface ProductRow { productId: string; name: string; nameAr: string | null; quantity: number; revenueMinor: number; netExVatMinor: number;
  costData: 'complete' | 'partial' | 'none' | 'no_sales'; costMinor: number | null; grossMarginMinor: number | null; marginPct: number | null }
interface Products { top: ProductRow[]; topByQuantity: ProductRow[]; underperforming: ProductRow[];
  grossMargin: { netExVatMinor: number; costedNetExVatMinor: number; costMinor: number; grossMarginMinor: number | null; marginPct: number | null; costCoveragePct: number | null } }

export function ProductsPanel(props: PanelProps) {
  const { t, locale } = useT();
  const { org } = useOrg();
  const f = useFormat();
  const { data, error, loading, reload } = usePanel<Products>('products', props);
  if (error) return <LoadError error={error} retry={reload} />;
  if (loading && !data) return <Loading />;
  if (!data) return null;
  const g = data.grossMargin;
  const name = (p: ProductRow) => (locale === 'ar' && p.nameAr ? p.nameAr : p.name);
  const margin = (p: ProductRow) => p.costData === 'none' ? <Badge tone="warn">{t('insights.products.noCost')}</Badge>
    : p.costData === 'no_sales' ? '—'
      : <span className="num">{f.money(p.grossMarginMinor)} <span className="fine">({f.pct(p.marginPct)}){p.costData === 'partial' ? ` · ${t('insights.products.partialCost')}` : ''}</span></span>;
  const columns = [
    { key: 'name', header: t('insights.products.product'), render: (p: ProductRow) => name(p) },
    { key: 'qty', header: t('insights.products.qty'), align: 'end' as const, render: (p: ProductRow) => <span className="num">{f.num(p.quantity)}</span> },
    { key: 'rev', header: t('insights.products.revenue'), align: 'end' as const, render: (p: ProductRow) => <span className="num">{f.money(p.revenueMinor)}</span> },
    { key: 'net', header: t('insights.kpi.netExVat'), align: 'end' as const, render: (p: ProductRow) => <span className="num">{f.money(p.netExVatMinor)}</span> },
    { key: 'margin', header: t('insights.products.margin'), align: 'end' as const, render: margin },
  ];
  return (
    <div className="stack gap-16">
      <div className="grid grid-4">
        <Stat label={t('insights.kpi.netExVat')} value={f.money(g.netExVatMinor)} />
        <Stat label={t('insights.products.grossMargin')} value={g.grossMarginMinor === null ? '—' : f.money(g.grossMarginMinor)} hint={g.marginPct !== null ? f.pct(g.marginPct) : t('insights.products.noCost')} />
        <Stat label={t('insights.products.coverage')} value={f.pct(g.costCoveragePct)} tone={g.costCoveragePct !== null && g.costCoveragePct < 80 ? 'warn' : undefined}
          hint={t('insights.products.coverageHint')} />
        <Stat label={t('insights.products.cost')} value={f.money(g.costMinor)} />
      </div>
      {g.costCoveragePct !== null && g.costCoveragePct < 100 && (
        <Notice tone="warn">{t('insights.products.coverageNotice', { pct: f.pct(g.costCoveragePct) })} <Link href={`/dashboard/${org.id}/menu`}>{t('nav.menu')}</Link></Notice>
      )}
      <Section title={t('insights.products.top')}>
        <DataTable rows={data.top} rowKey={(p) => p.productId} columns={columns} empty={<EmptyState title={t('insights.empty.period')} />} />
      </Section>
      <Section title={t('insights.products.topQty')}>
        <BarList format={f.num} empty={t('insights.empty.none')} items={data.topByQuantity.map((p) => ({ key: p.productId, label: name(p), value: p.quantity }))} />
      </Section>
      <Section title={t('insights.products.under')}>
        <p className="fine">{t('insights.products.underHint')}</p>
        <DataTable rows={data.underperforming} rowKey={(p) => p.productId} columns={columns} empty={<EmptyState title={t('insights.empty.none')} />} />
      </Section>
      <MetaPanel meta={data.meta} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Customers
// ---------------------------------------------------------------------------
interface CustomerStats { customers: number; newCustomers: number; returningCustomers: number; repeatCustomers: number; repeatRatePct: number | null;
  newCustomerNetMinor: number; returningCustomerNetMinor: number; cohorts: Array<{ cohort: string; size: number; active: number[]; retentionPct: Array<number | null> }> }

export function CustomersPanel(props: PanelProps) {
  const { t } = useT();
  const f = useFormat();
  const { data, error, loading, reload } = usePanel<CustomerStats>('customers', props);
  if (error) return <LoadError error={error} retry={reload} />;
  if (loading && !data) return <Loading />;
  if (!data) return null;
  const cov = data.meta.dataCoverage;
  const maxOffset = Math.max(0, ...data.cohorts.map((c) => c.active.length));
  return (
    <div className="stack gap-16">
      <div className="grid grid-4">
        <Stat label={t('insights.customers.identified')} value={f.num(data.customers)} />
        <Stat label={t('insights.customers.new')} value={f.num(data.newCustomers)} hint={f.money(data.newCustomerNetMinor)} />
        <Stat label={t('insights.customers.returning')} value={f.num(data.returningCustomers)} hint={f.money(data.returningCustomerNetMinor)} />
        <Stat label={t('insights.customers.repeatRate')} value={f.pct(data.repeatRatePct)} hint={t('insights.customers.repeatHint', { count: data.repeatCustomers })} />
      </div>
      {Number(cov.ordersWithoutCustomer) > 0 && <Notice>{t('insights.customers.anonymous', { count: String(cov.ordersWithoutCustomer), pct: f.pct(cov.identifiedOrderSharePct as number) })}</Notice>}
      <Section title={t('insights.customers.cohorts')}>
        <p className="fine">{t('insights.customers.cohortsHint')}</p>
        {data.cohorts.length ? (
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>{t('insights.customers.cohort')}</th><th className="text-end">{t('insights.customers.size')}</th>
                {Array.from({ length: maxOffset }, (_, i) => <th className="text-end" key={i}>{t('insights.customers.month', { n: i })}</th>)}</tr></thead>
              <tbody>
                {data.cohorts.map((c) => (
                  <tr key={c.cohort}><td className="num">{c.cohort}</td><td className="num text-end">{c.size}</td>
                    {Array.from({ length: maxOffset }, (_, i) => {
                      const p = c.retentionPct[i];
                      return <td key={i} className="num" style={{ textAlign: 'end', background: p ? `color-mix(in srgb, var(--chart-1) ${Math.round(p * 0.6)}%, transparent)` : undefined }}>
                        {p === undefined ? '' : `${f.pct(p)} (${c.active[i]})`}</td>;
                    })}</tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <p className="muted">{t('insights.customers.noCohorts')}</p>}
      </Section>
      <MetaPanel meta={data.meta} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Marketing
// ---------------------------------------------------------------------------
interface MarketingStats {
  attributed: { orders: number; netMinor: number; netExVatMinor: number; campaigns: Array<{ campaignId: string; name: string; channel: string; orders: number; netMinor: number }> };
  costs: { adSpendMinor: number; marketingExpensesMinor: number; totalMinor: number; clicks: number; impressions: number };
  returnOnSpend: number | null;
}

export function MarketingPanel(props: PanelProps) {
  const { t } = useT();
  const f = useFormat();
  const { data, error, loading, reload } = usePanel<MarketingStats>('marketing', props);
  if (error) return <LoadError error={error} retry={reload} />;
  if (loading && !data) return <Loading />;
  if (!data) return null;
  const cov = data.meta.dataCoverage;
  return (
    <div className="stack gap-16">
      <Notice>{t('insights.marketing.attributionNote')}</Notice>
      <div className="grid grid-4">
        <Stat label={t('insights.marketing.attributedRevenue')} value={f.money(data.attributed.netMinor)} hint={t('insights.ordersCount', { count: data.attributed.orders })} />
        <Stat label={t('insights.marketing.cost')} value={f.money(data.costs.totalMinor)}
          hint={t('insights.marketing.costSplit', { ads: f.money(data.costs.adSpendMinor), other: f.money(data.costs.marketingExpensesMinor) })} />
        <Stat label={t('insights.marketing.ros')} value={data.returnOnSpend === null ? '—' : `${f.num(data.returnOnSpend)}×`} hint={t('insights.marketing.rosHint')} />
        <Stat label={t('insights.marketing.clicks')} value={f.num(data.costs.clicks)} hint={t('insights.marketing.impressions', { count: f.num(data.costs.impressions) })} />
      </div>
      {(Number(cov.excludedSandboxCampaignOrders) > 0 || Number(cov.excludedSandboxAdSpendMinor) > 0) && (
        <Notice tone="warn"><Badge tone="sandbox">{t('state.sandbox')}</Badge> {t('insights.marketing.sandboxExcluded', {
          orders: String(cov.excludedSandboxCampaignOrders), revenue: f.money(Number(cov.excludedSandboxCampaignNetMinor)), spend: f.money(Number(cov.excludedSandboxAdSpendMinor)) })}</Notice>
      )}
      {cov.adSpendIncluded === false && <Notice>{t('insights.marketing.branchNoAds')}</Notice>}
      <Section title={t('insights.marketing.campaigns')}>
        <DataTable rows={data.attributed.campaigns} rowKey={(c) => c.campaignId} empty={<EmptyState title={t('insights.marketing.noCampaigns')} />} columns={[
          { key: 'name', header: t('insights.marketing.campaign'), render: (c) => c.name },
          { key: 'channel', header: t('insights.marketing.channel'), render: (c) => c.channel },
          { key: 'orders', header: t('insights.kpi.orders'), align: 'end', render: (c) => <span className="num">{c.orders}</span> },
          { key: 'net', header: t('insights.kpi.net'), align: 'end', render: (c) => <span className="num">{f.money(c.netMinor)}</span> },
        ]} />
      </Section>
      <MetaPanel meta={data.meta} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------
interface Ops {
  kitchen: { ordersMeasured: number; placedToReadyAvgMinutes: number | null; placedToReadyP50Minutes: number | null; placedToReadyP90Minutes: number | null; placedToAcceptedAvgMinutes: number | null };
  delivery: { jobs: number; delivered: number; failed: number; cancelled: number; failureRatePct: number | null; assignmentAvgMinutes: number | null; assignmentP50Minutes: number | null;
    pickupToDeliveredAvgMinutes: number | null; pickupToDeliveredP50Minutes: number | null; onTimePct: number | null; onTimeMeasured: number };
}

export function OperationsPanel(props: PanelProps) {
  const { t } = useT();
  const f = useFormat();
  const { data, error, loading, reload } = usePanel<Ops>('operations', props);
  if (error) return <LoadError error={error} retry={reload} />;
  if (loading && !data) return <Loading />;
  if (!data) return null;
  const k = data.kitchen;
  const d = data.delivery;
  return (
    <div className="stack gap-16">
      <Section title={t('insights.ops.kitchen')}>
        <div className="grid grid-4">
          <Stat label={t('insights.ops.readyAvg')} value={f.minutes(k.placedToReadyAvgMinutes)} hint={t('insights.ops.measured', { count: k.ordersMeasured })} />
          <Stat label={t('insights.ops.readyP50')} value={f.minutes(k.placedToReadyP50Minutes)} />
          <Stat label={t('insights.ops.readyP90')} value={f.minutes(k.placedToReadyP90Minutes)} />
          <Stat label={t('insights.ops.acceptAvg')} value={f.minutes(k.placedToAcceptedAvgMinutes)} />
        </div>
      </Section>
      <Section title={t('insights.ops.delivery')}>
        {d.jobs === 0 ? <p className="muted">{t('insights.ops.noDeliveries')}</p> : (
          <div className="grid grid-4">
            <Stat label={t('insights.ops.jobs')} value={f.num(d.jobs)} hint={t('insights.ops.deliveredFailed', { delivered: d.delivered, failed: d.failed })} />
            <Stat label={t('insights.ops.onTime')} value={f.pct(d.onTimePct)} hint={t('insights.ops.onTimeHint', { count: d.onTimeMeasured })} />
            <Stat label={t('insights.ops.failureRate')} value={f.pct(d.failureRatePct)} tone={d.failureRatePct !== null && d.failureRatePct > 5 ? 'warn' : undefined} />
            <Stat label={t('insights.ops.assignAvg')} value={f.minutes(d.assignmentAvgMinutes)} hint={t('insights.ops.median', { value: f.minutes(d.assignmentP50Minutes) })} />
            <Stat label={t('insights.ops.transitAvg')} value={f.minutes(d.pickupToDeliveredAvgMinutes)} hint={t('insights.ops.median', { value: f.minutes(d.pickupToDeliveredP50Minutes) })} />
          </div>
        )}
      </Section>
      <MetaPanel meta={data.meta} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sustainability (SDG 12)
// ---------------------------------------------------------------------------
interface Sust {
  foodWaste: { valueMinor: number; entries: number; massKg: number; volumeL: number; pieces: number; purchasesValueMinor: number; wasteToPurchasesPct: number | null };
  paper: { digitalOrders: number; qrOrders: number; qrTableSessions: number; electronicFiscalDocuments: number; countedOrders: number;
    printedTicketsAvoidedIndicator: number; estimatedPaperGrams: number | null; estimateLabel: string | null };
}

export function SustainabilityPanel(props: PanelProps) {
  const { t } = useT();
  const { org } = useOrg();
  const f = useFormat();
  const [grams, setGrams] = useState('');
  const g = Number(grams);
  const { data, error, loading, reload } = usePanel<Sust>('sustainability', props, { gramsPerSheet: grams && g > 0 && g <= 100 ? g : undefined });
  if (error) return <LoadError error={error} retry={reload} />;
  if (loading && !data) return <Loading />;
  if (!data) return null;
  const w = data.foodWaste;
  const p = data.paper;
  return (
    <div className="stack gap-16">
      <Section title={t('insights.sust.waste')} actions={<Link className="btn btn-sm" href={`/dashboard/${org.id}/inventory?tab=waste`}>{t('insights.sust.recordWaste')}</Link>}>
        {w.entries === 0 ? <p className="muted">{t('insights.sust.noWaste')}</p> : (
          <div className="grid grid-4">
            <Stat label={t('insights.sust.wasteValue')} value={f.money(w.valueMinor)} hint={t('insights.sust.entries', { count: w.entries })} />
            <Stat label={t('insights.sust.mass')} value={`${f.num(w.massKg)} kg`} hint={w.volumeL ? `${f.num(w.volumeL)} L` : undefined} />
            <Stat label={t('insights.sust.pieces')} value={f.num(w.pieces)} />
            <Stat label={t('insights.sust.wasteToPurchases')} value={f.pct(w.wasteToPurchasesPct)} hint={t('insights.sust.purchases', { value: f.money(w.purchasesValueMinor) })} />
          </div>
        )}
        <p className="fine mbs-10">{t('insights.sust.wasteMethod')}</p>
      </Section>
      <Section title={t('insights.sust.paper')}>
        <div className="grid grid-4">
          <Stat label={t('insights.sust.digitalOrders')} value={f.num(p.digitalOrders)} hint={t('insights.sust.ofOrders', { count: p.countedOrders })} />
          <Stat label={t('insights.sust.qrSessions')} value={f.num(p.qrTableSessions)} />
          <Stat label={t('insights.sust.eDocs')} value={f.num(p.electronicFiscalDocuments)} />
          <Stat label={t('insights.sust.indicator')} value={f.num(p.printedTicketsAvoidedIndicator)} hint={t('insights.sust.indicatorHint')} />
        </div>
        <div className={`row ${a.gramsRow}`}>
          <label className={`field ${a.gramsField}`}>
            <span>{t('insights.sust.gramsPerSheet')}</span>
            <input className="input" inputMode="decimal" value={grams} onChange={(e) => setGrams(e.target.value)} placeholder={t('insights.sust.gramsPlaceholder')} />
          </label>
          {p.estimatedPaperGrams !== null && (
            <div><Badge tone="sandbox">{t('insights.sust.estimate')}</Badge> <strong className="num">{f.num(p.estimatedPaperGrams)} g</strong>
              <div className="fine">{t('insights.sust.estimateNote', { grams: f.num(g) })}</div></div>
          )}
        </div>
      </Section>
      <MetaPanel meta={data.meta} />
    </div>
  );
}

