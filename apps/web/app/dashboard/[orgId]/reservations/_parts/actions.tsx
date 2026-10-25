'use client';
import type { ReservationView } from '@resuto/contracts';
import type { Tone } from '@resuto/ui';
import { useT } from '@/lib/i18n/client';

export const resTone = (s: string): Tone => ({ held: 'warn', pending_deposit: 'pay', confirmed: 'info', seated: 'ok', completed: 'neutral', cancelled: 'danger', no_show: 'danger', expired: 'neutral' } as Record<string, Tone>)[s] ?? 'neutral';
export const isClosed = (s: string) => ['cancelled', 'expired', 'no_show'].includes(s);

export interface ResActions { checkIn(r: ReservationView): void; noShow(r: ReservationView): void; cancel(r: ReservationView): void }

/** Check in, no-show and cancel for one booking (the list rows and the reservation sheet share them). */
export function ReservationActions({ r, canWrite, canSeat, actions, now = Date.now() }: { r: ReservationView; canWrite: boolean; canSeat: boolean; actions: ResActions; now?: number }) {
  const { t } = useT();
  if (!canWrite) return null;
  return (
    <div className="row">
      {r.status === 'confirmed' && canSeat && <button className="btn btn-sm btn-primary" onClick={() => actions.checkIn(r)}>{t('core.resdash.checkIn')}</button>}
      {r.status === 'confirmed' && Date.parse(r.startsAt) < now && <button className="btn btn-sm" onClick={() => actions.noShow(r)}>{t('core.resdash.noShow')}</button>}
      {['held', 'pending_deposit', 'confirmed'].includes(r.status) && <button className="btn btn-sm btn-danger" onClick={() => actions.cancel(r)}>{t('core.res.cancel')}</button>}
    </div>
  );
}
