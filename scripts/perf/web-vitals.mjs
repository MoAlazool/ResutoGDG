#!/usr/bin/env node
// Throttled mobile Web Vitals runner (CR-16): LCP, CLS, FCP, TTFB, request counts and transferred bytes per
// resource type for key pages, first visit (cold browser cache) and repeat visit (same browser profile), plus the
// API calls a page makes while it sits open (polling). Local or staging only.
//
//   PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers node scripts/perf/web-vitals.mjs --web http://127.0.0.1:3570 \
//     --api http://127.0.0.1:4570 --accounts <demo-accounts.json> --label baseline [--pages landing,guest-qr] \
//     [--runs 3] [--observe 20] [--shots <dir>] [--out results.json]
//
// Profile: 390x844 @2x mobile viewport, 150 ms RTT, 1.6 Mbit/s down, 750 kbit/s up, CPU slowed 4x (close to
// Lighthouse "slow 4G" mobile). Each page runs `runs` times in fresh browser contexts and reports the median;
// the repeat visit reloads in the same context to show what HTTP caching saves. Lab numbers on one machine:
// use them to compare versions, not as field data.
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import { args, assertLocalUrl } from './lib/guard.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const { chromium } = createRequire(path.join(root, 'package.json'))('@playwright/test');
const a = args();
const WEB = String(a.web ?? 'http://127.0.0.1:3570').replace(/\/$/, '');
const API = String(a.api ?? 'http://127.0.0.1:4570').replace(/\/(v1)?\/?$/, '');
assertLocalUrl(WEB);
assertLocalUrl(API);
const RUNS = Number(a.runs ?? 3);
const OBSERVE_S = Number(a.observe ?? 20);
const label = String(a.label ?? 'run');
const acct = JSON.parse(readFileSync(a.accounts ?? '', 'utf8'));

const login = await (await fetch(`${API}/v1/auth/dev/login`, { method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: acct.owner.email, password: acct.owner.password }) })).json();
if (!login.accessToken) throw new Error('dev login failed');
const D = `/dashboard/${acct.orgId}`;
/** [id, path, public, locale, observe-polling] */
const ALL = [
  ['landing', '/', true, 'en'], ['landing-ar', '/', true, 'ar'], ['public-site', `/r/${acct.slug}`, true, 'en'],
  ['guest-qr', `/t/${acct.qr.qrToken}`, true, 'ar', true], ['web-order', `/order/${acct.slug}`, true, 'en'],
  ['overview', D, false, 'en', true], ['orders', `${D}/orders`, false, 'en', true], ['customers', `${D}/customers`, false, 'en'],
  ['kds-full', `/kitchen/${acct.orgId}`, false, 'en', true],
];
const pages = a.pages ? String(a.pages).split(',') : null;
const typeOf = (t, url, mime) => (t === 'Font' || /\.(woff2?|ttf|otf)(\?|$)/.test(url) ? 'font'
  : t === 'Image' || /^image\//.test(mime ?? '') ? 'image' : t === 'Script' ? 'script' : t === 'Stylesheet' ? 'css'
  : t === 'Document' ? 'document' : t === 'Fetch' || t === 'XHR' ? 'api' : 'other');

