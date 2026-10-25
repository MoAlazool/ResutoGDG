import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { StaffProviders } from '@/components/shell/StaffProviders';
import { getLocale } from '@/lib/i18n/server';
import { AdminShell } from './AdminShell';
import { ADMIN_STRINGS } from './strings';

export const metadata: Metadata = { title: 'Admin', robots: { index: false, follow: false } };

/**
 * Operator console (21-ADMIN): the admin message scope (the shell's and the operations copy, not every module's) and
 * the console's own strings in the page language, rendered on the server so the client bundle carries no dictionary.
 */
export default async function AdminLayout({ children }: { children: ReactNode }) {
  const locale = await getLocale();
  return <StaffProviders scope="admin"><AdminShell strings={ADMIN_STRINGS[locale]}>{children}</AdminShell></StaffProviders>;
}
