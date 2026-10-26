import type { ReactNode } from 'react';
import { RouteMessages } from '@/lib/i18n/scope';

/** The module's own copy on top of the dashboard shell's (lib/i18n/route-families.ts, 21-PERF). */
export default function NotificationsLayout({ children }: { children: ReactNode }) {
  return <RouteMessages route="dashboard/notifications">{children}</RouteMessages>;
}
