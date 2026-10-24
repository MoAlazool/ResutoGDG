'use client';
import { INTL_LOCALE } from '@resuto/contracts/lite';
import { useId, useMemo, type ReactNode } from 'react';
import { useUiLocale } from '../locale';
import { chartColor } from './shared';

export interface DonutSegment { key: string; label: string; value: number; color?: string }

/** Share of a whole (payment methods, channels). Segments start at the top and run clockwise; a list gives values. */
export function DonutChart({ title, segments, format, centerLabel, centerValue, size = 168, thickness = 22 }: {
  title: string; segments: DonutSegment[]; format: (n: number) => string; centerLabel?: ReactNode; centerValue?: ReactNode;
  size?: number; thickness?: number;
}) {
  const id = useId();
  const total = segments.reduce((a, s) => a + Math.max(0, s.value), 0);
  const r = (size - thickness) / 2;
  let offset = 0;
  const arcs = segments.map((s, i) => {
    const pct = total > 0 ? (Math.max(0, s.value) / total) * 100 : 0;
    const arc = { ...s, pct, offset, color: s.color ?? chartColor(i) };
    offset += pct;
    return arc;
  });
  const locale = useUiLocale();
  const pctFormat = useMemo(() => new Intl.NumberFormat(locale === 'ar' ? INTL_LOCALE.ar : 'en-US', { style: 'percent', maximumFractionDigits: 1 }), [locale]);
  return (
    <figure className="rui-chart rui-donut">
      <div className="rui-donut-body">
        <svg className="rui-chart-svg" width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-labelledby={`${id}-t`}>
          <title id={`${id}-t`}>{title}</title>
          <circle cx={size / 2} cy={size / 2} r={r} fill="none" className="rui-donut-track" strokeWidth={thickness} />
          <g transform={`rotate(-90 ${size / 2} ${size / 2})`}>
            {arcs.filter((a) => a.pct > 0).map((a) => (
              <circle key={a.key} className="rui-donut-arc" cx={size / 2} cy={size / 2} r={r} fill="none" stroke={a.color} strokeWidth={thickness}
                pathLength={100} strokeDasharray={`${a.pct} ${100 - a.pct}`} strokeDashoffset={-a.offset} />
            ))}
          </g>
        </svg>
        {(centerValue !== undefined || centerLabel) && (
          <div className="rui-donut-center" aria-hidden="true">{centerValue !== undefined && <strong className="num">{centerValue}</strong>}{centerLabel && <span>{centerLabel}</span>}</div>
        )}
      </div>
      <ul className="rui-donut-legend">
        {arcs.map((a) => (
          <li key={a.key}><span className="rui-chart-swatch" style={{ background: a.color }} /><span>{a.label}</span>
            <b className="num">{format(a.value)}</b><small className="num">{pctFormat.format(a.pct / 100)}</small></li>
        ))}
      </ul>
    </figure>
  );
}
