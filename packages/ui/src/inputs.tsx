'use client';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { DateTimeInput } from './base';
import { UiStyles } from './styles';
import type { UiLocale } from './overlays';

const L = {
  en: { search: 'Search', clear: 'Clear search', prev: 'Previous', next: 'Next', page: 'Page {n}', of: 'Page {n} of {total}',
    from: 'From', to: 'To', today: 'Today', d7: '7 days', d30: '30 days', range: 'Date range' },
  ar: { search: 'بحث', clear: 'مسح البحث', prev: 'السابق', next: 'التالي', page: 'صفحة {n}', of: 'صفحة {n} من {total}',
    from: 'من', to: 'إلى', today: 'اليوم', d7: '7 أيام', d30: '30 يومًا', range: 'الفترة' },
};
const fill = (s: string, v: Record<string, string | number>) => Object.entries(v).reduce((a, [k, x]) => a.replaceAll(`{${k}}`, String(x)), s);

/** Search box with a visible label (or aria-label), clear button and optional debounce. */
export function SearchInput({ value, onChange, label, placeholder, debounceMs = 0, locale = 'en', hideLabel = true, name }: {
  value: string; onChange: (v: string) => void; label?: string; placeholder?: string; debounceMs?: number; locale?: UiLocale; hideLabel?: boolean; name?: string;
}) {
  const id = useId();
  const [local, setLocal] = useState(value);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => { setLocal(value); }, [value]);
  const emit = (v: string) => {
    setLocal(v);
    if (timer.current) clearTimeout(timer.current);
    if (debounceMs > 0) timer.current = setTimeout(() => onChange(v), debounceMs);
    else onChange(v);
  };
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const text = label ?? L[locale].search;
  return (
    <div className="field" style={{ marginBlockEnd: 0 }}>
      <UiStyles />
      <label htmlFor={id} className={hideLabel ? 'sr-only' : undefined} style={hideLabel ? undefined : { fontSize: 13, fontWeight: 650 }}>{text}</label>
      <div className="rui-search">
        <span className="rui-search-icon" aria-hidden>⌕</span>
        <input id={id} name={name} type="search" className="input" value={local} placeholder={placeholder ?? text}
          onChange={(e) => emit(e.target.value)} onKeyDown={(e) => { if (e.key === 'Escape' && local) { e.preventDefault(); emit(''); } }} />
        {local && <button type="button" className="rui-search-clear" onClick={() => emit('')} aria-label={L[locale].clear}>✕</button>}
      </div>
    </div>
  );
}

/**
 * Pagination for cursor (`hasNext`) or numbered (`pageCount`) lists. The API's
 * `{ items, nextCursor }` lists map to `hasNext = !!nextCursor`.
 */
export function Pagination({ page, pageCount, hasNext, onPage, locale = 'en', summary }: {
  page: number; pageCount?: number; hasNext?: boolean; onPage: (page: number) => void; locale?: UiLocale; summary?: ReactNode;
}) {
  const next = pageCount !== undefined ? page < pageCount : !!hasNext;
  const t = L[locale];
  return (
    <nav className="rui-pagination" aria-label="Pagination">
      <UiStyles />
      <span aria-live="polite">{summary ?? (pageCount ? fill(t.of, { n: page, total: pageCount }) : fill(t.page, { n: page }))}</span>
      <div className="row" style={{ gap: 8 }}>
        <button type="button" className="btn btn-sm" disabled={page <= 1} onClick={() => onPage(page - 1)}>
          <span aria-hidden>{locale === 'ar' ? '→' : '←'}</span> {t.prev}
        </button>
        <button type="button" className="btn btn-sm" disabled={!next} onClick={() => onPage(page + 1)}>
          {t.next} <span aria-hidden>{locale === 'ar' ? '←' : '→'}</span>
        </button>
      </div>
    </nav>
  );
}

export interface DateRange { from: string; to: string }
const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
/** Inclusive range ending today covering `days` days (days=1 → today). */
export function lastDays(days: number, today = new Date()): DateRange {
  const from = new Date(today);
  from.setDate(today.getDate() - (days - 1));
  return { from: iso(from), to: iso(today) };
}

/** Simple date range: two native date inputs plus quick presets; keeps from ≤ to. */
export function DateRangePicker({ value, onChange, locale = 'en', presets = [1, 7, 30], label }: {
  value: DateRange; onChange: (r: DateRange) => void; locale?: UiLocale; presets?: number[]; label?: string;
}) {
  const t = L[locale];
  const set = (from: string, to: string) => onChange(from && to && from > to ? { from: to, to: from } : { from, to });
  return (
    <fieldset className="rui-daterange" style={{ border: 0, padding: 0, margin: 0 }}>
      <UiStyles />
      <legend className="sr-only">{label ?? t.range}</legend>
      <label className="field"><span>{t.from}</span><DateTimeInput type="date" value={value.from} max={value.to || undefined} onChange={(e) => set(e.target.value, value.to)} /></label>
      <label className="field"><span>{t.to}</span><DateTimeInput type="date" value={value.to} min={value.from || undefined} onChange={(e) => set(value.from, e.target.value)} /></label>
      <div className="rui-presets" role="group" aria-label={label ?? t.range}>
        {presets.map((d) => {
          const r = lastDays(d);
          const active = r.from === value.from && r.to === value.to;
          return (
            <button key={d} type="button" className={`btn btn-sm btn-pill ${active ? 'btn-primary' : ''}`} aria-pressed={active} onClick={() => onChange(r)}>
              {d === 1 ? t.today : d === 7 ? t.d7 : d === 30 ? t.d30 : `${d}`}
            </button>
          );
        })}
      </div>
    </fieldset>
  );
}
