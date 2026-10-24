import type { Locale } from './i18n/locale';

/**
 * The Arabic or English name of a record for the page language (falls back to whichever exists). Its own module so
 * the staff shell, which needs only this, does not pull every formatter into the layout (21-SHELL bundle budget).
 */
export const pick = (locale: Locale, en: string | null | undefined, ar: string | null | undefined) => (locale === 'ar' && ar ? ar : en ?? ar ?? '');
