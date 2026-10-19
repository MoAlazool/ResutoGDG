#!/usr/bin/env node
// Staging smoke test against the DEPLOYED services (no mocks): Render API, AI and MCP,
// Supabase Auth, and the private Vercel web app. Read-mostly; the few writes it makes
// (a payment link paid through the simulated provider, a refused MCP call) are labelled demo data.
//
//   API_URL=https://… WEB_URL=https://… MCP_URL=https://… AI_URL=https://… \
//   SUPABASE_URL=https://<ref>.supabase.co SUPABASE_PUBLISHABLE_KEY=sb_publishable_… \
//   DEMO_OWNER_PASSWORD=… DEMO_STAFF_PASSWORD=… DEMO_ADMIN_PASSWORD=… node scripts/staging/smoke.mjs
//
// Optional: VERCEL_BYPASS (Protection Bypass for Automation secret) to check the web app behind
// Vercel Authentication. Exits non-zero when any check fails. Never prints secrets.
const env = process.env;
for (const k of ['API_URL', 'SUPABASE_URL', 'SUPABASE_PUBLISHABLE_KEY', 'DEMO_OWNER_PASSWORD', 'DEMO_STAFF_PASSWORD', 'DEMO_ADMIN_PASSWORD']) {
  if (!env[k]) { console.error(`missing ${k}`); process.exit(2); }
}
const API = `${env.API_URL.replace(/\/$/, '')}/v1`;
const SB = env.SUPABASE_URL.replace(/\/$/, '');
const DOMAIN = env.DEMO_EMAIL_DOMAIN ?? 'olive-room.demo.test';
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok }); console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`); };

async function req(method, url, { token, body, headers = {}, raw } = {}) {
  const res = await fetch(url, { method, redirect: 'manual', headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers }, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)) });
  const text = await res.text();
  let json = null; try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: res.status, body: json, text, headers: res.headers };
}
const api = (method, p, opts) => req(method, API + p, opts);
async function signIn(email, password) {
  const r = await req('POST', `${SB}/auth/v1/token?grant_type=password`, { headers: { apikey: env.SUPABASE_PUBLISHABLE_KEY }, body: { email, password } });
  return r.status === 200 ? r.body : null;
}
const SECRET_PATTERNS = [/sb_secret_/i, /service_role/i, /SUPABASE_SERVICE_ROLE_KEY/, /CREDENTIALS_KEYS/, /encrypted_password/, /postgres(ql)?:\/\//i, /"qrToken"|qr_token/];
const leaks = (text) => SECRET_PATTERNS.filter((p) => p.test(text)).map(String);

// --- 1. health ------------------------------------------------------------------------------------
const health = await api('GET', '/health');
check('API health (database reachable)', health.status === 200 && health.body?.status === 'ok', `db latency ${health.body?.db?.latencyMs ?? '?'} ms`);
if (env.AI_URL) {
  const ai = await req('GET', `${env.AI_URL.replace(/\/$/, '')}/v1/health`);
  check('AI service health (auth required)', ai.status === 200 && ai.body?.auth === true);
}
if (env.MCP_URL) {
  const m = await req('GET', `${env.MCP_URL.replace(/\/$/, '')}/health`);
  check('MCP server health', m.status === 200);
  const noKey = await req('POST', `${env.MCP_URL.replace(/\/$/, '')}/mcp`, { headers: { accept: 'application/json, text/event-stream' }, body: { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'smoke', version: '0' } } } });
  check('MCP server refuses a request without a client key', noKey.status === 401, `HTTP ${noKey.status}`);
}

// --- 2. real Supabase Auth --------------------------------------------------------------------------
const owner = await signIn(`owner@${DOMAIN}`, env.DEMO_OWNER_PASSWORD);
check('Supabase Auth: owner signs in with email/password', !!owner?.access_token);
const wrong = await signIn(`owner@${DOMAIN}`, 'not-the-password-123');
check('Supabase Auth: wrong password is refused', wrong === null);
if (!owner) { summary(); }
const header = JSON.parse(Buffer.from(owner.access_token.split('.')[0], 'base64url').toString());
const claims = JSON.parse(Buffer.from(owner.access_token.split('.')[1], 'base64url').toString());
check('Access token is asymmetric (JWKS) and issued by the staging project', ['ES256', 'RS256'].includes(header.alg) && claims.iss === `${SB}/auth/v1`, `${header.alg}, iss ${claims.iss}`);
const me = await api('GET', '/me', { token: owner.access_token });
check('API accepts the Supabase token (GET /me)', me.status === 200 && me.body?.memberships?.length >= 1);
const orgId = me.body?.memberships?.[0]?.orgId;
const refreshed = await req('POST', `${SB}/auth/v1/token?grant_type=refresh_token`, { headers: { apikey: env.SUPABASE_PUBLISHABLE_KEY }, body: { refresh_token: owner.refresh_token } });
check('Session refresh returns a new working token', refreshed.status === 200 && (await api('GET', '/me', { token: refreshed.body.access_token })).status === 200);
const tampered = owner.access_token.slice(0, -4) + (owner.access_token.endsWith('AAAA') ? 'BBBB' : 'AAAA');
check('Tampered token is rejected', (await api('GET', '/me', { token: tampered })).status === 401);
check('Missing token is rejected', (await api('GET', '/me')).status === 401);
check('Development login is disabled on staging', [404, 401].includes((await api('POST', '/auth/dev/login', { body: { email: `owner@${DOMAIN}`, password: env.DEMO_OWNER_PASSWORD } })).status));
const out = await req('POST', `${SB}/auth/v1/logout`, { token: refreshed.body.access_token, headers: { apikey: env.SUPABASE_PUBLISHABLE_KEY } });
check('Logout revokes the session (refresh token no longer works)', [204, 200].includes(out.status)
  && (await req('POST', `${SB}/auth/v1/token?grant_type=refresh_token`, { headers: { apikey: env.SUPABASE_PUBLISHABLE_KEY }, body: { refresh_token: refreshed.body.refresh_token } })).status >= 400);

// --- 3. authorization boundaries ------------------------------------------------------------------------
const O = (p) => `/o/${orgId}${p}`;
const tokenOf = async (local, pw = env.DEMO_STAFF_PASSWORD) => (await signIn(`${local}@${DOMAIN}`, pw))?.access_token;
const ownerTok = (await signIn(`owner@${DOMAIN}`, env.DEMO_OWNER_PASSWORD)).access_token;
const waiter = await tokenOf('waiter');
const kitchen = await tokenOf('kitchen');
const driver = await tokenOf('driver1');
const admin = await tokenOf('platform-admin', env.DEMO_ADMIN_PASSWORD);
check('Staff accounts sign in (waiter, kitchen, driver, platform admin)', !!(waiter && kitchen && driver && admin));
check('Unknown organization is invisible (404, not 403)', (await api('GET', '/o/00000000-0000-4000-8000-000000000000', { token: ownerTok })).status === 404);
check('Waiter cannot read finance (403)', (await api('GET', O('/finance/overview'), { token: waiter })).status === 403);
check('Waiter cannot read marketing (403)', (await api('GET', O('/marketing/campaigns'), { token: waiter })).status === 403);
check('Driver cannot read customers (403)', (await api('GET', O('/customers'), { token: driver })).status === 403);
const org = await api('GET', O(''), { token: ownerTok });
const other = org.body?.branches?.find((b) => b.code !== 'main');
check('Branch-scoped kitchen user cannot open another branch\'s KDS', other && [403, 404].includes((await api('GET', O(`/kitchen/${other.id}`), { token: kitchen })).status));
check('Owner cannot use the platform admin API (403)', (await api('GET', '/admin/tenants', { token: ownerTok })).status === 403);
check('Platform admin can list tenants', (await api('GET', '/admin/tenants', { token: admin })).status === 200);

// --- 4. public surface: no capability tokens or secrets ---------------------------------------------------------
const slug = org.body?.slug ?? 'the-olive-room';
const pub = [await api('GET', `/public/menu/${slug}`), await api('GET', `/public/order/${slug}`), await api('GET', `/public/sites/${slug}`), await api('GET', `/public/floor/${slug}/main`)];
check('Public menu, ordering, website and floor respond', pub.every((r) => r.status === 200), pub.map((r) => r.status).join(','));
check('Public responses carry no QR tokens or secrets', pub.every((r) => leaks(r.text).length === 0));
const staffViews = [org, await api('GET', O('/menu'), { token: ownerTok }), await api('GET', O('/integrations'), { token: ownerTok }), await api('GET', O('/mcp/clients'), { token: ownerTok })];
check('Staff responses carry no credentials or keys', staffViews.every((r) => leaks(r.text.replace(/"qrToken"|qr_token/g, '')).length === 0));

// --- 5. storage: signed media only ---------------------------------------------------------------------------------
const menuView = await api('GET', `/public/menu/${slug}`);
const img = menuView.body?.categories?.flatMap((c) => c.products).find((p) => p.imageUrl)?.imageUrl;
check('Menu photos are served from Supabase Storage via signed URLs', !!img && /\/storage\/v1\/object\/sign\//.test(img), img ? new URL(img).host : 'no image');
if (img) {
  check('Signed image URL loads', (await req('GET', img)).status === 200);
  const unsigned = img.replace('/object/sign/', '/object/').split('?')[0];
  check('The same object without a signature is refused (private bucket)', (await req('GET', unsigned)).status >= 400);
}

// --- 6. payment link → simulated checkout → server-side confirmation ---------------------------------------------------
const order = await api('POST', O('/orders'), { token: ownerTok, headers: { 'Idempotency-Key': `smoke-${Date.now()}` }, body: {
  branchId: org.body.branches.find((b) => b.code === 'main').id, fulfillment: 'pickup', customer: { name: 'Smoke test (demo)' },
  lines: [{ productId: menuView.body.categories.flatMap((c) => c.products).find((p) => p.available).id, quantity: 1 }],
} });
check('Staff order placed', order.status === 201, `#${order.body?.number}`);
const link = await api('POST', O('/payments/links'), { token: ownerTok, body: { orderId: order.body.id, amountMinor: order.body.totalMinor, allowedMethods: ['card'], key: `smoke-link-${Date.now()}` } });
const payTok = link.body?.url?.split('/pay/')[1];
check('Payment link created', link.status === 201 && !!payTok);
const forged = await api('POST', `/public/pay/${payTok}/refresh?status=paid&success=true`);
const stillOpen = await api('GET', `/public/pay/${payTok}`);
check('A forged "paid" return changes nothing', stillOpen.body?.status === 'open', `refresh ${forged.status}`);
await api('POST', `/public/pay/${payTok}/start`, { body: { method: 'card' } });
const done = await api('POST', `/public/pay/${payTok}/sandbox/complete`, { body: { outcome: 'success' } });
const paidOrder = await api('GET', O(`/orders/${order.body.id}`), { token: ownerTok });
check('Simulated provider payment confirmed server-side (signed webhook → ledger)', done.body?.status === 'paid' && paidOrder.body?.paymentStatus === 'paid');
const unsigned = await req('POST', `${API}/webhooks/payments/simulated`, { body: { type: 'payment.succeeded', data: { id: 'sim_pay_forged_smoke', amount: 1 } } });
check('Unsigned payment webhook is refused (invalid signature)', unsigned.status >= 400 && unsigned.body?.error?.code === 'invalid_signature', `HTTP ${unsigned.status}`);

