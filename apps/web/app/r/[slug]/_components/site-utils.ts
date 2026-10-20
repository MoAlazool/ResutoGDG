import { formatMoney, type Currency, type PublicSite, INTL_LOCALE } from '@resuto/contracts';

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

/** schema.org Restaurant JSON-LD built only from published, guest-visible data. */
export function restaurantJsonLd(site: PublicSite, url: string, locale: SiteLocale) {
  const b = site.branches[0];
  const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const ld: Record<string, unknown> = {
    '@context': 'https://schema.org',
    '@type': 'Restaurant',
    name: pickName(locale, site.org.name, site.org.nameAr),
    url,
    ...(loc(site.seo.description, locale) ? { description: loc(site.seo.description, locale) } : {}),
    ...(site.seo.ogImageUrl || site.theme.heroUrl ? { image: site.seo.ogImageUrl ?? site.theme.heroUrl } : {}),
    ...(site.theme.logoUrl ? { logo: site.theme.logoUrl } : {}),
    currenciesAccepted: site.org.currency,
    acceptsReservations: acceptsReservations(site),
    hasMenu: new URL(site.links.order, url).toString(),
  };
  if (b) {
    if (b.phone) ld.telephone = b.phone;
    if (b.address || b.city) {
      ld.address = { '@type': 'PostalAddress', ...(b.address ? { streetAddress: b.address } : {}), ...(b.city ? { addressLocality: b.city } : {}), addressCountry: site.org.country };
    }
    if (b.latitude !== null && b.longitude !== null) ld.geo = { '@type': 'GeoCoordinates', latitude: b.latitude, longitude: b.longitude };
    const hours = openingHours(b.openingHours);
    if (hours.length) ld.openingHoursSpecification = hours.map((h) => ({ '@type': 'OpeningHoursSpecification', dayOfWeek: `https://schema.org/${dayNames[h.day]}`, opens: h.opens, closes: h.closes }));
  }
  if (site.branches.length > 1) {
    ld.department = site.branches.slice(1).map((x) => ({ '@type': 'Restaurant', name: pickName(locale, x.name, x.nameAr), ...(x.phone ? { telephone: x.phone } : {}) }));
  }
  return ld;
}

/** Escapes a JSON-LD payload for safe embedding in a <script> element. */
export const jsonLdScript = (data: unknown) => JSON.stringify(data).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');

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
