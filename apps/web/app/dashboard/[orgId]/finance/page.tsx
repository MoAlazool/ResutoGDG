'use client';
import dynamic from 'next/dynamic';
import { Suspense, type ReactNode } from 'react';
import type { ProfitAndLoss, RevenueOverview } from '@resuto/contracts';
import { Card, DataTableV2, EmptyState, Notice, ProvenanceBadge, Skeleton, StatV2, type Provenance } from '@resuto/ui';
import { financeWarningText } from '@/lib/finance-warnings';
import { useT } from '@/lib/i18n/client';
import { useOrg } from '@/lib/org-context';
import { useApi } from '@/lib/use-api';
import styles from './_ui/finance.module.css';
import { FinanceFrame, pct, useMoney, usePeriod } from './_ui/FinanceFrame';
import { deltaPct } from './_ui/period';
import { feesProvenance, profitProvenance, revenueProvenance, type FeesView } from './_ui/provenance';

const chartLoading = () => <div className={`skeleton ${styles.chartSlot}`} aria-hidden="true" />;
const NetByDayChart = dynamic(() => import('./_ui/OverviewCharts').then((m) => m.NetByDayChart), { ssr: false, loading: chartLoading });
const NetByMonthChart = dynamic(() => import('./_ui/OverviewCharts').then((m) => m.NetByMonthChart), { ssr: false, loading: chartLoading });

interface Insights {
  marginTrend: { direction: string; deltaBp: number | null; months: Array<{ month: string; netRevenueMinor: number; grossMarginBp: number | null }> };
  fastestGrowingExpense: { name: string; nameAr: string | null; currentMinor: number; previousMinor: number; growthBp: number | null } | null;
}

/**
 * Finance overview (21-MONEY): the period's figures against the comparison period, each with where it comes from
 * (from your records, estimated when inputs are incomplete), net sales by day, the six-month trend and the
 * breakdowns. Every figure is computed by the finance API from recorded data; nothing here is modelled.
 */
