'use client';
import Link from 'next/link';
import { Sheet } from '@resuto/ui';
import { useT } from '@/lib/i18n/client';
import type { NavArea } from '@/lib/nav';
import { ShellIcon } from './shell-icons';
import { SidebarNav } from './SidebarNav';

/**
 * The phone drawer (21-SHELL): the full navigation in a Sheet that slides in from the reading end, with the Settings
 * cluster, Explore and the account actions. Loaded the first time "More" is opened.
 */
export default function MobileDrawer({ open, onClose, areas, settings, base, pathname, search, explore, openOrders, guest, setupHref, onNavigate, onLanguage, onSignOut }: {
  open: boolean; onClose(): void; areas: NavArea[]; settings: NavArea | null; base: string; pathname: string; search?: string; explore: boolean;
  openOrders: number | null; guest: { href: string; label: string }; setupHref: string | null;
  onNavigate(href: string): void; onLanguage(): void; onSignOut(): void;
}) {
  const { t } = useT();
  // The account menu's choices (the sidebar footer is hidden on phones).
  const account: Array<{ key: string; label: string; onSelect(): void; tone?: 'danger' }> = [
    { key: 'security', label: t('shell.accountSecurity'), onSelect: () => onNavigate('/account/security') },
    { key: 'language', label: t('lang.switch'), onSelect: onLanguage },
    { key: 'guest', label: guest.label, onSelect: () => { window.open(guest.href, '_blank', 'noopener,noreferrer'); } },
    ...(setupHref ? [{ key: 'setup', label: t('nav.setupGuide'), onSelect: () => onNavigate(setupHref) }] : []),
    { key: 'signout', label: t('shell.signOutAction'), tone: 'danger' as const, onSelect: onSignOut },
  ];
  return (
    <Sheet open={open} onClose={onClose} side="end" size="sm" title={t('shell.menu')} labels={{ close: t('action.close') }} className="ws-drawer">
      <SidebarNav areas={settings ? [...areas, settings] : areas} base={base} pathname={pathname} search={search} openOrders={openOrders} label={t('shell.nav')} onNavigate={onClose} />
      {explore && (
        <Link className="ws-area-btn ws-explore" href={`${base}/explore`} onClick={onClose}>
          <ShellIcon name="explore" /><span className="ws-nav-text">{t('nav.explore')}</span>
        </Link>
      )}
      <ul className="ws-drawer-account" aria-label={t('shell.account')}>
        {account.map((a) => (
          <li key={a.key}><button type="button" className="ws-nav-link" data-tone={a.tone} onClick={() => { onClose(); a.onSelect(); }}>{a.label}</button></li>
        ))}
      </ul>
    </Sheet>
  );
}
