'use client';
import type { ReactNode } from 'react';
import { Header, type PageHeaderProps } from './header';

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
