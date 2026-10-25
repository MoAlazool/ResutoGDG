'use client';
import type { ReservationView } from '@resuto/contracts';
import { Badge, Code, Phone, Sheet, UserText } from '@resuto/ui';
import { money, time } from '@/lib/format';
import { useT } from '@/lib/i18n/client';
import { useOrg } from '@/lib/org-context';
import { ReservationActions, resTone, type ResActions } from './actions';

/** One booking in a sheet at the reading end (opened from a timeline bar): details and its actions. */
export function ReservationSheet({ r, onClose, actions }: { r: ReservationView; onClose: () => void; actions: ResActions }) {
  const { t, locale } = useT();
  const { org, can } = useOrg();
  return (
    <Sheet open onClose={onClose} size="sm" title={r.guestName}
      description={`${time(r.startsAt, locale, org.timezone)}–${time(r.endsAt, locale, org.timezone)} · ${t('core.res.guests', { n: r.partySize })}`}
      footer={<ReservationActions r={r} canWrite={can('reservations:write')} canSeat={can('floor:seat')} actions={actions} />}>
      <div className="stack">
        <div className="row"><Badge tone={resTone(r.status)}>{t(`core.res.status.${r.status}`)}</Badge>{r.tableLabel && <Badge>{t('core.kds.table', { label: r.tableLabel })}</Badge>}</div>
        <dl className="res-facts">
          <dt>{t('ops.res.code')}</dt><dd><Code>{r.code}</Code></dd>
          <dt>{t('core.resdash.source')}</dt><dd>{t(`core.res.source.${r.source}`)}</dd>
          {r.guestPhone && <><dt>{t('core.web.phone')}</dt><dd><Phone value={r.guestPhone} link /></dd></>}
          {r.depositMinor > 0 && <><dt>{t('core.res.deposit')}</dt><dd><span className="num">{money(r.depositMinor, r.currency, locale)}</span> · {t(`core.res.deposit.${r.depositStatus}`)}</dd></>}
          {r.notes && <><dt>{t('core.res.notes')}</dt><dd>“<UserText>{r.notes}</UserText>”</dd></>}
        </dl>
      </div>
    </Sheet>
  );
}
