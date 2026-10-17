'use client';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { PLATFORM_ROLE_CAPABILITIES, type PlatformRole } from '@resuto/contracts';
import { Notice, Skeleton } from '@resuto/ui';
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
  const { locale } = useT();
  const s = ADMIN_STRINGS[locale];
  const session = useSession();
  const router = useRouter();
  const pathname = usePathname();
  const [role, setRole] = useState<PlatformRole | null>(null);
  const [denied, setDenied] = useState(false);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!session.ready) return;
    if (!session.token) { router.replace(`/login?next=${encodeURIComponent(pathname)}`); return; }
    session.call<{ role: PlatformRole }>('/admin/me').then((r) => setRole(r.role)).catch(() => setDenied(true));
  }, [session, router, pathname]);

  if (denied) {
    return <main className="center-page"><div className="auth-card"><Notice tone="danger">{s.onlyAdmins}</Notice><p style={{ marginTop: 16 }}><Link href="/">{s.backToApp}</Link></p></div></main>;
  }
  if (!role) return <main className="center-page"><div style={{ width: 320 }}><Skeleton lines={4} /></div></main>;

  const nav = [{ href: '/admin', label: s.tenants, icon: '▦' }, { href: '/admin/prices', label: s.prices, icon: '¤' }, { href: '/admin/operations', label: s.operations, icon: '⚙' }];
  return (
    <AdminContext.Provider value={{ role, can: (cap) => PLATFORM_ROLE_CAPABILITIES[role].includes(cap), s }}>
      <div className="app-shell">
        <aside className="sidebar" data-open={open} aria-label="Admin navigation">
          <Link href="/admin" className="brand"><img src="/brand/resuto-icon.png" alt="" /> {s.console}</Link>
          <div style={{ padding: '0 8px' }}><span className="badge badge-pay">{s.role.replace('{role}', role)}</span></div>
          <nav>
            {nav.map((n) => {
              const active = n.href === '/admin' ? pathname === '/admin' || pathname.startsWith('/admin/tenants') : pathname.startsWith(n.href);
              return <Link key={n.href} href={n.href} className="nav-link" aria-current={active ? 'page' : undefined} onClick={() => setOpen(false)}><span aria-hidden>{n.icon}</span> {n.label}</Link>;
            })}
          </nav>
          <div style={{ marginTop: 'auto', display: 'grid', gap: 8 }}>
            <LanguageToggle />
            <button className="btn btn-sm btn-ghost" style={{ color: '#dfe8e2' }} onClick={async () => { await session.signOut(); router.push('/login'); }}>{s.signOut}</button>
          </div>
        </aside>
        <div>
          <div className="topbar-mobile">
            <button className="btn btn-sm btn-ghost" style={{ color: '#fff' }} onClick={() => setOpen(!open)} aria-expanded={open} aria-label="Menu">☰</button>
            <strong>{s.console}</strong><span />
          </div>
          <main className="main">{children}</main>
        </div>
      </div>
    </AdminContext.Provider>
  );
}
