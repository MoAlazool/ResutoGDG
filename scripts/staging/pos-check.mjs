#!/usr/bin/env node
// POS device API 0.2.0 end to end against the DEPLOYED services, with a simulated iPad (a scripted HTTP client, like
// tests/e2e/pos-ipad.spec.ts), on a DEDICATED test tenant (stg-check-pos-…, a paid trial; never the demo restaurant).
// Contract: docs/api/IPAD_INTEGRATION.md §4–§5 and §8, docs/api/IPAD_COMPATIBILITY.md.
//
//   owner pairs a staff-only waiter iPad for branch A → the rpos_ credential works (session) → without a staff session
//   every other route is 401 pos_staff_required → the waiter signs in on it (X-Resuto-Staff-Authorization) and gets
//   waiter ∩ waiter permissions → menu / floor / orders sync with cursors → quote, submit with a clientOrderId (201),
//   replay (same order, Idempotent-Replayed), changed body (409 client_order_id_reused), by-client-id → the event feed
//   (seq +1, no gaps) → a kitchen iPad: the waiter there gets waiter ∩ kitchen (cannot submit, 403) → the kitchen
//   bumps from the staff API → the device long-poll gets ticket.status_changed, the orders delta shows it → offline:
//   another bump, then resume from the last seq; a foreign epoch is 409 resync_required → a price change while the
//   device was offline is 409 pos_price_changed and creates nothing; the reviewed resubmit is 201 → stale version 409,
//   cash payment with a clientPaymentId (replay = same payment, payment.captured) → a branch-B device cannot see
//   branch A's order (404) and the A-scoped waiter on it is 403 pos_staff_not_allowed → revoke → 401 device_revoked →
//   cleanup.
//
// Staging (Supabase Auth):
//   API_URL=https://… SUPABASE_URL=https://<ref>.supabase.co SUPABASE_PUBLISHABLE_KEY=sb_publishable_… \
//   STAGING_CHECK_EMAIL=… STAGING_CHECK_PASSWORD=… STAGING_CHECK_STAFF_EMAIL=… STAGING_CHECK_STAFF_PASSWORD=… \
//   [STAGING_CHECK_TOTP_SECRET=…] [SUPABASE_SERVICE_ROLE_KEY=…] node scripts/staging/pos-check.mjs
// Local stack: AUTH_MODE=local API_URL=http://127.0.0.1:4681 node scripts/staging/pos-check.mjs (accounts made on first use)
//
// Optional: POS_TENANT_PREFIX (stg-check-pos), POS_PLAN (pro), EXPECT_COMMIT, SMOKE_REPORT=<file>. Exit 0 passed,
// 1 failed, 3 blocked. Never prints passwords, JWTs or the rpos_ credentials.
import { randomUUID } from 'node:crypto';
import { applyFeedPage, brief, createReport, errCode, isError, leaks, makeAuth, req, targetProblem, throwawayId } from './lib/check-kit.mjs';

const env = process.env;
const LOCAL = env.AUTH_MODE === 'local';
const need = ['API_URL', ...(LOCAL ? [] : ['SUPABASE_URL', 'SUPABASE_PUBLISHABLE_KEY', 'STAGING_CHECK_EMAIL', 'STAGING_CHECK_PASSWORD', 'STAGING_CHECK_STAFF_EMAIL', 'STAGING_CHECK_STAFF_PASSWORD'])];
for (const k of need) if (!env[k]) { console.error(`missing ${k}`); process.exit(2); }
{ const p = targetProblem(env.API_URL, env.ALLOW_NON_STAGING === '1'); if (p) { console.error(`refusing to run: ${p}`); process.exit(2); } }

