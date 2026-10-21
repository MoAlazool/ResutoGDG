'use client';
import type { PublicDeliveryTracking } from '@resuto/contracts';
import { SchematicMap, type MapPin } from '@/components/maps/SchematicMap';
import { time } from '@/lib/format';
import { useT } from '@/lib/i18n/client';

/**
 * FT-14: delivery status, ETA and driver first name on the guest's tracking page, with a tile-free schematic map.
 * The driver's position exists only while en route (the API never sends it earlier) and is approximate.
 */
export function DeliveryPanel({ d }: { d: PublicDeliveryTracking }) {
  const { t, tn, locale } = useT();
  const closed = d.status === 'delivered' || d.status === 'failed' || d.status === 'cancelled';
  const pins: MapPin[] = [];
  if (d.restaurant) pins.push({ id: 'r', kind: 'restaurant', label: t('core.web.track.restaurant'), ...d.restaurant });
  if (d.destination) pins.push({ id: 'd', kind: 'destination', label: t('core.web.track.you'), ...d.destination });
  if (d.driver) pins.push({ id: 'v', kind: 'driver', label: t('core.web.track.driverPin'), latitude: d.driver.latitude, longitude: d.driver.longitude });
  const soon = d.etaAt && new Date(d.etaAt).getTime() <= Date.now();
  return (
    <section aria-live="polite" style={{ marginBlock: 14, padding: 16, display: 'grid', gap: 10, background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 16, boxShadow: 'var(--shadow-card)' }}>
      <span className="gx-overline">{t('core.web.track.title')}</span>
      <strong style={{ fontSize: 18 }}>{t(`core.web.track.status.${d.status}`)}</strong>
      {d.driverFirstName && !closed && <span>{tn('core.web.track.driver', { name: <bdi>{d.driverFirstName}</bdi> })}</span>}
      {d.etaAt && !closed && <span className="gx-fine">{soon ? t('core.web.track.etaSoon') : t('core.web.track.eta', { time: time(d.etaAt, locale) })}</span>}
      {!closed && pins.length >= 2 && (
        <SchematicMap label={t('core.web.track.mapLabel')} pins={pins} lines={d.driver ? [['r', 'v'], ['v', 'd']] : [['r', 'd']]} height={200} />
      )}
      {!closed && (d.driver
        ? <span className="gx-fine">{t('core.web.track.positionNote', { time: time(d.driver.at, locale) })}</span>
        : <span className="gx-fine">{t('core.web.track.noPosition')}</span>)}
    </section>
  );
}
