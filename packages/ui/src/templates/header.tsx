'use client';
import type { ReactNode } from 'react';
import { PageHeading } from '../primitives';

export interface PageHeaderProps { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode; eyebrow?: ReactNode }
export const Header = ({ header }: { header?: PageHeaderProps | ReactNode }) => {
  if (!header) return null;
  if (typeof header === 'object' && header !== null && 'title' in (header as object)) {
    const h = header as PageHeaderProps;
    return <PageHeading title={h.title} subtitle={h.subtitle} actions={h.actions} eyebrow={h.eyebrow} />;
  }
  return <>{header}</>;
};
