// schema.org structured data for a restaurant website (21-STUDIO SEO/AEO/GEO, plan §6.4): Restaurant (with its Menu,
// the Offers on its dishes and its promotions) and, when the site has questions and answers, an FAQPage. Built only from
// the published, guest-visible site payload (PublicSite): business name, address, phone, hours, dishes, prices, offer
// codes and the owner's own Q&A — never customers, staff, costs or stock. Server-rendered into the page
// (app/r/[slug]/page.tsx) and checked by validateJsonLd(), which the Studio SEO panel and the unit test use.
import { formatMoney, type Currency } from '@resuto/contracts/lite';
import type { PublicSite, PublicSiteProduct, PublicSitePromotion } from '@resuto/contracts';
import { acceptsReservations, loc, openingHours, pickName, type SiteLocale } from './site-utils';

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
type Ld = Record<string, unknown>;

/** Minor units to a schema.org price ("38.25"): Western digits, a dot, no grouping. */
export const ldPrice = (minor: number) => (minor / 100).toFixed(2);

function menuItem(p: PublicSiteProduct, locale: SiteLocale, url: string): Ld {
  const offer: Ld = { '@type': 'Offer', price: ldPrice(p.priceMinor), priceCurrency: p.currency, url, availability: 'https://schema.org/InStock' };
  // A dish discount: the struck-through price is the list price (schema.org priceSpecification with priceType ListPrice).
  if (p.compareAtMinor && p.compareAtMinor > p.priceMinor) {
    offer.priceSpecification = [
      { '@type': 'UnitPriceSpecification', price: ldPrice(p.priceMinor), priceCurrency: p.currency },
      { '@type': 'UnitPriceSpecification', price: ldPrice(p.compareAtMinor), priceCurrency: p.currency, priceType: 'https://schema.org/ListPrice' },
    ];
  }
  const description = pickName(locale, p.description, p.descriptionAr);
  return {
    '@type': 'MenuItem', name: pickName(locale, p.name, p.nameAr), ...(description ? { description } : {}),
    ...(p.imageUrl ? { image: p.imageUrl } : {}), offers: offer,
    ...(p.dietary.includes('vegetarian') ? { suitableForDiet: 'https://schema.org/VegetarianDiet' } : {}),
    ...(p.dietary.includes('vegan') ? { suitableForDiet: 'https://schema.org/VeganDiet' } : {}),
  };
}

function promotionOffer(p: PublicSitePromotion, locale: SiteLocale, currency: string, url: string): Ld {
  const what = p.kind === 'percent' ? (locale === 'ar' ? `خصم ${p.value / 100}%` : `${p.value / 100}% off`)
    : p.kind === 'fixed' ? (locale === 'ar' ? `خصم ${formatMoney(p.value, currency as Currency, 'ar')}` : `${formatMoney(p.value, currency as Currency, 'en')} off`)
      : (locale === 'ar' ? 'توصيل مجاني' : 'Free delivery');
  return {
    '@type': 'Offer', name: pickName(locale, p.name, p.nameAr), description: p.code ? `${what} · ${p.code}` : what, url,
    ...(p.endsAt ? { validThrough: p.endsAt } : {}),
    ...(p.minOrderMinor > 0 ? { eligibleTransactionVolume: { '@type': 'PriceSpecification', price: ldPrice(p.minOrderMinor), priceCurrency: currency } } : {}),
  };
}

/** The menu: the full-menu section's categories when the site has one, else the highlighted dishes. */
function menuOf(site: PublicSite, locale: SiteLocale, menuUrl: string): Ld | null {
  const full = site.sections.find((s) => s.kind === 'menu_full' && s.content.menu?.length);
  const sections = full
    ? full.content.menu!.map((c) => ({ '@type': 'MenuSection', name: pickName(locale, c.name, c.nameAr), hasMenuItem: c.items.map((p) => menuItem(p, locale, menuUrl)) }))
    : site.menuHighlights.length ? [{ '@type': 'MenuSection', name: locale === 'ar' ? 'أطباق مميزة' : 'Highlights', hasMenuItem: site.menuHighlights.map((p) => menuItem(p, locale, menuUrl)) }] : [];
  if (!sections.length) return null;
  return { '@type': 'Menu', url: menuUrl, inLanguage: locale, hasMenuSection: sections };
}

