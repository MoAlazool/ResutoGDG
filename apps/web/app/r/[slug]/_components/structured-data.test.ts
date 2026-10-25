import type { PublicSite, PublicSiteProduct } from '@resuto/contracts';
import { describe, expect, it } from 'vitest';
import { faqLd, jsonLdScript, ldPrice, restaurantLd, siteJsonLd, validateJsonLd } from './structured-data';

const dish = (over: Partial<PublicSiteProduct> = {}): PublicSiteProduct => ({
  id: 'p1', name: 'Koshari', nameAr: 'كشري', description: 'Lentils, rice, pasta', descriptionAr: 'عدس وأرز ومكرونة', priceMinor: 3825, currency: 'EGP',
  imageUrl: 'https://cdn.example/k.webp', dietary: ['vegetarian'], compareAtMinor: 4500, ...over,
});
const site = (over: Partial<PublicSite> = {}): PublicSite => ({
  slug: 'koshary-lab', revision: 3, publishedAt: '2026-10-20T10:00:00.000Z', preview: false,
  org: { name: 'Koshary Lab', nameAr: 'معمل الكشري', currency: 'EGP', country: 'EG', defaultLocale: 'en', demo: false,
    socialLinks: { instagram: 'https://instagram.com/kosharylab', google_maps: 'https://maps.app.goo.gl/abc' } },
  template: 'olive',
  theme: { primaryColor: '#000000', accentColor: '#ffffff', backgroundColor: '#ffffff', font: 'manrope', logoUrl: 'https://cdn.example/logo.png', heroUrl: null, tagline: {} },
  seo: { title: { en: 'Koshary Lab' }, description: { en: 'Koshari since 1998', ar: 'كشري منذ 1998' }, ogImageUrl: null },
  sections: [
    { id: 's1', kind: 'menu_full', content: { menu: [{ id: 'c1', name: 'Mains', nameAr: 'أطباق رئيسية', items: [dish(), dish({ id: 'p2', name: 'Feteer', nameAr: null, compareAtMinor: null, dietary: [] })] }] } },
    { id: 's2', kind: 'offers', content: { products: [dish()], promotion: { code: 'EID15', name: 'Eid', nameAr: 'العيد', kind: 'percent', value: 1500, minOrderMinor: 10000, endsAt: '2026-11-01T00:00:00.000Z' } } },
    { id: 's3', kind: 'faq', content: { items: [{ title: { en: 'Do you deliver?', ar: 'هل توصلون؟' }, body: { en: 'Yes, in Dokki.', ar: 'نعم، في الدقي.' } }, { title: { en: 'Unanswered?' } }] } },
  ],
  branches: [{ id: 'b', code: 'main', name: 'Dokki', nameAr: 'الدقي', address: '5 Tahrir St', city: 'Giza', phone: '+20212345678', latitude: 30.03, longitude: 31.21,
    openingHours: [{ day: 5, opens: '12:00', closes: '23:00' }], acceptsDineIn: true, acceptsPickup: true, acceptsDelivery: true, acceptsReservations: false }],
  menuHighlights: [], canonicalHost: null, links: { reserve: '/reserve/koshary-lab', order: '/order/koshary-lab', site: '/r/koshary-lab' }, storefronts: [],
  ...over,
} as PublicSite);
const URL_ = 'https://app.resuto.test/r/koshary-lab';

