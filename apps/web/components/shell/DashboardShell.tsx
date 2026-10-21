'use client';
import Link, { useLinkStatus } from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { can as roleCan, dateTimeFormat, type EntitlementsView, type ModuleKey } from '@resuto/contracts';
import {
  Breadcrumb, ErrorState, LiveStatus, NavBadge, NavGlyph, PageEyebrowProvider, ProfileButton, RestaurantChip, RouteProgress, Topbar,
  Wordmark, WorkspaceFooter, initialOf,
} from '@resuto/ui';
import { ApiRequestError } from '@/lib/api';
import { connectionState, subscribeConnection } from '@/lib/connection';
import { pick } from '@/lib/format';
import { LanguageToggle, useT } from '@/lib/i18n/client';
import { NotificationBell } from './NotificationBell';
import { ACTIVE_ORDER_STATUSES, NAV, navForBranch, navVisible, type NavItem } from '@/lib/nav';
import { OrgProvider, type OrgInfo } from '@/lib/org-context';
import { useSession } from '@/lib/session';
import {
  dropShellSnapshot, readPreferredBranch, readShellSnapshot, withPreferredBranch, writePreferredBranch, writeShellSnapshot,
} from '@/lib/shell-snapshot';
import { useApi } from '@/lib/use-api';
import { BodySkeleton, NavSkeleton } from './Skeletons';