// --- 7. MCP permission boundaries -------------------------------------------------------------------------------------
check('MCP routes refuse a user token without a client key', (await api('GET', O('/mcp/tools'), { token: 'rmcp_invalid_key_for_smoke' })).status === 401);
const approvals = await api('GET', O('/mcp/approvals'), { token: ownerTok });
check('MCP approval queue readable by the owner', approvals.status === 200, `${approvals.body?.items?.length ?? 0} item(s)`);
check('Waiter cannot read MCP approvals', [403].includes((await api('GET', O('/mcp/approvals'), { token: waiter })).status));

// --- 8. AI through the API -------------------------------------------------------------------------------------------
const fc = await api('GET', O(`/intelligence/forecast?branchId=${org.body.branches.find((b) => b.code === 'main').id}&horizon=7&top=2`), { token: ownerTok });
check('Forecast computed by the deployed AI service', fc.status === 200 && (fc.body?.items?.length ?? 0) > 0, `HTTP ${fc.status}`);

// --- 9. CORS and web ---------------------------------------------------------------------------------------------------
if (env.WEB_URL) {
  const web = env.WEB_URL.replace(/\/$/, '');
  const pre = await req('OPTIONS', `${API}/me`, { headers: { Origin: web, 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'authorization' } });
  check('CORS allows the staging web origin', pre.headers.get('access-control-allow-origin') === web);
  const evil = await req('OPTIONS', `${API}/me`, { headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'GET' } });
  check('CORS refuses other origins', evil.headers.get('access-control-allow-origin') !== 'https://evil.example');
  const anon = await req('GET', `${web}/dashboard`);
  check('Web app requires Vercel login (private preview)', [302, 401, 403].includes(anon.status), `HTTP ${anon.status}`);
  if (env.VERCEL_BYPASS) {
    const ok = await req('GET', `${web}/`, { headers: { 'x-vercel-protection-bypass': env.VERCEL_BYPASS } });
    check('Web app serves the landing page through the automation bypass', ok.status === 200 && /Resuto/.test(ok.text));
  }
}

summary();
function summary() {
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
}
