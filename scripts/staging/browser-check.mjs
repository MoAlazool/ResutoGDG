#!/usr/bin/env node
// Browser check of the DEPLOYED staging web app (Vercel) talking to the staging API (Render)
// and Supabase. Each role signs in through the real login form (Supabase Auth); every page is
// opened in English and Arabic, guest/driver pages also at phone width. Records console errors
// and failed API calls per page and saves screenshots (WebP) for review.
//
// Env: WEB_URL, API_URL, SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, VERCEL_BYPASS (automation bypass
// secret for Vercel Authentication), DEMO_OWNER_PASSWORD, DEMO_STAFF_PASSWORD, DEMO_ADMIN_PASSWORD,
// OUT_DIR, optional WA_TOKEN (hosted WhatsApp ordering page token). Never prints secrets.
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const env = process.env;
const req = createRequire(path.resolve('package.json'));
const { chromium } = req('@playwright/test');
const sharp = createRequire(req.resolve('next/package.json', { paths: [path.resolve('apps/web')] }))('sharp');
const WEB = env.WEB_URL.replace(/\/$/, '');
const API = `${env.API_URL.replace(/\/$/, '')}/v1`;
const OUT = env.OUT_DIR ?? 'staging-shots';
const DOMAIN = env.DEMO_EMAIL_DOMAIN ?? 'olive-room.demo.test';
mkdirSync(path.join(OUT, 'shots'), { recursive: true });

