'use client';
import { useState } from 'react';
import type { DeliveryJobView } from '@resuto/contracts';
import { Card, EmptyState, Notice, Skeleton, Stat, useAction } from '@resuto/ui';
import { money, time } from '@/lib/format';
import { useT } from '@/lib/i18n/client';
import { useOrg } from '@/lib/org-context';
import { useApi } from '@/lib/use-api';
import { useSession } from '@/lib/session';
import { AssignControl, Availability, JobStatus, addressOf, type BoardData } from './shared';
import { JobModal } from './JobModal';

const ageMin = (iso: string) => Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60_000));

/** Live dispatch board (polls every 10 s): waiting jobs, jobs on the road, drivers, recently closed. */
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
  if (board.error) return <Notice tone="danger">{board.error.message} <button className="btn btn-sm" onClick={() => void board.reload()}>{t('action.retry')}</button></Notice>;
  const b = board.data!;
  const online = b.drivers.filter((d) => d.availability !== 'offline');
  const canDispatch = can('delivery:dispatch');

  const jobRow = (j: DeliveryJobView, controls: React.ReactNode) => (
    <div key={j.id} className="card" style={{ padding: 14, display: 'grid', gap: 8 }}>
      <div className="spread">
        <button className="btn btn-ghost btn-sm" style={{ paddingInline: 0, fontWeight: 750 }} onClick={() => setOpen(j.id)}>
          {t('driver.order', { n: j.orderNumber })}
        </button>
        <div className="row" style={{ gap: 6 }}>
          <JobStatus status={j.status} />
          <span className="fine">{t('driver.dispatch.age', { m: ageMin(j.createdAt) })}</span>
        </div>
      </div>
      <div style={{ fontSize: 14 }}><bdi>{addressOf(j) || '—'}</bdi></div>
      <div className="row fine" style={{ gap: 10 }}>
        {j.driverName && <span>🛵 <bdi>{j.driverName}</bdi></span>}
        {j.offer && <span>{t('driver.dispatch.offerExpires', { t: time(j.offer.expiresAt, locale) })}</span>}
        {j.etaAt && <span>⏱ {t('driver.eta', { t: time(j.etaAt, locale) })}</span>}
        <span>{j.codAmountMinor > 0 && j.cashStatus !== 'none' ? `💵 ${money(j.codAmountMinor, j.currency, locale)}` : t('driver.prepaid')}</span>
        <span>{t(`driver.orderState.${j.orderStatus}`)}</span>
        {j.failureReason && <span style={{ color: 'var(--danger)' }}>{t(`driver.fail.reasons.${j.failureReason}`)}</span>}
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
      {act.error && <Notice tone="danger">{act.error}</Notice>}
      <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', alignItems: 'start' }}>
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
              <div className="stack" style={{ gap: 6 }}>
                <AssignControl job={j} drivers={b.drivers.filter((d) => d.id !== j.driverId)} pending={act.pending} onAssign={assign(j)} compact />
                <div><button className="btn btn-sm btn-ghost" disabled={act.pending} onClick={() => void act.run(() => call(`/o/${org.id}/delivery/jobs/${j.id}/unassign`, { body: {} }))}>{t('driver.dispatch.unassign')}</button></div>
              </div>
            ) : null)) : <EmptyState title={t('driver.dispatch.noActive')} />}
          </div>
        </Card>
        <Card title={t('driver.dispatch.drivers')}>
          <div className="stack" style={{ gap: 8 }}>
            {b.drivers.length ? b.drivers.map((d) => (
              <div key={d.id} className="spread" style={{ borderBlockEnd: '1px solid var(--line-soft)', paddingBlockEnd: 8 }}>
                <div>
                  <strong>{d.displayName}</strong>
                  <div className="fine">
                    {t(`driver.vehicle.${d.vehicleType}`)}
                    {d.activeJobs ? ` · ${t('driver.dispatch.activeJobs', { n: d.activeJobs })}` : ''}
                    {d.cashOnHandMinor ? ` · 💵 ${money(d.cashOnHandMinor, org.currency, locale)}` : ''}
                  </div>
                  <div className="fine">{d.lastLocation ? t('driver.dispatch.lastSeen', { t: time(d.lastLocation.at, locale) }) : t('driver.dispatch.noLocation')}</div>
                </div>
                <Availability driver={d} />
              </div>
            )) : <EmptyState title={t('driver.dispatch.noDrivers')}>{t('driver.dispatch.noDriversHint')}</EmptyState>}
          </div>
        </Card>
      </div>
      {!!b.recent.length && (
        <Card title={t('driver.dispatch.recent')}>
          <div className="stack">{b.recent.map((j) => jobRow(j, null))}</div>
        </Card>
      )}
      <p className="fine">{t('driver.dispatch.updated', { t: time(b.generatedAt, locale) })} · {t('driver.dispatch.etaNote')}</p>
      {open && <JobModal jobId={open} onClose={() => setOpen(null)} onChanged={() => void board.reload()} />}
    </div>
  );
}
