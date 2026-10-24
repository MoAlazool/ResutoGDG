import {
  dateTimeFormat, formatCompact, formatDate, formatDateTime, formatMoney, formatNumber, formatPercent, formatTime, numberFormat, type Currency,
} from '@resuto/contracts/lite';
import type { Locale } from './i18n/locale';

// Display formatting for the web app. Everything delegates to @resuto/contracts (locale-format.ts), which pins
// Western digits 0-9 in Arabic and English and is shared with the API, so server and client output match.

export const money = (minor: number | null | undefined, currency: Currency | string = 'EGP', locale: Locale = 'en') =>
  minor === null || minor === undefined ? '—' : formatMoney(minor, currency as Currency, locale);

/**
 * Money on guest surfaces (menu, cart, bill, order status, payment, booking): always with its minor digits, like legacy
 * ("EGP 145.00", PAR-07). Staff screens keep `money` (whole amounts without ".00"). Western digits in Arabic too.
 */
export const guestMoney = (minor: number | null | undefined, currency: Currency | string = 'EGP', locale: Locale = 'en') =>
  minor === null || minor === undefined ? '—' : formatMoney(minor, currency as Currency, locale, { decimals: 'always' });

export const dateTime = (iso: string | null | undefined, locale: Locale = 'en', timeZone?: string) => formatDateTime(iso, locale, timeZone);

export const time = (iso: string | null | undefined, locale: Locale = 'en', timeZone?: string) => formatTime(iso, locale, timeZone);

export const date = (iso: string | null | undefined, locale: Locale = 'en', timeZone?: string) => formatDate(iso, locale, timeZone);

export const num = (n: number | null | undefined, locale: Locale = 'en', maximumFractionDigits = 2) => formatNumber(n, locale, { maximumFractionDigits });

/** Fraction → "15%". */
export const pct = (fraction: number | null | undefined, locale: Locale = 'en', maximumFractionDigits = 1) => formatPercent(fraction, locale, maximumFractionDigits);

export const compact = (n: number | null | undefined, locale: Locale = 'en') => formatCompact(n, locale);

export { pick } from './pick';

/** Wraps user-entered text in first-strong isolates (FSI…PDI) so it keeps its own direction inside an interpolated sentence. */
export const isolate = (text: string) => `⁨${text}⁩`;


// --- Human-friendly durations and timestamps (VS-30) ------------------------------------------------------------
// "20382 min" or "2839:59" for an order that has been open for two weeks is noise. Durations switch unit as they
// grow, and timestamps say "Yesterday 22:05" or carry the date when they are not from today. Western digits always.

const MIN = 60_000;
const unit = (locale: Locale, u: 'minute' | 'hour' | 'day', display: 'short' | 'narrow' | 'long') =>
  numberFormat(locale, { style: 'unit', unit: u, unitDisplay: display });

/** Elapsed time from milliseconds: "14 mins", "3h 5m", "2 days" (Arabic: "14 د", "3 س 5 د", "2 يومان"). */
export function formatElapsedMs(ms: number | null | undefined, locale: Locale = 'en'): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '—';
  const minutes = Math.max(0, Math.floor(ms / MIN));
  if (minutes < 60) return unit(locale, 'minute', 'short').format(minutes);
  if (minutes < 24 * 60) {
    const h = Math.floor(minutes / 60), m = minutes % 60;
    return m ? `${unit(locale, 'hour', 'narrow').format(h)} ${unit(locale, 'minute', 'narrow').format(m)}` : unit(locale, 'hour', 'long').format(h);
  }
  return unit(locale, 'day', 'long').format(Math.floor(minutes / (24 * 60)));
}

/** Elapsed time since an ISO timestamp (or epoch ms) until `now`. */
export const formatElapsed = (since: string | number | null | undefined, locale: Locale = 'en', now = Date.now()) =>
  since === null || since === undefined || since === '' ? '—' : formatElapsedMs(now - (typeof since === 'number' ? since : Date.parse(since)), locale);

/** Calendar day key of an instant in a time zone. */
const dayKey = (d: Date, timeZone?: string) => dateTimeFormat('en', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);

/**
 * When something happened: the time for today ("22:05"), "Yesterday 22:05", the weekday within the last week
 * ("Mon 22:05"), otherwise the date and time ("12 Oct 2026, 22:05"). In the restaurant's time zone when given.
 */
export function formatWhen(v: string | number | Date | null | undefined, locale: Locale = 'en', timeZone?: string, now: number = Date.now()): string {
  if (v === null || v === undefined || v === '') return '—';
  const d = v instanceof Date ? v : new Date(v);
  if (Number.isNaN(d.getTime())) return '—';
  const clock = formatTime(d, locale, timeZone);
  const today = dayKey(new Date(now), timeZone);
  if (dayKey(d, timeZone) === today) return clock;
  if (dayKey(d, timeZone) === dayKey(new Date(now - 864e5), timeZone)) {
    const y = new Intl.RelativeTimeFormat(locale === 'ar' ? 'ar' : 'en', { numeric: 'auto' }).format(-1, 'day');
    return `${locale === 'ar' ? y : y.charAt(0).toUpperCase() + y.slice(1)} ${clock}`;
  }
  if (now - d.getTime() < 6 * 864e5 && d.getTime() <= now) return `${dateTimeFormat(locale, { weekday: 'short', timeZone }).format(d)} ${clock}`;
  return formatDateTime(d, locale, timeZone);
}
