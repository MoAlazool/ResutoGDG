'use client';
import { INTL_LOCALE } from '@resuto/contracts';
// Shared building blocks for the overview, analytics, inventory and customers pages (Agent B2).
import { useCallback, type ReactNode } from 'react';
import s from './charts.module.css';
import type { AnalyticsMeta } from '@resuto/contracts';
import { Badge, Notice } from '@resuto/ui';
import type { ApiRequestError } from '@/lib/api';
import { money as fmtMoney } from '@/lib/format';
import { useT } from '@/lib/i18n/client';
import { useOrg } from '@/lib/org-context';

/** YYYY-MM-DD of "now" in a time zone. */
export function localToday(timeZone: string, offsetDays = 0): string {
  const d = new Date(Date.now() + offsetDays * 86_400_000);
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function useFormat() {
  const { locale } = useT();
  const { org } = useOrg();
  const nf = new Intl.NumberFormat(locale === 'ar' ? INTL_LOCALE.ar : 'en-GB', { maximumFractionDigits: 2 });
  const compact = new Intl.NumberFormat(locale === 'ar' ? INTL_LOCALE.ar : 'en-GB', { notation: 'compact', maximumFractionDigits: 1 });
  return {
    money: useCallback((minor: number | null | undefined) => fmtMoney(minor, org.currency, locale), [org.currency, locale]),
    compactMoney: (minor: number) => compact.format(minor / 100),
    num: (n: number | null | undefined) => (n === null || n === undefined ? '—' : nf.format(n)),
    pct: (n: number | null | undefined) => (n === null || n === undefined ? '—' : `${nf.format(n)}%`),
    minutes: (n: number | null | undefined) => (n === null || n === undefined ? '—' : `${nf.format(n)} ${locale === 'ar' ? 'د' : 'min'}`),
    date: (iso: string) => new Intl.DateTimeFormat(locale === 'ar' ? INTL_LOCALE.ar : 'en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(`${iso}T00:00:00Z`)),
  };
}

/** Change badge (± %). Neutral when there is no comparison base. */
export function Delta({ value, inverse = false }: { value: number | null | undefined; inverse?: boolean }) {
  const { t } = useT();
  const { pct } = useFormat();
  if (value === null || value === undefined) return <Badge>{t('insights.delta.none')}</Badge>;
  const good = inverse ? value < 0 : value > 0;
  const tone = value === 0 ? 'neutral' : good ? 'ok' : 'danger';
  return <Badge tone={tone}><span aria-hidden>{value > 0 ? '▲' : value < 0 ? '▼' : '■'}</span> {value > 0 ? '+' : ''}{pct(value)}</Badge>;
}

export interface Period { from: string; to: string; preset: string }

export function presetPeriod(preset: string, tz: string): Period {
  const today = localToday(tz);
  switch (preset) {
    case 'today': return { from: today, to: today, preset };
    case '7d': return { from: addDays(today, -6), to: today, preset };
    case '30d': return { from: addDays(today, -29), to: today, preset };
    case 'month': return { from: `${today.slice(0, 8)}01`, to: today, preset };
    case 'lastMonth': {
      const first = `${today.slice(0, 8)}01`;
      const lastPrev = addDays(first, -1);
      return { from: `${lastPrev.slice(0, 8)}01`, to: lastPrev, preset };
    }
    case '90d': return { from: addDays(today, -89), to: today, preset };
    default: return { from: addDays(today, -6), to: today, preset: '7d' };
  }
}

export function PeriodPicker({ value, onChange }: { value: Period; onChange: (p: Period) => void }) {
  const { t } = useT();
  const { org } = useOrg();
  const presets = ['today', '7d', '30d', 'month', 'lastMonth', '90d'];
  return (
    <div className="row" style={{ gap: 8 }} role="group" aria-label={t('insights.period.label')}>
      <select className="select" style={{ width: 'auto', minHeight: 38 }} value={value.preset} aria-label={t('insights.period.label')}
        onChange={(e) => onChange(e.target.value === 'custom' ? { ...value, preset: 'custom' } : presetPeriod(e.target.value, org.timezone))}>
        {presets.map((p) => <option key={p} value={p}>{t(`insights.period.${p}`)}</option>)}
        <option value="custom">{t('insights.period.custom')}</option>
      </select>
      {value.preset === 'custom' && (
        <>
          <input type="date" className="input" style={{ width: 'auto', minHeight: 38 }} aria-label={t('insights.period.from')} value={value.from}
            max={value.to} onChange={(e) => e.target.value && onChange({ ...value, from: e.target.value })} />
          <input type="date" className="input" style={{ width: 'auto', minHeight: 38 }} aria-label={t('insights.period.to')} value={value.to}
            min={value.from} onChange={(e) => e.target.value && onChange({ ...value, to: e.target.value })} />
        </>
      )}
    </div>
  );
}

export function BranchSelect({ value, onChange, allowAll = true }: { value: string; onChange: (v: string) => void; allowAll?: boolean }) {
  const { t, locale } = useT();
  const { org } = useOrg();
  const branches = org.branches.filter((b) => b.isActive);
  if (branches.length < 2 && allowAll) return null;
  return (
    <select className="select" style={{ width: 'auto', minHeight: 38 }} value={value} onChange={(e) => onChange(e.target.value)} aria-label={t('insights.branch.label')}>
      {allowAll && <option value="">{t('insights.branch.all')}</option>}
      {branches.map((b) => <option key={b.id} value={b.id}>{locale === 'ar' && b.nameAr ? b.nameAr : b.name}</option>)}
    </select>
  );
}

export function useBranchName() {
  const { locale } = useT();
  const { org } = useOrg();
  return (id: string | null | undefined) => {
    const b = org.branches.find((x) => x.id === id);
    return b ? (locale === 'ar' && b.nameAr ? b.nameAr : b.name) : '—';
  };
}

/** "How this is calculated": the API's method, assumptions and data coverage, shown verbatim. */
export function MetaPanel({ meta }: { meta: AnalyticsMeta | undefined }) {
  const { t } = useT();
  if (!meta) return null;
  const coverage = Object.entries(meta.dataCoverage ?? {});
  return (
    <details className="fine" style={{ marginBlockStart: 12 }}>
      <summary style={{ cursor: 'pointer' }}>{t('insights.meta.how')} {meta.kind !== 'measured' && <Badge tone="sandbox">{t(`insights.meta.kind.${meta.kind}`)}</Badge>}</summary>
      <div className="stack" style={{ gap: 6, marginBlockStart: 8 }}>
        <p style={{ margin: 0 }} lang="en">{meta.method}</p>
        <div>{t('insights.meta.timezone')}: <span className="num">{meta.timezone}</span></div>
        {meta.assumptions.length > 0 && (
          <div><strong>{t('insights.meta.assumptions')}</strong>
            <ul style={{ margin: '4px 0', paddingInlineStart: 18 }}>
              {meta.assumptions.map((a) => <li key={a.key}><code>{a.key}</code> = {String(a.value)} <Badge>{t(`insights.meta.source.${a.source}`)}</Badge></li>)}
            </ul>
          </div>
        )}
        {coverage.length > 0 && (
          <div><strong>{t('insights.meta.coverage')}</strong>
            <ul style={{ margin: '4px 0', paddingInlineStart: 18 }}>
              {coverage.map(([k, v]) => <li key={k}><code>{k}</code>: {v === null ? '—' : String(v)}</li>)}
            </ul>
          </div>
        )}
      </div>
    </details>
  );
}

export function LoadError({ error, retry }: { error: ApiRequestError | null; retry?: () => void }) {
  const { t } = useT();
  if (!error) return null;
  return (
    <Notice tone="danger">
      <div className="spread"><span>{error.message || t('state.error')}</span>{retry && <button className="btn btn-sm" onClick={retry}>{t('action.retry')}</button>}</div>
    </Notice>
  );
}

/** Root wrapper for B2 pages: keeps wide tables from widening the page on phones. */
export function InsightsPage({ children }: { children: ReactNode }) {
  return <div className={s.page}>{children}</div>;
}

export function Section({ title, actions, children }: { title: ReactNode; actions?: ReactNode; children: ReactNode }) {
  return (
    <section className="card">
      <div className="spread" style={{ marginBlockEnd: 14 }}>
        <h2 style={{ margin: 0, fontSize: 18 }}>{title}</h2>
        {actions && <div className="row">{actions}</div>}
      </div>
      {children}
    </section>
  );
}

export const qs = (params: Record<string, string | number | undefined | null | boolean>) => {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '' && v !== false) sp.set(k, String(v));
  const s = sp.toString();
  return s ? `?${s}` : '';
};
