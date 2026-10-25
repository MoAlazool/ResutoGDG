'use client';
// The Insights area shell (21-INSIGHTS): one header, one SectionNav (analytics, then intelligence: it replaces the
// Analytics tabs and IntelShell), the toolbar (the analytics views pass the period/comparison controls) with the
// saved-report controls, and one branch context (the shell's branch switcher; a link's `?branch=` selects it on
// arrival). The view lives in the URL (lib/insights.ts), so a reload, a drill-down from the overview and a saved report
// all reopen the same view.
import dynamic from 'next/dynamic';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, type ReactNode } from 'react';
import type { ModuleKey, Permission } from '@resuto/contracts';
import { PageHeader } from '@resuto/ui';
import { ModuleGate } from '@/components/shell/ModuleGate';
import { SectionNav } from '@/components/shell/SectionNav';
import { withParams } from '@/components/ops/use-url-state';
import { REPORT_SECTIONS, type ReportSection, type ReportView } from '@/lib/contracts-reports';
import { apiCompare, branchParam, DEFAULT_COMPARE, DEFAULT_PERIOD, periodRange, PERIOD_SECTIONS, readView, viewParams, type InsightsSection } from '@/lib/insights';
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
  const latest = useRef({ setBranchId: scope.setBranchId, shellBranch, allBranches, branches: org.branches });
  latest.current = { setBranchId: scope.setBranchId, shellBranch, allBranches, branches: org.branches };
  const handled = useRef<string | null>(null);
  useEffect(() => {
    if (!wanted || handled.current === wanted) return;
    handled.current = wanted;
    const { setBranchId, shellBranch: current, allBranches: all, branches } = latest.current;
    if (wanted === 'all') { if (allowAll && !all) setBranchId(''); }
    else if (branches.some((b) => b.id === wanted && b.isActive !== false) && (wanted !== current || all)) setBranchId(wanted);
    router.replace(`${pathname}${withParams(window.location.search, { branch: null })}`, { scroll: false });
  }, [wanted, allowAll, pathname, router]);
  return scope;
}

export function InsightsShell({ section, children, toolbar, title, subtitle, actions, module, permission }: {
  section: InsightsSection; children: ReactNode;
  /** Controls at the start of the toolbar (the analytics views pass PeriodControls). */
  toolbar?: ReactNode;
  title?: ReactNode; subtitle?: ReactNode; actions?: ReactNode; module?: ModuleKey; permission?: Permission;
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
  const savable = (REPORT_SECTIONS as readonly string[]).includes(section);
  // The section links keep the period and comparison (not the page's own filters).
  const carry = PERIOD_SECTIONS.includes(section) ? viewParams({ period: view.period, compare: view.compare, from: view.from, to: view.to }).toString() : undefined;
  const heading = title ?? t(section === 'overview' ? 'insights.analytics.title' : `insights.area.${section}`);

  return (
    <ModuleGate module={module ?? (intelligence ? 'intelligence' : 'core')} permission={permission ?? (intelligence ? 'ai:use' : 'analytics:read')}>
      <Ctx.Provider value={value}>
        <div className={s.page}>
          <PageHeader overline={t('nav.area.insights')} title={heading}
            subtitle={subtitle ?? t(intelligence ? 'intelligence.subtitle' : 'insights.analytics.subtitle')} actions={actions} />
          <SectionNav sections={INSIGHTS_SECTIONS} label={t('nav.area.insights')} query={carry} />
          {(toolbar || savable) && (
            <div className={s.toolbar} role="group" aria-label={t('insights.area.toolbar')}>
              {toolbar}
              {savable && <div className={s.toolbarEnd}><ReportControls section={section as ReportSection} view={view} branchId={branchId} /></div>}
            </div>
          )}
          {children}
        </div>
      </Ctx.Provider>
    </ModuleGate>
  );
}
