'use client';
import type { ReactNode, Ref } from 'react';
import { Header, type PageHeaderProps } from './header';

export interface BoardLane { key: string; title: ReactNode; count?: ReactNode; tone?: 'ok' | 'warn' | 'danger' | 'info'; children: ReactNode; label?: string }

/**
 * Lanes side by side (kitchen tickets, order stages, a pipeline); they scroll sideways and snap on phones. Each lane
 * carries `data-lane` (its key), so a board can add drag and drop on top. `boardRef` and `label` reach the lane
 * container; `footer` sits under the lanes; `className` is added to the page root.
 */
export function BoardPage({ header, lanes, toolbar, footer, label, boardRef, className }: {
  header?: PageHeaderProps | ReactNode; lanes: BoardLane[]; toolbar?: ReactNode; footer?: ReactNode; label?: string;
  boardRef?: Ref<HTMLDivElement>; className?: string;
}) {
  return (
    <div className={['rui-page rui-board-page', className].filter(Boolean).join(' ')}>
      <Header header={header} />
      {toolbar && <div className="rui-page-filters">{toolbar}</div>}
      <div className="rui-board" data-lanes={lanes.length} ref={boardRef} role={label ? 'group' : undefined} aria-label={label}>
        {lanes.map((l) => (
          <section key={l.key} className="rui-lane" data-lane={l.key} data-tone={l.tone} aria-label={l.label}>
            <header className="rui-lane-head"><h2>{l.title}</h2>{l.count !== undefined && <span className="rui-lane-count num">{l.count}</span>}</header>
            <div className="rui-lane-body">{l.children}</div>
          </section>
        ))}
      </div>
      {footer && <div className="rui-page-footer">{footer}</div>}
    </div>
  );
}
