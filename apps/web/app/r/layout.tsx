import type { ReactNode } from 'react';
import { ScopeMessages } from '@/lib/i18n/scope';

/** Guest copy for this route group, on top of the root layout's base scope (lib/i18n/messages.ts, 21-PERF). */
export default function RGuestLayout({ children }: { children: ReactNode }) {
  return <ScopeMessages scope="guest">{children}</ScopeMessages>;
}
