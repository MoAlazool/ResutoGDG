// @vitest-environment jsdom
import type { PublicMenu, PublicSite } from '@resuto/contracts';
import { describe, expect, it } from 'vitest';
import { auditCounts, auditSite, outlineProblems, phonesIn, readRendered, robotsAllows, timesIn, type AuditInput } from './site-audit';

const branch = (over: Partial<PublicSite['branches'][number]> = {}): PublicSite['branches'][number] => ({
  id: 'b1', code: 'main', name: 'Zamalek', nameAr: 'الزمالك', address: '14 26th of July St', city: 'Cairo', phone: '+20223456789', latitude: 30.06261, longitude: 31.21972,
  openingHours: [{ day: 0, opens: '12:00', closes: '23:00' }], acceptsDineIn: true, acceptsPickup: true, acceptsDelivery: true, acceptsReservations: true, ...over,
});
const site = (over: Partial<PublicSite> = {}): PublicSite => ({
  slug: 'olive', revision: 2, publishedAt: '2026-10-20T10:00:00.000Z', preview: true,
  org: { name: 'The Olive Room', nameAr: 'غرفة الزيتون', currency: 'EGP', country: 'EG', defaultLocale: 'ar', demo: false,
    socialLinks: { instagram: 'https://instagram.com/olive', google_maps: 'https://maps.app.goo.gl/olive' } },
  template: 'olive',
  theme: { primaryColor: '#173f36', accentColor: '#C85E33', backgroundColor: '#faf9f5', font: 'manrope', logoUrl: 'https://cdn.example/logo.png', heroUrl: 'https://cdn.example/hero.webp', tagline: {} },
  seo: { title: { en: 'The Olive Room — Mediterranean in Zamalek', ar: 'غرفة الزيتون — مطبخ متوسطي في الزمالك' },
    description: { en: 'Seasonal Mediterranean plates in Zamalek, Cairo. Book a table or order for pickup and delivery online.', ar: 'أطباق متوسطية موسمية في الزمالك بالقاهرة. احجز طاولة أو اطلب للاستلام والتوصيل عبر الإنترنت.' },
    ogImageUrl: 'https://cdn.example/og.webp' },
  sections: [
    { id: 'a', kind: 'about', content: { headline: { en: 'About us', ar: 'من نحن' }, body: { en: 'A neighbourhood restaurant.', ar: 'مطعم الحي.' } } },
    { id: 'f', kind: 'faq', content: { items: [
      { title: { en: 'When are you open?', ar: 'متى تفتحون؟' }, body: { en: 'Sunday 12:00–23:00.', ar: 'الأحد 12:00–23:00.' } },
      { title: { en: 'Where are you?', ar: 'أين أنتم؟' }, body: { en: '14 26th of July St, Cairo', ar: '14 شارع 26 يوليو، القاهرة' } },
      { title: { en: 'Can I book?', ar: 'هل يمكنني الحجز؟' }, body: { en: 'Yes, online.', ar: 'نعم، عبر الإنترنت.' } }] } },
  ],
  branches: [branch()], canonicalHost: null,
  menuHighlights: [{ id: 'p1', name: 'Seabass', nameAr: 'قاروص', description: 'With lemon butter.', descriptionAr: 'بزبدة الليمون.', priceMinor: 34500, currency: 'EGP', imageUrl: null, dietary: [] }],
  links: { reserve: '/reserve/olive', order: '/order/olive', site: '/r/olive' }, storefronts: [], ...over,
} as PublicSite);
const menu = (over: Partial<PublicMenu> = {}): PublicMenu => ({
  org: { name: 'The Olive Room', nameAr: 'غرفة الزيتون', currency: 'EGP', slug: 'olive' },
  branch: { id: 'b1', code: 'main', name: 'Zamalek', nameAr: 'الزمالك', acceptsDineIn: true, acceptsPickup: true, acceptsDelivery: true, acceptsReservations: true,
    deliveryFeeMinor: 0, minOrderMinor: 0, address: '14 26th of July St', city: 'Cairo', phone: '+20223456789' },
  branches: [{ id: 'b1', code: 'main', name: 'Zamalek', nameAr: 'الزمالك', acceptsDineIn: true, acceptsPickup: true, acceptsDelivery: true, acceptsReservations: true,
    deliveryFeeMinor: 0, minOrderMinor: 0, address: '14 26th of July St', city: 'Cairo', phone: '+20223456789' }],
  categories: [{ id: 'c', name: 'Mains', nameAr: 'رئيسي', products: [
    { id: 'p1', name: 'Seabass', nameAr: 'قاروص', description: 'With lemon butter.', descriptionAr: 'بزبدة الليمون.', priceMinor: 34500, imageUrl: null, allergens: [], dietary: [], spiceLevel: 0, available: true, prepMinutes: null, modifierGroups: [] },
  ] }],
  ...over,
} as PublicMenu);
const input = (over: Partial<AuditInput> = {}): AuditInput => ({
  draft: site(), published: site({ preview: false }), website: { publishedRevision: 2, hasUnpublishedChanges: false },
  siteUrl: 'https://app.resuto.test/r/olive', menu: menu(), robotsTxt: 'User-agent: *\nAllow: /r/\nDisallow: /dashboard\n',
  rendered: { en: { headings: [{ level: 1, text: 'The Olive Room' }, { level: 2, text: 'About us' }], images: [{ src: 'a.webp', alt: 'Dining room', decorative: false }], internalLinks: ['/order/olive'] } },
  media: [{ id: 'm', url: 'a.webp', alt: 'Dining room', altAr: 'قاعة الطعام', inUse: true }],
  ...over,
});
const byId = (checks: ReturnType<typeof auditSite>, id: string, locale?: string) => checks.find((c) => c.id === id && (!locale || c.locale === locale));