export function restaurantLd(site: PublicSite, url: string, locale: SiteLocale): Ld {
  const b = site.branches[0];
  const menuUrl = new URL(site.links.order, url).toString();
  const ld: Ld = {
    '@context': 'https://schema.org',
    '@type': 'Restaurant',
    name: pickName(locale, site.org.name, site.org.nameAr),
    url,
    ...(loc(site.seo.description, locale) ? { description: loc(site.seo.description, locale) } : {}),
    ...(site.seo.ogImageUrl || site.theme.heroUrl ? { image: site.seo.ogImageUrl ?? site.theme.heroUrl } : {}),
    ...(site.theme.logoUrl ? { logo: site.theme.logoUrl } : {}),
    currenciesAccepted: site.org.currency,
    acceptsReservations: acceptsReservations(site),
  };
  const menu = menuOf(site, locale, menuUrl);
  ld.hasMenu = menu ?? menuUrl;
  const sameAs = Object.values(site.org.socialLinks ?? {}).filter((x): x is string => typeof x === 'string');
  if (sameAs.length) ld.sameAs = sameAs;
  if (b) {
    if (b.phone) ld.telephone = b.phone;
    if (b.address || b.city) {
      ld.address = { '@type': 'PostalAddress', ...(b.address ? { streetAddress: b.address } : {}), ...(b.city ? { addressLocality: b.city } : {}), addressCountry: site.org.country };
    }
    if (b.latitude !== null && b.longitude !== null) ld.geo = { '@type': 'GeoCoordinates', latitude: b.latitude, longitude: b.longitude };
    const hours = openingHours(b.openingHours);
    if (hours.length) ld.openingHoursSpecification = hours.map((h) => ({ '@type': 'OpeningHoursSpecification', dayOfWeek: `https://schema.org/${DAY_NAMES[h.day]}`, opens: h.opens, closes: h.closes }));
  }
  if (site.branches.length > 1) {
    ld.department = site.branches.slice(1).map((x) => ({ '@type': 'Restaurant', name: pickName(locale, x.name, x.nameAr), ...(x.phone ? { telephone: x.phone } : {}) }));
  }
  const promos = new Map<string, PublicSitePromotion>();
  for (const s of site.sections) if (s.content.promotion) promos.set(s.content.promotion.code ?? s.content.promotion.name, s.content.promotion);
  if (promos.size) ld.makesOffer = [...promos.values()].map((p) => promotionOffer(p, locale, site.org.currency, menuUrl));
  return ld;
}

/** FAQPage from the site's question-and-answer sections (null without answered questions). */
export function faqLd(site: PublicSite, locale: SiteLocale): Ld | null {
  const qa = site.sections.filter((s) => s.kind === 'faq').flatMap((s) => s.content.items ?? [])
    .map((i) => ({ q: loc(i.title, locale), a: loc(i.body, locale) })).filter((x) => x.q && x.a);
  if (!qa.length) return null;
  return {
    '@context': 'https://schema.org', '@type': 'FAQPage', inLanguage: locale,
    mainEntity: qa.map((x) => ({ '@type': 'Question', name: x.q, acceptedAnswer: { '@type': 'Answer', text: x.a } })),
  };
}

/** Every structured-data document the page carries, in order (Restaurant first). */
export function siteJsonLd(site: PublicSite, url: string, locale: SiteLocale): Ld[] {
  return [restaurantLd(site, url, locale), faqLd(site, locale)].filter((x): x is Ld => !!x);
}

/** Escapes a JSON-LD payload for safe embedding in a <script> element (no "</script>", "<!--" or "&" survives). */
export const jsonLdScript = (data: unknown) =>
  JSON.stringify(data).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');

const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
/** Keys that would mean private or internal data reached the page. */
const PRIVATE_KEYS = /^(email|customer|customers|guest|staff|employee|cost|costMinor|cost_minor|stock|stockQty|margin|token|qrToken|password|userId|membership|redemptions?|redemptionCount)$/i;
const KNOWN_TYPES = new Set(['Restaurant', 'FAQPage', 'Question', 'Answer', 'Menu', 'MenuSection', 'MenuItem', 'Offer', 'UnitPriceSpecification', 'PriceSpecification',
  'PostalAddress', 'GeoCoordinates', 'OpeningHoursSpecification']);

/**
 * Problems with a structured-data document (empty when it is fine): the schema.org context on the top level, a known
 * @type on every object, required fields per type, prices as plain decimals, no private keys and no e-mail addresses.
 */
export function validateJsonLd(doc: unknown): string[] {
  const problems: string[] = [];
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return ['not an object'];
  if ((doc as Ld)['@context'] !== 'https://schema.org') problems.push('@context must be https://schema.org');
  const walk = (v: unknown, path: string) => {
    if (Array.isArray(v)) { v.forEach((x, i) => walk(x, `${path}[${i}]`)); return; }
    if (typeof v === 'string') { if (EMAIL.test(v)) problems.push(`${path}: looks like an e-mail address`); return; }
    if (!v || typeof v !== 'object') return;
    const o = v as Ld;
    const type = o['@type'];
    if (typeof type !== 'string' || !KNOWN_TYPES.has(type)) problems.push(`${path}: unknown @type ${String(type)}`);
    for (const [k, x] of Object.entries(o)) {
      if (PRIVATE_KEYS.test(k)) problems.push(`${path}.${k}: private field`);
      if (k === 'price' && !(typeof x === 'string' && /^\d+\.\d{2}$/.test(x))) problems.push(`${path}.price: not a decimal price`);
      walk(x, `${path}.${k}`);
    }
    const need: Record<string, string[]> = {
      Restaurant: ['name', 'url'], FAQPage: ['mainEntity'], Question: ['name', 'acceptedAnswer'], Answer: ['text'], Menu: ['hasMenuSection'],
      MenuSection: ['name', 'hasMenuItem'], MenuItem: ['name', 'offers'], Offer: [], PostalAddress: ['addressCountry'],
    };
    for (const f of need[type as string] ?? []) if (o[f] === undefined || o[f] === '') problems.push(`${path}: ${type} needs ${f}`);
    if (type === 'Offer' && o.price !== undefined && typeof o.priceCurrency !== 'string') problems.push(`${path}: Offer with a price needs priceCurrency`);
  };
  walk(doc, '$');
  return problems;
}
