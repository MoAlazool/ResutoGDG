import type { PublicSite } from '@resuto/contracts';
import { describe, expect, it } from 'vitest';
import { seoChecklist } from './studio-seo';

const base = (over: Partial<PublicSite> = {}): PublicSite => ({
  slug: 'grill', revision: 1, publishedAt: null, preview: true,
  org: { name: 'Grill', nameAr: null, currency: 'EGP', country: 'EG', defaultLocale: 'en', demo: false, socialLinks: {} },
  template: 'olive', theme: { primaryColor: '#000000', accentColor: '#ffffff', backgroundColor: '#ffffff', font: 'manrope', logoUrl: null, heroUrl: null, tagline: {} },
  seo: { title: { en: 'Grill' }, description: {}, ogImageUrl: null }, sections: [],
  branches: [{ id: 'b', code: 'main', name: 'Main', nameAr: null, address: null, city: 'Cairo', phone: null, latitude: null, longitude: null, openingHours: [],
    acceptsDineIn: true, acceptsPickup: true, acceptsDelivery: false, acceptsReservations: false }],
  menuHighlights: [], canonicalHost: null, links: { reserve: '/reserve/grill', order: '/order/grill', site: '/r/grill' }, storefronts: [], ...over,
} as PublicSite);
const done = (s: PublicSite) => Object.fromEntries(seoChecklist(s, 'https://app.example/r/grill').map((c) => [c.key, c.ok]));

describe('Studio SEO / AEO / GEO checklist', () => {
  it('reports what a bare site still needs, in three groups', () => {
    const items = seoChecklist(base(), 'https://app.example/r/grill');
    expect(new Set(items.map((i) => i.group))).toEqual(new Set(['search', 'local', 'answers']));
    expect(done(base())).toMatchObject({ title: false, description: false, shareImage: false, hreflang: true, sitemap: true, structuredData: true,
      nameBoth: false, address: false, phone: false, mapPin: false, mapsLink: false, logo: false, photos: false, faq: false, hours: false, menuText: false, aboutBoth: false });
  });

  it('marks AI answer readiness when the site has 3 answered questions, hours everywhere and menu text', () => {
    const qa = (q: string) => ({ title: { en: q }, body: { en: 'Yes.' } });
    const site = base({
      branches: [{ ...base().branches[0]!, openingHours: [{ day: 1, opens: '09:00', closes: '17:00' }] }],
      sections: [
        { id: 'f', kind: 'faq', content: { items: [qa('a?'), qa('b?'), qa('c?'), { title: { en: 'no answer?' } }] } },
        { id: 'm', kind: 'menu_full', content: { menu: [{ id: 'c', name: 'Mains', nameAr: null, items: [{ id: 'p', name: 'Koshari', nameAr: null, description: null, descriptionAr: null, priceMinor: 100, currency: 'EGP', imageUrl: null, dietary: [] }] }] } },
        { id: 'h', kind: 'hero', content: { body: { en: 'Since 1998', ar: 'منذ 1998' } } },
      ],
    });
    expect(done(site)).toMatchObject({ faq: true, hours: true, menuText: true, aboutBoth: true });
    const two = base({ sections: [{ id: 'f', kind: 'faq', content: { items: [qa('a?'), qa('b?')] } }] });
    expect(done(two).faq).toBe(false);
  });

  it('counts described highlights as menu text when at least half have a description', () => {
    const dish = (d: string | null) => ({ id: d ?? 'x', name: 'n', nameAr: null, description: d, descriptionAr: null, priceMinor: 1, currency: 'EGP', imageUrl: null, dietary: [] });
    expect(done(base({ menuHighlights: [dish('a'), dish(null)] })).menuText).toBe(true);
    expect(done(base({ menuHighlights: [dish('a'), dish(null), dish(null)] })).menuText).toBe(false);
  });

  it('marks local listing facts per branch', () => {
    const site = base({ org: { ...base().org, nameAr: 'جريل', socialLinks: { google_maps: 'https://maps.app.goo.gl/x' } },
      theme: { ...base().theme, logoUrl: 'https://cdn/l.png', heroUrl: 'https://cdn/h.jpg' },
      branches: [{ ...base().branches[0]!, address: '1 Nile St', phone: '+20212345678', latitude: 30, longitude: 31 }] });
    expect(done(site)).toMatchObject({ nameBoth: true, address: true, phone: true, mapPin: true, mapsLink: true, logo: true, photos: true });
  });
});
