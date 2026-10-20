#!/usr/bin/env node
// Behavioural probes for the staff shell and client data layer (read-only against a running web + API).
//
//   node scripts/ui/probe-shell.mjs --web http://127.0.0.1:3530 --api http://127.0.0.1:4530/v1 \
//     --accounts <demo-accounts.json> --out <dir>/probe-<label>.json
//
// Probes:
//  shellRefetch     – /o/:org and /billing/entitlements requests while navigating between 4 dashboard pages
//  transient503     – one 503 for /o/:org during navigation: is the dashboard still usable afterwards?
//  html503          – a poll answered with an HTML 503 page: is a raw "SyntaxError" shown?
//  rejectedToken    – an expired/rejected token on /dashboard/:org/orders, /kitchen/:org and /dashboard
//  preflights       – OPTIONS requests per authorised GET on an idle orders page for 20 s
//  signOutClears    – per-user localStorage keys after sign-out
//  notFound         – /no-such-page status, language and branding in Arabic
//  chromeFirst      – time until the sidebar is visible vs. until page data rendered (API delayed 600 ms)
//  filterPending    – orders filter change with the API delayed 1.5 s: are the previous rows marked busy?
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const { chromium } = createRequire(path.join(ROOT, 'package.json'))('@playwright/test');
const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => { if (a.startsWith('--')) acc.push([a.slice(2), all[i + 1]]); return acc; }, []));
const WEB = args.web, API = args.api, ACCT = JSON.parse(readFileSync(args.accounts, 'utf8'));
const only = args.only ? new Set(args.only.split(',')) : null;
const D = `/dashboard/${ACCT.orgId}`;
const res = {};

