// Locale constants with no dictionary imports: safe to import from any client component without pulling the
// dictionaries into its bundle.
export type Locale = 'en' | 'ar';
export const LOCALE_COOKIE = 'resuto_locale';
export const isRtl = (l: Locale) => l === 'ar';
/** Flat key → message map for one locale (English fallbacks already applied). */
export type Messages = Record<string, string>;