describe('schema.org structured data for the restaurant website', () => {
  it('builds Restaurant with its Menu, dish Offers (with the list price of a discount) and the promotion', () => {
    const ld = restaurantLd(site(), URL_, 'en') as any;
    expect(ld).toMatchObject({ '@context': 'https://schema.org', '@type': 'Restaurant', name: 'Koshary Lab', url: URL_, telephone: '+20212345678',
      address: { '@type': 'PostalAddress', streetAddress: '5 Tahrir St', addressLocality: 'Giza', addressCountry: 'EG' },
      geo: { '@type': 'GeoCoordinates', latitude: 30.03, longitude: 31.21 }, sameAs: ['https://instagram.com/kosharylab', 'https://maps.app.goo.gl/abc'] });
    expect(ld.openingHoursSpecification).toEqual([{ '@type': 'OpeningHoursSpecification', dayOfWeek: 'https://schema.org/Friday', opens: '12:00', closes: '23:00' }]);
    expect(ld.hasMenu).toMatchObject({ '@type': 'Menu', url: 'https://app.resuto.test/order/koshary-lab', hasMenuSection: [{ '@type': 'MenuSection', name: 'Mains' }] });
    const [koshari, feteer] = ld.hasMenu.hasMenuSection[0].hasMenuItem;
    expect(koshari).toMatchObject({ '@type': 'MenuItem', name: 'Koshari', suitableForDiet: 'https://schema.org/VegetarianDiet',
      offers: { '@type': 'Offer', price: '38.25', priceCurrency: 'EGP' } });
    expect(koshari.offers.priceSpecification[1]).toEqual({ '@type': 'UnitPriceSpecification', price: '45.00', priceCurrency: 'EGP', priceType: 'https://schema.org/ListPrice' });
    expect(feteer.offers.priceSpecification).toBeUndefined();
    expect(ld.makesOffer).toEqual([{ '@type': 'Offer', name: 'Eid', description: '15% off · EID15', url: 'https://app.resuto.test/order/koshary-lab',
      validThrough: '2026-11-01T00:00:00.000Z', eligibleTransactionVolume: { '@type': 'PriceSpecification', price: '100.00', priceCurrency: 'EGP' } }]);
    expect(validateJsonLd(ld)).toEqual([]);
  });

  it('writes Arabic names and descriptions with Western digits', () => {
    const ld = restaurantLd(site(), URL_, 'ar') as any;
    expect(ld.name).toBe('معمل الكشري');
    expect(ld.hasMenu.hasMenuSection[0].name).toBe('أطباق رئيسية');
    expect(ld.makesOffer[0].description).toBe('خصم 15% · EID15');
    expect(JSON.stringify(ld)).not.toMatch(/[٠-٩۰-۹]/);
  });

  it('builds an FAQPage from answered questions only, and none without them', () => {
    expect(faqLd(site(), 'en')).toEqual({ '@context': 'https://schema.org', '@type': 'FAQPage', inLanguage: 'en',
      mainEntity: [{ '@type': 'Question', name: 'Do you deliver?', acceptedAnswer: { '@type': 'Answer', text: 'Yes, in Dokki.' } }] });
    expect(faqLd(site({ sections: [] }), 'en')).toBeNull();
    expect(siteJsonLd(site(), URL_, 'en').map((d) => d['@type'])).toEqual(['Restaurant', 'FAQPage']);
    expect(siteJsonLd(site({ sections: [] }), URL_, 'en').map((d) => d['@type'])).toEqual(['Restaurant']);
    for (const d of siteJsonLd(site(), URL_, 'ar')) expect(validateJsonLd(d)).toEqual([]);
  });

  it('falls back to the highlighted dishes for the menu, and to the ordering URL without any dish', () => {
    const highlights = restaurantLd(site({ sections: [], menuHighlights: [dish()] }), URL_, 'en') as any;
    expect(highlights.hasMenu.hasMenuSection[0].hasMenuItem[0].name).toBe('Koshari');
    expect((restaurantLd(site({ sections: [] }), URL_, 'en') as any).hasMenu).toBe('https://app.resuto.test/order/koshary-lab');
  });

  it('carries no private data: the validator flags private keys and e-mail addresses', () => {
    const ld = siteJsonLd(site(), URL_, 'en');
    const text = JSON.stringify(ld);
    expect(text).not.toMatch(/\bcost|\bstock|customer|staff|redemption|token|@[a-z0-9-]+\.[a-z]{2,}/i);
    expect(validateJsonLd({ ...ld[0], email: 'owner@example.com' })).toEqual(expect.arrayContaining(['$.email: private field', '$.email: looks like an e-mail address']));
    expect(validateJsonLd({ ...ld[0], costMinor: 1200 })).toContain('$.costMinor: private field');
    expect(validateJsonLd({ ...ld[0], description: 'write to chef@restaurant.example' })).toContain('$.description: looks like an e-mail address');
  });

  it('checks the shape: context, known types, required fields and decimal prices', () => {
    expect(validateJsonLd([])).toEqual(['not an object']);
    expect(validateJsonLd({ '@type': 'Restaurant', name: 'x', url: 'u' })).toContain('@context must be https://schema.org');
    expect(validateJsonLd({ '@context': 'https://schema.org', '@type': 'Thing' })).toContain('$: unknown @type Thing');
    expect(validateJsonLd({ '@context': 'https://schema.org', '@type': 'Restaurant', name: 'x' })).toContain('$: Restaurant needs url');
    expect(validateJsonLd({ '@context': 'https://schema.org', '@type': 'Restaurant', name: 'x', url: 'u', makesOffer: [{ '@type': 'Offer', price: 38.25 }] }))
      .toEqual(expect.arrayContaining(['$.makesOffer[0].price: not a decimal price', '$.makesOffer[0]: Offer with a price needs priceCurrency']));
    expect(ldPrice(3825)).toBe('38.25');
    expect(ldPrice(5)).toBe('0.05');
  });

  it('escapes the payload against </script> injection and HTML comments', () => {
    const hostile = site({ seo: { title: {}, description: { en: '</script><script>alert(1)</script><!-- & \u2028' }, ogImageUrl: null } });
    const out = jsonLdScript(restaurantLd(hostile, URL_, 'en'));
    expect(out).not.toMatch(/<\/?script|<!--|&/i);
    expect(out).not.toContain(String.fromCharCode(0x2028));
    expect(out).not.toContain('<');
    expect(JSON.parse(out).description).toBe('</script><script>alert(1)</script><!-- & \u2028');
  });
});
