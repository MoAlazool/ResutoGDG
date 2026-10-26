'use client';
import type { ReactNode } from 'react';
import { Header, type PageHeaderProps } from './header';

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
