'use client';
import { dateTimeFormat, formatClock, normalizeNumericInput } from '@resuto/contracts';
import { useUiLocale } from './locale';
import { PageHeading } from './primitives';
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode, type SelectHTMLAttributes, type InputHTMLAttributes, type TextareaHTMLAttributes } from 'react';

const cx = (...c: Array<string | false | null | undefined>) => c.filter(Boolean).join(' ');

/**
 * Page heading (legacy .page-heading): eyebrow, 32px title, 13px subtitle and actions. Without an `overline` the
 * eyebrow is the shell's "Restaurant / Branch" breadcrumb (PageEyebrowProvider).
 */
export function PageHeader({ title, subtitle, actions, overline }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode; overline?: ReactNode }) {
  return <PageHeading title={title} subtitle={subtitle} actions={actions} eyebrow={overline} />;
}

export function Card({ title, actions, children, warm, className }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; warm?: boolean; className?: string }) {
  return (
    <section className={cx('card', warm && 'card-warm', className)}>
      {(title || actions) && (
        <div className="spread" style={{ marginBlockEnd: 14 }}>
          {title && <h2 style={{ margin: 0 }}>{title}</h2>}
          {actions && <div className="row">{actions}</div>}
        </div>
      )}
      {children}
    </section>
  );
}

export function Stat({ label, value, hint, tone }: { label: ReactNode; value: ReactNode; hint?: ReactNode; tone?: 'ok' | 'warn' | 'danger' }) {
  return (
    <div className="card stat">
      <span>{label}</span>
      <strong>{value}</strong>
      {hint && <em style={{ color: tone ? `var(--${tone})` : 'var(--muted)' }}>{hint}</em>}
    </div>
  );
}

export type Tone = 'ok' | 'warn' | 'info' | 'pay' | 'danger' | 'sandbox' | 'neutral';
export function Badge({ tone = 'neutral', children }: { tone?: Tone; children: ReactNode }) {
  return <span className={cx('badge', tone !== 'neutral' && `badge-${tone}`)}>{children}</span>;
}

export function Notice({ tone = 'info', children }: { tone?: 'info' | 'warn' | 'danger' | 'ok'; children: ReactNode }) {
  return <div role={tone === 'danger' ? 'alert' : 'status'} className={cx('notice', tone !== 'info' && `notice-${tone}`)}>{children}</div>;
}

export function EmptyState({ title, children, action }: { title: ReactNode; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      <strong>{title}</strong>
      {children && <p>{children}</p>}
      {action}
    </div>
  );
}

export function Skeleton({ lines = 3 }: { lines?: number }) {
  return <div className="stack" aria-busy="true">{Array.from({ length: lines }, (_, i) => <div key={i} className="skeleton" style={{ width: `${90 - i * 12}%` }} />)}</div>;
}

interface FieldProps { label: ReactNode; hint?: ReactNode; error?: string | null }
const NUMERIC_MODES = new Set(['decimal', 'numeric', 'tel']);
/**
 * Numeric text inputs (inputMode decimal/numeric/tel) accept Arabic-Indic digits from Arabic keyboards and store
 * Western digits 0-9, so amounts, quantities and phone numbers parse the same in both languages.
 * Free text, identifiers and secrets are never rewritten (only these input modes are touched).
 */
export function normalizeNumericEvent(e: { currentTarget: HTMLInputElement }) {
  const el = e.currentTarget;
  const next = normalizeNumericInput(el.value);
  if (next === el.value) return;
  const pos = el.selectionStart;
  el.value = next;
  if (pos !== null) { try { el.setSelectionRange(pos, pos); } catch { /* some input types have no selection */ } }
}

export function Field({ label, hint, error, ...input }: FieldProps & InputHTMLAttributes<HTMLInputElement>) {
  const numeric = typeof input.inputMode === 'string' && NUMERIC_MODES.has(input.inputMode);
  const { onChange, onInput } = input;
  return (
    <label className="field">
      <span>{label}</span>
      {isDateTimeType(input.type)
        ? <DateTimeInput aria-invalid={!!error || undefined} {...input} type={input.type} />
        : <input className="input" aria-invalid={!!error || undefined} {...input}
          onInput={numeric ? (e) => { normalizeNumericEvent(e); onInput?.(e); } : onInput}
          onChange={numeric && onChange ? (e) => { normalizeNumericEvent(e); onChange(e); } : onChange} />}
      {hint && <small>{hint}</small>}
      {error && <span className="field-error">{error}</span>}
    </label>
  );
}

