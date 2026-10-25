'use client';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { PLATFORM_ROLE_CAPABILITIES, type PlatformRole } from '@resuto/contracts';
import { ErrorState, ProfileButton, RestaurantChip, SkeletonBlock, Topbar, Wordmark, initialOf, type MenuItem } from '@resuto/ui';
import { LazyMenu as Menu } from '@/components/shell/LazyMenu';
import { UiIcon } from '@/components/shell/shell-icons';
import { ApiRequestError } from '@/lib/api';
import { LanguageToggle, setLocale, useT } from '@/lib/i18n/client';
import { useSession } from '@/lib/session';
import { AdminIcon } from './admin-icons';
import { ADMIN_NAV, activeAdminNav, roleLabel } from './console';
import { ADMIN_STRINGS, fill, type AdminStrings } from './strings';
import '@/components/shell/shell.css';
import './admin.css';

type Cap = (typeof PLATFORM_ROLE_CAPABILITIES)['superadmin'][number];
interface AdminValue { role: PlatformRole; can(cap: Cap): boolean; s: AdminStrings }
const AdminContext = createContext<AdminValue | null>(null);
export function useAdmin() {
  const v = useContext(AdminContext);
  if (!v) throw new Error('useAdmin outside the admin console');
  return v;
}

/** Sidebar collapsed to icons: the same device preference as the staff shell (components/shell/DashboardShell.tsx). */
const COLLAPSED_KEY = 'resuto.ui.sidebar-collapsed';
const readCollapsed = () => { try { return localStorage.getItem(COLLAPSED_KEY) === '1'; } catch { return false; } };
const writeCollapsed = (v: boolean) => { try { localStorage.setItem(COLLAPSED_KEY, v ? '1' : '0'); } catch { /* storage blocked */ } };

type Gate = { state: 'checking' } | { state: 'ok'; role: PlatformRole } | { state: 'denied' } | { state: 'failed'; error: ApiRequestError };

/**
 * Operator console shell (21-ADMIN): the staff shell's conventions (sidebar with icons, collapsible; account menu;
 * EN/AR; skip link; a bottom tab bar on phones) for Resuto's platform staff. The API enforces every role check; the
 * console only hides what a role cannot do. A signed-in member without a platform role (403/404 from /admin/me) is
 * told so; any other failure to check is an error with Retry, not a refusal.
 */
