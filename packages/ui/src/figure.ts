import { Children, isValidElement, type CSSProperties, type ReactNode } from 'react';

// KPI tile values (Stat, StatsStrip). A figure — an amount with its currency, a count, a percentage — is one unit:
// it never wraps (the formatters glue amount and currency with a no-break space) and its font shrinks with the tile
// and with its own length. Anything else (a date, "1,250 expire on 21 Nov 2026", a status sentence) wraps like
// text so nothing is hidden (PAR-06 review).

// Every space a line may break at (U+00A0 / U+202F, the no-break spaces the formatters use, are not in it).
const BREAKABLE = new RegExp('[\\t\\n\\r \\u1680\\u2000-\\u200a\\u2028\\u2029\\u205f\\u3000]');

// Bidi marks and isolates the formatters add (LRM, RLM, ALM, LRI...PDI) take no width.
const INVISIBLE = new RegExp('[\\u200e\\u200f\\u061c\\u2066-\\u2069]', 'g');

/** The plain text of a value made of strings, numbers and plain HTML elements; null when a component renders it. */
export function plainText(node: ReactNode): string | null {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number' || typeof node === 'bigint') return String(node);
  if (Array.isArray(node)) {
    let out = '';
    for (const c of Children.toArray(node)) { const s = plainText(c); if (s === null) return null; out += s; }
    return out;
  }
  if (isValidElement(node) && typeof node.type === 'string') return plainText((node.props as { children?: ReactNode }).children);
  return null;
}

export interface Figure { text: string; chars: number }

/** The value as a figure (has a digit, no breakable space, short), or null when it should wrap as text. */
export function figureOf(value: ReactNode, unit?: ReactNode): Figure | null {
  const text = plainText(value)?.trim();
  if (!text || !/\d/.test(text) || BREAKABLE.test(text) || text.length > 24) return null;
  const u = unit === undefined || unit === null ? '' : plainText(unit);
  if (u === null) return null;
  // The unit is set at about half the value's size, after a gap.
  const chars = text.replace(INVISIBLE, '').length + (u ? 1 + u.trim().length / 2 : 0);
  return { text: u ? `${text} ${u.trim()}` : text, chars: Math.max(4, Math.round(chars * 10) / 10) };
}

/** Props for the element that shows a figure: the class, the length the CSS scales the font by, and the full text. */
export function figureProps(fig: Figure | null): { className?: string; style?: CSSProperties; title?: string } {
  if (!fig) return {};
  return { className: 'is-fig', style: { ['--chars' as string]: fig.chars } as CSSProperties, title: fig.text };
}