const API = `${env.API_URL.replace(/\/$/, '')}/v1`;
const PREFIX = env.POS_TENANT_PREFIX ?? 'stg-check-pos';
const PLAN = env.POS_PLAN ?? 'pro';
const OWNER = { email: env.STAGING_CHECK_EMAIL ?? 'stg-check-pos-owner@example.test', password: env.STAGING_CHECK_PASSWORD ?? 'Local-check-password-1' };
const STAFF = { email: env.STAGING_CHECK_STAFF_EMAIL ?? 'stg-check-pos-waiter@example.test', password: env.STAGING_CHECK_STAFF_PASSWORD ?? 'Local-check-password-2' };
const STAFF_HEADER = 'X-Resuto-Staff-Authorization';
const CATEGORY = 'POS check (test data)';
const DISHES = { burger: ['POS check: burger (test)', 18500], fries: ['POS check: fries (test)', 4500] };
const BRANCH_B = 'POS check branch B (test)';
const MARK = 'staging POS check (test)';
const run = Date.now().toString(36);

const R = createReport(`POS device API check (${LOCAL ? 'local stack, development issuer' : 'staging, Supabase Auth'}) — run ${run}`);
const { check, blocked, note } = R;
const auth = makeAuth(env, API);
const api = (method, p, opts) => req(method, API + p, opts);
const done = () => R.finish(env, { tenant: tenant?.slug ?? null, run });
let tenant = null;

// --- 0. API up ------------------------------------------------------------------------------------------------------
const health = await api('GET', '/health');
R.recordBuild('api', health);
if (!check('API health', health.status === 200 && health.body?.status === 'ok', `HTTP ${health.status}`)) done();

// --- 1. accounts: the dedicated owner and a dedicated waiter ------------------------------------------------------
async function account({ email, password }, fullName) {
  const s = await auth.signIn(email, password);
  if (s) return { s, how: 'signed in' };
  if (!LOCAL && !auth.hasAdmin) return { s: null, how: 'cannot sign in (create it once: Supabase → Authentication → Add user, auto-confirm; or set SUPABASE_SERVICE_ROLE_KEY)' };
  const u = await auth.signUp(email, password, fullName);
  return { s: u.session, how: u.session ? `created (${u.via})` : `could not be created: ${u.error}` };
}
const o = await account(OWNER, 'Staging check owner (test)');
if (!check('Dedicated staging-check owner signs in', !!o.s, `${o.how}${o.s ? `, ${o.s.aal}` : ''}`)) done();
const w = await account(STAFF, 'Staging check waiter (test)');
if (!check('Dedicated staging-check waiter account signs in', !!w.s, w.how)) done();
const owner = o.s;
const waiterTok = w.s.accessToken;
const tok = owner.accessToken;
let stepped = null;
async function sensitive(call) {
  let r = await call(stepped?.accessToken ?? tok);
  if (r.status === 403 && errCode(r) === 'mfa_required' && !stepped) {
    stepped = await auth.stepUp(owner, env.STAGING_CHECK_TOTP_SECRET);
    if (!stepped) return { r, blocked: 'the owner has a verified authenticator and this needs aal2: set STAGING_CHECK_TOTP_SECRET; the step-up is never bypassed' };
    r = await call(stepped.accessToken);
  }
  return { r };
}

// --- 2. the dedicated tenant (reused while its paid trial is live) -------------------------------------------------
const me = await api('GET', '/me', { token: tok });
for (const m of (me.body?.memberships ?? []).filter((x) => x.role === 'owner' && x.orgSlug?.startsWith(`${PREFIX}-`)).sort((a, b) => b.orgSlug.localeCompare(a.orgSlug))) {
  const s = await api('GET', `/o/${m.orgId}/setup`, { token: tok });
  if (s.status === 200 && s.body?.planId && s.body.planId !== 'free') { tenant = { id: m.orgId, slug: m.orgSlug, reused: true }; break; }
  note(`tenant ${m.orgSlug} is on ${s.body?.planId ?? 'unknown'} now (trial lapsed): not reused, left as is`);
}
if (!tenant) {
  const slug = throwawayId(PREFIX);
  const c = await api('POST', '/orgs', { token: tok, body: { name: 'Staging check: POS (test data)', slug, country: 'EG', planId: PLAN, branch: { name: 'POS check branch A (test)' } } });
  if (c.status !== 201) { check('Dedicated test tenant ready', false, `create: ${brief(c)}`); done(); }
  tenant = { id: c.body.id, slug, reused: false };
}
const O = (p) => `/o/${tenant.id}${p}`;
let org = (await api('GET', O(''), { token: tok })).body;
const branchA = org?.branches?.find((b) => b.name !== BRANCH_B && b.isActive)?.id;
let branchB = org?.branches?.find((b) => b.name === BRANCH_B)?.id;
if (!branchB) branchB = (await api('POST', O('/branches'), { token: tok, body: { name: BRANCH_B } })).body?.id;
check('Dedicated test tenant ready with two branches (never the demo restaurant)', !!branchA && !!branchB && tenant.slug.startsWith(`${PREFIX}-`),
  `${tenant.reused ? 'reused' : 'created'} /${tenant.slug} on ${PLAN === 'pro' ? 'a paid trial' : PLAN}`);