export type DateTimeType = 'date' | 'time' | 'datetime-local';
const isDateTimeType = (t: unknown): t is DateTimeType => t === 'date' || t === 'time' || t === 'datetime-local';

/**
 * Resting text of a date/time field, in the page's language with Western digits and no time-zone shift (the value is
 * wall-clock): "2026-10-20" → "20 Oct 2026" / "20 أكتوبر 2026"; "21:30" → "21:30" / "9:30 م";
 * "2026-10-13T06:43" → "13 Oct 2026, 6:43" / "13 أكتوبر 2026، 6:43 ص". Unparseable values are shown as given.
 */
export function formatInputValue(type: DateTimeType, value: string, locale: 'en' | 'ar'): string {
  const date = (v: string) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
    return m ? dateTimeFormat(locale, { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!)) : null;
  };
  const time = (v: string) => {
    const m = /^(\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?$/.exec(v);
    return m ? formatClock(+m[1]!, +m[2]!, locale) : null;
  };
  if (type === 'date') return date(value) ?? value;
  if (type === 'time') return time(value) ?? value;
  const [d, t] = value.split('T');
  const dd = d ? date(d) : null;
  const tt = t ? time(t) : null;
  return dd && tt ? `${dd}${locale === 'ar' ? '، ' : ', '}${tt}` : value;
}

const EMPTY_DATE_TEXT = {
  en: { date: 'Choose a date', time: 'Choose a time', 'datetime-local': 'Choose a date and time' },
  ar: { date: 'اختر تاريخًا', time: 'اختر وقتًا', 'datetime-local': 'اختر التاريخ والوقت' },
} as const;

/**
 * Native date, time or datetime-local input whose resting text is formatted by Resuto (Western digits, the page's language) instead of
 * the browser's locale (mm/dd/yyyy, or Arabic-Indic digits in an Arabic browser). An empty field shows `placeholder`
 * (or "Choose a date" in the page language) instead of the browser's "mm/dd/yyyy" pattern. While focused the native
 * fields are shown for typing; the native calendar/clock picker stays available (VS-06).
 */
export function DateTimeInput({ type, className, ...props }: InputHTMLAttributes<HTMLInputElement> & { type: DateTimeType }) {
  const locale = useUiLocale();
  const controlled = props.value !== undefined;
  const [inner, setInner] = useState(String(props.defaultValue ?? ''));
  const value = controlled ? String(props.value ?? '') : inner;
  return (
    <span className="date-input" data-filled={value ? '' : undefined} data-empty={value ? undefined : ''}>
      <input {...props} type={type} className={cx('input', className)}
        onChange={(e) => { if (!controlled) setInner(e.target.value); props.onChange?.(e); }} />
      {value
        ? <span className="date-input-text num" aria-hidden="true">{formatInputValue(type, value, locale)}</span>
        : <span className="date-input-text date-input-empty" aria-hidden="true">{props.placeholder ?? EMPTY_DATE_TEXT[locale][type]}</span>}
    </span>
  );
}

export function SelectField({ label, hint, error, children, ...select }: FieldProps & SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <label className="field">
      <span>{label}</span>
      <select className="select" {...select}>{children}</select>
      {hint && <small>{hint}</small>}
      {error && <span className="field-error">{error}</span>}
    </label>
  );
}
export function TextareaField({ label, hint, error, ...ta }: FieldProps & TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <label className="field">
      <span>{label}</span>
      <textarea className="textarea" {...ta} />
      {hint && <small>{hint}</small>}
      {error && <span className="field-error">{error}</span>}
    </label>
  );
}

