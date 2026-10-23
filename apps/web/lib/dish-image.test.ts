import { createElement as h, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { PublicMenu, PublicMenuProduct } from '@resuto/contracts';
import { DishImage } from '@/components/public/DishImage';
import { MenuBrowser, ProductSheet, type Cart } from '@/components/guest/menu';
import { Photo } from '@/components/guest/shell';
import { LocaleProvider } from '@/lib/i18n/client';
import { messagesFor } from '@/lib/i18n/messages';
import { DISH_SIZES, dishSrcSet, fixedSizes, parseSrcSet } from './dish-image';

// REM-W01 (CR-12 web side): dish photos carry the API's stored copies as srcset with a `sizes` matching their box, so
// a phone card loads the 320 px copy; the list always reaches as wide as the URL the page used before.

const U = (w: number | 'orig') => `https://media.example/tenant/menu/a${w === 'orig' ? '' : `.w${w}`}.webp?exp=1&sig=abc_-${w}`;

describe('dishSrcSet', () => {
  it('uses the stored copies when imageUrl is one of them (a large original: 320/640/1280 copies, 640 chosen)', () => {
    const p = { imageUrl: U(640), imageSrcSet: `${U(320)} 320w, ${U(640)} 640w, ${U(1280)} 1280w`, imageWidth: 4000, imageHeight: 3000 };
    expect(dishSrcSet(p)).toBe(`${U(320)} 320w, ${U(640)} 640w, ${U(1280)} 1280w`);
  });

  it('adds the original at its own width when it is wider than every copy (512 px photo with only a 320 px copy)', () => {
    const p = { imageUrl: U('orig'), imageSrcSet: `${U(320)} 320w`, imageWidth: 512, imageHeight: 384 };
    expect(dishSrcSet(p)).toBe(`${U(320)} 320w, ${U('orig')} 512w`);
  });

  it('returns nothing when the copies could be too small and the original width is unknown, or there are no copies', () => {
    expect(dishSrcSet({ imageUrl: U('orig'), imageSrcSet: `${U(320)} 320w`, imageWidth: null })).toBeUndefined();
    expect(dishSrcSet({ imageUrl: U('orig'), imageSrcSet: null, imageWidth: 800 })).toBeUndefined();
    expect(dishSrcSet({ imageUrl: U('orig') })).toBeUndefined();
    expect(dishSrcSet({ imageUrl: null, imageSrcSet: `${U(320)} 320w` })).toBeUndefined();
    expect(dishSrcSet(undefined)).toBeUndefined();
  });

  it('skips malformed entries and sorts by width', () => {
    expect(parseSrcSet(`${U(640)} 640w, nonsense, ${U(320)} 320w, ${U(1)} 0w`)).toEqual([{ url: U(640), w: 640 }, { url: U(320), w: 320 }]);
    expect(dishSrcSet({ imageUrl: U(640), imageSrcSet: `${U(640)} 640w, ${U(320)} 320w` })).toBe(`${U(320)} 320w, ${U(640)} 640w`);
  });
});

const product = (over: Partial<PublicMenuProduct> = {}): PublicMenuProduct => ({
  id: 'p1', name: 'Burrata', nameAr: 'بوراتا', description: null, descriptionAr: null, priceMinor: 14500,
  imageUrl: U(640), imageSrcSet: `${U(320)} 320w, ${U(640)} 640w, ${U(1280)} 1280w`, imageWidth: 2000, imageHeight: 1500,
  allergens: [], dietary: [], spiceLevel: 0, available: true, prepMinutes: 10, modifierGroups: [], ...over,
});
const menu = (p: PublicMenuProduct) => ({
  org: { name: 'The Olive Room', nameAr: null, currency: 'EGP', slug: 'olive' },
  branch: { id: 'b', code: 'main', name: 'Main', nameAr: null } as PublicMenu['branch'], branches: [],
  categories: [{ id: 'c1', name: 'Starters', nameAr: null, products: [p] }],
}) as unknown as PublicMenu;
const cart = { items: [], count: 0, add() {}, setQty() {}, clear() {}, addMany() {} } as unknown as Cart;
const render = (locale: 'en' | 'ar', node: ReactNode) =>
  renderToStaticMarkup(h(LocaleProvider, { locale, messages: messagesFor(locale, 'guest'), children: node }));
const imgs = (html: string) => html.match(/<img [^>]*>/g) ?? [];
const decode = (s: string) => s.replace(/&amp;/g, '&');

describe('guest menu, product sheet and storefront render responsive dish photos', () => {
  for (const locale of ['en', 'ar'] as const) {
    it(`menu card: srcset + phone-sized sizes, box reserved (${locale})`, () => {
      const img = imgs(render(locale, h(MenuBrowser, { menu: menu(product()), cart, onOpen() {}, ordering: true })))[0] ?? '';
      expect(decode(img)).toContain(`srcSet="${U(320)} 320w, ${U(640)} 640w, ${U(1280)} 1280w"`);
      expect(img).toContain(`sizes="${DISH_SIZES.guestCard}"`);
      expect(img).toMatch(/width="420" height="420"/);
      // srcset/sizes come before src so a client-side render never starts the src download first.
      expect(img.indexOf('srcSet=')).toBeLessThan(img.indexOf(' src='));
    });
  }

  it('product sheet: srcset with the sheet width', () => {
    const img = imgs(render('en', h(ProductSheet, { product: product(), currency: 'EGP', ordering: true, onAdd() {}, onClose() {} })))[0] ?? '';
    expect(img).toContain('class="gx-product-photo"');
    expect(img).toContain(`sizes="${DISH_SIZES.guestSheet}"`);
    expect(decode(img)).toContain(`${U(320)} 320w`);
  });

  it('keeps the old single-URL image when the API sends no copies (no srcset, no sizes)', () => {
    const img = imgs(render('en', h(MenuBrowser, { menu: menu(product({ imageSrcSet: null })), cart, onOpen() {}, ordering: true })))[0] ?? '';
    expect(img).not.toContain('srcSet');
    expect(img).not.toContain('sizes');
    expect(decode(img)).toContain(`src="${U(640)}"`);
  });

  it('fixed thumbnails default sizes to their CSS size', () => {
    const img = renderToStaticMarkup(h(Photo, { src: U(640), srcSet: dishSrcSet(product()), name: 'x', size: 88 }));
    expect(img).toContain(`sizes="${fixedSizes(88)}"`);
  });

  it('storefront DishImage passes srcset, sizes and the original dimensions', () => {
    const p = product();
    const img = renderToStaticMarkup(h(DishImage, { url: p.imageUrl, srcSet: dishSrcSet(p), sizes: DISH_SIZES.storefrontCard, width: p.imageWidth, height: p.imageHeight, name: 'Burrata' }));
    expect(img).toContain(`sizes="${DISH_SIZES.storefrontCard}"`);
    expect(img).toContain('width="2000" height="1500"');
    expect(decode(img)).toContain(`${U(1280)} 1280w`);
  });
});
