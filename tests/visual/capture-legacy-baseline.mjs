// Captures PNGs; the committed baseline was converted to WebP (quality 72) with Pillow to keep the repository small.
// Capture baseline screenshots of the legacy Resuto app (read-only use of legacy/).
//
// Usage (from repo root):
//   PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers \
//   NODE_PATH=/opt/node22/lib/node_modules \
//   node tests/visual/capture-legacy-baseline.mjs
//
// Starts legacy/server.js on port 3200 against a throw-away SQLite file, seeds a
// little live activity through the public/staff APIs (one dine-in order so the
// kitchen and manager boards are not empty), captures desktop (1440x900) and
// mobile (390x844) full-page PNGs into docs/ui/baseline/, then stops the server.
// Pages taller than 4000px are cropped to the first 4000px.
import {spawn} from 'node:child_process';
import {mkdirSync, rmSync, statSync, writeFileSync, existsSync} from 'node:fs';
import {createRequire} from 'node:module';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const require = createRequire(import.meta.url);
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || '/opt/node22/lib/node_modules/playwright');

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../..');
const legacy = path.join(repo, 'legacy');
const out = path.join(repo, 'docs/ui/baseline');
const PORT = Number(process.env.BASELINE_PORT || 3200);
const ORIGIN = `http://localhost:${PORT}`;
const tmpDir = process.env.BASELINE_TMP || '/tmp/claude-0/resuto-audit';
const PASSWORDS = {manager: 'audit-manager-pw', kitchen: 'audit-kitchen-pw', host: 'audit-host-pw'};
const VIEWPORTS = {desktop: {width: 1440, height: 900}, mobile: {width: 390, height: 844}};
const MAX_HEIGHT = 4000, MAX_BYTES = 3 * 1024 * 1024;

process.env.PLAYWRIGHT_BROWSERS_PATH ||= '/opt/pw-browsers';
mkdirSync(out, {recursive: true});
rmSync(tmpDir, {recursive: true, force: true});
mkdirSync(tmpDir, {recursive: true});

const env = {...process.env, PORT: String(PORT), APP_ORIGIN: ORIGIN, DB_PATH: path.join(tmpDir, 'db.sqlite'),
  MANAGER_PASSWORD: PASSWORDS.manager, KITCHEN_PASSWORD: PASSWORDS.kitchen, HOST_PASSWORD: PASSWORDS.host,
  PAYMENT_MODE: 'test', FIREBASE_TENANT_MODE: 'false'};
for (const k of ['GEMINI_API_KEY', 'STRIPE_SECRET_KEY', 'PAYMOB_SECRET_KEY', 'FOODICS_API_TOKEN', 'ODOO_API_KEY']) delete env[k];

const server = spawn(process.execPath, ['server.js'], {cwd: legacy, env, stdio: ['ignore', 'pipe', 'pipe']});
let serverLog = '';
server.stdout.on('data', d => serverLog += d);
server.stderr.on('data', d => serverLog += d);

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitForServer() {
  for (let i = 0; i < 100; i++) {
    try { const r = await fetch(ORIGIN + '/api/events'); if (r.ok) return; } catch {}
    await sleep(200);
  }
  throw new Error('Legacy server did not start:\n' + serverLog);
}
const json = (url, body, headers = {}) => fetch(ORIGIN + url, {method: body ? 'POST' : 'GET',
  headers: {'Content-Type': 'application/json', ...headers}, body: body ? JSON.stringify(body) : undefined})
  .then(async r => { const data = await r.json().catch(() => ({})); if (!r.ok) throw new Error(`${url} ${r.status} ${data.error}`); return data; });

