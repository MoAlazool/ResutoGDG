'use client';
import Link from 'next/link';
import { useMemo, useState } from 'react';
import type { AnalyticsMeta, Permission } from '@resuto/contracts';
import { Badge, Notice, PageHeader, Skeleton, Stat } from '@resuto/ui';
import { LineChart } from '@/components/charts';
import { BranchSelect, Delta, InsightsPage, LoadError, MetaPanel, qs, Section, useBranchName, useFormat } from '@/components/charts/insights';
import { useT } from '@/lib/i18n/client';
import { useOrg } from '@/lib/org-context';
import { useApi } from '@/lib/use-api';

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

const QUICK_LINKS: Array<{ href: string; label: string; icon: string; permission: Permission }> = [
  { href: '/orders', label: 'nav.orders', icon: '🧾', permission: 'orders:read' },
  { href: '/kitchen', label: 'nav.kitchen', icon: '🔥', permission: 'kitchen:operate' },
  { href: '/reservations', label: 'nav.reservations', icon: '📅', permission: 'reservations:read' },
  { href: '/menu', label: 'nav.menu', icon: '🍽', permission: 'menu:read' },
  { href: '/inventory', label: 'nav.inventory', icon: '📦', permission: 'inventory:read' },
  { href: '/customers', label: 'nav.customers', icon: '👥', permission: 'customers:read' },
  { href: '/analytics', label: 'nav.analytics', icon: '📈', permission: 'analytics:read' },
];

function QuickLinks() {
  const { t } = useT();
  const { org, can } = useOrg();
  const links = QUICK_LINKS.filter((l) => can(l.permission));
  if (!links.length) return null;
  return (
    <Section title={t('insights.overview.quickLinks')}>
      <div className="grid grid-4" style={{ gap: 10 }}>
        {links.map((l) => (
          <Link key={l.href} href={`/dashboard/${org.id}${l.href}`} className="btn" style={{ justifyContent: 'flex-start' }}>
            <span aria-hidden>{l.icon}</span> {t(l.label)}
          </Link>
        ))}
      </div>
    </Section>
  );
}

