'use client';
// The Insights area shell (21-INSIGHTS): one header, one SectionNav (analytics, then intelligence: it replaces the
// Analytics tabs and IntelShell), the period/comparison toolbar and the saved-report controls, and one branch context
// (the shell's branch switcher; a link's `?branch=` selects it on arrival). The view lives in the URL
// (lib/insights.ts), so a reload, a drill-down from the overview and a saved report all reopen the same view.
import dynamic from 'next/dynamic';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { createContext, useCallback, useContext, useEffect, useMemo, type ReactNode } from 'react';
import type { ModuleKey, Permission } from '@resuto/contracts';
import { DateTimeInput, PageHeader, SegmentedControl } from '@resuto/ui';
import { ModuleGate } from '@/components/shell/ModuleGate';
import { SectionNav } from '@/components/shell/SectionNav';
import { withParams } from '@/components/ops/use-url-state';
import { REPORT_COMPARE, REPORT_PERIODS, REPORT_SECTIONS, type ReportCompare, type ReportPeriod, type ReportSection, type ReportView } from '@/lib/contracts-reports';
import {
  apiCompare, branchParam, COMPARE_SECTIONS, DEFAULT_COMPARE, DEFAULT_PERIOD, periodRange, PERIOD_SECTIONS, readView, viewParams, type InsightsSection,
} from '@/lib/insights';
import { useT } from '@/lib/i18n/client';
import { useBranchScope, useOrg } from '@/lib/org-context';
import { INSIGHTS_SECTIONS } from '@/lib/sections';
import s from './insights.module.css';

// Saving and opening reports: a separate chunk, loaded after the page (it is not needed to read the figures).
const ReportControls = dynamic(() => import('./ReportControls').then((m) => m.ReportControls), { ssr: false });

const INTELLIGENCE: readonly InsightsSection[] = ['findings', 'forecast', 'recommendations', 'research', 'routes'];

export interface InsightsContext {
  section: InsightsSection;
  view: ReportView;
  /** Local dates of the period. */
  range: { from: string; to: string };
  /** The period as the analytics panels take it. */
  period: { from: string; to: string; preset: string };
  /** The analytics API's comparison. */
  compare: 'previous' | 'last_year' | 'none';
  /** The shell's branch ('' = All branches, only on analytics views). */
  branchId: string;
  /** Changes the view in the URL (null removes a key). */
  setParams(patch: Record<string, string | null>): void;
}

const Ctx = createContext<InsightsContext | null>(null);

export function useInsights(): InsightsContext {
  const v = useContext(Ctx);
  if (!v) throw new Error('useInsights must be used inside InsightsShell');
  return v;
}

/** The URL's `?branch=` selects that branch (or All) in the shell's switcher once, then leaves the URL. */
function useBranchFromLink(allowAll: boolean) {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const { org, branchId: shellBranch, allBranches } = useOrg();
  const scope = useBranchScope({ allowAll });
  const wanted = branchParam(params.get('branch'));
  const { setBranchId } = scope;
  useEffect(() => {
    if (!wanted) return;
    if (wanted === 'all') { if (allowAll && !allBranches) setBranchId(''); }
    else if (org.branches.some((b) => b.id === wanted && b.isActive !== false) && (wanted !== shellBranch || allBranches)) setBranchId(wanted);
    router.replace(`${pathname}${withParams(window.location.search, { branch: null })}`, { scroll: false });
  }, [wanted, allowAll, allBranches, shellBranch, org.branches, setBranchId, pathname, router]);
  return scope;
}

