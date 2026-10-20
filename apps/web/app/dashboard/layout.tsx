import type { ReactNode } from 'react';
import { StaffProviders } from '@/components/shell/StaffProviders';

export default function DashboardRootLayout({ children }: { children: ReactNode }) {
  return <StaffProviders>{children}</StaffProviders>;
}
