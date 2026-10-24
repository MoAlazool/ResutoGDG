'use client';
import type { ReactNode } from 'react';
import { useUiLocale } from '../locale';
import { chartColor, plainNumber } from './shared';

export interface BarItem { key: string; label: ReactNode; value: number; hint?: ReactNode }
export type BarListProps = {
  format?: (n: number) => string;
  empty?: ReactNode;
  /** Accessible name of the list. */
  label?: string;
  /** Makes each row a toggle button (drill-down, segment pick). */
  onSelect?: (key: string) => void;
  selected?: string | null;
  /** 'single' (default): one hue, identity comes from the label; 'categorical': one chart colour per row. */
  palette?: 'single' | 'categorical';
} & ({ items: BarItem[]; rows?: never } | { rows: Array<{ key: string; label: string; value: number }>; items?: never });

/** Horizontal bars for ranked categories. Accepts `items` (analytics) or `rows` (intelligence segments). */
export function BarList(props: BarListProps) {
  const locale = useUiLocale();
  const items: BarItem[] = props.items ?? props.rows ?? [];
  const format = props.format ?? plainNumber(locale);
  const max = Math.max(0, ...items.map((i) => i.value));
  if (!items.length) return <p className="muted">{props.empty}</p>;
  return (
    <ul className="rui-barlist" aria-label={props.label}>
      {items.map((it, i) => {
        const pct = max > 0 ? Math.max(1, (Math.max(it.value, 0) / max) * 100) : 0;
        const body = (
          <>
            <span className="rui-bar-label">{it.label}{it.hint && <span className="rui-bar-hint">{it.hint}</span>}</span>
            <span className="rui-bar-track" aria-hidden="true">
              <span className="rui-bar" style={{ inlineSize: `${pct}%`, background: props.palette === 'categorical' ? chartColor(i) : undefined }} />
            </span>
            <span className="rui-bar-value num">{format(it.value)}</span>
          </>
        );
        return (
          <li key={it.key} className="rui-bar-row" title={`${typeof it.label === 'string' ? it.label : ''} ${format(it.value)}`.trim()}>
            {props.onSelect
              ? <button type="button" className="rui-bar-button" aria-pressed={props.selected === it.key} onClick={() => props.onSelect!(it.key)}>{body}</button>
              : body}
          </li>
        );
      })}
    </ul>
  );
}
