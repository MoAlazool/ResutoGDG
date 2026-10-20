#!/usr/bin/env node
// DOM sweep of the staff screens (read-only): for every route, in Arabic and English, records Arabic-Indic digits
// (VS-06 / CR-04), colour emoji (VS-03), Latin-only text lines in Arabic (VS-21), horizontal overflow and page errors.
//
//   node scripts/ui/sweep-staff.mjs --web http://127.0.0.1:3530 --api http://127.0.0.1:4530/v1 \
//     --accounts <demo-accounts.json> --out <dir>/sweep.json [--device desktop|mobile] [--langs ar,en]
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const { chromium } = createRequire(path.join(ROOT, 'package.json'))('@playwright/test');
const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => { if (a.startsWith('--')) acc.push([a.slice(2), all[i + 1]]); return acc; }, []));
const WEB = args.web, API = args.api, ACCT = JSON.parse(readFileSync(args.accounts, 'utf8'));
const LANGS = (args.langs ?? 'ar,en').split(',');
const DEVICE = args.device ?? 'desktop';
const D = `/dashboard/${ACCT.orgId}`;
const ROUTES = [
  '', '/orders', '/kitchen', '/floor', '/reservations', '/menu', '/inventory', '/inventory?tab=items', '/inventory?tab=movements',
  '/customers', '/payments', '/analytics', '/integrations', '/settings', '/team', '/billing', '/audit', '/finance',
  '/finance/expenses', '/finance/exports', '/compliance', '/marketing', '/inbox', '/delivery', '/website', '/intelligence',
  '/intelligence/forecast', '/intelligence/customers', '/mcp',
].map((p) => D + p).concat([`/kitchen/${ACCT.orgId}`]);

const r = await fetch(`${API}/auth/dev/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(ACCT.owner) });
if (!r.ok) throw new Error(`dev login ${r.status}`);
const TOKEN = (await r.json()).accessToken;
const browser = await chromium.launch();
const out = [];
for (const lang of LANGS) {
  const ctx = await browser.newContext(DEVICE === 'mobile' ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } : { viewport: { width: 1440, height: 900 } });
  await ctx.addCookies([{ name: 'resuto_locale', value: lang, url: WEB }]);
  await ctx.addInitScript(([t]) => { try { localStorage.setItem('resuto_session', JSON.stringify({ accessToken: t, expiresAt: Date.now() + 3600e3, email: 'sweep' })); } catch {} }, [TOKEN]);
  const page = await ctx.newPage();
  for (const route of ROUTES) {
    const errors = [];
    const onErr = (e) => errors.push(String(e.message ?? e).slice(0, 160));
    page.on('pageerror', onErr);
    try {
      const resp = await page.goto(WEB + route, { waitUntil: 'networkidle', timeout: 45000 });
      await page.waitForTimeout(1200);
      const m = await page.evaluate(() => {
        const main = document.querySelector('main') ?? document.body;
        const text = main.innerText || '';
        const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
        return {
          title: document.title,
          arabicIndic: (document.body.innerText.match(/[٠-٩۰-۹]/g) || []).length,
          indicSamples: [...new Set([...document.body.innerText.matchAll(/[^\n]{0,18}[٠-٩۰-۹][^\n]{0,18}/g)].map((x) => x[0].trim()))].slice(0, 5),
          emoji: (document.body.innerText.match(/[\u{1F300}-\u{1FAFF}]/gu) || []).length,
          overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          // Lines with Latin words and no Arabic letter (only meaningful on Arabic pages).
          latinOnly: lines.filter((l) => /[A-Za-z]{3,}/.test(l) && !/[؀-ۿ]/.test(l)),
        };
      });
      out.push({ lang, device: DEVICE, route: route.replace(ACCT.orgId, ':org'), status: resp?.status(), ...m,
        latinOnly: lang === 'ar' ? m.latinOnly.slice(0, 12) : undefined, latinOnlyCount: lang === 'ar' ? m.latinOnly.length : undefined, errors });
      console.log(lang, route.replace(ACCT.orgId, ':org'), 'indic', m.arabicIndic, 'emoji', m.emoji, 'ovf', m.overflowX, lang === 'ar' ? `latin ${m.latinOnly.length}` : '');
    } catch (e) {
      out.push({ lang, route, error: String(e.message).slice(0, 200) });
      console.log('FAIL', lang, route, e.message.slice(0, 80));
    }
    page.off('pageerror', onErr);
  }
  await ctx.close();
}
await browser.close();
const summary = {
  routes: out.length,
  withArabicIndic: out.filter((x) => x.arabicIndic > 0).map((x) => `${x.lang} ${x.route}: ${x.arabicIndic}`),
  withEmoji: out.filter((x) => x.emoji > 0).map((x) => `${x.lang} ${x.route}: ${x.emoji}`),
  withOverflow: out.filter((x) => x.overflowX > 0).map((x) => `${x.lang} ${x.route}: ${x.overflowX}px`),
  withErrors: out.filter((x) => x.error || x.errors?.length).map((x) => `${x.lang} ${x.route}`),
  latinOnlyTotalAr: out.filter((x) => x.lang === 'ar').reduce((n, x) => n + (x.latinOnlyCount ?? 0), 0),
};
mkdirSync(path.dirname(path.resolve(args.out)), { recursive: true });
writeFileSync(args.out, JSON.stringify({ summary, routes: out }, null, 1));
console.log(JSON.stringify(summary, null, 1));