async function visit(ctx, page, cdp, url) {
  const reqs = new Map();
  const on = (name, fn) => { cdp.on(name, fn); return () => cdp.off(name, fn); };
  const offs = [
    on('Network.requestWillBeSent', (e) => { reqs.set(e.requestId, { url: e.request.url, method: e.request.method, type: e.type, t: Date.now(), bytes: 0, cached: false, status: 0 }); }),
    on('Network.responseReceived', (e) => { const r = reqs.get(e.requestId); if (r) { r.status = e.response.status; r.mime = e.response.mimeType; r.cached = r.cached || !!(e.response.fromDiskCache || e.response.fromServiceWorker || e.response.fromPrefetchCache); r.cacheControl = e.response.headers['cache-control'] ?? e.response.headers['Cache-Control']; } }),
    on('Network.requestServedFromCache', (e) => { const r = reqs.get(e.requestId); if (r) r.cached = true; }),
    on('Network.loadingFinished', (e) => { const r = reqs.get(e.requestId); if (r) r.bytes = e.encodedDataLength; }),
  ];
  const t0 = Date.now();
  await page.goto(url, { waitUntil: 'load', timeout: 120_000 });
  const loadMs = Date.now() - t0;
  await page.waitForTimeout(4000);
  const vitals = await page.evaluate(() => window.__p);
  const nav = await page.evaluate(() => { const n = performance.getEntriesByType('navigation')[0]; return n ? Math.round(n.responseStart) : null; });
  const settled = Date.now();
  offs.forEach((off) => off());
  const list = [...reqs.values()].filter((r) => !r.url.startsWith('data:'));
  const by = {};
  for (const r of list) {
    const k = typeOf(r.type, r.url, r.mime);
    by[k] ??= { n: 0, kb: 0, cached: 0 };
    by[k].n++; by[k].kb += r.bytes / 1024; if (r.cached || r.status === 304) by[k].cached++;
  }
  for (const k of Object.keys(by)) by[k].kb = Math.round(by[k].kb);
  return { loadMs, ttfb: nav, fcp: Math.round(vitals.fcp), lcp: Math.round(vitals.lcp), lcpEl: vitals.lcpEl.slice(0, 40), cls: +vitals.cls.toFixed(3),
    requests: list.length, kb: Math.round(list.reduce((s, r) => s + r.bytes, 0) / 1024), cachedOr304: list.filter((r) => r.cached || r.status === 304).length,
    fromCache: list.filter((r) => r.cached).length, revalidated: list.filter((r) => r.status === 304).length,
    by, settled, list };
}

const median = (arr) => { const s = [...arr].sort((x, y) => x - y); return s[Math.floor((s.length - 1) / 2)]; };
const browser = await chromium.launch();
const out = [];
for (const [id, p, isPublic, locale, observe] of ALL.filter(([id]) => !pages || pages.includes(id))) {
  const runs = [];
  for (let run = 0; run < RUNS; run++) {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    await ctx.addCookies([{ name: 'resuto_locale', value: locale, url: WEB }]);
    if (!isPublic) {
      await ctx.addInitScript(([s]) => { try { localStorage.setItem('resuto_session', s); } catch { /* storage blocked */ } },
        [JSON.stringify({ accessToken: login.accessToken, expiresAt: Date.now() + login.expiresIn * 1000, email: acct.owner.email })]);
    }
    await ctx.addInitScript(() => {
      window.__p = { lcp: 0, cls: 0, fcp: 0, lcpEl: '' };
      new PerformanceObserver((l) => { for (const e of l.getEntries()) { window.__p.lcp = e.startTime; window.__p.lcpEl = `${e.element?.tagName ?? ''}.${e.element?.className ?? ''}`; } }).observe({ type: 'largest-contentful-paint', buffered: true });
      new PerformanceObserver((l) => { for (const e of l.getEntries()) if (!e.hadRecentInput) window.__p.cls += e.value; }).observe({ type: 'layout-shift', buffered: true });
      new PerformanceObserver((l) => { for (const e of l.getEntries()) if (e.name === 'first-contentful-paint') window.__p.fcp = e.startTime; }).observe({ type: 'paint', buffered: true });
    });
    const page = await ctx.newPage();
    const cdp = await ctx.newCDPSession(page);
    await cdp.send('Network.enable');
    await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 150, downloadThroughput: (1.6 * 1024 * 1024) / 8, uploadThroughput: (750 * 1024) / 8 });
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    const first = await visit(ctx, page, cdp, WEB + p);
    if (run === 0 && a.shots) {
      mkdirSync(a.shots, { recursive: true });
      await page.screenshot({ path: path.join(a.shots, `${label}-${id}.png`) });
    }
    let polling = null;
    if (observe && run === 0) {
      // API calls while the page sits open (no navigation): polling budget.
      const seen = [];
      const onReq = (e) => { if (e.request.url.startsWith(API)) seen.push({ method: e.request.method, url: e.request.url }); };
      const onResp = (e) => { const s = seen.find((x) => x.url === e.response.url && x.status === undefined); if (s) s.status = e.response.status; };
      cdp.on('Network.requestWillBeSent', onReq);
      cdp.on('Network.responseReceived', onResp);
      await page.waitForTimeout(OBSERVE_S * 1000);
      cdp.off('Network.requestWillBeSent', onReq);
      cdp.off('Network.responseReceived', onResp);
      const gets = seen.filter((x) => x.method === 'GET');
      polling = { perMinute: Math.round((gets.length / OBSERVE_S) * 60), preflightsPerMinute: Math.round((seen.filter((x) => x.method === 'OPTIONS').length / OBSERVE_S) * 60),
        notModified: gets.filter((x) => x.status === 304).length, total: gets.length };
    }
    const repeat = await visit(ctx, page, cdp, WEB + p);
    runs.push({ first, repeat, polling });
    await ctx.close();
  }
  const pick = (k, sel) => median(runs.map((r) => sel(r)[k]));
  const row = {
    id, locale,
    lcp: pick('lcp', (r) => r.first), fcp: pick('fcp', (r) => r.first), cls: pick('cls', (r) => r.first), ttfb: pick('ttfb', (r) => r.first),
    loadMs: pick('loadMs', (r) => r.first), lcpEl: runs[0].first.lcpEl, requests: pick('requests', (r) => r.first), kb: pick('kb', (r) => r.first),
    fontKb: median(runs.map((r) => r.first.by.font?.kb ?? 0)), imageKb: median(runs.map((r) => r.first.by.image?.kb ?? 0)),
    scriptKb: median(runs.map((r) => r.first.by.script?.kb ?? 0)), apiKb: median(runs.map((r) => r.first.by.api?.kb ?? 0)),
    repeatLcp: pick('lcp', (r) => r.repeat), repeatLcpEl: runs[0].repeat.lcpEl, repeatFcp: pick('fcp', (r) => r.repeat),
    // Per-run values, so a median can be checked against its spread.
    lcpRuns: runs.map((r) => r.first.lcp), repeatLcpRuns: runs.map((r) => r.repeat.lcp), repeatLcpEls: runs.map((r) => r.repeat.lcpEl),
    repeatKb: pick('kb', (r) => r.repeat), repeatRequests: pick('requests', (r) => r.repeat),
    repeatCachedOr304: pick('cachedOr304', (r) => r.repeat), repeatFromCache: pick('fromCache', (r) => r.repeat), repeatRevalidated: pick('revalidated', (r) => r.repeat),
    repeatImageKb: median(runs.map((r) => r.repeat.by.image?.kb ?? 0)),
    repeatFontKb: median(runs.map((r) => r.repeat.by.font?.kb ?? 0)),
    polling: runs[0].polling,
  };
  out.push(row);
  console.error(JSON.stringify(row));
}
await browser.close();

