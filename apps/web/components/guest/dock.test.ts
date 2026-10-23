import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hasEasternDigits } from '@resuto/contracts';
import { guestMoney } from '@/lib/format';
import { LocaleProvider } from '@/lib/i18n/client';
import { messagesFor } from '@/lib/i18n/messages';
import { GuestDock } from './dock';

// POL-02: on a 390 px phone the guest dock's item-count badge was pushed past the screen edge once View bill carried the
// amount due ("View bill · EGP 390.00"). Rendered from the real component; the layout is checked in Chromium below.

type Lang = 'en' | 'ar';
const noop = () => {};
const dock = (lang: Lang, o: { dueMinor?: number | null; totalMinor?: number; count?: number; bill?: boolean; status?: boolean } = {}) => {
  const messages = { ...messagesFor(lang, 'staff'), ...messagesFor(lang, 'guest') };
  const { dueMinor = 39000, totalMinor = 0, count = 0, bill = true, status = false } = o;
  // The reconnecting status exactly as the QR table page passes it.
  const live = status ? h('span', { className: 'gx-live', role: 'status' }, '● ', messages['core.guest.reconnecting']) : null;
  return renderToStaticMarkup(h(LocaleProvider, { locale: lang, messages, children: h(GuestDock, {
    count, total: guestMoney(totalMinor, 'EGP', lang), onCart: noop, status: live,
    bill: bill ? { due: dueMinor ? guestMoney(dueMinor, 'EGP', lang) : null, onOpen: noop } : null,
  }) }));
};
const LONG = { dueMinor: 1239000, totalMinor: 145000, count: 12 };

describe('guest dock markup (POL-02)', () => {
  it('keeps the amount due in its own isolate after the View bill words, Western digits in Arabic', () => {
    const html = dock('ar', { dueMinor: 1239000, totalMinor: 14500, count: 3 });
    expect(html).toMatch(/class="gx-btn gx-dock-bill has-due"[^>]*><span class="gx-dock-label">[^<]+<\/span><span class="gx-dock-sep" aria-hidden="true">·<\/span><bdi>[^<]*12,390\.00/);
    expect(hasEasternDigits(html)).toBe(false);
    // The count is on View cart (phone badge) and at the end of the row (legacy desktop look); both hidden from AT,
    // the cart button's label carries it.
    expect(html).toMatch(/class="gx-btn is-primary gx-dock-cart"[^>]*aria-label="[^"]*3[^"]*"/);
    expect(html).toContain('class="gx-count is-badge" aria-hidden="true">3<');
    expect(html).toContain('class="gx-count is-trailing" aria-hidden="true">3<');
  });

  it('an empty cart has no badge on View cart; no View bill without a visit', () => {
    const html = dock('en', { bill: false });
    expect(html).not.toContain('is-badge');
    expect(html).not.toContain('gx-dock-bill');
    expect(html).toContain('class="gx-count is-trailing"');
    // Nothing due: plain View bill, no stacked layout.
    expect(dock('en', { dueMinor: null })).toContain('class="gx-btn gx-dock-bill"');
  });
});

