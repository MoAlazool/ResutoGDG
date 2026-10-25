'use client';
import { useState } from 'react';
import type { DeliveryJobView, DriverView } from '@resuto/contracts';
import { Badge, type Tone } from '@resuto/ui';
import { time } from '@/lib/format';
import { useT } from '@/lib/i18n/client';

export interface BoardData {
  unassigned: DeliveryJobView[];
  active: DeliveryJobView[];
  recent: DeliveryJobView[];
  drivers: DriverView[];
  generatedAt: string;
}

export const JOB_TONE: Record<string, Tone> = {
  unassigned: 'warn', offered: 'pay', assigned: 'info', accepted: 'info', picked_up: 'warn', en_route: 'warn', delivered: 'ok', failed: 'danger', cancelled: 'neutral',
};
export const AVAIL_TONE: Record<string, Tone> = { available: 'ok', busy: 'warn', break: 'info', offline: 'neutral' };

export function JobStatus({ status }: { status: string }) {
  const { t } = useT();
  return <Badge tone={JOB_TONE[status]}>{t(`driver.status.${status}`)}</Badge>;
}

export function Availability({ driver }: { driver: Pick<DriverView, 'availability' | 'status'> }) {
  const { t } = useT();
  if (driver.status === 'suspended') return <Badge tone="danger">{t('driver.dispatch.suspended')}</Badge>;
  return <Badge tone={AVAIL_TONE[driver.availability]}>{t(`driver.availability.${driver.availability}`)}</Badge>;
}

/** Availability order on the dispatch screen: who can take a job first. */
export const AVAILABILITY_ORDER = ['available', 'busy', 'break', 'offline'] as const;

/** Drivers sorted for the status chips: suspended last, then by availability, then by name. */
export function sortDriversForChips<D extends Pick<DriverView, 'availability' | 'status' | 'displayName'>>(drivers: readonly D[]): D[] {
  const rank = (d: D) => (d.status === 'suspended' ? 99 : (AVAILABILITY_ORDER as readonly string[]).indexOf(d.availability));
  return [...drivers].sort((a, b) => rank(a) - rank(b) || a.displayName.localeCompare(b.displayName));
}

/**
 * Driver status chips (21-OPS): one chip per driver with an availability dot, their open jobs and a stale-position
 * mark, in the order a dispatcher reads them (available first). A summary counts each availability.
 */
export function DriverChips({ drivers }: { drivers: DriverView[] }) {
  const { t, locale } = useT();
  const counts = AVAILABILITY_ORDER.map((a) => [a, drivers.filter((d) => d.status !== 'suspended' && d.availability === a).length] as const).filter(([, n]) => n > 0);
  return (
    <section className="driver-chips" aria-label={t('driver.dispatch.drivers')}>
      <p className="driver-chips-summary num">{counts.map(([a, n]) => `${n} ${t(`driver.availability.${a}`)}`).join(' · ')}</p>
      <ul>
        {sortDriversForChips(drivers).map((d) => {
          const state = d.status === 'suspended' ? 'suspended' : d.availability;
          return (
            <li key={d.id} className="driver-chip" data-availability={state}>
              <span className="driver-chip-dot" aria-hidden="true" />
              <bdi className="driver-chip-name">{d.displayName}</bdi>
              <span className="driver-chip-state">{state === 'suspended' ? t('driver.dispatch.suspended') : t(`driver.availability.${d.availability}`)}</span>
              {d.activeJobs > 0 && <span className="driver-chip-jobs num">{t('driver.dispatch.activeJobs', { n: d.activeJobs })}</span>}
              {d.lastLocation && <span className="driver-chip-seen num">{time(d.lastLocation.at, locale)}</span>}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

export const addressOf =(j: DeliveryJobView) => [j.dropoff.line1, j.dropoff.area, j.dropoff.city].filter(Boolean).join(', ');

/** Driver picker + assign / offer buttons. */
export function AssignControl({ job, drivers, onAssign, pending, compact }: {
  job: DeliveryJobView; drivers: DriverView[]; pending: boolean; compact?: boolean;
  onAssign(driverId: string, mode: 'assign' | 'offer'): void;
}) {
  const { t, locale } = useT();
  const eligible = drivers.filter((d) => d.status === 'active' && (!d.branchIds || d.branchIds.includes(job.branchId)));
  const [driverId, setDriverId] = useState('');
  const chosen = eligible.find((d) => d.id === driverId);
  const canOffer = chosen && (chosen.availability === 'available' || chosen.availability === 'busy');
  if (!eligible.length) return <span className="fine">{t('driver.dispatch.noEligible')}</span>;
  return (
    <div className="row gap-6">
      <select className="select dispatch-driver-select" data-compact={compact || undefined} value={driverId} onChange={(e) => setDriverId(e.target.value)} aria-label={t('driver.dispatch.chooseDriver')}>
        <option value="">{t('driver.dispatch.chooseDriver')}</option>
        {eligible.map((d) => (
          <option key={d.id} value={d.id}>
            {d.displayName} · {t(`driver.availability.${d.availability}`)}{d.activeJobs ? ` · ${t('driver.dispatch.activeJobs', { n: d.activeJobs })}` : ''}
            {d.lastLocation ? ` · ${time(d.lastLocation.at, locale)}` : ''}
          </option>
        ))}
      </select>
      <button className="btn btn-sm btn-primary" disabled={!driverId || pending} onClick={() => onAssign(driverId, 'assign')}>{t('driver.dispatch.assign')}</button>
      <button className="btn btn-sm" disabled={!canOffer || pending} title={chosen && !canOffer ? t('driver.dispatch.offerNeedsOnline') : undefined} onClick={() => onAssign(driverId, 'offer')}>{t('driver.dispatch.offer')}</button>
    </div>
  );
}
