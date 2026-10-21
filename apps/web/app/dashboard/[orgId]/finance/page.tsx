'use client';
import { financeWarningText } from '@/lib/finance-warnings';
import { Suspense } from 'react';
import type { RevenueOverview } from '@resuto/contracts';
import { Card, DataTable, EmptyState, Notice, Skeleton, Stat } from '@resuto/ui';
import { useT } from '@/lib/i18n/client';
import { useOrg } from '@/lib/org-context';
import { useApi } from '@/lib/use-api';
import { FinanceFrame, pct, useMoney, usePeriod } from './_ui/FinanceFrame';

function Overview() {
  const { t, locale } = useT();
  const { org } = useOrg();
  const p = usePeriod();
  const m = useMoney();
  const rev = useApi<RevenueOverview>(`/o/${org.id}/finance/overview?${p.query}`);
  const insights = useApi<any>(`/o/${org.id}/finance/insights?${p.query}`);
  const fees = useApi<any>(`/o/${org.id}/finance/fees?${p.query}`);
  const recon = useApi<any>(`/o/${org.id}/finance/reconciliation?${p.query}`);
  if (rev.error) return <Notice tone="danger">{rev.error.message}</Notice>;
  if (!rev.data) return <Skeleton lines={6} />;
  const T = rev.data.totals;
  const trend = insights.data?.marginTrend;
  const fast = insights.data?.fastestGrowingExpense;
  const maxRev = Math.max(1, ...(trend?.months ?? []).map((x: any) => Math.abs(x.netRevenueMinor)));
  return (
    <div className="stack">
      <div className="grid grid-4">
        <div><Stat label={t('finance.gross')} value={<bdi>{m(T.grossMinor)}</bdi>} hint={`${T.orderCount} ${t('finance.orders')}`} /></div>
        <div><Stat label={t('finance.net')} value={<bdi>{m(T.netMinor)}</bdi>} hint={`${t('finance.discounts')} ${m(T.discountsMinor)} · ${t('finance.refunds')} ${m(T.refundsMinor)}`} /></div>
        <div><Stat label={t('finance.netExVat')} value={<bdi>{m(T.netExVatMinor)}</bdi>} hint={`${t('finance.vat')} ${m(T.vatMinor)}`} /></div>
        <div><Stat label={t('finance.collected')} value={<bdi>{m(T.collectedMinor)}</bdi>} /></div>
      </div>
      {rev.data.warnings.length > 0 && <Notice tone="warn"><strong>{t('finance.warnings')}:</strong> {rev.data.warnings.map((w) => financeWarningText(w, t)).join(' ')}</Notice>}
      <div className="grid grid-2" style={{ alignItems: 'start' }}>
        <Card title={t('finance.insights')}>
          {!insights.data ? <Skeleton lines={3} /> : (
            <div className="stack">
              <div>
                <h3>{t('finance.marginTrend')}</h3>
                <p className="fine">{t(`finance.trend.${trend.direction}`, { bp: Math.abs(Math.round((trend.deltaBp ?? 0) / 100)) })}</p>
                <div role="img" aria-label={t('finance.marginTrend')} style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: 8, alignItems: 'end', height: 120 }}>
                  {trend.months.map((x: any) => (
                    <div key={x.month} style={{ display: 'grid', gap: 4, alignContent: 'end', height: '100%', textAlign: 'center' }}>
                      <span className="fine" style={{ lineHeight: 1 }}>{pct(x.grossMarginBp)}</span>
                      <div style={{ height: `${Math.max(2, (Math.abs(x.netRevenueMinor) / maxRev) * 80)}px`, background: (x.grossMarginBp ?? 0) < 0 ? 'var(--danger)' : 'var(--chart-2)', borderRadius: 6 }} />
                      <span className="fine" dir="ltr" style={{ lineHeight: 1 }}>{x.month.slice(5)}</span>
                    </div>
                  ))}
                </div>
              </div>
              <div>
                <h3>{t('finance.fastestExpense')}</h3>
                <p className="fine">{!fast ? t('finance.noExpenseGrowth') : fast.growthBp === null
                  ? t('finance.fastestExpenseNew', { name: locale === 'ar' && fast.nameAr ? fast.nameAr : fast.name, current: m(fast.currentMinor) })
                  : t('finance.fastestExpenseBody', { name: locale === 'ar' && fast.nameAr ? fast.nameAr : fast.name, current: m(fast.currentMinor), previous: m(fast.previousMinor), growth: `+${pct(fast.growthBp)}` })}</p>
              </div>
            </div>
          )}
        </Card>
        <Card title={t('finance.byMethod')}>
          <DataTable rows={rev.data.byMethod} rowKey={(r) => r.method} empty={<EmptyState title={t('finance.noData')} />} columns={[
            { key: 'm', header: t('finance.method'), render: (r) => t(`pay.method.${r.method}`) },
            { key: 'n', header: t('finance.count'), align: 'end', render: (r) => r.count },
            { key: 'c', header: t('finance.collected'), align: 'end', render: (r) => <span dir="ltr">{m(r.collectedMinor)}</span> },
            { key: 'r', header: t('finance.refunds'), align: 'end', render: (r) => <span dir="ltr">{m(r.refundedMinor)}</span> },
          ]} />
        </Card>
      </div>
      <div className="grid grid-2" style={{ alignItems: 'start' }}>
        <Card title={t('finance.byDay')}>
          <DataTable rows={rev.data.byDay} rowKey={(r) => r.date} empty={<EmptyState title={t('finance.noData')} />} columns={[
            { key: 'd', header: t('finance.date'), render: (r) => <span dir="ltr">{r.date}</span> },
            { key: 'o', header: t('finance.orders'), align: 'end', render: (r) => r.orderCount },
            { key: 'n', header: t('finance.net'), align: 'end', render: (r) => <span dir="ltr">{m(r.netMinor)}</span> },
            { key: 'v', header: t('finance.vat'), align: 'end', render: (r) => <span dir="ltr">{m(r.vatMinor)}</span> },
          ]} />
        </Card>
        <Card title={t('finance.feesByProvider')}>
          {fees.data ? (
            <DataTable rows={fees.data.items} rowKey={(r: any) => `${r.provider}:${r.method}`} empty={<EmptyState title="—" />} columns={[
              { key: 'p', header: t('finance.provider'), render: (r: any) => `${r.provider} · ${t(`pay.method.${r.method}`)}` },
              { key: 'v', header: t('finance.volume'), align: 'end', render: (r: any) => <span dir="ltr">{m(r.volumeMinor)}</span> },
              { key: 'f', header: t('finance.fees'), align: 'end', render: (r: any) => <span dir="ltr">{m(r.feesMinor)}{r.unknownFee ? ` (${r.unknownFee} ${t('finance.unknownFee')})` : ''}</span> },
            ]} />
          ) : <Skeleton lines={3} />}
          {recon.data && <p className="fine" style={{ marginTop: 12 }}>{t('finance.reconciliation')}: {t('finance.openExceptions', { n: recon.data.openExceptions })}</p>}
        </Card>
      </div>
      {rev.data.byBranch.length > 1 && (
        <Card title={t('finance.byBranch')}>
          <DataTable rows={rev.data.byBranch} rowKey={(r) => r.branchId} columns={[
            { key: 'b', header: t('finance.period.branch'), render: (r) => r.name },
            { key: 'o', header: t('finance.orders'), align: 'end', render: (r) => r.orderCount },
            { key: 'n', header: t('finance.netExVat'), align: 'end', render: (r) => <span dir="ltr">{m(r.netExVatMinor)}</span> },
          ]} />
        </Card>
      )}
    </div>
  );
}

export default function FinanceOverviewPage() {
  return <Suspense fallback={<Skeleton lines={6} />}><FinanceFrame><Overview /></FinanceFrame></Suspense>;
}
