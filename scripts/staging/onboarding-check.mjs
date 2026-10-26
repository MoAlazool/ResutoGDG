#!/usr/bin/env node
// Free onboarding flow against the DEPLOYED services (plan §12.3), as a brand-new owner: a fresh throwaway account
// signs up → the wizard's API calls in order (progress saved after each step) → restaurant on the Free plan with its
// web address → theme preset → a two-dish menu → publish → the view-only menu QR (PNG + SVG) → the public menu
// (/m/<slug>) and site (/r/<slug>) are browsable with no cart or ordering UI, and the plan is Free (the full Studio
// answers 402) → cleanup.
//
// Staging (Supabase Auth; "Confirm email" is ON there, so the public signup returns no session):
//   API_URL=https://… [WEB_URL=https://… VERCEL_BYPASS=…] SUPABASE_URL=https://<ref>.supabase.co \
//   SUPABASE_PUBLISHABLE_KEY=sb_publishable_… [SUPABASE_SERVICE_ROLE_KEY=…] [DEMO_ADMIN_PASSWORD=… DEMO_EMAIL_DOMAIN=…] \
//   node scripts/staging/onboarding-check.mjs
//   Without SUPABASE_SERVICE_ROLE_KEY a confirmation-gated signup is reported as BLOCKED (exit 3), never faked; with it,
//   the check confirms the throwaway account through the Admin Auth API and says so.
// Local stack (development issuer): AUTH_MODE=local API_URL=http://127.0.0.1:4681 [WEB_URL=http://localhost:3681]
//   [ADMIN_EMAIL=… ADMIN_PASSWORD=…] node scripts/staging/onboarding-check.mjs
//
// Every throwaway is named stg-onb-<yyyymmddhhmm>-<hex> (slug and email local part; ONBOARDING_PREFIX overrides the
// prefix). Resuto has no account or restaurant deletion API, so the cleanup neutralises instead (see
// docs/STAGING_DEPLOYMENT.md): the owner deactivates the branch (the public menu stops), a platform admin suspends the
// tenant when admin credentials are given (the site stops, staff access ends), and with the service-role key the
// account is banned. What remains is listed at the end. Exit 0 = passed, 1 = failed, 3 = blocked. Never prints secrets.
import { randomBytes } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  brief, createReport, errCode, leaks, makeAuth, menuQrProblems, orderingUiMarkers, pngBytes, req, targetProblem, throwawayId, visibleHtml,
} from './lib/check-kit.mjs';

const env = process.env;
const LOCAL = env.AUTH_MODE === 'local';
for (const k of ['API_URL', ...(LOCAL ? [] : ['SUPABASE_URL', 'SUPABASE_PUBLISHABLE_KEY'])]) if (!env[k]) { console.error(`missing ${k}`); process.exit(2); }
for (const u of [env.API_URL, env.WEB_URL].filter(Boolean)) {
  const p = targetProblem(u, env.ALLOW_NON_STAGING === '1');
  if (p) { console.error(`refusing to run: ${p}`); process.exit(2); }
}
const API = `${env.API_URL.replace(/\/$/, '')}/v1`;
const WEB = env.WEB_URL?.replace(/\/$/, '') ?? null;
const webHeaders = env.VERCEL_BYPASS ? { 'x-vercel-protection-bypass': env.VERCEL_BYPASS } : {};
const ID = throwawayId(env.ONBOARDING_PREFIX ?? 'stg-onb');
const DOMAIN = env.ONBOARDING_EMAIL_DOMAIN ?? (LOCAL ? 'example.test' : (env.DEMO_EMAIL_DOMAIN ?? 'olive-room.demo.test'));
const EMAIL = `${ID}@${DOMAIN}`;
const PASSWORD = `Stg-${randomBytes(12).toString('base64url')}-7a`; // per run, never printed
const NAME = 'Staging check: onboarding (throwaway)';
const DISHES = [['Throwaway flat white (test)', 6500], ['Throwaway croissant (test)', 4550]];

const R = createReport(`Free onboarding check (${LOCAL ? 'local stack, development issuer' : 'staging, Supabase Auth'}) — ${ID}`);
const { check, blocked, note } = R;
const auth = makeAuth(env, API);
const api = (method, p, opts) => req(method, API + p, opts);
const leftovers = [];
const done = () => {
  if (leftovers.length) { console.log('\nLeft on the target (prefix for cleanup):'); for (const l of leftovers) console.log(`  - ${l}`); }
  R.finish(env, { throwaway: ID, email: EMAIL, leftovers });
};

// --- 0. services ----------------------------------------------------------------------------------------------------
const health = await api('GET', '/health');
R.recordBuild('api', health);
check('API health', health.status === 200 && health.body?.status === 'ok', `HTTP ${health.status}`);
if (WEB) {
  const v = await req('GET', `${WEB}/api/version`, { headers: webHeaders });
  if (v.status === 200) R.recordBuild('web', { status: v.status, headers: v.headers, body: { build: v.body } });
}
if (health.status !== 200) done();

