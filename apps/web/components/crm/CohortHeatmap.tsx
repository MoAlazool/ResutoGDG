'use client';
// Retention cohort heatmap (21-CRM): one row per first-order month, one cell per month after it, shaded on the chart
// kit's sequential scale (--chart-1 mixed into the surface, in ten steps through data-level so no inline style is
// needed). A real table, so screen readers read cohort, month and share; the cell text carries the numbers.
import type { RetentionReport } from '@resuto/contracts';
import { useT } from '@/lib/i18n/client';

/** 0 (empty) … 10 (100 %): the shade bucket of a retention share. */
export const level = (pct: number | null | undefined) => (pct === null || pct === undefined || pct <= 0 ? 0 : Math.min(10, Math.max(1, Math.ceil(pct / 10))));

export function CohortHeatmap({ cohorts, formatPct, formatNum }: {
  cohorts: RetentionReport['cohorts']; formatPct: (n: number | null) => string; formatNum: (n: number) => string;
}) {
  const { t } = useT();
  const months = Math.max(0, ...cohorts.map((c) => c.active.length));
  return (
    <figure className="rui-chart crm-cohort" aria-label={t('crm.retention.cohorts')}>
      <div className="crm-cohort-scroll">
        <table className="crm-cohort-table">
          <caption className="sr-only">{t('crm.retention.cohortsHint')}</caption>
          <thead>
            <tr>
              <th scope="col">{t('crm.retention.cohort')}</th>
              <th scope="col" className="crm-num">{t('crm.retention.size')}</th>
              {Array.from({ length: months }, (_, m) => <th scope="col" key={m} className="crm-num">{t('crm.retention.month', { m })}</th>)}
            </tr>
          </thead>
          <tbody>
            {cohorts.map((c) => (
              <tr key={c.cohort}>
                <th scope="row" className="num"><bdi>{c.cohort}</bdi></th>
                <td className="num crm-num">{formatNum(c.size)}</td>
                {Array.from({ length: months }, (_, m) => {
                  const p = c.retentionPct[m];
                  if (p === undefined) return <td key={m} className="crm-cohort-cell" data-level="none" />;
                  return (
                    <td key={m} className="crm-cohort-cell num" data-level={level(p)}
                      title={t('crm.retention.cell', { cohort: c.cohort, m, pct: formatPct(p), matched: formatNum(c.active[m] ?? 0), size: formatNum(c.size) })}>
                      {formatPct(p)}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </figure>
  );
}
