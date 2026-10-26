#!/usr/bin/env node
// Change-set "Eid offers" flow against the DEPLOYED services (plan §12.3), on a DEDICATED test tenant, never the demo
// restaurant: an MCP client (connection key) reads the menu and drafts one change set (an "offers" website section
// with three dishes + 15 % off each) → it waits for approval with a preview diff and nothing changes → the owner
// approves through the staff API (MFA step-up when the owner has a factor) → applied (prices, was-prices, draft
// section) → the MCP client publishes a website revision → the public site shows the section → the change set's audit
// trail and the connection's call log are there → cleanup: the key is revoked, the section is removed and the site
// republished, the discounts are ended through a second change set.
//
// Staging (Supabase Auth):
//   API_URL=https://… MCP_URL=https://… [WEB_URL=https://… VERCEL_BYPASS=…] \
//   SUPABASE_URL=https://<ref>.supabase.co SUPABASE_PUBLISHABLE_KEY=sb_publishable_… \
//   STAGING_CHECK_EMAIL=… STAGING_CHECK_PASSWORD=… [STAGING_CHECK_TOTP_SECRET=…] [SUPABASE_SERVICE_ROLE_KEY=…] \
//   node scripts/staging/eid-check.mjs
// Local stack (development issuer): AUTH_MODE=local API_URL=http://127.0.0.1:4681 MCP_URL=http://127.0.0.1:7381 \
//   [WEB_URL=http://localhost:3681] node scripts/staging/eid-check.mjs   (the account is created on first use)
//
// Optional: EID_TENANT_PREFIX (default stg-check-eid), EID_PLAN (default pro), EXPECT_COMMIT, SMOKE_REPORT=<file>.
// Exit 0 = all passed, 1 = a check failed, 3 = nothing failed but a step was blocked (e.g. MFA without a TOTP secret).
// Never prints secrets: passwords, tokens and the MCP key stay in memory.
import {
  brief, createReport, discountedPrice, errCode, leaks, makeAuth, mcpClient, missingInOrder, req, targetProblem, throwawayId, visibleHtml,
} from './lib/check-kit.mjs';

const env = process.env;
const LOCAL = env.AUTH_MODE === 'local';
const need = ['API_URL', 'MCP_URL', ...(LOCAL ? [] : ['SUPABASE_URL', 'SUPABASE_PUBLISHABLE_KEY', 'STAGING_CHECK_EMAIL', 'STAGING_CHECK_PASSWORD'])];
for (const k of need) if (!env[k]) { console.error(`missing ${k}`); process.exit(2); }
for (const u of [env.API_URL, env.MCP_URL, env.WEB_URL].filter(Boolean)) {
  const p = targetProblem(u, env.ALLOW_NON_STAGING === '1');
  if (p) { console.error(`refusing to run: ${p}`); process.exit(2); }
}

const API = `${env.API_URL.replace(/\/$/, '')}/v1`;
const MCP_BASE = env.MCP_URL.replace(/\/$/, '');
const WEB = env.WEB_URL?.replace(/\/$/, '') ?? null;
const webHeaders = env.VERCEL_BYPASS ? { 'x-vercel-protection-bypass': env.VERCEL_BYPASS } : {};
const PREFIX = env.EID_TENANT_PREFIX ?? 'stg-check-eid';
const PLAN = env.EID_PLAN ?? 'pro';
const EMAIL = env.STAGING_CHECK_EMAIL ?? 'stg-check-eid-owner@example.test';
const PASSWORD = env.STAGING_CHECK_PASSWORD ?? 'Local-check-password-1';
const HEADLINE = 'Eid offers';
const MARK = 'staging check';
const DISHES = [['Eid check: Koshary (test)', 9500], ['Eid check: Molokhia (test)', 12000], ['Eid check: Fatta (test)', 15000]];
const CATEGORY = 'Staging check (test data)';
const BPS = 1500;
const run = Date.now().toString(36);

