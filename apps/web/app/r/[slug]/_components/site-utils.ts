import { formatMoney, INTL_LOCALE, type Currency } from '@resuto/contracts/lite';
import type { PublicSitePromotion, PublicSite } from '@resuto/contracts';

export type SiteLocale = 'en' | 'ar';
export type T = (key: string, vars?: Record<string, string | number>) => string;

/** Localised copy with fallback to the other language (owners may fill only one). */
export const loc = (v: { en?: string; ar?: string } | undefined | null, locale: SiteLocale) =>
  (locale === 'ar' ? v?.ar || v?.en : v?.en || v?.ar) ?? '';
export const pickName = (locale: SiteLocale, en: string | null | undefined, ar: string | null | undefined) => (locale === 'ar' && ar ? ar : en ?? ar ?? '');
/** Guest-facing prices keep their minor digits ("EGP 145.00"), as the original site did (audit VP-26). */
export const price = (minor: number, currency: string, locale: SiteLocale) => formatMoney(minor, currency as Currency, locale, { decimals: 'always' });

export const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;
export interface Hours { day: number; opens: string; closes: string }
export function openingHours(raw: unknown): Hours[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((h): h is Hours => !!h && typeof h.day === 'number' && /^\d{2}:\d{2}$/.test(h.opens) && /^\d{2}:\d{2}$/.test(h.closes))
    .sort((a, b) => a.day - b.day || a.opens.localeCompare(b.opens));
}
export const clock = (hhmm: string, locale: SiteLocale) => {
  const [h, m] = hhmm.split(':').map(Number);
  return new Date(Date.UTC(2024, 0, 1, h, m)).toLocaleTimeString(locale === 'ar' ? INTL_LOCALE.ar : 'en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'UTC' });
};

export const acceptsOrders = (site: PublicSite) => site.branches.some((b) => b.acceptsPickup || b.acceptsDelivery);
export const acceptsReservations = (site: PublicSite) => site.branches.some((b) => b.acceptsReservations);

/**
 * Hero copy. A restaurant's hero starts with its name as the headline, which counts as "not written yet"; the name
 * then shows as the eyebrow, as on the legacy page. The legacy guest home's own words ("Good food. Long
 * conversations.") are the demo restaurant's copy, so only the demo tenant (org.demo) gets them in place of an
 * unwritten headline; any other restaurant shows its own name and no body text it never wrote.
 */
export function heroCopy(s: PublicSite['sections'][number], site: PublicSite, locale: SiteLocale, t: T) {
  const name = pickName(locale, site.org.name, site.org.nameAr);
  const written = loc(s.content.headline, locale);
  const isDefault = !written || [site.org.name, site.org.nameAr].filter(Boolean).includes(written);
  const demoCopy = isDefault && site.template === 'olive' && site.org.demo;
  return {
    eyebrow: loc(s.content.eyebrow, locale) || name,
    headline: demoCopy ? t('studio.site.tpl.headline') : written || name,
    body: loc(s.content.body, locale) || (demoCopy ? t('studio.site.tpl.body') : ''),
  };
}

/**
 * The legacy "Dinner, without the back-and-forth." story beside the first dish photo is the demo restaurant's copy, not
 * an owner-editable section: only the demo tenant (org.demo) shows it, and only when it takes orders.
 */
export const showsDemoStory = (site: PublicSite) => site.template === 'olive' && site.org.demo && acceptsOrders(site);

/** The discount a dish shows: whole percent off its was-price (null when it is not discounted). */
export function discountPercent(p: { priceMinor: number; compareAtMinor?: number | null }): number | null {
  if (!p.compareAtMinor || p.compareAtMinor <= p.priceMinor) return null;
  return Math.round((1 - p.priceMinor / p.compareAtMinor) * 100);
}

/** A promotion's discount in words ("15% off", "EGP 50.00 off", "Free delivery"). */
export function promotionLabel(p: PublicSitePromotion, currency: string, locale: SiteLocale, t: T): string {
  if (p.kind === 'percent') return t('studio.site.percentOff', { pct: p.value / 100 });
  if (p.kind === 'fixed') return t('studio.site.amountOff', { amount: price(p.value, currency, locale) });
  return t('studio.site.freeDelivery');
}
