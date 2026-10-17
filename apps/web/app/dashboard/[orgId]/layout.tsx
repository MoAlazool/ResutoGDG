import type { ReactNode } from 'react';
import { DashboardShell } from '@/components/shell/DashboardShell';

export default async function DashboardLayout({ children, params }: { children: ReactNode; params: Promise<{ orgId: string }> }) {
  const { orgId } = await params;
  return <DashboardShell orgId={orgId}>{children}</DashboardShell>;
}