if (!branchA || !branchB) done();

// Menu (two dishes), one table on branch A's floor, the waiter scoped to branch A.
const menuView = async () => (await api('GET', O('/menu'), { token: tok })).body;
let view = await menuView();
let cat = view?.categories?.find((x) => x.name === CATEGORY) ?? (await api('POST', O('/menu/categories'), { token: tok, body: { name: CATEGORY } })).body;
for (const [name, price] of Object.values(DISHES)) {
  if (!view?.products?.some((p) => p.name === name && p.isActive)) await api('POST', O('/menu/products'), { token: tok, body: { categoryId: cat?.id, name, priceMinor: price } });
}
view = await menuView();
const product = Object.fromEntries(Object.entries(DISHES).map(([k, [name]]) => [k, view?.products?.find((p) => p.name === name && p.isActive)?.id]));
// A branch price left by an interrupted run is removed first.
await api('PUT', O(`/menu/products/${product.fries}/branches/${branchA}`), { token: tok, body: { priceOverrideMinor: null } });
const floor = await api('GET', O(`/floor/${branchA}`), { token: tok });
if (floor.status === 200 && !(floor.body?.tables ?? []).length) {
  await api('PUT', O(`/floor/${branchA}`), { token: tok, body: { baseRevision: floor.body.revision, key: `stg-pos-floor-${run}`, layout: {
    width: floor.body.width, height: floor.body.height, background: floor.body.background,
    zones: [{ id: 'z-main', type: 'zone', label: 'Main Room', x: 600, y: 300, width: 1080, height: 470, rotation: 0, color: '#e9e6dc' }], objects: [],
    tables: [{ label: 'T1', capacity: 4, zone: 'Main Room', shape: 'square', cx: 250, cy: 220, width: 100, height: 100, rotation: 0, reservable: false }],
  } } });
}
const members = (await api('GET', O('/members'), { token: tok })).body;
const staffId = (await api('GET', '/me', { token: waiterTok })).body?.user?.id;
let membership = members?.members?.find((m) => m.userId === staffId && m.status === 'active');
if (!membership) {
  const inv = await sensitive((t) => api('POST', O('/invitations'), { token: t, body: { email: STAFF.email, role: 'waiter', branchIds: [branchA] } }));
  if (inv.blocked) { blocked('Waiter member scoped to branch A', inv.blocked); done(); }
  await api('POST', '/invitations/accept', { token: waiterTok, body: { token: inv.r.body?.token } });
} else if (membership.role !== 'waiter' || JSON.stringify(membership.branchIds) !== JSON.stringify([branchA])) {
  const up = await sensitive((t) => api('PATCH', O(`/members/${membership.id}`), { token: t, body: { role: 'waiter', branchIds: [branchA] } }));
  if (up.blocked) { blocked('Waiter member scoped to branch A', up.blocked); done(); }
}
membership = (await api('GET', O('/members'), { token: tok })).body?.members?.find((m) => m.userId === staffId && m.status === 'active');
check('Test fixtures: two labelled dishes, a table, the waiter scoped to branch A', !!product.burger && !!product.fries && membership?.role === 'waiter' && membership?.branchIds?.[0] === branchA,
  `${Object.values(DISHES).map(([n]) => n).join(', ')}; waiter ${membership?.role ?? 'missing'}`);