// --- ids for page URLs, read through the API as the owner ---------------------------------------------
async function token(email, password) {
  const r = await fetch(`${env.SUPABASE_URL}/auth/v1/token?grant_type=password`, { method: 'POST', headers: { apikey: env.SUPABASE_PUBLISHABLE_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
  return (await r.json()).access_token;
}
const ownerTok = await token(`owner@${DOMAIN}`, env.DEMO_OWNER_PASSWORD);
const get = async (p) => (await fetch(API + p, { headers: { Authorization: `Bearer ${ownerTok}` } })).json();
const ORG = (await get('/me')).memberships[0].orgId;
const org = await get(`/o/${ORG}`);
const main = org.branches.find((b) => b.code === 'main');
const qr = (await get(`/o/${ORG}/floor/${main.id}/qr`)).items.find((x) => x.label === 'T3').url.split('/t/')[1];
const customers = await get(`/o/${ORG}/customers?limit=5`);
const customerId = customers.items?.[0]?.id;
const payments = await get(`/o/${ORG}/payments?limit=20`);
const paymentId = (payments.items ?? []).find((p) => p.method === 'card')?.id ?? payments.items?.[0]?.id;
const board = await get(`/o/${ORG}/delivery/board`);
const enRoute = [...(board.active ?? [])].find((j) => j.status === 'en_route')?.id;

const D = `/dashboard/${ORG}`;
const PAGES = [
  ['landing', 'Public', '/', null], ['login', 'Public', '/login', null], ['pricing', 'Public', '/pricing', null],
  ['site', 'Restaurant website', `/r/${org.slug}`, null, { mobile: true }], ['web-order', 'Restaurant website', `/order/${org.slug}`, null, { mobile: true }],
  ['reserve', 'Restaurant website', `/reserve/${org.slug}`, null, { mobile: true }],
  ['qr', 'QR dine-in', `/t/${qr}`, null, { mobileOnly: true }],
  ...(env.WA_TOKEN ? [['wa-hosted', 'WhatsApp', `/o/${env.WA_TOKEN}`, null, { mobileOnly: true }]] : []),
  ['overview', 'Owner dashboard', D, 'owner', { mobile: true }], ['orders', 'Owner dashboard', `${D}/orders`, 'owner'],
  ['kitchen', 'Kitchen (KDS)', `${D}/kitchen`, 'owner'], ['kds-full', 'Kitchen (KDS)', `/kitchen/${ORG}`, 'owner'],
  ['floor-live', 'Floor', `${D}/floor?tab=live`, 'owner'], ['floor-studio', 'Floor', `${D}/floor?tab=studio`, 'owner'],
  ['reservations', 'Owner dashboard', `${D}/reservations`, 'owner'], ['menu', 'Owner dashboard', `${D}/menu`, 'owner'],
  ['inventory', 'Owner dashboard', `${D}/inventory`, 'owner'], ['delivery', 'ResutoDriver', `${D}/delivery`, 'owner'],
  ['customers', 'Owner dashboard', `${D}/customers`, 'owner'], ...(customerId ? [['customer', 'Owner dashboard', `${D}/customers/${customerId}`, 'owner']] : []),
  ['inbox', 'WhatsApp', `${D}/inbox`, 'owner'], ['marketing', 'Marketing', `${D}/marketing`, 'owner'], ['website', 'ResutoStudio', `${D}/website`, 'owner'],
  ['analytics', 'Owner dashboard', `${D}/analytics`, 'owner'], ['finance', 'Finance', `${D}/finance`, 'owner'], ['pnl', 'Finance', `${D}/finance/pnl`, 'owner'],
  ['expenses', 'Finance', `${D}/finance/expenses`, 'owner'], ['payments', 'ResutoPay', `${D}/payments`, 'owner'],
  ...(paymentId ? [['payment', 'ResutoPay', `${D}/payments/${paymentId}`, 'owner']] : []),
  ['compliance', 'Compliance', `${D}/compliance`, 'owner'], ['intelligence', 'Intelligence', `${D}/intelligence`, 'owner'],
  ['forecast', 'Intelligence', `${D}/intelligence/forecast`, 'owner'], ['assistant', 'Intelligence', `${D}/intelligence/assistant`, 'owner'],
  ['mcp', 'ResutoMCP', `${D}/mcp`, 'owner'], ['mcp-approvals', 'ResutoMCP', `${D}/mcp/approvals`, 'owner'],
  ['integrations', 'Owner dashboard', `${D}/integrations`, 'owner'], ['team', 'Owner dashboard', `${D}/team`, 'owner'],
  ['billing', 'Billing', `${D}/billing`, 'owner'], ['audit', 'Owner dashboard', `${D}/audit`, 'owner'],
  ['driver-home', 'ResutoDriver', '/driver', 'driver2', { mobileOnly: true }],
  ...(enRoute ? [['driver-job', 'ResutoDriver', `/driver/jobs/${enRoute}`, 'driver2', { mobileOnly: true }]] : []),
  ['driver-cash', 'ResutoDriver', '/driver/cash', 'driver1', { mobileOnly: true }],
  ['admin', 'Platform admin', '/admin', 'admin'], ['admin-tenant', 'Platform admin', `/admin/tenants/${ORG}`, 'admin'], ['admin-ops', 'Platform admin', '/admin/operations', 'admin'],
];
const ACCOUNTS = {
  owner: [`owner@${DOMAIN}`, env.DEMO_OWNER_PASSWORD], admin: [`platform-admin@${DOMAIN}`, env.DEMO_ADMIN_PASSWORD],
  driver1: [`driver1@${DOMAIN}`, env.DEMO_STAFF_PASSWORD], driver2: [`driver2@${DOMAIN}`, env.DEMO_STAFF_PASSWORD],
};

const browser = await chromium.launch();
const results = [];
const storage = {};   // per role and device: signed-in browser storage state (real login, done once)
async function context(locale, mobile, who) {
  const opts = mobile ? { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true } : { viewport: { width: 1440, height: 900 } };
  const ctx = await browser.newContext({ ...opts, locale: locale === 'ar' ? 'ar-EG' : 'en-US', ...(who && storage[who] ? { storageState: storage[who] } : {}) });
  // Vercel Authentication: the automation bypass sets a cookie for the web origin only (API calls are untouched).
  const p = await ctx.newPage();
  await p.goto(`${WEB}/?x-vercel-protection-bypass=${env.VERCEL_BYPASS}&x-vercel-set-bypass-cookie=samesitenone`, { waitUntil: 'domcontentloaded' });
  await ctx.addCookies([{ name: 'resuto_locale', value: locale, url: WEB }]);
  if (who && !storage[who]) {
    await p.goto(`${WEB}/login`, { waitUntil: 'networkidle' });
    await p.getByLabel(/^Email|البريد/).fill(ACCOUNTS[who][0]);
    await p.getByLabel(/^Password|كلمة المرور/).fill(ACCOUNTS[who][1]);
    await p.getByRole('button', { name: /^(Sign in|تسجيل الدخول)$/ }).click();
    await p.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 45_000 });
    storage[who] = await ctx.storageState();
    results.push({ id: `login-${who}`, title: `Real Supabase sign-in as ${who}`, status: 'ok', errors: [], failures: [] });
    console.log(`✓ signed in through the login form as ${who}`);
  }
  return { ctx, p };
}
async function shoot([id, group, url, who, opts = {}], locale, device) {
  const { ctx, p } = await context(locale, device === 'mobile', who);
  const errors = [], failures = [];
  p.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 240)); });
  p.on('pageerror', (e) => errors.push(`pageerror: ${e.message.slice(0, 240)}`));
  p.on('response', (r) => {
    if (r.url().startsWith(API) && r.status() >= 400 && r.request().method() !== 'OPTIONS') failures.push(`${r.status()} ${r.request().method()} ${new URL(r.url()).pathname}`);
    else if (r.status() >= 500) errors.push(`web ${r.status()} ${new URL(r.url()).pathname}${r.request().headers()['rsc'] ? ' (RSC)' : ''}`);
  });
  let status = 'ok', file = null, dir = null;
  try {
    await p.goto(WEB + url, { waitUntil: 'load', timeout: 90_000 });
    await p.waitForTimeout(1500);
    await p.waitForFunction(() => !document.querySelector('.skeleton, [aria-busy="true"]'), null, { timeout: 25_000 }).catch(() => { status = 'still-loading'; });
    await p.waitForTimeout(800);
    if (new URL(p.url()).pathname.startsWith('/login') && who) status = 'redirected-to-login';
    const png = await p.screenshot({ fullPage: device !== 'mobile' });
    const meta = await sharp(png).metadata();
    const maxH = device === 'mobile' ? 1688 : 2600;
    const img = meta.height > maxH ? sharp(png).extract({ left: 0, top: 0, width: meta.width, height: maxH }) : sharp(png);
    file = `shots/${id}-${locale}-${device}.webp`;
    await img.resize({ width: device === 'mobile' ? 600 : 1280 }).webp({ quality: 74 }).toFile(path.join(OUT, file));
    dir = await p.evaluate(() => document.querySelector('[dir]')?.getAttribute('dir') ?? document.documentElement.dir);
  } catch (e) { status = `error: ${e.message.slice(0, 160)}`; }
  await ctx.close();
  results.push({ id, group, url: url.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, '…'), who, locale, device, status, file, dir, errors, failures });
  console.log(`${status === 'ok' && !errors.length && !failures.length ? '✓' : '!'} ${id} ${locale}/${device} ${status} errors=${errors.length} api=${failures.join('|') || 0}`);
}
const ONLY = env.ONLY ? new Set(env.ONLY.split(',')) : null;   // re-check selected page ids
for (const page of PAGES) {
  if (ONLY && !ONLY.has(page[0])) continue;
  const o = page[4] ?? {};
  const runs = o.mobileOnly ? [['en', 'mobile'], ['ar', 'mobile']] : [['en', 'desktop'], ['ar', 'desktop'], ...(o.mobile ? [['en', 'mobile'], ['ar', 'mobile']] : [])];
  for (const [l, d] of runs) await shoot(page, l, d);
}
await browser.close();
writeFileSync(path.join(OUT, ONLY ? 'results-recheck.json' : 'results.json'), JSON.stringify(results, null, 2));
const bad = results.filter((r) => r.status !== 'ok' || r.errors?.length || r.failures?.length);
console.log(`\n${results.length - bad.length}/${results.length} page loads clean`);
process.exit(bad.length ? 1 : 0);
