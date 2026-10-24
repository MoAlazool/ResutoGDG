'use client';
import Link from 'next/link';
import { useMemo, useState } from 'react';
import { LaunchCard, OperationalInsights, OverviewFloor } from '@/components/ops/OverviewOps';
import '@/components/ops/ops.css';
import type { AnalyticsMeta, Permission } from '@resuto/contracts';
import { Badge, NavGlyph, Notice, PageHeader, StatsStrip, StatsStripSkeleton, type NavGlyphName } from '@resuto/ui';
import { LineChart } from '@/components/charts';
import { Delta, InsightsPage, LoadError, MetaPanel, qs, Section, useBranchName, useFormat } from '@/components/charts/insights';
import { formatElapsed } from '@/lib/format';
import { useT } from '@/lib/i18n/client';
import { useBranchScope, useOrg } from '@/lib/org-context';
import { useApi } from '@/lib/use-api';
import { unitLabel } from '@/lib/vocab';

interface Overview {
  date: string; localTime: string; currency: string;
  today: { orders: number; netMinor: number; averageOrderMinor: number };
  lastWeekSameTime: { date: string; orders: number; netMinor: number; averageOrderMinor: number };
  lastWeekFullDay: { orders: number; netMinor: number };
  changePct: { orders: number | null; netMinor: number | null; averageOrderMinor: number | null };
  hourly: Array<{ hour: number; todayNetMinor: number; lastWeekNetMinor: number }>;
  live: { openOrders: number; byStatus: Record<string, number>; oldestOpenOrderAt: string | null; openVisits: number };
  reservationsToday: { total: number; guests: number; byStatus: Record<string, number> };
  lowStock: { count: number; items: Array<{ id: string; branchId: string; name: string; nameAr: string | null; unit: string; quantity: number; reorderLevel: number }> };
  meta: AnalyticsMeta;
}

const QUICK_LINKS: Array<{ href: string; label: string; glyph: NavGlyphName; permission: Permission }> = [
  { href: '/orders', label: 'nav.orders', glyph: 'orders', permission: 'orders:read' },
  { href: '/kitchen', label: 'nav.kitchen', glyph: 'kitchen', permission: 'kitchen:operate' },
  { href: '/floor', label: 'nav.floor', glyph: 'floor', permission: 'floor:read' },
  { href: '/reservations', label: 'nav.reservations', glyph: 'reservations', permission: 'reservations:read' },
  { href: '/menu', label: 'nav.menu', glyph: 'menu', permission: 'menu:read' },
  { href: '/inventory', label: 'nav.inventory', glyph: 'inventory', permission: 'inventory:read' },
  { href: '/customers', label: 'nav.customers', glyph: 'customers', permission: 'customers:read' },
  { href: '/analytics', label: 'nav.analytics', glyph: 'analytics', permission: 'analytics:read' },
];

function QuickLinks() {
  const { t } = useT();
  const { org, can } = useOrg();
  const links = QUICK_LINKS.filter((l) => can(l.permission));
  if (!links.length) return null;
  return (
    <Section title={t('insights.overview.quickLinks')}>
      <div className="grid grid-4 gap-10">
        {links.map((l) => (
          <Link key={l.href} href={`/dashboard/${org.id}${l.href}`} className="btn" style={{ justifyContent: 'flex-start' }}>
            <NavGlyph name={l.glyph} /> {t(l.label)}
          </Link>
        ))}
      </div>
    </Section>
  );
}

