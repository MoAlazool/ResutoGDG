import type { ReactNode } from 'react';
import { StaffProviders } from '@/components/shell/StaffProviders';

export default function AuthLayout({ children }: { children: ReactNode }) {
  return <StaffProviders requireAuth={false}>{children}</StaffProviders>;
}