function Overview() {
  const { t, locale } = useT();
  const { org } = useOrg();
  const p = usePeriod();
  const m = useMoney();
  const base = `/o/${org.id}/finance`;
  const rev = useApi<RevenueOverview>(`${base}/overview?${p.query}`);
  const prev = useApi<RevenueOverview>(p.previousQuery ? `${base}/overview?${p.previousQuery}` : null);
  const pnl = useApi<ProfitAndLoss>(`${base}/pnl?${p.query}`);
  const pnlPrev = useApi<ProfitAndLoss>(p.previousQuery ? `${base}/pnl?${p.previousQuery}` : null);
  const insights = useApi<Insights>(`${base}/insights?${p.query}`);
  const fees = useApi<FeesView>(`${base}/fees?${p.query}`);
  const recon = useApi<{ openExceptions: number }>(`${base}/reconciliation?${p.query}`);
  if (rev.error) return <Notice tone="danger">{rev.error.message}</Notice>;
  if (!rev.data) return <Skeleton lines={6} />;
  const T = rev.data.totals;
  const P = prev.data?.totals ?? null;
  const synthetic = !!pnl.data?.isSyntheticData;
  const revenue = revenueProvenance(true, synthetic);
  const profit = profitProvenance(pnl.data);
  const feeProv = feesProvenance(fees.data, synthetic);
  const provLabels = { live: t('finance.prov.ledger'), estimated: t('finance.prov.estimated'), sandbox: t('finance.prov.sandbox'), unavailable: t('finance.prov.unavailable') };
  const vs = p.previous ? t(`finance.compare.vs.${p.compare}`) : undefined;
  const delta = (cur: number | null | undefined, before: number | null | undefined, ready: boolean) => (p.previous ? { value: ready ? deltaPct(cur, before) : null, label: vs } : null);
  const badge = (prov: Provenance) => <ProvenanceBadge provenance={prov} labels={provLabels} />;
  const stat = (key: string, label: string, value: number | null | undefined, before: number | null | undefined, prov: Provenance, ready: boolean, hint?: ReactNode) => (
    <div data-stat={key}><StatV2 label={label} value={prov === 'unavailable' ? '—' : <bdi>{m(value)}</bdi>} provenance={prov} hint={hint} delta={delta(value, before, ready)} /></div>
  );
  const trend = insights.data?.marginTrend;
  const fast = insights.data?.fastestGrowingExpense;
  const prevReady = !!prev.data;
  return (
    <div className="stack">
      <div className={`rui-stat-grid ${styles.stats}`} data-testid="finance-kpis">
        {stat('gross', t('finance.gross'), T.grossMinor, P?.grossMinor, revenue, prevReady, `${T.orderCount} ${t('finance.orders')}`)}
        {stat('net', t('finance.net'), T.netMinor, P?.netMinor, revenue, prevReady, `${t('finance.discounts')} ${m(T.discountsMinor)} · ${t('finance.refunds')} ${m(T.refundsMinor)}`)}
        {stat('netExVat', t('finance.netExVat'), T.netExVatMinor, P?.netExVatMinor, revenue, prevReady, `${t('finance.vat')} ${m(T.vatMinor)}`)}
        {stat('collected', t('finance.collected'), T.collectedMinor, P?.collectedMinor, revenue, prevReady)}
        {stat('operatingProfit', t('finance.overview.operatingProfit'), pnl.data?.lines.operatingProfitMinor, pnlPrev.data?.lines.operatingProfitMinor, profit, !!pnlPrev.data,
          pnl.data ? `${t('finance.pnl.operatingMargin')}: ${pct(pnl.data.operatingMarginBp)}` : undefined)}
      </div>
      <p className={styles.legend}>{t('finance.prov.legend')}</p>
      {rev.data.warnings.length > 0 && <Notice tone="warn"><strong>{t('finance.warnings')}:</strong> {rev.data.warnings.map((w) => financeWarningText(w, t)).join(' ')}</Notice>}

      <Card title={t('finance.overview.netByDay')} actions={badge(revenue)}>
        <NetByDayChart current={p} previous={p.previous} rows={rev.data.byDay} previousRows={p.previous ? prev.data?.byDay ?? null : null} format={m} />
      </Card>

      <div className={styles.pair}>
        <Card title={t('finance.insights')} actions={badge(insights.data ? revenue : 'unavailable')}>
          {!insights.data || !trend ? <Skeleton lines={3} /> : (
            <div className="stack">
              <NetByMonthChart months={trend.months} format={m} />
              <div>
                <h3>{t('finance.overview.margins')}</h3>
                <p className="fine m-0">{t(`finance.trend.${trend.direction}`, { bp: Math.abs(Math.round((trend.deltaBp ?? 0) / 100)) })}</p>
                <ul className={styles.margins}>
                  {trend.months.map((x) => <li key={x.month} data-negative={(x.grossMarginBp ?? 0) < 0 ? '' : undefined}><bdi dir="ltr">{x.month}</bdi> <strong className="num">{pct(x.grossMarginBp)}</strong></li>)}
                </ul>
              </div>
              <div>
                <h3>{t('finance.fastestExpense')}</h3>
                <p className="fine m-0">{!fast ? t('finance.noExpenseGrowth') : fast.growthBp === null
                  ? t('finance.fastestExpenseNew', { name: locale === 'ar' && fast.nameAr ? fast.nameAr : fast.name, current: m(fast.currentMinor) })
                  : t('finance.fastestExpenseBody', { name: locale === 'ar' && fast.nameAr ? fast.nameAr : fast.name, current: m(fast.currentMinor), previous: m(fast.previousMinor), growth: `+${pct(fast.growthBp)}` })}</p>
              </div>
            </div>
          )}
        </Card>
        <Card title={t('finance.byMethod')} actions={badge(revenue)}>
          <DataTableV2 label={t('finance.byMethod')} rows={rev.data.byMethod} rowKey={(r) => r.method} empty={<EmptyState title={t('finance.noData')} />} columns={[
            { key: 'm', header: t('finance.method'), render: (r) => t(`pay.method.${r.method}`) },
            { key: 'n', header: t('finance.count'), align: 'end', render: (r) => <span className="num">{r.count}</span> },
            { key: 'c', header: t('finance.collected'), align: 'end', render: (r) => <span className="num" dir="ltr">{m(r.collectedMinor)}</span> },
            { key: 'r', header: t('finance.refunds'), align: 'end', render: (r) => <span className="num" dir="ltr">{m(r.refundedMinor)}</span> },
          ]} />
        </Card>
      </div>

      <div className={styles.pair}>
        <Card title={t('finance.feesByProvider')} actions={badge(feeProv)}>
          {fees.error ? <Notice tone="danger">{fees.error.message}</Notice> : fees.data ? (
            <DataTableV2 label={t('finance.feesByProvider')} rows={fees.data.items} rowKey={(r) => `${r.provider}:${r.method}`} empty={<EmptyState title={t('finance.noData')} />} columns={[
              { key: 'p', header: t('finance.provider'), render: (r) => <><bdi>{r.provider}</bdi> · {t(`pay.method.${r.method}`)}</> },
              { key: 'v', header: t('finance.volume'), align: 'end', render: (r) => <span className="num" dir="ltr">{m(r.volumeMinor)}</span> },
              { key: 'f', header: t('finance.fees'), align: 'end', render: (r) => <span className="num" dir="ltr">{m(r.feesMinor)}{r.unknownFee ? ` (${r.unknownFee} ${t('finance.unknownFee')})` : ''}</span> },
            ]} />
          ) : <Skeleton lines={3} />}
          {recon.data && <p className="fine mbs-12">{t('finance.reconciliation')}: {t('finance.openExceptions', { n: recon.data.openExceptions })}</p>}
        </Card>
        {rev.data.byBranch.length > 1 && (
          <Card title={t('finance.byBranch')} actions={badge(revenue)}>
            <DataTableV2 label={t('finance.byBranch')} rows={rev.data.byBranch} rowKey={(r) => r.branchId} columns={[
              { key: 'b', header: t('finance.period.branch'), render: (r) => <bdi>{r.name}</bdi> },
              { key: 'o', header: t('finance.orders'), align: 'end', render: (r) => <span className="num">{r.orderCount}</span> },
              { key: 'n', header: t('finance.netExVat'), align: 'end', render: (r) => <span className="num" dir="ltr">{m(r.netExVatMinor)}</span> },
            ]} />
          </Card>
        )}
      </div>
    </div>
  );
}

export default function FinanceOverviewPage() {
  return <Suspense fallback={<Skeleton lines={6} />}><FinanceFrame><Overview /></FinanceFrame></Suspense>;
}
