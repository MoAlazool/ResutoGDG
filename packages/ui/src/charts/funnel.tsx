'use client';
import { INTL_LOCALE } from '@resuto/contracts/lite';
import { useMemo } from 'react';
import { useUiLocale } from '../locale';
import { chartColor } from './shared';

export interface FunnelStep { key: string; label: string; value: number }

/**
 * Conversion funnel: one bar per step, each as wide as its share of the first step, with the step-to-step rate.
 * An ordered list, so screen readers read steps, values and rates in order.
 */
export function FunnelChart({ title, steps, format, formatRate, rateLabel }: {
  title: string; steps: FunnelStep[]; format: (n: number) => string; formatRate?: (fraction: number) => string; rateLabel?: (rate: string) => string;
}) {
  const locale = useUiLocale();
  const pf = useMemo(() => new Intl.NumberFormat(locale === 'ar' ? INTL_LOCALE.ar : 'en-US', { style: 'percent', maximumFractionDigits: 1 }), [locale]);
  const rate = formatRate ?? ((f: number) => pf.format(f));
  const first = Math.max(0, steps[0]?.value ?? 0);
  return (
    <figure className="rui-chart rui-funnel">
      <figcaption className="sr-only">{title}</figcaption>
      <ol className="rui-funnel-steps">
        {steps.map((s, i) => {
          const share = first > 0 ? Math.max(0, s.value) / first : 0;
          const prev = i > 0 ? Math.max(0, steps[i - 1]!.value) : 0;
          const conv = i > 0 && prev > 0 ? rate(Math.max(0, s.value) / prev) : null;
          return (
            <li key={s.key} className="rui-funnel-step">
              <div className="rui-funnel-head"><span>{s.label}</span><b className="num">{format(s.value)}</b></div>
              <span className="rui-funnel-track" aria-hidden="true"><span className="rui-funnel-bar" style={{ inlineSize: `${Math.max(share > 0 ? 1 : 0, share * 100)}%`, background: chartColor(0) }} /></span>
              {conv && <small className="rui-funnel-rate num">{rateLabel ? rateLabel(conv) : conv}</small>}
            </li>
          );
        })}
      </ol>
    </figure>
  );
}