export function InsightsShell({ section, children, title, subtitle, actions, module, permission }: {
  section: InsightsSection; children: ReactNode; title?: ReactNode; subtitle?: ReactNode; actions?: ReactNode;
  module?: ModuleKey; permission?: Permission;
}) {
  const { t } = useT();
  const { org } = useOrg();
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const intelligence = INTELLIGENCE.includes(section);
  const { branchId } = useBranchFromLink(!intelligence);
  const search = params.toString();
  const view = useMemo(() => readView(section, new URLSearchParams(search)), [section, search]);
  const { from, to } = periodRange(view.period, org.timezone, view);
  const setParams = useCallback((patch: Record<string, string | null>) => {
    router.replace(`${pathname}${withParams(window.location.search, patch, { period: DEFAULT_PERIOD, compare: DEFAULT_COMPARE })}`, { scroll: false });
  }, [pathname, router]);
  const value = useMemo<InsightsContext>(() => ({
    section, view, range: { from, to }, period: { from, to, preset: view.period }, compare: apiCompare(view.compare), branchId, setParams,
  }), [section, view, from, to, branchId, setParams]);
  const range = value.range;
  const usesPeriod = PERIOD_SECTIONS.includes(section);
  const savable = (REPORT_SECTIONS as readonly string[]).includes(section);
  // The section links keep the period and comparison (not the page's own filters).
  const carry = viewParams({ period: view.period, compare: view.compare, from: view.from, to: view.to }).toString();
  const heading = title ?? t(section === 'overview' ? 'insights.analytics.title' : `insights.area.${section}`);

  return (
    <ModuleGate module={module ?? (intelligence ? 'intelligence' : 'core')} permission={permission ?? (intelligence ? 'ai:use' : 'analytics:read')}>
      <div className={s.page}>
        <PageHeader overline={t('nav.area.insights')} title={heading}
          subtitle={subtitle ?? t(intelligence ? 'intelligence.subtitle' : 'insights.analytics.subtitle')} actions={actions} />
        <SectionNav sections={INSIGHTS_SECTIONS} label={t('nav.area.insights')} query={usesPeriod ? carry : undefined} />
        {(usesPeriod || savable) && (
          <div className={s.toolbar} role="group" aria-label={t('insights.area.toolbar')}>
            {usesPeriod && <PeriodControls view={view} range={range} compare={COMPARE_SECTIONS.includes(section)} onChange={setParams} />}
            {savable && <div className={s.toolbarEnd}><ReportControls section={section as ReportSection} view={view} branchId={branchId} /></div>}
          </div>
        )}
        <Ctx.Provider value={value}>{children}</Ctx.Provider>
      </div>
    </ModuleGate>
  );
}

function PeriodControls({ view, range, compare, onChange }: {
  view: ReportView; range: { from: string; to: string }; compare: boolean; onChange: (patch: Record<string, string | null>) => void;
}) {
  const { t } = useT();
  const custom = view.period === 'custom';
  return (
    <div className={s.group}>
      <label className={s.field}>
        <span className="sr-only">{t('insights.period.label')}</span>
        <select className={`select ${s.select}`} value={view.period} aria-label={t('insights.period.label')}
          onChange={(e) => {
            const p = e.target.value as ReportPeriod;
            onChange(p === 'custom' ? { period: p, from: range.from, to: range.to } : { period: p, from: null, to: null });
          }}>
          {REPORT_PERIODS.map((p) => <option key={p} value={p}>{t(`insights.period.${p}`)}</option>)}
        </select>
      </label>
      {custom && (
        <>
          <DateTimeInput type="date" className={s.date} aria-label={t('insights.period.from')} value={range.from} max={range.to}
            onChange={(e) => e.target.value && onChange({ period: 'custom', from: e.target.value, to: range.to })} />
          <DateTimeInput type="date" className={s.date} aria-label={t('insights.period.to')} value={range.to} min={range.from}
            onChange={(e) => e.target.value && onChange({ period: 'custom', from: range.from, to: e.target.value })} />
        </>
      )}
      {compare && (
        <SegmentedControl<ReportCompare> label={t('home.perf.compare')} size="sm" value={view.compare} onChange={(v) => onChange({ compare: v })}
          options={REPORT_COMPARE.map((c) => ({ value: c, label: t(`home.compare.${c}`) }))} />
      )}
    </div>
  );
}