const R = createReport(`Eid change-set check (${LOCAL ? 'local stack, development issuer' : 'staging, Supabase Auth'}) — run ${run}`);
const { check, blocked, note } = R;
const auth = makeAuth(env, API);
const api = (method, p, opts) => req(method, API + p, opts);
const done = () => R.finish(env, { tenant: state.slug ?? null, run });
const state = { slug: null };

// --- 0. services up, builds named ----------------------------------------------------------------------------------
const health = await api('GET', '/health');
R.recordBuild('api', health);
check('API health', health.status === 200 && health.body?.status === 'ok', `HTTP ${health.status}`);
const mh = await req('GET', `${MCP_BASE}/health`);
R.recordBuild('mcp', mh);
check('MCP server health', mh.status === 200, `HTTP ${mh.status}`);
if (WEB) {
  const v = await req('GET', `${WEB}/api/version`, { headers: webHeaders });
  if (v.status === 200) R.recordBuild('web', { status: v.status, headers: v.headers, body: { build: v.body } });
}
if (health.status !== 200 || mh.status !== 200) done();

// --- 1. the dedicated owner account --------------------------------------------------------------------------------
let owner = await auth.signIn(EMAIL, PASSWORD);
let how = 'signed in';
if (!owner && (LOCAL || auth.hasAdmin)) {
  const s = await auth.signUp(EMAIL, PASSWORD, 'Staging check owner (test)');
  owner = s.session;
  how = s.session ? `created (${s.via})` : `could not be created: ${s.error}`;
}
if (!owner) {
  check('Dedicated staging-check owner signs in', false, `${how}. Create the account once (Supabase → Authentication → Add user, auto-confirm) or set SUPABASE_SERVICE_ROLE_KEY`);
  done();
}
check('Dedicated staging-check owner signs in', true, `${how}, ${owner.aal}`);
let tok = owner.accessToken;
let stepped = null;
/** Runs a staff call; on 403 mfa_required steps up once with the TOTP secret and retries. Returns { r, aal, blocked }. */
async function sensitive(call) {
  let r = await call(stepped?.accessToken ?? tok);
  if (r.status === 403 && errCode(r) === 'mfa_required' && !stepped) {
    stepped = await auth.stepUp(owner, env.STAGING_CHECK_TOTP_SECRET);
    if (!stepped) return { r, aal: owner.aal, blocked: 'the owner has a verified authenticator and this needs aal2: set STAGING_CHECK_TOTP_SECRET (the factor\'s base32 secret) so the check can verify a code; it never bypasses the step-up' };
    r = await call(stepped.accessToken);
  }
  return { r, aal: stepped ? stepped.aal : owner.aal };
}

// --- 2. the dedicated tenant (reused while its paid trial is live) -------------------------------------------------
const me = await api('GET', '/me', { token: tok });
let tenant = null;
for (const m of (me.body?.memberships ?? []).filter((x) => x.role === 'owner' && x.orgSlug?.startsWith(`${PREFIX}-`)).sort((a, b) => b.orgSlug.localeCompare(a.orgSlug))) {
  const s = await api('GET', `/o/${m.orgId}/setup`, { token: tok });
  if (s.status === 200 && s.body?.planId && s.body.planId !== 'free') { tenant = { id: m.orgId, slug: m.orgSlug, reused: true }; break; }
  note(`tenant ${m.orgSlug} is on ${s.body?.planId ?? 'unknown'} now (trial lapsed): not reused, left as is`);
}
if (!tenant) {
  const slug = throwawayId(PREFIX);
  const c = await api('POST', '/orgs', { token: tok, body: { name: 'Staging check: Eid (test data)', nameAr: 'فحص التجهيز: العيد (بيانات اختبار)', slug, country: 'EG', planId: PLAN, branch: { name: 'Test branch' } } });
  if (c.status === 201) tenant = { id: c.body.id, slug, reused: false };
  else { check('Dedicated test tenant ready', false, `create: ${brief(c)}`); done(); }
}
state.slug = tenant.slug;
if (tenant.slug === 'the-olive-room' || !tenant.slug.startsWith(`${PREFIX}-`)) { check('Test tenant is not the demo restaurant', false, tenant.slug); done(); }
check('Dedicated test tenant ready (never the demo restaurant)', true, `${tenant.reused ? 'reused' : 'created'} /${tenant.slug} on ${PLAN === 'pro' ? 'a paid trial' : PLAN}`);
const O = (p) => `/o/${tenant.id}${p}`;

