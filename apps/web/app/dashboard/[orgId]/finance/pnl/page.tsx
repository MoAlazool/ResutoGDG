'use client';
import { Suspense } from 'react';
import type { ProfitAndLoss } from '@resuto/contracts';
import { Card, Notice, Skeleton } from '@resuto/ui';
import { useT } from '@/lib/i18n/client';
import { useOrg } from '@/lib/org-context';
import { useApi } from '@/lib/use-api';
import { PolicyCard } from '../_ui/AccountingSetup';
import { FinanceFrame, pct, useMoney, usePeriod } from '../_ui/FinanceFrame';

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
    <tr key={label} style={opts.strong ? { fontWeight: 700, background: '#fbfbf8' } : undefined}>
      <td style={{ paddingInlineStart: opts.indent ? 32 : 14 }}>{label}</td>
      <td style={{ textAlign: 'end' }} className="num" dir="ltr">{opts.neg && v ? `−${m(v)}` : m(v)}</td>
    </tr>
  );
  return (
    <div className="grid grid-2" style={{ alignItems: 'start' }}>
      {data.isSyntheticData && <div style={{ gridColumn: '1 / -1' }}><Notice tone="warn">{t('finance.demo')}</Notice></div>}
      <Card title={t('finance.pnl.title')}>
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
              {memo.length > 0 && <tr><td colSpan={2} className="fine" style={{ paddingTop: 14 }}>{t('finance.pnl.memo')}</td></tr>}
              {memo.map(([k, v]) => (
                <tr key={k} className="fine">
                  <td style={{ paddingInlineStart: 32 }}>{t(`finance.pnl.memo.${k}`)}</td>
                  <td style={{ textAlign: 'end' }} className="num" dir="ltr">({m(v)})</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="row" style={{ marginTop: 12 }}>
          <span className="badge">{t('finance.pnl.grossMargin')}: {pct(data.grossMarginBp)}</span>
          <span className="badge">{t('finance.pnl.operatingMargin')}: {pct(data.operatingMarginBp)}</span>
          {data.coverage.costedSalesBp !== null && data.policy.cogsMethod === 'item_cost' && <span className="badge">{t('finance.pnl.costed', { pct: pct(data.coverage.costedSalesBp) })}</span>}
        </div>
      </Card>
      <div className="stack">
        <PolicyCard onSaved={() => reload()} />
        {data.warnings.length > 0 && <Notice tone="warn"><strong>{t('finance.warnings')}</strong><ul style={{ margin: '6px 0 0', paddingInlineStart: 18 }}>{data.warnings.map((w) => <li key={w}>{w}</li>)}</ul></Notice>}
        <Card title={t('finance.pnl.methodology')}>
          <ol className="fine" style={{ paddingInlineStart: 18, margin: 0 }}>{data.methodology.map((x) => <li key={x}>{x}</li>)}</ol>
        </Card>
      </div>
    </div>
  );
}

export default function PnlPage() {
  return <Suspense fallback={<Skeleton lines={6} />}><FinanceFrame><Pnl /></FinanceFrame></Suspense>;
}
