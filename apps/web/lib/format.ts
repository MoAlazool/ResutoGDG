import {
  formatCompact, formatDate, formatDateTime, formatMoney, formatNumber, formatPercent, formatTime, type Currency,
} from '@resuto/contracts';
import type { Locale } from './i18n';

// Display formatting for the web app. Everything delegates to @resuto/contracts (locale-format.ts), which pins
// Western digits 0-9 in Arabic and English and is shared with the API, so server and client output match.

export const money = (minor: number | null | undefined, currency: Currency | string = 'EGP', locale: Locale = 'en') =>
  minor === null || minor === undefined ? '—' : formatMoney(minor, currency as Currency, locale);

export const dateTime = (iso: string | null | undefined, locale: Locale = 'en', timeZone?: string) => formatDateTime(iso, locale, timeZone);

export const time = (iso: string | null | undefined, locale: Locale = 'en', timeZone?: string) => formatTime(iso, locale, timeZone);

export const date = (iso: string | null | undefined, locale: Locale = 'en', timeZone?: string) => formatDate(iso, locale, timeZone);

export const num = (n: number | null | undefined, locale: Locale = 'en', maximumFractionDigits = 2) => formatNumber(n, locale, { maximumFractionDigits });

/** Fraction → "15%". */
export const pct = (fraction: number | null | undefined, locale: Locale = 'en', maximumFractionDigits = 1) => formatPercent(fraction, locale, maximumFractionDigits);

export const compact = (n: number | null | undefined, locale: Locale = 'en') => formatCompact(n, locale);

export const pick = (locale: Locale, en: string | null | undefined, ar: string | null | undefined) => (locale === 'ar' && ar ? ar : en ?? ar ?? '');

/** Wraps user-entered text in first-strong isolates (FSI…PDI) so it keeps its own direction inside an interpolated sentence. */
export const isolate = (text: string) => `⁨${text}⁩`;
