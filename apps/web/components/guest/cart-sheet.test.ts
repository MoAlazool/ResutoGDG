import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { createElement as h, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hasEasternDigits, type PublicMenuProduct, type SuggestionsResult } from '@resuto/contracts';
import { TableCartFooter } from '@/app/t/[qr]/_guest/TableExperience';
import { guestMoney } from '@/lib/format';
import { LocaleProvider } from '@/lib/i18n/client';
import { messagesFor } from '@/lib/i18n/messages';
import { CartSheet } from './cart';
import type { Cart } from './menu';
import { Sheet } from './shell';

// PAR-07: on a 390 x 844 phone the cart keeps its total and Confirm order in view, and an order error raised by Confirm
// shows right above it (review). Rendered from the real components; the layout is checked in Chromium below.

const product = (n: number): PublicMenuProduct => ({
  id: `p${n}`, name: `Dish number ${n} with a longer name`, nameAr: null, description: null, descriptionAr: null, priceMinor: 14500,
  imageUrl: null, allergens: [], dietary: [], spiceLevel: 0, available: true, prepMinutes: 10, modifierGroups: [],
});
const products = new Map(Array.from({ length: 8 }, (_, i) => [`p${i}`, product(i)] as const));
const noop = () => {};
const cart = {
  items: Array.from({ length: 8 }, (_, i) => ({ key: `k${i}`, productId: `p${i}`, quantity: 1, modifiers: [], notes: null })),
  count: 8, add: noop, setQty: noop, clear: noop,
} as unknown as Cart;
const suggestions: SuggestionsResult = {
  reason: 'drink', mode: 'rules',
  items: Array.from({ length: 4 }, (_, i) => ({ productId: `s${i}`, name: `Drink ${i}`, nameAr: null, priceMinor: 4500, imageUrl: null })),
} as unknown as SuggestionsResult;

const messages = { ...messagesFor('en', 'staff'), ...messagesFor('en', 'guest') };
const inEnglish = (node: ReactNode) => renderToStaticMarkup(h(LocaleProvider, { locale: 'en', messages, children: node }));
const tableCart = (error: string | null) => inEnglish(h(CartSheet, {
  cart, products, currency: 'EGP', onClose: noop, suggestions, onSuggest: noop, total: 116000,
  footer: h(TableCartFooter, { settling: false, error, pending: false, disabled: false, onConfirm: noop }),
}, h('label', { className: 'gx-field' }, h('span', null, 'Order notes'), h('input', { defaultValue: '' }))));

const between = (html: string, open: string) => {
  const i = html.indexOf(open);
  return i < 0 ? '' : html.slice(i);
};

describe('cart sheet keeps Confirm order in view (PAR-07)', () => {
  it('pins a footer with the order total and Confirm order under the scrolling lines', () => {
    const html = tableCart(null);
    expect(html).toContain('class="gx-sheet has-foot"');
    const scroll = html.slice(html.indexOf('class="gx-sheet-scroll"'), html.indexOf('class="gx-sheet-foot"'));
    const foot = between(html, 'class="gx-sheet-foot"');
    expect(scroll).toContain('Dish number 7');
    expect(scroll).toContain('gx-suggest is-compact');
    expect(scroll).not.toContain('gx-btn is-primary');
    expect(foot).toContain(guestMoney(116000, 'EGP', 'en'));
    expect(foot).toMatch(/class="gx-btn is-primary is-block"[^>]*>Confirm order</);
  });

  it('shows an order error in the footer, right above Confirm order', () => {
    const foot = between(tableCart('Prices changed. Check the new total.'), 'class="gx-sheet-foot"');
    const alert = foot.indexOf('role="alert"');
    expect(alert).toBeGreaterThan(0);
    expect(foot.indexOf('Prices changed')).toBeLessThan(foot.indexOf('gx-btn is-primary'));
  });

  it('a sheet without a footer keeps its single scrolling body', () => {
    const html = inEnglish(h(Sheet, { title: 'Bill', onClose: noop, children: h('p', null, 'body') }));
    expect(html).toContain('class="gx-sheet"');
    expect(html).not.toContain('gx-sheet-scroll');
    expect(html).not.toContain('gx-sheet-foot');
  });
});

