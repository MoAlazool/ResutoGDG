import type { ReactNode } from 'react';
import { StaffProviders } from '@/components/shell/StaffProviders';

/** An invitation can be opened signed out: the page offers sign-in/sign-up with ?next= back to it. */
export default function InviteLayout({ children }: { children: ReactNode }) {
  return <StaffProviders requireAuth={false}>{children}</StaffProviders>;
}
