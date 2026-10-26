'use client';
// The overview command centre (21-HOME, plan §6.1): five rows that answer "what is happening now", "how are we
// doing", "what needs me", "where do customers come from" and "what should I do next". The branch comes from the
// shell (one branch context, "All branches" supported); the period and comparison live in the URL; the order and
// visibility of the rows are the member's own preference ("Customise", GET/PUT preferences/overview).
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useMemo, useRef, useState, type ReactNode } from 'react';
import type { ModuleKey, Permission } from '@resuto/contracts';
import type { AttentionResponse, OverviewCompare, OverviewPreferencesResponse, OverviewSectionId } from '@resuto/contracts/home';
import { normaliseOverviewPreferences, sameOverviewPreferences, type OverviewPreferences } from '@/lib/contracts-home';
import { DateTimeInput, NavGlyph, Notice, PageHeader, SegmentedControl, SkeletonStats, type NavGlyphName } from '@resuto/ui';
import '@/components/ops/ops.css';
import { LoadError, MetaPanel, qs, useFormat } from '@/components/charts/insights';
import { withParams } from '@/components/ops/use-url-state';
import { drillDownHref, type InsightsSection } from '@/lib/insights';
import { useT } from '@/lib/i18n/client';
import { useBranchScope, useOrg } from '@/lib/org-context';
import { useSession } from '@/lib/session';
import { useApi } from '@/lib/use-api';
import { Attention } from './Attention';
import { Customers } from './Customers';
import { attentionPath, COMPARES, overviewPath, PERIOD_PRESETS, periodRange, sectionAvailable, shownSections, type HomeAccess, type PeriodPreset } from './model';
import { Performance, type RatingsData } from './Performance';
import { RightNow } from './RightNow';
import type { OverviewData } from './types';
import s from './home.module.css';

const CustomiseSheet = dynamic(() => import('./CustomiseSheet'), { ssr: false });
// Insights and the ask box: a separate chunk (it needs the full contracts entry, which the first load does not).
const NextActions = dynamic(() => import('./NextActions').then((m) => m.NextActions), { ssr: false, loading: () => <div className="skeleton" aria-hidden="true" /> });

const QUICK_LINKS: Array<{ href: string; label: string; glyph: NavGlyphName; permission: Permission }> = [
  { href: '/orders', label: 'nav.orders', glyph: 'orders', permission: 'orders:read' },
  { href: '/kitchen', label: 'nav.kitchen', glyph: 'kitchen', permission: 'kitchen:operate' },
  { href: '/floor', label: 'nav.floor', glyph: 'floor', permission: 'floor:read' },
  { href: '/reservations', label: 'nav.reservations', glyph: 'reservations', permission: 'reservations:read' },
  { href: '/menu', label: 'nav.menu', glyph: 'menu', permission: 'menu:read' },
  { href: '/inventory', label: 'nav.inventory', glyph: 'inventory', permission: 'inventory:read' },
  { href: '/customers', label: 'nav.customers', glyph: 'customers', permission: 'customers:read' },
];

function QuickLinks() {
  const { t } = useT();
  const { org, can } = useOrg();
  const links = QUICK_LINKS.filter((l) => can(l.permission));
  if (!links.length) return null;
  return (
    <section className={s.section} aria-labelledby="home-links">
      <h2 id="home-links" className={s.sectionTitle}>{t('insights.overview.quickLinks')}</h2>
      <div className="grid grid-4 gap-10">
        {links.map((l) => <Link key={l.href} href={`/dashboard/${org.id}${l.href}`} className="btn"><NavGlyph name={l.glyph} /> {t(l.label)}</Link>)}
      </div>
    </section>
  );
}

/** Period and comparison in the URL (?period=7d&compare=last_year, custom dates as from/to), so reloads and links keep them. */
function usePeriodParams(timeZone: string) {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const preset = (PERIOD_PRESETS as readonly string[]).includes(params.get('period') ?? '') ? params.get('period') as PeriodPreset : 'today';
  const compare = (COMPARES as readonly string[]).includes(params.get('compare') ?? '') ? params.get('compare') as OverviewCompare : 'previous_period';
  const custom = { from: params.get('from'), to: params.get('to') };
  const range = periodRange(preset, timeZone, custom);
  const set = useCallback((patch: Record<string, string | null>) => {
    router.replace(`${pathname}${withParams(window.location.search, patch, { period: 'today', compare: 'previous_period' })}`, { scroll: false });
  }, [pathname, router]);
  return { preset, compare, range, set };
}

