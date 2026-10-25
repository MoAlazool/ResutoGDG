'use client';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useState, type ReactNode } from 'react';
import { isoDateIn } from '@resuto/contracts/lite';
import { Field, PageHeader, SelectField } from '@resuto/ui';
import { ModuleGate } from '@/components/shell/ModuleGate';
import { SectionNav } from '@/components/shell/SectionNav';
import { date, money } from '@/lib/format';
import { useT } from '@/lib/i18n/client';
import { useBranchScope, useOrg } from '@/lib/org-context';
import { FINANCE_SECTIONS } from '@/lib/sections';
import styles from './finance.module.css';
import { COMPARE_MODES, compareRange, PERIOD_PRESETS, presetOf, presetRange, validPeriod, type CompareMode, type DateRange, type PeriodPreset } from './period';

export interface Period { from: string; to: string; branchId: string; compare: CompareMode; previous: DateRange | null }

/** The restaurant's calendar date today (its time zone), YYYY-MM-DD. */
function useToday() {
  const { org } = useOrg();
  return isoDateIn(Date.now(), org.timezone || 'UTC');
}

const rangeQuery = (r: DateRange, branchId: string) => new URLSearchParams({ from: r.from, to: r.to, ...(branchId ? { branchId } : {}) }).toString();

/**
 * Period from the URL (?from&to&compare), defaulting to month to date compared with the previous period; the branch is
 * the shell's branch switcher (21-SHELL single branch context, "All branches" supported). `query` and
 * `previousQuery` are the finance API's period parameters for the period and its comparison (null without one).
 */
export function usePeriod(): Period & { query: string; previousQuery: string | null } {
  const sp = useSearchParams();
  const today = useToday();
  const { branchId } = useBranchScope({ allowAll: true });
  const asked = { from: sp.get('from') ?? '', to: sp.get('to') ?? '' };
  const range = validPeriod(asked) ? asked : presetRange('mtd', today);
  const c = sp.get('compare');
  const compare: CompareMode = (COMPARE_MODES as readonly string[]).includes(c ?? '') ? (c as CompareMode) : 'previous_period';
  const previous = compareRange(range, compare);
  return { ...range, branchId, compare, previous, query: rangeQuery(range, branchId), previousQuery: previous ? rangeQuery(previous, branchId) : null };
}

export function useMoney() {
  const { org } = useOrg();
  const { locale } = useT();
  return (v: number | null | undefined) => money(v, org.currency, locale);
}
export const pct = (bp: number | null | undefined) => (bp === null || bp === undefined ? '—' : `${(bp / 100).toFixed(1)}%`);

/**
 * The Finance area: header, SectionNav (FINANCE_SECTIONS, keeping the period across sections) and the period picker:
 * a preset or custom dates, and what to compare with. A preset or comparison applies at once; custom dates apply on
 * submit (the API takes at most one year).
 */
export function FinanceFrame({ children, actions, compare = true }: { children: ReactNode; actions?: ReactNode; compare?: boolean }) {
  const { t, locale } = useT();
  const router = useRouter();
  const pathname = usePathname();
  const today = useToday();
  const period = usePeriod();
  const preset = presetOf(period, today);
  const [custom, setCustom] = useState<PeriodPreset | null>(null);
  const [draft, setDraft] = useState<DateRange>({ from: period.from, to: period.to });
  const shownPreset = custom ?? preset;
  const go = (r: DateRange, mode: CompareMode) => router.push(`${pathname}?${new URLSearchParams({ from: r.from, to: r.to, ...(mode !== 'previous_period' ? { compare: mode } : {}) })}`);
  const keep = new URLSearchParams({ from: period.from, to: period.to, ...(period.compare !== 'previous_period' ? { compare: period.compare } : {}) }).toString();
  const d = (x: string) => date(`${x}T12:00:00Z`, locale, 'UTC');
  const summary = period.previous && compare
    ? t('finance.compare.summary', { from: d(period.from), to: d(period.to), pfrom: d(period.previous.from), pto: d(period.previous.to) })
    : t('finance.compare.only', { from: d(period.from), to: d(period.to) });
  return (
    <ModuleGate module="finance" permission="finance:read">
      <PageHeader title={t('finance.title')} subtitle={t('finance.subtitle')} actions={actions} />
      <SectionNav sections={FINANCE_SECTIONS} label={t('finance.title')} query={keep} />
      <form className={`card ${styles.picker}`} onSubmit={(e) => {
        e.preventDefault();
        if (validPeriod(draft)) { setCustom(null); go(draft, period.compare); }
      }}>
        <div className={styles.pickerRow}>
          <SelectField label={t('finance.period.label')} value={shownPreset} onChange={(e) => {
            const p = e.target.value as PeriodPreset;
            if (p === 'custom') { setCustom('custom'); setDraft({ from: period.from, to: period.to }); return; }
            setCustom(null);
            go(presetRange(p, today), period.compare);
          }}>
            {PERIOD_PRESETS.map((p) => <option key={p} value={p}>{t(`finance.preset.${p}`)}</option>)}
          </SelectField>
          {shownPreset === 'custom' && (
            <>
              <Field label={t('finance.period.from')} type="date" value={draft.from} max={draft.to} onChange={(e) => setDraft({ ...draft, from: e.target.value })} />
              <Field label={t('finance.period.to')} type="date" value={draft.to} min={draft.from} onChange={(e) => setDraft({ ...draft, to: e.target.value })} />
              <button className={`btn ${styles.apply}`}>{t('finance.period.apply')}</button>
            </>
          )}
          {compare && (
            <SelectField label={t('finance.compare.label')} value={period.compare} onChange={(e) => go(period, e.target.value as CompareMode)}>
              {COMPARE_MODES.map((m) => <option key={m} value={m}>{t(`finance.compare.${m}`)}</option>)}
            </SelectField>
          )}
        </div>
        {shownPreset === 'custom' && !validPeriod(draft) && <p className="fine field-error m-0" role="alert">{t('finance.period.invalid')}</p>}
        <p className={`fine m-0 ${styles.summary}`} data-testid="finance-period">{summary}</p>
      </form>
      {children}
    </ModuleGate>
  );
}
