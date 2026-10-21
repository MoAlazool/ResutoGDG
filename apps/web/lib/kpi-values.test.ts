import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createElement as h, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { figureOf, Stat, StatsStrip } from '@resuto/ui';
import { money } from './format';

// PAR-06 review: only a figure (amount + currency, count, percentage) is kept on one line in a KPI tile. A date or a
// sentence wraps like text, so its content is never cut off by an ellipsis. Rendered from the real components, then
// laid out in Chromium with the real globals.css and fonts at the widths the reviewer measured.

const stat = (value: ReactNode) => renderToStaticMarkup(h(Stat, { label: 'L', value }));
const strip = (value: ReactNode, unit?: ReactNode, count = 2) =>
  renderToStaticMarkup(h(StatsStrip, { items: Array.from({ length: count }, () => ({ label: 'L', value, unit })) }));

describe('KPI values: figures stay whole, text wraps (PAR-06 review)', () => {
  it('marks money, counts and percentages as figures, with their length and full text', () => {
    for (const v of [money(1234567800, 'EGP', 'en'), money(742000, 'EGP', 'ar'), '1,250', '42%', 7]) {
      expect(figureOf(v), String(v)).not.toBeNull();
    }
    const html = stat(money(742000, 'EGP', 'en'));
    expect(html).toContain('class="is-fig"');
    expect(html).toMatch(/style="--chars:\d+(\.\d+)?"/);
    expect(html).toContain(`title="${money(742000, 'EGP', 'en')}"`);
    expect(strip('18', 'min')).toMatch(/class="stats-value num is-fig"/);
    expect(figureOf(h('bdi', null, money(14500, 'EGP', 'en')))).not.toBeNull();
  });

  it('leaves dates, sentences and component-rendered values free to wrap', () => {
    for (const v of ['1,250 expire on 21 Nov 2026', 'Oct 21, 2026, 10:30 PM', 'No payback yet', '—', '✓']) {
      expect(figureOf(v), v).toBeNull();
      expect(stat(v)).toContain('<strong>');
      expect(strip(v)).toContain('class="stats-value num"');
    }
    const Custom = () => h('span', null, '7');
    expect(figureOf(h(Custom))).toBeNull();
  });
});

// Layout in a real browser: skipped only when the Playwright Chromium the repo installs is not on this machine.
const browsers = process.env.PLAYWRIGHT_BROWSERS_PATH ?? '/opt/pw-browsers';
const haveChromium = existsSync(browsers);
describe.skipIf(!haveChromium)('KPI values in Chromium with globals.css', () => {
  type Box = { text: string; scrollWidth: number; clientWidth: number; textWidth: number; lines: number; fontSize: number };
  let dir = '';
  let close: () => Promise<void> = async () => {};
  let measure: (body: string, width: number, lang: 'en' | 'ar') => Promise<Box[]>;

  beforeAll(async () => {
    process.env.PLAYWRIGHT_BROWSERS_PATH = browsers;
    const { chromium } = await import('@playwright/test');
    const browser = await chromium.launch();
    close = () => browser.close();
    dir = mkdtempSync(join(tmpdir(), 'kpi-'));
    const web = join(__dirname, '..');
    const tokens = readFileSync(join(web, '..', '..', 'packages', 'ui', 'src', 'tokens.css'), 'utf8');
    const css = readFileSync(join(web, 'app', 'globals.css'), 'utf8')
      .replace(/@import [^;]+;/, '')
      .replace(/url\('\/fonts\//g, `url('file://${join(web, 'public', 'fonts')}/`);
    writeFileSync(join(dir, 'kpi.css'), `${tokens}\n${css}`);
    measure = async (body, width, lang) => {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      writeFileSync(join(dir, 'p.html'), `<!doctype html><html lang="${lang}" dir="${lang === 'ar' ? 'rtl' : 'ltr'}"><head><link rel="stylesheet" href="kpi.css"></head><body><div class="ws">${body}</div></body></html>`);
      await page.goto(`file://${join(dir, 'p.html')}`);
      await page.evaluate(() => document.fonts.ready);
      const out = await page.$$eval('.stat strong, .stats-value', (els) => els.map((e) => {
        const cs = getComputedStyle(e);
        const r = document.createRange();
        r.selectNodeContents(e);
        return { text: e.textContent ?? '', scrollWidth: e.scrollWidth, clientWidth: e.clientWidth, textWidth: r.getBoundingClientRect().width, lines: Math.round(e.getBoundingClientRect().height / parseFloat(cs.lineHeight)), fontSize: parseFloat(cs.fontSize) };
      }));
      await page.close();
      return out;
    };
  }, 30_000);
  afterAll(async () => { await close(); if (dir) rmSync(dir, { recursive: true, force: true }); });

  // A ws card stat 210 px wide inside (the 1440 px loyalty grid-3 tile the reviewer measured).
  const card = (value: ReactNode) => `<div style="width:258px">${stat(value)}</div>`;
  // A two-up stats strip on a 390 px phone (358 px wide): each cell's content box is about 147 px, the reviewer's 8-digit KPI.
  const cell = (value: ReactNode) => `<div style="width:358px">${strip(value)}</div>`;

  it('a long sentence or a date in a stat wraps and shows all of its text', async () => {
    for (const v of ['1,250 expire on 21 Nov 2026', 'Oct 21, 2026, 10:30 PM']) {
      const [b] = await measure(card(v), 1440, 'en');
      expect(b!.clientWidth).toBeGreaterThan(180);
      expect(b!.text).toBe(v);
      expect(b!.scrollWidth, v).toBeLessThanOrEqual(b!.clientWidth);
      expect(b!.lines, v).toBeGreaterThan(1);
    }
  });

  it('an 8-digit amount stays on one line and fits a 390 px tile, in English and Arabic', async () => {
    for (const lang of ['en', 'ar'] as const) {
      const v = money(1234567800, 'EGP', lang);
      const [b] = await measure(cell(v), 390, lang);
      expect(b!.lines, `${lang} ${v}`).toBe(1);
      expect(b!.scrollWidth, `${lang} ${v} ${JSON.stringify(b)}`).toBeLessThanOrEqual(b!.clientWidth);
      expect(b!.textWidth, `${lang} ${v} ${JSON.stringify(b)}`).toBeLessThanOrEqual(b!.clientWidth);
      expect(b!.clientWidth).toBeGreaterThan(140);
      expect(b!.fontSize, 'still legible').toBeGreaterThanOrEqual(14);
      const [c] = await measure(card(v), 390, lang);
      expect(c!.lines, `${lang} ${v}`).toBe(1);
      expect(c!.scrollWidth, `${lang} ${v} ${JSON.stringify(c)}`).toBeLessThanOrEqual(c!.clientWidth);
      expect(c!.textWidth, `${lang} ${v} ${JSON.stringify(c)}`).toBeLessThanOrEqual(c!.clientWidth);
    }
  });

  it('a short amount keeps its full size', async () => {
    // A four-up strip in the 1440 px workspace (about 1100 px of content).
    const [b] = await measure(`<div style="width:1100px">${strip(money(742000, 'EGP', 'en'), undefined, 4)}</div>`, 1440, 'en');
    expect(b!.fontSize).toBe(32);
    expect(b!.lines).toBe(1);
  });
});