if (!product.burger || membership?.role !== 'waiter') done();

// --- 3. pairing --------------------------------------------------------------------------------------------------------
const devices = [];
let ipad = null;
let waiter = null;
let first = null;
async function pair(branchId, actingRole, name, requireStaff = false) {
  const code = await sensitive((t) => api('POST', O('/pos/pairings'), { token: t, body: { branchId, actingRole, name: `${name} ${run}`, requireStaff } }));
  if (code.blocked) return { blocked: code.blocked };
  const p = await api('POST', '/pos/pair', { body: { code: code.r.body?.code, platform: 'ipados', appVersion: 'staging-check', model: 'simulated' } });
  if (p.status !== 201) return { error: `pairing code ${brief(code.r)}, pair ${brief(p)}` };
  devices.push(p.body.device.id);
  return { device: device(p.body.token, p.body.device.id, branchId), body: p.body };
}
function device(token, id, branchId, staff = null) {
  const headers = (extra = {}) => ({ Authorization: `Bearer ${token}`, ...(staff ? { [STAFF_HEADER]: `Bearer ${staff}` } : {}), ...extra });
  return {
    id, branchId, feed: { epoch: null, lastSeq: 0 }, ordersCursor: null,
    as(staffToken) { return device(token, id, branchId, staffToken); },
    get: (p, timeoutMs) => req('GET', `${API}/pos${p}`, { headers: headers(), timeoutMs }),
    post: (p, body = {}) => req('POST', `${API}/pos${p}`, { headers: headers(), body }),
  };
}
const p1 = await pair(branchA, 'waiter', 'Staging check waiter iPad', true);
if (p1.blocked) { blocked('Owner pairs a staff-only waiter iPad for branch A', p1.blocked); done(); }
if (!check('Owner pairs a staff-only waiter iPad for branch A (one-time code → rpos_ credential)', !!p1.device && /^rpos_[A-Za-z0-9_-]{43}$/.test(p1.body.token)
  && p1.body.contractVersion === '0.2.0' && p1.body.device.requireStaff === true, p1.error ?? `contract ${p1.body?.contractVersion}, device ${p1.body?.device?.actingRole}@A`)) { await cleanup(); done(); }
ipad = p1.device;
waiter = ipad.as(waiterTok);
const bare = await ipad.get('/session');
check('Device credential works: GET /v1/pos/session (no staff yet)', bare.status === 200 && bare.body?.device?.id === ipad.id && bare.body?.branch?.id === branchA && bare.body?.requireStaff === true && bare.body?.staff === null,
  `${brief(bare)}, feed head ${bare.body?.feed?.head}`);
// The session shows the credential's prefix (tokenPrefix) by design; the credential itself must never come back.
const sessionLeaks = leaks(bare.text.replace(/"tokenPrefix":"rpos_[A-Za-z0-9_-]{1,12}"/, '"tokenPrefix":"…"'));
check('Session carries no credential (only its prefix) and no secrets', !bare.text.includes(p1.body.token) && sessionLeaks.length === 0, sessionLeaks.join(', '));
const noStaff = await ipad.get('/sync/menu');
check('Staff-only device without X-Resuto-Staff-Authorization → 401 pos_staff_required', isError(noStaff, 401, 'pos_staff_required'), brief(noStaff));
const junk = await ipad.as('not-a-jwt').get('/session');
check('A malformed staff header → 401 unauthorized', isError(junk, 401, 'unauthorized'), brief(junk));
const onStaffRoute = await api('GET', O(''), { token: p1.body.token });
check('The device credential is refused on staff routes (403 pos_device_only)', isError(onStaffRoute, 403, 'pos_device_only'), brief(onStaffRoute));
const signed = await waiter.get('/session');
const perms = signed.body?.permissions ?? [];
check('Waiter signs in on the iPad: staff on the session, waiter ∩ waiter permissions', signed.status === 200 && signed.body?.staff?.id === staffId && signed.body?.staff?.role === 'waiter'
  && perms.includes('orders:write') && perms.includes('payments:collect') && !perms.includes('orders:cancel'), `${perms.length} permissions`);
