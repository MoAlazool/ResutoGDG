'use client';
import { ProfileButton, initialOf, type MenuItem } from '@resuto/ui';
import { LazyMenu as Menu } from './LazyMenu';
import { useT } from '@/lib/i18n/client';

export interface AccountMenuProps {
  /** The signed-in member's name (or email). */
  name: string;
  /** Localised role name. */
  roleLabel: string;
  /** The restaurant's guest page (the public site or the ordering page). */
  guestHref: string;
  guestLabel: string;
  /** The setup guide, for members who manage the restaurant. */
  setupHref?: string | null;
  /** Other restaurants the member belongs to. */
  restaurants?: Array<{ orgId: string; orgName: string }>;
  onNavigate(href: string): void;
  onLanguage(): void;
  onSignOut(): void;
  collapsed?: boolean;
}

/**
 * Account menu (21-SHELL): replaces the profile row that signed out on a click. Account security, language, the
 * guest site, the setup guide, other restaurants, and sign out as an explicit, separate choice.
 */
export function AccountMenu({ name, roleLabel, guestHref, guestLabel, setupHref, restaurants = [], onNavigate, onLanguage, onSignOut, collapsed }: AccountMenuProps) {
  const { t } = useT();
  const items: MenuItem[] = [
    { key: 'security', label: t('shell.accountSecurity'), onSelect: () => onNavigate('/account/security') },
    { key: 'language', label: <span lang={t('lang.switch') === 'English' ? 'en' : 'ar'}>{t('lang.switch')}</span>, text: t('lang.switch'), hint: t('shell.language'), onSelect: onLanguage },
    { key: 'guest', label: guestLabel, hint: <span aria-hidden="true" className="ws-out">↗</span>,
      onSelect: () => { window.open(guestHref, '_blank', 'noopener,noreferrer'); } },
    ...(setupHref ? [{ key: 'setup', label: t('nav.setupGuide'), onSelect: () => onNavigate(setupHref) }] : []),
    ...restaurants.map((r) => ({ key: `org-${r.orgId}`, label: <bdi>{t('shell.switchRestaurant', { name: r.orgName })}</bdi>, text: r.orgName,
      onSelect: () => onNavigate(`/dashboard/${r.orgId}`) })),
    { key: 'signout', label: t('shell.signOutAction'), tone: 'danger' as const, onSelect: onSignOut },
  ];
  return (
    <Menu label={t('shell.account')} items={items} placement="top" className="ws-account"
      trigger={<ProfileButton initial={initialOf(name)} name={<bdi>{name}</bdi>} detail={roleLabel}
        aria-label={`${t('shell.account')}: ${name}`} data-collapsed={collapsed || undefined} />} />
  );
}