const results = [];
async function capture(browser, name, route, {role = null, viewportNames = ['desktop', 'mobile'], waitFor = null} = {}) {
  for (const vp of viewportNames) {
    const file = path.join(out, `${name}-${vp}.png`);
    const context = await browser.newContext({viewport: VIEWPORTS[vp], deviceScaleFactor: 1,
      isMobile: vp === 'mobile', hasTouch: vp === 'mobile', locale: 'en-US', timezoneId: 'Africa/Cairo'});
    const errors = [];
    try {
      if (role) {
        const r = await context.request.post(ORIGIN + '/api/login', {data: {role, password: PASSWORDS[role]}});
        if (!r.ok()) throw new Error(`login ${role} failed: ${r.status()}`);
      }
      const page = await context.newPage();
      page.on('pageerror', e => errors.push(String(e)));
      await page.goto(ORIGIN + route, {waitUntil: 'networkidle', timeout: 30000});
      if (waitFor) await page.waitForSelector(waitFor, {timeout: 10000}).catch(e => errors.push('waitFor ' + waitFor + ': ' + e.message.split('\n')[0]));
      await page.waitForTimeout(800);
      // Scroll through the page so IntersectionObserver-driven reveals render, then return to top.
      await page.evaluate(async () => {
        const step = Math.max(200, Math.floor(innerHeight * 0.6));
        for (let y = 0; y < document.documentElement.scrollHeight; y += step) { scrollTo(0, y); await new Promise(r => setTimeout(r, 120)); }
        scrollTo(0, 0);
      });
      await page.waitForTimeout(1200);
      const height = await page.evaluate(() => Math.max(document.documentElement.scrollHeight, document.body.scrollHeight));
      const cropped = height > MAX_HEIGHT;
      const shot = async h => page.screenshot({path: file, fullPage: true, animations: 'disabled',
        clip: {x: 0, y: 0, width: VIEWPORTS[vp].width, height: Math.min(height, h)}});
      await shot(MAX_HEIGHT);
      let size = statSync(file).size, finalHeight = Math.min(height, MAX_HEIGHT);
      if (size > MAX_BYTES) { finalHeight = Math.min(height, 2500); await shot(2500); size = statSync(file).size; }
      results.push({name, viewport: vp, route, file: path.relative(repo, file), pageHeight: height,
        capturedHeight: finalHeight, cropped: cropped || finalHeight < height, bytes: size, pageErrors: errors});
      console.log(`ok   ${name}-${vp} (${route}) ${height}px -> ${finalHeight}px, ${(size / 1024).toFixed(0)} KB${errors.length ? ' errors: ' + errors.join(' | ') : ''}`);
    } catch (e) {
      results.push({name, viewport: vp, route, failed: String(e.message || e).split('\n')[0], pageErrors: errors});
      console.log(`FAIL ${name}-${vp} (${route}): ${e.message}`);
    } finally { await context.close(); }
  }
}

let exitCode = 0;
try {
  await waitForServer();
  // Seed: open table T2 by its QR, place one order so kitchen/manager boards show a ticket.
  const pub = await json('/api/public');
  const [t1, t2] = pub.tables;
  const session = await json('/api/table-session', {qr: t2.qr});
  await json('/api/order', {lines: [{id: 'm0', qty: 2}, {id: 'm7', qty: 2}], notes: 'Baseline seed order', key: 'baseline-order-1'},
    {Authorization: 'Bearer ' + session.token});

  const browser = await chromium.launch({headless: true});
  const pages = [
    ['landing', '/', {waitFor: '.lp-hero'}],
    ['landing-ar', '/?lang=ar', {waitFor: '.lp-hero'}],
    ['pricing', '/pricing'],
    ['restaurant', '/restaurant'],
    ['restaurant-ar', '/restaurant?lang=ar'],
    ['menu', '/menu', {waitFor: '.dish-grid'}],
    ['reserve', '/reserve', {waitFor: '.bk-slot'}],
    ['order', '/order'],
    ['table-qr', '/t/' + t1.qr, {waitFor: '.dish-grid'}],
    ['manager', '/manager', {role: 'manager', waitFor: '.workspace'}],
    ['manager-floor-editor', '/manager/floor-editor', {role: 'manager', waitFor: '#studio-canvas'}],
    ['manager-setup', '/manager/setup', {role: 'manager'}],
    ['kitchen', '/kitchen', {role: 'kitchen', waitFor: '.workspace'}],
    ['host', '/host', {role: 'host'}],
    ['manager-login', '/manager', {viewportNames: ['desktop']}],
    ['burger', '/burger'],
  ];
  for (const [name, route, opts] of pages) await capture(browser, name, route, opts || {});
  await browser.close();
} catch (e) {
  console.error(e); exitCode = 1;
} finally {
  server.kill('SIGTERM');
  writeFileSync(path.join(out, 'manifest.json'), JSON.stringify({capturedAt: new Date().toISOString(), origin: ORIGIN, results}, null, 2));
  if (results.some(r => r.failed)) exitCode = exitCode || 2;
  await sleep(300);
  process.exit(exitCode);
}