waiter.feed = { epoch: signed.body?.feed?.epoch ?? null, lastSeq: signed.body?.feed?.head ?? 0 };

// --- 4. sync with cursors -----------------------------------------------------------------------------------------------
const menu = await waiter.get('/sync/menu');
const items = new Map((menu.body?.categories ?? []).flatMap((c) => c.products).map((p) => [p.id, p]));
const again = menu.body?.cursor ? await waiter.get(`/sync/menu?since=${encodeURIComponent(menu.body.cursor)}`) : null;
check('Menu sync: branch prices, then unchanged: true from the cursor', menu.status === 200 && items.get(product.burger)?.priceMinor === DISHES.burger[1] && again?.body?.unchanged === true,
  `${items.size} product(s), cursor reused → unchanged ${again?.body?.unchanged}`);
const fl = await waiter.get('/sync/floor');
const fl2 = fl.body?.cursor ? await waiter.get(`/sync/floor?since=${encodeURIComponent(fl.body.cursor)}`) : null;
check('Floor sync: the table, then unchanged: true from the cursor', fl.status === 200 && (fl.body?.tables ?? []).some((t) => t.label === 'T1') && fl2?.body?.unchanged === true,
  `${fl.body?.tables?.length ?? 0} table(s)`);
const os = await waiter.get('/sync/orders');
waiter.ordersCursor = os.body?.cursor;
check('Orders sync: full snapshot with a cursor', os.status === 200 && os.body?.mode === 'full' && !!os.body?.cursor, `${os.body?.orders?.length ?? 0} open order(s)`);

// --- 5. quote, submit, replay, reconcile --------------------------------------------------------------------------------
const lines = [{ productId: product.burger, quantity: 1 }, { productId: product.fries, quantity: 2, notes: MARK }];
const quote = await waiter.post('/orders/quote', { fulfillment: 'pickup', lines });
check('Quote: server totals per line', quote.status === 200 && quote.body?.lines?.map((l) => l.lineTotalMinor).join() === `${DISHES.burger[1]},${DISHES.fries[1] * 2}`, `total ${quote.body?.totalMinor}`);
const firstBody = { clientOrderId: randomUUID(), fulfillment: 'pickup', customer: { name: MARK }, notes: MARK, repricing: 'reject',
  lines: lines.map((l, i) => ({ ...l, expectedLineTotalMinor: quote.body?.lines?.[i]?.lineTotalMinor })), expectedTotalMinor: quote.body?.totalMinor, takenAt: new Date().toISOString() };
const sub = await waiter.post('/orders', firstBody);
first = sub.body;
const orders = [];
if (first?.order?.id) orders.push(first.order.id);
check('Submit with a clientOrderId → 201, channel pos, placed', sub.status === 201 && first?.order?.channel === 'pos' && first.order.status === 'placed' && first.order.totalMinor === quote.body?.totalMinor && !sub.headers.get('idempotent-replayed'),
  `${brief(sub)} #${first?.order?.number ?? '?'}`);
if (!first?.order?.id) { await cleanup(); done(); }
const replay = await waiter.post('/orders', firstBody);
check('Replay of the same clientOrderId → the same order, Idempotent-Replayed: true', replay.status === 201 && replay.body?.order?.id === first.order.id && replay.headers.get('idempotent-replayed') === 'true', brief(replay));
const reused = await waiter.post('/orders', { ...firstBody, lines: [{ productId: product.fries, quantity: 3 }], expectedTotalMinor: undefined });
check('Same clientOrderId with another body → 409 client_order_id_reused', isError(reused, 409, 'client_order_id_reused'), brief(reused));
const byId = await waiter.get(`/orders/by-client-id/${firstBody.clientOrderId}`);
const never = await waiter.get(`/orders/by-client-id/${randomUUID()}`);
check('GET /v1/pos/orders/by-client-id: accepted with the original response; an unknown id → 404', byId.body?.state === 'accepted' && byId.body?.orderId === first.order.id && isError(never, 404, 'not_found'),
  `${byId.body?.state}, unknown ${brief(never)}`);

