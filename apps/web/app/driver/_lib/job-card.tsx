'use client';
import Link from 'next/link';
import type { DeliveryJobView } from '@resuto/contracts';
import { Badge, type Tone } from '@resuto/ui';
import { money, time } from '@/lib/format';
import { useT } from '@/lib/i18n/client';
import s from '../driver.module.css';

export const STATUS_TONE: Record<string, Tone> = {
  unassigned: 'neutral', offered: 'pay', assigned: 'info', accepted: 'info', picked_up: 'warn', en_route: 'warn', delivered: 'ok', failed: 'danger', cancelled: 'neutral',
};

export const addressLine = (j: DeliveryJobView) => [j.dropoff.line1, j.dropoff.area, j.dropoff.city].filter(Boolean).join(', ');
export const km = (m: number | null) => (m === null ? null : (m / 1000).toFixed(m < 10_000 ? 1 : 0));

export function JobCard({ job, offer, sequence, children }: { job: DeliveryJobView; offer?: boolean; sequence?: number; children?: React.ReactNode }) {
  const { t, locale } = useT();
  return (
    <div className={s.jobCard} data-offer={offer || undefined}>
      <Link href={`/driver/jobs/${job.id}`} style={{ textDecoration: 'none', color: 'inherit', display: 'grid', gap: 8 }}>
        <div className={s.jobTop}>
          <span className={s.jobNumber}>{sequence ? `${sequence}. ` : ''}{t('driver.order', { n: job.orderNumber })}</span>
          <Badge tone={STATUS_TONE[job.status]}>{t(`driver.status.${job.status}`)}</Badge>
        </div>
        <div className={s.address}>{addressLine(job) || '—'}</div>
        <div className={s.meta}>
          {job.dropoff.customerName && <span>👤 {job.dropoff.customerName}</span>}
          {job.distanceM !== null && <span>📍 {t('driver.distance', { km: km(job.distanceM)! })}</span>}
          {job.etaAt && <span>⏱ {t('driver.eta', { t: time(job.etaAt, locale) })}</span>}
          {job.codAmountMinor > 0 && job.cashStatus !== 'none'
            ? <span className={s.cod}>💵 {t('driver.cod')}: {money(job.codAmountMinor, job.currency, locale)}</span>
            : <span>✓ {t('driver.prepaid')}</span>}
        </div>
      </Link>
      {children}
    </div>
  );
}