// --- 3. its three test dishes (created once; a discount left by an interrupted run is ended first) --------------------
async function menuView() { return (await api('GET', O('/menu'), { token: tok })).body; }
let view = await menuView();
let cat = view?.categories?.find((x) => x.name === CATEGORY);
if (!cat) cat = (await api('POST', O('/menu/categories'), { token: tok, body: { name: CATEGORY, nameAr: 'فحص التجهيز' } })).body;
for (const [name, price] of DISHES) {
  if (!view?.products?.some((p) => p.name === name && p.isActive)) await api('POST', O('/menu/products'), { token: tok, body: { categoryId: cat?.id, name, priceMinor: price } });
}
view = await menuView();
const dishes = DISHES.map(([name, price]) => ({ ...view?.products?.find((p) => p.name === name && p.isActive), original: price }));
if (!check('Three labelled test dishes on the test tenant', dishes.every((d) => d.id), dishes.map((d) => d.name ?? '?').join(', '))) done();

/** Ends the dishes' discounts through a staff change set the owner approves (prices are an approval group). */
async function endDiscounts(ids, title) {
  const p = await api('POST', O('/change-sets'), { token: tok, headers: { 'Idempotency-Key': `stg-eid-end-${run}-${title.length}-${ids.length}` },
    body: { title, ops: ids.map((productId) => ({ type: 'product.discount.set', input: { productId, discountBps: 0 } })) } });
  if (p.status >= 300) return { ok: false, detail: `propose ${brief(p)}` };
  if (p.body.status === 'applied') return { ok: true, detail: 'applied by policy' };
  const a = await sensitive((t) => api('POST', O(`/change-sets/${p.body.id}/approve`), { token: t, body: { note: MARK, previewDigest: p.body.previewDigest } }));
  if (a.blocked) return { ok: false, blocked: a.blocked };
  return { ok: a.r.status === 200 && a.r.body?.status === 'applied', detail: `${brief(a.r)} ${a.r.body?.status ?? ''}` };
}
async function removeSections(publishKey) {
  const w = await api('GET', O('/studio/website'), { token: tok });
  const ours = (w.body?.sections ?? []).filter((s) => s.kind === 'offers' && s.content?.headline?.en === HEADLINE);
  for (const s of ours) await api('DELETE', O(`/studio/website/sections/${s.id}`), { token: tok });
  if (ours.length && publishKey) await api('POST', O('/studio/website/publish'), { token: tok, body: { key: publishKey, note: `${MARK}: remove Eid section` } });
  return ours.length;
}
const leftover = dishes.filter((d) => d.compareAtMinor !== null && d.compareAtMinor !== undefined);
if (leftover.length) {
  const e = await endDiscounts(leftover.map((d) => d.id), 'Staging check: end leftover discounts');
  note(`pre-clean: ended ${leftover.length} leftover discount(s) from an earlier run: ${e.ok ? 'ok' : e.blocked ?? e.detail}`);
}
const stale = await removeSections(`stg-eid-preclean-${run}`);
if (stale) note(`pre-clean: removed ${stale} leftover "${HEADLINE}" section(s) and republished`);
view = await menuView();
for (const d of dishes) d.priceMinor = view?.products?.find((p) => p.id === d.id)?.priceMinor;
check('Test dishes start at their original prices (no discount)', dishes.every((d) => d.priceMinor === d.original),
  dishes.map((d) => d.priceMinor).join(' / '));