// --- 6. the event feed --------------------------------------------------------------------------------------------------
async function follow(dev) {
  const fresh = [];
  for (let i = 0; i < 20; i++) {
    const r = await dev.get(`/events?after=${dev.feed.lastSeq}${dev.feed.epoch ? `&epoch=${dev.feed.epoch}` : ''}`);
    if (r.status !== 200) return { fresh, problem: brief(r) };
    const a = applyFeedPage(dev.feed, r.body);
    dev.feed = a.state;
    fresh.push(...a.fresh);
    if (a.problem) return { fresh, problem: a.problem };
    if (!r.body.hasMore) return { fresh, problem: null };
  }
  return { fresh, problem: 'the feed did not drain' };
}
const f1 = await follow(waiter);
check('Event feed: order.created for the order, seq +1 with no gaps', !f1.problem && f1.fresh.some((e) => e.kind === 'order.created' && e.payload?.orderId === first.order.id),
  f1.problem ?? `${f1.fresh.length} event(s), last seq ${waiter.feed.lastSeq}: ${[...new Set(f1.fresh.map((e) => e.kind))].join(', ')}`);

// --- 7. permissions = staff role ∩ device role ----------------------------------------------------------------------
const p2 = await pair(branchA, 'kitchen', 'Staging check kitchen iPad');
const kds = p2.device;
if (kds) {
  const wk = kds.as(waiterTok);
  const ks = await wk.get('/session');
  const kperms = ks.body?.permissions ?? [];
  const ksub = await wk.post('/orders', { ...firstBody, clientOrderId: randomUUID() });
  check('Waiter on a kitchen iPad: waiter ∩ kitchen (no orders:write), submit → 403', ks.status === 200 && !kperms.includes('orders:write') && !kperms.includes('payments:collect') && isError(ksub, 403, 'forbidden'),
    `permissions ${kperms.join(',')}; submit ${brief(ksub)}`);
} else check('Kitchen iPad paired', false, p2.blocked ?? p2.error);

// --- 8. kitchen change from the staff API reaches the device -------------------------------------------------------
const before = waiter.feed.lastSeq;
const poll = waiter.get(`/events?after=${before}&epoch=${waiter.feed.epoch}&wait=10`, 30_000);
await new Promise((r) => setTimeout(r, 500));
const cur = await waiter.get(`/orders/${first.order.id}`);
const bump = await api('POST', O(`/kitchen/orders/${first.order.id}/bump`), { token: tok, body: { to: 'preparing', version: cur.body?.version } });
const woke = await poll;
const a1 = applyFeedPage(waiter.feed, woke.body);
waiter.feed = a1.state;
const f2 = await follow(waiter);
const changed = [...a1.fresh, ...f2.fresh].find((e) => e.kind === 'ticket.status_changed' && e.payload?.orderId === first.order.id);
check('Staff-API kitchen bump → the device long-poll delivers ticket.status_changed', bump.status < 300 && woke.status === 200 && !a1.problem && !f2.problem && changed?.payload?.to === 'preparing',
  `bump ${brief(bump)}, long-poll ${woke.body?.events?.length ?? 0} event(s), ${changed ? `${changed.payload.from} → ${changed.payload.to}` : 'no ticket event'}`);
const delta = await waiter.get(`/sync/orders?cursor=${encodeURIComponent(waiter.ordersCursor ?? '')}`);
const mine = delta.body?.orders?.find((x) => x.id === first.order.id);
check('Orders delta from the cursor shows the new status', delta.body?.mode === 'delta' && mine?.status === 'preparing', `${delta.body?.mode}, ${mine?.status}`);
waiter.ordersCursor = delta.body?.cursor ?? waiter.ordersCursor;

