import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { StaffProviders } from '@/components/shell/StaffProviders';
import { AdminShell } from './AdminShell';

export const metadata: Metadata = { title: 'Admin', robots: { index: false, follow: false } };

export default function AdminLayout({ children }: { children: ReactNode }) {
  return <StaffProviders><AdminShell>{children}</AdminShell></StaffProviders>;
}