export function AdminShell({ children }: { children: ReactNode }) {
  const { locale, t } = useT();
  const s = ADMIN_STRINGS[locale];
  const session = useSession();
  const router = useRouter();
  const pathname = usePathname();
  const [gate, setGate] = useState<Gate>({ state: 'checking' });
  const [collapsed, setCollapsed] = useState(false);
  useEffect(() => { setCollapsed(readCollapsed()); }, []);
  const toggleCollapsed = () => setCollapsed((c) => { writeCollapsed(!c); return !c; });

  const check = useCallback(async () => {
    setGate({ state: 'checking' });
    try {
      const r = await session.call<{ role: PlatformRole }>('/admin/me');
      setGate({ state: 'ok', role: r.role });
    } catch (e) {
      const err = e instanceof ApiRequestError ? e : new ApiRequestError(0, 'unexpected', (e as Error)?.message ?? String(e));
      if (err.kind === 'unauthorized' || err.kind === 'aborted') return; // the session sends signed-out visitors to /login
      setGate(err.kind === 'forbidden' || err.kind === 'not_found' ? { state: 'denied' } : { state: 'failed', error: err });
    }
  }, [session.call]);
  useEffect(() => {
    if (!session.ready || !session.token) return; // signed-out visitors are sent to /login by the session
    void check();
  }, [session.ready, session.token, check]);

  const signOut = useCallback(async () => { await session.signOut(); router.push('/login'); }, [session, router]);

  if (gate.state === 'denied') {
    return (
      <main className="ws-solo" id="workspace-main">
        <div className="ws-solo-card admin-denied">
          <Wordmark label={t('app.name')} />
          <h1>{s.onlyAdmins}</h1>
          <p className="fine">{s.deniedBody}</p>
          <div className="row">
            <Link className="btn btn-primary" href="/">{s.backToApp}</Link>
            <button type="button" className="btn btn-ghost" onClick={() => void signOut()}>{t('shell.signOutAction')}</button>
          </div>
        </div>
      </main>
    );
  }

  const role = gate.state === 'ok' ? gate.role : null;
  const active = activeAdminNav(pathname);
  const me = session.me;
  const name = me?.user.fullName || me?.user.email || s.console;
  const account: MenuItem[] = [
    { key: 'security', label: t('shell.accountSecurity'), onSelect: () => router.push('/account/security') },
    { key: 'language', label: <span lang={locale === 'ar' ? 'en' : 'ar'}>{t('lang.switch')}</span>, text: t('lang.switch'), hint: t('shell.language'),
      onSelect: () => setLocale(locale === 'ar' ? 'en' : 'ar') },
    { key: 'app', label: s.openApp, onSelect: () => router.push('/dashboard') },
    { key: 'signout', label: t('shell.signOutAction'), tone: 'danger', onSelect: () => void signOut() },
  ];
  const roleText = role ? fill(s.role, { role: roleLabel(s, role) }) : undefined;

  let body: ReactNode;
  if (gate.state === 'failed') {
    body = (
      <div className="admin-gate" role="alert">
        <h1 className="sr-only">{s.meFailed}</h1>
        <ErrorState locale={locale} error={{ status: gate.error.status, code: gate.error.code, message: gate.error.message, requestId: gate.error.requestId }}
          onRetry={check} />
      </div>
    );
  } else if (!role) {
    body = (
      <div className="admin-gate" aria-busy="true">
        <SkeletonBlock width="40%" height={28} />
        <SkeletonBlock width="70%" height={14} />
        <SkeletonBlock height={220} radius={10} />
      </div>
    );
  } else {
    body = children;
  }

  return (
    <AdminContext.Provider value={role ? { role, can: (cap) => PLATFORM_ROLE_CAPABILITIES[role].includes(cap), s } : null}>
      <div className="ws admin-ws" data-collapsed={collapsed || undefined}>
        <a className="skip-link" href="#workspace-main">{t('shell.skip')}</a>
        <aside className="ws-sidebar" aria-label={s.console}>
          <div className="ws-sidebar-head">
            <div className="ws-brand-row">
              <Link href="/admin" className="ws-brand" aria-label={s.console}><Wordmark label={s.console} size={collapsed ? 'sm' : 'md'} /></Link>
              <button type="button" className="ws-icon-btn ws-collapse" onClick={toggleCollapsed} aria-pressed={collapsed}
                aria-label={collapsed ? t('shell.expand') : t('shell.collapse')} title={collapsed ? t('shell.expand') : t('shell.collapse')}>
                <UiIcon name={collapsed ? 'expand' : 'collapse'} />
              </button>
            </div>
            <RestaurantChip name={s.operatorConsole} initial="R" branch={roleText} busy={!role} />
          </div>
          <nav className="ws-nav admin-nav" aria-label={s.console}>
            {ADMIN_NAV.map((n) => (
              <Link key={n.key} href={n.href} className="ws-nav-link admin-nav-link" aria-current={active === n.key ? 'page' : undefined}
                aria-label={collapsed ? s[n.key] : undefined} title={collapsed ? s[n.key] : undefined}>
                <AdminIcon name={n.key} /><span className="ws-nav-text">{s[n.key]}</span>
              </Link>
            ))}
          </nav>
          <div className="ws-sidebar-bottom">
            <Menu label={t('shell.account')} items={account} placement="top" className="ws-account"
              trigger={<ProfileButton initial={initialOf(name)} name={<bdi>{name}</bdi>} detail={roleText ?? s.console}
                aria-label={`${t('shell.account')}: ${name}`} data-collapsed={collapsed || undefined} />} />
          </div>
        </aside>
        <div className="ws-main">
          <Topbar title={s.console}>
            <LanguageToggle className="ws-lang-btn" label={t('lang.short')} />
            <span className="admin-phone-account">
              <Menu label={t('shell.account')} items={account} placement="bottom" align="end" className="ws-account"
                trigger={<button type="button" className="ws-avatar admin-avatar-btn" aria-label={`${t('shell.account')}: ${name}`}>{initialOf(name)}</button>} />
            </span>
          </Topbar>
          <main className="ws-page" id="workspace-main" tabIndex={-1}>{body}</main>
        </div>
        <nav className="ws-tabbar" aria-label={t('shell.mobileNav')}>
          {ADMIN_NAV.map((n) => (
            <Link key={n.key} href={n.href} className="ws-tab" aria-current={active === n.key ? 'page' : undefined}>
              <AdminIcon name={n.key} size={20} />
              <span className="ws-tab-text">{s[n.key]}</span>
            </Link>
          ))}
        </nav>
      </div>
    </AdminContext.Provider>
  );
}
