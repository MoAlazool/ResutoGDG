import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { PublicBranch, PublicMenu, PublicMenuProduct } from '@resuto/contracts';
import { LocaleProvider } from '@/lib/i18n/client';
import { messagesFor } from '@/lib/i18n/messages';
import { MenuOnlyExperience } from './MenuOnlyExperience';

// 21-ONB: /m/<slug> is the view-only menu the menu QR opens. Rendered from the real component (guest messages only,
// as the root layout ships them): the menu is there, nothing can start an order, and only safe links are shown.

const branch = (code: string, name: string): PublicBranch => ({
  id: `b-${code}`, code, name, nameAr: null, acceptsDineIn: true, acceptsPickup: true, acceptsDelivery: true, acceptsReservations: true,
  deliveryFeeMinor: 0, minOrderMinor: 0, address: null, city: null, phone: null,
});
const dish = (id: string, name: string, priceMinor: number, available = true, withOptions = false): PublicMenuProduct => ({
  id, name, nameAr: null, description: `${name} description`, descriptionAr: null, priceMinor, imageUrl: null, allergens: [], dietary: [],
  spiceLevel: 0, available, prepMinutes: null,
  modifierGroups: withOptions ? [{ id: 'g1', name: 'Size', nameAr: null, minSelect: 1, maxSelect: 1, options: [{ id: 'o1', name: 'Large', nameAr: null, priceDeltaMinor: 500, available: true }] }] as any : [],
});
const menu = (socialLinks: Record<string, unknown> = {}, branches = [branch('main', 'Zamalek')]): PublicMenu => ({
  org: { name: 'The Olive Room', nameAr: 'غرفة الزيتون', currency: 'EGP', slug: 'the-olive-room', socialLinks: socialLinks as any },
  branch: branches[0]!, branches,
  categories: [{ id: 'c1', name: 'Mains', nameAr: null, products: [dish('p1', 'Koshary', 9500), dish('p2', 'Molokhia', 12000, false), dish('p3', 'Fatta', 15000, true, true)] }],
});
const render = (m: PublicMenu, locale: 'en' | 'ar' = 'en') => renderToStaticMarkup(h(LocaleProvider, {
  locale, messages: messagesFor(locale, 'guest'),
  children: h(MenuOnlyExperience, { slug: 'the-olive-room', initialMenu: m }),
}));

describe('view-only menu /m/[slug]', () => {
  it('shows categories, dishes, prices and availability', () => {
    const html = render(menu());
    expect(html).toContain('Mains');
    for (const name of ['Koshary', 'Molokhia', 'Fatta']) expect(html).toContain(name);
    expect(html).toMatch(/95(\.00)?/);
    expect(html).toContain('Sold out');
    expect(html).toContain('This menu is for browsing');
  });

  it('has no way to order: no Add or Choose buttons, no cart dock, no assistant, no checkout', () => {
    const html = render(menu());
    expect(html).not.toContain('gx-add');
    expect(html).not.toContain('gx-stepper');
    expect(html).not.toContain('gx-dock');
    expect(html).not.toMatch(/>\s*\+?\s*Add\s*</);
    expect(html).not.toContain('Choose');
    expect(html).not.toMatch(/checkout|Help me choose/i);
  });

  it('lists only https links on each network\'s own hosts, opened safely', () => {
    const html = render(menu({
      instagram: 'https://instagram.com/olive', website: 'javascript:alert(1)', facebook: 'https://evil.example/x',
      whatsapp: 'https://wa.me/201001234567', myspace: 'https://myspace.com/olive',
    }));
    expect(html).toContain('href="https://instagram.com/olive"');
    expect(html).toContain('href="https://wa.me/201001234567"');
    expect(html).not.toContain('javascript:');
    expect(html).not.toContain('evil.example');
    expect(html).not.toContain('myspace');
    expect(html.match(/rel="noopener noreferrer nofollow"/g)).toHaveLength(2);
    expect(render(menu())).not.toContain('gx-social');
  });

  it('renders in Arabic from the guest messages', () => {
    const html = render(menu({ instagram: 'https://instagram.com/olive' }), 'ar');
    expect(html).toContain('قائمتنا');
    expect(html).toContain('إنستغرام');
    expect(html).toContain('غرفة الزيتون');
  });

  it('a restaurant with several branches gets a branch picker', () => {
    expect(render(menu({}, [branch('main', 'Zamalek'), branch('maadi', 'Maadi')]))).toContain('<select');
    expect(render(menu())).not.toContain('<select');
  });

  it('the route never reaches an ordering, table or visit API', () => {
    const dir = __dirname;
    const src = readdirSync(dir).filter((f) => /\.tsx?$/.test(f) && !f.endsWith('.test.ts')).map((f) => readFileSync(join(dir, f), 'utf8')).join('\n');
    expect(src).not.toMatch(/\/public\/(order|tables|venue|sessions|visits)\b/);
    expect(src).not.toMatch(/components\/guest\/(cart|dock|assistant|bill|live)['/]/);
    expect(src).not.toMatch(/\buseCart\(/);
  });
});
