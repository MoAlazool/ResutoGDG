'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import { SettingsPage, type PageHeaderProps } from '@resuto/ui';
import { useT } from '@/lib/i18n/client';
import { navVisible } from '@/lib/nav';
import { useOrg } from '@/lib/org-context';
import { activeSection, SETTINGS_SECTIONS } from '@/lib/sections';

/**
 * The Settings cluster on the SettingsPage template (21-MONEY): restaurant settings, messaging, team & roles, plan &
 * billing, data import/export and the activity log share one section list at the reading start. Sections the role
 * cannot open, or whose module the plan lacks, are left out; links navigate client-side.
 */
export function SettingsShell({ header, children }: { header: PageHeaderProps; children: ReactNode }) {
  const { t } = useT();
  const { org, hasModule } = useOrg();
  const pathname = usePathname();
  const base = `/dashboard/${org.id}`;
  const path = pathname.startsWith(base) ? pathname.slice(base.length) : pathname;
  const shown = SETTINGS_SECTIONS.filter((s) => navVisible(s, org.role) && (!s.module || hasModule(s.module)));
  const active = activeSection(SETTINGS_SECTIONS, path)?.href ?? '';
  return (
    <SettingsPage header={header} navLabel={t('nav.settingsSections')} active={active}
      sections={shown.map((s) => ({ key: s.href, label: t(s.label), href: `${base}${s.href}` }))}
      renderLink={(href, label, current) => <Link href={href} aria-current={current}>{label}</Link>}>
      {children}
    </SettingsPage>
  );
}