export default function OverviewPage() {
  const { t, locale, dir } = useT();
  const { org, can, hasModule, branchId: shellBranch } = useOrg();
  const f = useFormat();
  const branchName = useBranchName();
  // The overview follows the shell's branch switcher ("All branches" supported, 21-SHELL).
  const { branchId } = useBranchScope({ allowAll: true });
  const allowed = can('analytics:read');
  const { data, error, loading, reload } = useApi<Overview>(allowed ? `/o/${org.id}/analytics/overview${qs({ branchId })}` : null, { pollMs: 60_000 });
  // Guest satisfaction today (VS-27 ratings); "—" until a guest has rated, never a made-up score.
  const ratings = useApi<{ count: number; averages: { overall: number | null } }>(allowed && data ? `/o/${org.id}/analytics/ratings${qs({ from: data.date, to: data.date, branchId, compare: 'none' })}` : null, { pollMs: 60_000 });
  // The floor / launch card shows one branch: the one picked here, else the one chosen in the shell.
  const floorBranch = org.branches.find((b) => b.id === (branchId || shellBranch)) ?? org.branches[0];
  const mode = (floorBranch?.serviceMode ?? 'tables') as 'tables' | 'counter' | 'online';

  const trend = useMemo(() => {
    if (!data) return null;
    const nowHour = Number(data.localTime.slice(0, 2));
    let a = 0, b = 0;
    const today: number[] = [], lastWeek: number[] = [];
    for (const h of data.hourly) {
      a += h.todayNetMinor; b += h.lastWeekNetMinor;
      today.push(h.hour <= nowHour ? a : NaN);
      lastWeek.push(b);
    }
    const n = nowHour + 1;
    return { labels: data.hourly.slice(0, n).map((h) => `${String(h.hour).padStart(2, '0')}:00`), today: today.slice(0, n), lastWeek: lastWeek.slice(0, n) };
  }, [data]);

  const title = locale === 'ar' && org.nameAr ? org.nameAr : org.name;
  if (!allowed) {
    return (
      <>
        <PageHeader title={t('insights.overview.welcome', { name: title })} subtitle={t('insights.overview.noAnalytics')} />
        <QuickLinks />
      </>
    );
  }

  const oldestAt = data?.live.oldestOpenOrderAt ? Date.parse(data.live.oldestOpenOrderAt) : null;
  const oldestMinutes = oldestAt !== null ? Math.round((Date.now() - oldestAt) / 60000) : null;
  const oldest = oldestAt !== null ? formatElapsed(oldestAt, locale) : null;
  const deltaNote = (pct: number | null, value: string) => <span className="row gap-6"><Delta value={pct} /> {t('insights.overview.vsLastWeek', { value })}</span>;
  return (
    <InsightsPage>
      <PageHeader overline={t(`ops.mode.${mode}`)} title={t('nav.overview')}
        subtitle={data ? <>{t('ops.overview.measured')} · {t('insights.overview.asOf', { date: f.date(data.date), time: data.localTime, tz: data.meta.timezone })}</> : t('state.loading')}
        actions={<>
          {mode === 'tables' && can('floor:write') && floorBranch && <Link className="btn btn-primary" href={`/dashboard/${org.id}/floor?tab=studio&branch=${floorBranch.id}`}>{t('ops.overview.plan')} ↗</Link>}
        </>} />
      <LoadError error={error} retry={reload} />
      {loading && !data && <StatsStripSkeleton count={4} />}
      {data && (
        <div className="stack gap-16">
          {/* Legacy KPI strip: today's revenue, active tables, orders today, guest satisfaction. */}
          <StatsStrip label={t('nav.overview')} items={[
            { key: 'net', label: t('ops.overview.revenue'), value: f.money(data.today.netMinor), note: deltaNote(data.changePct.netMinor, f.money(data.lastWeekSameTime.netMinor)) },
            { key: 'tables', label: t('ops.overview.activeTables'), value: f.num(data.live.openVisits),
              note: t('ops.overview.openOrdersNote', { n: data.live.openOrders }) + (oldest !== null ? ` · ${t('insights.overview.oldest', { elapsed: oldest })}` : ''),
              tone: oldestMinutes !== null && oldestMinutes > 45 ? 'warn' : undefined },
            { key: 'orders', label: t('insights.overview.ordersToday'), value: f.num(data.today.orders), note: deltaNote(data.changePct.orders, f.num(data.lastWeekSameTime.orders)) },
            { key: 'csat', label: t('ops.overview.satisfaction'),
              value: ratings.data?.count && ratings.data.averages.overall !== null ? f.num(Math.round(ratings.data.averages.overall * 10) / 10) : '—',
              unit: ratings.data?.count ? '/ 5' : undefined,
              note: ratings.data ? (ratings.data.count ? t('ops.overview.ratings', { n: ratings.data.count }) : t('ops.overview.noRatings')) : undefined },
          ]} />

          <div className="ops-overview">
            {floorBranch && (mode === 'tables'
              ? (can('floor:read') ? <OverviewFloor key={floorBranch.id} orgId={org.id} branchId={floorBranch.id} canEdit={can('floor:write')} /> : <span />)
              : <LaunchCard orgId={org.id} branchId={floorBranch.id} mode={mode} slug={org.slug} />)}
            <OperationalInsights orgId={org.id} branchId={floorBranch?.id ?? null} canAsk={can('ai:use') && hasModule('intelligence')}
              canKitchen={can('kitchen:operate')} lowStock={data.lowStock.items} inventoryHref={can('inventory:read') ? `/dashboard/${org.id}/inventory?tab=alerts` : null} />
          </div>

          <div className="grid grid-2">
            <Section title={t('insights.overview.trend')}>
              {trend && trend.today.some((v) => v > 0) || (trend && trend.lastWeek.some((v) => v > 0)) ? (
                <LineChart title={t('insights.overview.trend')} labels={trend!.labels} rtl={dir === 'rtl'}
                  series={[{ name: t('insights.overview.todayCumulative'), values: trend!.today.map((v) => (Number.isNaN(v) ? 0 : v)) },
                    { name: t('insights.overview.lastWeekCumulative', { date: f.date(data.lastWeekSameTime.date) }), values: trend!.lastWeek }]}
                  format={f.money} compactFormat={f.compactMoney} xLabel={t('insights.chart.hour')} tableCaption={t('insights.chart.showTable')} />
              ) : <p className="muted">{t('insights.overview.noSalesYet')}</p>}
              <p className="fine mbs-8">{t('insights.overview.fullDayLastWeek', { value: f.money(data.lastWeekFullDay.netMinor), orders: data.lastWeekFullDay.orders })}</p>
            </Section>

            <Section title={t('insights.overview.alerts')}>
              <p className="fine mbs-0">{t('insights.overview.reservationsToday')}: <span className="num">{f.num(data.reservationsToday.total)}</span> · {t('insights.overview.guests', { count: data.reservationsToday.guests })}
                {' · '}{t('insights.kpi.aov')}: <span className="num">{f.money(data.today.averageOrderMinor)}</span></p>
              <div className="stack gap-10">
                {data.live.byStatus.awaitingPayment > 0 && <Notice tone="warn">{t('insights.overview.awaitingPayment', { count: data.live.byStatus.awaitingPayment })}</Notice>}
                {oldest !== null && oldestMinutes !== null && oldestMinutes > 45 && <Notice tone="warn">{t('insights.overview.slowOrder', { elapsed: oldest })}</Notice>}
                {data.lowStock.count > 0 ? (
                  <div>
                    <div className="spread mbe-6">
                      <strong>{t('insights.overview.lowStock', { count: data.lowStock.count })}</strong>
                      {can('inventory:read') && <Link className="btn btn-sm btn-ghost" href={`/dashboard/${org.id}/inventory?tab=alerts`}>{t('insights.overview.viewAll')}</Link>}
                    </div>
                    <ul style={{ margin: 0, paddingInlineStart: 18 }}>
                      {data.lowStock.items.map((i) => (
                        <li key={i.id}>{locale === 'ar' && i.nameAr ? i.nameAr : i.name} — <span className="num">{f.num(i.quantity)} {unitLabel(t, i.unit)}</span>
                          <span className="fine"> ({t('insights.inventory.reorderAt', { level: f.num(i.reorderLevel) })} · {branchName(i.branchId)})</span></li>
                      ))}
                    </ul>
                  </div>
                ) : <p className="muted m-0"><Badge tone="ok">✓</Badge> {t('insights.overview.stockOk')}</p>}
                {data.live.byStatus.ready > 0 && <p className="fine m-0">{t('insights.overview.readyWaiting', { count: data.live.byStatus.ready })}</p>}
              </div>
            </Section>
          </div>
          <MetaPanel meta={data.meta} />
        </div>
      )}
    </InsightsPage>
  );
}
