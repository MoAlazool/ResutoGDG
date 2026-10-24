'use client';
// Forecast chart, legend and segment bars come from the shared chart kit (packages/ui/src/charts/); the route map
// is specific to delivery routes and stays here. Each chart has a text alternative (role="img" + aria-label).
import { BarList as KitBarList, ChartLegend, ForecastChart } from '@resuto/ui';

export { ForecastChart };
export const Legend = ChartLegend;

/** Horizontal bars (segment sizes): one chart colour per segment, rows are toggle buttons when `onSelect` is given. */
export function BarList({ rows, onSelect, selected, label }: {
  rows: Array<{ key: string; label: string; value: number }>; onSelect?: (key: string) => void; selected?: string | null; label: string;
}) {
  return <KitBarList rows={rows} onSelect={onSelect} selected={selected} label={label} palette="categorical" />;
}

/** Route map: equirectangular projection of the start and stops, planned route solid, naive order dashed. */
export function RouteMap({ start, stops, label, naiveLabel, plannedLabel, startLabel }: {
  start: { lat: number; lng: number }; label: string; naiveLabel: string; plannedLabel: string; startLabel: string;
  stops: Array<{ jobId: string; lat: number; lng: number; sequence: number; naiveSequence: number; lateMinutes: number }>;
}) {
  const S = 360;
  const pts = [start, ...stops];
  const k = Math.cos((start.lat * Math.PI) / 180);
  const xs = pts.map((p) => p.lng * k);
  const ys = pts.map((p) => p.lat);
  const minX = Math.min(...xs); const maxX = Math.max(...xs); const minY = Math.min(...ys); const maxY = Math.max(...ys);
  const span = Math.max(maxX - minX, maxY - minY, 1e-4);
  const px = (p: { lat: number; lng: number }) => 24 + ((p.lng * k - minX) / span) * (S - 48);
  const py = (p: { lat: number; lng: number }) => S - 24 - ((p.lat - minY) / span) * (S - 48);
  const planned = [...stops].sort((a, b) => a.sequence - b.sequence);
  const naive = [...stops].sort((a, b) => a.naiveSequence - b.naiveSequence);
  const path = (list: typeof stops) => [start, ...list].map((p, i) => `${i ? 'L' : 'M'}${px(p).toFixed(1)},${py(p).toFixed(1)}`).join(' ');
  return (
    <svg viewBox={`0 0 ${S} ${S}`} role="img" aria-label={label} style={{ width: '100%', maxWidth: 420, height: 'auto', background: 'var(--surface-warm)', borderRadius: 12 }}>
      <title>{label}</title>
      <path d={path(naive)} fill="none" stroke="var(--chart-4)" strokeWidth="1.5" strokeDasharray="5 5" opacity="0.8"><title>{naiveLabel}</title></path>
      <path d={path(planned)} fill="none" stroke="var(--chart-1)" strokeWidth="3"><title>{plannedLabel}</title></path>
      <rect x={px(start) - 8} y={py(start) - 8} width="16" height="16" rx="3" fill="var(--ink)"><title>{startLabel}</title></rect>
      {planned.map((s) => (
        <g key={s.jobId}>
          <circle cx={px(s)} cy={py(s)} r="12" fill={s.lateMinutes > 0 ? 'var(--danger)' : 'var(--chart-2)'} stroke="var(--on-ink)" strokeWidth="2" />
          <text x={px(s)} y={py(s) + 4} textAnchor="middle" fontSize="12" fontWeight="700" fill="var(--on-ink)">{s.sequence}</text>
        </g>
      ))}
    </svg>
  );
}