const r = await fetch(`${API}/auth/dev/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(ACCT.owner) });
const TOKEN = (await r.json()).accessToken;
const browser = await chromium.launch();
async function ctxWith(token, lang = 'en', extra = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, ...extra });
  await ctx.addCookies([{ name: 'resuto_locale', value: lang, url: WEB }]);
  if (token) await ctx.addInitScript(([t]) => { try { if (!sessionStorage.getItem('probe-set')) { localStorage.setItem('resuto_session', JSON.stringify({ accessToken: t, expiresAt: Date.now() + 3600e3, email: 'probe' })); sessionStorage.setItem('probe-set', '1'); } } catch {} }, [token]);
  return ctx;
}
const navClick = async (page, href) => {
  await page.evaluate((h) => { const a = [...document.querySelectorAll('a')].find((x) => x.getAttribute('href') === h); a?.click(); }, href);
  await page.waitForURL((u) => u.pathname === href, { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(1500);
};
const want = (k) => !only || only.has(k);

if (want('shellRefetch')) {
  const ctx = await ctxWith(TOKEN);
  const page = await ctx.newPage();
  await page.goto(WEB + D, { waitUntil: 'networkidle' });
  const calls = [];
  page.on('request', (q) => { if (q.method() === 'GET' && /\/v1\/o\/[^/]+(\/billing\/entitlements)?(\?|$)/.test(q.url())) calls.push(q.url().replace(API, '')); });
  for (const p of ['/orders', '/menu', '/customers', '']) await navClick(page, D + p);
  res.shellRefetch = { navigations: 4, orgOrEntitlementRequests: calls.length, calls };
  await ctx.close();
}

if (want('transient503')) {
  const ctx = await ctxWith(TOKEN);
  const page = await ctx.newPage();
  await page.goto(WEB + D, { waitUntil: 'networkidle' });
  let failNext = true;
  await page.route(/\/v1\/o\/[^/]+(\?.*)?$/, async (route) => {
    if (failNext && route.request().method() === 'GET') { failNext = false; return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'unavailable', message: 'Service temporarily unavailable' } }) }); }
    return route.continue();
  });
  // Navigate inside the app (no reload): a shell that refetches the org on navigation now gets the 503.
  await navClick(page, D + '/orders');
  await page.waitForTimeout(1500);
  const duringLinks = await page.locator('aside a').count();
  // The API is healthy again from here on; wait and look again without reloading.
  await navClick(page, D + '/menu');
  await page.waitForTimeout(6000);
  const sidebarLinks = await page.locator('aside a').count();
  const body = (await page.locator('body').innerText()).slice(0, 300);
  res.transient503 = { sidebarLinksDuring: duringLinks, sidebarLinksAfter: sidebarLinks, bodyStart: body, usableAfterRecovery: sidebarLinks > 5 && !/temporarily unavailable/i.test(body) };
  await ctx.close();
}

if (want('html503')) {
  const ctx = await ctxWith(TOKEN);
  const page = await ctx.newPage();
  await page.route(/\/v1\/o\/[^/]+\/orders(\?|$)/, (route) => route.request().method() === 'GET'
    ? route.fulfill({ status: 503, contentType: 'text/html', body: '<html><body><h1>503 Service Unavailable</h1></body></html>' }) : route.continue());
  await page.goto(WEB + D + '/orders', { waitUntil: 'networkidle' });
  await page.waitForTimeout(2000);
  const text = await page.locator('main').innerText().catch(() => '');
  res.html503 = { showsSyntaxError: /SyntaxError|Unexpected token/.test(text), sample: text.slice(0, 300) };
  await ctx.close();
}

if (want('rejectedToken')) {
  const out = {};
  for (const p of [D + '/orders', `/kitchen/${ACCT.orgId}`, '/dashboard']) {
    const ctx = await ctxWith('eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.invalid-signature');
    const page = await ctx.newPage();
    await page.goto(WEB + p, { waitUntil: 'networkidle' }).catch(() => {});
    await page.waitForTimeout(4000);
    out[p] = { finalUrl: page.url().replace(WEB, ''), redirectedToLogin: new URL(page.url()).pathname === '/login', text: (await page.locator('body').innerText()).slice(0, 160) };
    await ctx.close();
  }
  res.rejectedToken = out;
}

if (want('preflights')) {
  const ctx = await ctxWith(TOKEN);
  const page = await ctx.newPage();
  // CORS preflights are not page requests in Playwright; count them through the DevTools protocol.
  const counts = { OPTIONS: 0, GET: 0 };
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Network.enable');
  cdp.on('Network.requestWillBeSent', (e) => { if (e.request.url.startsWith(API)) counts[e.request.method] = (counts[e.request.method] ?? 0) + 1; });
  cdp.on('Network.requestWillBeSentExtraInfo', () => {});
  let preflight = 0;
  cdp.on('Network.responseReceived', (e) => { if (e.type === 'Preflight') preflight++; });
  await page.goto(WEB + D + '/orders', { waitUntil: 'networkidle' });
  await page.waitForTimeout(20000);
  res.preflights = { windowSeconds: 20, ...counts, preflightResponses: preflight };
  await ctx.close();
}

if (want('signOutClears')) {
  const ctx = await ctxWith(TOKEN);
  const page = await ctx.newPage();
  await page.goto(WEB + D, { waitUntil: 'networkidle' });
  await page.evaluate(() => { localStorage.setItem('resuto:u:probe:draft', 'x'); localStorage.setItem('resuto_floor_view', 'x'); });
  const before = await page.evaluate(() => Object.keys(localStorage));
  const btn = page.getByRole('button', { name: /sign out|تسجيل الخروج/i }).first();
  await btn.click({ timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(2000);
  const after = await page.evaluate(() => Object.keys(localStorage));
  res.signOutClears = { before, after, url: page.url().replace(WEB, '') };
  await ctx.close();
}

if (want('notFound')) {
  const ctx = await ctxWith(null, 'ar');
  const page = await ctx.newPage();
  const resp = await page.goto(WEB + '/no-such-page', { waitUntil: 'networkidle' });
  res.notFound = { status: resp?.status(), text: (await page.locator('body').innerText()).slice(0, 200), title: await page.title() };
  const unknown = {};
  for (const p of ['/order/no-such-restaurant', '/reserve/no-such-restaurant', '/t/not-a-real-qr-token-123456', '/pay/not-a-token', '/r/no-such-restaurant']) {
    const rr = await page.goto(WEB + p, { waitUntil: 'networkidle' }).catch(() => null);
    unknown[p] = rr?.status();
  }
  res.notFound.unknownGuestRoutes = unknown;
  await ctx.close();
}

if (want('chromeFirst')) {
  const ctx = await ctxWith(TOKEN);
  const page = await ctx.newPage();
  await page.goto(WEB + D, { waitUntil: 'networkidle' }); // warm the HTTP and org caches
  await page.route(/\/v1\//, async (route) => { await new Promise((r2) => setTimeout(r2, 600)); return route.continue(); });
  const t0 = Date.now();
  await page.goto(WEB + D + '/orders', { waitUntil: 'commit' });
  const sidebar = await page.locator('aside nav a').first().waitFor({ timeout: 15000 }).then(() => Date.now() - t0, () => null);
  const table = await page.locator('main table, main [data-loaded]').first().waitFor({ timeout: 15000 }).then(() => Date.now() - t0, () => null);
  res.chromeFirst = { sidebarVisibleMs: sidebar, pageDataMs: table };
  await ctx.close();
}

if (want('filterPending')) {
  const ctx = await ctxWith(TOKEN);
  const page = await ctx.newPage();
  await page.goto(WEB + D + '/orders', { waitUntil: 'networkidle' });
  await page.locator('main table').first().waitFor({ timeout: 15000 }).catch(() => {});
  const rowsBefore = await page.locator('main table tbody tr').count();
  await page.route(/\/v1\/o\/[^/]+\/orders\?/, async (route) => { await new Promise((r2) => setTimeout(r2, 1500)); return route.continue(); });
  const t0 = Date.now();
  await page.locator('main select').filter({ has: page.locator('option[value="active"]') }).first().selectOption('');
  await page.waitForTimeout(300);
  const busyDuring = await page.locator('main .table-wrap[aria-busy="true"]').count();
  const dimmed = await page.locator('main .table-wrap[data-busy] tbody').evaluate((el) => getComputedStyle(el).opacity).catch(() => null);
  await page.locator('main .table-wrap[aria-busy="true"]').first().waitFor({ state: 'detached', timeout: 10000 }).catch(() => {});
  const settledMs = Date.now() - t0;
  const busyAfter = await page.locator('main .table-wrap[aria-busy="true"]').count();
  const rowsAfter = await page.locator('main table tbody tr').count();
  res.filterPending = { rowsBefore, busyDuring, tbodyOpacityDuring: dimmed, settledMs, busyAfter, rowsAfter };
  await ctx.close();
}

await browser.close();
mkdirSync(path.dirname(path.resolve(args.out)), { recursive: true });
writeFileSync(args.out, JSON.stringify(res, null, 1));
console.log(JSON.stringify(res, null, 1));
