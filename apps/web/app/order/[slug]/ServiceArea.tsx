'use client';
import { useEffect, useState } from 'react';
import type { PublicServiceArea } from '@resuto/contracts';
import { api } from '@/lib/api';
import { dateTime, guestMoney as money } from '@/lib/format';
import { useT } from '@/lib/i18n/client';

/** FT-09: what the checkout sends for opening hours and delivery coverage (the server decides; this only informs). */
export interface AreaChoice {
  zoneId: string | null;
  point: { latitude: number; longitude: number } | null;
  scheduledFor: string | null;
}
export const NO_CHOICE: AreaChoice = { zoneId: null, point: null, scheduledFor: null };

/** Server refusal codes this checkout explains in the guest's language. */
export const AREA_ERRORS = new Set(['branch_closed', 'scheduled_while_closed', 'scheduled_in_past', 'scheduled_too_far', 'outside_delivery_area',
  'location_required', 'delivery_zone_required', 'delivery_zone_invalid', 'below_minimum']);

export function useServiceArea(slug: string, branchId: string) {
  const [area, setArea] = useState<PublicServiceArea | null>(null);
  useEffect(() => {
    let live = true;
    api<PublicServiceArea>(`/public/order/${encodeURIComponent(slug)}/service-area?branchId=${encodeURIComponent(branchId)}`)
      .then((a) => { if (live) setArea(a); }).catch(() => { if (live) setArea(null); });
    return () => { live = false; };
  }, [slug, branchId]);
  return area;
}

/** Closed-now notice with "schedule for opening", and the delivery-area picker / location share for delivery. */
export function ServiceAreaFields({ area, fulfillment, currency, value, onChange }: {
  area: PublicServiceArea | null; fulfillment: 'pickup' | 'delivery'; currency: string; value: AreaChoice; onChange(v: AreaChoice): void;
}) {
  const { t, locale } = useT();
  const [locating, setLocating] = useState<'idle' | 'busy' | 'denied'>('idle');
  if (!area) return null;
  const when = (iso: string) => dateTime(iso, locale, area.timezone);
  // Schedule a quarter of an hour after opening so the kitchen is ready.
  const slot = area.nextOpenAt ? new Date(new Date(area.nextOpenAt).getTime() + 15 * 60_000).toISOString() : null;
  const zones = fulfillment === 'delivery' ? area.delivery.zones : [];
  const chosen = zones.find((z) => z.id === value.zoneId) ?? null;
  const m = (v: number) => money(v, currency, locale);

  function locate() {
    if (!('geolocation' in navigator)) { setLocating('denied'); return; }
    setLocating('busy');
    navigator.geolocation.getCurrentPosition(
      (pos) => { setLocating('idle'); onChange({ ...value, point: { latitude: pos.coords.latitude, longitude: pos.coords.longitude } }); },
      () => setLocating('denied'), { enableHighAccuracy: false, timeout: 10_000, maximumAge: 300_000 });
  }

  return (
    <>
      {!area.openNow && (
        <div className="gx-note is-warn" role="status">
          {slot ? t('core.web.area.closed', { when: when(area.nextOpenAt!) }) : t('core.web.area.closedNoNext')}
          {slot && (
            <label style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8 }}>
              <input type="checkbox" checked={value.scheduledFor === slot} onChange={(e) => onChange({ ...value, scheduledFor: e.target.checked ? slot : null })} />
              <span>{t('core.web.area.schedule', { when: when(slot) })}</span>
            </label>
          )}
        </div>
      )}
      {zones.length > 0 && (
        <>
          <label className="gx-field"><span>{t('core.web.area.zone')}</span>
            <select required={!value.point} value={value.zoneId ?? ''} onChange={(e) => onChange({ ...value, zoneId: e.target.value || null })}>
              <option value="">{t('core.web.area.chooseZone')}</option>
              {zones.map((z) => <option key={z.id} value={z.id}>{t('core.web.area.zoneOption', { name: locale === 'ar' && z.nameAr ? z.nameAr : z.name, fee: m(z.feeMinor) })}</option>)}
            </select>
            {chosen && (
              <small className="gx-fine">
                {[chosen.minOrderMinor > 0 ? t('core.web.area.zoneMin', { min: m(chosen.minOrderMinor) }) : null,
                  chosen.etaMin ? t('core.web.area.zoneEta', { min: chosen.etaMin }) : null].filter(Boolean).join(' · ')}
                {chosen.kind !== 'area' && !value.point ? ` ${t('core.web.area.needsLocation')}` : ''}
              </small>
            )}
          </label>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBlockEnd: 8 }}>
            <button type="button" className="gx-btn" onClick={locate} disabled={locating === 'busy'}>
              {locating === 'busy' ? t('core.web.area.locating') : t('core.web.area.useLocation')}
            </button>
            {value.point && <span className="gx-fine">{t('core.web.area.located')}</span>}
            {locating === 'denied' && <span className="gx-fine">{t('core.web.area.locationDenied')}</span>}
          </div>
        </>
      )}
    </>
  );
}
