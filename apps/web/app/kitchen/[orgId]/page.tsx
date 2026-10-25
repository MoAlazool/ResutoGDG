'use client';
import Link from 'next/link';
import { useParams, usePathname, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { can } from '@resuto/contracts';
import { Notice, Skeleton } from '@resuto/ui';
import { StationPicker, TicketBoard } from '@/components/ops/TicketBoard';
import { pick } from '@/lib/format';
import { homePath } from '@/lib/home-path';
import { LanguageToggle, useT } from '@/lib/i18n/client';
import type { OrgInfo } from '@/lib/org-context';
import { useSession } from '@/lib/session';
import { readPreferredBranch, writePreferredBranch } from '@/lib/shell-snapshot';

/**
 * The kitchen display (21-OPS: one route). The dashboard's Kitchen link opens this full-screen screen for everyone who
 * operates the kitchen; it is also the kitchen team's home. Wall tablets read it from about 2 m: large type,
 * high-contrast status colours, 44 px or larger targets, and a bump bar or keyboard (1-9 pick a ticket, arrows move,
 * Enter / Space / b bump). The branch is the one branch context of the shell (the same stored choice), so the display
 * opens on the branch chosen in the workspace; a wall tablet without the workspace picks it here.
 */
export default function KitchenScreen() {
  const { orgId } = useParams<{ orgId: string }>();
  const { t, locale } = useT();
  const session = useSession();
  const router = useRouter();
  const pathname = usePathname();
  const [org, setOrg] = useState<OrgInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [branchId, setBranchId] = useState<string | null>(null);
  const [station, setStation] = useState<string | null>(null);
  const [stations, setStations] = useState<string[]>([]);

  useEffect(() => {
    if (!session.ready) return;
    if (!session.token) { router.replace(`/login?next=${encodeURIComponent(pathname)}`); return; }
    session.call<OrgInfo>(`/o/${orgId}`).then((o) => {
      if (!can(o.role, 'kitchen:operate')) { router.replace(homePath(o.role, orgId)); return; }
      setOrg(o);
      let saved: { branchId?: string; station?: string | null } = {};
      try { saved = JSON.parse(localStorage.getItem(`resuto.kds.${orgId}`) ?? '{}') as typeof saved; } catch { /* ignore */ }
      const active = o.branches.filter((b) => b.isActive !== false);
      const wanted = readPreferredBranch(orgId) ?? saved.branchId;
      setBranchId(active.find((b) => b.id === wanted)?.id ?? active[0]?.id ?? o.branches[0]?.id ?? null);
      setStation(saved.station ?? null);
    }).catch((e) => setError((e as Error).message));
  }, [session.ready, session.token, session, orgId, router, pathname]);

  useEffect(() => {
    if (!branchId) return;
    try { localStorage.setItem(`resuto.kds.${orgId}`, JSON.stringify({ station })); } catch { /* ignore */ }
  }, [orgId, branchId, station]);

  if (error) return <main className="center-page"><Notice tone="danger">{error}</Notice></main>;
  if (!org) return <main className="center-page"><div className="kds-loading"><Skeleton lines={4} /></div></main>;

  const branches = org.branches.filter((b) => b.isActive !== false);
  const home = homePath(org.role, org.id);
  const back = home === `/kitchen/${org.id}` ? `/dashboard/${org.id}/orders` : home;
  return (
    <main className="kds-full">
      <header className="kds-full-head">
        <div>
          <div className="overline">{pick(locale, org.name, org.nameAr)}</div>
          <h1>{t('core.kds.title')}</h1>
        </div>
        <div className="row">
          {branches.length > 1 && (
            <select className="select" value={branchId ?? ''} aria-label={t('core.web.branch')}
              onChange={(e) => { setBranchId(e.target.value); writePreferredBranch(org.id, e.target.value); }}>
              {branches.map((b) => <option key={b.id} value={b.id}>{pick(locale, b.name, b.nameAr)}</option>)}
            </select>
          )}
          <button className="btn btn-sm" onClick={() => { void document.documentElement.requestFullscreen?.().catch(() => undefined); }}>⛶ {t('core.kds.fullscreen')}</button>
          <Link className="btn btn-sm btn-ghost" href={back}>{t('ops.kds.back')}</Link>
          <LanguageToggle />
        </div>
      </header>
      <StationPicker stations={stations} value={station} onChange={setStation} />
      <details className="kds-keys">
        <summary>{t('ops.kds.keys')}</summary>
        <ul>
          <li>{t('ops.kds.keys.pick')}</li>
          <li>{t('ops.kds.keys.move')}</li>
          <li>{t('ops.kds.keys.bump')}</li>
        </ul>
      </details>
      {branchId ? (
        <TicketBoard key={branchId} mode="kds" orgId={orgId} branchId={branchId} station={station} onStations={setStations} timezone={org.timezone} currency={org.currency}
          canCancel={can(org.role, 'orders:cancel')} can86={can(org.role, 'menu:availability')}
          canResolve={can(org.role, 'orders:read') && (can(org.role, 'floor:seat') || can(org.role, 'orders:status'))}
          ordersHref={can(org.role, 'payments:collect') ? `/dashboard/${orgId}/orders` : null} />
      ) : <Notice tone="warn">{t('core.kds.noBranch')}</Notice>}
    </main>
  );
}