describe('Optimize checks (SEO / AEO / GEO) from real site data', () => {
  it('a complete, published, consistent site passes every counted check', () => {
    const checks = auditSite(input());
    const bad = checks.filter((c) => c.status === 'fail' || c.status === 'warn').map((c) => `${c.id}${c.locale ? `:${c.locale}` : ''} ${JSON.stringify(c.details ?? c.vars)}`);
    // servesCuisine has no field in Resuto: it is listed (with that note) but does not fail the recommended check.
    expect(bad).toEqual([]);
    const counts = auditCounts(checks);
    expect(counts.failed).toBe(0);
    expect(counts.passed).toBe(counts.total);
    expect(auditCounts(checks, 'seo').total + auditCounts(checks, 'aeo').total + auditCounts(checks, 'geo').total).toBe(counts.total);
  });

  it('reports missing and over-long search text per language, and untranslated duplicates', () => {
    const checks = auditSite(input({ draft: site({ seo: { title: { en: 'The Olive Room', ar: 'The Olive Room' }, description: { en: 'x'.repeat(200) }, ogImageUrl: null } }) }));
    expect(byId(checks, 'seo.title', 'en')?.status).toBe('warn'); // 14 characters, under 15
    expect(byId(checks, 'seo.description', 'en')).toMatchObject({ status: 'warn', vars: { length: 200 } });
    expect(byId(checks, 'seo.description', 'ar')?.status).toBe('fail');
    expect(byId(checks, 'seo.duplicateLocale')).toMatchObject({ status: 'warn', details: ['title'] });
    expect(byId(checks, 'seo.shareImage')?.status).toBe('warn');
    expect(byId(checks, 'geo.description', 'ar')?.status).toBe('fail');
    expect(byId(checks, 'geo.language', 'ar')?.details).toContain('seo.description');
  });

  it('indexability: unpublished sites, unpublished changes and robots.txt blocks', () => {
    const never = auditSite(input({ published: null, website: { publishedRevision: 0, hasUnpublishedChanges: true } }));
    expect(byId(never, 'seo.indexable')).toMatchObject({ status: 'fail', fix: { kind: 'publish' } });
    expect(byId(never, 'seo.unpublished')?.status).toBe('warn');
    expect(byId(never, 'seo.sitemap')?.status).toBe('warn');
    const blocked = auditSite(input({ robotsTxt: 'User-agent: *\nDisallow: /r/\n' }));
    expect(byId(blocked, 'seo.robots')).toMatchObject({ status: 'fail', details: ['/r/olive'] });
    expect(byId(auditSite(input({ robotsTxt: null })), 'seo.robots')?.status).toBe('info');
  });

  it('headings, image alt text and internal links come from the rendered page', () => {
    const checks = auditSite(input({ rendered: { ar: { headings: [{ level: 2, text: 'من نحن' }, { level: 4, text: '' }], images: [{ src: 'a', alt: null, decorative: false }, { src: 'l', alt: '', decorative: true }], internalLinks: [] } } }));
    expect(byId(checks, 'seo.h1', 'ar')).toMatchObject({ status: 'fail', vars: { count: 0 } });
    expect(byId(checks, 'seo.headingOrder', 'ar')).toMatchObject({ status: 'warn', vars: { empty: 1 } });
    expect(byId(checks, 'seo.imageAlt', 'ar')).toMatchObject({ status: 'fail', vars: { missing: 1, total: 1 } });
    expect(byId(checks, 'seo.internalLinks', 'ar')?.status).toBe('warn');
    expect(byId(checks, 'seo.h1', 'en')).toBeUndefined(); // not rendered: not checked
    const media = auditSite(input({ media: [{ id: 'm', url: 'a', alt: 'Room', altAr: null, inUse: true }, { id: 'n', url: 'b', alt: null, altAr: null, inUse: false }] }));
    expect(byId(media, 'seo.mediaAlt')).toMatchObject({ status: 'warn', vars: { missing: 0, missingAr: 1, total: 1 } });
  });

  it('AEO: FAQ, hours, address, phone and menu facts from the branch and menu data', () => {
    const checks = auditSite(input({ draft: site({ sections: [], branches: [branch({ openingHours: [], phone: null }), branch({ id: 'b2', code: 'two', name: 'Downtown', address: null })] }) }));
    expect(byId(checks, 'aeo.faq')).toMatchObject({ status: 'warn', fix: { kind: 'ai', request: 'faq' } });
    expect(byId(checks, 'aeo.hours')).toMatchObject({ status: 'fail', details: ['Zamalek'] });
    expect(byId(checks, 'aeo.address')).toMatchObject({ status: 'fail', details: ['Downtown'] });
    expect(byId(checks, 'aeo.phone')).toMatchObject({ status: 'warn', details: ['Zamalek'] });
    expect(byId(checks, 'aeo.ldRequired', 'en')).toMatchObject({ status: 'pass' });
    expect(byId(checks, 'aeo.menuPrices')).toMatchObject({ status: 'pass', vars: { count: 1, categories: 1, currency: 'EGP' } });
    const empty = auditSite(input({ menu: menu({ categories: [] }) }));
    expect(byId(empty, 'aeo.menuPrices')?.status).toBe('fail');
    const partial = auditSite(input({ draft: site({ sections: [{ id: 'f', kind: 'faq', content: { items: [{ title: { en: 'Q?' }, body: { en: 'A.' } }] } }] }) }));
    expect(byId(partial, 'aeo.faqLanguage', 'ar')).toMatchObject({ status: 'warn', vars: { missing: 1, total: 1 } });
  });

  it('GEO: contradictions between pages, and facts in the text that the branch records contradict', () => {
    const stale = auditSite(input({ menu: menu({ branches: [{ ...menu().branches[0]!, phone: '+20200000000' }] }),
      published: site({ branches: [branch({ address: '1 Old St' })] }) }));
    expect(byId(stale, 'geo.nap')?.status).toBe('fail');
    expect(byId(stale, 'geo.nap')?.details).toEqual([expect.stringContaining('phone'), expect.stringContaining('published site shows older details')]);
    const text = auditSite(input({ draft: site({ sections: [{ id: 'a', kind: 'about', content: { body: { en: 'Open daily 9 am to 11 pm. Call 0100 123 4567.', ar: 'نفتح يوميًا.' } } }] }) }));
    const facts = byId(text, 'geo.textFacts');
    expect(facts?.status).toBe('warn');
    expect(facts?.details?.join(' ')).toMatch(/09:00/);
    expect(facts?.details?.join(' ')).toMatch(/01001234567/);
    // 11 pm = 23:00 matches the branch hours, so it is not listed.
    expect(facts?.details?.join(' ')).not.toMatch(/23:00/);
    expect(byId(auditSite(input()), 'geo.entities')).toMatchObject({ status: 'pass' });
    expect(byId(auditSite(input({ menu: null })), 'geo.entities')?.status).toBe('warn');
  });

  it('local listing facts: map pins, the Maps profile, the logo and photos', () => {
    const bare = auditSite(input({ draft: site({ org: { ...site().org, socialLinks: {} }, theme: { ...site().theme, logoUrl: null, heroUrl: null },
      branches: [branch({ latitude: null, longitude: null })] }) }));
    expect(byId(bare, 'geo.mapPin')).toMatchObject({ status: 'warn', details: ['Zamalek'] });
    expect(byId(bare, 'geo.mapsLink')?.status).toBe('warn');
    expect(byId(bare, 'geo.logo')?.status).toBe('warn');
    expect(byId(bare, 'seo.photos')?.status).toBe('warn');
    expect(byId(bare, 'geo.sameAs')?.status).toBe('warn');
    const full = auditSite(input());
    for (const id of ['geo.mapPin', 'geo.mapsLink', 'geo.logo', 'seo.photos', 'geo.sameAs']) expect(byId(full, id)?.status, id).toBe('pass');
  });

  it('nothing is a score: info items explain without counting; Web Vitals only link to measured data for public https sites', () => {
    const checks = auditSite(input());
    expect(checks.every((c) => ['pass', 'fail', 'warn', 'info'].includes(c.status))).toBe(true);
    expect(byId(checks, 'seo.webVitals')).toMatchObject({ status: 'info', fix: { kind: 'link', href: expect.stringContaining('pagespeed.web.dev') } });
    expect(byId(auditSite(input({ siteUrl: 'http://localhost:3000/r/olive' })), 'seo.webVitals')?.fix).toBeUndefined();
    expect(JSON.stringify(checks)).not.toMatch(/score|rank/i);
  });
});

