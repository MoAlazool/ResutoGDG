'use client';
import Link from 'next/link';
import { useParams, usePathname, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { can } from '@resuto/contracts';
import { Notice, Skeleton } from '@resuto/ui';
import { pick } from '@/lib/format';
import { kitchenDisplayPath } from '@/lib/home-path';
import { LanguageToggle, useT } from '@/lib/i18n/client';
import type { OrgInfo } from '@/lib/org-context';
import { useSession } from '@/lib/session';
import { TicketBoard as KitchenBoard, StationPicker } from '@/components/ops/TicketBoard';

/**
 * Full-screen kitchen display for wall tablets (no dashboard chrome): the kitchen team's home. Staff who also have the
 * workspace (owners, managers) open the KDS inside the staff shell like legacy, and reach this screen with its
 * "Full screen" button (?display=full) (PAR-05).
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
      const full = new URLSearchParams(window.location.search).get('display') === 'full';
      const target = kitchenDisplayPath(o.role, orgId, { full });
      if (!target.startsWith(`/kitchen/${orgId}`)) { router.replace(target); return; }
      setOrg(o);
      let saved: string | null = null;
      try { saved = localStorage.getItem(`resuto.kds.${orgId}`); } catch { /* ignore */ }
      const parsed = saved ? JSON.parse(saved) as { branchId?: string; station?: string | null } : {};
      setBranchId(o.branches.find((b) => b.id === parsed.branchId)?.id ?? o.branches[0]?.id ?? null);
      setStation(parsed.station ?? null);
    }).catch((e) => setError((e as Error).message));
  }, [session.ready, session.token, session, orgId, router, pathname]);

  useEffect(() => {
    if (!branchId) return;
    try { localStorage.setItem(`resuto.kds.${orgId}`, JSON.stringify({ branchId, station })); } catch { /* ignore */ }
  }, [orgId, branchId, station]);

  if (error) return <main className="center-page"><Notice tone="danger">{error}</Notice></main>;
  if (!org) return <main className="center-page"><div style={{ width: 320 }}><Skeleton lines={4} /></div></main>;

  return (
    <main className="kds-full">
      <header className="spread" style={{ marginBottom: 14 }}>
        <div>
          <div className="overline">{pick(locale, org.name, org.nameAr)}</div>
          <h1 style={{ margin: 0 }}>{t('core.kds.title')}</h1>
        </div>
        <div className="row">
          {org.branches.length > 1 && (
            <select className="select" style={{ width: 'auto' }} value={branchId ?? ''} onChange={(e) => setBranchId(e.target.value)} aria-label={t('core.web.branch')}>
              {org.branches.map((b) => <option key={b.id} value={b.id}>{pick(locale, b.name, b.nameAr)}</option>)}
            </select>
          )}
          <button className="btn btn-sm" onClick={() => { void document.documentElement.requestFullscreen?.().catch(() => undefined); }}>⛶ {t('core.kds.fullscreen')}</button>
          <Link className="btn btn-sm btn-ghost" href={`/dashboard/${orgId}/kitchen`}>{t('core.kds.exit')}</Link>
          <LanguageToggle />
        </div>
      </header>
      <div style={{ marginBottom: 12 }}><StationPicker stations={stations} value={station} onChange={setStation} /></div>
      {branchId ? (
        <KitchenBoard orgId={orgId} branchId={branchId} station={station} onStations={setStations} timezone={org.timezone} currency={org.currency}
          canCancel={can(org.role, 'orders:cancel')} can86={can(org.role, 'menu:availability')}
          canResolve={can(org.role, 'orders:read') && (can(org.role, 'floor:seat') || can(org.role, 'orders:status'))}
          ordersHref={can(org.role, 'payments:collect') ? `/dashboard/${orgId}/orders` : null} />
      ) : <Notice tone="warn">{t('core.kds.noBranch')}</Notice>}
    </main>
  );
}
