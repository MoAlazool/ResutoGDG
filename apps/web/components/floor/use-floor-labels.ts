'use client';
import { INTL_LOCALE } from '@resuto/contracts';
import { useMemo } from 'react';
import { useT } from '@/lib/i18n/client';
import { labelForms } from './labels';

/** Localised labels for floor drawings: seat counts and the standard zone/object names. */
export function useFloorLabels() {
  const { t, locale } = useT();
  return useMemo(() => {
    const nf = new Intl.NumberFormat(locale === 'ar' ? INTL_LOCALE.ar : 'en-US');
    const labelOf = (label: string) => {
      for (const form of labelForms(label)) {
        const key = `studio.floor.label.${form}`;
        const v = t(key);
        if (v !== key) return v;
      }
      return label;
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
