'use client';
// Overview pieces restored from legacy manager-platform.js (VS-15): the live floor with its legend (table service), the
// launch card (counter / online-only). The overview command centre (21-HOME) loads them on demand; station load, low
// stock and the ask box moved into its rows.
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { ServiceMode } from '@resuto/contracts';
import { FloorMapPanel, useLiveFloor } from '@/components/floor/LiveFloor';
import { VenueQrCard } from '@/components/ops/ServiceMode';
import { useT } from '@/lib/i18n/client';

/** Read-only live floor for the overview; selecting a table opens it on the floor page. */
export function OverviewFloor({ orgId, branchId, canEdit }: { orgId: string; branchId: string; canEdit: boolean }) {
  const { t } = useT();
  const router = useRouter();
  const data = useLiveFloor(orgId, branchId, 10_000);
  return (
    <FloorMapPanel data={data} title={t('ops.overview.liveFloor')}
      actions={<span className="fine"><span className="ws-live-dot" aria-hidden="true" /> {t('ops.overview.liveUpdates')}</span>}
      onSelect={() => router.push(`/dashboard/${orgId}/floor?branch=${branchId}`)}
      note={canEdit ? <Link href={`/dashboard/${orgId}/floor?tab=studio&branch=${branchId}`}>{t('ops.floor.editLayout')} ↗</Link> : undefined} />
  );
}

/** Counter and online-only venues get a launch card instead of a floor (legacy overview, app.js:134). */
export function LaunchCard({ orgId, branchId, mode, slug }: { orgId: string; branchId: string; mode: ServiceMode; slug: string }) {
  const { t } = useT();
  if (mode === 'counter') return <VenueQrCard orgId={orgId} branchId={branchId} title={t('ops.mode.launchTitle')} />;
  return (
    <section className="panel">
      <div className="panel-head"><h2>{t('ops.mode.onlineLaunch')}</h2></div>
      <div className="panel-body">
        <p>{t('ops.mode.onlineLaunchBody')}</p>
        <a className="btn btn-primary" href={`/order/${slug}`} target="_blank" rel="noopener noreferrer">{t('ops.mode.openSite')} ↗</a>
      </div>
    </section>
  );
}
