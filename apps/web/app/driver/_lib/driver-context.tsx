'use client';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { DeliveryJobView, DriverView } from '@resuto/contracts';
import { Notice, Skeleton } from '@resuto/ui';
import { LanguageToggle, useT } from '@/lib/i18n/client';
import { useApi, type ApiState } from '@/lib/use-api';
import { useSession } from '@/lib/session';
import { useLocationSharing, type Fix, type LocationState } from './location';
import s from '../driver.module.css';

export interface DriverProfile extends DriverView {
  pendingOffers: number;
  org: { id: string; name: string; nameAr: string | null; currency: string; timezone: string };
}
export interface RoutePlan { algorithm: string; order: string[]; legs: Array<{ stopId: string; distanceM: number; arrivalOffsetSeconds: number }> }
export interface MyJobs { active: DeliveryJobView[]; offers: DeliveryJobView[]; route: RoutePlan | null }

interface DriverValue {
  orgId: string;
  base: string;
  profile: ApiState<DriverProfile>;
  jobs: ApiState<MyJobs>;
  location: { state: LocationState; lastFix: Fix | null };
  call: ReturnType<typeof useSession>['call'];
  refresh(): Promise<void>;
}

const Ctx = createContext<DriverValue | null>(null);
export const useDriver = () => {
  const v = useContext(Ctx);
  if (!v) throw new Error('useDriver must be used inside the driver app');
  return v;
};

const ORG_KEY = 'resuto_driver_org';
const DEVICE_KEY = 'resuto_driver_device';
const readLocal = (k: string) => { try { return localStorage.getItem(k); } catch { return null; } };
const writeLocal = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } };

/** Signed-in driver shell: auth redirect, restaurant picker, polling, location sharing, bottom navigation. */
export function DriverShell({ children }: { children: ReactNode }) {
  const { t } = useT();
  const session = useSession();
  const router = useRouter();
  const pathname = usePathname();
  const memberships = useMemo(() => (session.me?.memberships ?? []).filter((m) => m.role === 'driver'), [session.me]);
  const [orgId, setOrgId] = useState<string | null>(null);

  // A token without a profile happens right after sign-in (the post-login refresh can
  // run with the previous token); load the profile once more with the current token.
  const { ready, token, me, refreshMe } = session;
  useEffect(() => {
    if (ready && token && !me) void refreshMe();
  }, [ready, token, me, refreshMe]);

  useEffect(() => {
    if (!session.ready) return;
    if (!session.token) { router.replace(`/login?next=${encodeURIComponent(pathname || '/driver')}`); return; }
    if (!memberships.length) return;
    const stored = readLocal(ORG_KEY);
    setOrgId((current) => current ?? (memberships.find((m) => m.orgId === stored)?.orgId ?? (memberships.length === 1 ? memberships[0]!.orgId : null)));
  }, [session.ready, session.token, memberships, router, pathname]);

  if (!session.ready || (session.token && !session.me)) return <Frame><div style={{ padding: 24 }}><Skeleton lines={5} /></div></Frame>;
  if (!session.token) return <Frame><div className={s.centered}><Skeleton lines={2} /></div></Frame>;
  if (!memberships.length) {
    return (
      <Frame>
        <div className={s.centered}>
          <div className="stack" style={{ maxWidth: 360 }}>
            <h1 style={{ fontSize: 22 }}>{t('driver.notDriver.title')}</h1>
            <p className="muted">{t('driver.notDriver.body')}</p>
            <button className={`btn btn-primary ${s.bigBtn}`} onClick={async () => { await session.signOut(); router.replace('/login?next=/driver'); }}>{t('action.signOut')}</button>
          </div>
        </div>
      </Frame>
    );
  }
  if (!orgId) {
    return (
      <Frame>
        <div className={s.main}>
          <h1 style={{ fontSize: 22 }}>{t('driver.chooseRestaurant')}</h1>
          {memberships.map((m) => (
            <button key={m.orgId} className={`btn ${s.bigBtn}`} onClick={() => { writeLocal(ORG_KEY, m.orgId); setOrgId(m.orgId); }}>{m.orgName}</button>
          ))}
        </div>
      </Frame>
    );
  }
  return (
    <DriverRuntime orgId={orgId} memberships={memberships} onSwitch={(id) => { writeLocal(ORG_KEY, id); setOrgId(id); }}>
      {children}
    </DriverRuntime>
  );
}