// --- 4. connect an MCP client (connection key, scoped by permission groups) -----------------------------------------
const created = await sensitive((t) => api('POST', O('/mcp/clients'), { token: t, body: {
  name: `Staging Eid check ${run} (temporary)`, actingRole: 'manager', rateLimitPerMin: 60, groups: ['menu', 'website_drafts', 'website_publish'],
} }));
if (created.blocked) { blocked('Owner creates a scoped MCP connection key', created.blocked); done(); }
const key = created.r.body?.key;
const clientId = created.r.body?.id;
if (!check('Owner creates a scoped MCP connection key (menu, website drafts, website publish)', created.r.status === 201 && /^rmcp_/.test(key ?? ''),
  `${brief(created.r)}, owner session ${created.aal}`)) done();
const mcp = mcpClient(`${MCP_BASE}/mcp`, key, { name: 'resuto-eid-staging-check' });
const init = await mcp.initialize();
check('MCP initialize (Streamable HTTP, connection key)', init.status === 200 && !!init.body?.result?.serverInfo, `${init.body?.result?.serverInfo?.name ?? brief(init)} session ${mcp.sessionId ? 'open' : 'none'}`);
const tools = (await mcp.listTools()).body?.result?.tools?.map((x) => x.name) ?? [];
check('tools/list offers the change-set tools and nothing outside the groups',
  ['list_menu', 'get_website_draft', 'propose_changes', 'publish_website_revision', 'get_approval_status'].every((n) => tools.includes(n)) && !tools.includes('list_orders') && !tools.includes('create_payment_link'),
  `${tools.length} tools`);

// --- 5. read, then draft the Eid change set --------------------------------------------------------------------------
const menu = await mcp.call('list_menu', { query: 'Eid check' });
const seen = new Set((menu.out?.items ?? []).map((i) => i.productId));
check('MCP reads the menu (list_menu finds the three test dishes)', !menu.isError && dishes.every((d) => seen.has(d.id)), `${menu.out?.items?.length ?? 0} item(s)`);
const draft0 = await mcp.call('get_website_draft', {});
const publishedBefore = draft0.out?.publishedRevision;
check('MCP reads the website draft', !draft0.isError && Number.isInteger(publishedBefore), `published revision ${publishedBefore}`);
const ids = dishes.map((d) => d.id);
const proposed = await mcp.call('propose_changes', {
  title: `${HEADLINE} (${MARK})`, summary: 'Eid section with three dishes at 15% off (automated staging check, test data)', idempotencyKey: `stg-eid-${run}`,
  ops: [
    { type: 'website.section.add', input: { kind: 'offers', content: { headline: { en: HEADLINE, ar: 'عروض العيد' }, productIds: ids, badge: { en: '15% off', ar: 'خصم 15%' } } } },
    ...ids.map((productId) => ({ type: 'product.discount.set', input: { productId, discountBps: BPS } })),
  ],
});
const csId = proposed.out?.changeSetId;
check('MCP drafts one change set: section + 15 % off three dishes → approval required', !proposed.isError && proposed.out?.status === 'approval_required' && !!csId
  && proposed.out.ops.map((o) => o.type).join() === ['website.section.add', 'product.discount.set', 'product.discount.set', 'product.discount.set'].join(),
  `${proposed.out?.status ?? proposed.text.slice(0, 120)}, policy ${proposed.out?.policy?.mode ?? '?'}`);
if (!csId) { await cleanup(); done(); }
const cs = await api('GET', O(`/change-sets/${csId}`), { token: tok });
const priceRows = (cs.body?.ops ?? []).filter((o) => o.type === 'product.discount.set').map((o) => o.changes?.[0]);
check('Staff API shows it pending approval, proposed by the MCP connection, with before/after prices',
  cs.body?.status === 'pending_approval' && cs.body?.origin === 'mcp' && cs.body?.actor?.mcpClientId === clientId && priceRows.length === 3 && priceRows.every((c) => c?.before && c?.after && c.before !== c.after),
  priceRows.map((c) => `${c?.before} → ${c?.after}`).join('; '));
