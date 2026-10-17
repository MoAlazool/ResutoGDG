'use client';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { can as roleCan, type EntitlementsView, type ModuleKey } from '@resuto/contracts';
import { Notice, Skeleton } from '@resuto/ui';
import { LanguageToggle, useT } from '@/lib/i18n/client';
import { NAV } from '@/lib/nav';
import { OrgProvider, type OrgInfo } from '@/lib/org-context';
import { useSession } from '@/lib/session';

export function DashboardShell({ orgId, children }: { orgId: string; children: ReactNode }) {
  const { t, locale } = useT();
  const session = useSession();
  const router = useRouter();
  const pathname = usePathname();
  const [org, setOrg] = useState<OrgInfo | null>(null);
  const [modules, setModules] = useState<Partial<Record<ModuleKey, boolean>> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      // Load the org and its entitlements together: the shell only renders once module gates are known,
      // so gated pages never mount (and call module APIs) before the upgrade prompt replaces them.
      const [o, ent] = await Promise.all([
        session.call<OrgInfo>(`/o/${orgId}`),
        session.call<EntitlementsView>(`/o/${orgId}/billing/entitlements`).catch(() => null),
      ]);
      setModules(ent ? Object.fromEntries(Object.entries(ent.modules).map(([k, v]) => [k, v.enabled])) : null);
      setOrg(o);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [orgId, session]);

  useEffect(() => {
    if (!session.ready) return;
    if (!session.token) { router.replace(`/login?next=${encodeURIComponent(pathname)}`); return; }
    void load();
  }, [session.ready, session.token, load, router, pathname]);

  if (error) return <main className="center-page"><Notice tone="danger">{error}</Notice></main>;
  if (!org) return <main className="center-page"><div style={{ width: 320 }}><Skeleton lines={4} /></div></main>;

  const base = `/dashboard/${orgId}`;
  return (
    <OrgProvider value={{ org, modules, reload: load }}>
      <div className="app-shell">
        <aside className="sidebar" data-open={open} aria-label="Main navigation">
          <Link href={base} className="brand"><img src="/brand/resuto-icon.png" alt="" /> {t('app.name')}</Link>
          {(session.me?.memberships.length ?? 0) > 1 ? (
            <select className="org-switch" value={orgId} onChange={(e) => router.push(`/dashboard/${e.target.value}`)} aria-label="Restaurant">
              {session.me!.memberships.map((m) => <option key={m.orgId} value={m.orgId}>{m.orgName}</option>)}
            </select>
          ) : <div style={{ padding: '0 8px', fontWeight: 650, color: '#fff' }}>{locale === 'ar' && org.nameAr ? org.nameAr : org.name}</div>}
          {NAV.map((group) => {
            const items = group.items.filter((i) => (i.anyPermission ? i.anyPermission.some((p) => roleCan(org.role, p)) : !i.permission || roleCan(org.role, i.permission)));
            if (!items.length) return null;
            return (
              <nav key={group.group}>
                <div className="nav-group">{t(group.group)}</div>
                {items.map((item) => {
                  const href = base + item.href;
                  const active = item.href === '' ? pathname === base : pathname.startsWith(href);
                  const locked = modules !== null && modules[item.module] === false;
                  return (
                    <Link key={item.href} href={href} className="nav-link" aria-current={active ? 'page' : undefined} onClick={() => setOpen(false)}>
                      <span aria-hidden>{item.icon}</span> {t(item.label)}
                      {locked && <span className="lock" title={t('state.locked')}>🔒</span>}
                    </Link>
                  );
                })}
              </nav>
            );
          })}
          <div style={{ marginTop: 'auto', display: 'grid', gap: 8 }}>
            <LanguageToggle />
            <button className="btn btn-sm btn-ghost" style={{ color: '#dfe8e2' }} onClick={async () => { await session.signOut(); router.push('/login'); }}>
              {t('action.signOut')}
            </button>
          </div>
        </aside>
        <div style={{ minWidth: 0 }}>
          <div className="topbar-mobile">
            <button className="btn btn-sm btn-ghost" style={{ color: '#fff' }} onClick={() => setOpen(!open)} aria-expanded={open} aria-label="Menu">☰</button>
            <strong>{org.name}</strong>
            <span />
          </div>
          <main className="main">{children}</main>
        </div>
      </div>
    </OrgProvider>
  );
}
