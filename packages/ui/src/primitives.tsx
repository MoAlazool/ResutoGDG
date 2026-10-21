'use client';
import { createContext, useContext, type ReactNode } from 'react';
import { figureOf, figureProps } from './figure';

// Page primitives restored from the original Resuto manager workspace (legacy/public/style.css .page-heading,
// .stats, .panel/.panel-head): breadcrumb eyebrow, 32px heading, 13px subtitle and actions; a joined KPI strip
// (4-up desktop, 2-up mobile) with value, unit and note; white 10px-radius panels without shadow.

const EyebrowContext = createContext<ReactNode>(null);

/**
 * Default eyebrow for page headings in this subtree (the staff shell sets "Restaurant / Branch", as in the legacy
 * workspace). A page's own `overline`/`eyebrow` wins.
 */
export function PageEyebrowProvider({ value, children }: { value: ReactNode; children: ReactNode }) {
  return <EyebrowContext.Provider value={value}>{children}</EyebrowContext.Provider>;
}
export const usePageEyebrow = () => useContext(EyebrowContext);

/** Restaurant / branch breadcrumb used as the page eyebrow; names are direction-isolated user text. */
export function Breadcrumb({ parts }: { parts: Array<ReactNode | null | undefined | false> }) {
  const shown = parts.filter((p): p is ReactNode => p !== null && p !== undefined && p !== false && p !== '');
  return <>{shown.map((p, i) => <span key={i}>{i > 0 && <span className="eyebrow-sep" aria-hidden="true">/</span>}<bdi>{p}</bdi></span>)}</>;
}

export function PageHeading({ title, subtitle, actions, eyebrow }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode; eyebrow?: ReactNode }) {
  const fallback = usePageEyebrow();
  const shown = eyebrow ?? fallback;
  return (
    <header className="page-header">
      <div className="page-header-text">
        {shown && <div className="eyebrow">{shown}</div>}
        <h1>{title}</h1>
        {subtitle && <p>{subtitle}</p>}
      </div>
      {actions && <div className="heading-actions">{actions}</div>}
    </header>
  );
}

export interface StripItem {
  key?: string;
  label: ReactNode;
  value: ReactNode;
  /** Small unit after the value (e.g. "covers", "min"). */
  unit?: ReactNode;
  note?: ReactNode;
  tone?: 'ok' | 'warn' | 'danger';
}

/** Joined KPI strip with dividers: 4 per row on desktop, 2 on tablets and phones. */
export function StatsStrip({ items, label, busy }: { items: StripItem[]; label?: string; busy?: boolean }) {
  return (
    <section className="stats-strip" aria-label={label} aria-busy={busy || undefined} data-count={items.length}>
      {items.map((i, n) => {
        const fig = figureProps(figureOf(i.value, i.unit));
        return (
          <div key={i.key ?? n} className="stats-cell" data-tone={i.tone}>
            <span className="stats-label">{i.label}</span>
            <strong {...fig} className={`stats-value num${fig.className ? ` ${fig.className}` : ''}`}>{i.value}{i.unit && <small>{i.unit}</small>}</strong>
            {i.note && <p className="stats-note">{i.note}</p>}
          </div>
        );
      })}
    </section>
  );
}

/** Strip placeholder with the same geometry (no layout shift when values arrive). */
export function StatsStripSkeleton({ count = 4 }: { count?: number }) {
  return (
    <section className="stats-strip" aria-busy="true" data-count={count}>
      {Array.from({ length: count }, (_, n) => (
        <div key={n} className="stats-cell">
          <span className="skeleton" style={{ display: 'block', width: '45%', height: 12 }} />
          <span className="skeleton" style={{ display: 'block', width: '60%', height: 34, margin: '12px 0 10px' }} />
          <span className="skeleton" style={{ display: 'block', width: '35%', height: 10 }} />
        </div>
      ))}
    </section>
  );
}

/** White panel with an optional head (title, note, actions). `flush` removes the body padding (tables, maps). */
export function Panel({ title, note, actions, children, flush, className, as: Tag = 'section', label }: {
  title?: ReactNode; note?: ReactNode; actions?: ReactNode; children: ReactNode; flush?: boolean; className?: string;
  as?: 'section' | 'div' | 'aside'; label?: string;
}) {
  return (
    <Tag className={['panel', className].filter(Boolean).join(' ')} aria-label={label}>
      {(title || actions) && <PanelHead title={title} note={note} actions={actions} />}
      <div className={flush ? 'panel-body-flush' : 'panel-body'}>{children}</div>
    </Tag>
  );
}

export function PanelHead({ title, note, actions }: { title?: ReactNode; note?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="panel-head">
      <div>
        {title && <h2>{title}</h2>}
        {note && <p>{note}</p>}
      </div>
      {actions && <div className="row">{actions}</div>}
    </div>
  );
}