const pv = await api('GET', O(`/studio/website/preview/change-sets/${csId}`), { token: tok });
check('Preview diff: one added section, three repriced dishes', pv.status === 200 && pv.body?.diff?.added?.length === 1 && [...(pv.body?.diff?.repriced ?? [])].sort().join() === [...ids].sort().join(),
  pv.status === 200 ? `added ${pv.body.diff.added.length}, repriced ${pv.body.diff.repriced.length}` : brief(pv));
view = await menuView();
check('Nothing changed before approval (prices as before)', dishes.every((d) => view?.products?.find((p) => p.id === d.id)?.priceMinor === d.original));
const waiting = await mcp.call('get_approval_status', { approvalId: csId });
check('MCP get_approval_status: pending', waiting.out?.status === 'pending' && waiting.out?.changeSetStatus === 'pending_approval', `${waiting.out?.status}/${waiting.out?.changeSetStatus}`);

// --- 6. the owner approves (MFA step-up when the owner has a factor) -------------------------------------------------
const approved = await sensitive((t) => api('POST', O(`/change-sets/${csId}/approve`), { token: t, body: { note: `${MARK} ${run}`, previewDigest: cs.body?.previewDigest } }));
if (approved.blocked) {
  blocked('Owner approves the change set', approved.blocked);
  note(`change set ${csId} stays pending and expires by itself (24 h); nothing was applied`);
  await cleanup();
  done();
}
check('Owner approves through the staff API → applied', approved.r.status === 200 && approved.r.body?.status === 'applied', `${brief(approved.r)} ${approved.r.body?.status ?? ''}`);
const trail = await api('GET', O(`/change-sets/${csId}/audit?limit=100`), { token: tok });
const decidedAal = (trail.body?.items ?? []).find((x) => x.action === 'change_set.approved')?.metadata?.aal ?? approved.aal;
if (decidedAal === 'aal2') note('approval ran on an MFA-verified session (aal2)');
else note(`approval ran on a password session (${decidedAal}): the owner account has no verified MFA factor, so the API did not require a step-up (MFA is opt-in); not bypassed`);

// --- 7. applied: prices, was-prices, the draft section ---------------------------------------------------------------
view = await menuView();
const after = dishes.map((d) => view?.products?.find((p) => p.id === d.id));
check('Dishes at 15 % off with the original kept as the was-price', after.every((p, i) => p?.priceMinor === discountedPrice(dishes[i].original, BPS) && p?.compareAtMinor === dishes[i].original),
  after.map((p) => `${p?.priceMinor} (was ${p?.compareAtMinor})`).join('; '));
const draft1 = await mcp.call('get_website_draft', {});
const section = draft1.out?.sections?.find((s) => s.kind === 'offers' && s.headline === HEADLINE);
check('Website draft has the Eid offers section with the three dishes (not yet published)', !!section && [...section.productIds].sort().join() === [...ids].sort().join() && draft1.out.publishedRevision === publishedBefore,
  section ? `section ${section.id.slice(0, 8)}…, published still ${draft1.out.publishedRevision}` : 'no section');
const status = await mcp.call('get_approval_status', { approvalId: csId });
check('MCP get_approval_status: executed / applied', status.out?.status === 'executed' && status.out?.changeSetStatus === 'applied', `${status.out?.status}/${status.out?.changeSetStatus}`);

// --- 8. publish a revision through MCP ------------------------------------------------------------------------------
let pub = await mcp.call('publish_website_revision', { note: `${HEADLINE} (${MARK})`, idempotencyKey: `stg-eid-pub-${run}` });
if (pub.out?.status === 'approval_required' && pub.out.changeSetId) {
  const ap = await sensitive((t) => api('POST', O(`/change-sets/${pub.out.changeSetId}/approve`), { token: t, body: { note: MARK } }));
  note(`publishing needed approval on this tenant's policy: ${ap.blocked ?? `${brief(ap.r)} ${ap.r.body?.status ?? ''}`}`);
  pub = { ...pub, out: { ...pub.out, status: ap.r?.body?.status ?? pub.out.status, ops: ap.r?.body?.ops ?? pub.out.ops } };
}
const revision = pub.out?.ops?.[0]?.result?.revision;
check('MCP publishes a new website revision', pub.out?.status === 'applied' && revision === publishedBefore + 1, `${pub.out?.status ?? pub.text.slice(0, 100)}, revision ${revision}`);

