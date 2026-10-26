// schema.org structured data for a restaurant website (21-STUDIO SEO/AEO/GEO, plan §6.4; entity graph 22-STUDIO):
//   Restaurant (@id <site>#restaurant: name, address, geo, phone, hours, price range from the menu, other branches as
//   departments) -> hasMenu Menu (@id <menu page>#menu) -> MenuSection -> MenuItem -> Offer (price and currency from the
//   menu), its promotions as makesOffer, and an FAQPage only from the questions the page shows.
// The restaurant website (/r/<slug>) and the menu page (/m/<slug>, menuPageJsonLd) describe the same Restaurant and Menu
// under the same @ids, so the facts agree across pages. Built only from published, guest-visible data (PublicSite,
// PublicMenu): never customers, staff, costs or stock counts, and never ratings, reviews or claims the restaurant has not
// made (no aggregateRating: there is no review data). Server-rendered into the pages and checked by validateJsonLd()
// (shape and privacy) and lib/structured-data-checks.ts (required and recommended properties), which the Studio's
// Optimize workspace and the unit tests use.
import { formatMoney, type Currency } from '@resuto/contracts/lite';
import type { PublicMenu, PublicMenuProduct, PublicSite, PublicSiteProduct, PublicSitePromotion } from '@resuto/contracts';
import { acceptsReservations, loc, openingHours, pickName, type SiteLocale } from './site-utils';

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
type Ld = Record<string, unknown>;

/** Minor units to a schema.org price ("38.25"): Western digits, a dot, no grouping. */
export const ldPrice = (minor: number) => (minor / 100).toFixed(2);

/** The page addresses the structured data refers to: the website (canonical), its menu page and its ordering page. */
export interface SiteUrls { site: string; menu: string; order: string }
/** Stable node ids, shared by every page that describes the restaurant (JSON-LD @id). */
export const restaurantId = (siteUrl: string) => `${siteUrl.replace(/#.*$/, '')}#restaurant`;
export const menuId = (menuUrl: string) => `${menuUrl.replace(/#.*$/, '')}#menu`;

/**
 * The page URLs for a site whose canonical address is `siteUrl`: on the restaurant's own domain (https://host/) the menu
 * page is https://host/m/<slug> and ordering https://host/order; on the app host they are /m/<slug> and /order/<slug>.
 */
export function siteUrls(site: Pick<PublicSite, 'slug' | 'canonicalHost' | 'links'>, siteUrl: string): SiteUrls {
  const origin = new URL(siteUrl).origin;
  return { site: siteUrl, menu: `${origin}/m/${site.slug}`, order: site.canonicalHost ? `${origin}/order` : new URL(site.links.order, siteUrl).toString() };
}

type Dish = Pick<PublicSiteProduct, 'name' | 'nameAr' | 'description' | 'descriptionAr' | 'priceMinor' | 'imageUrl' | 'dietary'> & { compareAtMinor?: number | null; available?: boolean };

function menuItem(p: Dish, currency: string, locale: SiteLocale, url: string): Ld {
  const offer: Ld = { '@type': 'Offer', price: ldPrice(p.priceMinor), priceCurrency: currency, url };
  // Availability only where the menu says so (the menu page knows what is sold out today); never assumed.
  if (p.available !== undefined) offer.availability = p.available ? 'https://schema.org/InStock' : 'https://schema.org/SoldOut';
  // A dish discount: the struck-through price is the list price (schema.org priceSpecification with priceType ListPrice).
  if (p.compareAtMinor && p.compareAtMinor > p.priceMinor) {
    offer.priceSpecification = [
      { '@type': 'UnitPriceSpecification', price: ldPrice(p.priceMinor), priceCurrency: currency },
      { '@type': 'UnitPriceSpecification', price: ldPrice(p.compareAtMinor), priceCurrency: currency, priceType: 'https://schema.org/ListPrice' },
    ];
  }
  const description = pickName(locale, p.description, p.descriptionAr);
  const diets = [p.dietary.includes('vegetarian') && 'https://schema.org/VegetarianDiet', p.dietary.includes('vegan') && 'https://schema.org/VeganDiet'].filter(Boolean);
  return {
    '@type': 'MenuItem', name: pickName(locale, p.name, p.nameAr), ...(description ? { description } : {}),
    ...(p.imageUrl ? { image: p.imageUrl } : {}), offers: offer,
    ...(diets.length ? { suitableForDiet: diets.length === 1 ? diets[0] : diets } : {}),
  };
}

