'use client';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { lazy, Suspense, useCallback, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react';
import type { EntitlementsView, ModuleKey } from '@resuto/contracts';
import { can as roleCan, dateTimeFormat } from '@resuto/contracts/lite';
import { Breadcrumb, LiveStatus, PageEyebrowProvider, RestaurantChip, Topbar, Wordmark, WorkspaceFooter } from '@resuto/ui';
import { connectionState, subscribeConnection } from '@/lib/connection';
import { pick } from '@/lib/pick';
import { LanguageToggle, setLocale, useT } from '@/lib/i18n/client';
import { ACTIVE_ORDER_STATUSES, lockedItems, visibleAreas } from '@/lib/nav';
import { OrgProvider, type OrgInfo } from '@/lib/org-context';
import { useSession } from '@/lib/session';
import {
  dropShellSnapshot, readAllBranches, readPreferredBranch, readShellSnapshot, withPreferredBranch, writeAllBranches, writePreferredBranch,
  writeShellSnapshot,
} from '@/lib/shell-snapshot';
import type { ShortcutCommand } from '@/lib/shortcuts';
import { GO_SHORTCUTS } from '@/lib/shortcuts';
import { useApi } from '@/lib/use-api';
import { AccountMenu } from './AccountMenu';
import { BranchSwitcher } from './BranchSwitcher';
import { MobileTabBar } from './MobileNav';
import { NotificationBell } from './NotificationBell';
import { ShellIcon, UiIcon } from './shell-icons';
import { ShortcutsProvider } from './ShortcutsProvider';
import { SidebarNav } from './SidebarNav';
import { BodySkeleton, NavSkeleton } from './Skeletons';
import './shell.css';

// Loaded on first use (they render only after a click or a key press, never on the server), so the staff routes'
// first-load JavaScript does not carry them (bundle budget, 21-SHELL).
const CommandPalette = lazy(() => import('./CommandPalette'));
const ShortcutsSheet = lazy(() => import('./CommandPalette').then((m) => ({ default: m.ShortcutsSheet })));
const MobileDrawer = lazy(() => import('./MobileDrawer'));
const ShellFailure = lazy(() => import('./ShellFailure'));

type Modules = Partial<Record<ModuleKey, boolean>> | null;
const toModules = (e: EntitlementsView): Modules => Object.fromEntries(Object.entries(e.modules).map(([k, v]) => [k, v.enabled]));
const MINUTE = 60_000;
/** Sidebar collapsed to icons (a device preference, not per user). */
const COLLAPSED_KEY = 'resuto.ui.sidebar-collapsed';
const readCollapsed = () => { try { return localStorage.getItem(COLLAPSED_KEY) === '1'; } catch { return false; } };
const writeCollapsed = (v: boolean) => { try { localStorage.setItem(COLLAPSED_KEY, v ? '1' : '0'); } catch { /* storage blocked */ } };

/** Re-renders every `ms` (topbar date in the restaurant's time zone). Null until mounted (no SSR clock mismatch). */
function useNow(ms: number) {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [ms]);
  return now;
}

const useConnection = () => useSyncExternalStore(subscribeConnection, connectionState, () => 'live' as const);

/**
 * Staff workspace shell (VS-02, VS-24, VS-07, PCL-05; 21-SHELL).
 *
 * Navigation: seven areas with their secondary lists and a Settings cluster (lib/nav.ts), collapsible to icons; a
 * bottom tab bar and a drawer on phones; the command palette (⌘K / Ctrl K) and `g` shortcuts; an account menu; one
 * branch context (the switcher in the restaurant chip; screens read it from lib/org-context).
 *
 * Data: the restaurant (GET /o/:id) and its entitlements load once per restaurant through the shared query cache
 * (5-minute stale time, refreshed on focus), in parallel with /me, not on every navigation. The chrome renders
 * first: from the last known restaurant (per-user snapshot) when there is one, otherwise with placeholders of the
 * same geometry. A failed refresh keeps the last good restaurant and shows a non-blocking notice with Retry; only a
 * first load that fails shows a full-page state, classified as offline / no access / not found / server error.
 */
