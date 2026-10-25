'use client';
// Row 2 "Performance": revenue, orders, average order, repeat rate and guest satisfaction for the chosen period, each
// with its change against the chosen comparison, a sparkline and where the figure comes from. Each tile drills down
// to the Insights view that explains it, with the same period, comparison and branch (21-INSIGHTS).
import Link from 'next/link';
import type { OverviewPeriod } from '@resuto/contracts/home';
import { provenanceFromMetaKind, StatV2 } from '@resuto/ui';
import { useFormat } from '@/components/charts/insights';
import { useT } from '@/lib/i18n/client';
import type { InsightsSection } from '@/lib/insights';
import { cumulative } from './model';

export interface RatingsData { count: number; averages: { overall: number | null } }

export function Performance({ period, hourlyToday, ratings, drill }: {
  period: OverviewPeriod; hourlyToday: number[] | null; ratings: RatingsData | undefined;
  /** The Insights link of a tile (same period, comparison and branch); no links without it. */
  drill?: (section: InsightsSection) => string;
}) {
  const { t } = useT();
  const f = useFormat();
  const c = period.current;
  const cmp = period.comparison;
  const vs = cmp ? t('home.perf.vs', { from: f.date(cmp.from), to: f.date(cmp.to) }) : undefined;
  const delta = (v: number | null | undefined) => (period.changePct ? { value: v ?? null, label: vs } : undefined);
  // Live measured figures (AnalyticsMeta.kind 'measured'); the period meta is 'mixed' only because of acquisition.
  const live = provenanceFromMetaKind('measured');
  const spark = (values: number[]) => (values.length >= 2 ? values : undefined);
  const netSeries = period.days === 1 && hourlyToday ? cumulative(hourlyToday) : period.daily.map((d) => d.netMinor);
  const pts = period.changePct?.repeatRatePts;
  const to = (section: InsightsSection) => (drill ? { href: drill(section), linkAs: Link } : {});
  const ratingValue = ratings && ratings.count && ratings.averages.overall !== null ? f.num(Math.round(ratings.averages.overall * 10) / 10) : '—';

  return (
    <div className="rui-stat-grid">
      <StatV2 label={t('insights.kpi.net')} value={f.money(c.netMinor)} provenance={live} delta={delta(period.changePct?.netMinor)} sparkline={spark(netSeries)} {...to('sales')} />
      <StatV2 label={t('insights.kpi.orders')} value={f.num(c.orders)} provenance={live} delta={delta(period.changePct?.orders)}
        sparkline={period.days > 1 ? spark(period.daily.map((d) => d.orders)) : undefined} {...to('sales')} />
      <StatV2 label={t('insights.kpi.aov')} value={f.money(c.averageOrderMinor)} provenance={live} delta={delta(period.changePct?.averageOrderMinor)} {...to('sales')} />
      <StatV2 label={t('home.perf.repeat')} value={c.repeatRatePct === null ? '—' : f.pct(c.repeatRatePct)} provenance={live} {...to('customers')}
        hint={c.customers
          ? <>{t('home.perf.repeatHint', { repeat: f.num(c.repeatCustomers), customers: f.num(c.customers) })}
            {pts !== null && pts !== undefined && vs ? <> · <span className="num">{t('home.perf.pts', { value: `${pts > 0 ? '+' : ''}${f.num(pts)}`, vs })}</span></> : null}</>
          : t('home.perf.noCustomers')} />
      <StatV2 label={t('ops.overview.satisfaction')} value={ratingValue} unit={ratings?.count ? '/ 5' : undefined}
        provenance={ratings ? 'live' : 'unavailable'} {...to('ratings')}
        hint={ratings ? (ratings.count ? t('home.perf.ratings', { n: ratings.count }) : t('home.perf.noRatings')) : undefined} />
    </div>
  );
}
