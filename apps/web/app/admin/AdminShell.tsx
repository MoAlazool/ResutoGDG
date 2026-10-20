'use client';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { PLATFORM_ROLE_CAPABILITIES, type PlatformRole } from '@resuto/contracts';
import { NavGlyph, Notice, ProfileButton, RestaurantChip, Skeleton, Wordmark, initialOf, type NavGlyphName } from '@resuto/ui';
import { LanguageToggle, useT } from '@/lib/i18n/client';
import { useSession } from '@/lib/session';
import { ADMIN_STRINGS, type AdminStrings } from './strings';

type Cap = (typeof PLATFORM_ROLE_CAPABILITIES)['superadmin'][number];
interface AdminValue { role: PlatformRole; can(cap: Cap): boolean; s: AdminStrings }
const AdminContext = createContext<AdminValue | null>(null);
export function useAdmin() {
  const v = useContext(AdminContext);
  if (!v) throw new Error('useAdmin outside the admin console');
  return v;
}

/** Platform admin console shell. The API enforces every role check; the UI only hides what a role cannot do. */
export function AdminShell({ children }: { children: ReactNode }) {
  const { locale, t } = useT();
  const s = ADMIN_STRINGS[locale];
  const session = useSession();
  const router = useRouter();
  const pathname = usePathname();
  const [role, setRole] = useState<PlatformRole | null>(null);
  const [denied, setDenied] = useState(false);

  useEffect(() => {
    if (!session.ready || !session.token) return; // signed-out visitors are sent to /login by the session
    session.call<{ role: PlatformRole }>('/admin/me').then((r) => setRole(r.role)).catch(() => setDenied(true));
  }, [session.ready, session.token, session.call]);

  if (denied) {
    return <main className="ws-solo"><div className="ws-solo-card"><Notice tone="danger">{s.onlyAdmins}</Notice><p style={{ marginTop: 16 }}><Link href="/">{s.backToApp}</Link></p></div></main>;
  }

  const nav: Array<{ href: string; label: string; glyph: NavGlyphName }> = [
    { href: '/admin', label: s.tenants, glyph: 'tenants' }, { href: '/admin/prices', label: s.prices, glyph: 'prices' }, { href: '/admin/operations', label: s.operations, glyph: 'operations' },
  ];
  const me = session.me;
  return (
    <AdminContext.Provider value={role ? { role, can: (cap) => PLATFORM_ROLE_CAPABILITIES[role].includes(cap), s } : null}>
      <div className="ws">
        <aside className="ws-sidebar" aria-label={s.console}>
          <div className="ws-sidebar-head">
            <Link href="/admin" className="ws-brand" aria-label={s.console}><Wordmark label={s.console} /></Link>
            <RestaurantChip name={s.console} branch={role ? s.role.replace('{role}', role) : undefined} busy={!role} />
          </div>
          <nav className="ws-nav" aria-label={s.console}>
            {nav.map((n) => {
              const active = n.href === '/admin' ? pathname === '/admin' || pathname.startsWith('/admin/tenants') : pathname.startsWith(n.href);
              return <Link key={n.href} href={n.href} className="ws-nav-link" aria-current={active ? 'page' : undefined}><NavGlyph name={n.glyph} /><span className="ws-nav-text">{n.label}</span></Link>;
            })}
          </nav>
          <div className="ws-sidebar-bottom">
            <ProfileButton initial={initialOf(me?.user.fullName || me?.user.email || 'A')} name={<bdi>{me?.user.fullName || me?.user.email || s.console}</bdi>}
              detail={t('shell.signOut')} onClick={async () => { await session.signOut(); router.push('/login'); }} />
          </div>
        </aside>
        <div className="ws-main">
          <header className="ws-topbar"><span className="ws-topbar-title"><span className="ws-live-dot" aria-hidden="true" />{s.console}</span></header>
          <main className="ws-page" id="workspace-main">{role ? children : <div style={{ width: 'min(420px, 100%)' }}><Skeleton lines={4} /></div>}</main>
        </div>
        <LanguageToggle className="ws-lang" label={t('lang.short')} />
      </div>
    </AdminContext.Provider>
  );
}
