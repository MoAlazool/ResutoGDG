'use client';
import { useId } from 'react';
import { ChartTable, SeriesLegend } from './shared';
import { ChartTooltip, useActive, useWidth, useXY, type XYProps } from './xy';

/** Vertical bars per label; two series are grouped side by side (current vs comparison). */
export function BarChart(props: XYProps) {
  const { title, labels, format, compactFormat, rtl = false, xLabel, tableCaption } = props;
  const id = useId();
  const [wrap, W] = useWidth();
  const g = useXY(props, W);
  const { active, setActive, onKey } = useActive(g.n, rtl);
  const band = g.plotW / Math.max(1, g.n);
  const groups = Math.max(1, g.colored.length);
  const barW = Math.max(2, Math.min(36, (band * 0.7) / groups));
  const center = (i: number) => (rtl ? g.plotEnd - (i + 0.5) * band : g.plotStart + (i + 0.5) * band);
  return (
    <figure className="rui-chart">
      <SeriesLegend series={g.colored} />
      <div className="rui-chart-wrap" ref={wrap}>
        <svg className="rui-chart-svg" viewBox={`0 0 ${W} ${g.H}`} width={W} height={g.H} role="img" aria-labelledby={`${id}-t`} tabIndex={0} onKeyDown={onKey} onBlur={() => setActive(null)}>
          <title id={`${id}-t`}>{title}</title>
          {g.ticks.map((tv) => (
            <g key={tv}>
              <line className="rui-chart-grid" x1={g.plotStart} x2={g.plotEnd} y1={g.y(tv)} y2={g.y(tv)} />
              <text className="rui-chart-axis" x={rtl ? g.plotEnd + 8 : g.plotStart - 8} y={g.y(tv) + 4} textAnchor={rtl ? 'start' : 'end'}>{(compactFormat ?? format)(tv)}</text>
            </g>
          ))}
          {labels.map((l, i) => ((i % g.every === 0) || i === g.n - 1) && (
            <text key={l + i} className="rui-chart-axis" x={center(i)} y={g.H - 8} textAnchor="middle">{l}</text>
          ))}
          {labels.map((l, i) => (
            <g key={l + i} data-active={active === i || undefined} onPointerEnter={() => setActive(i)} onPointerLeave={() => setActive(null)}>
              <rect x={center(i) - band / 2} y={g.padTop} width={band} height={g.plotH} fill="transparent" />
              {g.colored.map((se, si) => {
                const v = Math.max(0, se.values[i] ?? 0);
                const offset = (si - (groups - 1) / 2) * barW * (rtl ? -1 : 1);
                return <rect key={se.name} className="rui-chart-bar" x={center(i) + offset - barW / 2} y={g.y(v)} width={barW} height={Math.max(0, g.y(0) - g.y(v))} rx={2} fill={se.color} />;
              })}
            </g>
          ))}
        </svg>
        {active !== null && <ChartTooltip xPct={(center(active) / W) * 100} title={labels[active]}
          rows={g.colored.map((se) => ({ key: se.name, color: se.color, name: se.name, value: format(se.values[active] ?? 0) }))} />}
      </div>
      <ChartTable caption={tableCaption} xLabel={xLabel} labels={labels} series={g.colored} format={format} />
    </figure>
  );
}
