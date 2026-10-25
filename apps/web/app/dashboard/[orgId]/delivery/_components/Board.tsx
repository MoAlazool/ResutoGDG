'use client';
import { lazy, Suspense, useState, type ReactNode } from 'react';
import type { DeliveryJobView } from '@resuto/contracts';
import { Card, EmptyState, Notice, Skeleton, Stat, useAction } from '@resuto/ui';
import { formatElapsed, money, time } from '@/lib/format';
import { useT } from '@/lib/i18n/client';
import { useOrg } from '@/lib/org-context';
import { useApi } from '@/lib/use-api';
import { useSession } from '@/lib/session';
import { AssignControl, Availability, DriverChips, JobStatus, addressOf, type BoardData } from './shared';
import { JobSheet } from './JobSheet';

// The map is drawn on demand (inline SVG, no tiles; the map provider behaviour is unchanged).
const DispatchMap = lazy(() => import('./DispatchMap').then((m) => ({ default: m.DispatchMap })));

/**
 * Dispatch (21-OPS): the live map beside the board, polled every 10 s from one read: drivers as status chips,
 * waiting jobs (assign or offer), jobs on the road, the roster, recently closed. A job opens in a sheet.
 */
export function Board({ branchId }: { branchId: string }) {
  const { t, locale } = useT();
  const { org, can } = useOrg();
  const { call } = useSession();
  const board = useApi<BoardData>(`/o/${org.id}/delivery/board${branchId ? `?branchId=${branchId}` : ''}`, { pollMs: 10_000 });
  const [open, setOpen] = useState<string | null>(null);
  const act = useAction(async (fn: () => Promise<unknown>) => { await fn(); await board.reload(); });
  const assign = (job: DeliveryJobView) => (driverId: string, mode: 'assign' | 'offer') =>
    void act.run(() => call(`/o/${org.id}/delivery/jobs/${job.id}/assign`, { body: { driverId, mode } }));

  if (board.loading && !board.data) return <Skeleton lines={8} />;
  if (board.error && !board.data) return <Notice tone="danger">{board.error.message} <button className="btn btn-sm" onClick={() => void board.reload()}>{t('action.retry')}</button></Notice>;
  const b = board.data!;
  const online = b.drivers.filter((d) => d.availability !== 'offline');
  const canDispatch = can('delivery:dispatch');

  const jobRow = (j: DeliveryJobView, controls: ReactNode) => (
    <div key={j.id} className="card dispatch-job" data-status={j.status}>
      <div className="spread">
        <button className="btn btn-ghost btn-sm dispatch-job-ref" onClick={() => setOpen(j.id)}>
          {t('driver.order', { n: j.orderNumber })}
        </button>
        <div className="row gap-6">
          <JobStatus status={j.status} />
          <span className="fine num">{t('driver.dispatch.age', { elapsed: formatElapsed(j.createdAt, locale) })}</span>
        </div>
      </div>
      <div className="dispatch-job-address"><bdi>{addressOf(j) || '—'}</bdi></div>
      <div className="row fine gap-10">
        {j.driverName && <span><bdi>{j.driverName}</bdi></span>}
        {j.offer && <span className="num">{t('driver.dispatch.offerExpires', { t: time(j.offer.expiresAt, locale) })}</span>}
        {j.etaAt && <span className="num">{t('driver.eta', { t: time(j.etaAt, locale) })}</span>}
        <span className="num">{j.codAmountMinor > 0 && j.cashStatus !== 'none' ? `${t('driver.cod')}: ${money(j.codAmountMinor, j.currency, locale)}` : t('driver.prepaid')}</span>
        <span>{t(`driver.orderState.${j.orderStatus}`)}</span>
        {j.failureReason && <span className="dispatch-fail">{t(`driver.fail.reasons.${j.failureReason}`)}</span>}
      </div>
      {canDispatch && controls}
    </div>
  );

  return (
    <div className="stack">
      <div className="grid grid-4">
        <Stat label={t('driver.dispatch.unassigned')} value={b.unassigned.length} tone={b.unassigned.length ? 'warn' : undefined} />
        <Stat label={t('driver.dispatch.active')} value={b.active.length} />
        <Stat label={t('driver.dispatch.onlineDrivers')} value={`${online.length} / ${b.drivers.length}`} />
        <Stat label={t('driver.dispatch.deliveredRecent')} value={b.recent.filter((j) => j.status === 'delivered').length} />
      </div>
      {b.drivers.length > 0 && <DriverChips drivers={b.drivers} />}
      {act.error && <Notice tone="danger">{act.error}</Notice>}
      <div className="dispatch-layout">
        <div className="dispatch-map">
          <Suspense fallback={<div className="card"><Skeleton lines={8} /></div>}><DispatchMap branchId={branchId} data={b} /></Suspense>
        </div>
        <div className="dispatch-lanes">
          <Card title={t('driver.dispatch.unassigned')}>
            <div className="stack">
              {b.unassigned.length ? b.unassigned.map((j) => jobRow(j, (
                <AssignControl job={j} drivers={b.drivers} pending={act.pending} onAssign={assign(j)} />
              ))) : <EmptyState title={t('driver.dispatch.empty')} />}
            </div>
          </Card>
          <Card title={t('driver.dispatch.active')}>
            <div className="stack">
              {b.active.length ? b.active.map((j) => jobRow(j, ['assigned', 'accepted'].includes(j.status) ? (
                <div className="stack gap-6">
                  <AssignControl job={j} drivers={b.drivers.filter((d) => d.id !== j.driverId)} pending={act.pending} onAssign={assign(j)} compact />
                  <div><button className="btn btn-sm btn-ghost" disabled={act.pending} onClick={() => void act.run(() => call(`/o/${org.id}/delivery/jobs/${j.id}/unassign`, { body: {} }))}>{t('driver.dispatch.unassign')}</button></div>
                </div>
              ) : null)) : <EmptyState title={t('driver.dispatch.noActive')} />}
            </div>
          </Card>
        </div>
      </div>
      <Card title={t('driver.dispatch.drivers')}>
        <div className="stack gap-8">
          {b.drivers.length ? b.drivers.map((d) => (
            <div key={d.id} className="spread dispatch-driver">
              <div>
                <strong>{d.displayName}</strong>
                <div className="fine num">
                  {t(`driver.vehicle.${d.vehicleType}`)}
                  {d.activeJobs ? ` · ${t('driver.dispatch.activeJobs', { n: d.activeJobs })}` : ''}
                  {d.cashOnHandMinor ? ` · ${t('driver.cash.onHand')}: ${money(d.cashOnHandMinor, org.currency, locale)}` : ''}
                </div>
                <div className="fine num">{d.lastLocation ? t('driver.dispatch.lastSeen', { t: time(d.lastLocation.at, locale) }) : t('driver.dispatch.noLocation')}</div>
              </div>
              <Availability driver={d} />
            </div>
          )) : <EmptyState title={t('driver.dispatch.noDrivers')}>{t('driver.dispatch.noDriversHint')}</EmptyState>}
        </div>
      </Card>
      {!!b.recent.length && (
        <Card title={t('driver.dispatch.recent')}>
          <div className="stack">{b.recent.map((j) => jobRow(j, null))}</div>
        </Card>
      )}
      <p className="fine num">{t('driver.dispatch.updated', { t: time(b.generatedAt, locale) })} · {t('driver.dispatch.etaNote')}</p>
      {open && <JobSheet jobId={open} onClose={() => setOpen(null)} onChanged={() => void board.reload()} />}
    </div>
  );
}
