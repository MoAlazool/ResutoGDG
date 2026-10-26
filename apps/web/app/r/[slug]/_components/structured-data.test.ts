import type { PublicSite, PublicSiteProduct } from '@resuto/contracts';
import { describe, expect, it } from 'vitest';
import type { PublicMenu } from '@resuto/contracts';
import { faqLd, jsonLdScript, ldPrice, menuPageJsonLd, priceRange, restaurantLd, siteJsonLd, siteUrls, validateJsonLd } from './structured-data';

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
    // The menu lives on the menu page (/m/<slug>); the website's full-menu section describes the same Menu node.
    expect(ld['@id']).toBe(`${URL_}#restaurant`);
    expect(ld.menu).toBe('https://app.resuto.test/m/koshary-lab');
    expect(ld.hasMenu).toMatchObject({ '@type': 'Menu', '@id': 'https://app.resuto.test/m/koshary-lab#menu', url: 'https://app.resuto.test/m/koshary-lab',
      hasMenuSection: [{ '@type': 'MenuSection', name: 'Mains' }] });
    // Lowest and highest price shown on the page (Koshari 38.25 after its discount, also in the offers section).
    expect(ld.priceRange).toBe('EGP 38.25');
    expect(ld.alternateName).toBe('معمل الكشري');
    const [koshari, feteer] = ld.hasMenu.hasMenuSection[0].hasMenuItem;
    expect(koshari).toMatchObject({ '@type': 'MenuItem', name: 'Koshari', suitableForDiet: 'https://schema.org/VegetarianDiet',
      offers: { '@type': 'Offer', price: '38.25', priceCurrency: 'EGP', url: 'https://app.resuto.test/order/koshary-lab' } });
    // The website does not know today's availability, so it claims none.
    expect(koshari.offers.availability).toBeUndefined();
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

  it('without a full-menu section, points to the menu page (a few highlighted dishes are not the menu)', () => {
    const highlights = restaurantLd(site({ sections: [], menuHighlights: [dish(), dish({ id: 'p3', priceMinor: 12000 })] }), URL_, 'en') as any;
    expect(highlights.hasMenu).toBe('https://app.resuto.test/m/koshary-lab');
    expect(highlights.priceRange).toBe('EGP 38.25–120.00');
    const bare = restaurantLd(site({ sections: [] }), URL_, 'en') as any;
    expect(bare.hasMenu).toBe('https://app.resuto.test/m/koshary-lab');
    expect(bare.priceRange).toBeUndefined();
    expect(priceRange([], 'EGP')).toBeNull();
  });

  it('on a custom domain the menu and ordering pages are on that host, and other branches are departments with their own facts', () => {
    const custom = site({ canonicalHost: 'kosharylab.example', branches: [...site().branches,
      { id: 'b2', code: 'zamalek', name: 'Zamalek', nameAr: 'الزمالك', address: '1 Brazil St', city: 'Cairo', phone: null, latitude: null, longitude: null,
        openingHours: [{ day: 0, opens: '09:00', closes: '17:00' }], acceptsDineIn: true, acceptsPickup: false, acceptsDelivery: false, acceptsReservations: true }] });
    expect(siteUrls(custom, 'https://kosharylab.example/')).toEqual({ site: 'https://kosharylab.example/', menu: 'https://kosharylab.example/m/koshary-lab', order: 'https://kosharylab.example/order' });
    const ld = restaurantLd(custom, 'https://kosharylab.example/', 'ar') as any;
    expect(ld.department).toEqual([{ '@type': 'Restaurant', '@id': 'https://kosharylab.example/#restaurant-zamalek', name: 'الزمالك', url: 'https://kosharylab.example/',
      address: { '@type': 'PostalAddress', streetAddress: '1 Brazil St', addressLocality: 'Cairo', addressCountry: 'EG' },
      openingHoursSpecification: [{ '@type': 'OpeningHoursSpecification', dayOfWeek: 'https://schema.org/Sunday', opens: '09:00', closes: '17:00' }] }]);
    expect(ld.acceptsReservations).toBe(true);
    expect(validateJsonLd(ld)).toEqual([]);
  });

  it('the menu page carries the whole menu (availability from the menu) under the same @ids as the website', () => {
    const p = (id: string, over: Record<string, unknown> = {}) => ({ id, name: `Dish ${id}`, nameAr: null, description: null, descriptionAr: null, priceMinor: 5000, imageUrl: null,
      allergens: [], dietary: [], spiceLevel: 0, available: true, prepMinutes: null, modifierGroups: [], ...over });
    const branch = { id: 'b', code: 'main', name: 'Dokki', nameAr: 'الدقي', acceptsDineIn: true, acceptsPickup: true, acceptsDelivery: true, acceptsReservations: false,
      deliveryFeeMinor: 0, minOrderMinor: 0, address: '5 Tahrir St', city: 'Giza', phone: '+20212345678' };
    const menu = { org: { name: 'Koshary Lab', nameAr: 'معمل الكشري', currency: 'EGP', slug: 'koshary-lab' }, branch, branches: [branch],
      categories: [{ id: 'c', name: 'Mains', nameAr: 'رئيسي', products: [p('1'), p('2', { available: false, priceMinor: 9900 })] }, { id: 'e', name: 'Empty', nameAr: null, products: [] }] } as unknown as PublicMenu;
    const menuUrl = 'https://app.resuto.test/m/koshary-lab';
    const [m, r] = menuPageJsonLd(menu, site(), URL_, menuUrl, 'en') as any[];
    expect(m).toMatchObject({ '@context': 'https://schema.org', '@type': 'Menu', '@id': `${menuUrl}#menu`, url: menuUrl, name: 'Koshary Lab' });
    expect(m.hasMenuSection).toHaveLength(1);
    expect(m.hasMenuSection[0].hasMenuItem.map((i: any) => [i.offers.price, i.offers.availability])).toEqual([['50.00', 'https://schema.org/InStock'], ['99.00', 'https://schema.org/SoldOut']]);
    expect(r).toMatchObject({ '@type': 'Restaurant', '@id': `${URL_}#restaurant`, name: 'Koshary Lab', telephone: '+20212345678', hasMenu: { '@id': `${menuUrl}#menu` },
      menu: menuUrl, priceRange: 'EGP 50.00–99.00' });
    expect(r.makesOffer).toBeUndefined();
    for (const d of [m, r]) expect(validateJsonLd(d)).toEqual([]);
    // Without a published website: the Menu alone.
    expect(menuPageJsonLd(menu, null, null, menuUrl, 'ar').map((d: any) => d['@type'])).toEqual(['Menu']);
    expect(menuPageJsonLd({ ...menu, categories: [] }, null, null, menuUrl, 'en')).toEqual([]);
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
