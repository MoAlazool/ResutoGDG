'use client';
import { useId } from 'react';
import { project, type GeoPoint } from '@/lib/map-projection';

/** Pin colours, exported for legends. */
export const PIN_COLOR = { restaurant: 'var(--herb)', destination: 'var(--gold)', driver: 'var(--ink)', job: 'var(--danger)' } as const;

export interface MapPin extends GeoPoint {
  id: string;
  label: string;
  kind: 'restaurant' | 'destination' | 'driver' | 'job';
  /** Muted pins (offline drivers, stale positions). */
  muted?: boolean;
}

const FILL: Record<MapPin['kind'], string> = PIN_COLOR;

/**
 * FT-14: a tile-free schematic map (inline SVG): pins placed by projected coordinates on a soft grid, with optional
 * dashed lines (e.g. restaurant → driver → destination). No third-party tiles, so nothing is fetched, no key is
 * needed and the CSP is unchanged. Colours come from the theme tokens (CSS custom properties) via `style`.
 */
export function SchematicMap({ pins, lines = [], label, height = 220, width = 360 }: {
  pins: MapPin[]; lines?: Array<[string, string]>; label: string; height?: number;
  /** viewBox width; the map never renders wider than this many CSS pixels, so labels keep their size. */
  width?: number;
}) {
  const grid = `grid-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const pts = project(pins, { width, height, pad: 28 });
  const at = new Map(pins.map((p, i) => [p.id, pts[i]!]));
  return (
    <figure style={{ margin: 0, maxWidth: width }}>
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={label}
        style={{ width: '100%', height: 'auto', display: 'block', borderRadius: 14, background: 'color-mix(in srgb, var(--ink) 4%, var(--card))', border: '1px solid var(--line)' }}>
        <defs>
          <pattern id={grid} width="24" height="24" patternUnits="userSpaceOnUse">
            <path d="M 24 0 L 0 0 0 24" style={{ fill: 'none', stroke: 'var(--line)', strokeWidth: 1 }} />
          </pattern>
        </defs>
        <rect width={width} height={height} style={{ fill: `url(#${grid})` }} />
        {lines.map(([a, b]) => {
          const p = at.get(a), q = at.get(b);
          return p && q ? <line key={`${a}-${b}`} x1={p.x} y1={p.y} x2={q.x} y2={q.y} style={{ stroke: 'var(--muted)', strokeWidth: 2, strokeDasharray: '5 5' }} /> : null;
        })}
        {pins.map((p, i) => {
          const q = pts[i]!;
          return (
            <g key={p.id} transform={`translate(${q.x} ${q.y})`} opacity={p.muted ? 0.45 : 1}>
              <circle r={p.kind === 'driver' ? 8 : 7} style={{ fill: FILL[p.kind], stroke: 'var(--card)', strokeWidth: 2.5 }} />
              <text y={-13} textAnchor="middle" fontSize="11" fontWeight="650"
                style={{ fill: 'var(--ink)', paintOrder: 'stroke', stroke: 'var(--card)', strokeWidth: 3 }}>{p.label}</text>
            </g>
          );
        })}
      </svg>
    </figure>
  );
}
