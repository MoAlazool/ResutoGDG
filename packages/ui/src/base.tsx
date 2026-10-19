'use client';
import { normalizeNumericInput } from '@resuto/contracts';
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode, type SelectHTMLAttributes, type InputHTMLAttributes, type TextareaHTMLAttributes } from 'react';

const cx = (...c: Array<string | false | null | undefined>) => c.filter(Boolean).join(' ');

export function PageHeader({ title, subtitle, actions, overline }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode; overline?: ReactNode }) {
  return (
    <header className="page-header">
      <div>
        {overline && <div className="overline">{overline}</div>}
        <h1>{title}</h1>
        {subtitle && <p>{subtitle}</p>}
      </div>
      {actions && <div className="row">{actions}</div>}
    </header>
  );
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
      <input className="input" aria-invalid={!!error || undefined} {...input}
        onInput={numeric ? (e) => { normalizeNumericEvent(e); onInput?.(e); } : onInput}
        onChange={numeric && onChange ? (e) => { normalizeNumericEvent(e); onChange(e); } : onChange} />
      {hint && <small>{hint}</small>}
      {error && <span className="field-error">{error}</span>}
    </label>
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
export function DataTable<T>({ rows, columns, rowKey, empty, onRowClick }: {
  rows: T[]; columns: Column<T>[]; rowKey: (row: T) => string; empty?: ReactNode; onRowClick?: (row: T) => void;
}) {
  if (!rows.length) return <div className="card">{empty ?? <EmptyState title="Nothing here yet" />}</div>;
  return (
    <div className="table-wrap">
      <table className="data">
        <thead><tr>{columns.map((c) => <th key={c.key} style={{ textAlign: c.align === 'end' ? 'end' : 'start' }}>{c.header}</th>)}</tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={rowKey(r)} onClick={onRowClick ? () => onRowClick(r) : undefined} style={onRowClick ? { cursor: 'pointer' } : undefined}>
              {columns.map((c) => <td key={c.key} style={{ textAlign: c.align === 'end' ? 'end' : 'start' }}>{c.render(r)}</td>)}
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