describe('audit helpers', () => {
  it('robots.txt: longest match wins, only the * group counts', () => {
    const robots = 'User-agent: Googlebot\nDisallow: /\n\nUser-agent: *\nDisallow: /r/\nAllow: /r/olive\n# comment\nDisallow: /dashboard\n';
    expect(robotsAllows(robots, '/r/olive')).toBe(true);
    expect(robotsAllows(robots, '/r/other')).toBe(false);
    expect(robotsAllows(robots, '/m/olive')).toBe(true);
    expect(robotsAllows('', '/r/x')).toBe(true);
    expect(robotsAllows('User-agent: *\nDisallow: /*.xml$\n', '/r/x/sitemap.xml')).toBe(false);
  });

  it('heading outline, times and phone numbers in text', () => {
    expect(outlineProblems([{ level: 1, text: 'A' }, { level: 2, text: 'B' }, { level: 4, text: 'C' }, { level: 2, text: ' ' }]))
      .toEqual({ h1: 1, skipped: ['h2 → h4 “C”'], empty: 1 });
    expect(timesIn('Open 12:00–23:30, brunch 9 am, late 11pm, ٩:٠٠ مساءً').sort()).toEqual(['09:00', '12:00', '21:00', '23:00', '23:30']);
    expect(timesIn('Since 1998, 3 branches')).toEqual([]);
    expect(phonesIn('Call +20 2 2345 6789 or 0100-123-4567; 25 dishes')).toEqual(['20223456789', '01001234567']);
  });

  it('reads headings, images and internal links from a rendered page', () => {
    document.body.innerHTML = `<div class="site-root"><header><a class="olive-logo" href="/r/olive"><img src="logo" alt=""></a></header>
      <h1>Olive</h1><section hidden><h2>Hidden</h2></section><h2>Menu</h2><img src="dish" alt="Seabass"><img src="x"><img src="s" alt="" aria-hidden="true">
      <a href="/order/olive">Order</a><a href="https://instagram.com/olive">IG</a><a href="https://app.resuto.test/m/olive">Menu</a></div>`;
    const r = readRendered(document, 'https://app.resuto.test');
    expect(r.headings).toEqual([{ level: 1, text: 'Olive' }, { level: 2, text: 'Menu' }]);
    expect(r.images.map((i) => [i.src, i.alt, i.decorative])).toEqual([['logo', '', true], ['dish', 'Seabass', false], ['x', null, false], ['s', '', true]]);
    expect(r.internalLinks).toEqual(['/r/olive', '/order/olive', 'https://app.resuto.test/m/olive']);
  });
});
