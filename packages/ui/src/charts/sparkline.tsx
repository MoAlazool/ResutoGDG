/**
 * Word-sized trend line (KPI tiles, table cells). Decorative unless `label` is given; the last point is marked.
 * `rtl` runs time right to left.
 */
export function Sparkline({ values, width = 96, height = 28, color = 'var(--chart-1)', label, area = true, rtl = false }: {
  values: number[]; width?: number; height?: number; color?: string; label?: string; area?: boolean; rtl?: boolean;
}) {
  const pts = values.filter((v) => Number.isFinite(v));
  if (pts.length < 2) return null;
  const min = Math.min(...pts), max = Math.max(...pts);
  const span = max - min || 1;
  const pad = 3;
  const x = (i: number) => { const t = i / (pts.length - 1); const v = pad + t * (width - pad * 2); return rtl ? width - v : v; };
  const y = (v: number) => pad + (1 - (v - min) / span) * (height - pad * 2);
  const line = pts.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const last = pts.length - 1;
  return (
    <svg className="rui-spark" width={width} height={height} viewBox={`0 0 ${width} ${height}`} role={label ? 'img' : undefined} aria-label={label} aria-hidden={label ? undefined : true} focusable="false">
      {area && <polygon className="rui-spark-area" fill={color} points={`${x(0).toFixed(1)},${height - pad} ${line} ${x(last).toFixed(1)},${height - pad}`} />}
      <polyline className="rui-chart-line rui-spark-line" stroke={color} points={line} pathLength={1} />
      <circle cx={x(last)} cy={y(pts[last]!)} r={2.5} fill={color} />
    </svg>
  );
}
