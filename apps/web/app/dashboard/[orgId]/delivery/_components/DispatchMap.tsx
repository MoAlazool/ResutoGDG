'use client';
import type { DeliveryJobView } from '@resuto/contracts';
import { Card, EmptyState, Notice, Skeleton } from '@resuto/ui';
import { SchematicMap, type MapPin } from '@/components/maps/SchematicMap';
import { isolate, time } from '@/lib/format';
import { useT } from '@/lib/i18n/client';
import { useOrg } from '@/lib/org-context';
import { useApi } from '@/lib/use-api';
import type { BoardData } from './shared';

/** A driver position older than this is drawn faded. */
const STALE_MS = 10 * 60_000;

/** FT-14: dispatcher map (schematic, tile-free) of online drivers, active deliveries and their branches. */
export function DispatchMap({ branchId }: { branchId: string }) {
  const { t, locale } = useT();
  const { org } = useOrg();
  const board = useApi<BoardData>(`/o/${org.id}/delivery/board${branchId ? `?branchId=${branchId}` : ''}`, { pollMs: 15_000 });
  if (board.loading && !board.data) return <Skeleton lines={8} />;
  if (board.error) return <Notice tone="danger">{board.error.message}</Notice>;
  const b = board.data!;
  const jobs: DeliveryJobView[] = [...b.unassigned, ...b.active];
  const pins: MapPin[] = [];
  const seenBranch = new Set<string>();
  for (const j of jobs) {
    if (j.pickup.latitude !== null && j.pickup.longitude !== null && !seenBranch.has(j.branchId)) {
      seenBranch.add(j.branchId);
      pins.push({ id: `b-${j.branchId}`, kind: 'restaurant', label: j.branchName ?? t('dispatchMap.legend.branch'), latitude: j.pickup.latitude, longitude: j.pickup.longitude });
    }
    if (j.dropoff.latitude !== null && j.dropoff.longitude !== null) {
      pins.push({ id: `j-${j.id}`, kind: 'job', label: t('driver.order', { n: j.orderNumber }), latitude: j.dropoff.latitude, longitude: j.dropoff.longitude });
    }
  }
  const now = Date.now();
  for (const d of b.drivers) {
    if (!d.lastLocation || d.availability === 'offline') continue;
    const stale = now - new Date(d.lastLocation.at).getTime() > STALE_MS;
    // SVG text: the name is wrapped in Unicode isolates so an Arabic or Latin name never reorders the suffix.
    const name = isolate(d.displayName);
    pins.push({ id: `d-${d.id}`, kind: 'driver', label: stale ? [name, t('dispatchMap.stale', { time: time(d.lastLocation.at, locale) })].join(' · ') : name,
      latitude: d.lastLocation.latitude, longitude: d.lastLocation.longitude, muted: stale });
  }
  const lines: Array<[string, string]> = b.active.filter((j) => j.driverId && j.dropoff.latitude !== null).map((j) => [`d-${j.driverId}`, `j-${j.id}`]);
  const missing = jobs.filter((j) => j.dropoff.latitude === null).length;
  return (
    <Card title={t('dispatchMap.title')}>
      <p className="fine" style={{ marginTop: 0 }}>{t('dispatchMap.body')}</p>
      {pins.length === 0 ? <EmptyState title={t('dispatchMap.empty')} /> : (
        <SchematicMap label={t('dispatchMap.title')} pins={pins} lines={lines} height={360} />
      )}
      <div className="row fine" style={{ gap: 14, marginTop: 10 }}>
        <span>● {t('dispatchMap.legend.branch')}</span><span>● {t('dispatchMap.legend.job')}</span><span>● {t('dispatchMap.legend.driver')}</span>
      </div>
      {missing > 0 && <p className="fine">{t('dispatchMap.noCoords', { n: missing })}</p>}
    </Card>
  );
}
