#!/usr/bin/env node
// DEMO DATA for local development and the private staging environment — never production.
//
// Builds "The Olive Room" (Egypt, two branches) through the running Resuto API, the same
// calls a restaurant would make: menu, floor, staff, inventory, 8 weeks of orders, QR,
// WhatsApp (sandbox transport), deliveries, reservations, marketing, finance, Studio,
// AI and MCP. Every person and phone number is fictional and labelled "(demo)";
// every payment goes through the SIMULATED provider; nothing leaves the system.
//
// Direct SQL is limited to what no API offers, and is listed here:
//   1. nothing for accounts: Supabase Auth users are created through the Supabase Admin Auth API
//      (service-role key, server side only); in dev-auth mode the API's dev issuer is used;
//   2. granting the demo platform-admin row (there is deliberately no API for the first admin);
//   3. marking the demo subscription active ("complimentary demo access, nothing charged");
//   4. BACK-DATING historical orders (and their lines, payments, events and stock movements)
//      after they were placed through the API, because the API always stamps "now";
//   5. reading ids and the completion marker.
//
// Environment (see scripts/demo/README.md):
//   API_URL                    e.g. http://127.0.0.1:4000 (no /v1)
//   DATABASE_URL               the same database the API uses
//   SUPABASE_URL + SUPABASE_PUBLISHABLE_KEY + SUPABASE_SERVICE_ROLE_KEY   real Supabase Auth (staging); omit for dev auth
//   DEMO_OWNER_PASSWORD, DEMO_ADMIN_PASSWORD, DEMO_STAFF_PASSWORD   required, never printed
//   DEMO_TARGET=staging        required for any non-local database
//   DEMO_EMAIL_DOMAIN          default olive-room.demo.test
//
// Safety: refuses NODE_ENV=production, refuses a non-local database unless DEMO_TARGET=staging,
// and refuses any database that already holds a non-demo organization. Idempotent: a completed
// run is detected and skipped; an interrupted run stops and asks for a disposable database.
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { pgClientConfig } from '../db/pg-tls.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const env = process.env;
const API = `${(env.API_URL ?? 'http://127.0.0.1:4000').replace(/\/$/, '')}/v1`;
const SLUG = 'the-olive-room';
const DOMAIN = env.DEMO_EMAIL_DOMAIN ?? 'olive-room.demo.test';
const SUPABASE = env.SUPABASE_URL ? { url: env.SUPABASE_URL.replace(/\/$/, ''), key: env.SUPABASE_PUBLISHABLE_KEY, admin: env.SUPABASE_SERVICE_ROLE_KEY } : null;
const DAYS = Number(env.DEMO_HISTORY_DAYS ?? 56);

function fail(message) { console.error(`demo loader: ${message}`); process.exit(1); }
if (env.NODE_ENV === 'production') fail('refusing to run with NODE_ENV=production');
if (!env.DATABASE_URL) fail('DATABASE_URL is required');
const dbHost = new URL(env.DATABASE_URL).hostname;
const localDb = ['127.0.0.1', 'localhost', '::1'].includes(dbHost);
if (!localDb && env.DEMO_TARGET !== 'staging') fail(`refusing non-local database host "${dbHost}" without DEMO_TARGET=staging`);
for (const k of ['DEMO_OWNER_PASSWORD', 'DEMO_ADMIN_PASSWORD', 'DEMO_STAFF_PASSWORD']) {
  if (!env[k] || env[k].length < 12) fail(`${k} must be set (at least 12 characters)`);
}
if (SUPABASE && !SUPABASE.key) fail('SUPABASE_PUBLISHABLE_KEY is required with SUPABASE_URL');
if (SUPABASE && !SUPABASE.admin) fail('SUPABASE_SERVICE_ROLE_KEY is required with SUPABASE_URL (accounts are created through the Admin Auth API)');

const db = new pg.Pool({ ...pgClientConfig(env.DATABASE_URL), max: 3 });
const q = async (text, params = []) => (await db.query(text, params)).rows;
const log = (...a) => console.log('•', ...a);