// --- 1. a fresh account signs up -------------------------------------------------------------------------------------
const signup = await auth.signUp(EMAIL, PASSWORD, 'Throwaway owner (staging check)');
if (!signup.session) {
  blocked('A fresh throwaway account signs up and gets a session', `${signup.error}. No admin path: set SUPABASE_SERVICE_ROLE_KEY to let the check confirm its own throwaway account, or turn email confirmation off for the run`);
  if (!LOCAL) leftovers.push(`possibly an unconfirmed Supabase user ${EMAIL} (Authentication → Users; delete it)`);
  done();
}
leftovers.push(`account ${EMAIL}`);
let tok = signup.session.accessToken;
check('A fresh throwaway account signs up and gets a session', true, signup.via);
const me = await api('GET', '/me', { token: tok });
const userId = signup.session.userId ?? me.body?.user?.id;
check('New account has no restaurant yet', me.status === 200 && (me.body?.memberships ?? []).length === 0, `${me.body?.memberships?.length ?? '?'} membership(s)`);

// --- 2. wizard: restaurant → address (creates the Free restaurant) ---------------------------------------------------
const progress = (body) => api('PUT', '/onboarding/progress', { token: tok, body });
const p0 = await api('GET', '/onboarding/progress', { token: tok });
check('Wizard starts at the restaurant step', p0.status === 200 && p0.body?.step === 'restaurant', `${p0.body?.step} (${(p0.body?.completed ?? []).join(',')})`);
const draft = { name: NAME, nameAr: 'فحص التجهيز (مؤقت)', country: 'EG', serviceMode: 'counter' };
const p1 = await progress({ step: 'address', completed: ['restaurant'], draft });
check('Restaurant step saved (resumable progress)', p1.status === 200 && p1.body?.step === 'address', brief(p1));
const avail = await api('GET', `/orgs/slug-availability?slug=${ID}`, { token: tok });
check('Web address is available', avail.body?.available === true, `${ID}: ${avail.body?.reason ?? 'available'}`);
const org = await api('POST', '/orgs', { token: tok, body: { name: NAME, nameAr: draft.nameAr, slug: ID, country: 'EG', planId: 'free', defaultLocale: 'en', branch: { name: 'Main branch' } } });
if (!check('Restaurant created on the Free plan with that web address', org.status === 201 && !!org.body?.id, brief(org))) done();
leftovers.push(`restaurant /${ID} (organization ${org.body.id})`);
const O = (p) => `/o/${org.body.id}${p}`;
const mode = await api('PUT', O(`/branches/${org.body.branchId}/service-mode`), { token: tok, body: { mode: 'counter' } });
const p2 = await progress({ step: 'brand', completed: ['address'], orgId: org.body.id, draft: { ...draft, slug: ID } });
check('Service mode set and progress linked to the restaurant', mode.status === 200 && p2.body?.orgId === org.body.id, `${brief(mode)}, step ${p2.body?.step}`);

// --- 3. theme --------------------------------------------------------------------------------------------------------
const presets = await api('GET', O('/brand/presets'), { token: tok });
const preset = presets.body?.items?.[0]?.id;
const brand = await api('PUT', O('/brand'), { token: tok, body: { presetId: preset } });
check('Theme preset applied (studio_basic on Free)', brand.status === 200 && brand.body?.presetId === preset, `${presets.body?.items?.length ?? 0} presets, chose ${preset}`);
await progress({ step: 'menu', completed: ['brand'] });

// --- 4. menu ---------------------------------------------------------------------------------------------------------
const cat = await api('POST', O('/menu/categories'), { token: tok, body: { name: 'Coffee & bakery', nameAr: null } });
const made = [];
for (const [name, priceMinor] of DISHES) made.push(await api('POST', O('/menu/products'), { token: tok, body: { categoryId: cat.body?.id, name, nameAr: null, priceMinor } }));
check('Menu added (one category, two dishes)', cat.status === 201 && made.every((r) => r.status === 201), [brief(cat), ...made.map(brief)].join(', '));
await progress({ step: 'publish', completed: ['menu', 'details', 'social'] });

// --- 5. publish ------------------------------------------------------------------------------------------------------
const pub = await api('POST', O('/brand/publish'), { token: tok, body: { key: `stg-onb-pub-${ID}` } });
check('Menu and site published', pub.status === 200 && pub.body?.revision >= 1 && pub.body?.links?.menu === `/m/${ID}`, `${brief(pub)} revision ${pub.body?.revision}, ${pub.body?.links?.menu} ${pub.body?.links?.site}`);

// --- 6. menu QR download ---------------------------------------------------------------------------------------------
const qr = await api('GET', O('/menu-qr'), { token: tok });
const problems = menuQrProblems(qr.body, ID);
check('Menu QR is view-only: opens /m/<slug>, no table or venue token', qr.status === 200 && problems.length === 0, problems.join('; ') || qr.body?.url);
const png = pngBytes(qr.body?.png);
const dir = mkdtempSync(path.join(tmpdir(), 'resuto-onb-qr-'));
if (png) writeFileSync(path.join(dir, `${ID}-menu-qr.png`), png);
if (typeof qr.body?.svg === 'string') writeFileSync(path.join(dir, `${ID}-menu-qr.svg`), qr.body.svg);
check('Menu QR downloads as PNG and SVG', !!png && /<svg[\s>]/.test(qr.body?.svg ?? ''), `PNG ${png?.length ?? 0} bytes, SVG ${qr.body?.svg?.length ?? 0} chars, saved in ${dir}`);
note('the PDF posters (A4, A5, table tent) are generated in the browser from this QR (apps/web/lib/onboarding/poster); this API-level check does not render them');
const p3 = await progress({ step: 'qr', completed: ['publish', 'qr'], done: true });
check('Wizard finished (progress completed)', p3.status === 200 && !!p3.body?.completedAt, `step ${p3.body?.step}`);

