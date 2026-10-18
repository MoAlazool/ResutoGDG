import { formatMoney, type Currency } from '@resuto/contracts';
import type { Locale } from './i18n';

export const money = (minor: number | null | undefined, currency: Currency | string = 'EGP', locale: Locale = 'en') =>
  minor === null || minor === undefined ? '—' : formatMoney(minor, currency as Currency, locale);

export const dateTime = (iso: string | null | undefined, locale: Locale = 'en', timeZone?: string) =>
  iso ? new Intl.DateTimeFormat(locale === 'ar' ? 'ar-EG' : 'en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone }).format(new Date(iso)) : '—';

export const time = (iso: string | null | undefined, locale: Locale = 'en', timeZone?: string) =>
  iso ? new Intl.DateTimeFormat(locale === 'ar' ? 'ar-EG' : 'en-GB', { timeStyle: 'short', timeZone }).format(new Date(iso)) : '—';

export const pick = (locale: Locale, en: string | null | undefined, ar: string | null | undefined) => (locale === 'ar' && ar ? ar : en ?? ar ?? '');

/** Wraps user-entered text in first-strong isolates (FSI…PDI) so it keeps its own direction inside an interpolated sentence. */
export const isolate = (text: string) => `⁨${text}⁩`;
