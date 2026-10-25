'use client';
import { INTL_LOCALE } from '@resuto/contracts/lite';
import type { ElementType, ReactNode } from 'react';
import { Badge, type Tone } from './base';
import { Sparkline } from './charts/sparkline';
import { figureOf, figureProps } from './figure';
import { useUiLocale } from './locale';
import type { UiLocale } from './overlays';

// Honest metrics (plan §2.7): every figure says where it comes from. live = measured from this restaurant's own
// records; estimated = modelled or partly assumed (AnalyticsMeta.kind 'hypothetical' or 'mixed'); sandbox = a test or
// demo provider, not real money or messages; unavailable = no data source yet (the value is never invented).

export type Provenance = 'live' | 'estimated' | 'sandbox' | 'unavailable';

const PL: Record<UiLocale, Record<Provenance, string>> = {
  en: { live: 'Live', estimated: 'Estimated', sandbox: 'Sandbox', unavailable: 'Unavailable' },
  ar: { live: 'مباشر', estimated: 'تقديري', sandbox: 'تجريبي', unavailable: 'غير متاح' },
};
const PROVENANCE_TONE: Record<Provenance, Tone> = { live: 'ok', estimated: 'info', sandbox: 'sandbox', unavailable: 'neutral' };

/** AnalyticsMeta.kind (the analytics API's "how this is calculated") → provenance. */
export function provenanceFromMetaKind(kind: 'measured' | 'hypothetical' | 'mixed' | null | undefined): Provenance {
  if (kind === 'measured') return 'live';
  if (kind === 'hypothetical' || kind === 'mixed') return 'estimated';
  return 'unavailable';
}

export function provenanceLabel(p: Provenance, locale: UiLocale = 'en') { return PL[locale][p]; }

/** Small badge naming where a figure comes from (reuses the Badge tones; sandbox keeps its dashed outline). */
export function ProvenanceBadge({ provenance, locale, labels }: { provenance: Provenance; locale?: UiLocale; labels?: Partial<Record<Provenance, string>> }) {
  const ctx = useUiLocale();
  const text = labels?.[provenance] ?? PL[locale ?? ctx][provenance];
  return <span className="rui-provenance" data-provenance={provenance}><Badge tone={PROVENANCE_TONE[provenance]}>{text}</Badge></span>;
}

export interface StatDelta {
  /** Change in percent (12.5 = +12.5 %); null when there is no comparison base. */
  value: number | null;
  /** True when a decrease is good (cost, wait time). */
  inverse?: boolean;
  /** What it is compared with ("vs last Tuesday"). */
  label?: ReactNode;
}

const SL = { en: { noBase: 'No comparison', trend: 'Trend' }, ar: { noBase: 'لا توجد مقارنة', trend: 'الاتجاه' } };

/**
 * KPI tile v2: label, value (with unit), change against a comparison, an optional sparkline and the provenance badge.
 * An 'unavailable' figure shows a dash, never a made-up value. Wrap a row of them in .rui-stat-grid. Values are not
 * animated: a new value replaces the old one with a short cross-fade (.motion-content).
 */
export function StatV2({ label, value, unit, delta, sparkline, provenance, hint, href, linkAs, locale, labels, rtl }: {
  label: ReactNode; value: ReactNode; unit?: ReactNode; delta?: StatDelta | null; sparkline?: number[]; provenance?: Provenance;
  hint?: ReactNode; href?: string;
  /** The link component for `href` (the web passes Next's Link for client navigation); a plain <a> by default. */
  linkAs?: ElementType;
  locale?: UiLocale; labels?: Partial<typeof SL.en>; rtl?: boolean;
}) {
  const ctx = useUiLocale();
  const loc = locale ?? ctx;
  const t = { ...SL[loc], ...labels };
  const unavailable = provenance === 'unavailable';
  const shown = unavailable ? '—' : value;
  const fig = figureProps(figureOf(shown, unit));
  const nf = new Intl.NumberFormat(loc === 'ar' ? INTL_LOCALE.ar : 'en-US', { maximumFractionDigits: 1 });
  let deltaNode: ReactNode = null;
  if (delta && !unavailable) {
    if (delta.value === null || !Number.isFinite(delta.value)) deltaNode = <span className="rui-stat-delta" data-trend="none">{t.noBase}</span>;
    else {
      const v = delta.value;
      const good = delta.inverse ? v < 0 : v > 0;
      const trend = v === 0 ? 'flat' : good ? 'good' : 'bad';
      deltaNode = (
        <span className="rui-stat-delta num" data-trend={trend}>
          <span aria-hidden="true">{v > 0 ? '▲' : v < 0 ? '▼' : '■'}</span> {v > 0 ? '+' : ''}{nf.format(v)}%
          {delta.label && <span className="rui-stat-vs"> {delta.label}</span>}
        </span>
      );
    }
  }
  const body = (
    <>
      <div className="rui-stat-top">
        <span className="rui-stat-label">{label}</span>
        {provenance && <ProvenanceBadge provenance={provenance} locale={loc} />}
      </div>
      <strong {...fig} className={['rui-stat-value num motion-content', fig.className].filter(Boolean).join(' ')}>
        {shown}{unit && !unavailable && <small>{unit}</small>}
      </strong>
      <div className="rui-stat-foot">
        {deltaNode}
        {sparkline && !unavailable && <Sparkline values={sparkline} label={typeof label === 'string' ? `${label} — ${t.trend}` : t.trend} rtl={rtl ?? loc === 'ar'} />}
      </div>
      {hint && <p className="rui-stat-hint">{hint}</p>}
    </>
  );
  const A = linkAs ?? 'a';
  return href
    ? <A className="rui-stat" href={href} data-provenance={provenance}>{body}</A>
    : <div className="rui-stat" data-provenance={provenance}>{body}</div>;
}
