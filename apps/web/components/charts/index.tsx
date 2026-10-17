'use client';
// Small dependency-free charts for Resuto dashboards (Agent B2).
// - Colors: --chart-1 for a single magnitude; --chart-1 + --chart-4 for current vs comparison.
// - Every chart has a hover/focus tooltip, a legend for 2+ series, and a data-table fallback.
// - RTL: time runs right-to-left and the value axis sits on the right.
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react';
import s from './charts.module.css';

export const CHART_COLORS = { current: 'var(--chart-1)', comparison: 'var(--chart-4)' } as const;

export interface Series { name: string; values: number[]; color?: string }

function niceScale(max: number, ticks = 4): number[] {
  if (!(max > 0)) return [0, 1];
  const raw = max / ticks;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * pow).find((st) => st >= raw) ?? raw;
  return Array.from({ length: Math.ceil(max / step) + 1 }, (_, i) => i * step);
}

function DataTable({ caption, xLabel, labels, series, format }: { caption: ReactNode; xLabel: ReactNode; labels: string[]; series: Series[]; format: (n: number) => string }) {
  return (
    <details className={s.tableToggle}>
      <summary>{caption}</summary>
      <div className="table-wrap">
        <table className="data">
          <thead><tr><th>{xLabel}</th>{series.map((se) => <th key={se.name} style={{ textAlign: 'end' }}>{se.name}</th>)}</tr></thead>
          <tbody>
            {labels.map((l, i) => (
              <tr key={l + i}><td>{l}</td>{series.map((se) => <td key={se.name} className="num" style={{ textAlign: 'end' }}>{format(se.values[i] ?? 0)}</td>)}</tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}

export function Legend({ series }: { series: Series[] }) {
  if (series.length < 2) return null;
  return (
    <div className={s.legend}>
      {series.map((se, i) => (
        <span key={se.name} className={s.legendItem}><span className={s.key} style={{ background: se.color ?? (i ? CHART_COLORS.comparison : CHART_COLORS.current) }} />{se.name}</span>
      ))}
    </div>
  );
}

/** Line chart for one series, or current vs comparison (two series max). */
export function LineChart({ title, labels, series, format, compactFormat, rtl = false, xLabel, tableCaption, area = true, height = 220 }: {
  title: string; labels: string[]; series: Series[]; format: (n: number) => string; compactFormat?: (n: number) => string;
  rtl?: boolean; xLabel: ReactNode; tableCaption: ReactNode; area?: boolean; height?: number;
}) {
  const id = useId();
  const [active, setActive] = useState<number | null>(null);
  // Draw at the container's real pixel width so axis text keeps its true size on phones and in narrow cards.
  const wrap = useRef<HTMLDivElement>(null);
  const [W, setW] = useState(640);
  useEffect(() => {
    const el = wrap.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(([entry]) => { const w = Math.round(entry!.contentRect.width); if (w > 0) setW(w); });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const H = height, padAxis = 56, padEdge = 14, padTop = 12, padBottom = 28;
  const plotW = W - padAxis - padEdge;
  const plotH = H - padTop - padBottom;
  const max = Math.max(0, ...series.flatMap((se) => se.values));
  const ticks = niceScale(max);
  const top = ticks[ticks.length - 1] || 1;
  const n = labels.length;
  const plotStart = rtl ? padEdge : padAxis;
  const plotEnd = plotStart + plotW;
  const x = (i: number) => {
    const t = n <= 1 ? 0.5 : i / (n - 1);
    return rtl ? plotEnd - t * plotW : plotStart + t * plotW;
  };
  const y = (v: number) => padTop + plotH - (Math.max(v, 0) / top) * plotH;
  const colored = series.slice(0, 2).map((se, i) => ({ ...se, color: se.color ?? (i ? CHART_COLORS.comparison : CHART_COLORS.current) }));
  const every = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(plotW / 70))));

  const onMove = (e: PointerEvent<SVGRectElement>) => {
    const rect = (e.currentTarget.ownerSVGElement as SVGSVGElement).getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * W;
    let best = 0;
    for (let i = 1; i < n; i++) if (Math.abs(x(i) - px) < Math.abs(x(best) - px)) best = i;
    setActive(n ? best : null);
  };
  const onKey = (e: KeyboardEvent<SVGSVGElement>) => {
    if (!n) return;
    const fwd = rtl ? 'ArrowLeft' : 'ArrowRight';
    const back = rtl ? 'ArrowRight' : 'ArrowLeft';
    if (e.key === fwd) { e.preventDefault(); setActive((a) => Math.min(n - 1, (a ?? -1) + 1)); }
    if (e.key === back) { e.preventDefault(); setActive((a) => Math.max(0, (a ?? n) - 1)); }
    if (e.key === 'Escape') setActive(null);
  };

  return (
    <figure className={s.figure}>
      <Legend series={colored} />
      <div className={s.svgWrap} ref={wrap}>
        <svg className={s.svg} viewBox={`0 0 ${W} ${H}`} width={W} height={H} role="img" aria-labelledby={`${id}-t`} tabIndex={0} onKeyDown={onKey} onBlur={() => setActive(null)}>
          <title id={`${id}-t`}>{title}</title>
          {ticks.map((tv) => (
            <g key={tv}>
              <line className={s.grid} x1={plotStart} x2={plotEnd} y1={y(tv)} y2={y(tv)} />
              <text className={s.axis} x={rtl ? plotEnd + 8 : plotStart - 8} y={y(tv) + 4} textAnchor={rtl ? 'start' : 'end'}>{(compactFormat ?? format)(tv)}</text>
            </g>
          ))}
          {labels.map((l, i) => ((i % every === 0 && n - 1 - i >= every / 2) || i === n - 1) && (
            <text key={l + i} className={s.axis} x={x(i)} y={H - 8} textAnchor="middle">{l}</text>
          ))}
          {colored.map((se, si) => {
            const pts = se.values.map((v, i) => `${x(i)},${y(v)}`).join(' ');
            return (
              <g key={se.name}>
                {area && si === 0 && n > 1 && <polygon className={s.area} fill={se.color} points={`${x(0)},${y(0)} ${pts} ${x(n - 1)},${y(0)}`} />}
                <polyline className={s.line} stroke={se.color} points={pts} />
                {n > 0 && <circle className={s.dot} cx={x(n - 1)} cy={y(se.values[n - 1] ?? 0)} r={4} fill={se.color} />}
              </g>
            );
          })}
          {active !== null && (
            <g aria-hidden>
              <line className={s.crosshair} x1={x(active)} x2={x(active)} y1={padTop} y2={padTop + plotH} />
              {colored.map((se) => <circle key={se.name} className={s.dot} cx={x(active)} cy={y(se.values[active] ?? 0)} r={5} fill={se.color} />)}
            </g>
          )}
          <rect x={0} y={0} width={W} height={H} fill="transparent" onPointerMove={onMove} onPointerLeave={() => setActive(null)} />
        </svg>
        {active !== null && (
          <div className={s.tooltip} role="status" style={{ left: `${Math.min(85, Math.max(15, (x(active) / W) * 100))}%` }}>
            <strong>{labels[active]}</strong>
            {colored.map((se) => <div key={se.name}><span className={s.swatch} style={{ background: se.color }} /> {se.name}: <b className="num">{format(se.values[active] ?? 0)}</b></div>)}
          </div>
        )}
      </div>
      <DataTable caption={tableCaption} xLabel={xLabel} labels={labels} series={colored} format={format} />
    </figure>
  );
}

/** Horizontal bars for ranked categories (single hue; identity comes from the label). */
export function BarList({ items, format, empty }: { items: Array<{ key: string; label: ReactNode; value: number; hint?: ReactNode }>; format: (n: number) => string; empty?: ReactNode }) {
  const max = Math.max(0, ...items.map((i) => i.value));
  if (!items.length) return <p className="muted">{empty}</p>;
  return (
    <ul className={s.barList}>
      {items.map((it) => (
        <li key={it.key} className={s.barRow} title={`${typeof it.label === 'string' ? it.label : ''} ${format(it.value)}`}>
          <span className={s.barLabel}>{it.label}{it.hint && <span className={s.barHint}>{it.hint}</span>}</span>
          <span className={s.barTrack} aria-hidden><span className={s.bar} style={{ width: `${max > 0 ? Math.max(1, (Math.max(it.value, 0) / max) * 100) : 0}%` }} /></span>
          <span className={s.barValue}>{format(it.value)}</span>
        </li>
      ))}
    </ul>
  );
}

/** Weekday × hour heatmap (sequential: one hue, light → dark). */
export function Heatmap({ cells, dayLabels, format, title, tableCaption, hourLabel, dayLabel }: {
  cells: Array<{ isoDow: number; hour: number; value: number; orders: number }>; dayLabels: string[]; format: (n: number) => string;
  title: string; tableCaption: ReactNode; hourLabel: ReactNode; dayLabel: ReactNode;
}) {
  const [hover, setHover] = useState<string | null>(null);
  const map = useMemo(() => new Map(cells.map((c) => [`${c.isoDow}-${c.hour}`, c])), [cells]);
  const max = Math.max(0, ...cells.map((c) => c.value));
  const hours = Array.from({ length: 24 }, (_, h) => h);
  return (
    <figure className={s.figure} aria-label={title}>
      <div className={s.heatScroll}>
        <div className={`${s.heat} ${s.heatInner}`} role="grid" aria-label={title}>
          <span />
          {hours.map((h) => <span key={h} style={{ textAlign: 'center' }}>{h % 3 === 0 ? h : ''}</span>)}
          {dayLabels.map((d, di) => (
            <div key={d} role="row" style={{ display: 'contents' }}>
              <span role="rowheader" style={{ alignSelf: 'center' }}>{d}</span>
              {hours.map((h) => {
                const c = map.get(`${di + 1}-${h}`);
                const v = c?.value ?? 0;
                const k = `${di + 1}-${h}`;
                const label = `${d} ${String(h).padStart(2, '0')}:00 — ${format(v)} · ${c?.orders ?? 0}`;
                return (
                  <span key={h} role="gridcell" tabIndex={-1} aria-label={label} className={s.heatCell}
                    onPointerEnter={() => setHover(k)} onPointerLeave={() => setHover(null)}
                    style={v > 0 ? { background: `color-mix(in srgb, var(--chart-1) ${Math.round(15 + (v / max) * 85)}%, var(--card))` } : undefined}>
                    {hover === k && <span className={s.tooltip} style={{ left: '50%', top: '-46px' }}><strong>{d} {String(h).padStart(2, '0')}:00</strong>{format(v)} · {c?.orders ?? 0}</span>}
                  </span>
                );
              })}
            </div>
          ))}
        </div>
      </div>
      <details className={s.tableToggle}>
        <summary>{tableCaption}</summary>
        <div className="table-wrap">
          <table className="data">
            <thead><tr><th>{dayLabel}</th><th>{hourLabel}</th><th style={{ textAlign: 'end' }}>#</th><th style={{ textAlign: 'end' }}>Σ</th></tr></thead>
            <tbody>
              {cells.filter((c) => c.orders > 0).map((c) => (
                <tr key={`${c.isoDow}-${c.hour}`}><td>{dayLabels[c.isoDow - 1]}</td><td className="num">{String(c.hour).padStart(2, '0')}:00</td>
                  <td className="num" style={{ textAlign: 'end' }}>{c.orders}</td><td className="num" style={{ textAlign: 'end' }}>{format(c.value)}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </figure>
  );
}
