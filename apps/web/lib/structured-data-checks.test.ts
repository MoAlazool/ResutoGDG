import type { PublicSite } from '@resuto/contracts';
import { describe, expect, it } from 'vitest';
import { siteJsonLd } from '@/app/r/[slug]/_components/structured-data';
import { extractJsonLd, jsonLdReport, propertyChecks } from './structured-data-checks';

const site = (over: Partial<PublicSite> = {}): PublicSite => ({
  slug: 'grill', revision: 1, publishedAt: '2026-10-20T10:00:00.000Z', preview: false,
  org: { name: 'Grill House', nameAr: 'بيت المشويات', currency: 'EGP', country: 'EG', defaultLocale: 'en', demo: false },
  template: 'olive',
  theme: { primaryColor: '#000000', accentColor: '#ffffff', backgroundColor: '#ffffff', font: 'manrope', logoUrl: null, heroUrl: 'https://cdn.example/h.webp', tagline: {} },
  seo: { title: { en: 'Grill House' }, description: { en: 'Charcoal grill in Maadi.' }, ogImageUrl: null },
  sections: [{ id: 's', kind: 'menu_full', content: { menu: [{ id: 'c', name: 'Grill', nameAr: 'مشويات', items: [
    { id: 'p', name: 'Kofta', nameAr: 'كفتة', description: null, descriptionAr: null, priceMinor: 12000, currency: 'EGP', imageUrl: null, dietary: [] }] }] } }],
  branches: [{ id: 'b', code: 'main', name: 'Maadi', nameAr: 'المعادي', address: '9 Road 9', city: 'Cairo', phone: '+20225555555', latitude: 29.96012, longitude: 31.25734,
    openingHours: [{ day: 1, opens: '12:00', closes: '23:00' }], acceptsDineIn: true, acceptsPickup: true, acceptsDelivery: false, acceptsReservations: true }],
  menuHighlights: [], canonicalHost: null, links: { reserve: '/reserve/grill', order: '/order/grill', site: '/r/grill' }, storefronts: [],
  ...over,
} as PublicSite);
const URL_ = 'https://app.resuto.test/r/grill';

describe('structured-data property checks (Restaurant / Menu / FAQPage guidance)', () => {
  it('a complete restaurant passes every required property; the missing recommended ones are listed', () => {
    const r = jsonLdReport(siteJsonLd(site(), URL_, 'en'));
    expect(r.problems).toEqual([]);
    expect(r.required.failed).toEqual([]);
    expect(r.required.passed).toBeGreaterThanOrEqual(10);
    // No cuisine field exists, so servesCuisine is reported with that note (not invented); the menu item has no description.
    expect(r.recommended.missing.map((c) => `${c.type}.${c.property}${c.note ? `:${c.note}` : ''}`).sort())
      .toEqual(['MenuItem.description', 'Restaurant.servesCuisine:noCuisineField']);
    expect(r.types).toMatchObject({ Restaurant: 1, PostalAddress: 1, GeoCoordinates: 1, OpeningHoursSpecification: 1, Menu: 1, MenuSection: 1, MenuItem: 1, Offer: 1 });
    // No ratings or reviews are ever emitted.
    expect(JSON.stringify(siteJsonLd(site(), URL_, 'en'))).not.toMatch(/aggregateRating|review/i);
  });

  it('flags a restaurant without an address (required) and without phone, hours, map pin (recommended)', () => {
    const bare = site({ branches: [{ ...site().branches[0]!, address: null, city: null, phone: null, latitude: null, longitude: null, openingHours: [] }] });
    const r = jsonLdReport(siteJsonLd(bare, URL_, 'en'));
    expect(r.required.failed.map((c) => `${c.type}.${c.property}`)).toEqual(['Restaurant.address']);
    expect(r.recommended.missing.map((c) => c.property)).toEqual(expect.arrayContaining(['telephone', 'geo', 'openingHoursSpecification']));
  });

  it('checks coordinate precision (5 decimals), offer prices and currencies, and FAQ questions', () => {
    expect(propertyChecks({ '@type': 'GeoCoordinates', latitude: 30.06, longitude: 31.2 }).filter((c) => !c.ok).map((c) => c.note)).toEqual(['precision']);
    const offer = propertyChecks({ '@type': 'Offer', price: 12, priceCurrency: 'egp' });
    expect(offer.filter((c) => !c.ok).map((c) => c.property)).toEqual(['price', 'priceCurrency']);
    const faq = propertyChecks({ '@type': 'FAQPage', mainEntity: [{ '@type': 'Question', name: 'Open late?', acceptedAnswer: { '@type': 'Answer', text: '' } }] });
    expect(faq.filter((c) => !c.ok).map((c) => `${c.type}.${c.property}`)).toEqual(['Answer.text']);
    // A promotion offer (makesOffer) needs a name, not a dish price.
    const promo = propertyChecks({ '@type': 'Restaurant', name: 'x', makesOffer: [{ '@type': 'Offer', name: 'Eid' }] }).filter((c) => c.type === 'Offer');
    expect(promo.every((c) => c.ok || c.level === 'recommended')).toBe(true);
    // Another branch (department) is checked for its location facts only, not the menu or price range of the whole business.
    const dept = propertyChecks({ '@type': 'Restaurant', name: 'x', url: 'https://x/', menu: 'https://x/m', department: [{ '@type': 'Restaurant', name: 'Branch', address: { '@type': 'PostalAddress' } }] })
      .filter((c) => c.path.startsWith('$.department'));
    expect(dept.filter((c) => c.type === 'Restaurant').map((c) => c.property)).toEqual(['name', 'address', 'telephone', 'geo', 'openingHoursSpecification']);
    // References to nodes described elsewhere are not checked as nodes.
    expect(propertyChecks({ '@type': 'Restaurant', name: 'x', hasMenu: { '@id': 'https://x/m/y#menu' } }).some((c) => c.type === '')).toBe(false);
  });

  it('dishes the website shows (not a full menu) are offers with a price and a named item', () => {
    const highlights = site({ sections: [], menuHighlights: [{ id: 'p', name: 'Kofta', nameAr: 'كفتة', description: null, descriptionAr: null, priceMinor: 12000, currency: 'EGP', imageUrl: null, dietary: [] }] });
    const r = jsonLdReport(siteJsonLd(highlights, URL_, 'ar'));
    expect(r.problems).toEqual([]);
    expect(r.required.failed).toEqual([]);
    expect(r.types).toMatchObject({ Offer: 1, MenuItem: 1 });
    const noPrice = propertyChecks({ '@type': 'Restaurant', name: 'x', makesOffer: [{ '@type': 'Offer', itemOffered: { '@type': 'MenuItem', name: 'Kofta' } }] });
    expect(noPrice.filter((c) => !c.ok && c.level === 'required').map((c) => `${c.type}.${c.property}`)).toEqual(['Restaurant.address', 'Offer.price', 'Offer.priceCurrency']);
  });

  it('extracts and parses every JSON-LD script of a page, reporting unparseable ones', () => {
    const html = '<head><script type="application/ld+json">{"@type":"Restaurant","name":"A\\u003c/script>"}</script>'
      + '<script nonce="x" type="application/ld+json">{"@type":"FAQPage"}</script><script type="application/ld+json">{oops}</script></head>';
    const { docs, errors } = extractJsonLd(html);
    expect(docs).toEqual([{ '@type': 'Restaurant', name: 'A</script>' }, { '@type': 'FAQPage' }]);
    expect(errors).toHaveLength(1);
  });
});