// --- HTTP ---------------------------------------------------------------------------------------
let ipN = 0;
const ip = () => { ipN++; return `10.77.${(ipN >> 8) & 255}.${ipN & 255}`; };   // distinct demo guests (public rate limits are per IP)
const key = (p) => `${p}-${randomBytes(6).toString('hex')}`;
async function call(method, p, { token, body, headers = {}, form } = {}) {
  const res = await fetch(API + p, {
    method,
    headers: { ...(form ? {} : { 'Content-Type': 'application/json' }), 'X-Forwarded-For': ip(), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
    body: form ?? (body === undefined ? undefined : JSON.stringify(body)),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: res.status, body: json };
}
async function must(method, p, opts = {}) {
  let r = await call(method, p, opts);
  for (let i = 0; i < 3 && r.status === 429; i++) {   // respect the API's rate limits
    await new Promise((res) => setTimeout(res, (r.body?.error?.details?.retryAfterMs ?? 30_000) + 500));
    r = await call(method, p, opts);
  }
  if (r.status >= 300) throw new Error(`${method} ${p} → ${r.status} ${JSON.stringify(r.body).slice(0, 500)}`);
  return r.body;
}
const upload = (p, token, bytes, filename, type, alt) => {
  const fd = new FormData();
  fd.append('file', new Blob([bytes], { type }), filename);
  if (alt) fd.append('alt', alt);
  return must('POST', p, { token, form: fd });
};

// --- accounts ----------------------------------------------------------------------------------
async function signIn(email, password) {
  if (!SUPABASE) return (await must('POST', '/auth/dev/login', { body: { email, password } })).accessToken;
  const res = await fetch(`${SUPABASE.url}/auth/v1/token?grant_type=password`, {
    method: 'POST', headers: { apikey: SUPABASE.key, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`Supabase sign-in for ${email} failed: ${res.status} ${body.error_description ?? body.msg ?? ''}`);
  return body.access_token;
}
// Supabase Admin Auth API (GoTrue /admin/users). The secret key goes in `apikey`; a legacy JWT service-role key
// is also sent as a bearer token. Server side only: the key is never printed or sent anywhere else.
async function admin(method, path, body) {
  const headers = { apikey: SUPABASE.admin, 'Content-Type': 'application/json' };
  if (SUPABASE.admin.startsWith('eyJ')) headers.Authorization = `Bearer ${SUPABASE.admin}`;
  const res = await fetch(`${SUPABASE.url}/auth/v1${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}
async function adminFindUser(email) {
  for (let page = 1; page <= 20; page++) {
    const r = await admin('GET', `/admin/users?page=${page}&per_page=200`);
    if (r.status !== 200) throw new Error(`Supabase admin list users failed: ${r.status} ${r.data?.msg ?? r.data?.error_code ?? ''}`);
    const users = r.data.users ?? [];
    const hit = users.find((u) => (u.email ?? '').toLowerCase() === email.toLowerCase());
    if (hit) return hit;
    if (users.length < 200) return null;
  }
  return null;
}
/** Creates a confirmed email/password user, or resets the password of the existing one; returns the user id. */
async function adminUpsertUser(email, password, fullName) {
  const user = await adminFindUser(email);
  if (user) {
    const updated = await admin('PUT', `/admin/users/${user.id}`, { password, email_confirm: true });
    if (updated.status !== 200) throw new Error(`Supabase admin update user ${email} failed: ${updated.status} ${updated.data?.msg ?? updated.data?.error_code ?? ''}`);
    return user.id;
  }
  const created = await admin('POST', '/admin/users', { email, password, email_confirm: true, user_metadata: { full_name: fullName, demo: true } });
  if (created.status !== 200 && created.status !== 201) {
    throw new Error(`Supabase admin create user ${email} failed: ${created.status} ${created.data?.msg ?? created.data?.error_code ?? ''}`);
  }
  return created.data.id;
}

/** Creates (or re-passwords) a confirmed account and returns { email, userId, token }. */
async function account(localPart, fullName, password) {
  const email = `${localPart}@${DOMAIN}`;
  if (!SUPABASE) {
    const r = await call('POST', '/auth/dev/signup', { body: { email, password, fullName } });
    if (r.status >= 300 && r.status !== 409) throw new Error(`dev signup ${email}: ${r.status}`);
  } else {
    const id = await adminUpsertUser(email, password, fullName);
    await q(`insert into profiles(id, full_name, email) values ($1, $2, $3) on conflict (id) do update set full_name = excluded.full_name`, [id, fullName, email]);
  }
  const token = await signIn(email, password);
  const me = await must('GET', '/me', { token });
  return { email, userId: me.user.id, token };
}

// --- safety and idempotency ----------------------------------------------------------------------
const foreign = await q(`select count(*)::int as n from organizations where slug <> $1 and coalesce((onboarding->>'demo')::boolean, false) = false`, [SLUG]);
if (foreign[0].n > 0) fail(`this database holds ${foreign[0].n} non-demo organization(s); the demo loader only runs on a disposable database`);
const [prior] = await q(`select id, onboarding->>'demoLoader' as state from organizations where slug = $1`, [SLUG]);
if (prior?.state === 'complete') {
  log(`demo tenant "${SLUG}" already loaded (organization ${prior.id}); nothing to do`);
  // Keep the demo passwords in sync with the environment.
  await account('owner', 'Demo Owner (demo)', env.DEMO_OWNER_PASSWORD);
  await db.end();
  process.exit(0);
}
if (prior) fail(`demo tenant "${SLUG}" exists from an interrupted run; reset the disposable database and run again`);

// --- 1. owner, restaurant, branches ----------------------------------------------------------------
const OWNER = await account('owner', 'Demo Owner (demo)', env.DEMO_OWNER_PASSWORD);
const org = await must('POST', '/orgs', { token: OWNER.token, body: {
  name: 'The Olive Room', nameAr: 'غرفة الزيتون', slug: SLUG, country: 'EG', planId: 'pro', defaultLocale: 'ar',
  branch: { name: 'Zamalek, Cairo', nameAr: 'الزمالك، القاهرة', code: 'main', address: '14 26th of July St, Zamalek', city: 'Cairo', acceptsDelivery: true, deliveryFeeMinor: 3000 },
} });
const ORG = org.id;
const O = (p) => `/o/${ORG}${p}`;
await q(`update organizations set onboarding = onboarding || '{"demo": true, "demoLoader": "started"}'::jsonb where id = $1`, [ORG]);
const smashBranch = await must('POST', O('/branches'), { token: OWNER.token, body: { name: 'Smash & Co', nameAr: 'سماش آند كو', code: 'burger', address: '9 Champollion St, Downtown', city: 'Cairo', acceptsDelivery: true, deliveryFeeMinor: 2500 } });
const MAIN = { id: org.branchId, code: 'main' };
const SMASH = { id: smashBranch.id, code: 'burger' };
await must('PATCH', O(`/branches/${MAIN.id}`), { token: OWNER.token, body: { latitude: 30.0626, longitude: 31.2197 } });
await must('PATCH', O(`/branches/${SMASH.id}`), { token: OWNER.token, body: { latitude: 30.0478, longitude: 31.2393 } });
// Complimentary demo access: the Pro plan stays active for the review; nothing is charged.
const [sub] = await q(`update subscriptions set status = 'active' where org_id = $1 and status <> 'canceled' returning id`, [ORG]);
if (sub) await q(`insert into subscription_events(org_id, subscription_id, event_type, to_plan_id, details) values ($1, $2, 'demo_complimentary', 'pro', $3)`,
  [ORG, sub.id, { note: 'Demo data: complimentary access, nothing charged, no billing provider.' }]);
log(`restaurant ${SLUG} (${ORG}) with branches Zamalek (fine dining) and Smash & Co (burgers)`);

// --- 2. staff and platform admin ------------------------------------------------------------------------
const STAFF = {};
for (const [role, name, branches] of [
  ['manager', 'Karim Manager', null], ['kitchen', 'Hoda Kitchen', [MAIN.id]], ['cashier', 'Sami Cashier', null],
  ['marketing', 'Laila Marketing', null], ['accountant', 'Tarek Accountant', null], ['host', 'Nadia Host', [MAIN.id]], ['waiter', 'Youssef Waiter', [MAIN.id]],
  ['driver', 'Omar Driver', [MAIN.id]], ['driver', 'Mahmoud Driver', [MAIN.id]],
]) {
  const local = role === 'driver' ? `driver${Object.keys(STAFF).filter((k) => k.startsWith('driver')).length + 1}` : role;
  const user = await account(local, `${name} (demo)`, env.DEMO_STAFF_PASSWORD);
  const inv = await must('POST', O('/invitations'), { token: OWNER.token, body: { email: user.email, role, branchIds: branches } });
  await must('POST', '/invitations/accept', { token: user.token, body: { token: inv.token } });
  STAFF[local] = user;
}
const ADMIN = await account('platform-admin', 'Platform admin (demo)', env.DEMO_ADMIN_PASSWORD);
await q(`insert into platform_admins(user_id, role) values ($1, 'superadmin') on conflict (user_id) do nothing`, [ADMIN.userId]);
log('staff: manager, kitchen, cashier, marketing, accountant, host, waiter, 2 drivers; 1 platform superadmin');

// --- 3. tax profile (ETA pre-production structure; validation is not certification) ------------------------
await must('PUT', O('/compliance/tax-profile'), { token: STAFF.accountant.token, body: {
  vatNumber: '100200300', registeredName: 'The Olive Room (demo) LLC',
  registeredAddress: { governate: 'Cairo', regionCity: 'Zamalek', street: '26th of July St', buildingNumber: '14' },
  etaActivityCode: '5610', etaBranchCode: '0', etaPosSerial: 'DEMO-POS-001', etaEnvironment: 'preprod',
} });

// --- 4. menu (from the legacy demo fixture: names, Arabic names, prices, stations) --------------------------------
const fixture = JSON.parse(readFileSync(path.join(ROOT, 'tools/legacy-migration/fixtures/olive-room.legacy-state.json'), 'utf8')).state.menu;
const CATEGORY_AR = { Starters: 'المقبلات', Mains: 'الأطباق الرئيسية', Desserts: 'الحلويات', Drinks: 'المشروبات', Burgers: 'البرجر', Sides: 'الأطباق الجانبية', Shakes: 'الميلك شيك' };
const categories = {};
for (const name of [...new Set(fixture.map((m) => m.category))]) {
  categories[name] = (await must('POST', O('/menu/categories'), { token: OWNER.token, body: { name, nameAr: CATEGORY_AR[name] ?? null } })).id;
}
const costRatio = (m) => (/Drinks|Shakes/.test(m.category) ? 0.22 : m.category === 'Sides' ? 0.25 : 0.32);
const PRODUCTS = {};   // fixture id → { id, name, branch, priceMinor }
for (const m of fixture) {
  const p = await must('POST', O('/menu/products'), { token: OWNER.token, body: {
    categoryId: categories[m.category], name: m.name, nameAr: m.nameAr ?? null, description: m.description ?? null, descriptionAr: m.descriptionAr ?? null,
    priceMinor: m.price, costMinor: Math.round((m.price * costRatio(m)) / 50) * 50, station: m.station, allergens: m.allergens ?? [], dietary: m.dietary ?? [],
    prepMinutes: m.prepMinutes ?? null, spiceLevel: m.spice ?? 0,
  } });
  const branch = m.branchIds?.includes('burger') ? SMASH : MAIN;
  const other = branch === MAIN ? SMASH : MAIN;
  // Each branch serves its own menu: the other branch does not offer this dish.
  await must('PUT', O(`/menu/products/${p.id}/branches/${other.id}`), { token: OWNER.token, body: { isAvailable: false } });
  PRODUCTS[m.id] = { id: p.id, name: m.name, category: m.category, branch, priceMinor: m.price };
}
// Every dish has its own photo: the eight Zamalek dishes (m0–m7, cut from the legacy menu photography) and the nine
// Smash & Co items (b0–b8, the legacy storefront's photography in supabase/seeds/media/smash). No dish falls back to a
// shared sprite (audits VP-04, DF-08).
const seedManifest = JSON.parse(readFileSync(path.join(ROOT, 'supabase/seeds/olive-room.demo.json'), 'utf8'));
for (const [legacyId, rel] of [...Object.entries(seedManifest.photos), ...Object.entries(seedManifest.smash.photos)]) {
  if (legacyId.startsWith('_') || !PRODUCTS[legacyId]) continue;
  await upload(O(`/menu/products/${PRODUCTS[legacyId].id}/image`), OWNER.token, readFileSync(path.join(ROOT, 'supabase/seeds', rel)), `${legacyId}.webp`, 'image/webp', PRODUCTS[legacyId].name);
}
// Burger extras (optional modifier group).
const extras = await must('POST', O('/menu/modifier-groups'), { token: OWNER.token, body: { name: 'Extras', nameAr: 'إضافات', minSelect: 0, maxSelect: 2 } });
for (const [name, nameAr, price] of [['Extra cheese', 'جبنة إضافية', 1500], ['Jalapeños', 'هالابينو', 1000]]) {
  await must('POST', O(`/menu/modifier-groups/${extras.id}/options`), { token: OWNER.token, body: { name, nameAr, priceDeltaMinor: price } });
}
for (const p of Object.values(PRODUCTS).filter((x) => x.category === 'Burgers')) {
  await must('PUT', O(`/menu/products/${p.id}/modifier-groups`), { token: OWNER.token, body: { groupIds: [extras.id] } });
}
const menuOf = (branch) => Object.values(PRODUCTS).filter((p) => p.branch === branch);
const byName = (re) => Object.values(PRODUCTS).find((p) => re.test(p.name));
log(`menu: ${Object.keys(categories).length} categories (Arabic names), ${fixture.length} dishes with photos, burger extras`);

// --- 5. floor plans -------------------------------------------------------------------------------------------
const table = (label, cx, cy, zone, extra = {}) => ({ label, capacity: 4, zone, shape: 'square', cx, cy, width: 100, height: 100, rotation: 0,
  features: [], reservable: true, minSpendMinor: 0, premium: false, internalNotes: '', ...extra });
async function floor(branch, tables, zones) {
  const cur = await must('GET', O(`/floor/${branch.id}`), { token: OWNER.token });
  await must('PUT', O(`/floor/${branch.id}`), { token: OWNER.token, body: { baseRevision: cur.revision, key: key('floor'), layout: {
    width: 1200, height: 800, background: { image: null, opacity: 0.4, locked: true, x: 0, y: 0, width: 1200, height: 800 },
    zones, objects: [{ id: 'wall-top', type: 'wall', label: 'North wall', x: 600, y: 40, width: 1100, height: 10, rotation: 0 },
      { id: 'door', type: 'door', label: 'Entrance', x: 120, y: 760, width: 90, height: 20, rotation: 0 }], tables,
  } } });
}
await floor(MAIN, [
  table('T1', 250, 220, 'Main room', { shape: 'round', capacity: 2, width: 90, height: 90 }), table('T2', 500, 220, 'Main room'), table('T3', 750, 220, 'Main room'),
  table('T4', 250, 560, 'Terrace', { shape: 'round', capacity: 6, width: 120, height: 120, features: ['Outdoor'] }), table('T5', 500, 560, 'Terrace', { features: ['Outdoor'] }),
  table('T6', 750, 560, 'Terrace', { shape: 'rect', capacity: 8, width: 180, height: 90, features: ['Outdoor'], premium: true }),
], [
  { id: 'zone-main', type: 'zone', label: 'Main room', x: 600, y: 220, width: 1000, height: 300, rotation: 0, color: '#e9efe5' },
  { id: 'zone-terrace', type: 'zone', label: 'Terrace', x: 600, y: 560, width: 1000, height: 300, rotation: 0, color: '#f3ead8' },
]);
await floor(SMASH, [table('S1', 300, 300, 'Counter'), table('S2', 600, 300, 'Counter'), table('S3', 900, 300, 'Counter')],
  [{ id: 'zone-counter', type: 'zone', label: 'Counter', x: 600, y: 300, width: 1000, height: 400, rotation: 0, color: '#f0e6e0' }]);

// --- 6. demo customers and the order plan ------------------------------------------------------------------------
const FIRST = ['Mona', 'Ahmed', 'Sara', 'Youssef', 'Nour', 'Omar', 'Laila', 'Karim', 'Hana', 'Mostafa', 'Salma', 'Tamer', 'Dina', 'Hassan', 'Mariam', 'Ali', 'Farah', 'Ziad', 'Rana', 'Khaled', 'Yara', 'Amr', 'Jana', 'Seif'];
const LAST = ['Adel', 'Hassan', 'Fouad', 'Mansour', 'Saeed', 'Nabil', 'Ezzat', 'Ramzy', 'Selim', 'Farouk'];
const CUSTOMERS = FIRST.map((f, i) => ({ name: `${f} ${LAST[i % LAST.length]} (demo)`, phone: `+2010${String(90000000 + i * 137).padStart(8, '0')}`, consent: i % 3 !== 2, weight: i < 8 ? 3 : i < 16 ? 1.4 : 0.6 }));
let seed = 42;   // deterministic plan: the same history on every run
const rand = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
const pickN = (arr, n) => [...arr].sort(() => rand() - 0.5).slice(0, n);
const customer = () => { let r = rand() * CUSTOMERS.reduce((s, c) => s + c.weight, 0); for (const c of CUSTOMERS) { r -= c.weight; if (r <= 0) return c; } return CUSTOMERS[0]; };
const [{ today }] = await q(`select (now() at time zone 'Africa/Cairo')::date::text as today`);
const addDays = (iso, n) => { const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const HOURS = [12, 13, 13, 14, 15, 18, 19, 19, 20, 20, 21, 22];
const PLAN = [];
for (let d = DAYS; d >= 1; d--) {
  const date = addDays(today, -d);
  const dow = new Date(`${date}T00:00:00Z`).getUTCDay();          // Thu/Fri evenings are busiest in Cairo
  const n = Math.max(2, Math.round((dow === 4 || dow === 5 ? 9 : dow === 6 ? 7 : 5) * (1 + ((DAYS - d) / DAYS) * 0.25) + (rand() * 3 - 1.5)));
  for (let i = 0; i < n; i++) {
    const branch = rand() < 0.7 ? MAIN : SMASH;
    const lines = pickN(menuOf(branch), 1 + Math.floor(rand() * 3)).map((p) => ({ productId: p.id, quantity: rand() < 0.25 ? 2 : 1 }));
    PLAN.push({ date, hour: HOURS[Math.floor(rand() * HOURS.length)], minute: Math.floor(rand() * 60), branch, lines,
      customer: rand() < 0.85 ? customer() : null, web: rand() < 0.45, online: rand() < 0.5, cancel: rand() < 0.03 });
  }
}

// --- 7. inventory: recipes, then opening stock sized to the planned sales (stock never goes negative) ---------------
const sup1 = await must('POST', O('/inventory/suppliers'), { token: OWNER.token, body: { name: 'Delta Fresh Produce (demo)', phone: '+20223450001' } });
const sup2 = await must('POST', O('/inventory/suppliers'), { token: OWNER.token, body: { name: 'Nile Meats (demo)', phone: '+20223450002' } });
const ITEMS = {};
const ITEM_DEFS = [
  ['Beef patty mix', 'kg', 42000, 4, sup2.id, SMASH], ['Chicken breast', 'kg', 21000, 4, sup2.id, MAIN], ['Seabass fillet', 'kg', 52000, 2, sup2.id, MAIN],
  ['Potatoes', 'kg', 1800, 15, sup1.id, SMASH], ['Tomatoes', 'kg', 2200, 6, sup1.id, MAIN], ['Arborio rice', 'kg', 9500, 3, sup1.id, MAIN],
  ['Brioche buns', 'pcs', 650, 40, null, SMASH], ['Frying oil', 'l', 9500, 10, null, SMASH], ['Burrata', 'pcs', 6500, 6, null, MAIN], ['Mushrooms', 'kg', 16000, 2, sup1.id, MAIN],
];
for (const [name, unit, cost, reorder, supplierId] of ITEM_DEFS) {
  ITEMS[name] = (await must('POST', O('/inventory/items'), { token: OWNER.token, body: { name, unit, costPerUnitMinor: cost, reorderLevel: reorder, ...(supplierId ? { supplierId } : {}) } })).id;
}
// Quantities in the item's base unit (kg, l, pcs) per portion.
const RECIPES = {
  'Classic Smash': [['Beef patty mix', 0.15], ['Brioche buns', 1]], 'Double Smash': [['Beef patty mix', 0.3], ['Brioche buns', 1]],
  'Classic Fries': [['Potatoes', 0.25], ['Frying oil', 0.04]], 'Loaded Fries': [['Potatoes', 0.3], ['Frying oil', 0.04]],
  'Grilled chicken supreme': [['Chicken breast', 0.25]], 'Seabass with lemon butter': [['Seabass fillet', 0.22]],
  'Wild mushroom risotto': [['Arborio rice', 0.12], ['Mushrooms', 0.08]], 'Burrata & heirloom tomato': [['Burrata', 1], ['Tomatoes', 0.15]],
};
const unitOf = Object.fromEntries(ITEM_DEFS.map(([n, u]) => [n, u]));
for (const [dish, comps] of Object.entries(RECIPES)) {
  const p = byName(new RegExp(`^${dish.replace(/[&()]/g, '.')}$`));
  if (p) await must('PUT', O(`/inventory/recipes/${p.id}`), { token: OWNER.token, body: { components: comps.map(([item, qty]) => ({ itemId: ITEMS[item], quantity: qty, unit: unitOf[item] })) } });
}
const usage = {};   // `${branchId}:${item}` → planned consumption
for (const o of PLAN) for (const l of o.lines) {
  const name = Object.values(PRODUCTS).find((p) => p.id === l.productId).name;
  for (const [item, qty] of RECIPES[name] ?? []) usage[`${o.branch.id}:${item}`] = (usage[`${o.branch.id}:${item}`] ?? 0) + qty * l.quantity;
}
const openingAt = `${addDays(today, -DAYS - 1)}T09:00:00+02:00`;
for (const [k, used] of Object.entries(usage)) {
  const [branchId, item] = k.split(':');
  const reorder = ITEM_DEFS.find((x) => x[0] === item)[3];
  const quantity = Math.ceil((used + reorder * 2.5) * 10) / 10;   // planned sales + a buffer above the reorder level
  const m = await must('POST', O('/inventory/movements'), { token: OWNER.token, body: { kind: 'purchase', branchId, itemId: ITEMS[item], quantity, note: 'Opening stock (demo)' } });
  await q(`update stock_movements set created_at = $2 where id = $1::bigint`, [m.movementId, openingAt]);
}
for (const [name, qty, reason, note] of [['Tomatoes', 1.5, 'spoiled', 'Overripe batch (demo)'], ['Burrata', 2, 'expired', 'Past date (demo)']]) {
  await must('POST', O('/inventory/movements'), { token: OWNER.token, body: { kind: 'waste', branchId: MAIN.id, itemId: ITEMS[name], quantity: qty, reason, note } });
}
log(`inventory: 2 suppliers, ${ITEM_DEFS.length} items, ${Object.keys(RECIPES).length} recipes, opening stock sized to the planned sales, 2 waste records`);

// --- 8. order history (placed through the API, then back-dated) -------------------------------------------------
async function advance(orderId, to, token = STAFF.manager.token) {
  for (const s of to) await must('POST', O(`/orders/${orderId}/transition`), { token, body: { to: s } });
}
async function backdate(orderId, date, hour, minute) {
  await q(`with t as (select (($2::date + make_interval(hours => $3, mins => $4)) at time zone 'Africa/Cairo') as at)
    update orders o set business_date = $2::date, placed_at = t.at, created_at = t.at,
      accepted_at = case when o.accepted_at is null then null else t.at + interval '2 min' end,
      ready_at = case when o.ready_at is null then null else t.at + interval '16 min' end,
      fulfilled_at = case when o.fulfilled_at is null then null else t.at + interval '22 min' end,
      cancelled_at = case when o.cancelled_at is null then null else t.at + interval '5 min' end,
      updated_at = t.at + interval '22 min'
    from t where o.id = $1`, [orderId, date, hour, minute]);
  await q(`update order_lines l set created_at = o.placed_at,
      kitchen_started_at = case when l.kitchen_started_at is null then null else o.placed_at + interval '3 min' end,
      kitchen_ready_at = case when l.kitchen_ready_at is null then null else o.placed_at + interval '15 min' end,
      updated_at = o.placed_at + interval '22 min' from orders o where o.id = l.order_id and o.id = $1`, [orderId]);
  await q(`update payments p set created_at = o.placed_at + interval '20 min', captured_at = case when p.captured_at is null then null else o.placed_at + interval '21 min' end,
      updated_at = o.placed_at + interval '21 min' from orders o where o.id = p.order_id and o.id = $1`, [orderId]);
  await q(`update order_events e set created_at = o.placed_at + interval '1 min' from orders o where o.id = e.order_id and o.id = $1`, [orderId]);
  await q(`update stock_movements m set created_at = o.placed_at + interval '15 min' from orders o where o.id = $1 and m.reference_id = $1::text`, [orderId]);
}
for (const o of PLAN) {
  let orderId = null;
  if (o.web) {
    // Website order. The public endpoint limits orders per phone per minute; a regular who hits it is served at the counter instead.
    const r = await call('POST', `/public/order/${SLUG}/orders`, { headers: { 'Idempotency-Key': key('hist-web') }, body: {
      branchId: o.branch.id, fulfillment: 'pickup', payment: o.online ? 'online' : 'pay_at_pickup', lines: o.lines,
      customer: o.customer ? { name: o.customer.name, phone: o.customer.phone, marketingConsent: o.customer.consent } : { name: 'Website guest (demo)', phone: `+2011${String(Math.floor(rand() * 1e8)).padStart(8, '0')}` },
    } });
    if (r.status < 300) {
      orderId = r.body.order.id;
      if (o.online) {
        const tok = r.body.checkout.url.split('/pay/')[1];
        await must('POST', `/public/pay/${tok}/start`, { body: { method: 'card' } });
        await must('POST', `/public/pay/${tok}/sandbox/complete`, { body: { outcome: 'success' } });
      } else {
        await must('POST', O(`/orders/${orderId}/collect`), { token: STAFF.cashier.token, headers: { 'Idempotency-Key': key('cash') }, body: { method: 'cash' } });
      }
    } else if (r.status !== 429) throw new Error(`web order ${r.status} ${JSON.stringify(r.body)}`);
  }
  if (!orderId) {
    const r = await must('POST', O('/orders'), { token: STAFF.cashier.token, headers: { 'Idempotency-Key': key('hist') }, body: {
      branchId: o.branch.id, fulfillment: 'pickup', lines: o.lines, customer: o.customer ? { name: o.customer.name, phone: o.customer.phone } : { name: 'Walk-in (demo)' },
    } });
    orderId = r.id;
    // Transfers need the reference staff verified (PAY-19); demo references are labelled and unique.
    const method = o.cancel ? null : rand() < 0.7 ? 'cash' : 'instapay';
    if (method) await must('POST', O(`/orders/${orderId}/collect`), { token: STAFF.cashier.token, headers: { 'Idempotency-Key': key('cash') }, body: method === 'cash' ? { method } : { method, reference: key('DEMO-IP') } });
  }
  const detail = await must('GET', O(`/orders/${orderId}`), { token: OWNER.token });
  const cancelled = o.cancel && detail.paymentStatus === 'unpaid'
    && (await call('POST', O(`/orders/${orderId}/cancel`), { token: STAFF.manager.token, body: { reason: 'Customer changed plans (demo)', version: detail.version } })).status < 300;
  if (!cancelled) await advance(orderId, ['accepted', 'preparing', 'ready', 'picked_up']);
  await backdate(orderId, o.date, o.hour, o.minute);
}
await q(`update customers c set first_seen_at = s.first, created_at = least(c.created_at, s.first), last_seen_at = s.last
         from (select customer_id, min(placed_at) as first, max(placed_at) as last from orders where org_id = $1 and customer_id is not null group by 1) s
         where c.id = s.customer_id`, [ORG]);
log(`history: ${PLAN.length} orders over ${DAYS} days (website and counter), placed through the API, then back-dated`);

// --- 9. today: kitchen, QR dine-in, reservations ----------------------------------------------------------------------
const chicken = byName(/Grilled chicken/), soup = byName(/pumpkin soup/), hibiscus = byName(/Hibiscus/), risotto = byName(/risotto/), seabass = byName(/Seabass/), smash = byName(/^Classic Smash$/);
const line = (p, quantity = 1) => ({ productId: p.id, quantity });
const live = [];
for (const [lines, to, who, notes] of [
  [[line(chicken, 2), line(soup)], [], 'Mona Adel (demo)', 'No onions please (demo)'],
  [[line(risotto), line(hibiscus, 2)], ['accepted', 'preparing'], 'Ahmed Hassan (demo)', undefined],
  [[line(seabass), line(soup)], ['accepted', 'preparing', 'ready'], 'Sara Fouad (demo)', undefined],
]) {
  const r = await must('POST', O('/orders'), { token: STAFF.cashier.token, headers: { 'Idempotency-Key': key('live') }, body: { branchId: MAIN.id, fulfillment: 'pickup', lines, customer: { name: who }, notes } });
  await advance(r.id, to, STAFF.kitchen.token);
  live.push(r.id);
}
const qrSheet = await must('GET', O(`/floor/${MAIN.id}/qr`), { token: OWNER.token });
const qrFor = (label) => qrSheet.items.find((x) => x.label === label).url.split('/t/')[1];
const sess = await must('POST', `/public/tables/${qrFor('T2')}/session`);
const V = { 'X-Visit-Token': sess.token };
await must('POST', '/public/visits/current/orders', { headers: { ...V, 'Idempotency-Key': key('qr') }, body: { lines: [line(chicken, 2), line(hibiscus, 2)], notes: 'Birthday table (demo)' } });
await must('POST', '/public/visits/current/requests', { headers: V, body: { kind: 'waiter' } });
for (const [days, time, party, guest, phone, label] of [
  [0, '20:00', 4, 'Hana Mansour (demo)', '+201090001001', 'T4'], [0, '21:30', 2, 'Ziad Ramzy (demo)', '+201090001002', 'T1'],
  [1, '19:30', 6, 'Farah Selim (demo)', '+201090001003', null], [2, '13:00', 3, 'Khaled Farouk (demo)', '+201090001004', null],
]) {
  const [t] = label ? await q(`select id from dining_tables where branch_id = $1 and label = $2`, [MAIN.id, label]) : [];
  const r = await call('POST', O('/reservations'), { token: STAFF.host.token, headers: { 'Idempotency-Key': key('res') }, body: {
    branchId: MAIN.id, date: addDays(today, days), time, partySize: party, guestName: guest, guestPhone: phone, ...(t ? { tableId: t.id } : {}),
  } });
  if (r.status >= 300) console.warn(`  reservation ${addDays(today, days)} ${time} not created: ${r.body?.error?.code ?? r.status} (e.g. the time has passed today)`);
}
log('today: kitchen tickets (new / preparing / ready), a QR visit on T2 with an order and a waiter call, reservations');

// --- 10. WhatsApp (sandbox transport: nothing reaches Meta) --------------------------------------------------------------
const channel = await must('POST', O('/connect/channels'), { token: OWNER.token, body: { transport: 'sandbox', displayName: 'Olive Room WhatsApp (sandbox)' } });
const inbound = (from, msg) => must('POST', O('/connect/sandbox/inbound'), { token: OWNER.token, body: { channelId: channel.id, from, ...msg } });
const lastOut = async (conversationId) => (await q(`select payload from messages where conversation_id = $1 and direction = 'outbound' order by created_at desc, id desc limit 1`, [conversationId]))[0];
async function waToMenu(from, name, fulfillment, address) {
  const a = await inbound(from, { text: 'order', name });
  const out = await lastOut(a.conversationId);
  if (out?.payload?.buttons?.some((b) => b.id?.startsWith('branch:')) || out?.payload?.sections) await inbound(from, { reply: { id: `branch:${MAIN.id}` } });
  await inbound(from, { reply: { id: `ful:${fulfillment}` } });
  await inbound(from, { text: name });
  if (fulfillment === 'delivery') await inbound(from, { text: address });
  const link = await lastOut(a.conversationId);
  return { conversationId: a.conversationId, token: link.payload.url.split('/o/')[1] };
}
const waOrders = [];
for (const [from, name, payment, lines, addr] of [
  ['+201090002001', 'Mariam Ezzat (demo)', 'cod', [line(chicken), line(soup, 2)], '12 Hassan Sabry St, Zamalek, floor 3'],
  ['+201090002002', 'Seif Nabil (demo)', 'online', [line(risotto), line(hibiscus)], '4 Brazil St, Zamalek, apt 7'],
  ['+201090002003', 'Yara Saeed (demo)', 'cod', [line(seabass), line(hibiscus, 2)], '30 Abu El Feda St, Zamalek'],
]) {
  const w = await waToMenu(from, name, 'delivery', addr);
  const v = await must('GET', `/public/connect/ordering/${w.token}`);
  const cart = await must('POST', `/public/connect/ordering/${w.token}/cart`, { body: { version: v.version, lines } });
  await must('POST', `/public/connect/ordering/${w.token}/details`, { body: { version: cart.version, marketingConsent: true } });
  const v2 = await must('GET', `/public/connect/ordering/${w.token}`);
  const done = await must('POST', `/public/connect/ordering/${w.token}/checkout`, { body: { version: v2.version, paymentMethod: payment, expectedTotalMinor: cart.quote.totalMinor } });
  if (payment === 'online') {
    const tok = done.checkoutUrl.split('/pay/')[1];
    await must('POST', `/public/pay/${tok}/start`, { body: { method: 'card' } });
    await must('POST', `/public/pay/${tok}/sandbox/complete`, { body: { outcome: 'success' } });
  }
  waOrders.push({ orderId: done.order.id, total: done.order.totalMinor });
}
await waToMenu('+201090002004', 'Rana Hassan (demo)', 'pickup');
await inbound('+201090002005', { text: 'Hi, do you have vegan options? (demo)', name: 'Ali Fouad (demo)' });
log('WhatsApp sandbox: 3 delivery orders (2 cash on delivery, 1 paid online), 1 open menu session, 1 question');

// --- 11. delivery: dispatch, pickup, proof, cash on delivery, settlement ---------------------------------------------------
const D = (p) => O(`/driver${p}`), M = (p) => O(`/delivery${p}`);
const jobOf = async (orderId) => {
  for (let i = 0; i < 60; i++) {   // the worker creates delivery jobs from the outbox
    const [j] = await q(`select id from delivery_jobs where order_id = $1`, [orderId]);
    if (j) return j.id;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`no delivery job for ${orderId}: is the worker running?`);
};
const fleet = await must('GET', M('/drivers'), { token: STAFF.manager.token });
const drivers = [STAFF.driver1, STAFF.driver2];
const driverIds = drivers.map((d) => fleet.items.find((x) => x.userId === d.userId).id);
for (const d of drivers) await must('PATCH', D('/me/availability'), { token: d.token, body: { availability: 'available' } });
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082', 'hex');
{
  const o = waOrders[0];
  const job = await jobOf(o.orderId);
  await must('POST', M(`/jobs/${job}/assign`), { token: STAFF.manager.token, body: { driverId: driverIds[0] } });
  await must('POST', D(`/jobs/${job}/accept`), { token: drivers[0].token, body: { latitude: 30.063, longitude: 31.22 } });
  for (const to of ['accepted', 'preparing', 'ready']) await must('POST', O(`/kitchen/orders/${o.orderId}/bump`), { token: STAFF.kitchen.token, body: { to } });
  await must('POST', D(`/jobs/${job}/pickup`), { token: drivers[0].token, body: {} });
  await must('POST', D(`/jobs/${job}/en-route`), { token: drivers[0].token, body: { latitude: 30.064, longitude: 31.221 } });
  const photo = await upload(D(`/jobs/${job}/proof-photo`), drivers[0].token, PNG, 'door.png', 'image/png');
  await must('POST', D(`/jobs/${job}/deliver`), { token: drivers[0].token, headers: { 'Idempotency-Key': key('deliver') },
    body: { proofMediaId: photo.mediaId, recipientName: 'Mariam (demo)', cashCollectedMinor: o.total, latitude: 30.0601, longitude: 31.2185 } });
  await must('POST', M('/settlements'), { token: STAFF.manager.token, body: { driverId: driverIds[0], jobIds: [job], amountMinor: o.total, note: 'End of shift (demo)' } });
}
{
  const o = waOrders[1];
  const job = await jobOf(o.orderId);
  await must('POST', M(`/jobs/${job}/assign`), { token: STAFF.manager.token, body: { driverId: driverIds[1] } });
  await must('POST', D(`/jobs/${job}/accept`), { token: drivers[1].token, body: { latitude: 30.062, longitude: 31.219 } });
  for (const to of ['accepted', 'preparing', 'ready']) await must('POST', O(`/kitchen/orders/${o.orderId}/bump`), { token: STAFF.kitchen.token, body: { to } });
  await must('POST', D(`/jobs/${job}/pickup`), { token: drivers[1].token, body: {} });
  await must('POST', D(`/jobs/${job}/en-route`), { token: drivers[1].token, body: { latitude: 30.0655, longitude: 31.2155 } });
}
await jobOf(waOrders[2].orderId);
log('delivery: 1 delivered (photo proof, cash collected and settled), 1 on the way, 1 waiting for a driver');

// --- 12. marketing ---------------------------------------------------------------------------------------------------------
const mk = (p) => O(`/marketing${p}`);
const regulars = await must('POST', mk('/segments'), { token: STAFF.marketing.token, body: { name: 'Regulars: 3+ orders in 60 days (demo)', definition: { op: 'and', rules: [{ type: 'orders_gte', count: 3, withinDays: 60 }] } } });
const waSeg = await must('POST', mk('/segments'), { token: STAFF.marketing.token, body: { name: 'Consented WhatsApp customers (demo)', definition: { op: 'and', rules: [{ type: 'consent', value: true }, { type: 'channel', channel: 'whatsapp' }] } } });
const camp = await must('POST', mk('/campaigns'), { token: STAFF.marketing.token, body: { name: 'Weekend dinner offer (demo)', channel: 'whatsapp', segmentId: waSeg.id, objective: 'retention',
  content: { text: 'This weekend at The Olive Room: a complimentary hibiscus cooler with every main course. Order here! (demo message)' } } });
await must('POST', mk(`/campaigns/${camp.id}/submit`), { token: STAFF.marketing.token });
await must('POST', mk(`/campaigns/${camp.id}/approve`), { token: STAFF.manager.token });   // approved by a second person
await must('POST', mk(`/campaigns/${camp.id}/send`), { token: STAFF.marketing.token });
const link = await must('POST', mk('/links'), { token: STAFF.marketing.token, body: { campaignId: camp.id, destinationPath: `/order/${SLUG}`, utm: { content: 'weekend' } } });
const click = await must('GET', `/public/l/${link.code}`);
const attribution = Object.fromEntries(new URL(click.destination, 'http://localhost').searchParams.entries());
const attributed = await must('POST', `/public/order/${SLUG}/orders`, { headers: { 'Idempotency-Key': key('attr') }, body: {
  branchId: MAIN.id, fulfillment: 'pickup', payment: 'online', lines: [line(chicken), line(soup)],
  customer: { name: 'Hana Mansour (demo)', phone: '+201090001001', marketingConsent: true }, attribution,
} });
{
  const tok = attributed.checkout.url.split('/pay/')[1];
  await must('POST', `/public/pay/${tok}/start`, { body: { method: 'card' } });
  await must('POST', `/public/pay/${tok}/sandbox/complete`, { body: { outcome: 'success' } });
}
const draft = await must('POST', mk('/campaigns'), { token: STAFF.marketing.token, body: { name: 'Iftar set menu (demo draft)', channel: 'whatsapp', segmentId: regulars.id, objective: 'reactivation',
  content: { text: 'Our iftar set menu is back. Book your table. (demo draft)' } } });
await must('POST', mk(`/campaigns/${draft.id}/submit`), { token: STAFF.marketing.token });
await must('POST', mk('/promotions'), { token: STAFF.marketing.token, body: { code: 'WELCOME10', name: 'Welcome 10% (demo)', nameAr: 'خصم ترحيبي 10% (تجريبي)', kind: 'percent', value: 1000, maxDiscountMinor: 5000, minOrderMinor: 20000, channels: ['web'] } });
log('marketing: 2 segments, 1 approved campaign sent on the sandbox channel with an attributed paid order, 1 awaiting approval, 1 promo code');

// --- 13. finance: monthly operating expenses (no ingredient expenses: item costs already carry COGS) -----------------------------
const cats = (await must('GET', O('/finance/expense-categories'), { token: STAFF.accountant.token })).items;
const cat = (kind) => { const c = cats.find((x) => x.kind === kind); if (!c) throw new Error(`no expense category of kind ${kind}`); return c.id; };
const months = [...new Set(PLAN.map((o) => o.date.slice(0, 7)).concat(today.slice(0, 7)))];
for (const month of months) {
  for (const [kind, amount, tax, vendor, day] of [
    ['rent', 1800000, 0, 'Zamalek landlord (demo)', '01'], ['utilities', 342000, 42000, 'Electricity & water (demo)', '10'],
    ['labor', 2400000, 0, 'Payroll (demo)', '25'], ['fees', 120000, 0, 'POS terminal rental (demo)', '05'],
  ]) {
    const incurredOn = `${month}-${day}`;
    if (incurredOn > today || incurredOn < addDays(today, -DAYS)) continue;   // only expenses inside the demo period, never in the future
    await must('POST', O('/finance/expenses'), { token: STAFF.accountant.token, body: { categoryId: cat(kind), amountMinor: amount, taxMinor: tax, incurredOn, vendor } });
  }
}
await must('POST', O('/finance/expenses'), { token: STAFF.accountant.token, body: { categoryId: cat('marketing'), amountMinor: 250000, taxMinor: 0, incurredOn: addDays(today, -9), vendor: 'Flyer printing (demo)' } });
const [cardPay] = await q(`select id from payments where org_id = $1 and method = 'card' and status = 'succeeded' order by created_at desc limit 1`, [ORG]);
if (cardPay) await must('POST', O(`/payments/${cardPay.id}/refunds`), { token: OWNER.token, body: { amountMinor: 2000, reason: 'Missing sauce (demo)', key: key('refund') } });
await must('POST', O('/payments/reconciliation/runs'), { token: STAFF.accountant.token, body: { provider: 'simulated', from: new Date(Date.now() - (DAYS + 2) * 86400_000).toISOString(), to: new Date(Date.now() + 3600_000).toISOString(), source: 'provider_api' } });
await must('POST', O('/finance/exports'), { token: STAFF.accountant.token, body: { kind: 'sales', from: addDays(today, -30), to: today, format: 'csv' } });
log(`finance: rent, utilities, salaries and POS rental for ${months.length} month(s) inside the period, 1 partial refund, a reconciliation run, a CSV export`);

// --- 14. Studio website ---------------------------------------------------------------------------------------------------------
const hero = await upload(O('/studio/media'), OWNER.token, readFileSync(path.join(ROOT, 'apps/web/public/brand/olive-interior.webp')), 'olive-interior.webp', 'image/webp', 'The Olive Room dining room');
const heroId = hero.id ?? hero.mediaId;
await must('PATCH', O('/studio/website'), { token: OWNER.token, body: { theme: { heroMediaId: heroId } } });
const site = await must('GET', O('/studio/website'), { token: OWNER.token });
const highlights = site.sections.find((x) => x.kind === 'menu_highlights');
if (highlights) await must('PATCH', O(`/studio/website/sections/${highlights.id}`), { token: OWNER.token, body: { content: { headline: { en: 'Chef’s favourites', ar: 'اختيارات الشيف' }, productIds: [seabass.id, risotto.id, chicken.id] } } });
await must('POST', O('/studio/website/publish'), { token: OWNER.token, body: { key: key('publish') } });
await must('POST', O('/studio/creative'), { token: STAFF.marketing.token, body: { kind: 'caption', locale: 'en', brief: 'Instagram caption for our seabass with lemon butter', productId: seabass.id, tone: 'premium', variants: 2 } });
await must('POST', O('/studio/creative'), { token: STAFF.marketing.token, body: { kind: 'caption', locale: 'ar', brief: 'منشور إنستجرام عن برجر سماش الكلاسيكي', productId: smash.id, tone: 'playful', variants: 2 } });
log('studio: website published with a hero photo and chef’s favourites; 2 creative drafts (template mode)');

// --- 14b. Smash & Co storefront branding (audit VP-05) -------------------------------------------------------------
// The burger branch trades under its own brand. Its name, colours, hero and copy are branch storefront data, carried
// over from the legacy /burger storefront (legacy/public/burger.js, burger.css); its menu, prices and ordering are the
// branch's own live data.
const smashHero = await upload(O('/studio/media'), OWNER.token, readFileSync(path.join(ROOT, 'supabase/seeds', seedManifest.smash.hero)), 'smash-hero.webp', 'image/webp', 'Double Smash burger (AI-generated food photography)');
const smashPromo = ['b5', 'b0', 'b8'].map((id) => PRODUCTS[id].id);   // fries, burger, cola: "Any burger + classic fries + cola"
await must('PUT', O(`/studio/storefronts/${SMASH.id}`), { token: OWNER.token, body: {
  slug: 'smash-and-co', brandName: 'Smash & Co', brandNameAr: 'سماش آند كو',
  tagline: { en: 'Smashed fresh. Served fast.', ar: 'طازج ومهروس. يُقدّم بسرعة.' },
  theme: { primaryColor: '#b51218', accentColor: '#ffd52f', inkColor: '#17120f', paperColor: '#fff8ed' },
  heroMediaId: smashHero.id ?? smashHero.mediaId,
  content: {
    headline: { en: 'Smashed fresh. Served fast.', ar: 'طازج ومهروس. يُقدّم بسرعة.' },
    body: { en: 'Lacy-edged patties, crisp fries and thick shakes. Made to order and ready when you are.', ar: 'قطع لحم بحواف مقرمشة، بطاطس ساخنة، وميلك شيك كثيف. يُحضّر عند الطلب ويجهز في وقتك.' },
    heroNote: { en: 'Made for the messy bite.', ar: 'مصنوع للقضمة الشهية.' },
    promo: { title: { en: 'The Smash combo.', ar: 'كومبو سماش.' }, body: { en: 'Any burger + classic fries + cola', ar: 'أي برجر + بطاطس كلاسيك + كولا' },
      ctaLabel: { en: 'Choose a burger', ar: 'اختر برجر' }, ctaCategoryId: categories.Burgers, productIds: smashPromo },
    sections: [
      { categoryId: categories.Burgers, eyebrow: { en: 'Our burgers', ar: 'برجرنا' }, title: { en: 'Burgers that hit different.', ar: 'برجر بطعم مختلف.' }, body: { en: '100% beef. Smashed to perfection.', ar: 'لحم بقري 100٪، مهروس بإتقان.' } },
      { categoryId: categories.Sides, title: { en: 'More to love.', ar: 'المزيد لتحبه.' }, body: { en: 'Crisp, golden, made for dipping.', ar: 'مقرمش وذهبي ومثالي للصوص.' } },
      { categoryId: categories.Shakes, title: { en: 'Shakes done right.', ar: 'ميلك شيك كما يجب.' }, body: { en: 'The perfect finish to your smash.', ar: 'الختام المثالي لوجبتك.' } },
      { categoryId: categories.Drinks, title: { en: 'Keep it cold.', ar: 'خليه بارد.' }, body: { en: 'The perfect finish to your smash.', ar: 'الختام المثالي لوجبتك.' } },
    ],
  },
  isPublished: true,
} });
log('storefront: Smash & Co branding on the burger branch (red/yellow, hero photo, combo, section copy), published at /r/the-olive-room/smash-and-co');

// --- 15. intelligence and MCP ------------------------------------------------------------------------------------------------------
await call('GET', O(`/intelligence/forecast?branchId=${MAIN.id}&horizon=14&top=5`), { token: OWNER.token });
await must('POST', O('/intelligence/insights/refresh'), { token: OWNER.token });
await must('POST', O('/intelligence/assistant'), { token: OWNER.token, body: { message: 'How much did we sell in the last 7 days?' } });
await must('POST', O('/intelligence/assistant'), { token: OWNER.token, body: { message: 'What are my top selling items this month?' } });
const mcp = await must('POST', O('/mcp/clients'), { token: OWNER.token, body: {
  name: 'Claude Desktop (demo key)', actingRole: 'manager', rateLimitPerMin: 60,
  allowedTools: ['list_orders', 'get_order', 'get_sales_summary', 'list_top_items', 'create_payment_link', 'get_approval_status'],
} });
const K = { Authorization: `Bearer ${mcp.key}` };   // shown once by the API; never printed or stored here
await must('POST', O('/mcp/tools/list_orders'), { headers: K, body: { input: { limit: 5 } } });
await must('POST', O('/mcp/tools/get_sales_summary'), { headers: K, body: { input: { from: addDays(today, -7), to: today } } });
const pending = await call('POST', O('/mcp/tools/create_payment_link'), { headers: K, body: { input: { orderId: live[0], description: 'Pay link requested by the AI client (demo)' } } });
if (pending.body?.status !== 'approval_required') throw new Error(`MCP payment link: expected approval_required, got ${JSON.stringify(pending.body).slice(0, 200)}`);
log('intelligence: forecast, insights refresh, 2 assistant questions (rules mode without a Gemini key); MCP: 1 client, 2 reads, 1 payment link awaiting approval');

await q(`update organizations set onboarding = onboarding || '{"demoLoader": "complete"}'::jsonb where id = $1`, [ORG]);
await db.end();
console.log(`\nDemo data loaded for ${SLUG} (${ORG}). Accounts: owner@${DOMAIN}, platform-admin@${DOMAIN}, <role>@${DOMAIN} (manager, kitchen, cashier, marketing, accountant, host, waiter, driver1, driver2). Passwords come from the DEMO_*_PASSWORD variables.`);