type Modules = Partial<Record<ModuleKey, boolean>> | null;
const toModules = (e: EntitlementsView): Modules => Object.fromEntries(Object.entries(e.modules).map(([k, v]) => [k, v.enabled]));
const MINUTE = 60_000;

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
 * Staff workspace shell (VS-02, VS-24, VS-07, PCL-05), restored from the original Resuto manager workspace.
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

  const orgQ = useApi<OrgInfo>(`/o/${orgId}`);
  const entQ = useApi<EntitlementsView>(`/o/${orgId}/billing/entitlements`);

  // Last known restaurant and branch choice for this user (read once the stored session is known).
  const stored = useMemo(
    () => (session.tokenReady && session.scope ? { snap: readShellSnapshot(orgId, session.scope), branch: readPreferredBranch(orgId) } : null),
    [session.tokenReady, session.scope, orgId],
  );
  const [branchChoice, setBranchChoice] = useState<string | null>(null);

  const orgKind = orgQ.error?.kind;
  const orgGone = !orgQ.data && (orgKind === 'forbidden' || orgKind === 'not_found');
  const baseOrg = orgQ.data ?? (orgGone ? null : stored?.snap?.org ?? null);
  const modules: Modules | undefined = entQ.data ? toModules(entQ.data)
    : entQ.error ? (stored?.snap?.modules ?? null)
      : stored?.snap ? stored.snap.modules : undefined;

  const wantedBranch = branchChoice ?? stored?.branch ?? null;
  const branchId = baseOrg?.branches.some((b) => b.id === wantedBranch) ? wantedBranch : baseOrg?.branches[0]?.id ?? null;
  const org = useMemo(() => (baseOrg ? withPreferredBranch(baseOrg, branchId) : null), [baseOrg, branchId]);

  // Keep the snapshot current once both reads have settled; forget it when access is gone.
  useEffect(() => {
    if (!session.scope || !orgQ.data || (entQ.data === undefined && !entQ.error)) return;
    writeShellSnapshot({ scope: session.scope, org: orgQ.data, modules: entQ.data ? toModules(entQ.data) : null, savedAt: orgQ.updatedAt || Date.now() });
  }, [session.scope, orgQ.data, orgQ.updatedAt, entQ.data, entQ.error]);
  useEffect(() => { if (orgGone) dropShellSnapshot(orgId); }, [orgGone, orgId]);

  const reload = async () => { await Promise.all([orgQ.reload(), entQ.reload()]); };
  const chooseBranch = useCallback((id: string) => { writePreferredBranch(orgId, id); setBranchChoice(id); }, [orgId]);

  const ordersAllowed = !!org && roleCan(org.role, 'orders:read');
  const orders = useApi<{ items: unknown[]; nextCursor: string | null }>(
    ordersAllowed && modules !== undefined ? `/o/${orgId}/orders?status=${ACTIVE_ORDER_STATUSES}&limit=100` : null, { pollMs: 30_000 });
  const payAllowed = !!org && !!branchId && roleCan(org.role, 'payments:read') && modules !== undefined && (modules === null || modules.pay !== false);
  const payConfig = useApi<{ mode: string }>(payAllowed ? `/o/${orgId}/payments/config?branchId=${branchId}` : null, { staleMs: 5 * MINUTE });

  const orgName = org ? pick(locale, org.name, org.nameAr) : null;
  const branch = org?.branches.find((b) => b.id === branchId) ?? null;
  const branchName = branch ? pick(locale, branch.name, branch.nameAr) : null;
  const switchable = !!org && (org.branches.filter((b) => b.isActive !== false).length > 1 || (session.me?.memberships ?? []).some((m) => m.orgId !== orgId));
  const eyebrow = useMemo(() => (orgName ? <Breadcrumb parts={[orgName, branchName]} /> : null), [orgName, branchName]);

  const refreshFailed = !!org && !!orgQ.error && orgQ.error.kind !== 'unauthorized' && orgQ.error.kind !== 'aborted';
  let body: ReactNode;
  if (!org) {
    body = orgQ.error && orgQ.error.kind !== 'unauthorized' && orgQ.error.kind !== 'aborted'
      ? <ShellFailure error={orgQ.error} onRetry={reload} />
      : <BodySkeleton />;
  } else if (modules === undefined) {
    body = <BodySkeleton />;
  } else {
    body = (
      <OrgProvider value={{ org, modules, reload, branchId, setBranchId: chooseBranch }}>
        <PageEyebrowProvider value={eyebrow}>
          {refreshFailed && (
            <div className="notice notice-warn stale-notice ws-banner" role="status">
              <span>{t('shell.refreshFailed')}</span>
              <button type="button" className="btn btn-sm" onClick={() => void reload()}>{t('action.retry')}</button>
            </div>
          )}
          {/* Re-mount the screen when the branch changes so it opens on the newly chosen branch. */}
          <div key={branchId ?? 'all'} style={{ display: 'contents' }}>{children}</div>
        </PageEyebrowProvider>
      </OrgProvider>
    );
  }

  return (
    <div className="ws">
      <a className="skip-link" href="#workspace-main">{t('shell.skip')}</a>
      <aside className="ws-sidebar" aria-label={t('shell.nav')}>
        <div className="ws-sidebar-head">
          <Link className="ws-brand" href={`/dashboard/${orgId}`} aria-label={t('app.name')}><Wordmark label={t('app.name')} /></Link>
          {org && orgName ? (
            <RestaurantChip name={<bdi>{orgName}</bdi>} initial={initialOf(orgName)} branch={branchName ? <bdi>{branchName}</bdi> : undefined}>
              {switchable && <Switcher org={org} orgId={orgId} branchId={branchId} onBranch={chooseBranch}
                memberships={session.me?.memberships ?? []} onRestaurant={(id) => router.push(`/dashboard/${id}`)} />}
            </RestaurantChip>
          ) : <RestaurantChip name="" busy />}
        </div>
        {org && modules !== undefined
          ? <ShellNav org={org} orgId={orgId} modules={modules} openOrders={orders.data ? orders.data.items.length + (orders.data.nextCursor ? 1 : 0) : null} />
          : <NavSkeleton />}
        {org && <SidebarBottom org={org} demo={!!org.onboarding?.demo} payMode={payConfig.data?.mode ?? null}
          onSignOut={async () => { await session.signOut(); router.push('/login'); }} />}
      </aside>
      <div className="ws-main">
        <ShellTopbar timeZone={org?.timezone} />
        <main className="ws-page" id="workspace-main" tabIndex={-1}>{body}</main>
        <WorkspaceFooter brand={t('app.name')}
          promise={org && !org.branches.some((b) => b.acceptsDineIn !== false) ? t('shell.promise.counter') : t('shell.promise.tables')}
          mode={org ? <>{payConfig.data ? `${payConfig.data.mode === 'live' ? t('shell.payments.live') : t('shell.payments.simulated')} · ` : ''}<bdi>{org.currency}</bdi></> : null} />
      </div>
      <LanguageToggle className="ws-lang" label={t('lang.short')} />
    </div>
  );
}

