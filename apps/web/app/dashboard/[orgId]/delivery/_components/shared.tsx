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

export const addressOf = (j: DeliveryJobView) => [j.dropoff.line1, j.dropoff.area, j.dropoff.city].filter(Boolean).join(', ');

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
      <select className="select" style={{ minHeight: 36, padding: '4px 8px', width: compact ? 160 : 200 }} value={driverId} onChange={(e) => setDriverId(e.target.value)} aria-label={t('driver.dispatch.chooseDriver')}>
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
