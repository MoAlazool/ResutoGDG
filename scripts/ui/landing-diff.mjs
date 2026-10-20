#!/usr/bin/env node
// Visual regression check for public pages whose look must not change (landing, pricing).
//
//   capture:  node scripts/ui/landing-diff.mjs capture --web http://127.0.0.1:3530 --out <dir>/before
//   compare:  node scripts/ui/landing-diff.mjs compare --a <dir>/before --b <dir>/after --out <dir>/diff
//
// Captures full pages with reduced motion (demos pause, reveals settle) in English and Arabic at 1440 and 390 px,
// then reports the share of differing pixels per page and writes highlighted diff images.
import { createRequire } from 'node:module';
import { mkdirSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const req = createRequire(path.join(ROOT, 'package.json'));
const sharp = createRequire(req.resolve('next/package.json', { paths: [path.join(ROOT, 'apps/web')] }))('sharp');
const [mode, ...rest] = process.argv.slice(2);
const args = Object.fromEntries(rest.reduce((acc, a, i, all) => { if (a.startsWith('--')) acc.push([a.slice(2), all[i + 1]]); return acc; }, []));
const PAGES = (args.pages ?? '/,/pricing').split(',');
const VIEWPORTS = { desktop: { width: 1440, height: 900 }, mobile: { width: 390, height: 844 } };

if (mode === 'capture') {
  const { chromium } = req('@playwright/test');
  const out = path.resolve(args.out);
  mkdirSync(out, { recursive: true });
  const browser = await chromium.launch();
  for (const p of PAGES) for (const [dev, viewport] of Object.entries(VIEWPORTS)) for (const lang of ['en', 'ar']) {
    const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1, reducedMotion: 'reduce', locale: lang === 'ar' ? 'ar-EG' : 'en-US' });
    await ctx.addCookies([{ name: 'resuto_locale', value: lang, url: args.web }]);
    // Freeze the clock so time-based demo copy (greetings, clocks) renders the same in both runs.
    await ctx.addInitScript(() => { const fixed = new Date('2026-10-20T10:00:00Z').getTime(); Date.now = () => fixed; });
    const page = await ctx.newPage();
    await page.goto(args.web + p, { waitUntil: 'networkidle', timeout: 45000 });
    // Reveal everything that animates in on scroll, then return to the top.
    await page.evaluate(async () => {
      for (let y = 0; y < document.body.scrollHeight; y += 600) { window.scrollTo(0, y); await new Promise((r) => setTimeout(r, 40)); }
      document.querySelectorAll('[data-reveal]').forEach((el) => el.classList.add('is-in'));
      window.scrollTo(0, 0);
    });
    await page.waitForTimeout(800);
    const name = `${p === '/' ? 'landing' : p.replace(/\W+/g, '')}-${lang}-${dev}.png`;
    await page.screenshot({ path: path.join(out, name), fullPage: true, animations: 'disabled' });
    console.log('captured', name);
    await ctx.close();
  }
  await browser.close();
} else if (mode === 'compare') {
  const a = path.resolve(args.a), b = path.resolve(args.b), out = path.resolve(args.out);
  mkdirSync(out, { recursive: true });
  const report = [];
  for (const f of readdirSync(a).filter((x) => x.endsWith('.png'))) {
    if (!existsSync(path.join(b, f))) { report.push({ file: f, error: 'missing in b' }); continue; }
    const A = sharp(path.join(a, f)), B = sharp(path.join(b, f));
    const [ma, mb] = await Promise.all([A.metadata(), B.metadata()]);
    const w = Math.min(ma.width, mb.width), h = Math.min(ma.height, mb.height);
    const [ra, rb] = await Promise.all([
      sharp(path.join(a, f)).extract({ left: 0, top: 0, width: w, height: h }).removeAlpha().raw().toBuffer(),
      sharp(path.join(b, f)).extract({ left: 0, top: 0, width: w, height: h }).removeAlpha().raw().toBuffer(),
    ]);
    const diff = Buffer.alloc(w * h * 3);
    let changed = 0;
    for (let i = 0; i < w * h; i++) {
      const d = Math.abs(ra[i * 3] - rb[i * 3]) + Math.abs(ra[i * 3 + 1] - rb[i * 3 + 1]) + Math.abs(ra[i * 3 + 2] - rb[i * 3 + 2]);
      if (d > 24) { changed++; diff[i * 3] = 255; diff[i * 3 + 1] = 0; diff[i * 3 + 2] = 80; }
      else { const g = Math.round((ra[i * 3] + ra[i * 3 + 1] + ra[i * 3 + 2]) / 3 * 0.35 + 160); diff[i * 3] = diff[i * 3 + 1] = diff[i * 3 + 2] = g; }
    }
    await sharp(diff, { raw: { width: w, height: h, channels: 3 } }).png().toFile(path.join(out, f));
    report.push({ file: f, sizeA: `${ma.width}x${ma.height}`, sizeB: `${mb.width}x${mb.height}`, changedPixels: changed, changedPct: +(changed / (w * h) * 100).toFixed(4) });
  }
  writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 1));
  console.table(report);
} else {
  console.log('usage: landing-diff.mjs capture|compare ...');
  process.exit(2);
}