function ShellTopbar({ timeZone }: { timeZone?: string }) {
  const { t, locale } = useT();
  const now = useNow(MINUTE);
  const state = useConnection();
  return (
    <Topbar title={t('shell.service')}
      status={<LiveStatus state={state} labels={{ live: t('shell.live'), reconnecting: t('shell.reconnecting'), offline: t('shell.offline') }} />}
      date={now !== null && timeZone ? <time dateTime={new Date(now).toISOString()}>{dateTimeFormat(locale, { day: 'numeric', month: 'short', year: 'numeric', timeZone }).format(now)}</time> : null}><NotificationBell /></Topbar>
  );
}

function ShellNav({ org, orgId, modules, openOrders }: { org: OrgInfo; orgId: string; modules: Modules; openOrders: number | null }) {
  const { t } = useT();
  const pathname = usePathname();
  const navRef = useRef<HTMLElement>(null);
  const base = `/dashboard/${orgId}`;
  // On phones the nav is a horizontal chip row: keep the current page's chip in view.
  useEffect(() => {
    const el = navRef.current?.querySelector<HTMLElement>('[aria-current="page"]');
    if (el && navRef.current && navRef.current.scrollWidth > navRef.current.clientWidth) el.scrollIntoView({ block: 'nearest', inline: 'center' });
  }, [pathname]);
  return (
    <nav className="ws-nav" ref={navRef} aria-label={t('shell.nav')}>
      {NAV.map((group) => {
        // org.branches lists the branch chosen in the restaurant chip first; its service model drives the nav (VS-16).
        const items = group.items.filter((i) => navVisible(i, org.role) && navForBranch(i, org.branches[0]));
        if (!items.length) return null;
        return (
          <div className="ws-nav-group" key={group.group} role="group" aria-labelledby={`nav-${group.group}`}>
            <div className="ws-nav-label" id={`nav-${group.group}`}>{t(group.group)}</div>
            {items.map((item) => (
              <NavEntry key={item.href} item={item} base={base} pathname={pathname}
                locked={modules !== null && modules[item.module] === false}
                badge={item.href === '/orders' ? openOrders : null} />
            ))}
          </div>
        );
      })}
    </nav>
  );
}

function NavEntry({ item, base, pathname, locked, badge }: { item: NavItem; base: string; pathname: string; locked: boolean; badge: number | null }) {
  const { t } = useT();
  const href = base + item.href;
  const active = item.href === '' ? pathname === base : pathname === href || pathname.startsWith(`${href}/`);
  return (
    <Link href={href} className="ws-nav-link" aria-current={active ? 'page' : undefined} data-locked={locked || undefined}>
      <NavGlyph name={item.glyph} />
      <span className="ws-nav-text">{t(item.label)}</span>
      {locked ? <span className="ws-lock" title={t('state.locked')} aria-label={t('state.locked')}>⊘</span>
        : <NavBadge count={badge} label={badge ? t('shell.openOrders', { n: badge }) : undefined} />}
      <NavPending />
    </Link>
  );
}

/** Pending state for a navigation: marks the clicked link and shows the top progress bar until the page is ready. */
function NavPending() {
  const { pending } = useLinkStatus();
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const link = ref.current?.closest('a');
    if (!link) return;
    if (pending) link.setAttribute('data-pending', ''); else link.removeAttribute('data-pending');
  }, [pending]);
  return <span ref={ref} hidden={!pending}><RouteProgress active={pending} /></span>;
}

