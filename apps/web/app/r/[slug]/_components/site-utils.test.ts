import type { PublicSite } from '@resuto/contracts';
import { describe, expect, it } from 'vitest';
import { heroCopy, showsDemoStory } from './site-utils';

const t = (key: string) => `t:${key}`;
const site = (over: { demo?: boolean; template?: PublicSite['template']; pickup?: boolean } = {}): PublicSite => ({
  slug: 'koshary-lab', revision: 1, publishedAt: null, preview: false,
  org: { name: 'Koshary Lab', nameAr: 'معمل الكشري', currency: 'EGP', country: 'EG', defaultLocale: 'en', demo: over.demo ?? false },
  template: over.template ?? 'olive',
  theme: { primaryColor: '#000000', accentColor: '#ffffff', backgroundColor: '#ffffff', font: 'manrope', logoUrl: null, heroUrl: null, tagline: {} },
  seo: { title: {}, description: {}, ogImageUrl: null },
  sections: [],
  branches: [{ id: 'b', code: 'main', name: 'Main', nameAr: null, address: null, city: 'Cairo', phone: null, latitude: null, longitude: null, openingHours: [],
    acceptsDineIn: true, acceptsPickup: over.pickup ?? true, acceptsDelivery: false, acceptsReservations: true }],
  menuHighlights: [], canonicalHost: null, links: { reserve: '/reserve/x', order: '/order/x', site: '/r/x' }, storefronts: [],
} as PublicSite);
const hero = (content: Record<string, unknown>) => ({ id: 's1', kind: 'hero', content } as unknown as PublicSite['sections'][number]);

describe('restaurant site copy (template words are demo copy only)', () => {
  it('shows a real restaurant its own name and no invented body when the headline is not written', () => {
    for (const content of [{}, { headline: { en: 'Koshary Lab' } }]) {
      expect(heroCopy(hero(content), site(), 'en', t)).toEqual({ eyebrow: 'Koshary Lab', headline: 'Koshary Lab', body: '' });
    }
    expect(heroCopy(hero({}), site(), 'ar', t)).toEqual({ eyebrow: 'معمل الكشري', headline: 'معمل الكشري', body: '' });
  });

  it('keeps the legacy hero words for the demo restaurant only', () => {
    expect(heroCopy(hero({}), site({ demo: true }), 'en', t)).toEqual({ eyebrow: 'Koshary Lab', headline: 't:studio.site.tpl.headline', body: 't:studio.site.tpl.body' });
  });

  it('always uses what the owner wrote', () => {
    const written = hero({ headline: { en: 'Lentils, done right.' }, body: { en: 'Since 1998.' } });
    expect(heroCopy(written, site({ demo: true }), 'en', t)).toMatchObject({ headline: 'Lentils, done right.', body: 'Since 1998.' });
    expect(heroCopy(written, site(), 'en', t)).toMatchObject({ headline: 'Lentils, done right.', body: 'Since 1998.' });
  });

  it('shows the fixed "Dinner, without the back-and-forth." story only on the demo restaurant', () => {
    expect(showsDemoStory(site())).toBe(false);
    expect(showsDemoStory(site({ demo: true }))).toBe(true);
    expect(showsDemoStory(site({ demo: true, pickup: false }))).toBe(false);
    expect(showsDemoStory(site({ demo: true, template: 'minimal' }))).toBe(false);
  });
});

describe('altOf (22-STUDIO)', () => {
  it('uses the page language’s alt text, falling back to the other language, else empty', async () => {
    const { altOf } = await import('./site-utils');
    expect(altOf({ alt: 'Grilled seabass', altAr: 'قاروص مشوي' }, 'ar')).toBe('قاروص مشوي');
    expect(altOf({ alt: 'Grilled seabass', altAr: 'قاروص مشوي' }, 'en')).toBe('Grilled seabass');
    expect(altOf({ alt: 'Grilled seabass', altAr: null }, 'ar')).toBe('Grilled seabass');
    expect(altOf({ alt: null, altAr: 'قاروص' }, 'en')).toBe('قاروص');
    expect(altOf(null, 'en')).toBe('');
  });
});