let commit = null;
try { commit = execSync('git rev-parse --short HEAD', { cwd: root }).toString().trim(); } catch { /* not a checkout */ }
const lines = ['| page | LCP ms | FCP ms | CLS | TTFB | requests | KB (font / img / js / api) | repeat: KB (img / font), from cache, 304 | repeat LCP | API GET/min open (304s) |', '|' + '---|'.repeat(10)];
for (const r of out) {
  lines.push(`| ${r.id} | ${r.lcp} | ${r.fcp} | ${r.cls} | ${r.ttfb} | ${r.requests} | ${r.kb} (${r.fontKb} / ${r.imageKb} / ${r.scriptKb} / ${r.apiKb}) | ${r.repeatKb} (${r.repeatImageKb} / ${r.repeatFontKb}), ${r.repeatFromCache}/${r.repeatRequests}, ${r.repeatRevalidated} | ${r.repeatLcp} | ${r.polling ? `${r.polling.perMinute} (+${r.polling.preflightsPerMinute} OPTIONS; ${r.polling.notModified}/${r.polling.total} 304)` : '-'} |`);
}
const md = `Web vitals "${label}" at ${commit ?? '?'} (${new Date().toISOString()}); median of ${RUNS} runs; mobile 390x844, 150 ms RTT, 1.6 Mbit/s, CPU x4\n\n${lines.join('\n')}\n`;
console.log(md);
if (a.out) {
  mkdirSync(path.dirname(path.resolve(a.out)), { recursive: true });
  writeFileSync(a.out, JSON.stringify({ label, commit, at: new Date().toISOString(), runs: RUNS, rows: out }, null, 1));
  writeFileSync(String(a.out).replace(/\.json$/, '') + '.md', md);
}
