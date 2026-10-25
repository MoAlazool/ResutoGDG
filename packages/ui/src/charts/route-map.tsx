import type { ReactNode } from 'react';

// Delivery route map (moved from intelligence/_components/charts.tsx into the kit, 21-INSIGHTS). A map is
// geographic, so it is never mirrored in Arabic: east stays on the right in both directions (only text is localised).
// Static SVG: nothing animates, so reduced motion needs no special case.

export interface MapPoint { lat: number; lng: number }
export interface RouteStop extends MapPoint { jobId: string; sequence: number; naiveSequence: number; lateMinutes: number }

/**
 * Equirectangular projection of the start and the stops into a square of `size` px with `pad` px of margin: the
 * longitude is scaled by cos(latitude of the start), both axes share one scale (so distances keep their proportions)
 * and north is up.
 */
export function projectRoute(start: MapPoint, stops: MapPoint[], size = 360, pad = 24) {
  const pts = [start, ...stops];
  const k = Math.cos((start.lat * Math.PI) / 180);
  const xs = pts.map((p) => p.lng * k);
  const ys = pts.map((p) => p.lat);
  const minX = Math.min(...xs); const maxX = Math.max(...xs); const minY = Math.min(...ys); const maxY = Math.max(...ys);
  const span = Math.max(maxX - minX, maxY - minY, 1e-4);
  const inner = size - 2 * pad;
  return {
    x: (p: MapPoint) => pad + ((p.lng * k - minX) / span) * inner,
    y: (p: MapPoint) => size - pad - ((p.lat - minY) / span) * inner,
  };
}

/** Route map: the planned order solid, the naive (arrival) order dashed, late stops in the danger colour. */
export function RouteMap({ start, stops, label, naiveLabel, plannedLabel, startLabel, empty }: {
  start: MapPoint; stops: RouteStop[]; label: string; naiveLabel: string; plannedLabel: string; startLabel: string;
  /** Shown instead of the map when there are no stops. */
  empty?: ReactNode;
}) {
  if (!stops.length) return empty ? <p className="muted rui-chart-empty">{empty}</p> : null;
  const S = 360;
  const { x, y } = projectRoute(start, stops, S);
  const planned = [...stops].sort((a, b) => a.sequence - b.sequence);
  const naive = [...stops].sort((a, b) => a.naiveSequence - b.naiveSequence);
  const path = (list: MapPoint[]) => [start, ...list].map((p, i) => `${i ? 'L' : 'M'}${x(p).toFixed(1)},${y(p).toFixed(1)}`).join(' ');
  return (
    <svg className="rui-chart-svg rui-route-map" viewBox={`0 0 ${S} ${S}`} role="img" aria-label={label}>
      <title>{label}</title>
      <path d={path(naive)} fill="none" stroke="var(--chart-4)" strokeWidth="1.5" strokeDasharray="5 5" opacity="0.8"><title>{naiveLabel}</title></path>
      <path d={path(planned)} fill="none" stroke="var(--chart-1)" strokeWidth="3"><title>{plannedLabel}</title></path>
      <rect x={x(start) - 8} y={y(start) - 8} width="16" height="16" rx="3" fill="var(--ink)"><title>{startLabel}</title></rect>
      {planned.map((st) => (
        <g key={st.jobId} data-late={st.lateMinutes > 0 ? '' : undefined}>
          <circle cx={x(st)} cy={y(st)} r="12" fill={st.lateMinutes > 0 ? 'var(--danger)' : 'var(--chart-2)'} stroke="var(--on-ink)" strokeWidth="2" />
          <text x={x(st)} y={y(st) + 4} textAnchor="middle" fontSize="12" fontWeight="700" fill="var(--on-ink)">{st.sequence}</text>
        </g>
      ))}
    </svg>
  );
}
