'use client';
// Accessible inline SVG charts using the chart tokens (--chart-1..4). Each chart has a text
// alternative (role="img" + aria-label) and the forecast chart has a values table.

interface Point { date: string; value: number }
interface Band { date: string; yhat: number; lower: number; upper: number }

const W = 640;
const H = 220;
const PAD = { l: 36, r: 12, t: 12, b: 26 };

export function ForecastChart({ history, forecast, label, rtl }: { history: Point[]; forecast: Band[]; label: string; rtl?: boolean }) {
  const all = [...history.map((h) => h.date), ...forecast.map((f) => f.date)];
  const n = all.length;
  const maxY = Math.max(1, ...history.map((h) => h.value), ...forecast.map((f) => f.upper));
  const x = (i: number) => {
    const v = PAD.l + (i / Math.max(n - 1, 1)) * (W - PAD.l - PAD.r);
    return rtl ? W - v : v;
  };
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
    <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={label} style={{ width: '100%', height: 'auto', display: 'block' }}>
      <title>{label}</title>
      {ticks.map((tk) => (
        <g key={tk}>
          <line x1={PAD.l} x2={W - PAD.r} y1={y(tk)} y2={y(tk)} stroke="var(--line)" strokeDasharray="3 4" />
          <text x={rtl ? W - 4 : 4} y={y(tk) + 4} fontSize="11" fill="var(--muted)" textAnchor={rtl ? 'end' : 'start'}>{tk}</text>
        </g>
      ))}
      {band && <path d={band} fill="var(--chart-1)" opacity="0.16" />}
      {histPath && <path d={histPath} fill="none" stroke="var(--chart-4)" strokeWidth="2" />}
      {fcPath && <path d={fcPath} fill="none" stroke="var(--chart-1)" strokeWidth="2.5" strokeDasharray="6 4" />}
      {off > 0 && forecast.length > 0 && <line x1={x(off - 0.5)} x2={x(off - 0.5)} y1={PAD.t} y2={H - PAD.b} stroke="var(--muted)" strokeWidth="1" />}
      {all.map((d, i) => (i % labelEvery === 0 ? (
        <text key={d} x={x(i)} y={H - 8} fontSize="10" fill="var(--muted)" textAnchor="middle">{d.slice(5)}</text>
      ) : null))}
    </svg>
  );
}

export function Legend({ items }: { items: Array<{ color: string; label: string; dashed?: boolean; band?: boolean }> }) {
  return (
    <div className="row" style={{ gap: 16, fontSize: 12, color: 'var(--muted)' }}>
      {items.map((it) => (
        <span key={it.label} className="row gap-6">
          <svg width="22" height="10" aria-hidden="true">
            {it.band ? <rect width="22" height="10" fill={it.color} opacity="0.2" />
              : <line x1="0" x2="22" y1="5" y2="5" stroke={it.color} strokeWidth="2.5" strokeDasharray={it.dashed ? '5 3' : undefined} />}
          </svg>
          {it.label}
        </span>
      ))}
    </div>
  );
}

/** Horizontal bars (segment sizes). */
export function BarList({ rows, onSelect, selected, label }: {
  rows: Array<{ key: string; label: string; value: number }>; onSelect?: (key: string) => void; selected?: string | null; label: string;
}) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <ul aria-label={label} style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 8 }}>
      {rows.map((r, i) => (
        <li key={r.key}>
          <button type="button" onClick={() => onSelect?.(r.key)} aria-pressed={selected === r.key}
            style={{ all: 'unset', cursor: onSelect ? 'pointer' : 'default', display: 'grid', gridTemplateColumns: 'minmax(110px, 160px) 1fr 48px', gap: 10, alignItems: 'center', width: '100%',
              fontWeight: selected === r.key ? 700 : 500 }}>
            <span style={{ fontSize: 14 }}>{r.label}</span>
            <span style={{ background: 'var(--line-soft)', borderRadius: 6, height: 14, overflow: 'hidden' }}>
              <span style={{ display: 'block', height: '100%', width: `${(r.value / max) * 100}%`, background: `var(--chart-${(i % 4) + 1})`, borderRadius: 6 }} />
            </span>
            <span className="num" style={{ textAlign: 'end', fontSize: 14 }}>{r.value}</span>
          </button>
        </li>
      ))}
    </ul>
  );
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
