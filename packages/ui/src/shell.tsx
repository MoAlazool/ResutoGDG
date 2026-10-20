'use client';
import type { ButtonHTMLAttributes, ReactNode } from 'react';

// Staff workspace chrome, restored from the original Resuto manager workspace (legacy/public/app.js `shell()`,
// legacy/public/style.css): white 250px sidebar with the CSS wordmark, restaurant chip, glyph navigation with count
// badges, a 70px topbar (live status + date), the footer line and the profile/sign-out row. Styles live in
// apps/web/app/globals.css (`.ws-*`) on the tokens from tokens.css. Components here are presentational: routing,
// data and permissions stay in the app (components/shell/DashboardShell.tsx).

/**
 * The Resuto wordmark: italic "r" tile, "resuto" and the lime period. It is Latin in both languages and is laid
 * out left-to-right even in Arabic pages, so the period always follows the word (the legacy RTL page put it on the
 * wrong side).
 */
export function Wordmark({ size = 'md', tone = 'ink', label = 'Resuto' }: { size?: 'sm' | 'md' | 'lg'; tone?: 'ink' | 'light'; label?: string }) {
  return (
    <span className="ws-wordmark" data-size={size} data-tone={tone} dir="ltr" role="img" aria-label={label}>
      <span className="ws-wordmark-mark" aria-hidden="true">r</span>
      <span aria-hidden="true">resuto</span>
      <span className="ws-wordmark-period" aria-hidden="true">.</span>
    </span>
  );
}

/**
 * Monochrome navigation glyphs (rendered in currentColor). Legacy modules keep their original glyph; newer modules
 * use glyphs from the same geometric family. U+FE0E forces text (not emoji) presentation where a code point has an
 * emoji form.
 */
export const NAV_GLYPHS = {
  overview: '◈', frontdesk: '⌘', orders: '▥', kitchen: '▩', floor: '▦', reservations: '▤', visits: '◉', menu: '☷',
  inventory: '▧', delivery: '⇢', customers: '♙', inbox: '✉︎', marketing: '◎', website: '⊕', payments: '◉',
  finance: '∑', compliance: '⚖︎', analytics: '↗', intelligence: '✦', mcp: '⋈', settings: '⚙︎',
  team: '♗', integrations: '⇄', billing: '◇', audit: '☰', branches: '⌂', data: '⇅', setup: '✦', guest: '↗',
  admin: '⌂', tenants: '▤', prices: '◇', operations: '◉', lock: '⊘',
} as const;
export type NavGlyphName = keyof typeof NAV_GLYPHS;

export function NavGlyph({ name }: { name: NavGlyphName }) {
  return <span className="ws-glyph" aria-hidden="true">{NAV_GLYPHS[name]}</span>;
}

/** Small count chip on a navigation item (e.g. open orders). Hidden when the count is 0 or unknown. */
export function NavBadge({ count, label, max = 99 }: { count: number | null | undefined; label?: string; max?: number }) {
  if (!count || count < 0) return null;
  return <b className="ws-badge" aria-label={label}>{count > max ? `${max}+` : count}</b>;
}

/** First letter of a name for a round initial tile (restaurant chip, avatar); Latin and Arabic alike. */
export const initialOf = (name: string | null | undefined, fallback = '·') => {
  const ch = [...(name ?? '').trim()][0];
  return ch ? ch.toLocaleUpperCase() : fallback;
};

/**
 * Restaurant identity chip: initial tile, name and branch. `children` renders a switcher (e.g. a disclosure menu)
 * over the chip when given. `initial` defaults to the first letter of a string `name`.
 */
export function RestaurantChip({ name, initial, branch, children, busy }: { name: ReactNode; initial?: string; branch?: ReactNode; children?: ReactNode; busy?: boolean }) {
  return (
    <div className="ws-chip" aria-busy={busy || undefined} data-switch={children ? '' : undefined}>
      <span className="ws-chip-icon" aria-hidden="true">{initial ?? (typeof name === 'string' ? initialOf(name) : '·')}</span>
      <span className="ws-chip-text">
        <strong>{name}</strong>
        {branch && <small>{branch}</small>}
      </span>
      {children}
    </div>
  );
}

/** "Service workspace" + "Live updates / Reconnecting…" + date, as in the legacy 70px topbar. */
export function Topbar({ title, status, date, children }: { title: ReactNode; status?: ReactNode; date?: ReactNode; children?: ReactNode }) {
  return (
    <header className="ws-topbar">
      <span className="ws-topbar-title"><span className="ws-live-dot" aria-hidden="true" />{title}</span>
      <div className="ws-topbar-end">
        {children}
        {status}
        {date && <span className="ws-date">{date}</span>}
      </div>
    </header>
  );
}

export type LiveState = 'live' | 'reconnecting' | 'offline';
/** Connection status line for the topbar; announced politely when it changes. */
export function LiveStatus({ state, labels }: { state: LiveState; labels: Record<LiveState, ReactNode> }) {
  return <span className="ws-sync" data-state={state} role="status" aria-live="polite">{labels[state]}</span>;
}

/** Footer line: brand + promise on the start side, payments mode and currency on the end side. */
export function WorkspaceFooter({ brand, promise, mode }: { brand: ReactNode; promise: ReactNode; mode?: ReactNode }) {
  return (
    <footer className="ws-footer">
      <span className="ws-footer-brand">{brand}</span>
      <span className="ws-footer-promise">{promise}</span>
      {mode && <span className="ws-footer-mode">{mode}</span>}
    </footer>
  );
}

/** Profile row at the bottom of the sidebar; the whole row is the sign-out button, as in the legacy workspace. */
export function ProfileButton({ name, detail, initial, ...button }: { name: ReactNode; detail: ReactNode; initial: string } & Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'name'>) {
  return (
    <button type="button" className="ws-profile" {...button}>
      <span className="ws-avatar" aria-hidden="true">{initial}</span>
      <span className="ws-profile-text"><strong>{name}</strong><small>{detail}</small></span>
    </button>
  );
}

/** Thin progress bar shown at the top of the workspace while a route transition is pending. */
export function RouteProgress({ active }: { active: boolean }) {
  return <div className="ws-progress" data-active={active || undefined} role="progressbar" aria-hidden={!active} aria-busy={active} />;
}