// Offline, the kitchen marks it ready; the device resumes from its last seq.
const offlineAt = waiter.feed.lastSeq;
const cur2 = await waiter.get(`/orders/${first.order.id}`);
await api('POST', O(`/kitchen/orders/${first.order.id}/bump`), { token: tok, body: { to: 'ready', version: cur2.body?.version } });
const resumed = await waiter.get(`/events?after=${offlineAt}&epoch=${waiter.feed.epoch}`);
const a2 = applyFeedPage(waiter.feed, resumed.body);
waiter.feed = a2.state;
await follow(waiter);
check('Reconnect resumes from the last seq (first event = last seq + 1, ticket → ready)', resumed.body?.events?.[0]?.seq === offlineAt + 1 && !a2.problem && a2.fresh.some((e) => e.kind === 'ticket.status_changed' && e.payload?.to === 'ready'),
  `resumed at seq ${resumed.body?.events?.[0]?.seq} after ${offlineAt}`);
const dup = await waiter.get(`/events?after=${offlineAt}&epoch=${waiter.feed.epoch}`);
check('At-least-once: re-reading applies nothing twice', applyFeedPage(waiter.feed, dup.body).fresh.length === 0, `${dup.body?.events?.length ?? 0} re-delivered`);
const foreign = await waiter.get(`/events?after=${waiter.feed.lastSeq}&epoch=${randomUUID()}`);
check('A foreign epoch → 409 resync_required with epoch and head', isError(foreign, 409, 'resync_required') && foreign.body.error.details?.epoch === waiter.feed.epoch, `${brief(foreign)} ${foreign.body?.error?.details?.reason ?? ''}`);

// --- 9. stale price while offline ---------------------------------------------------------------------------------
const lines2 = [{ productId: product.fries, quantity: 1 }];
const shown = await waiter.post('/orders/quote', { fulfillment: 'pickup', lines: lines2 });
const queued = { clientOrderId: randomUUID(), fulfillment: 'pickup', customer: { name: MARK }, notes: MARK,
  lines: lines2.map((l, i) => ({ ...l, expectedLineTotalMinor: shown.body?.lines?.[i]?.lineTotalMinor })), expectedTotalMinor: shown.body?.totalMinor };
const override = await api('PUT', O(`/menu/products/${product.fries}/branches/${branchA}`), { token: tok, body: { priceOverrideMinor: 5000 } });
const conflict = await waiter.post('/orders', queued);
const cl = conflict.body?.error?.details?.lines?.[0];
const notCreated = await waiter.get(`/orders/by-client-id/${queued.clientOrderId}`);
check('Price changed while offline → 409 pos_price_changed with per-line details; nothing created', override.status === 200 && isError(conflict, 409, 'pos_price_changed')
  && cl?.expectedLineTotalMinor === DISHES.fries[1] && cl?.currentUnitPriceMinor === 5000 && isError(notCreated, 404, 'not_found'),
  `${brief(conflict)}: ${cl?.expectedLineTotalMinor} → ${cl?.currentLineTotalMinor}; by-client-id ${brief(notCreated)}`);
const reviewed = await waiter.post('/orders/quote', { fulfillment: 'pickup', lines: lines2 });
const resub = await waiter.post('/orders', { ...queued, lines: lines2.map((l, i) => ({ ...l, expectedLineTotalMinor: reviewed.body?.lines?.[i]?.lineTotalMinor })), expectedTotalMinor: reviewed.body?.totalMinor });
if (resub.body?.order?.id) orders.push(resub.body.order.id);
check('Reviewed resubmit of the same clientOrderId → 201 at the new price', resub.status === 201 && resub.body?.order?.totalMinor === reviewed.body?.totalMinor, `${brief(resub)} total ${resub.body?.order?.totalMinor}`);
await api('PUT', O(`/menu/products/${product.fries}/branches/${branchA}`), { token: tok, body: { priceOverrideMinor: null } });

