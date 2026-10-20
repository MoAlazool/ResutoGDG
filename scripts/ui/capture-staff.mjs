#!/usr/bin/env node
// Captures the staff surfaces of the legacy app and of a Resuto 2.0 build at 1440x900 and 390x844, in English and
// Arabic, and builds LEGACY | NEW side-by-side composites. Read-only: it opens pages and never submits forms.
//
//   node scripts/ui/capture-staff.mjs --out <dir> --label after \
//     --web http://127.0.0.1:3530 --api http://127.0.0.1:4530/v1 --legacy http://127.0.0.1:3931 \
//     --accounts <demo-accounts.json> [--screens login,overview,reservations,settings,landing] [--no-legacy]
//
// Accounts JSON: { orgId, owner: { email, password } } (the demo loader's output). Legacy staff passwords come from
// LEGACY_MANAGER_PASSWORD (required for the signed-in legacy screens; no default is kept in the repo). Needs
// PLAYWRIGHT_BROWSERS_PATH for Chromium.
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const req = createRequire(path.join(ROOT, 'package.json'));
const { chromium } = req('@playwright/test');
const sharp = createRequire(req.resolve('next/package.json', { paths: [path.join(ROOT, 'apps/web')] }))('sharp');

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => {
  if (a.startsWith('--')) acc.push([a.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : true]);
  return acc;
}, []));
const OUT = path.resolve(String(args.out ?? 'ui-capture'));
const LABEL = String(args.label ?? 'new');
const WEB = String(args.web ?? 'http://127.0.0.1:3000');
const API = String(args.api ?? 'http://127.0.0.1:4000/v1');
const LEGACY = args['no-legacy'] ? null : String(args.legacy ?? 'http://127.0.0.1:3900');
const ACCT = JSON.parse(readFileSync(String(args.accounts), 'utf8'));
const LEGACY_PW = process.env.LEGACY_MANAGER_PASSWORD;
const SCREENS = String(args.screens ?? 'login,overview,reservations,settings').split(',');
if (LEGACY && !LEGACY_PW && SCREENS.some((s) => !['login', 'landing', 'notfound'].includes(s))) {
  console.error('capture-staff: set LEGACY_MANAGER_PASSWORD to the legacy manager password of the instance at --legacy (or pass --no-legacy).');
  process.exit(2);
}
mkdirSync(path.join(OUT, 'shots'), { recursive: true });
mkdirSync(path.join(OUT, 'compare'), { recursive: true });

const VIEWPORTS = {
  desktop: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 },
  mobile: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true },
};
const D = `/dashboard/${ACCT.orgId}`;
const tab = (id) => async (p) => { await p.evaluate((x) => document.querySelector(`[data-action="tab"][data-id="${x}"]`)?.click(), id); await p.waitForTimeout(900); };
// screen id -> [legacy path, legacy action, new path, signed in]
const MAP = {
  login: ['/manager', null, '/login', false],
  overview: ['/manager', null, D, true],
  reservations: ['/manager', tab('reservations'), `${D}/reservations`, true],
  customers: ['/manager', tab('customers'), `${D}/customers`, true],
  orders: ['/manager', tab('orders'), `${D}/orders`, true],
  settings: ['/manager', tab('settings'), `${D}/settings`, true],
  landing: ['/', null, '/', false],
  notfound: ['/no-such-page', null, '/no-such-page', false],
};