function Frame({ children }: { children: ReactNode }) {
  const { t } = useT();
  return (
    <div className={s.app}>
      <header className={s.header}>
        <div className={s.brand}><img src="/brand/resuto-icon.png" alt="" /><span>{t('driver.title')}</span></div>
        <div className={s.headerTools}><LanguageToggle /></div>
      </header>
      {children}
    </div>
  );
}

function DriverRuntime({ orgId, memberships, onSwitch, children }: {
  orgId: string; memberships: Array<{ orgId: string; orgName: string }>; onSwitch(id: string): void; children: ReactNode;
}) {
  const { t, locale } = useT();
  const session = useSession();
  const pathname = usePathname();
  const base = `/o/${orgId}/driver`;
  const profile = useApi<DriverProfile>(`${base}/me`, { pollMs: 30_000 });
  const jobs = useApi<MyJobs>(`${base}/jobs`, { pollMs: 10_000 });
  const onRoad = !!jobs.data?.active.some((j) => j.status === 'picked_up' || j.status === 'en_route');
  const upload = useCallback((points: Fix[]) => session.call(`${base}/me/locations`, { body: { points } }), [session, base]);
  const location = useLocationSharing(onRoad, upload);

  // Register this browser as a device (push token support arrives with native apps / web push).
  useEffect(() => {
    let id = readLocal(DEVICE_KEY);
    if (!id) { id = `web-${crypto.randomUUID()}`; writeLocal(DEVICE_KEY, id); }
    void session.call(`${base}/me/devices`, { body: { platform: 'web', deviceId: id, appVersion: 'web-1' } }).catch(() => undefined);
  }, [base, session]);

  const refresh = useCallback(async () => { await Promise.all([profile.reload(), jobs.reload()]); }, [profile, jobs]);
  const value: DriverValue = { orgId, base, profile, jobs, location, call: session.call, refresh };
  const nav = [
    { href: '/driver', icon: '⇢', label: t('driver.nav.jobs') },
    { href: '/driver/cash', icon: '¤', label: t('driver.nav.cash') },
    { href: '/driver/history', icon: '☰', label: t('driver.nav.history') },
  ];
  const orgName = profile.data ? (locale === 'ar' && profile.data.org.nameAr ? profile.data.org.nameAr : profile.data.org.name) : '';

  return (
    <Ctx.Provider value={value}>
      <div className={s.app}>
        <header className={s.header}>
          <div className={s.brand}><img src="/brand/resuto-icon.png" alt="" /><span>{orgName || t('driver.title')}</span></div>
          <div className={s.headerTools}>
            {memberships.length > 1 && (
              <select className={s.orgSelect} value={orgId} onChange={(e) => onSwitch(e.target.value)} aria-label={t('driver.switchRestaurant')}>
                {memberships.map((m) => <option key={m.orgId} value={m.orgId}>{m.orgName}</option>)}
              </select>
            )}
            <LanguageToggle />
          </div>
        </header>
        <main className={s.main}>
          {profile.error?.code === 'module_not_entitled' ? <Notice tone="warn">{t('driver.moduleOff')}</Notice>
            : profile.error?.code === 'driver_suspended' ? <Notice tone="danger">{profile.error.message}</Notice>
              : profile.error ? <Notice tone="danger">{profile.error.message} <button className="btn btn-sm" onClick={() => void refresh()}>{t('action.retry')}</button></Notice>
                : children}
        </main>
        <nav className={s.bottomNav} aria-label={t('driver.title')}>
          {nav.map((n) => (
            <Link key={n.href} href={n.href} aria-current={(n.href === '/driver' ? pathname === '/driver' || pathname.startsWith('/driver/jobs') : pathname.startsWith(n.href)) ? 'page' : undefined}>
              <span aria-hidden>{n.icon}</span>{n.label}
            </Link>
          ))}
        </nav>
      </div>
    </Ctx.Provider>
  );
}

export function LocationPill() {
  const { t } = useT();
  const { location } = useDriver();
  const map: Record<LocationState, { cls: string; key: string }> = {
    off: { cls: '', key: 'driver.location.off' },
    starting: { cls: s.pillWarn, key: 'driver.location.starting' },
    on: { cls: s.pillOn, key: 'driver.location.on' },
    denied: { cls: s.pillWarn, key: 'driver.location.denied' },
    unsupported: { cls: s.pillWarn, key: 'driver.location.unsupported' },
    error: { cls: s.pillWarn, key: 'driver.location.error' },
  };
  const m = map[location.state];
  return (
    <span className={`${s.pill} ${m.cls}`} role="status">
      <span className={`${s.dot} ${location.state === 'on' ? s.pulse : ''}`} aria-hidden />{t(m.key)}
    </span>
  );
}