function Switcher({ org, orgId, branchId, onBranch, memberships, onRestaurant }: {
  org: OrgInfo; orgId: string; branchId: string | null; onBranch(id: string): void;
  memberships: Array<{ orgId: string; orgName: string }>; onRestaurant(id: string): void;
}) {
  const { t, locale } = useT();
  const ref = useRef<HTMLDetailsElement>(null);
  const active = org.branches.filter((b) => b.isActive !== false);
  const others = memberships.filter((m) => m.orgId !== orgId);
  // Close when clicking outside or pressing Escape.
  useEffect(() => {
    const onDoc = (e: Event) => { if (ref.current?.open && !ref.current.contains(e.target as Node)) ref.current.open = false; };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && ref.current?.open) { ref.current.open = false; ref.current.querySelector('summary')?.focus(); } };
    document.addEventListener('pointerdown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('pointerdown', onDoc); document.removeEventListener('keydown', onKey); };
  }, []);
  const close = () => { if (ref.current) ref.current.open = false; };
  return (
    <details className="ws-switch" ref={ref}>
      <summary aria-label={t('shell.switch')} title={t('shell.switch')}><span aria-hidden="true">⌄</span></summary>
      <div className="ws-switch-menu">
        {active.length > 1 && <>
          <div className="ws-switch-label">{t('shell.branch')}</div>
          {active.map((b) => (
            <button key={b.id} type="button" aria-current={b.id === branchId ? 'true' : undefined} onClick={() => { onBranch(b.id); close(); }}>
              <bdi>{pick(locale, b.name, b.nameAr)}</bdi>{b.id === branchId && <span aria-hidden="true">✓</span>}
            </button>
          ))}
        </>}
        {others.length > 0 && <>
          <div className="ws-switch-label">{t('shell.restaurants')}</div>
          {others.map((m) => (
            <button key={m.orgId} type="button" onClick={() => { close(); onRestaurant(m.orgId); }}><bdi>{m.orgName}</bdi></button>
          ))}
        </>}
      </div>
    </details>
  );
}

function SidebarBottom({ org, demo, payMode, onSignOut }: { org: OrgInfo; demo: boolean; payMode: string | null; onSignOut(): void }) {
  const { t } = useT();
  const { me } = useSession();
  const tables = org.branches.some((b) => b.acceptsDineIn !== false);
  const name = me?.user.fullName || me?.user.email || t(`role.${org.role}`);
  return (
    <div className="ws-sidebar-bottom">
      {roleCan(org.role, 'org:manage') && <Link className="ws-guest-link" href={`/dashboard/${org.id}/setup`}>✦ {t('shell.setup')}</Link>}
      <Link className="ws-guest-link" href="/account/security">{t('auth.account.title')}</Link>
      <a className="ws-guest-link" href={`/r/${org.slug}`} target="_blank" rel="noopener noreferrer">↗ {tables ? t('shell.guest') : t('shell.guestOrdering')}</a>
      {payMode && (
        <div className="ws-mode-note">
          <span className="ws-live-dot" aria-hidden="true" /> {demo ? t('shell.mode.demo') : t('shell.mode.restaurant')}
          <span>{payMode === 'live' ? t('shell.mode.online') : t('shell.mode.test')}</span>
        </div>
      )}
      <ProfileButton initial={initialOf(me?.user.fullName || me?.user.email || t(`role.${org.role}`))}
        name={<bdi>{name}</bdi>} detail={<>{t(`role.${org.role}`)} · {t('shell.signOut')}</>} onClick={onSignOut} />
    </div>
  );
}

/** First load of the restaurant failed: say why and what to do (no endless spinner, no raw error text). */
function ShellFailure({ error, onRetry }: { error: ApiRequestError; onRetry(): Promise<void> }) {
  const { t, locale } = useT();
  if (error.kind === 'forbidden' || error.kind === 'not_found') {
    const k = error.kind === 'forbidden' ? 'forbidden' : 'notFound';
    return (
      <div className="err-inline" role="alert" data-kind={k}>
        <h2>{t(`shell.fail.${k}.title`)}</h2>
        <p>{t(`shell.fail.${k}.body`)}</p>
        <div className="err-actions"><Link className="btn btn-primary" href="/dashboard">{t('shell.fail.myRestaurants')}</Link></div>
      </div>
    );
  }
  return <div className="err-inline"><ErrorState error={error} onRetry={onRetry} locale={locale} /></div>;
}