export function DashboardShell({ orgId, children }: { orgId: string; children: ReactNode }) {
  const { t, locale } = useT();
  const session = useSession();
  const router = useRouter();
  const pathname = usePathname();

  const orgQ = useApi<OrgInfo>(`/o/${orgId}`);
  const entQ = useApi<EntitlementsView>(`/o/${orgId}/billing/entitlements`);

  // Last known restaurant and branch choice for this user (read once the stored session is known).
  const stored = useMemo(
    () => (session.tokenReady && session.scope
      ? { snap: readShellSnapshot(orgId, session.scope), branch: readPreferredBranch(orgId), all: readAllBranches(orgId) } : null),
    [session.tokenReady, session.scope, orgId],
  );
  const [branchChoice, setBranchChoice] = useState<string | null>(null);
  const [allChoice, setAllChoice] = useState<boolean | null>(null);
  const [allowAllCount, setAllowAllCount] = useState(0);

  const orgKind = orgQ.error?.kind;
  const orgGone = !orgQ.data && (orgKind === 'forbidden' || orgKind === 'not_found');
  const baseOrg = orgQ.data ?? (orgGone ? null : stored?.snap?.org ?? null);
  const modules: Modules | undefined = entQ.data ? toModules(entQ.data)
    : entQ.error ? (stored?.snap?.modules ?? null)
      : stored?.snap ? stored.snap.modules : undefined;
  const plan = entQ.data ? entQ.data.planId : stored?.snap?.plan ?? null;

  const wantedBranch = branchChoice ?? stored?.branch ?? null;
  const activeBranches = baseOrg?.branches.filter((b) => b.isActive !== false) ?? [];
  const branchId = baseOrg?.branches.some((b) => b.id === wantedBranch) ? wantedBranch : activeBranches[0]?.id ?? baseOrg?.branches[0]?.id ?? null;
  const allBranches = activeBranches.length > 1 && (allChoice ?? stored?.all ?? true);
  const org = useMemo(() => (baseOrg ? withPreferredBranch(baseOrg, branchId) : null), [baseOrg, branchId]);

  // Keep the snapshot current once both reads have settled; forget it when access is gone.
  useEffect(() => {
    if (!session.scope || !orgQ.data || (entQ.data === undefined && !entQ.error)) return;
    writeShellSnapshot({ scope: session.scope, org: orgQ.data, modules: entQ.data ? toModules(entQ.data) : null, plan: entQ.data?.planId ?? null,
      savedAt: orgQ.updatedAt || Date.now() });
  }, [session.scope, orgQ.data, orgQ.updatedAt, entQ.data, entQ.error]);
  useEffect(() => { if (orgGone) dropShellSnapshot(orgId); }, [orgGone, orgId]);

  const reload = async () => { await Promise.all([orgQ.reload(), entQ.reload()]); };
  const chooseBranch = useCallback((id: string | null) => {
    if (id === null) { writeAllBranches(orgId, true); setAllChoice(true); return; }
    writePreferredBranch(orgId, id); writeAllBranches(orgId, false); setBranchChoice(id); setAllChoice(false);
  }, [orgId]);
  const registerAllBranches = useCallback(() => {
    setAllowAllCount((c) => c + 1);
    return () => setAllowAllCount((c) => c - 1);
  }, []);
  const allowAll = allowAllCount > 0;

  // Navigation for this member: role, branch service model, plan (Free shell), locked modules → Explore.
  const navCtx = org && modules !== undefined ? { role: org.role, modules, plan, branch: org.branches[0] ?? null } : null;
  const areas = useMemo(() => (navCtx ? visibleAreas(navCtx) : []), [navCtx?.role, navCtx?.modules, navCtx?.plan, navCtx?.branch]); // eslint-disable-line react-hooks/exhaustive-deps
  const explore = useMemo(() => (navCtx ? lockedItems(navCtx).length > 0 : false), [navCtx?.role, navCtx?.modules, navCtx?.plan]); // eslint-disable-line react-hooks/exhaustive-deps
  const primary = areas.filter((a) => a.key !== 'settings');
  const settings = areas.find((a) => a.key === 'settings') ?? null;
  const base = `/dashboard/${orgId}`;

  const ordersAllowed = !!org && roleCan(org.role, 'orders:read');
  const orders = useApi<{ items: unknown[]; nextCursor: string | null }>(
    ordersAllowed && modules !== undefined ? `/o/${orgId}/orders?status=${ACTIVE_ORDER_STATUSES}&limit=100` : null, { pollMs: 30_000 });
  const openOrders = orders.data ? orders.data.items.length + (orders.data.nextCursor ? 1 : 0) : null;
  // Only once the entitlements read has settled: the saved snapshot can predate a downgrade, and asking a dropped
  // module for its config answers 402.
  const entSettled = entQ.data !== undefined || !!entQ.error;
  const payAllowed = !!org && !!branchId && roleCan(org.role, 'payments:read') && entSettled && modules !== undefined && (modules === null || modules.pay !== false);
  const payConfig = useApi<{ mode: string }>(payAllowed ? `/o/${orgId}/payments/config?branchId=${branchId}` : null, { staleMs: 5 * MINUTE });

  // Shell chrome state: sidebar collapsed (persisted), command palette, cheat sheet, phone drawer.
  const [collapsed, setCollapsed] = useState(false);
  useEffect(() => { setCollapsed(readCollapsed()); }, []);
  const toggleCollapsed = () => setCollapsed((c) => { writeCollapsed(!c); return !c; });
  const [palette, setPalette] = useState<boolean | null>(null);
  const [help, setHelp] = useState<boolean | null>(null);
  const [drawer, setDrawer] = useState<boolean | null>(null);
  useEffect(() => { setDrawer((d) => (d ? false : d)); }, [pathname]);

  const orgName = org ? pick(locale, org.name, org.nameAr) : null;
  const branch = org?.branches.find((b) => b.id === branchId) ?? null;
  const branchName = allBranches && allowAll ? t('shell.allBranches') : branch ? pick(locale, branch.name, branch.nameAr) : null;
  const eyebrow = useMemo(() => (orgName ? <Breadcrumb parts={[orgName, branchName]} /> : null), [orgName, branchName]);

  const navigate = useCallback((href: string) => router.push(href), [router]);
  const signOut = useCallback(async () => { await session.signOut(); router.push('/login'); }, [session, router]);
  const switchLanguage = useCallback(() => setLocale(locale === 'ar' ? 'en' : 'ar'), [locale]);
  const visibleHrefs = useMemo(() => new Set(areas.flatMap((a) => a.items.map((i) => i.href))), [areas]);
  const onShortcut = (cmd: ShortcutCommand) => {
    if (!org) return false;
    if (cmd.type === 'palette') { setHelp(false); setPalette(true); return; }
    if (cmd.type === 'help') { if (palette) return false; setHelp(true); return; }
    const hit = GO_SHORTCUTS.find((s) => s.letter === cmd.letter && visibleHrefs.has(s.item.href));
    if (!hit) return false;
    setPalette(false); setHelp(false);
    router.push(base + hit.item.href);
  };

  const refreshFailed = !!org && !!orgQ.error && orgQ.error.kind !== 'unauthorized' && orgQ.error.kind !== 'aborted';
  let body: ReactNode;
  if (!org) {
    body = orgQ.error && orgQ.error.kind !== 'unauthorized' && orgQ.error.kind !== 'aborted'
      ? <Suspense fallback={<BodySkeleton />}><ShellFailure error={orgQ.error} onRetry={reload} /></Suspense>
      : <BodySkeleton />;
  } else if (modules === undefined) {
    body = <BodySkeleton />;
  } else {
    body = (
      <OrgProvider value={{ org, modules, plan, reload, branchId, allBranches, setBranchId: chooseBranch, registerAllBranches }}>
        <PageEyebrowProvider value={eyebrow}>
          {refreshFailed && (
            <div className="notice notice-warn stale-notice ws-banner" role="status">
              <span>{t('shell.refreshFailed')}</span>
              <button type="button" className="btn btn-sm" onClick={() => void reload()}>{t('action.retry')}</button>
            </div>
          )}
          {/* Re-mount the screen when the branch changes so it opens on the newly chosen branch. */}
          <div key={allBranches ? `all:${branchId}` : branchId ?? 'none'} style={{ display: 'contents' }}>{children}</div>
        </PageEyebrowProvider>
      </OrgProvider>
    );
  }

  const me = session.me;
  const memberName = me?.user.fullName || me?.user.email || (org ? t(`role.${org.role}`) : '');
  const tables = !!org && org.branches.some((b) => b.acceptsDineIn !== false);
  const guest = org ? { href: `/r/${org.slug}`, label: tables ? t('shell.guest') : t('shell.guestOrdering') } : null;
  const setupHref = org && roleCan(org.role, 'org:manage') ? `${base}/setup` : null;
  const others = (me?.memberships ?? []).filter((m) => m.orgId !== orgId);
  const payMode = payConfig.data?.mode ?? null;

  return (
    <ShortcutsProvider onCommand={onShortcut}>
      <div className="ws" data-collapsed={collapsed || undefined}>
        <a className="skip-link" href="#workspace-main">{t('shell.skip')}</a>
        <aside className="ws-sidebar" aria-label={t('shell.nav')}>
          <div className="ws-sidebar-head">
            <div className="ws-brand-row">
              <Link className="ws-brand" href={base} aria-label={t('app.name')}><Wordmark label={t('app.name')} size={collapsed ? 'sm' : 'md'} /></Link>
              <button type="button" className="ws-icon-btn ws-collapse" onClick={toggleCollapsed} aria-pressed={collapsed}
                aria-label={collapsed ? t('shell.expand') : t('shell.collapse')} title={collapsed ? t('shell.expand') : t('shell.collapse')}>
                <UiIcon name={collapsed ? 'expand' : 'collapse'} />
              </button>
            </div>
            {org && orgName
              ? <BranchSwitcher org={org} branchId={branchId} allBranches={allBranches} allowAll={allowAll} onChoose={chooseBranch} collapsed={collapsed} />
              : <RestaurantChip name="" busy />}
          </div>
          {navCtx ? <SidebarNav areas={primary} base={base} pathname={pathname} collapsed={collapsed} openOrders={openOrders} label={t('shell.nav')} /> : <NavSkeleton />}
          {org && navCtx && (
            <div className="ws-sidebar-bottom">
              {settings && <SidebarNav areas={[settings]} base={base} pathname={pathname} collapsed={collapsed} label={t('nav.group.settings')} />}
              {explore && (
                <Link className="ws-area-btn ws-explore" href={`${base}/explore`} aria-current={pathname === `${base}/explore` ? 'page' : undefined}
                  aria-label={collapsed ? t('nav.explore') : undefined} title={collapsed ? t('nav.explore') : undefined}>
                  <ShellIcon name="explore" /><span className="ws-nav-text">{t('nav.explore')}</span>
                </Link>
              )}
              {payMode && !collapsed && (
                <div className="ws-mode-note">
                  <span className="ws-live-dot" aria-hidden="true" /> {org.onboarding?.demo ? t('shell.mode.demo') : t('shell.mode.restaurant')}
                  <span>{payMode === 'live' ? t('shell.mode.online') : t('shell.mode.test')}</span>
                </div>
              )}
              {guest && (
                <AccountMenu name={memberName} roleLabel={t(`role.${org.role}`)} guestHref={guest.href} guestLabel={guest.label} setupHref={setupHref}
                  restaurants={others} onNavigate={navigate} onLanguage={switchLanguage} onSignOut={() => void signOut()} collapsed={collapsed} />
              )}
            </div>
          )}
        </aside>
        <div className="ws-main">
          <ShellTopbar timeZone={org?.timezone} onSearch={org ? () => setPalette(true) : undefined} />
          <main className="ws-page" id="workspace-main" tabIndex={-1}>{body}</main>
          <WorkspaceFooter brand={t('app.name')}
            promise={org && !org.branches.some((b) => b.acceptsDineIn !== false) ? t('shell.promise.counter') : t('shell.promise.tables')}
            mode={org ? <>{payConfig.data ? `${payConfig.data.mode === 'live' ? t('shell.payments.live') : t('shell.payments.simulated')} · ` : ''}<bdi>{org.currency}</bdi></> : null} />
        </div>
        {navCtx && <MobileTabBar areas={areas} base={base} pathname={pathname} onMore={() => setDrawer(true)} moreOpen={!!drawer} />}
        <Suspense fallback={null}>
        {org && navCtx && drawer !== null && guest && (
          <MobileDrawer open={drawer} onClose={() => setDrawer(false)} areas={primary} settings={settings} base={base} pathname={pathname}
            explore={explore} openOrders={openOrders} guest={guest} setupHref={setupHref} onNavigate={navigate} onLanguage={switchLanguage}
            onSignOut={() => void signOut()} />
        )}
        {org && navCtx && palette !== null && (
          <CommandPalette open={palette} onClose={() => setPalette(false)} org={org} role={org.role} areas={areas} explore={explore}
            branchId={branchId} allowAll={allowAll} allBranches={allBranches} onBranch={chooseBranch} onNavigate={navigate}
            onLanguage={switchLanguage} onSignOut={() => void signOut()}
            search={(path, signal) => session.call(path, { signal })} />
        )}
        {help !== null && <ShortcutsSheet open={help} onClose={() => setHelp(false)} visibleHrefs={visibleHrefs} />}
        </Suspense>
      </div>
    </ShortcutsProvider>
  );
}

function ShellTopbar({ timeZone, onSearch }: { timeZone?: string; onSearch?: () => void }) {
  const { t, locale } = useT();
  const now = useNow(MINUTE);
  const state = useConnection();
  const [mac, setMac] = useState(false);
  useEffect(() => { setMac(/Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)); }, []);
  return (
    <Topbar title={t('shell.service')}
      status={<LiveStatus state={state} labels={{ live: t('shell.live'), reconnecting: t('shell.reconnecting'), offline: t('shell.offline') }} />}
      date={now !== null && timeZone ? <time dateTime={new Date(now).toISOString()}>{dateTimeFormat(locale, { day: 'numeric', month: 'short', year: 'numeric', timeZone }).format(now)}</time> : null}>
      {onSearch && (
        <button type="button" className="ws-search" onClick={onSearch} aria-keyshortcuts="Meta+K Control+K">
          <UiIcon name="search" size={16} />
          <span className="ws-search-text">{t('shell.search')}</span>
          <kbd className="rui-kbd" dir="ltr" aria-hidden="true">{mac ? '⌘K' : 'Ctrl K'}</kbd>
        </button>
      )}
      <LanguageToggle className="ws-lang-btn" label={t('lang.short')} />
      <NotificationBell />
    </Topbar>
  );
}