// --- 10. stale version, payment ---------------------------------------------------------------------------------------
const now = (await waiter.get(`/orders/${first.order.id}`)).body;
const stale = await waiter.post(`/orders/${first.order.id}/transition`, { to: 'picked_up', version: first.order.version });
check('A stale version → 409 stale_order with the current version', isError(stale, 409, 'stale_order') && stale.body.error.details?.version === now?.version, brief(stale));
const head = waiter.feed.lastSeq;
const clientPaymentId = randomUUID();
const paid = await waiter.post(`/orders/${first.order.id}/payments`, { clientPaymentId, method: 'cash', reference: MARK });
const paidAgain = await waiter.post(`/orders/${first.order.id}/payments`, { clientPaymentId, method: 'cash', reference: MARK });
check('Cash payment with a clientPaymentId → paid; the replay returns the same payment', paid.status === 201 && paid.body?.paymentStatus === 'paid' && paid.body?.dueMinor === 0 && paidAgain.body?.paymentId === paid.body?.paymentId,
  `${brief(paid)} ${paid.body?.amountMinor ?? ''}, replay ${brief(paidAgain)}`);
const f3 = await follow(waiter);
check('Feed: payment.captured for the order', !f3.problem && f3.fresh.some((e) => e.seq > head && e.kind === 'payment.captured' && e.payload?.orderId === first.order.id), f3.problem ?? `${f3.fresh.length} event(s)`);

// --- 11. branch B device and staff scope ---------------------------------------------------------------------------
const p3 = await pair(branchB, 'cashier', 'Staging check branch B till');
if (p3.device) {
  const till = p3.device;
  const r1 = await till.get(`/orders/${first.order.id}`);
  const r2 = await till.post(`/orders/${first.order.id}/payments`, { clientPaymentId: randomUUID(), method: 'cash' });
  const r3 = await till.get(`/orders/by-client-id/${firstBody.clientOrderId}`);
  check('A branch-B device cannot read, pay or reconcile a branch-A order (404)', [r1, r2, r3].every((r) => isError(r, 404, 'not_found')), [r1, r2, r3].map(brief).join(', '));
  const scoped = await till.as(waiterTok).get('/session');
  check('The branch-A waiter on the branch-B device → 403 pos_staff_not_allowed', isError(scoped, 403, 'pos_staff_not_allowed') && !JSON.stringify(scoped.body).includes(branchA), brief(scoped));
} else check('Branch-B device paired', false, p3.blocked ?? p3.error);

// --- 12. revoke, then cleanup --------------------------------------------------------------------------------------
await cleanup(true);
done();

async function cleanup(full = false) {
  if (full && first?.order?.id) {
    const cur3 = (await waiter.get(`/orders/${first.order.id}`)).body;
    const closed = await waiter.post(`/orders/${first.order.id}/transition`, { to: 'picked_up', version: cur3?.version });
    const finished = (await waiter.get(`/orders/${first.order.id}`)).body;
    check('Cleanup: the paid test order is handed over (picked_up, no longer open)', closed.status === 200 && finished?.status === 'picked_up' && finished?.open === false,
      `${brief(closed)} ${finished?.status ?? ''}, open ${finished?.open}`);
    const extra = orders.filter((id) => id !== first.order.id);
    const cancelled = [];
    for (const id of extra) cancelled.push(await api('POST', O(`/orders/${id}/cancel`), { token: tok, body: { reason: `${MARK} cleanup` } }));
    check('Cleanup: the unpaid test order is cancelled (staff route)', cancelled.every((r) => r.status === 200 && r.body?.status === 'cancelled'), cancelled.map((r) => `${brief(r)} ${r.body?.status ?? ''}`).join(', ') || 'none');
  }
  const results = [];
  for (const id of devices) results.push(await api('POST', O(`/pos/devices/${id}/revoke`), { token: tok, body: { reason: `${MARK} cleanup` } }));
  if (ipad) {
    const after = await ipad.as(waiterTok).get('/session');
    check('Revoked devices are refused at once (401 device_revoked)', results.every((r) => r.status === 200) && isError(after, 401, 'device_revoked'),
      `${results.length} device(s) revoked, then ${brief(after)}`);
  }
}
