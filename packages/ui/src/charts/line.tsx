'use client';
import { useId, type PointerEvent } from 'react';
import { ChartTable, SeriesLegend } from './shared';
import { ChartTooltip, useActive, useWidth, useXY, type XYProps } from './xy';

/** Line chart for one series, or current vs comparison. `area` fills under the first series. */
export function LineChart(props: XYProps & { area?: boolean }) {
  const { title, labels, format, compactFormat, rtl = false, xLabel, tableCaption, area = true } = props;
  const id = useId();
  const [wrap, W] = useWidth();
  const g = useXY(props, W);
  const { active, setActive, onKey } = useActive(g.n, rtl);
  const x = (i: number) => {
    const t = g.n <= 1 ? 0.5 : i / (g.n - 1);
    return rtl ? g.plotEnd - t * g.plotW : g.plotStart + t * g.plotW;
  };
  const onMove = (e: PointerEvent<SVGRectElement>) => {
    const rect = (e.currentTarget.ownerSVGElement as SVGSVGElement).getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * W;
    let best = 0;
    for (let i = 1; i < g.n; i++) if (Math.abs(x(i) - px) < Math.abs(x(best) - px)) best = i;
    setActive(g.n ? best : null);
  };
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
          {labels.map((l, i) => ((i % g.every === 0 && g.n - 1 - i >= g.every / 2) || i === g.n - 1) && (
            <text key={l + i} className="rui-chart-axis" x={x(i)} y={g.H - 8} textAnchor="middle">{l}</text>
          ))}
          {g.colored.map((se, si) => {
            const pts = se.values.map((v, i) => `${x(i)},${g.y(v)}`).join(' ');
            return (
              <g key={se.name}>
                {area && si === 0 && g.n > 1 && <polygon className="rui-chart-area" fill={se.color} points={`${x(0)},${g.y(0)} ${pts} ${x(g.n - 1)},${g.y(0)}`} />}
                <polyline className="rui-chart-line" stroke={se.color} points={pts} pathLength={1} />
                {g.n > 0 && <circle className="rui-chart-dot" cx={x(g.n - 1)} cy={g.y(se.values[g.n - 1] ?? 0)} r={4} fill={se.color} />}
              </g>
            );
          })}
          {active !== null && (
            <g aria-hidden="true">
              <line className="rui-chart-crosshair" x1={x(active)} x2={x(active)} y1={g.padTop} y2={g.padTop + g.plotH} />
              {g.colored.map((se) => <circle key={se.name} className="rui-chart-dot" cx={x(active)} cy={g.y(se.values[active] ?? 0)} r={5} fill={se.color} />)}
            </g>
          )}
          <rect x={0} y={0} width={W} height={g.H} fill="transparent" onPointerMove={onMove} onPointerLeave={() => setActive(null)} />
        </svg>
        {active !== null && <ChartTooltip xPct={(x(active) / W) * 100} title={labels[active]}
          rows={g.colored.map((se) => ({ key: se.name, color: se.color, name: se.name, value: format(se.values[active] ?? 0) }))} />}
      </div>
      <ChartTable caption={tableCaption} xLabel={xLabel} labels={labels} series={g.colored} format={format} />
    </figure>
  );
}

/** Line chart with a stronger fill under the first series (volumes over time). */
export function AreaChart(props: XYProps) {
  return <div className="rui-chart-area-strong"><LineChart {...props} area /></div>;
}
