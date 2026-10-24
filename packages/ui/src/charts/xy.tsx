'use client';
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { CHART_COLORS, chartColor, niceScale, type ChartSeries } from './shared';

// Shared frame of the line and bar charts: container width, scales, keyboard focus and the tooltip.

/** Draws at the container's real pixel width so axis text keeps its true size on phones and in narrow cards. */
export function useWidth(initial = 640) {
  const ref = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(initial);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(([entry]) => { const v = Math.round(entry!.contentRect.width); if (v > 0) setW(v); });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}

export interface XYProps {
  title: string; labels: string[]; series: ChartSeries[]; format: (n: number) => string; compactFormat?: (n: number) => string;
  rtl?: boolean; xLabel: ReactNode; tableCaption: ReactNode; height?: number;
  /** At most this many series are drawn (default 2: current vs comparison). */
  maxSeries?: number;
}

/** Shared frame for line and bar charts: scales, axes, keyboard/pointer focus, tooltip, legend and table. */
export function useXY({ labels, series, rtl = false, height = 220, maxSeries = 2 }: XYProps, W: number) {
  const H = height, padAxis = 56, padEdge = 14, padTop = 12, padBottom = 28;
  const plotW = Math.max(10, W - padAxis - padEdge);
  const plotH = H - padTop - padBottom;
  const colored = series.slice(0, maxSeries).map((se, i) => ({ ...se, color: se.color ?? (maxSeries <= 2 ? (i ? CHART_COLORS.comparison : CHART_COLORS.current) : chartColor(i)) }));
  const max = Math.max(0, ...colored.flatMap((se) => se.values));
  const ticks = niceScale(max);
  const top = ticks[ticks.length - 1] || 1;
  const n = labels.length;
  const plotStart = rtl ? padEdge : padAxis;
  const plotEnd = plotStart + plotW;
  const y = (v: number) => padTop + plotH - (Math.max(v, 0) / top) * plotH;
  const every = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(plotW / 70))));
  return { H, plotW, plotH, padTop, colored, ticks, n, plotStart, plotEnd, y, every };
}

export function useActive(n: number, rtl: boolean) {
  const [active, setActive] = useState<number | null>(null);
  const onKey = (e: KeyboardEvent<SVGSVGElement>) => {
    if (!n) return;
    const fwd = rtl ? 'ArrowLeft' : 'ArrowRight';
    const back = rtl ? 'ArrowRight' : 'ArrowLeft';
    if (e.key === fwd) { e.preventDefault(); setActive((a) => Math.min(n - 1, (a ?? -1) + 1)); }
    else if (e.key === back) { e.preventDefault(); setActive((a) => Math.max(0, (a ?? n) - 1)); }
    else if (e.key === 'Home') { e.preventDefault(); setActive(0); }
    else if (e.key === 'End') { e.preventDefault(); setActive(n - 1); }
    else if (e.key === 'Escape') setActive(null);
  };
  return { active, setActive, onKey };
}

export function ChartTooltip({ xPct, title, rows }: { xPct: number; title: ReactNode; rows: Array<{ key: string; color: string; name: ReactNode; value: string }> }) {
  return (
    // SVG x positions are physical, so the tooltip is placed physically too.
    <div className="rui-chart-tip" role="status" style={{ left: `${Math.min(85, Math.max(15, xPct))}%` /* logical-exempt: SVG coordinates */ }}>
      <strong>{title}</strong>
      {rows.map((r) => <div key={r.key}><span className="rui-chart-swatch" style={{ background: r.color }} /> {r.name}: <b className="num">{r.value}</b></div>)}
    </div>
  );
}
