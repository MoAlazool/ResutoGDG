import type { ReactNode } from 'react';
import { StaffProviders } from '@/components/shell/StaffProviders';

/** Onboarding sends signed-out visitors to /signup itself, so no sign-in redirect here. */
export default function OnboardingLayout({ children }: { children: ReactNode }) {
  return <StaffProviders requireAuth={false} scope="auth">{children}</StaffProviders>;
}