async function devToken() {
  const r = await fetch(`${API}/auth/dev/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(ACCT.owner) });
  if (!r.ok) throw new Error(`dev login failed: ${r.status}`);
  return (await r.json()).accessToken;
}

/** DOM checks recorded next to every capture (Arabic-Indic digits, horizontal overflow, emoji). */
const metrics = (page) => page.evaluate(() => {
  const text = document.body.innerText || '';
  const de = document.documentElement;
  return {
    dir: de.dir, lang: de.lang, title: document.title,
    arabicIndic: (text.match(/[٠-٩۰-۹]/g) || []).length,
    indicSamples: [...new Set([...text.matchAll(/[^\n]{0,16}[٠-٩۰-۹][^\n]{0,16}/g)].map((m) => m[0].trim()))].slice(0, 6),
    overflowX: de.scrollWidth - de.clientWidth,
    emoji: (text.match(/[\u{1F300}-\u{1FAFF}]/gu) || []).length,
  };
});

async function shot(page, file) {
  const png = await page.screenshot({ animations: 'disabled' });
  const out = path.join(OUT, 'shots', `${file}.png`);
  await sharp(png).png({ compressionLevel: 9 }).toFile(out);
  return out;
}

const browser = await chromium.launch();
const results = [];
let legacyState = null;
const token = SCREENS.some((s) => MAP[s]?.[3]) ? await devToken() : null;

for (const id of SCREENS) {
  const [lPath, lAction, nPath, signedIn] = MAP[id] ?? [];
  if (!nPath) { console.log('unknown screen', id); continue; }
  for (const device of Object.keys(VIEWPORTS)) for (const lang of ['en', 'ar']) {
    // New build
    {
      const ctx = await browser.newContext({ ...VIEWPORTS[device], locale: lang === 'ar' ? 'ar-EG' : 'en-US' });
      await ctx.addCookies([{ name: 'resuto_locale', value: lang, url: WEB }]);
      if (signedIn) await ctx.addInitScript(([t]) => { try { localStorage.setItem('resuto_session', JSON.stringify({ accessToken: t, expiresAt: Date.now() + 3600e3, email: 'capture' })); } catch {} }, [token]);
      const page = await ctx.newPage();
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message.slice(0, 160)));
      try {
        await page.goto(WEB + nPath, { waitUntil: 'networkidle', timeout: 45000 });
        await page.waitForTimeout(1500);
        const file = await shot(page, `${LABEL}-${id}-${lang}-${device}`);
        results.push({ app: LABEL, id, lang, device, file, ...(await metrics(page)), errors });
        console.log('ok', LABEL, id, lang, device);
      } catch (e) { results.push({ app: LABEL, id, lang, device, error: String(e.message).slice(0, 200) }); console.log('FAIL', LABEL, id, lang, device, e.message.slice(0, 100)); }
      await ctx.close();
    }
    // Legacy
    if (LEGACY) {
      if (lPath === '/manager' && id !== 'login' && !legacyState) {
        const c = await browser.newContext();
        const r = await c.request.post(LEGACY + '/api/login', { data: { role: 'manager', password: LEGACY_PW } });
        if (!r.ok()) throw new Error('legacy login ' + r.status());
        legacyState = await c.storageState();
        await c.close();
      }
      const ctx = await browser.newContext({ ...VIEWPORTS[device], locale: lang === 'ar' ? 'ar-EG' : 'en-US', ...(id !== 'login' && lPath === '/manager' ? { storageState: legacyState } : {}) });
      await ctx.addInitScript((l) => { try { localStorage.setItem('resuto-language', l); } catch {} }, lang);
      const page = await ctx.newPage();
      try {
        await page.goto(LEGACY + lPath, { waitUntil: 'networkidle', timeout: 30000 });
        await page.waitForTimeout(1200);
        if (lAction) await lAction(page);
        const file = await shot(page, `legacy-${id}-${lang}-${device}`);
        results.push({ app: 'legacy', id, lang, device, file, ...(await metrics(page)) });
        console.log('ok legacy', id, lang, device);
      } catch (e) { results.push({ app: 'legacy', id, lang, device, error: String(e.message).slice(0, 200) }); console.log('FAIL legacy', id, lang, device); }
      await ctx.close();
    }
  }
}
await browser.close();
writeFileSync(path.join(OUT, `results-${LABEL}.json`), JSON.stringify(results, null, 1));

// --- composites ---------------------------------------------------------------------------------------
function label(text, width, h = 34) {
  const esc = text.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  return Buffer.from(`<svg width="${width}" height="${h}" xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" fill="#111"/><text x="12" y="23" font-family="sans-serif" font-size="18" fill="#fff">${esc}</text></svg>`);
}
async function tile(file, w, title) {
  const h = 34;
  const img = existsSync(file) ? await sharp(file).resize({ width: w }).png().toBuffer() : await sharp({ create: { width: w, height: 300, channels: 3, background: '#f2d0d0' } }).png().toBuffer();
  const meta = await sharp(img).metadata();
  return sharp({ create: { width: w, height: meta.height + h, channels: 3, background: '#fff' } })
    .composite([{ input: label(existsSync(file) ? title : `${title} (missing)`, w, h), top: 0, left: 0 }, { input: img, top: h, left: 0 }]).png().toBuffer();
}
async function row(tiles, gap = 12) {
  const metas = await Promise.all(tiles.map((t) => sharp(t).metadata()));
  const W = metas.reduce((n, m) => n + m.width, 0) + gap * (tiles.length - 1);
  const H = Math.max(...metas.map((m) => m.height));
  let x = 0;
  const comps = tiles.map((t, i) => { const c = { input: t, top: 0, left: x }; x += metas[i].width + gap; return c; });
  return sharp({ create: { width: W, height: H, channels: 3, background: '#888' } }).composite(comps);
}
if (LEGACY) {
  const S = (n) => path.join(OUT, 'shots', `${n}.png`);
  for (const id of SCREENS) {
    for (const lang of ['en', 'ar']) {
      const r = await row([await tile(S(`legacy-${id}-${lang}-desktop`), 960, `LEGACY ${id} ${lang} 1440`), await tile(S(`${LABEL}-${id}-${lang}-desktop`), 960, `${LABEL.toUpperCase()} ${id} ${lang} 1440`)]);
      await r.png().toFile(path.join(OUT, 'compare', `${id}-${lang}-desktop.png`));
    }
    const m = [];
    for (const lang of ['en', 'ar']) {
      m.push(await tile(S(`legacy-${id}-${lang}-mobile`), 390, `LEGACY ${lang}`));
      m.push(await tile(S(`${LABEL}-${id}-${lang}-mobile`), 390, `${LABEL.toUpperCase()} ${lang}`));
    }
    await (await row(m)).png().toFile(path.join(OUT, 'compare', `${id}-mobile.png`));
    console.log('composite', id);
  }
}
