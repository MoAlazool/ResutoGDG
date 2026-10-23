import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PublicMenu, ReservationSlotsView } from '@resuto/contracts';
import { LocaleProvider } from '@/lib/i18n/client';
import { messagesFor } from '@/lib/i18n/messages';
import { BookingExperience } from './BookingExperience';

// POL-03: with two bookable branches the Branch select stood above the date strip and pushed the time grid down, so
// "Tables are held for 90 minutes" fell below the fold at 1440 x 900 (legacy shows the whole grid and the note). The
// branch now sits beside the party size. Rendered from the real component; the layout is checked in Chromium below.

type Lang = 'en' | 'ar';
const branch = (code: string, name: string, nameAr: string, acceptsReservations = true) => ({ id: `b-${code}`, code, name, nameAr, acceptsReservations });
const info = (branches: ReturnType<typeof branch>[]) => ({
  org: { slug: 'the-olive-room', name: 'The Olive Room', nameAr: 'غرفة الزيتون', currency: 'EGP' }, branches,
}) as unknown as PublicMenu;
const TWO = [branch('main', 'Zamalek, Cairo', 'الزمالك، القاهرة'), branch('burger', 'Smash & Co', 'سماش آند كو')];
const times = ['17:00', '17:30', '18:00', '18:30', '19:00', '19:30', '20:00', '20:30', '21:00', '21:30', '22:00', '22:30', '23:00'];
const slots: ReservationSlotsView = {
  branch: { id: 'b-main', code: 'main', name: 'Zamalek, Cairo', nameAr: null }, timeZone: 'Africa/Cairo', today: '2026-10-23', date: '2026-10-23',
  service: 'dinner', firstOpenDate: '2026-10-23', slots: times.map((time) => ({ time, free: 6, open: true })), passed: 0, durationMin: 90, depositMinor: 0, currency: 'EGP',
};
const render = (lang: Lang, branches = TWO) => renderToStaticMarkup(h(LocaleProvider, {
  locale: lang, messages: { ...messagesFor(lang, 'staff'), ...messagesFor(lang, 'guest') },
  children: h(BookingExperience, { slug: 'the-olive-room', info: info(branches), branchCode: 'main', initialSlots: slots, initialFloor: null, wordmark: h('span', { className: 'wordmark' }, 'resuto.') }),
}));

describe('booking step 1 markup (POL-03)', () => {
  it('puts the branch select beside the party size, after the date strip, with its label tied to it', () => {
    const html = render('en');
    const days = html.indexOf('class="bk-days"'), row = html.indexOf('class="bk-row"'), select = html.indexOf('class="bk-select"'), slotsAt = html.indexOf('class="bk-slots"');
    expect(days).toBeGreaterThan(0);
    expect(row).toBeGreaterThan(days);
    expect(select).toBeGreaterThan(row);
    expect(select).toBeLessThan(slotsAt);
    expect(html).toMatch(/<label class="bk-field bk-branch"><span class="bk-label">Branch<\/span><select class="bk-select"/);
    expect(html).toContain('Smash &amp; Co');
  });

  it('a restaurant with a single bookable branch shows no branch select', () => {
    expect(render('en', [TWO[0]!, { ...TWO[1]!, acceptsReservations: false }])).not.toContain('bk-select');
  });
});

const browsers = process.env.PLAYWRIGHT_BROWSERS_PATH ?? '/opt/pw-browsers';
describe.skipIf(!existsSync(browsers))('booking step 1 at 1440 x 900 (Chromium, POL-03)', () => {
  let dir = '';
  let close: () => Promise<void> = async () => {};
  let open: (body: string, lang: Lang, width: number, height: number) => Promise<{ vh: number; note: number; lastSlot: number; barTop: number; overflowX: number; select: { top: number; bottom: number } | null; party: { top: number; bottom: number } }>;

  beforeAll(async () => {
    process.env.PLAYWRIGHT_BROWSERS_PATH = browsers;
    const { chromium } = await import('@playwright/test');
    const browser = await chromium.launch();
    close = () => browser.close();
    dir = mkdtempSync(join(tmpdir(), 'booking-'));
    const web = join(__dirname, '..', '..', '..');
    const fonts = `url('file://${join(web, 'public', 'fonts')}/`;
    const strip = (css: string) => css.replace(/@import [^;]+;/g, '').replace(/url\('\/fonts\//g, fonts);
    const css = [join(web, '..', '..', 'packages', 'ui', 'src', 'tokens.css'), join(web, 'app', 'globals.css'), join(web, 'components', 'floor', 'floor.css'), join(web, 'components', 'guest', 'consumer.css')];
    writeFileSync(join(dir, 'app.css'), css.map((f) => strip(readFileSync(f, 'utf8'))).join('\n'));
    open = async (body, lang, width, height) => {
      const page = await browser.newPage({ viewport: { width, height } });
      writeFileSync(join(dir, 'p.html'), `<!doctype html><html lang="${lang}" dir="${lang === 'ar' ? 'rtl' : 'ltr'}"><head><meta name="viewport" content="width=device-width"><link rel="stylesheet" href="app.css"></head><body>${body}</body></html>`);
      await page.goto(`file://${join(dir, 'p.html')}`);
      await page.evaluate(() => document.fonts.ready);
      const out = await page.evaluate(() => {
        const r = (s: string) => document.querySelector(s)?.getBoundingClientRect() ?? null;
        const notes = document.querySelectorAll('.bk-note');
        const slots = document.querySelectorAll('.bk-slot');
        const sel = r('.bk-branch'), party = r('.bk-party')!;
        return {
          vh: window.innerHeight, note: notes[notes.length - 1]!.getBoundingClientRect().bottom, lastSlot: slots[slots.length - 1]!.getBoundingClientRect().bottom,
          barTop: r('.bk-bar')?.top ?? window.innerHeight, overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          select: sel && { top: sel.top, bottom: sel.bottom }, party: { top: party.top, bottom: party.bottom },
        };
      });
      await page.close();
      return out;
    };
  }, 30_000);
  afterAll(async () => { await close(); if (dir) rmSync(dir, { recursive: true, force: true }); });

  for (const lang of ['en', 'ar'] as const) {
    it(`${lang}: the whole time grid and the hold note are in the first viewport, the branch select on the party row`, async () => {
      const r = await open(render(lang), lang, 1440, 900);
      const fold = Math.min(r.vh, r.barTop);
      expect(r.lastSlot).toBeLessThanOrEqual(fold);
      expect(r.note).toBeLessThanOrEqual(fold);
      // Same row as the party controls (overlapping vertical ranges), not a block of its own above the dates.
      expect(r.select).not.toBeNull();
      expect(r.select!.bottom).toBeGreaterThan(r.party.top);
      expect(r.select!.top).toBeLessThan(r.party.bottom);
      expect(r.overflowX).toBe(0);
    });
  }

  it('390 x 844: the branch select wraps under the party size, full width, without horizontal overflow', async () => {
    for (const lang of ['en', 'ar'] as const) {
      const r = await open(render(lang), lang, 390, 844);
      expect(r.select!.top).toBeGreaterThanOrEqual(r.party.bottom);
      expect(r.overflowX).toBe(0);
    }
  });
});
