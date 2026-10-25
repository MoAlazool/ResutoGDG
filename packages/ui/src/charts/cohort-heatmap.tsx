// Retention cohort heatmap (21-CRM, moved into the kit by 21-INSIGHTS): one row per cohort, one cell per period after
// it, shaded on the kit's sequential scale (--chart-1 mixed into the surface, in ten steps through data-level so no
// inline style is needed). A real table, so screen readers read cohort, period and share; the cell text carries the
// numbers. Labels come from the caller (the kit has no dictionary).
import type { ReactNode } from 'react';

export interface CohortRow { cohort: string; size: number; retentionPct: Array<number | null>; active: number[] }

/** 0 (empty) … 10 (100 %): the shade bucket of a retention share. */
export const cohortLevel = (pct: number | null | undefined) => (pct === null || pct === undefined || pct <= 0 ? 0 : Math.min(10, Math.max(1, Math.ceil(pct / 10))));

export function CohortHeatmap({ cohorts, formatPct, formatNum, title, caption, cohortLabel, sizeLabel, periodLabel, cellTitle }: {
  cohorts: CohortRow[]; formatPct: (n: number | null) => string; formatNum: (n: number) => string;
  title: string; caption: ReactNode; cohortLabel: ReactNode; sizeLabel: ReactNode;
  periodLabel: (m: number) => ReactNode; cellTitle: (row: CohortRow, m: number, pct: number | null) => string;
}) {
  const periods = Math.max(0, ...cohorts.map((c) => c.active.length));
  return (
    <figure className="rui-chart rui-cohort" aria-label={title}>
      <div className="rui-cohort-scroll">
        <table className="rui-cohort-table">
          <caption className="sr-only">{caption}</caption>
          <thead>
            <tr>
              <th scope="col">{cohortLabel}</th>
              <th scope="col" className="rui-cohort-num">{sizeLabel}</th>
              {Array.from({ length: periods }, (_, m) => <th scope="col" key={m} className="rui-cohort-num">{periodLabel(m)}</th>)}
            </tr>
          </thead>
          <tbody>
            {cohorts.map((c) => (
              <tr key={c.cohort}>
                <th scope="row" className="num"><bdi>{c.cohort}</bdi></th>
                <td className="num rui-cohort-num">{formatNum(c.size)}</td>
                {Array.from({ length: periods }, (_, m) => {
                  const p = c.retentionPct[m];
                  if (p === undefined) return <td key={m} className="rui-cohort-cell" data-level="none" />;
                  return <td key={m} className="rui-cohort-cell num" data-level={cohortLevel(p)} title={cellTitle(c, m, p)}>{formatPct(p)}</td>;
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </figure>
  );
}
