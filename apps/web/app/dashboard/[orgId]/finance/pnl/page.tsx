'use client';
import { Suspense } from 'react';
import type { ProfitAndLoss } from '@resuto/contracts';
import { Card, Notice, ProvenanceBadge, Skeleton } from '@resuto/ui';
import { useT } from '@/lib/i18n/client';
import { useOrg } from '@/lib/org-context';
import { useApi } from '@/lib/use-api';
import { financeWarningText } from '@/lib/finance-warnings';
import dynamic from 'next/dynamic';
import styles from '../_ui/finance.module.css';
import { FinanceFrame, pct, useMoney, usePeriod } from '../_ui/FinanceFrame';
import { profitProvenance } from '../_ui/provenance';

// The accounting policy card loads after the statement (it needs the full contracts).
const PolicyCard = dynamic(() => import('../_ui/AccountingSetup').then((m) => m.PolicyCard), { ssr: false, loading: () => <div className="card"><Skeleton lines={4} /></div> });

function Pnl() {
  const { t } = useT();
  const { org } = useOrg();
  const p = usePeriod();
  const m = useMoney();
  const { data, error, reload } = useApi<ProfitAndLoss>(`/o/${org.id}/finance/pnl?${p.query}`);
  if (error) return <Notice tone="danger">{error.message}</Notice>;
  if (!data) return <Skeleton lines={8} />;
  const L = data.lines;
  const memo = ([
    ['inventoryPurchases', L.memo.inventoryPurchasesMinor], ['itemCostOfSales', L.memo.itemCostOfSalesMinor],
    ['feeExpenses', L.memo.feeExpensesMinor], ['providerReportedFees', L.memo.providerReportedFeesMinor],
  ] as const).filter(([, v]) => v > 0);
  const row = (label: string, v: number, opts: { neg?: boolean; strong?: boolean; indent?: boolean } = {}) => (
    <tr key={label} className={opts.strong ? 'row-strong' : undefined}>
      <td className={opts.indent ? styles.indent : undefined}>{label}</td>
      <td className="num text-end" dir="ltr">{opts.neg && v ? `−${m(v)}` : m(v)}</td>
    </tr>
  );
  return (
    <div className="grid grid-2 items-start">
      {data.isSyntheticData && <div className={styles.full}><Notice tone="warn">{t('finance.demo')}</Notice></div>}
      <Card title={t('finance.pnl.title')} actions={<ProvenanceBadge provenance={profitProvenance(data)}
        labels={{ live: t('finance.prov.ledger'), estimated: t('finance.prov.estimated'), sandbox: t('finance.prov.sandbox'), unavailable: t('finance.prov.unavailable') }} />}>
        <div className="table-wrap">
          <table className="data">
            <tbody>
              {row(t('finance.pnl.grossSales'), L.grossSalesMinor)}
              {row(t('finance.pnl.discounts'), L.discountsMinor, { neg: true, indent: true })}
              {row(t('finance.pnl.refunds'), L.refundsMinor, { neg: true, indent: true })}
              {row(t('finance.pnl.vat'), L.vatMinor, { neg: true, indent: true })}
              {row(t('finance.pnl.netRevenue'), L.netRevenueMinor, { strong: true })}
              {row(t('finance.pnl.cogsSales'), L.cogsFromSalesMinor, { neg: true, indent: true })}
              {row(t('finance.pnl.cogsExpenses'), L.cogsExpensesMinor, { neg: true, indent: true })}
              {row(t('finance.pnl.grossProfit'), L.grossProfitMinor, { strong: true })}
              {Object.entries(L.operatingExpensesByKind).map(([k, v]) => row(t(`finance.kind.${k}`), v, { neg: true, indent: true }))}
              {row(t('finance.pnl.paymentFees'), L.paymentFeesMinor, { neg: true, indent: true })}
              {row(t('finance.pnl.operatingProfit'), L.operatingProfitMinor, { strong: true })}
              {memo.length > 0 && <tr><td colSpan={2} className={`fine ${styles.memoHead}`}>{t('finance.pnl.memo')}</td></tr>}
              {memo.map(([k, v]) => (
                <tr key={k} className="fine">
                  <td className={styles.indent}>{t(`finance.pnl.memo.${k}`)}</td>
                  <td className="num text-end" dir="ltr">({m(v)})</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="row mbs-12">
          <span className="badge">{t('finance.pnl.grossMargin')}: {pct(data.grossMarginBp)}</span>
          <span className="badge">{t('finance.pnl.operatingMargin')}: {pct(data.operatingMarginBp)}</span>
          {data.coverage.costedSalesBp !== null && data.policy.cogsMethod === 'item_cost' && <span className="badge">{t('finance.pnl.costed', { pct: pct(data.coverage.costedSalesBp) })}</span>}
        </div>
      </Card>
      <div className="stack">
        <PolicyCard onSaved={() => reload()} />
        {data.warnings.length > 0 && <Notice tone="warn"><strong>{t('finance.warnings')}</strong><ul className={styles.list}>{data.warnings.map((w) => <li key={w}>{financeWarningText(w, t)}</li>)}</ul></Notice>}
        <Card title={t('finance.pnl.methodology')}>
          <ol className={`fine m-0 ${styles.list}`}>{data.methodology.map((x) => <li key={x}>{x}</li>)}</ol>
        </Card>
      </div>
    </div>
  );
}

export default function PnlPage() {
  return <Suspense fallback={<Skeleton lines={6} />}><FinanceFrame compare={false}><Pnl /></FinanceFrame></Suspense>;
}