export default function OverviewPage() {
  const { t, locale } = useT();
  const { org, can, hasModule, branchId: shellBranch } = useOrg();
  const f = useFormat();
  const { call } = useSession();
  // The overview follows the shell's branch switcher ("All branches" supported, 21-SHELL): never its own branch select.
  const { branchId } = useBranchScope({ allowAll: true });
  const access: HomeAccess = useMemo(() => ({ can: (p) => can(p as Permission), hasModule: (m) => hasModule(m as ModuleKey) }), [can, hasModule]);
  const analytics = can('analytics:read');
  const { preset, compare, range, set } = usePeriodParams(org.timezone);

  const overview = useApi<OverviewData>(analytics ? overviewPath(org.id, { branchId, ...range, compare }) : null, { pollMs: 60_000 });
  const attention = useApi<AttentionResponse>(attentionPath(org.id, branchId), { pollMs: 60_000 });
  // Guest satisfaction for the period (VS-27 ratings); "—" until a guest has rated, never a made-up score.
  const ratings = useApi<RatingsData>(analytics ? `/o/${org.id}/analytics/ratings${qs({ ...range, branchId, compare: 'none' })}` : null, { pollMs: 5 * 60_000 });
  const stored = useApi<OverviewPreferencesResponse>(`/o/${org.id}/preferences/overview`);

  // The layout: the saved preference (or the default), with local edits shown at once while they save.
  const [draft, setDraft] = useState<OverviewPreferences | null>(null);
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [customising, setCustomising] = useState(false);
  const prefs = draft ?? normaliseOverviewPreferences(stored.data?.value);
  // Each change is saved at once; only the answer to the latest save is applied (answers can arrive out of order).
  const seq = useRef(0);
  const save = async (next: OverviewPreferences) => {
    const mine = ++seq.current;
    setDraft(next);
    setStatus('saving');
    try {
      const res = await call<OverviewPreferencesResponse>(`/o/${org.id}/preferences/overview`, { method: 'PUT', body: next });
      if (mine !== seq.current) return;
      stored.setData(res);
      setDraft((d) => (d && sameOverviewPreferences(d, res.value) ? null : d));
      setStatus('saved');
    } catch {
      if (mine === seq.current) setStatus('error');
    }
  };

  const floorBranch = org.branches.find((b) => b.id === (branchId || shellBranch)) ?? org.branches[0];
  const mode = (floorBranch?.serviceMode ?? 'tables') as 'tables' | 'counter' | 'online';
  const data = overview.data;
  const period = data?.period;
  const sections = shownSections(prefs, access);
  const availableCount = prefs.sections.filter((x) => sectionAvailable(x.id, access)).length;
  const title = locale === 'ar' && org.nameAr ? org.nameAr : org.name;
  const hourlyToday = data && period?.days === 1 && period.to === data.date
    ? data.hourly.filter((h) => h.hour <= Number(data.localTime.slice(0, 2))).map((h) => h.todayNetMinor) : null;

  const body: Record<OverviewSectionId, () => ReactNode> = {
    now: () => (data ? <RightNow data={data} orgId={org.id} slug={org.slug} timeZone={org.timezone} floorBranchId={floorBranch?.id ?? null} mode={mode}
      canFloor={can('floor:read')} canEditFloor={can('floor:write')} /> : <SkeletonStats count={4} />),
    performance: () => (period ? <Performance period={period} hourlyToday={hourlyToday} ratings={ratings.data} drill={drill} /> : <SkeletonStats count={5} />),
    attention: () => (attention.data ? <Attention data={attention.data} orgId={org.id} timeZone={org.timezone} />
      : attention.error ? <LoadError error={attention.error} retry={attention.reload} /> : <SkeletonStats count={2} />),
    customers: () => (period ? <Customers period={period} drill={drill} /> : <SkeletonStats count={4} />),
    actions: () => <NextActions orgId={org.id} branchId={branchId || null} access={access} />,
  };
  const notes: Partial<Record<OverviewSectionId, ReactNode>> = {
    performance: period?.comparison ? t('home.perf.vs', { from: f.date(period.comparison.from), to: f.date(period.comparison.to) }) : null,
  };
  const usesPeriod = sections.includes('performance') || sections.includes('customers');
  // Drill-down (21-INSIGHTS): each Performance and Customers widget opens its Insights view with this period,
  // comparison and branch.
  const drill = (section: InsightsSection) => `/dashboard/${org.id}${drillDownHref(section, { preset, compare, from: range.from, to: range.to, branchId })}`;

  return (
    <div className={s.page}>
      <PageHeader overline={t(`ops.mode.${mode}`)} title={analytics ? t('nav.overview') : t('insights.overview.welcome', { name: title })}
        subtitle={!analytics ? t('insights.overview.noAnalytics')
          : data ? <>{t('ops.overview.measured')} · {t('insights.overview.asOf', { date: f.date(data.date), time: data.localTime, tz: data.meta.timezone })}</> : t('state.loading')}
        actions={<>
          {mode === 'tables' && can('floor:write') && floorBranch && <Link className="btn" href={`/dashboard/${org.id}/floor?tab=studio&branch=${floorBranch.id}`}>{t('ops.overview.plan')} ↗</Link>}
          {availableCount > 1 && <button type="button" className="btn btn-primary" aria-haspopup="dialog" onClick={() => setCustomising(true)}>{t('home.customise')}</button>}
        </>} />

      {analytics && usesPeriod && (
        <div className={s.toolbar} role="group" aria-label={t('insights.period.label')}>
          <div className={s.toolbarGroup}>
            <SegmentedControl label={t('insights.period.label')} size="sm" value={preset}
              onChange={(v) => set(v === 'custom' ? { period: v, from: range.from, to: range.to } : { period: v, from: null, to: null })}
              options={PERIOD_PRESETS.map((p) => ({ value: p, label: t(`insights.period.${p}`) }))} />
            {preset === 'custom' && (
              <>
                <DateTimeInput type="date" className={s.date} aria-label={t('insights.period.from')} value={range.from} max={range.to}
                  onChange={(e) => e.target.value && set({ period: 'custom', from: e.target.value, to: range.to })} />
                <DateTimeInput type="date" className={s.date} aria-label={t('insights.period.to')} value={range.to} min={range.from}
                  onChange={(e) => e.target.value && set({ period: 'custom', from: range.from, to: e.target.value })} />
              </>
            )}
          </div>
          <div className={s.toolbarGroup}>
            <span className={s.toolbarLabel} aria-hidden="true">{t('home.perf.compare')}</span>
            <SegmentedControl label={t('home.perf.compare')} size="sm" value={compare} onChange={(v) => set({ compare: v })}
              options={COMPARES.map((c) => ({ value: c, label: t(`home.compare.${c}`) }))} />
          </div>
        </div>
      )}
      <LoadError error={overview.error} retry={overview.reload} />

      {sections.length === 0 && availableCount > 0 && <Notice>{t('home.customise.allHidden')}</Notice>}
      {sections.map((id) => (
        <section key={id} className={`${s.section} motion-fade-in`} aria-labelledby={`home-${id}`} data-section={id}>
          <div className={s.sectionHead}>
            <h2 id={`home-${id}`} className={s.sectionTitle}>{t(`home.section.${id}`)}</h2>
            {notes[id] && <p className={s.sectionNote}>{notes[id]}</p>}
          </div>
          {body[id]()}
        </section>
      ))}

      {!analytics && <QuickLinks />}
      {analytics && period && <MetaPanel meta={period.meta} />}
      {customising && (
        <CustomiseSheet open={customising} onClose={() => setCustomising(false)} prefs={prefs} onChange={(next) => void save(next)} status={status} access={access} />
      )}
    </div>
  );
}
