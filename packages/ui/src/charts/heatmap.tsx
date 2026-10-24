'use client';
import { useMemo, useState, type ReactNode } from 'react';

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
    <figure className="rui-chart" aria-label={title}>
      <div className="rui-heat-scroll">
        <div className="rui-heat" role="grid" aria-label={title}>
          <span />
          {hours.map((h) => <span key={h} className="rui-heat-hour">{h % 3 === 0 ? h : ''}</span>)}
          {dayLabels.map((d, di) => (
            <div key={d} role="row" className="rui-heat-row">
              <span role="rowheader" className="rui-heat-day">{d}</span>
              {hours.map((h) => {
                const c = map.get(`${di + 1}-${h}`);
                const v = c?.value ?? 0;
                const k = `${di + 1}-${h}`;
                const label = `${d} ${String(h).padStart(2, '0')}:00 — ${format(v)} · ${c?.orders ?? 0}`;
                return (
                  <span key={h} role="gridcell" tabIndex={-1} aria-label={label} className="rui-heat-cell"
                    onPointerEnter={() => setHover(k)} onPointerLeave={() => setHover(null)}
                    style={v > 0 ? { background: `color-mix(in srgb, var(--chart-1) ${Math.round(15 + (v / max) * 85)}%, var(--surface-1))` } : undefined}>
                    {hover === k && <span className="rui-chart-tip rui-heat-tip"><strong>{d} {String(h).padStart(2, '0')}:00</strong>{format(v)} · {c?.orders ?? 0}</span>}
                  </span>
                );
              })}
            </div>
          ))}
        </div>
      </div>
      <details className="rui-chart-table">
        <summary>{tableCaption}</summary>
        <div className="table-wrap">
          <table className="data">
            <thead><tr><th>{dayLabel}</th><th>{hourLabel}</th><th className="rui-num-cell">#</th><th className="rui-num-cell">Σ</th></tr></thead>
            <tbody>
              {cells.filter((c) => c.orders > 0).map((c) => (
                <tr key={`${c.isoDow}-${c.hour}`}><td>{dayLabels[c.isoDow - 1]}</td><td className="num">{String(c.hour).padStart(2, '0')}:00</td>
                  <td className="num rui-num-cell">{c.orders}</td><td className="num rui-num-cell">{format(c.value)}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </figure>
  );
}
