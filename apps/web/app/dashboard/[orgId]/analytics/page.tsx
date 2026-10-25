'use client';
// Insights › Overview (21-INSIGHTS): the period's headline figures, each with where it comes from and a link to the
// view that explains it, the top dishes and channels, and the member's saved reports. The former Analytics tabs
// (`?tab=…`) redirect to their own routes (next.config.ts, lib/insights.ts insightsRedirects).
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect } from 'react';
import type { AnalyticsMeta, RatingsSummary, RevenueTotals } from '@resuto/contracts';
import { BarList, provenanceFromMetaKind, StatV2 } from '@resuto/ui';
import { InsightsShell, useInsights } from '@/components/insights/InsightsShell';
import { PeriodControls } from '@/components/insights/PeriodControls';
import { SavedReportsList } from '@/components/insights/SavedReportsList';
import { LoadError, MetaPanel, qs, useFormat } from '@/components/charts/insights';
import s from '@/components/insights/insights.module.css';
import { insightsHref, legacyAnalyticsTarget, type InsightsSection } from '@/lib/insights';
import { useT } from '@/lib/i18n/client';
import { useOrg } from '@/lib/org-context';
import { useApi } from '@/lib/use-api';

interface Summary {
  totals: RevenueTotals;
  comparison: null | { from: string; to: string; changePct: Record<string, number | null> };
  byChannel: Array<{ key: string; orders: number; netMinor: number }>;
  daily: Array<{ date: string; orders: number; netMinor: number }>;
  meta: AnalyticsMeta;
}
interface Products { top: Array<{ productId: string; name: string; nameAr: string | null; revenueMinor: number; quantity: number }>; meta: AnalyticsMeta }
interface Customers { customers: number; repeatCustomers: number; repeatRatePct: number | null; meta: AnalyticsMeta }

function Overview() {
  const { t, locale } = useT();
  const { org } = useOrg();
  const f = useFormat();
  const { period, branchId, compare, view } = useInsights();
  const range = { from: period.from, to: period.to, branchId };
  const summary = useApi<Summary>(`/o/${org.id}/analytics/summary${qs({ ...range, compare })}`);
  const products = useApi<Products>(`/o/${org.id}/analytics/products${qs({ ...range, compare: 'none' })}`);
  const customers = useApi<Customers>(`/o/${org.id}/analytics/customers${qs({ ...range, compare: 'none' })}`);
  const ratings = useApi<RatingsSummary & { meta: AnalyticsMeta }>(`/o/${org.id}/analytics/ratings${qs({ ...range, compare: 'none' })}`);
  const link = (section: InsightsSection) => `/dashboard/${org.id}${insightsHref(section, view)}`;
  const d = summary.data;
  const ch = d?.comparison?.changePct;
  const vs = d?.comparison ? t('home.perf.vs', { from: f.date(d.comparison.from), to: f.date(d.comparison.to) }) : undefined;
  const delta = (v: number | null | undefined) => (d?.comparison ? { value: v ?? null, label: vs } : undefined);
  const live = d ? provenanceFromMetaKind(d.meta.kind) : 'unavailable';
  const spark = d && d.daily.length >= 2 ? d.daily : null;
  const r = ratings.data;
  const c = customers.data;
  return (
    <div className="stack gap-16">
      <LoadError error={summary.error} retry={summary.reload} />
      <div className="rui-stat-grid">
        <StatV2 label={t('insights.kpi.net')} value={d ? f.money(d.totals.netMinor) : '…'} provenance={live} delta={delta(ch?.netMinor)}
          sparkline={spark ? spark.map((x) => x.netMinor) : undefined} href={link('sales')} linkAs={Link} />
        <StatV2 label={t('insights.kpi.orders')} value={d ? f.num(d.totals.orders) : '…'} provenance={live} delta={delta(ch?.orders)}
          sparkline={spark ? spark.map((x) => x.orders) : undefined} href={link('sales')} linkAs={Link} />
        <StatV2 label={t('insights.kpi.aov')} value={d ? f.money(d.totals.averageOrderMinor) : '…'} provenance={live} delta={delta(ch?.averageOrderMinor)}
          href={link('sales')} linkAs={Link} />
        <StatV2 label={t('insights.customers.repeatRate')} value={c ? f.pct(c.repeatRatePct) : '…'} provenance={c ? provenanceFromMetaKind(c.meta.kind) : 'unavailable'}
          hint={c ? t('insights.customers.repeatHint', { count: c.repeatCustomers }) : undefined} href={link('customers')} linkAs={Link} />
        <StatV2 label={t('ops.overview.satisfaction')} value={r && r.count && r.averages.overall !== null ? f.num(Math.round(r.averages.overall * 10) / 10) : '—'}
          unit={r?.count ? '/ 5' : undefined} provenance={r ? 'live' : 'unavailable'}
          hint={r ? (r.count ? t('home.perf.ratings', { n: r.count }) : t('home.perf.noRatings')) : undefined} href={link('ratings')} linkAs={Link} />
      </div>
      {d && d.totals.orders === 0 && <p className={s.note}>{t('insights.empty.period')}</p>}
      <div className={s.cards}>
        <section className="card" aria-labelledby="ov-dishes">
          <div className={s.cardHead}>
            <h2 id="ov-dishes" className={s.cardTitle}>{t('insights.products.top')}</h2>
            <Link href={link('menu')}>{t('insights.area.openMenu')}</Link>
          </div>
          <BarList label={t('insights.products.top')} format={f.money} empty={t('insights.empty.none')}
            items={(products.data?.top ?? []).slice(0, 5).map((p) => ({ key: p.productId, label: locale === 'ar' && p.nameAr ? p.nameAr : p.name, value: p.revenueMinor,
              hint: t('insights.area.qty', { n: p.quantity }) }))} />
        </section>
        <section className="card" aria-labelledby="ov-channels">
          <div className={s.cardHead}>
            <h2 id="ov-channels" className={s.cardTitle}>{t('insights.sales.byChannel')}</h2>
            <Link href={link('sales')}>{t('insights.area.openSales')}</Link>
          </div>
          <BarList label={t('insights.sales.byChannel')} format={f.money} empty={t('insights.empty.none')}
            items={(d?.byChannel ?? []).map((b) => ({ key: b.key, label: t(`insights.channel.${b.key}`), value: b.netMinor, hint: t('insights.ordersCount', { count: b.orders }) }))} />
        </section>
      </div>
      <SavedReportsList />
      <MetaPanel meta={d?.meta} />
    </div>
  );
}

export default function AnalyticsOverviewPage() {
  const router = useRouter();
  const { org } = useOrg();
  const params = useSearchParams();
  // Fallback for an old ?tab= link that reached the page without the server redirect.
  const legacy = legacyAnalyticsTarget(params.toString());
  useEffect(() => { if (legacy) router.replace(`/dashboard/${org.id}${legacy}`); }, [legacy, org.id, router]);
  return <InsightsShell section="overview" toolbar={<PeriodControls />}>{legacy ? null : <Overview />}</InsightsShell>;
}