/** A dish the page shows (highlights, offers) as something the restaurant offers at a price: Offer → itemOffered MenuItem. */
function dishOffer(p: Dish, currency: string, locale: SiteLocale, url: string): Ld {
  const { offers, ...item } = menuItem(p, currency, locale, url);
  return { ...(offers as Ld), itemOffered: item };
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

/** A Menu node: its sections and their dishes, under the menu page's @id. */
function menuNode(groups: Array<{ name: string; nameAr: string | null; items: Dish[] }>, currency: string, locale: SiteLocale, urls: SiteUrls): Ld {
  return {
    '@type': 'Menu', '@id': menuId(urls.menu), url: urls.menu, inLanguage: locale,
    hasMenuSection: groups.filter((g) => g.items.length).map((g) => ({
      '@type': 'MenuSection', name: pickName(locale, g.name, g.nameAr), hasMenuItem: g.items.map((p) => menuItem(p, currency, locale, urls.order)),
    })),
  };
}

/** The price range guests see on the menu ("EGP 95.00–345.00"), from the lowest and highest dish price; null without prices. */
export function priceRange(prices: number[], currency: string): string | null {
  const ok = prices.filter((n) => Number.isFinite(n) && n > 0);
  if (!ok.length) return null;
  const lo = Math.min(...ok);
  const hi = Math.max(...ok);
  return lo === hi ? `${currency} ${ldPrice(lo)}` : `${currency} ${ldPrice(lo)}–${ldPrice(hi)}`;
}

type Branch = PublicSite['branches'][number];
const address = (b: Pick<Branch, 'address' | 'city'>, country: string): Ld | null => (b.address || b.city
  ? { '@type': 'PostalAddress', ...(b.address ? { streetAddress: b.address } : {}), ...(b.city ? { addressLocality: b.city } : {}), addressCountry: country } : null);
const hoursOf = (raw: unknown): Ld[] => openingHours(raw).map((h) => ({ '@type': 'OpeningHoursSpecification', dayOfWeek: `https://schema.org/${DAY_NAMES[h.day]}`, opens: h.opens, closes: h.closes }));

/** Location facts of a branch: phone, address, map pin, opening hours (only those it has). */
function locationFacts(b: Branch, country: string): Ld {
  const out: Ld = {};
  if (b.phone) out.telephone = b.phone;
  const a = address(b, country);
  if (a) out.address = a;
  if (b.latitude !== null && b.longitude !== null) out.geo = { '@type': 'GeoCoordinates', latitude: b.latitude, longitude: b.longitude };
  const hours = hoursOf(b.openingHours);
  if (hours.length) out.openingHoursSpecification = hours;
  return out;
}

export function restaurantLd(site: PublicSite, url: string, locale: SiteLocale): Ld {
  const urls = siteUrls(site, url);
  const b = site.branches[0];
  const name = pickName(locale, site.org.name, site.org.nameAr);
  const other = locale === 'ar' ? site.org.name : site.org.nameAr;
  const ld: Ld = {
    '@context': 'https://schema.org',
    '@type': 'Restaurant',
    '@id': restaurantId(url),
    name,
    ...(other && other !== name ? { alternateName: other } : {}),
    url,
    ...(loc(site.seo.description, locale) ? { description: loc(site.seo.description, locale) } : {}),
    ...(site.seo.ogImageUrl || site.theme.heroUrl ? { image: site.seo.ogImageUrl ?? site.theme.heroUrl } : {}),
    ...(site.theme.logoUrl ? { logo: site.theme.logoUrl } : {}),
    currenciesAccepted: site.org.currency,
    acceptsReservations: acceptsReservations(site),
    ...(b ? locationFacts(b, site.org.country) : {}),
  };
  // The menu: the full-menu section when the page shows one (the same dishes, under the menu page's @id); otherwise the
  // menu page's address, and the dishes the page does show (highlights, offers) as offers of the restaurant (a few
  // highlighted dishes are not the restaurant's menu).
  const full = site.sections.find((s) => s.kind === 'menu_full' && s.content.menu?.some((c) => c.items.length));
  ld.menu = urls.menu;
  ld.hasMenu = full ? menuNode(full.content.menu!, site.org.currency, locale, urls) : urls.menu;
  const shown = [...site.menuHighlights, ...site.sections.flatMap((s) => [...(s.content.products ?? []), ...(s.content.menu ?? []).flatMap((c) => c.items)])];
  const range = priceRange(shown.map((p) => p.priceMinor), site.org.currency);
  if (range) ld.priceRange = range;
  const sameAs = Object.values(site.org.socialLinks ?? {}).filter((x): x is string => typeof x === 'string');
  if (sameAs.length) ld.sameAs = sameAs;
  if (site.branches.length > 1) {
    ld.department = site.branches.slice(1).map((x) => ({
      '@type': 'Restaurant', '@id': `${restaurantId(url)}-${x.code}`, name: pickName(locale, x.name, x.nameAr), url, ...locationFacts(x, site.org.country),
    }));
  }
  const promos = new Map<string, PublicSitePromotion>();
  for (const s of site.sections) if (s.content.promotion) promos.set(s.content.promotion.code ?? s.content.promotion.name, s.content.promotion);
  const dishes = full ? [] : [...new Map([...site.menuHighlights, ...site.sections.flatMap((s) => s.content.products ?? [])].map((p) => [p.id, p])).values()];
  const offers = [...[...promos.values()].map((p) => promotionOffer(p, locale, site.org.currency, urls.order)),
    ...dishes.map((p) => dishOffer(p, site.org.currency, locale, urls.order))];
  if (offers.length) ld.makesOffer = offers;
  return ld;
}

/** The questions the page shows (a question and its answer in this language or the other, as the FAQ section renders them). */
export function visibleFaq(site: PublicSite, locale: SiteLocale): Array<{ q: string; a: string }> {
  return site.sections.filter((s) => s.kind === 'faq').flatMap((s) => s.content.items ?? [])
    .map((i) => ({ q: loc(i.title, locale), a: loc(i.body, locale) })).filter((x) => x.q && x.a);
}

/** FAQPage from the site's visible question-and-answer sections (null without answered questions). */
export function faqLd(site: PublicSite, locale: SiteLocale): Ld | null {
  const qa = visibleFaq(site, locale);
  if (!qa.length) return null;
  return {
    '@context': 'https://schema.org', '@type': 'FAQPage', inLanguage: locale,
    mainEntity: qa.map((x) => ({ '@type': 'Question', name: x.q, acceptedAnswer: { '@type': 'Answer', text: x.a } })),
  };
}

/** Every structured-data document the website carries, in order (Restaurant first). */
export function siteJsonLd(site: PublicSite, url: string, locale: SiteLocale): Ld[] {
  return [restaurantLd(site, url, locale), faqLd(site, locale)].filter((x): x is Ld => !!x);
}

/**
 * The menu page's structured data (/m/<slug>): the whole public menu as a Menu, and the Restaurant it belongs to (same
 * @ids as the website, its name, address and phone) when the restaurant has a published website. `site` is that website
 * (for its canonical address and branch facts), or null.
 */
export function menuPageJsonLd(menu: PublicMenu, site: PublicSite | null, siteUrl: string | null, menuUrl: string, locale: SiteLocale): Ld[] {
  const urls: SiteUrls = site && siteUrl ? { ...siteUrls(site, siteUrl), menu: menuUrl } : { site: siteUrl ?? menuUrl, menu: menuUrl, order: menuUrl };
  const groups = menu.categories.map((c) => ({ name: c.name, nameAr: c.nameAr, items: c.products.map((p: PublicMenuProduct): Dish => p) }));
  const out: Ld[] = [];
  const node = menuNode(groups, menu.org.currency, locale, urls);
  if (!(node.hasMenuSection as Ld[]).length) return out;
  out.push({ '@context': 'https://schema.org', ...node, name: pickName(locale, menu.org.name, menu.org.nameAr) });
  if (site && siteUrl) {
    const r = restaurantLd(site, siteUrl, locale);
    // The menu page names the restaurant and its location (consistent with the website) and points to this menu.
    const keep = ['@context', '@type', '@id', 'name', 'alternateName', 'url', 'telephone', 'address', 'geo', 'openingHoursSpecification', 'department'];
    out.push({ ...Object.fromEntries(Object.entries(r).filter(([k]) => keep.includes(k))), menu: menuUrl, hasMenu: { '@id': menuId(menuUrl) },
      ...(priceRange(groups.flatMap((g) => g.items.map((p) => p.priceMinor)), menu.org.currency) ? { priceRange: priceRange(groups.flatMap((g) => g.items.map((p) => p.priceMinor)), menu.org.currency) } : {}) });
  }
  return out;
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
    // A reference to a node described elsewhere ({ "@id": … }) has no type of its own.
    if (Object.keys(o).length === 1 && typeof o['@id'] === 'string') return;
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
    // A dish offered by the restaurant (Offer → itemOffered MenuItem) carries its price on the Offer around it.
    const required = type === 'MenuItem' && path.endsWith('.itemOffered') ? ['name'] : need[type as string] ?? [];
    for (const f of required) if (o[f] === undefined || o[f] === '') problems.push(`${path}: ${type} needs ${f}`);
    if (type === 'Offer' && o.price !== undefined && typeof o.priceCurrency !== 'string') problems.push(`${path}: Offer with a price needs priceCurrency`);
  };
  walk(doc, '$');
  return problems;
}
