import { INTL_LOCALE } from '@resuto/contracts/lite';
import type { ReactNode } from 'react';

// The Resuto chart kit: dependency-free inline SVG, the only chart kit of the web app (21-INSIGHTS retired the
// apps/web/components/charts and intelligence/_components/charts copies; apps/web/lib/chart-kit-policy.test.ts fails if
// a chart is imported from anywhere else). This module holds the shared helpers; each chart has its own module, so a
// page ships only the charts it renders.
// - Colours: --chart-1..8 (contrast-checked against --surface-1, light and dark). One magnitude = --chart-1; current
//   vs comparison = --chart-1 + --chart-4 (validated pairing); categories cycle 1..8.
// - Every chart has a text alternative: role="img" + title, or a list, plus a values table under a disclosure.
// - Hover and keyboard focus show the exact value; nothing is shown that is not in the data.
// - Motion: lines draw in once (stroke-dash on pathLength=1), bars grow from zero to their value once; values are never
//   animated past or counted up to their real value, and prefers-reduced-motion shows the final state at once.
// - RTL: pass `rtl` and time runs right to left with the value axis on the right. SVG coordinates are physical, so the
//   SVG text itself is laid out left to right (.rui-chart-svg) and anchored by those coordinates.

export interface ChartSeries { name: string; values: number[]; color?: string }
/** @deprecated name kept for apps/web/components/charts; use ChartSeries. */
export type Series = ChartSeries;

export const CHART_COLORS = { current: 'var(--chart-1)', comparison: 'var(--chart-4)' } as const;
/** Categorical colour for the i-th category (cycles through the 8 chart tokens). */
export const chartColor = (i: number) => `var(--chart-${(((i % 8) + 8) % 8) + 1})`;

/** Round axis ticks from 0 to at least `max`. */
export function niceScale(max: number, ticks = 4): number[] {
  if (!(max > 0)) return [0, 1];
  const raw = max / ticks;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * pow).find((st) => st >= raw) ?? raw;
  return Array.from({ length: Math.ceil(max / step) + 1 }, (_, i) => i * step);
}

/** Plain number format with Western digits in both languages. */
export const plainNumber = (locale: 'en' | 'ar') => {
  const nf = new Intl.NumberFormat(locale === 'ar' ? INTL_LOCALE.ar : 'en-US', { maximumFractionDigits: 2 });
  return (n: number) => nf.format(n);
};

/** Values table behind a disclosure: the accessible, exact form of every chart. */
export function ChartTable({ caption, xLabel, labels, series, format }: { caption: ReactNode; xLabel: ReactNode; labels: string[]; series: ChartSeries[]; format: (n: number) => string }) {
  return (
    <details className="rui-chart-table">
      <summary>{caption}</summary>
      <div className="table-wrap">
        <table className="data">
          <thead><tr><th>{xLabel}</th>{series.map((se) => <th key={se.name} className="rui-num-cell">{se.name}</th>)}</tr></thead>
          <tbody>
            {labels.map((l, i) => (
              <tr key={l + i}><td>{l}</td>{series.map((se) => <td key={se.name} className="num rui-num-cell">{format(se.values[i] ?? 0)}</td>)}</tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}

/** Legend for 2+ series (a single series is named by the chart's title). */
export function SeriesLegend({ series }: { series: ChartSeries[] }) {
  if (series.length < 2) return null;
  return (
    <div className="rui-chart-legend">
      {series.map((se, i) => (
        <span key={se.name} className="rui-chart-legend-item"><span className="rui-chart-key" style={{ background: se.color ?? (i ? CHART_COLORS.comparison : CHART_COLORS.current) }} />{se.name}</span>
      ))}
    </div>
  );
}

/** Legend with line, dashed-line or band keys (forecast charts). */
export function ChartLegend({ items }: { items: Array<{ color: string; label: string; dashed?: boolean; band?: boolean }> }) {
  return (
    <div className="rui-chart-legend">
      {items.map((it) => (
        <span key={it.label} className="rui-chart-legend-item">
          <svg width="22" height="10" aria-hidden="true" focusable="false">
            {it.band ? <rect width="22" height="10" fill={it.color} opacity="0.2" />
              : <line x1="0" x2="22" y1="5" y2="5" stroke={it.color} strokeWidth="2.5" strokeDasharray={it.dashed ? '5 3' : undefined} />}
          </svg>
          {it.label}
        </span>
      ))}
    </div>
  );
}
