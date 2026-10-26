'use client';
import type { ReactNode } from 'react';
import { Header, type PageHeaderProps } from './header';

export interface SettingsSection { key: string; label: ReactNode; href?: string; description?: ReactNode }

/**
 * Section navigation and forms. Sections are links (`href`, e.g. ?tab= or a route) or buttons (`onSelect`); the
 * active one is marked aria-current. The list sits at the reading start and becomes a scrolling row on phones.
 * `renderLink` renders the section links (e.g. with next/link for client-side navigation); it receives the href, the
 * label and the aria-current value to put on the link.
 */
export function SettingsPage({ header, sections, active, onSelect, children, navLabel, renderLink }: {
  header?: PageHeaderProps | ReactNode; sections: SettingsSection[]; active: string; onSelect?: (key: string) => void; children: ReactNode; navLabel: string;
  renderLink?: (href: string, children: ReactNode, current: 'page' | undefined) => ReactNode;
}) {
  return (
    <div className="rui-page rui-settings-page">
      <Header header={header} />
      <div className="rui-settings-grid">
        <nav className="rui-settings-nav" aria-label={navLabel}>
          <ul>
            {sections.map((s) => (
              <li key={s.key}>
                {s.href && renderLink
                  ? renderLink(s.href, s.label, s.key === active ? 'page' : undefined)
                  : s.href
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
