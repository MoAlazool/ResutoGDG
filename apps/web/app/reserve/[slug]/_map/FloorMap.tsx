'use client';
import type { PublicFloor, PublicFloorTable } from '@resuto/contracts';

export type MapState = 'available' | 'unavailable' | 'selected' | 'recommended';

const FILL: Record<MapState, { fill: string; stroke: string; text: string }> = {
  available: { fill: '#e6f2e2', stroke: '#2f6238', text: '#173f36' },
  recommended: { fill: '#fbedc9', stroke: '#b8893a', text: '#5b4210' },
  selected: { fill: '#173f36', stroke: '#0c2620', text: '#ffffff' },
  unavailable: { fill: '#eeeee9', stroke: '#c9ccc4', text: '#9aa096' },
};

/**
 * Reservation floor map rendered from the public, sanitized schema-v2 geometry
 * (`GET /v1/public/floor/:slug/:branchCode`). Tables are buttons; everything
 * else is decoration. Layout units are illustrative, not architectural.
 */
export function FloorMap({ floor, states, onSelect, label, seats }: {
  floor: PublicFloor; states: Record<string, MapState>; onSelect: (t: PublicFloorTable) => void; label: string; seats: (n: number) => string;
}) {
  return (
    <svg viewBox={`0 0 ${floor.width} ${floor.height}`} role="group" aria-label={label} style={{ width: '100%', height: 'auto', background: '#f7f6f1', borderRadius: 18, display: 'block' }}>
      {floor.background.image && (
        <image href={floor.background.image} x={floor.background.x} y={floor.background.y} width={floor.background.width} height={floor.background.height} opacity={floor.background.opacity} />
      )}
      {floor.zones.map((z) => (
        <g key={z.id} transform={`translate(${z.x} ${z.y}) rotate(${z.rotation})`}>
          <rect x={-z.width / 2} y={-z.height / 2} width={z.width} height={z.height} rx={28} fill={z.color} opacity={0.8} />
          <text x={-z.width / 2 + 24} y={-z.height / 2 + 34} fontSize={20} fill="#57685f" fontWeight={600}>{z.label}</text>
        </g>
      ))}
      {floor.objects.map((o) => {
        const wall = o.type === 'wall' || o.type === 'divider';
        const door = o.type === 'door' || o.type === 'entrance';
        return (
          <g key={o.id} transform={`translate(${o.x} ${o.y}) rotate(${o.rotation})`} aria-hidden>
            {o.type === 'plant'
              ? <circle r={Math.min(o.width, o.height) / 2} fill="#7da05f" opacity={0.8} />
              : <rect x={-o.width / 2} y={-o.height / 2} width={o.width} height={o.height} rx={wall ? 3 : 10}
                fill={wall ? '#57685f' : door ? '#fff' : o.type === 'window' ? '#cfe1ea' : '#e2d8c6'} stroke={door ? '#57685f' : 'none'} strokeDasharray={door ? '6 4' : undefined} />}
            {!wall && o.type !== 'plant' && o.type !== 'window' && o.height >= 24 && (
              <text textAnchor="middle" dominantBaseline="central" fontSize={16} fill="#57685f">{o.label}</text>
            )}
          </g>
        );
      })}
      {floor.tables.map((tb) => {
        const s = FILL[states[tb.id] ?? 'unavailable'];
        const disabled = (states[tb.id] ?? 'unavailable') === 'unavailable';
        const round = tb.shape === 'round';
        return (
          <g key={tb.id} transform={`translate(${tb.cx} ${tb.cy}) rotate(${tb.rotation})`} role="button" tabIndex={disabled ? -1 : 0}
            aria-disabled={disabled} aria-pressed={states[tb.id] === 'selected'} aria-label={`${tb.label}, ${seats(tb.capacity)}`}
            style={{ cursor: disabled ? 'not-allowed' : 'pointer' }}
            onClick={() => { if (!disabled) onSelect(tb); }}
            onKeyDown={(e) => { if (!disabled && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); onSelect(tb); } }}>
            {round
              ? <ellipse rx={tb.width / 2} ry={tb.height / 2} fill={s.fill} stroke={s.stroke} strokeWidth={3} />
              : <rect x={-tb.width / 2} y={-tb.height / 2} width={tb.width} height={tb.height} rx={15} fill={s.fill} stroke={s.stroke} strokeWidth={3} />}
            <g transform={`rotate(${-tb.rotation})`}>
              <text textAnchor="middle" y={-2} fontSize={22} fontWeight={700} fill={s.text}>{tb.label}</text>
              <text textAnchor="middle" y={22} fontSize={15} fill={s.text}>{seats(tb.capacity)}</text>
              {tb.premium && <text textAnchor="middle" y={-tb.height / 2 - 8} fontSize={18} fill="#b8893a">★</text>}
            </g>
          </g>
        );
      })}
    </svg>
  );
}
