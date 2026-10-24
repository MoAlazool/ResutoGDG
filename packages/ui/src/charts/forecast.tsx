interface Point { date: string; value: number }
interface Band { date: string; yhat: number; lower: number; upper: number }

/** History (solid) followed by a forecast (dashed) with its uncertainty band. */
export function ForecastChart({ history, forecast, label, rtl }: { history: Point[]; forecast: Band[]; label: string; rtl?: boolean }) {
  const W = 640, H = 220, PAD = { l: 36, r: 12, t: 12, b: 26 };
  const all = [...history.map((h) => h.date), ...forecast.map((f) => f.date)];
  const n = all.length;
  const maxY = Math.max(1, ...history.map((h) => h.value), ...forecast.map((f) => f.upper));
  const x = (i: number) => { const v = PAD.l + (i / Math.max(n - 1, 1)) * (W - PAD.l - PAD.r); return rtl ? W - v : v; };
  const y = (v: number) => PAD.t + (1 - v / maxY) * (H - PAD.t - PAD.b);
  const off = history.length;
  const histPath = history.map((h, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(h.value).toFixed(1)}`).join(' ');
  const fcPath = forecast.map((f, i) => `${i ? 'L' : 'M'}${x(off + i).toFixed(1)},${y(f.yhat).toFixed(1)}`).join(' ');
  const band = forecast.length
    ? `M${forecast.map((f, i) => `${x(off + i).toFixed(1)},${y(f.upper).toFixed(1)}`).join(' L')} L${[...forecast].reverse()
      .map((f, i) => `${x(off + forecast.length - 1 - i).toFixed(1)},${y(f.lower).toFixed(1)}`).join(' L')} Z` : '';
  const ticks = [0, 0.5, 1].map((p) => Math.round(maxY * p));
  const labelEvery = Math.max(1, Math.ceil(n / 6));
  return (
    <svg className="rui-chart-svg rui-chart-fluid" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={label}>
      <title>{label}</title>
      {ticks.map((tk) => (
        <g key={tk}>
          <line x1={PAD.l} x2={W - PAD.r} y1={y(tk)} y2={y(tk)} stroke="var(--border)" strokeDasharray="3 4" />
          <text className="rui-chart-axis" x={rtl ? W - 4 : 4} y={y(tk) + 4} textAnchor={rtl ? 'end' : 'start'}>{tk}</text>
        </g>
      ))}
      {band && <path d={band} fill="var(--chart-1)" opacity="0.16" />}
      {histPath && <path className="rui-chart-line" d={histPath} stroke="var(--chart-4)" strokeWidth="2" pathLength={1} />}
      {fcPath && <path d={fcPath} fill="none" stroke="var(--chart-1)" strokeWidth="2.5" strokeDasharray="6 4" />}
      {off > 0 && forecast.length > 0 && <line x1={x(off - 0.5)} x2={x(off - 0.5)} y1={PAD.t} y2={H - PAD.b} stroke="var(--text-muted)" strokeWidth="1" />}
      {all.map((d, i) => (i % labelEvery === 0 ? (
        <text key={d} className="rui-chart-axis" x={x(i)} y={H - 8} textAnchor="middle">{d.slice(5)}</text>
      ) : null))}
    </svg>
  );
}