const browsers = process.env.PLAYWRIGHT_BROWSERS_PATH ?? '/opt/pw-browsers';
describe.skipIf(!existsSync(browsers))('guest dock layout (Chromium, POL-02)', () => {
  let dir = '';
  let close: () => Promise<void> = async () => {};
  type Box = { left: number; right: number; top: number; bottom: number };
  let open: (body: string, lang: Lang, width: number) => Promise<{ vw: number; vh: number; dock: Box; parts: Array<Box & { cls: string; clipped: boolean }>; live: (Box & { shown: number }) | null }>;

  beforeAll(async () => {
    process.env.PLAYWRIGHT_BROWSERS_PATH = browsers;
    const { chromium } = await import('@playwright/test');
    const browser = await chromium.launch();
    close = () => browser.close();
    dir = mkdtempSync(join(tmpdir(), 'dock-'));
    const web = join(__dirname, '..', '..');
    const fonts = `url('file://${join(web, 'public', 'fonts')}/`;
    const tokens = readFileSync(join(web, '..', '..', 'packages', 'ui', 'src', 'tokens.css'), 'utf8');
    const strip = (css: string) => css.replace(/@import [^;]+;/g, '').replace(/url\('\/fonts\//g, fonts);
    writeFileSync(join(dir, 'app.css'), [tokens, strip(readFileSync(join(web, 'app', 'globals.css'), 'utf8')), strip(readFileSync(join(__dirname, 'consumer.css'), 'utf8'))].join('\n'));
    open = async (body, lang, width) => {
      const page = await browser.newPage({ viewport: { width, height: 844 } });
      writeFileSync(join(dir, 'p.html'), `<!doctype html><html lang="${lang}" dir="${lang === 'ar' ? 'rtl' : 'ltr'}"><head><meta name="viewport" content="width=device-width"><link rel="stylesheet" href="app.css"></head><body><div class="gx">${body}</div></body></html>`);
      await page.goto(`file://${join(dir, 'p.html')}`);
      await page.evaluate(() => document.fonts.ready);
      const out = await page.evaluate(() => {
        const box = (el: Element) => { const r = el.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom }; };
        const d = document.querySelector('.gx-dock')!;
        // Every button, isolate, label and count; the amount (bdi) and the View bill words must never be clipped.
        const parts = [...d.querySelectorAll('button, strong, bdi, .gx-count, .gx-dock-label')].filter((n) => getComputedStyle(n).display !== 'none')
          .map((n) => ({ cls: `${n.tagName.toLowerCase()}.${n.className}`, ...box(n),
            clipped: (n.tagName === 'BDI' || n.classList.contains('gx-dock-label')) && (n as HTMLElement).scrollWidth > (n as HTMLElement).clientWidth + 1 }));
        const l = d.querySelector('.gx-live') as HTMLElement | null;
        return { vw: document.documentElement.clientWidth, vh: window.innerHeight, dock: box(d), parts, live: l ? { ...box(l), shown: l.clientWidth } : null };
      });
      await page.close();
      return out;
    };
  }, 30_000);
  afterAll(async () => { await close(); if (dir) rmSync(dir, { recursive: true, force: true }); });

  const inside = (r: Awaited<ReturnType<typeof open>>) => {
    for (const p of r.parts) {
      expect(p.left, p.cls).toBeGreaterThanOrEqual(0);
      expect(p.right, p.cls).toBeLessThanOrEqual(r.vw);
      expect(p.left, p.cls).toBeGreaterThanOrEqual(r.dock.left);
      expect(p.right, p.cls).toBeLessThanOrEqual(r.dock.right);
      expect(p.top, p.cls).toBeGreaterThanOrEqual(r.dock.top);
      expect(p.clipped, p.cls).toBe(false);
    }
    if (r.live) {
      // The reconnecting status may collapse to its dot, but stays inside the dock and never vanishes.
      expect(r.live.left).toBeGreaterThanOrEqual(r.dock.left);
      expect(r.live.right).toBeLessThanOrEqual(r.dock.right);
      expect(r.live.shown).toBeGreaterThan(5);
    }
    expect(r.dock.left).toBeGreaterThanOrEqual(0);
    expect(r.dock.right).toBeLessThanOrEqual(r.vw);
    expect(r.dock.bottom).toBeLessThanOrEqual(r.vh);
  };

  for (const lang of ['en', 'ar'] as const) {
    it(`390 px, ${lang}: View bill with the amount due, View cart, the total and the count all stay inside the dock`, async () => {
      // The gallery case (EGP 390.00 due, empty cart) and a long one (EGP 12,390.00 due, 12 items, EGP 1,450.00).
      // Plus the reviewer's case (EGP 1,170.00 due, EGP 390.00 in the cart), which shortened "View bill" to "View …".
      for (const o of [{ dueMinor: 39000, totalMinor: 0, count: 0 }, { dueMinor: 78000, totalMinor: 29000, count: 2 }, { dueMinor: 117000, totalMinor: 39000, count: 2 }, LONG, { ...LONG, status: true }]) {
        const r = await open(dock(lang, o), lang, 390);
        inside(r);
        if (o.count) expect(r.parts.some((p) => p.cls.includes('is-badge'))).toBe(true);
        expect(r.parts.some((p) => p.cls.includes('is-trailing'))).toBe(false);
      }
    });
  }

  it('360 px (the narrowest common phone) still keeps the amount due, the View bill words and the count on screen', async () => {
    for (const lang of ['en', 'ar'] as const) for (const o of [LONG, { ...LONG, status: true }]) inside(await open(dock(lang, o), lang, 360));
  });

  it('View bill stacks its words over the amount at phone width, so both read in full', async () => {
    for (const lang of ['en', 'ar'] as const) {
      const r = await open(dock(lang, { dueMinor: 117000, totalMinor: 39000, count: 2 }), lang, 390);
      const label = r.parts.find((p) => p.cls.includes('gx-dock-label'))!;
      const amount = r.parts.find((p) => p.cls.startsWith('bdi') && p.top < label.bottom + 30 && p.left < r.vw / 2 === (lang === 'en'))!;
      expect(amount.top).toBeGreaterThanOrEqual(label.bottom - 1);
    }
  });

  // Between the phone layout (600 px) and the desktop row the dock is centred; the reviewer found the trailing count
  // pushed off screen at 601-630 px with the reconnecting status and a long amount due.
  for (const width of [601, 620, 640, 768, 769, 1024]) {
    it(`${width} px with the reconnecting status and a long amount due: everything stays inside the dock, EN and AR`, async () => {
      for (const lang of ['en', 'ar'] as const) inside(await open(dock(lang, { ...LONG, status: true }), lang, width));
    });
  }

  it('desktop keeps the legacy row: the count trails the total, no badge on View cart', async () => {
    const r = await open(dock('en', { count: 2, totalMinor: 29000 }), 'en', 1440);
    inside(r);
    const trailing = r.parts.find((p) => p.cls.includes('is-trailing'))!;
    const total = r.parts.find((p) => p.cls.startsWith('strong'))!;
    expect(trailing.left).toBeGreaterThan(total.right);
    expect(r.parts.some((p) => p.cls.includes('is-badge'))).toBe(false);
  });

  it('control: the dock markup before POL-02 pushes the count past the 390 px screen edge', async () => {
    const before = (lang: Lang) => `<div class="gx-dock"><button type="button" class="gx-btn">${lang === 'ar' ? 'الحساب' : 'View bill'} · <bdi>${guestMoney(117000, 'EGP', lang)}</bdi></button>`
      + `<button type="button" class="gx-btn is-primary">${lang === 'ar' ? 'عرض السلة' : 'View cart'}</button><strong><bdi>${guestMoney(39000, 'EGP', lang)}</bdi></strong><span class="gx-count" aria-hidden="true">2</span></div>`;
    for (const lang of ['en', 'ar'] as const) {
      const r = await open(before(lang), lang, 390);
      const count = r.parts.find((p) => p.cls.includes('gx-count'))!;
      expect(lang === 'en' ? count.right > r.dock.right : count.left < r.dock.left).toBe(true);
    }
  });
});
