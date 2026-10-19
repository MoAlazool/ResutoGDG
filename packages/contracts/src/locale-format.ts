/**
 * The one place system-formatted numbers, dates and times are produced.
 *
 * Policy: Arabic stays Arabic and right-to-left, but every system-formatted number uses Western digits 0-9
 * (`numberingSystem: 'latn'`), in both languages, on the server and in the browser alike (so server-rendered
 * and hydrated output match). Stored amounts, timestamps and identifiers are never changed; this is display only.
 */
export type DisplayLocale = 'en' | 'ar';

/** BCP 47 tags with the Latin numbering system pinned (`-u-nu-latn`), so even `toLocaleString(tag)` keeps 0-9. */
export const INTL_LOCALE: Record<DisplayLocale, string> = { en: 'en-GB', ar: 'ar-EG-u-nu-latn' };
/** Money keeps the regional English variant used since the first release ("EGP 1,250.50"). */
const MONEY_LOCALE: Record<DisplayLocale, string> = { en: 'en-EG', ar: 'ar-EG-u-nu-latn' };

export const intlLocale = (locale: DisplayLocale | string | null | undefined): string =>
  locale === 'ar' ? INTL_LOCALE.ar : INTL_LOCALE.en;

const cache = new Map<string, Intl.NumberFormat | Intl.DateTimeFormat>();
function cached<T extends Intl.NumberFormat | Intl.DateTimeFormat>(key: string, make: () => T): T {
  let f = cache.get(key) as T | undefined;
  if (!f) {
    f = make();
    if (cache.size > 500) cache.clear(); // bounded: option combinations are finite in practice
    cache.set(key, f);
  }
  return f;
}

/** 'ar' / 'en' map to the product tags; a full BCP 47 tag (e.g. 'en-US' for the landing demos) is kept, digits still pinned. */
const tagFor = (locale: DisplayLocale | string) => (locale === 'ar' ? INTL_LOCALE.ar : locale === 'en' || !locale ? INTL_LOCALE.en : locale);

export function numberFormat(locale: DisplayLocale | string, options: Intl.NumberFormatOptions = {}): Intl.NumberFormat {
  const tag = tagFor(locale);
  return cached(`n|${tag}|${JSON.stringify(options)}`, () => new Intl.NumberFormat(tag, { ...options, numberingSystem: 'latn' }));
}

export function moneyNumberFormat(locale: DisplayLocale | string, options: Intl.NumberFormatOptions = {}): Intl.NumberFormat {
  const tag = locale === 'ar' ? MONEY_LOCALE.ar : MONEY_LOCALE.en;
  return cached(`m|${tag}|${JSON.stringify(options)}`, () => new Intl.NumberFormat(tag, { ...options, numberingSystem: 'latn' }));
}

export function dateTimeFormat(locale: DisplayLocale | string, options: Intl.DateTimeFormatOptions = {}): Intl.DateTimeFormat {
  const tag = tagFor(locale);
  return cached(`d|${tag}|${JSON.stringify(options)}`, () => new Intl.DateTimeFormat(tag, { ...options, numberingSystem: 'latn' }));
}

const isNum = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);
const toDate = (v: string | number | Date) => (v instanceof Date ? v : new Date(v));
const validDate = (d: Date) => !Number.isNaN(d.getTime());

/** 1250.5 → "1,250.5". Non-finite or missing values render as an em dash. */
export const formatNumber = (n: number | null | undefined, locale: DisplayLocale | string = 'en', options?: Intl.NumberFormatOptions) =>
  isNum(n) ? numberFormat(locale, options).format(n) : '—';

/** Fraction → percent: 0.15 → "15%". */
export const formatPercent = (fraction: number | null | undefined, locale: DisplayLocale | string = 'en', maximumFractionDigits = 1) =>
  isNum(fraction) ? numberFormat(locale, { style: 'percent', maximumFractionDigits }).format(fraction) : '—';

/** 125000 → "125K" / "125 ألف". */
export const formatCompact = (n: number | null | undefined, locale: DisplayLocale | string = 'en', maximumFractionDigits = 1) =>
  isNum(n) ? numberFormat(locale, { notation: 'compact', maximumFractionDigits }).format(n) : '—';

export const formatDate = (v: string | number | Date | null | undefined, locale: DisplayLocale | string = 'en', timeZone?: string, dateStyle: 'short' | 'medium' | 'long' | 'full' = 'medium') => {
  if (v === null || v === undefined || v === '') return '—';
  const d = toDate(v);
  return validDate(d) ? dateTimeFormat(locale, { dateStyle, timeZone }).format(d) : '—';
};

export const formatTime = (v: string | number | Date | null | undefined, locale: DisplayLocale | string = 'en', timeZone?: string) => {
  if (v === null || v === undefined || v === '') return '—';
  const d = toDate(v);
  return validDate(d) ? dateTimeFormat(locale, { timeStyle: 'short', timeZone }).format(d) : '—';
};

export const formatDateTime = (v: string | number | Date | null | undefined, locale: DisplayLocale | string = 'en', timeZone?: string) => {
  if (v === null || v === undefined || v === '') return '—';
  const d = toDate(v);
  return validDate(d) ? dateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short', timeZone }).format(d) : '—';
};

/** Wall-clock label for an hour/minute pair (opening hours, slots): 9, 30 → "09:30" / "9:30 am" depending on locale. */
export const formatClock = (hour: number, minute: number, locale: DisplayLocale | string = 'en', hourCycle?: 'h12' | 'h23') =>
  dateTimeFormat(locale, { hour: hourCycle === 'h23' ? '2-digit' : 'numeric', minute: '2-digit', timeZone: 'UTC', ...(hourCycle ? { hourCycle } : {}) })
    .format(new Date(Date.UTC(2024, 0, 1, hour, minute)));

/** Calendar date (YYYY-MM-DD) in a branch time zone — for keys and API parameters, not display. */
export const isoDateIn = (v: string | number | Date, timeZone: string) =>
  new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', numberingSystem: 'latn' }).format(toDate(v));

const EASTERN_DIGITS = /[٠-٩۰-۹]/g;
/**
 * Normalises Arabic-Indic (٠-٩) and Extended Arabic-Indic (۰-۹) digits and the Arabic decimal/thousands
 * separators to ASCII in a NUMERIC input value (quantity, price, phone keypad entry). Never apply it to
 * free text, identifiers, secrets or signed payloads.
 */
export function normalizeNumericInput(value: string): string {
  return value
    .replace(EASTERN_DIGITS, (c) => String((c.charCodeAt(0) & 0xf) % 10))
    .replace(/٫/g, '.') // Arabic decimal separator
    .replace(/[٬،]/g, ','); // Arabic thousands separator, Arabic comma
}

/** True when a string contains any Eastern Arabic digit (used by tests and QA scans). */
export const hasEasternDigits = (s: string) => /[٠-٩۰-۹]/.test(s);