// --- 7. the plan is Free --------------------------------------------------------------------------------------------
const setup = await api('GET', O('/setup'), { token: tok });
check('Plan is Free', setup.body?.planId === 'free', `planId ${setup.body?.planId}`);
const studio = await api('GET', O('/studio/website'), { token: tok });
check('Free has no full Studio (402 module_not_entitled)', studio.status === 402 && errCode(studio) === 'module_not_entitled', brief(studio));
note('KNOWN GAP (not asserted): the Free owner can still open the ordering-QR routes; apps/api/test/onboarding-free.test.ts pins it until the plan gate lands');

// --- 8. public: menu and site, no ordering --------------------------------------------------------------------------
const pm = await api('GET', `/public/menu/${ID}`);
const names = (pm.body?.categories ?? []).flatMap((c) => c.products.map((x) => x.name));
check('Public menu JSON lists the dishes with prices', pm.status === 200 && DISHES.every(([n]) => names.includes(n)), `HTTP ${pm.status}, ${names.length} dish(es)`);
check('Public menu carries no ordering tokens or secrets', pm.status === 200 && leaks(pm.text).length === 0, leaks(pm.text).join(', '));
const ps = await api('GET', `/public/sites/${ID}`);
check('Public site JSON is published', ps.status === 200 && ps.body?.revision >= 1, `HTTP ${ps.status}, revision ${ps.body?.revision ?? '?'}`);
if (WEB) {
  const m = await req('GET', `${WEB}/m/${ID}`, { headers: webHeaders });
  if ([401, 403].includes(m.status) || (m.status === 302 && !env.VERCEL_BYPASS)) blocked('/m/<slug> renders the view-only menu', `web answered HTTP ${m.status} (Vercel Authentication; set VERCEL_BYPASS)`);
  else {
    const html = visibleHtml(m.text);
    const markers = orderingUiMarkers(m.text);
    check('/m/<slug> renders the menu with its dishes', m.status === 200 && DISHES.every(([n]) => html.includes(n)), `HTTP ${m.status}`);
    check('/m/<slug> has no cart or ordering UI (view-only notice shown)', m.status === 200 && markers.length === 0 && /This menu is for browsing/.test(html), markers.join(', ') || 'no Add / stepper / dock / checkout / ordering links');
    const r = await req('GET', `${WEB}/r/${ID}`, { headers: webHeaders });
    check('/r/<slug> renders the published site', r.status === 200 && visibleHtml(r.text).includes(NAME), `HTTP ${r.status}`);
  }
}

// --- 9. cleanup: neutralise (there is no deletion API) ----------------------------------------------------------------
const off = await api('PATCH', O(`/branches/${org.body.branchId}`), { token: tok, body: { isActive: false } });
const gone = await api('GET', `/public/menu/${ID}`);
check('Cleanup: owner deactivates the branch, the public menu is no longer served', off.status === 200 && gone.status === 404, `${brief(off)}, public menu HTTP ${gone.status}`);
const adminEmail = env.ADMIN_EMAIL ?? (env.DEMO_ADMIN_PASSWORD ? `platform-admin@${env.DEMO_EMAIL_DOMAIN ?? 'olive-room.demo.test'}` : null);
const adminPassword = env.ADMIN_PASSWORD ?? env.DEMO_ADMIN_PASSWORD;
if (adminEmail && adminPassword) {
  const admin = await auth.signIn(adminEmail, adminPassword);
  const s = admin ? await api('POST', `/admin/tenants/${org.body.id}/suspend`, { token: admin.accessToken, body: { reason: `staging onboarding check throwaway ${ID}` } }) : null;
  if (s?.status === 403 && errCode(s) === 'mfa_required') blocked('Cleanup: platform admin suspends the throwaway tenant', 'the platform admin has an authenticator (aal2 needed); suspend it from the admin console');
  else {
    const site = await api('GET', `/public/sites/${ID}`);
    check('Cleanup: platform admin suspends the throwaway tenant (site gone, staff access ends)', s?.status === 200 && site.status === 404, admin ? `${brief(s)}, public site HTTP ${site.status}` : 'admin sign-in failed');
  }
} else note('no platform-admin credentials (ADMIN_EMAIL/ADMIN_PASSWORD or DEMO_ADMIN_PASSWORD): tenant not suspended');
const dis = await auth.disableUser(userId);
if (dis.ok) { note(`throwaway account banned and its name cleared (Supabase Admin Auth API)`); }
else note(`throwaway account left as is: ${dis.reason}`);
done();