// --- 9. the public site shows it -----------------------------------------------------------------------------------
const site = await api('GET', `/public/sites/${tenant.slug}`);
const live = site.body?.sections?.find((s) => s.kind === 'offers' && (s.content?.headline?.en ?? s.content?.headline) === HEADLINE);
check('Public site JSON shows the Eid offers section', site.status === 200 && !!live, `HTTP ${site.status}, revision ${site.body?.revision ?? '?'}`);
check('Public site response carries no tokens or secrets', site.status === 200 && leaks(site.text).length === 0, leaks(site.text).join(', '));
if (WEB) {
  const page = await req('GET', `${WEB}/r/${tenant.slug}`, { headers: webHeaders });
  if ([401, 403].includes(page.status) || (page.status === 302 && !env.VERCEL_BYPASS)) blocked('Public site page renders the section', `web answered HTTP ${page.status} (Vercel Authentication; set VERCEL_BYPASS)`);
  else check('Public site page (/r/<slug>) renders the Eid offers section', page.status === 200 && visibleHtml(page.text).includes(HEADLINE), `HTTP ${page.status}`);
}

// --- 10. audit ------------------------------------------------------------------------------------------------------
const actions = (trail.body?.items ?? []).map((x) => x.action);
const missing = missingInOrder(actions, ['change_set.draft', 'change_op.proposed', 'change_op.proposed', 'change_op.proposed', 'change_op.proposed', 'change_set.validated',
  'change_set.pending_approval', 'change_set.approved', 'change_set.applying', 'change_op.applied', 'change_op.applied', 'change_op.applied', 'change_op.applied', 'change_set.applied']);
check('Audit trail: every transition and op of the change set', trail.status === 200 && missing.length === 0, missing.length ? `missing ${missing.join(', ')}` : `${actions.length} rows`);
const calls = await api('GET', O(`/mcp/calls?clientId=${clientId}&changeSetId=${csId}`), { token: tok });
const outcomes = (calls.body?.items ?? []).map((c) => `${c.tool}:${c.outcome}:${c.via}`);
check('MCP call log links the proposal and its approved execution to the change set',
  outcomes.includes('propose_changes:approval_required:mcp') && outcomes.includes('propose_changes:ok:approval'), outcomes.join(', '));

await cleanup(true);
done();

// --- 11. cleanup (also after an early stop) ---------------------------------------------------------------------------
async function cleanup(verify = false) {
  const closed = await mcp?.close?.();
  if (clientId) {
    const rv = await api('POST', O(`/mcp/clients/${clientId}/revoke`), { token: tok });
    const again = mcpClient(`${MCP_BASE}/mcp`, key);
    const refused = await again.initialize();
    check('Cleanup: MCP key revoked and refused afterwards', rv.status < 300 && (refused.status === 401 || !!refused.body?.error), `revoke ${brief(rv)}, then HTTP ${refused.status}; session close HTTP ${closed}`);
  }
  if (!verify) return;
  const removed = await removeSections(`stg-eid-cleanup-${run}`);
  const site2 = await api('GET', `/public/sites/${tenant.slug}`);
  check('Cleanup: Eid section removed and the site republished', removed === 1 && !site2.body?.sections?.some((s) => s.kind === 'offers' && (s.content?.headline?.en ?? s.content?.headline) === HEADLINE),
    `${removed} section(s) removed, public revision ${site2.body?.revision ?? '?'}`);
  const e = await endDiscounts(ids, 'Staging check: end Eid discounts');
  if (e.blocked) { blocked('Cleanup: discounts ended', e.blocked); return; }
  view = await menuView();
  check('Cleanup: discounts ended through a second change set (original prices back)', e.ok && dishes.every((d) => {
    const p = view?.products?.find((x) => x.id === d.id);
    return p?.priceMinor === d.original && p?.compareAtMinor === null;
  }), e.detail);
}
