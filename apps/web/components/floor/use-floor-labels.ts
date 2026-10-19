'use client';
import { INTL_LOCALE } from '@resuto/contracts';
import { useMemo } from 'react';
import { useT } from '@/lib/i18n/client';

/** Localised labels for floor drawings: seat counts and the standard zone/object names. */
export function useFloorLabels() {
  const { t, locale } = useT();
  return useMemo(() => {
    const nf = new Intl.NumberFormat(locale === 'ar' ? INTL_LOCALE.ar : 'en-US');
    const labelOf = (label: string) => {
      const key = `studio.floor.label.${label}`;
      const v = t(key);
      return v === key ? label : v;
    };
    return {
      locale,
      t,
      nf,
      seatsLabel: (n: number) => t('studio.floor.seats', { n: nf.format(n) }),
      labelOf,
      selectAria: (label: string) => t('studio.floor.selectObject', { label }),
    };
  }, [t, locale]);
}