export interface Column<T> { key: string; header: ReactNode; render: (row: T) => ReactNode; align?: 'start' | 'end' }
export function DataTable<T>({ rows, columns, rowKey, empty, onRowClick, busy }: {
  rows: T[]; columns: Column<T>[]; rowKey: (row: T) => string; empty?: ReactNode; onRowClick?: (row: T) => void;
  /** The rows belong to the previous filter/page while the new result loads (useApi().pending): dimmed + aria-busy. */
  busy?: boolean;
}) {
  if (!rows.length) return <div className="card" aria-busy={busy || undefined}>{empty ?? <EmptyState title="Nothing here yet" />}</div>;
  return (
    <div className="table-wrap dt-stack" aria-busy={busy || undefined} data-busy={busy || undefined}>
      <table className="data">
        <thead><tr>{columns.map((c) => <th key={c.key} style={{ textAlign: c.align === 'end' ? 'end' : 'start' }}>{c.header}</th>)}</tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={rowKey(r)} onClick={onRowClick ? () => onRowClick(r) : undefined} style={onRowClick ? { cursor: 'pointer' } : undefined}>
              {/* .dt-label repeats the header for the stacked card layout under 700px (VS-25); hidden otherwise. */}
              {columns.map((c) => (
                <td key={c.key} style={{ textAlign: c.align === 'end' ? 'end' : 'start' }}>
                  {c.header ? <span className="dt-label" aria-hidden="true">{c.header}</span> : null}<div className="dt-cell">{c.render(r)}</div>
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Native <dialog> modal: focus trapping and Escape handling come from the browser. */
export function Modal({ open, onClose, title, children, footer }: { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; footer?: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog ref={ref} onClose={onClose} className="card" style={{ width: 'min(560px, calc(100% - 24px))', border: 0, padding: 26, boxShadow: 'var(--shadow-sheet)' }}>
      <div className="spread" style={{ marginBlockEnd: 16 }}>
        <h2 style={{ margin: 0 }}>{title}</h2>
        <button type="button" className="btn btn-ghost btn-sm" onClick={onClose} aria-label="Close">✕</button>
      </div>
      {children}
      {footer && <div className="row" style={{ justifyContent: 'flex-end', marginBlockStart: 18 }}>{footer}</div>}
    </dialog>
  );
}

/** Tab list with roving focus: Arrow keys (mirrored in RTL), Home and End move between tabs. */
export function Tabs<K extends string>({ tabs, value, onChange, label }: { tabs: Array<{ key: K; label: ReactNode }>; value: K; onChange: (k: K) => void; label?: string }) {
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const i = tabs.findIndex((t) => t.key === value);
    const rtl = getComputedStyle(e.currentTarget).direction === 'rtl';
    let next = -1;
    if (e.key === 'ArrowRight') next = rtl ? i - 1 : i + 1;
    else if (e.key === 'ArrowLeft') next = rtl ? i + 1 : i - 1;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = tabs.length - 1;
    else return;
    e.preventDefault();
    const target = tabs[(next + tabs.length) % tabs.length]!;
    onChange(target.key);
    e.currentTarget.querySelector<HTMLButtonElement>(`[data-tab="${target.key}"]`)?.focus();
  };
  return (
    <div role="tablist" aria-label={label} className="row" style={{ gap: 6, marginBlockEnd: 18 }} onKeyDown={onKeyDown}>
      {tabs.map((t) => (
        <button key={t.key} role="tab" aria-selected={t.key === value} tabIndex={t.key === value ? 0 : -1} type="button" data-tab={t.key}
          className={cx('btn btn-sm btn-pill', t.key === value ? 'btn-primary' : 'btn-ghost')} onClick={() => onChange(t.key)}>
          {t.label}
        </button>
      ))}
    </div>
  );
}

/** Runs an async action with pending state and surfaced errors. */
export function useAction<A extends unknown[], R>(fn: (...args: A) => Promise<R>) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Guards against a double click or Enter submitting the same intent twice while it is in flight.
  const busy = useRef(false);
  const run = async (...args: A): Promise<R | undefined> => {
    if (busy.current) return undefined;
    busy.current = true;
    setPending(true);
    setError(null);
    try {
      return await fn(...args);
    } catch (e) {
      setError((e as Error).message);
      return undefined;
    } finally {
      busy.current = false;
      setPending(false);
    }
  };
  return { run, pending, error, setError };
}