export default function OverviewPage() {
  const { t, locale, dir } = useT();
  const { org, can } = useOrg();
  const f = useFormat();
  const branchName = useBranchName();
  const [branchId, setBranchId] = useState('');
  const allowed = can('analytics:read');
  const { data, error, loading, reload } = useApi<Overview>(allowed ? `/o/${org.id}/analytics/overview${qs({ branchId })}` : null, { pollMs: 60_000 });

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

  const oldestMinutes = data?.live.oldestOpenOrderAt ? Math.round((Date.now() - Date.parse(data.live.oldestOpenOrderAt)) / 60000) : null;
  return (
    <InsightsPage>
      <PageHeader overline={t('nav.overview')} title={title}
        subtitle={data ? t('insights.overview.asOf', { date: f.date(data.date), time: data.localTime, tz: data.meta.timezone }) : t('state.loading')}
        actions={<BranchSelect value={branchId} onChange={setBranchId} />} />
      <LoadError error={error} retry={reload} />
      {loading && !data && <div className="card"><Skeleton lines={5} /></div>}
      {data && (
        <div className="stack" style={{ gap: 16 }}>
          <div className="grid grid-3">
            <Stat label={t('insights.overview.netToday')} value={f.money(data.today.netMinor)}
              hint={<span className="row" style={{ gap: 6 }}><Delta value={data.changePct.netMinor} /> {t('insights.overview.vsLastWeek', { value: f.money(data.lastWeekSameTime.netMinor) })}</span>} />
            <Stat label={t('insights.overview.ordersToday')} value={f.num(data.today.orders)}
              hint={<span className="row" style={{ gap: 6 }}><Delta value={data.changePct.orders} /> {t('insights.overview.vsLastWeek', { value: f.num(data.lastWeekSameTime.orders) })}</span>} />
            <Stat label={t('insights.kpi.aov')} value={f.money(data.today.averageOrderMinor)}
              hint={<span className="row" style={{ gap: 6 }}><Delta value={data.changePct.averageOrderMinor} /> {t('insights.overview.vsLastWeek', { value: f.money(data.lastWeekSameTime.averageOrderMinor) })}</span>} />
            <Stat label={t('insights.overview.openOrders')} value={f.num(data.live.openOrders)}
              hint={oldestMinutes !== null ? t('insights.overview.oldest', { minutes: oldestMinutes }) : t('insights.overview.noneOpen')}
              tone={oldestMinutes !== null && oldestMinutes > 45 ? 'warn' : undefined} />
            <Stat label={t('insights.overview.openTables')} value={f.num(data.live.openVisits)} />
            <Stat label={t('insights.overview.reservationsToday')} value={f.num(data.reservationsToday.total)}
              hint={t('insights.overview.guests', { count: data.reservationsToday.guests })} />
          </div>

          <div className="grid grid-2">
            <Section title={t('insights.overview.trend')}>
              {trend && trend.today.some((v) => v > 0) || (trend && trend.lastWeek.some((v) => v > 0)) ? (
                <LineChart title={t('insights.overview.trend')} labels={trend!.labels} rtl={dir === 'rtl'}
                  series={[{ name: t('insights.overview.todayCumulative'), values: trend!.today.map((v) => (Number.isNaN(v) ? 0 : v)) },
                    { name: t('insights.overview.lastWeekCumulative', { date: f.date(data.lastWeekSameTime.date) }), values: trend!.lastWeek }]}
                  format={f.money} compactFormat={f.compactMoney} xLabel={t('insights.chart.hour')} tableCaption={t('insights.chart.showTable')} />
              ) : <p className="muted">{t('insights.overview.noSalesYet')}</p>}
              <p className="fine" style={{ marginBlockStart: 8 }}>{t('insights.overview.fullDayLastWeek', { value: f.money(data.lastWeekFullDay.netMinor), orders: data.lastWeekFullDay.orders })}</p>
            </Section>

            <Section title={t('insights.overview.alerts')}>
              <div className="stack" style={{ gap: 10 }}>
                {data.live.byStatus.awaitingPayment > 0 && <Notice tone="warn">{t('insights.overview.awaitingPayment', { count: data.live.byStatus.awaitingPayment })}</Notice>}
                {oldestMinutes !== null && oldestMinutes > 45 && <Notice tone="warn">{t('insights.overview.slowOrder', { minutes: oldestMinutes })}</Notice>}
                {data.lowStock.count > 0 ? (
                  <div>
                    <div className="spread" style={{ marginBlockEnd: 6 }}>
                      <strong>{t('insights.overview.lowStock', { count: data.lowStock.count })}</strong>
                      {can('inventory:read') && <Link className="btn btn-sm btn-ghost" href={`/dashboard/${org.id}/inventory?tab=alerts`}>{t('insights.overview.viewAll')}</Link>}
                    </div>
                    <ul style={{ margin: 0, paddingInlineStart: 18 }}>
                      {data.lowStock.items.map((i) => (
                        <li key={i.id}>{locale === 'ar' && i.nameAr ? i.nameAr : i.name} — <span className="num">{f.num(i.quantity)} {i.unit}</span>
                          <span className="fine"> ({t('insights.inventory.reorderAt', { level: f.num(i.reorderLevel) })} · {branchName(i.branchId)})</span></li>
                      ))}
                    </ul>
                  </div>
                ) : <p className="muted" style={{ margin: 0 }}><Badge tone="ok">✓</Badge> {t('insights.overview.stockOk')}</p>}
                {data.live.byStatus.ready > 0 && <p className="fine" style={{ margin: 0 }}>{t('insights.overview.readyWaiting', { count: data.live.byStatus.ready })}</p>}
              </div>
            </Section>
          </div>
          <QuickLinks />
          <MetaPanel meta={data.meta} />
        </div>
      )}
    </InsightsPage>
  );
}
