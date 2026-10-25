'use client';
// The Insights toolbar's period and comparison (21-INSIGHTS). Its own module, rendered by the analytics views only
// (InsightsShell `toolbar`), so the intelligence views do not ship the date and segmented controls.
import { DateTimeInput, SegmentedControl } from '@resuto/ui';
import { REPORT_COMPARE, REPORT_PERIODS, type ReportCompare, type ReportPeriod } from '@/lib/contracts-reports';
import { COMPARE_SECTIONS } from '@/lib/insights';
import { useT } from '@/lib/i18n/client';
import { useInsights } from './InsightsShell';
import s from './insights.module.css';

export function PeriodControls() {
  const { t } = useT();
  const { section, view, range, setParams } = useInsights();
  const custom = view.period === 'custom';
  return (
    <div className={s.group}>
      <label className={s.field}>
        <span className="sr-only">{t('insights.period.label')}</span>
        <select className={`select ${s.select}`} value={view.period} aria-label={t('insights.period.label')}
          onChange={(e) => {
            const p = e.target.value as ReportPeriod;
            setParams(p === 'custom' ? { period: p, from: range.from, to: range.to } : { period: p, from: null, to: null });
          }}>
          {REPORT_PERIODS.map((p) => <option key={p} value={p}>{t(`insights.period.${p}`)}</option>)}
        </select>
      </label>
      {custom && (
        <>
          <DateTimeInput type="date" className={s.date} aria-label={t('insights.period.from')} value={range.from} max={range.to}
            onChange={(e) => e.target.value && setParams({ period: 'custom', from: e.target.value, to: range.to })} />
          <DateTimeInput type="date" className={s.date} aria-label={t('insights.period.to')} value={range.to} min={range.from}
            onChange={(e) => e.target.value && setParams({ period: 'custom', from: range.from, to: e.target.value })} />
        </>
      )}
      {COMPARE_SECTIONS.includes(section) && (
        <SegmentedControl<ReportCompare> label={t('home.perf.compare')} size="sm" value={view.compare} onChange={(v) => setParams({ compare: v })}
          options={REPORT_COMPARE.map((c) => ({ value: c, label: t(`home.compare.${c}`) }))} />
      )}
    </div>
  );
}
