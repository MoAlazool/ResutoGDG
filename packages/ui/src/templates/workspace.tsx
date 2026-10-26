'use client';
import type { ReactNode } from 'react';

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