const browsers = process.env.PLAYWRIGHT_BROWSERS_PATH ?? '/opt/pw-browsers';
describe.skipIf(!existsSync(browsers))('cart sheet layout on a 390 x 844 phone (Chromium)', () => {
  let dir = '';
  let close: () => Promise<void> = async () => {};
  let open: (body: string) => Promise<{ viewport: number; button: { top: number; bottom: number }; alert: { top: number; bottom: number } | null; suggestRow: number }>;

  beforeAll(async () => {
    process.env.PLAYWRIGHT_BROWSERS_PATH = browsers;
    const { chromium } = await import('@playwright/test');
    const browser = await chromium.launch();
    close = () => browser.close();
    dir = mkdtempSync(join(tmpdir(), 'cart-'));
    const web = join(__dirname, '..', '..');
    const fonts = `url('file://${join(web, 'public', 'fonts')}/`;
    const tokens = readFileSync(join(web, '..', '..', 'packages', 'ui', 'src', 'tokens.css'), 'utf8');
    const strip = (css: string) => css.replace(/@import [^;]+;/g, '').replace(/url\('\/fonts\//g, fonts);
    writeFileSync(join(dir, 'app.css'), [tokens, strip(readFileSync(join(web, 'app', 'globals.css'), 'utf8')), strip(readFileSync(join(__dirname, 'consumer.css'), 'utf8'))].join('\n'));
    open = async (body) => {
      const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
      writeFileSync(join(dir, 'p.html'), `<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width"><link rel="stylesheet" href="app.css"></head><body><div class="gx">${body}</div></body></html>`);
      await page.goto(`file://${join(dir, 'p.html')}`);
      await page.evaluate(() => document.fonts.ready);
      const out = await page.evaluate(() => {
        const box = (el: Element | null) => (el ? { top: el.getBoundingClientRect().top, bottom: el.getBoundingClientRect().bottom } : null);
        const list = document.querySelector('.gx-suggest-list');
        return { viewport: window.innerHeight, button: box(document.querySelector('.gx-sheet-foot .gx-btn.is-primary'))!, alert: box(document.querySelector('[role="alert"]')), suggestRow: list ? list.getBoundingClientRect().height : 0 };
      });
      await page.close();
      return out;
    };
  }, 30_000);
  afterAll(async () => { await close(); if (dir) rmSync(dir, { recursive: true, force: true }); });

  it('eight lines, suggestions and a note: Confirm order and the error stay on screen', async () => {
    const r = await open(tableCart('Prices changed. Check the new total.'));
    expect(r.button.bottom).toBeLessThanOrEqual(r.viewport);
    expect(r.button.top).toBeGreaterThan(0);
    expect(r.alert).not.toBeNull();
    expect(r.alert!.top).toBeGreaterThan(0);
    expect(r.alert!.bottom).toBeLessThanOrEqual(r.button.top);
    // Compact suggestions: one sideways row, not a stacked list.
    expect(r.suggestRow).toBeGreaterThan(0);
    expect(r.suggestRow).toBeLessThan(90);
  });

  it('control: the same error left at the end of the scrolling lines (before the review) is out of view', async () => {
    const html = inEnglish(h(CartSheet, {
      cart, products, currency: 'EGP', onClose: noop, suggestions, onSuggest: noop, total: 116000,
      footer: h(TableCartFooter, { settling: false, error: null, pending: false, disabled: false, onConfirm: noop }),
    }, h('p', { className: 'gx-note is-danger', role: 'alert' }, 'Prices changed. Check the new total.')));
    const r = await open(html);
    expect(r.alert!.top).toBeGreaterThanOrEqual(r.button.top);
  });
});

describe('cart sheet layout rules (PAR-07)', () => {
  it('the pinned footer and compact row have their layout rules, phone and safe area included', () => {
    const css = readFileSync(join(__dirname, 'consumer.css'), 'utf8');
    expect(css).toMatch(/\.gx-sheet-foot \{[^}]*env\(safe-area-inset-bottom\)/);
  });
});

describe('guest prices show their minor digits like legacy (PAR-07)', () => {
  it('formats "EGP 145.00", Western digits in Arabic', () => {
    expect(guestMoney(14500, 'EGP', 'en')).toBe(`EGP${String.fromCharCode(0xa0)}145.00`);
    const ar = guestMoney(14500, 'EGP', 'ar');
    expect(ar).toContain('145.00');
    expect(hasEasternDigits(ar)).toBe(false);
    expect(guestMoney(null)).toBe('—');
  });

  it('every guest surface formats money with guestMoney', () => {
    const repo = join(__dirname, '..', '..', '..', '..');
    // Guest pages: QR table, web ordering + tracking, booking, pay, split share (/s), messaging ordering link (/o).
    const roots = ['apps/web/app/t', 'apps/web/app/order', 'apps/web/app/reserve', 'apps/web/app/pay', 'apps/web/app/s', 'apps/web/app/o', 'apps/web/components/guest'];
    const walk = (d: string): string[] => readdirSync(d).flatMap((n) => {
      const p = join(d, n);
      return statSync(p).isDirectory() ? walk(p) : /\.tsx?$/.test(n) && !/\.test\./.test(n) ? [p] : [];
    });
    const offenders = roots.flatMap((r) => walk(join(repo, r))).filter((f) => {
      const m = /import \{([^}]*)\} from '@\/lib\/format'/.exec(readFileSync(f, 'utf8'));
      return !!m && /(^|[\s,])money([\s,]|$)/.test(m[1]!.replace(/guestMoney as money/, ''));
    }).map((f) => relative(repo, f));
    expect(offenders).toEqual([]);
  });
});
