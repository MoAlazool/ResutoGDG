'use client';
import type { ReactNode } from 'react';
import { PageHeading } from './primitives';

// Page templates (plan §4 "Layout"). They own the page's regions and spacing only; content, data and state stay in
// the page. Breakpoints: phone < 700 px, tablet 700-1100 px, desktop > 1100 px. Inspectors sit at the reading end.

export interface PageHeaderProps { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode; eyebrow?: ReactNode }
const Header = ({ header }: { header?: PageHeaderProps | ReactNode }) => {
  if (!header) return null;
  if (typeof header === 'object' && header !== null && 'title' in (header as object)) {
    const h = header as PageHeaderProps;
    return <PageHeading title={h.title} subtitle={h.subtitle} actions={h.actions} eyebrow={h.eyebrow} />;
  }
  return <>{header}</>;
};

/** Header, filter bar, then the list (usually DataTableV2) and its pagination. */
export function ListPage({ header, filters, children, footer }: { header?: PageHeaderProps | ReactNode; filters?: ReactNode; children: ReactNode; footer?: ReactNode }) {
  return (
    <div className="rui-page rui-list-page">
      <Header header={header} />
      {filters && <div className="rui-page-filters">{filters}</div>}
      <div className="rui-page-main">{children}</div>
      {footer && <div className="rui-page-footer">{footer}</div>}
    </div>
  );
}

/** Header, a main column and a side inspector at the reading end (below the main column on tablets and phones). */
export function DetailPage({ header, children, inspector, inspectorLabel }: { header?: PageHeaderProps | ReactNode; children: ReactNode; inspector?: ReactNode; inspectorLabel?: string }) {
  return (
    <div className="rui-page rui-detail-page">
      <Header header={header} />
      <div className="rui-detail-grid" data-has-inspector={inspector ? '' : undefined}>
        <div className="rui-detail-main">{children}</div>
        {inspector && <aside className="rui-detail-inspector" aria-label={inspectorLabel}>{inspector}</aside>}
      </div>
    </div>
  );
}

/**
 * Three panes at full height (Inbox, Studio, Customers): a navigator at the reading start, the centre, an inspector
 * at the reading end; each pane scrolls on its own. An optional toolbar spans the top. On tablets the inspector moves
 * under the centre; on phones the panes stack.
 */
export function WorkspacePage({ start, children, end, toolbar, labels }: {
  start?: ReactNode; children: ReactNode; end?: ReactNode; toolbar?: ReactNode;
  labels?: { start?: string; main?: string; end?: string; toolbar?: string };
}) {
  return (
    <div className="rui-workspace" data-start={start ? '' : undefined} data-end={end ? '' : undefined}>
      {toolbar && <div className="rui-workspace-toolbar" role="toolbar" aria-label={labels?.toolbar}>{toolbar}</div>}
      {start && <nav className="rui-workspace-pane rui-workspace-start" aria-label={labels?.start}>{start}</nav>}
      <section className="rui-workspace-pane rui-workspace-main" aria-label={labels?.main}>{children}</section>
      {end && <aside className="rui-workspace-pane rui-workspace-end" aria-label={labels?.end}>{end}</aside>}
    </div>
  );
}

export interface BoardLane { key: string; title: ReactNode; count?: ReactNode; tone?: 'ok' | 'warn' | 'danger' | 'info'; children: ReactNode; label?: string }

/** Lanes side by side (kitchen tickets, order stages, a pipeline); they scroll sideways and snap on phones. */
export function BoardPage({ header, lanes, toolbar }: { header?: PageHeaderProps | ReactNode; lanes: BoardLane[]; toolbar?: ReactNode }) {
  return (
    <div className="rui-page rui-board-page">
      <Header header={header} />
      {toolbar && <div className="rui-page-filters">{toolbar}</div>}
      <div className="rui-board" data-lanes={lanes.length}>
        {lanes.map((l) => (
          <section key={l.key} className="rui-lane" data-tone={l.tone} aria-label={l.label}>
            <header className="rui-lane-head"><h2>{l.title}</h2>{l.count !== undefined && <span className="rui-lane-count num">{l.count}</span>}</header>
            <div className="rui-lane-body">{l.children}</div>
          </section>
        ))}
      </div>
    </div>
  );
}

export interface SettingsSection { key: string; label: ReactNode; href?: string; description?: ReactNode }

/**
 * Section navigation and forms. Sections are links (`href`, e.g. ?tab= or a route) or buttons (`onSelect`); the
 * active one is marked aria-current. The list sits at the reading start and becomes a scrolling row on phones.
 */
export function SettingsPage({ header, sections, active, onSelect, children, navLabel }: {
  header?: PageHeaderProps | ReactNode; sections: SettingsSection[]; active: string; onSelect?: (key: string) => void; children: ReactNode; navLabel: string;
}) {
  return (
    <div className="rui-page rui-settings-page">
      <Header header={header} />
      <div className="rui-settings-grid">
        <nav className="rui-settings-nav" aria-label={navLabel}>
          <ul>
            {sections.map((s) => (
              <li key={s.key}>
                {s.href
                  ? <a href={s.href} aria-current={s.key === active ? 'page' : undefined} onClick={onSelect ? () => onSelect(s.key) : undefined}>{s.label}</a>
                  : <button type="button" aria-current={s.key === active ? 'true' : undefined} onClick={() => onSelect?.(s.key)}>{s.label}</button>}
              </li>
            ))}
          </ul>
        </nav>
        <div className="rui-settings-body">{children}</div>
      </div>
    </div>
  );
}
