import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { PublicSite } from '@resuto/contracts';
import { DISH_SIZES } from '@/lib/dish-image';
import { SiteView } from './SiteView';

// REM-W01 review: the restaurant site's menu highlights load the API's stored copies (srcset + sizes) like the guest
// menu and storefront, so a phone's two-column card fetches the 320 px copy instead of the 640 px one.

const U = (w: number) => `https://media.example/o/menu/a.w${w}.webp?exp=1&sig=s${w}`;
const t = (key: string) => key;
const site = (template: PublicSite['template']): PublicSite => ({
  slug: 'olive', revision: 1, publishedAt: null, preview: false,
  org: { name: 'Olive', nameAr: 'أوليف', currency: 'EGP', country: 'EG', defaultLocale: 'en', demo: false },
  template,
  theme: { primaryColor: '#213526', accentColor: '#c96f45', backgroundColor: '#ffffff', font: 'manrope', logoUrl: null, heroUrl: null, tagline: {} },
  seo: { title: {}, description: {}, ogImageUrl: null },
  sections: [{ id: 's1', kind: 'menu_highlights', content: {} } as unknown as PublicSite['sections'][number]],
  branches: [{ id: 'b', code: 'main', name: 'Main', nameAr: null, address: null, city: 'Cairo', phone: null, latitude: null, longitude: null, openingHours: [],
    acceptsDineIn: true, acceptsPickup: true, acceptsDelivery: false, acceptsReservations: true }],
  menuHighlights: [
    { id: 'p1', name: 'Burrata', nameAr: 'بوراتا', description: null, descriptionAr: null, priceMinor: 14500, currency: 'EGP', dietary: [],
      imageUrl: U(640), imageSrcSet: `${U(320)} 320w, ${U(640)} 640w, ${U(1280)} 1280w`, imageWidth: 2000, imageHeight: 1500 },
    { id: 'p2', name: 'Soup', nameAr: null, description: null, descriptionAr: null, priceMinor: 9000, currency: 'EGP', dietary: [],
      imageUrl: 'https://media.example/legacy.jpg', imageSrcSet: null, imageWidth: null, imageHeight: null },
  ],
  canonicalHost: null, links: { reserve: '/reserve/olive', order: '/order/olive', site: '/r/olive' }, storefronts: [],
} as PublicSite);
const imgs = (html: string) => (html.match(/<img [^>]*>/g) ?? []).map((s) => s.replace(/&amp;/g, '&'));

describe('restaurant site menu highlights load responsive photos', () => {
  for (const locale of ['en', 'ar'] as const) {
    it(`olive dish cards: srcset + the card's sizes; a photo without copies keeps its single URL (${locale})`, () => {
      const [burrata, soup] = imgs(renderToStaticMarkup(h(SiteView, { site: site('olive'), locale, t })));
      expect(burrata).toContain(`srcSet="${U(320)} 320w, ${U(640)} 640w, ${U(1280)} 1280w"`);
      expect(burrata).toContain(`sizes="${DISH_SIZES.siteCard}"`);
      expect(burrata).toContain(`src="${U(640)}"`);
      // The square card box comes from CSS; height/width attributes would override it.
      expect(burrata).not.toMatch(/ (width|height)="/);
      expect(soup).not.toContain('srcSet');
      expect(soup).toContain('src="https://media.example/legacy.jpg"');
    });

    it(`smash cards use the storefront card sizes (${locale})`, () => {
      const [burrata] = imgs(renderToStaticMarkup(h(SiteView, { site: site('smash'), locale, t })));
      expect(burrata).toContain(`srcSet="${U(320)} 320w, ${U(640)} 640w, ${U(1280)} 1280w"`);
      expect(burrata).toContain(`sizes="${DISH_SIZES.storefrontCard}"`);
    });
  }
});
