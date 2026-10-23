#!/usr/bin/env node
// DEMO DATA for local development and the private staging environment — never production.
//
// Builds "The Olive Room" (Egypt, two branches) through the running Resuto API, the same
// calls a restaurant would make: menu, floor, staff, inventory, 8 weeks of orders, QR,
// WhatsApp (sandbox transport), deliveries, reservations, marketing, finance, Studio,
// AI and MCP. Every person and phone number is fictional and labelled "(demo)";
// every payment goes through the SIMULATED provider; nothing leaves the system.
//
// Re-running it REFRESHES the tenant relative to the new load time instead of doing nothing (audit DF-10):
//   * "live" fixtures older than 6 h (kitchen tickets, the QR visit, waiter calls, bookings that never arrived,
//     open deliveries) are completed through the API, the way staff would close them, and dated as history;
//   * the history is topped up through yesterday with the same deterministic per-day plan (and a dated restock);
//   * fixed monthly costs are upserted for every month of the period (prorated partial months, payroll month to date);
//   * fresh live fixtures are created for today, a reconciliation run covers the new period (never past now);
//   * the post-load integrity check (scripts/demo/integrity-check.mjs) must pass, or the run exits 1.
// A refresh that is interrupted (killed, crashed, redeployed) resumes on the next run without placing anything twice:
// planned history orders are identified by (date, index), and a partial set of live fixtures is completed first.
// One run at a time (lease); a concurrent run exits 3.
//
// Direct SQL is limited to what no API offers, and is listed here:
//   1. nothing for accounts: Supabase Auth users are created through the Supabase Admin Auth API
//      (service-role key, server side only); in dev-auth mode the API's dev issuer is used;
//   2. granting the demo platform-admin row (there is deliberately no API for the first admin);
//   3. marking the demo subscription active ("complimentary demo access, nothing charged");
//   4. BACK-DATING orders (and their lines, payments, allocations, events, delivery jobs, visits, calls and stock
//      movements) after they were placed or completed through the API, because the API always stamps "now";
//   5. repairing what older loaders wrote wrongly into the demo tenant: a reconciliation run whose period ended after
//      the run was made (the old loader used now + 1 h) is clamped to the time the run was made (audit DF-11);
//   6. reading ids, the loader state in organizations.onboarding, and the integrity check (read-only);
//   7. tagging each planned history order with its plan identity (orders.external_ref = demo-hist:<date>:<index>) and
//      reading idempotency_keys to find planned orders an interrupted run created, so a re-run never places them twice;
//   8. the loader's single-runner lease row in job_leases (demo-loader:<slug>; the only row outside the tenant).
// Every other statement is scoped to the demo organization's id. Nothing is ever deleted, truncated or reset.
//
// Environment (see scripts/demo/README.md):
//   API_URL                    e.g. http://127.0.0.1:4000 (no /v1)
//   DATABASE_URL               the same database the API uses
//   SUPABASE_URL + SUPABASE_PUBLISHABLE_KEY + SUPABASE_SERVICE_ROLE_KEY   real Supabase Auth (staging); omit for dev auth
//   DEMO_OWNER_PASSWORD, DEMO_ADMIN_PASSWORD, DEMO_STAFF_PASSWORD   required, never printed
//   DEMO_TARGET=staging        required for any non-local database
//   DEMO_EMAIL_DOMAIN          default olive-room.demo.test
// Arguments:
//   --demo-tenant-only         required for anything that looks like staging (non-local host, DEMO_TARGET=staging,
//                              NODE_ENV=staging): the database may hold other organizations, which are never touched.
//
// Safety (scripts/demo/lib/safety.mjs): refuses NODE_ENV=production; refuses a non-local database unless
// DEMO_TARGET=staging; refuses staging-like targets without --demo-tenant-only; without that flag, refuses any
// database that holds a non-demo organization; refuses a slug clash with a non-demo organization; refuses a tenant
// left over from an interrupted run (there is no reset path).
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { pgClientConfig } from '../db/pg-tls.mjs';
import { checkDemoIntegrity, formatIntegrity, LIVE_STALE_HOURS } from './integrity-check.mjs';
import { fixedCostSchedule } from './lib/fixed-costs.mjs';
import { DEMO_FLOORS, withArchitecture } from './lib/floor-architecture.mjs';
import { SMASH_PREP_MINUTES, smashBranchPatch } from './lib/storefront-signals.mjs';
import { addDays, daysFrom, historyTag, planRange } from './lib/plan.mjs';
import { claimLease, releaseLease, RENEW_SECONDS, renewLease } from './lib/lease.mjs';
import { decideAction, decideTarget } from './lib/safety.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const env = process.env;
const ARGV = process.argv.slice(2);
const API = `${(env.API_URL ?? 'http://127.0.0.1:4000').replace(/\/$/, '')}/v1`;
const SLUG = 'the-olive-room';
const DOMAIN = env.DEMO_EMAIL_DOMAIN ?? 'olive-room.demo.test';
const SUPABASE = env.SUPABASE_URL ? { url: env.SUPABASE_URL.replace(/\/$/, ''), key: env.SUPABASE_PUBLISHABLE_KEY, admin: env.SUPABASE_SERVICE_ROLE_KEY } : null;
const DAYS = Number(env.DEMO_HISTORY_DAYS ?? 56);

function fail(message) { console.error(`demo loader: ${message}`); process.exit(1); }
if (ARGV.includes('--help')) {
  console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').filter((l) => l.startsWith('//')).map((l) => l.slice(3)).join('\n'));
  process.exit(0);
}
const target = decideTarget({ env, argv: ARGV, dbUrl: env.DATABASE_URL });
if (target.refuse) fail(target.refuse);
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
async function admin(method, p, body) {
  const headers = { apikey: SUPABASE.admin, 'Content-Type': 'application/json' };
  if (SUPABASE.admin.startsWith('eyJ')) headers.Authorization = `Bearer ${SUPABASE.admin}`;
  const res = await fetch(`${SUPABASE.url}/auth/v1${p}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
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

/** Creates (or re-passwords) a confirmed account and returns { email, userId, token }. Only demo-domain accounts. */
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

const STAFF_DEFS = (MAIN) => [
  ['manager', 'Karim Manager', null], ['kitchen', 'Hoda Kitchen', [MAIN.id]], ['cashier', 'Sami Cashier', null],
  ['marketing', 'Laila Marketing', null], ['accountant', 'Tarek Accountant', null], ['host', 'Nadia Host', [MAIN.id]], ['waiter', 'Youssef Waiter', [MAIN.id]],
  ['driver', 'Omar Driver', [MAIN.id]], ['driver', 'Mahmoud Driver', [MAIN.id]],
];
const localFor = (role, i, defs) => (role === 'driver' ? `driver${defs.slice(0, i).filter(([r]) => r === 'driver').length + 1}` : role);

// --- shared static data --------------------------------------------------------------------------
const fixture = JSON.parse(readFileSync(path.join(ROOT, 'tools/legacy-migration/fixtures/olive-room.legacy-state.json'), 'utf8')).state.menu;
const seedManifest = JSON.parse(readFileSync(path.join(ROOT, 'supabase/seeds/olive-room.demo.json'), 'utf8'));
export const CATEGORY_AR = seedManifest.categoryNamesAr;   // shared with the legacy seed (scripts/db/seed.mjs)
const ITEM_DEFS = [   // name, unit, cost/unit, reorder level, supplier key
  ['Beef patty mix', 'kg', 42000, 4, 'meat'], ['Chicken breast', 'kg', 21000, 4, 'meat'], ['Seabass fillet', 'kg', 52000, 2, 'meat'],
  ['Potatoes', 'kg', 1800, 15, 'produce'], ['Tomatoes', 'kg', 2200, 6, 'produce'], ['Arborio rice', 'kg', 9500, 3, 'produce'],
  ['Brioche buns', 'pcs', 650, 40, null], ['Frying oil', 'l', 9500, 10, null], ['Burrata', 'pcs', 6500, 6, null], ['Mushrooms', 'kg', 16000, 2, 'produce'],
];
// Arabic names of the ingredients: the inventory reads in Arabic on Arabic pages (gallery PAR-06).
const ITEM_AR = {
  'Beef patty mix': 'خلطة لحم البرجر', 'Chicken breast': 'صدور دجاج', 'Seabass fillet': 'فيليه قاروص', Potatoes: 'بطاطس', Tomatoes: 'طماطم',
  'Arborio rice': 'أرز أربوريو', 'Brioche buns': 'خبز بريوش', 'Frying oil': 'زيت قلي', Burrata: 'جبنة بوراتا', Mushrooms: 'مشروم',
};
// Quantities in the item's base unit (kg, l, pcs) per portion.
const RECIPES = {
  'Classic Smash': [['Beef patty mix', 0.15], ['Brioche buns', 1]], 'Double Smash': [['Beef patty mix', 0.3], ['Brioche buns', 1]],
  'Classic Fries': [['Potatoes', 0.25], ['Frying oil', 0.04]], 'Loaded Fries': [['Potatoes', 0.3], ['Frying oil', 0.04]],
  'Grilled chicken supreme': [['Chicken breast', 0.25]], 'Seabass with lemon butter': [['Seabass fillet', 0.22]],
  'Wild mushroom risotto': [['Arborio rice', 0.12], ['Mushrooms', 0.08]], 'Burrata & heirloom tomato': [['Burrata', 1], ['Tomatoes', 0.15]],
};
const unitOf = Object.fromEntries(ITEM_DEFS.map(([n, u]) => [n, u]));
const reorderOf = Object.fromEntries(ITEM_DEFS.map(([n, , , r]) => [n, r]));

/** Runtime context shared by the sections (ids and tokens; never printed). */
const C = { ORG: null, MAIN: null, SMASH: null, OWNER: null, STAFF: {}, ADMIN: null, PRODUCTS: {}, categories: {}, ITEMS: {}, today: null };
const O = (p) => `/o/${C.ORG}${p}`;
const menuOf = (branch) => Object.values(C.PRODUCTS).filter((p) => p.branch === branch);
const byName = (re) => Object.values(C.PRODUCTS).find((p) => re.test(p.name));
const productById = (id) => Object.values(C.PRODUCTS).find((p) => p.id === id);
const line = (p, quantity = 1) => ({ productId: p.id, quantity });
const setState = (patch) => q(`update organizations set onboarding = onboarding || $2::jsonb where id = $1`, [C.ORG, JSON.stringify(patch)]);

// --- 1. owner, restaurant, branches (first load) ----------------------------------------------------
async function createTenant() {
  C.OWNER = await account('owner', 'Demo Owner (demo)', env.DEMO_OWNER_PASSWORD);
  const org = await must('POST', '/orgs', { token: C.OWNER.token, body: {
    name: 'The Olive Room', nameAr: 'غرفة الزيتون', slug: SLUG, country: 'EG', planId: 'pro', defaultLocale: 'ar',
    branch: { name: 'Zamalek, Cairo', nameAr: 'الزمالك، القاهرة', code: 'main', address: '14 26th of July St, Zamalek', city: 'Cairo', acceptsDelivery: true, deliveryFeeMinor: 3000 },
  } });
  C.ORG = org.id;
  await setState({ demo: true, demoLoader: 'started' });
  const smashBranch = await must('POST', O('/branches'), { token: C.OWNER.token, body: { name: 'Smash & Co', nameAr: 'سماش آند كو', code: 'burger', address: '9 Champollion St, Downtown', city: 'Cairo', acceptsDelivery: true, deliveryFeeMinor: 2500 } });
  C.MAIN = { id: org.branchId, code: 'main' };
  C.SMASH = { id: smashBranch.id, code: 'burger' };
  await must('PATCH', O(`/branches/${C.MAIN.id}`), { token: C.OWNER.token, body: { latitude: 30.0626, longitude: 31.2197 } });
  await must('PATCH', O(`/branches/${C.SMASH.id}`), { token: C.OWNER.token, body: { latitude: 30.0478, longitude: 31.2393 } });
  // Complimentary demo access: the Pro plan stays active for the review; nothing is charged.
  const [sub] = await q(`update subscriptions set status = 'active' where org_id = $1 and status <> 'canceled' returning id`, [C.ORG]);
  if (sub) await q(`insert into subscription_events(org_id, subscription_id, event_type, to_plan_id, details) values ($1, $2, 'demo_complimentary', 'pro', $3)`,
    [C.ORG, sub.id, { note: 'Demo data: complimentary access, nothing charged, no billing provider.' }]);
  log(`restaurant ${SLUG} (${C.ORG}) with branches Zamalek (fine dining) and Smash & Co (burgers)`);

  // --- 2. staff and platform admin
  const defs = STAFF_DEFS(C.MAIN);
  for (const [i, [role, name, branches]] of defs.entries()) {
    const local = localFor(role, i, defs);
    const user = await account(local, `${name} (demo)`, env.DEMO_STAFF_PASSWORD);
    const inv = await must('POST', O('/invitations'), { token: C.OWNER.token, body: { email: user.email, role, branchIds: branches } });
    await must('POST', '/invitations/accept', { token: user.token, body: { token: inv.token } });
    C.STAFF[local] = user;
  }
  C.ADMIN = await account('platform-admin', 'Platform admin (demo)', env.DEMO_ADMIN_PASSWORD);
  await q(`insert into platform_admins(user_id, role) values ($1, 'superadmin') on conflict (user_id) do nothing`, [C.ADMIN.userId]);
  log('staff: manager, kitchen, cashier, marketing, accountant, host, waiter, 2 drivers; 1 platform superadmin');

  // --- 3. tax profile (ETA pre-production structure; validation is not certification)
  await must('PUT', O('/compliance/tax-profile'), { token: C.STAFF.accountant.token, body: {
    vatNumber: '100200300', registeredName: 'The Olive Room (demo) LLC',
    registeredAddress: { governate: 'Cairo', regionCity: 'Zamalek', street: '26th of July St', buildingNumber: '14' },
    etaActivityCode: '5610', etaBranchCode: '0', etaPosSerial: 'DEMO-POS-001', etaEnvironment: 'preprod',
  } });

  // --- 4. menu (from the legacy demo fixture: names, Arabic names, prices, stations)
  for (const name of [...new Set(fixture.map((m) => m.category))]) {
    C.categories[name] = (await must('POST', O('/menu/categories'), { token: C.OWNER.token, body: { name, nameAr: CATEGORY_AR[name] ?? null } })).id;
  }
  const costRatio = (m) => (/Drinks|Shakes/.test(m.category) ? 0.22 : m.category === 'Sides' ? 0.25 : 0.32);
  for (const m of fixture) {
    const p = await must('POST', O('/menu/products'), { token: C.OWNER.token, body: {
      categoryId: C.categories[m.category], name: m.name, nameAr: m.nameAr ?? null, description: m.description ?? null, descriptionAr: m.descriptionAr ?? null,
      priceMinor: m.price, costMinor: Math.round((m.price * costRatio(m)) / 50) * 50, station: m.station, allergens: m.allergens ?? [], dietary: m.dietary ?? [],
      prepMinutes: m.prepMinutes ?? null, spiceLevel: m.spice ?? 0,
    } });
    const branch = m.branchIds?.includes('burger') ? C.SMASH : C.MAIN;
    const other = branch === C.MAIN ? C.SMASH : C.MAIN;
    // Each branch serves its own menu: the other branch does not offer this dish.
    await must('PUT', O(`/menu/products/${p.id}/branches/${other.id}`), { token: C.OWNER.token, body: { isAvailable: false } });
    C.PRODUCTS[m.id] = { id: p.id, name: m.name, category: m.category, branch, priceMinor: m.price };
  }
  // Every dish has its own photo: the eight Zamalek dishes (m0–m7, cut from the legacy menu photography) and the nine
  // Smash & Co items (b0–b8, the legacy storefront's photography in supabase/seeds/media/smash). No dish falls back to a
  // shared sprite (audits VP-04, DF-08).
  for (const [legacyId, rel] of [...Object.entries(seedManifest.photos), ...Object.entries(seedManifest.smash.photos)]) {
    if (legacyId.startsWith('_') || !C.PRODUCTS[legacyId]) continue;
    await upload(O(`/menu/products/${C.PRODUCTS[legacyId].id}/image`), C.OWNER.token, readFileSync(path.join(ROOT, 'supabase/seeds', rel)), `${legacyId}.webp`, 'image/webp', C.PRODUCTS[legacyId].name);
  }
  const extras = await must('POST', O('/menu/modifier-groups'), { token: C.OWNER.token, body: { name: 'Extras', nameAr: 'إضافات', minSelect: 0, maxSelect: 2 } });
  for (const [name, nameAr, price] of [['Extra cheese', 'جبنة إضافية', 1500], ['Jalapeños', 'هالابينو', 1000]]) {
    await must('POST', O(`/menu/modifier-groups/${extras.id}/options`), { token: C.OWNER.token, body: { name, nameAr, priceDeltaMinor: price } });
  }
  for (const p of Object.values(C.PRODUCTS).filter((x) => x.category === 'Burgers')) {
    await must('PUT', O(`/menu/products/${p.id}/modifier-groups`), { token: C.OWNER.token, body: { groupIds: [extras.id] } });
  }
  log(`menu: ${Object.keys(C.categories).length} categories (Arabic names), ${fixture.length} dishes with photos, burger extras`);

  // --- 5. floor plans
  // Tables and zones inside the legacy room architecture: walls, windows, the service bar and the entrance (PAR-01).
  for (const branch of [C.MAIN, C.SMASH]) {
    const code = branch === C.MAIN ? 'main' : 'burger';
    const cur = await must('GET', O(`/floor/${branch.id}`), { token: C.OWNER.token });
    await must('PUT', O(`/floor/${branch.id}`), { token: C.OWNER.token, body: { baseRevision: cur.revision, key: key('floor'), layout: {
      width: 1200, height: 800, background: { image: null, opacity: 0.4, locked: true, x: 0, y: 0, width: 1200, height: 800 },
      zones: DEMO_FLOORS[code].zones, objects: withArchitecture([], code).objects, tables: DEMO_FLOORS[code].tables,
    } } });
  }

  // --- 7. inventory: suppliers, items, recipes (opening stock is booked with the history)
  const suppliers = {
    produce: (await must('POST', O('/inventory/suppliers'), { token: C.OWNER.token, body: { name: 'Delta Fresh Produce (demo)', phone: '+20223450001' } })).id,
    meat: (await must('POST', O('/inventory/suppliers'), { token: C.OWNER.token, body: { name: 'Nile Meats (demo)', phone: '+20223450002' } })).id,
  };
  for (const [name, unit, cost, reorder, sup] of ITEM_DEFS) {
    C.ITEMS[name] = (await must('POST', O('/inventory/items'), { token: C.OWNER.token, body: { name, nameAr: ITEM_AR[name] ?? null, unit, costPerUnitMinor: cost, reorderLevel: reorder, ...(sup ? { supplierId: suppliers[sup] } : {}) } })).id;
  }
  for (const [dish, comps] of Object.entries(RECIPES)) {
    const p = byName(new RegExp(`^${dish.replace(/[&()]/g, '.')}$`));
    if (p) await must('PUT', O(`/inventory/recipes/${p.id}`), { token: C.OWNER.token, body: { components: comps.map(([item, qty]) => ({ itemId: C.ITEMS[item], quantity: qty, unit: unitOf[item] })) } });
  }
  log(`inventory: 2 suppliers, ${ITEM_DEFS.length} items, ${Object.keys(RECIPES).length} recipes`);
}

// --- context for a refresh (the tenant exists) -----------------------------------------------------
async function loadContext(orgId) {
  C.ORG = orgId;
  C.OWNER = await account('owner', 'Demo Owner (demo)', env.DEMO_OWNER_PASSWORD);
  const branches = await q(`select id, code from branches where org_id = $1`, [orgId]);
  C.MAIN = { id: branches.find((b) => b.code === 'main').id, code: 'main' };
  C.SMASH = { id: branches.find((b) => b.code === 'burger').id, code: 'burger' };
  const defs = STAFF_DEFS(C.MAIN);
  for (const [i, [role, name]] of defs.entries()) {
    const local = localFor(role, i, defs);
    C.STAFF[local] = await account(local, `${name} (demo)`, env.DEMO_STAFF_PASSWORD);
  }
  C.ADMIN = await account('platform-admin', 'Platform admin (demo)', env.DEMO_ADMIN_PASSWORD);
  for (const c of await q(`select id, name from menu_categories where org_id = $1`, [orgId])) C.categories[c.name] = c.id;
  const products = await q(`select id, name from products where org_id = $1 and is_active`, [orgId]);
  for (const m of fixture) {
    const p = products.find((x) => x.name === m.name);
    if (p) C.PRODUCTS[m.id] = { id: p.id, name: m.name, category: m.category, branch: m.branchIds?.includes('burger') ? C.SMASH : C.MAIN, priceMinor: m.price };
  }
  for (const i of await q(`select id, name from inventory_items where org_id = $1`, [orgId])) C.ITEMS[i.name] = i.id;
}

// --- 8. order history (placed through the API, then back-dated) ---------------------------------------
async function advance(orderId, to, token = C.STAFF.manager.token) {
  for (const s of to) await must('POST', O(`/orders/${orderId}/transition`), { token, body: { to: s } });
}
async function backdate(orderId, date, hour, minute) {
  await q(`with t as (select (($2::date + make_interval(hours => $3, mins => $4)) at time zone 'Africa/Cairo') as at)
    update orders o set business_date = $2::date, placed_at = t.at, created_at = t.at,
      -- Order numbers restart per branch and business day; the API numbered this order on the day the loader ran, which
      -- can collide with an order already on the target day (live fixtures of that day, earlier history), so it takes
      -- the next free number there.
      number = case when o.business_date = $2::date then o.number
                    else (coalesce((select max(x.number::bigint) from orders x where x.branch_id = o.branch_id and x.business_date = $2::date
                                    and x.id <> o.id and x.number ~ '^[0-9]+$'), 0) + 1)::text end,
      accepted_at = case when o.accepted_at is null then null else t.at + interval '2 min' end,
      ready_at = case when o.ready_at is null then null else t.at + interval '16 min' end,
      fulfilled_at = case when o.fulfilled_at is null then null else t.at + interval '22 min' end,
      cancelled_at = case when o.cancelled_at is null then null else t.at + interval '5 min' end,
      updated_at = t.at + interval '22 min'
    from t where o.id = $1 and o.org_id = $5`, [orderId, date, hour, minute, C.ORG]);
  await settleTimeline([orderId]);
  await q(`update stock_movements m set created_at = o.placed_at + interval '15 min' from orders o where o.id = $1 and o.org_id = $2 and m.org_id = $2 and m.reference_id = $1::text`, [orderId, C.ORG]);
}
/**
 * Re-dates everything that hangs off an order relative to its placed_at (lines, payments, allocations, events, delivery
 * job and its events) — used after back-dating an order and after completing a stale live order through the API.
 */
async function settleTimeline(orderIds) {
  if (!orderIds.length) return;
  const p = [orderIds, C.ORG];
  await q(`update orders o set accepted_at = case when o.accepted_at is null then null else o.placed_at + interval '2 min' end,
      ready_at = case when o.ready_at is null then null else o.placed_at + interval '16 min' end,
      fulfilled_at = case when o.fulfilled_at is null then null
                          else o.placed_at + case o.fulfillment when 'delivery' then interval '48 min' when 'dine_in' then interval '55 min' else interval '22 min' end end,
      cancelled_at = case when o.cancelled_at is null then null else o.placed_at + interval '5 min' end,
      updated_at = o.placed_at + interval '60 min'
    where o.id = any($1::uuid[]) and o.org_id = $2`, p);
  await q(`update order_lines l set created_at = o.placed_at,
      kitchen_started_at = case when l.kitchen_started_at is null then null else o.placed_at + interval '3 min' end,
      kitchen_ready_at = case when l.kitchen_ready_at is null then null else o.placed_at + interval '15 min' end,
      updated_at = o.placed_at + interval '22 min' from orders o where o.id = l.order_id and o.id = any($1::uuid[]) and o.org_id = $2 and l.org_id = $2`, p);
  await q(`update payments pm set created_at = o.placed_at + interval '20 min', captured_at = case when pm.captured_at is null then null else o.placed_at + interval '21 min' end,
      updated_at = o.placed_at + interval '21 min'
    from orders o where o.org_id = $2 and pm.org_id = $2 and o.id = any($1::uuid[])
      and (pm.order_id = o.id or pm.id in (select a.payment_id from payment_allocations a where a.order_id = o.id))
      and pm.created_at > o.placed_at + interval '20 min'`, p);
  // Online checkout sessions open with their order (the guest pays from the order page). Fiscal documents are NOT
  // re-dated: they are immutable and hash-chained (issued_at is inside the hash and the QR payload), so a receipt shows
  // when it was really issued; see scripts/demo/README.md.
  await q(`update checkout_sessions s set created_at = o.placed_at, expires_at = o.placed_at + (s.expires_at - s.created_at),
      paid_at = case when s.paid_at is null then null else o.placed_at + interval '21 min' end
    from orders o where s.order_id = o.id and o.id = any($1::uuid[]) and o.org_id = $2 and s.org_id = $2
      and s.created_at > o.placed_at + interval '20 min'`, p);
  await q(`update payment_allocations a set created_at = o.placed_at + interval '21 min' from orders o
    where a.order_id = o.id and o.id = any($1::uuid[]) and o.org_id = $2 and a.org_id = $2`, p);
  await q(`update order_events e set created_at = o.placed_at + make_interval(secs => 60 + 30 * r.n)
    from orders o, (select id, row_number() over (partition by order_id order by id) as n from order_events where order_id = any($1::uuid[]) and org_id = $2) r
    where e.id = r.id and o.id = e.order_id and o.org_id = $2 and e.org_id = $2`, p);
  await q(`update delivery_jobs j set created_at = o.placed_at + interval '1 min',
      assigned_at = case when j.assigned_at is null then null else o.placed_at + interval '4 min' end,
      accepted_at = case when j.accepted_at is null then null else o.placed_at + interval '6 min' end,
      picked_up_at = case when j.picked_up_at is null then null else o.placed_at + interval '20 min' end,
      delivered_at = case when j.delivered_at is null then null else o.placed_at + interval '48 min' end,
      updated_at = o.placed_at + interval '48 min'
    from orders o where j.order_id = o.id and o.id = any($1::uuid[]) and o.org_id = $2 and j.org_id = $2`, p);
  await q(`update delivery_events e set created_at = j.created_at + make_interval(secs => 60 * r.n)
    from delivery_jobs j, (select id, row_number() over (partition by job_id order by id) as n from delivery_events
                           where org_id = $2 and job_id in (select id from delivery_jobs where order_id = any($1::uuid[]) and org_id = $2)) r
    where e.id = r.id and e.job_id = j.id and j.org_id = $2 and e.org_id = $2`, p).catch(() => undefined);   // older schemas: no delivery_events
}

/**
 * History orders are idempotent per planned order (date, index): the creation request uses the order's tag as its
 * Idempotency-Key and the order is tagged (orders.external_ref) right after it is created, so a refresh that was
 * interrupted finds what it already placed and only completes it, instead of placing the day again.
 */
const PAID = ['paid', 'partially_refunded', 'refunded'];
/** Tags a freshly created planned order; fails loudly if the API handed back an order that belongs to another plan entry. */
async function tagOrder(orderId, tag) {
  const [t] = await q(`update orders set external_ref = coalesce(external_ref, $2) where id = $1 and org_id = $3 returning external_ref`, [orderId, tag, C.ORG]);
  if (t?.external_ref !== tag) throw new Error(`history: the API returned order ${orderId} (tag ${t?.external_ref ?? 'none'}) for planned order ${tag}`);
}
const webOrderBody = (o, branch) => ({
  branchId: branch.id, fulfillment: 'pickup', payment: o.online ? 'online' : 'pay_at_pickup', lines: o.lines,
  customer: o.customer ? { name: o.customer.name, phone: o.customer.phone, marketingConsent: o.customer.consent } : { name: 'Website guest (demo)', phone: o.walkInPhone },
});
// The transfer reference is derived from the order, so a resumed collect repeats the same request (same key, same body).
const collectBody = (o, orderId) => (o.transfer ? { method: 'instapay', reference: `DEMO-IP-${orderId}` } : { method: 'cash' });
async function payCheckout(url) {
  const tok = url.split('/pay/')[1];
  await must('POST', `/public/pay/${tok}/start`, { body: { method: 'card' } });
  await must('POST', `/public/pay/${tok}/sandbox/complete`, { body: { outcome: 'success' } });
}

/** Planned orders of `plan` that already exist: tagged orders, plus orders whose creation committed before the tag. */
async function findPlanned(plan) {
  const tags = plan.map(historyTag);
  const found = new Map((await q(`select external_ref as tag, id from orders where org_id = $1 and external_ref = any($2::text[])`, [C.ORG, tags])).map((r) => [r.tag, r.id]));
  for (const k of await q(`select key, response->'value'->>'id' as id from idempotency_keys
                            where org_id = $1 and scope in ('staff-order', 'web-order') and key = any($2::text[]) and response is not null`, [C.ORG, tags])) {
    if (found.has(k.key) || !k.id) continue;
    // An order the interrupted run created but could not tag yet is adopted (tagOrder refuses one that carries another tag).
    await tagOrder(k.id, k.key);
    found.set(k.key, k.id);
  }
  return found;
}

/** Creates a planned order through the API (website or counter, paid the planned way) and tags it. */
async function createHistoric(o) {
  const branch = o.branch === 'smash' ? C.SMASH : C.MAIN;
  const cashier = C.STAFF.cashier.token;
  const tag = historyTag(o);
  if (o.web) {
    // Website order. The public endpoint limits orders per phone per minute; a regular who hits it is served at the counter instead.
    const r = await call('POST', `/public/order/${SLUG}/orders`, { headers: { 'Idempotency-Key': tag }, body: webOrderBody(o, branch) });
    if (r.status < 300) {
      const orderId = r.body.order.id;
      await tagOrder(orderId, tag);
      if (o.online) await payCheckout(r.body.checkout.url);
      else await must('POST', O(`/orders/${orderId}/collect`), { token: cashier, headers: { 'Idempotency-Key': `${tag}:collect` }, body: { method: 'cash' } });
      return orderId;
    }
    // Smash & Co publishes opening hours (PAR-02) and the storefront checks them against the clock of the run, not the
    // back-dated hour: a run while it is closed is refused like a rate-limited regular. Both are entered at the counter
    // here and keep their planned website channel in completeHistoric(), so the history's channel mix does not depend on
    // when the loader ran (such an order is paid at pickup).
    if (r.status !== 429 && r.body?.error?.code !== 'branch_closed') throw new Error(`web order ${r.status} ${JSON.stringify(r.body)}`);
  }
  const r = await must('POST', O('/orders'), { token: cashier, headers: { 'Idempotency-Key': tag }, body: {
    branchId: branch.id, fulfillment: 'pickup', lines: o.lines, customer: o.customer ? { name: o.customer.name, phone: o.customer.phone } : { name: 'Walk-in (demo)' },
  } });
  await tagOrder(r.id, tag);
  // Transfers need the reference staff verified (PAY-19); demo references are labelled and unique.
  if (!o.cancel) await must('POST', O(`/orders/${r.id}/collect`), { token: cashier, headers: { 'Idempotency-Key': `${tag}:collect` }, body: collectBody(o, r.id) });
  return r.id;
}

/**
 * Takes a planned order, new or left half-done by an interrupted run, to its planned end state (cancelled, or paid and
 * picked up) and back-dates it. Every step checks the order first, and payments reuse the order's deterministic keys.
 */
async function completeHistoric(orderId, o) {
  const tag = historyTag(o);
  // A planned website order the storefront refused at run time (closed now, or the per-phone rate limit) was entered at
  // the counter by createHistoric(); it stays a website order in the history. Also covers a run interrupted before this.
  if (o.web) await q(`update orders set channel = 'web' where id = $1 and org_id = $2 and channel = 'staff' and external_ref = $3`, [orderId, C.ORG, tag]);
  let detail = await must('GET', O(`/orders/${orderId}`), { token: C.OWNER.token });
  if (detail.status === 'awaiting_payment' && o.web && o.online) {
    // Interrupted between ordering and paying online: the same request (same key) returns the order with a fresh link.
    const r = await call('POST', `/public/order/${SLUG}/orders`, { headers: { 'Idempotency-Key': tag }, body: webOrderBody(o, o.branch === 'smash' ? C.SMASH : C.MAIN) });
    if (r.status < 300 && r.body.order.id === orderId && r.body.checkout?.url) await payCheckout(r.body.checkout.url).catch(() => undefined);
    detail = await must('GET', O(`/orders/${orderId}`), { token: C.OWNER.token });
  }
  if (!['cancelled', 'picked_up'].includes(detail.status)) {
    const unpaid = !PAID.includes(detail.paymentStatus);
    const cancelled = unpaid && (o.cancel || detail.status === 'awaiting_payment')
      && (await call('POST', O(`/orders/${orderId}/cancel`), { token: C.STAFF.manager.token, body: { reason: 'Customer changed plans (demo)', version: detail.version } })).status < 300;
    if (!cancelled) {
      if (unpaid) {
        await must('POST', O(`/orders/${orderId}/collect`), { token: C.STAFF.cashier.token, headers: { 'Idempotency-Key': `${tag}:collect` },
          body: o.web ? { method: 'cash' } : collectBody(o, orderId) });
      }
      const steps = ['accepted', 'preparing', 'ready', 'picked_up'];
      await advance(orderId, steps.slice(steps.indexOf(detail.status) + 1));
    }
  }
  await backdate(orderId, o.date, o.hour, o.minute);
}

/** Books stock that covers `plan` (sized so the running balance never goes below the buffer), dated before it. */
async function bookStock(plan, at, note) {
  const usage = {};   // `${branchId}:${item}` → planned consumption
  for (const o of plan) for (const l of o.lines) {
    const branchId = o.branch === 'smash' ? C.SMASH.id : C.MAIN.id;
    for (const [item, qty] of RECIPES[productById(l.productId)?.name] ?? []) usage[`${branchId}:${item}`] = (usage[`${branchId}:${item}`] ?? 0) + qty * l.quantity;
  }
  const levels = Object.fromEntries((await q(`select branch_id || ':' || item_id as k, quantity::float8 as q from stock_levels where org_id = $1`, [C.ORG])).map((r) => [r.k, r.q]));
  let booked = 0;
  for (const [k, used] of Object.entries(usage)) {
    const [branchId, item] = k.split(':');
    const have = levels[`${branchId}:${C.ITEMS[item]}`] ?? 0;
    // Planned sales + a buffer above the reorder level, minus what is still on the shelf.
    const quantity = Math.ceil((used + reorderOf[item] * 2.5 - have) * 10) / 10;
    if (quantity <= 0) continue;
    const m = await must('POST', O('/inventory/movements'), { token: C.OWNER.token, body: { kind: 'purchase', branchId, itemId: C.ITEMS[item], quantity, note } });
    await q(`update stock_movements set created_at = $2 where id = $1::bigint and org_id = $3`, [m.movementId, at, C.ORG]);
    booked++;
  }
  return booked;
}

/** History for the business days [from, to]: stock first (dated the morning before), then the orders. */
async function placeHistory(from, to, historyFrom, first) {
  if (from > to) return 0;
  const plan = planRange({ from, to, historyFrom, historyDays: DAYS, menus: { main: menuOf(C.MAIN), smash: menuOf(C.SMASH) } });
  // An interrupted earlier run may have placed part of this range already: those orders are completed, not placed again.
  const existing = await findPlanned(plan);
  const todo = plan.filter((o) => !existing.has(historyTag(o)));
  const stockAt = `${addDays(from, -1)}T09:00:00+02:00`;
  const booked = todo.length ? await bookStock(todo, stockAt, first ? 'Opening stock (demo)' : `Restock for ${from}..${to} (demo)`) : 0;
  if (first) {
    // Waste records inside the history (not at load time).
    for (const [name, qty, reason, note, d] of [['Tomatoes', 1.5, 'spoiled', 'Overripe batch (demo)', 12], ['Burrata', 2, 'expired', 'Past date (demo)', 5]]) {
      const m = await must('POST', O('/inventory/movements'), { token: C.OWNER.token, body: { kind: 'waste', branchId: C.MAIN.id, itemId: C.ITEMS[name], quantity: qty, reason, note } });
      await q(`update stock_movements set created_at = $2 where id = $1::bigint and org_id = $3`, [m.movementId, `${addDays(to, -d)}T23:00:00+02:00`, C.ORG]);
    }
  }
  for (const o of plan) await completeHistoric(existing.get(historyTag(o)) ?? await createHistoric(o), o);
  // Self-check: every planned order exists exactly once.
  const counts = new Map((await q(`select external_ref as tag, count(*)::int as n from orders where org_id = $1 and external_ref = any($2::text[]) group by 1`,
    [C.ORG, plan.map(historyTag)])).map((r) => [r.tag, r.n]));
  const wrong = plan.map(historyTag).filter((t) => counts.get(t) !== 1);
  if (wrong.length) throw new Error(`history self-check: planned order(s) missing or duplicated: ${wrong.slice(0, 5).join(', ')}`);
  await q(`update customers c set first_seen_at = least(c.first_seen_at, s.first), created_at = least(c.created_at, s.first), last_seen_at = greatest(s.last, least(c.last_seen_at, now()))
           from (select customer_id, min(placed_at) as first, max(placed_at) as last from orders where org_id = $1 and customer_id is not null group by 1) s
           where c.id = s.customer_id and c.org_id = $1`, [C.ORG]);
  log(`history: ${plan.length} orders for ${from}..${to} (website and counter), placed through the API, then back-dated`
    + `${existing.size ? ` (${existing.size} already placed by an interrupted run: completed, not placed again)` : ''}; ${booked} stock purchase(s) dated ${stockAt.slice(0, 10)}`);
  return plan.length;
}

// --- 9–11. live fixtures for today: kitchen, QR dine-in, reservations, WhatsApp, delivery ----------------------
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082', 'hex');
const D = (p) => O(`/driver${p}`), M = (p) => O(`/delivery${p}`);
const jobOf = async (orderId) => {
  for (let i = 0; i < 60; i++) {   // the worker creates delivery jobs from the outbox
    const [j] = await q(`select id from delivery_jobs where order_id = $1 and org_id = $2`, [orderId, C.ORG]);
    if (j) return j.id;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`no delivery job for ${orderId}: is the worker running?`);
};
async function drivers() {
  const fleet = await must('GET', M('/drivers'), { token: C.STAFF.manager.token });
  const list = [C.STAFF.driver1, C.STAFF.driver2].map((d) => ({ ...d, driverId: fleet.items.find((x) => x.userId === d.userId).id }));
  for (const d of list) await call('PATCH', D('/me/availability'), { token: d.token, body: { availability: 'available' } });
  return list;
}
async function kitchenTo(orderId, statuses) {
  for (const to of statuses) await must('POST', O(`/kitchen/orders/${orderId}/bump`), { token: C.STAFF.kitchen.token, body: { to } });
}
async function deliverJob(job, driver, codMinor, recipient) {
  const photo = await upload(D(`/jobs/${job}/proof-photo`), driver.token, PNG, 'door.png', 'image/png');
  await must('POST', D(`/jobs/${job}/deliver`), { token: driver.token, headers: { 'Idempotency-Key': key('deliver') },
    body: { proofMediaId: photo.mediaId, recipientName: recipient, cashCollectedMinor: codMinor, latitude: 30.0601, longitude: 31.2185 } });
  if (codMinor > 0) await must('POST', M('/settlements'), { token: C.STAFF.manager.token, body: { driverId: driver.driverId, jobIds: [job], amountMinor: codMinor, note: 'End of shift (demo)' } });
}

async function createLive() {
  // Marks the start: a run interrupted before demoLiveAt is written left a partial set, which the next run retires first.
  await setState({ demoLiveStartedAt: new Date().toISOString() });
  const chicken = byName(/Grilled chicken/), soup = byName(/pumpkin soup/), hibiscus = byName(/Hibiscus/), risotto = byName(/risotto/), seabass = byName(/Seabass/);
  const live = [];
  for (const [lines, to, who, notes] of [
    [[line(chicken, 2), line(soup)], [], 'Mona Adel (demo)', 'No onions please (demo)'],
    [[line(risotto), line(hibiscus, 2)], ['accepted', 'preparing'], 'Ahmed Hassan (demo)', undefined],
    [[line(seabass), line(soup)], ['accepted', 'preparing', 'ready'], 'Sara Fouad (demo)', undefined],
  ]) {
    const r = await must('POST', O('/orders'), { token: C.STAFF.cashier.token, headers: { 'Idempotency-Key': key('live') }, body: { branchId: C.MAIN.id, fulfillment: 'pickup', lines, customer: { name: who }, notes } });
    await advance(r.id, to, C.STAFF.kitchen.token);
    live.push(r.id);
  }
  const qrSheet = await must('GET', O(`/floor/${C.MAIN.id}/qr`), { token: C.OWNER.token });
  const qrFor = (label) => qrSheet.items.find((x) => x.label === label).url.split('/t/')[1];
  // A guest scans T2 (the legacy demo's table) unless the API keeps it free for a booking starting soon or a party
  // already sits there; then the next free table is used, as a real guest would be seated elsewhere.
  let sess = null;
  let qrTable = null;
  for (const label of ['T2', ...qrSheet.items.map((x) => x.label).filter((l) => l !== 'T2')]) {
    const r = await call('POST', `/public/tables/${qrFor(label)}/session`);
    if (r.status < 300) { sess = r.body; qrTable = label; break; }
    if (r.status !== 409) throw new Error(`POST /public/tables/<${label}>/session → ${r.status} ${JSON.stringify(r.body).slice(0, 300)}`);
  }
  if (!sess) throw new Error('no table is free for the demo QR visit');
  const V = { 'X-Visit-Token': sess.token };
  await must('POST', '/public/visits/current/orders', { headers: { ...V, 'Idempotency-Key': key('qr') }, body: { lines: [line(chicken, 2), line(hibiscus, 2)], notes: 'Birthday table (demo)' } });
  await must('POST', '/public/visits/current/requests', { headers: V, body: { kind: 'waiter' } });
  let booked = 0;
  for (const [days, time, party, guest, phone, label] of [
    [0, '20:00', 4, 'Hana Mansour (demo)', '+201090001001', 'T4'], [0, '21:30', 2, 'Ziad Ramzy (demo)', '+201090001002', 'T1'],
    [1, '19:30', 6, 'Farah Selim (demo)', '+201090001003', null], [2, '13:00', 3, 'Khaled Farouk (demo)', '+201090001004', null],
  ]) {
    const date = addDays(C.today, days);
    const [dup] = await q(`select 1 from reservations where org_id = $1 and guest_phone = $2 and (starts_at at time zone 'Africa/Cairo')::date = $3::date and status not in ('cancelled', 'expired')`, [C.ORG, phone, date]);
    if (dup) continue;
    const [t] = label ? await q(`select id from dining_tables where branch_id = $1 and label = $2 and org_id = $3`, [C.MAIN.id, label, C.ORG]) : [];
    const r = await call('POST', O('/reservations'), { token: C.STAFF.host.token, headers: { 'Idempotency-Key': key('res') }, body: {
      branchId: C.MAIN.id, date, time, partySize: party, guestName: guest, guestPhone: phone, ...(t ? { tableId: t.id } : {}),
    } });
    if (r.status >= 300) console.warn(`  reservation ${date} ${time} not created: ${r.body?.error?.code ?? r.status} (e.g. the time has passed today)`);
    else booked++;
  }
  log(`today: kitchen tickets (new / preparing / ready), a QR visit on ${qrTable} with an order and a waiter call, ${booked} new reservation(s)`);

  // WhatsApp (sandbox transport: nothing reaches Meta)
  const [existing] = await q(`select id from messaging_channels where org_id = $1 and transport = 'sandbox' order by created_at limit 1`, [C.ORG]).catch(() => []);
  const channel = existing ?? await must('POST', O('/connect/channels'), { token: C.OWNER.token, body: { transport: 'sandbox', displayName: 'Olive Room WhatsApp (sandbox)' } });
  const inbound = (from, msg) => must('POST', O('/connect/sandbox/inbound'), { token: C.OWNER.token, body: { channelId: channel.id, from, ...msg } });
  const lastOut = async (conversationId) => (await q(`select payload from messages where conversation_id = $1 and org_id = $2 and direction = 'outbound' order by created_at desc, id desc limit 1`, [conversationId, C.ORG]))[0];
  async function waToMenu(from, name, fulfillment, address) {
    const a = await inbound(from, { text: 'order', name });
    const out = await lastOut(a.conversationId);
    if (out?.payload?.buttons?.some((b) => b.id?.startsWith('branch:')) || out?.payload?.sections) await inbound(from, { reply: { id: `branch:${C.MAIN.id}` } });
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
    waOrders.push({ orderId: done.order.id, total: done.order.totalMinor, cod: payment === 'cod' });
  }
  await waToMenu('+201090002004', 'Rana Hassan (demo)', 'pickup');
  await inbound('+201090002005', { text: 'Hi, do you have vegan options? (demo)', name: 'Ali Fouad (demo)' });
  log('WhatsApp sandbox: 3 delivery orders (2 cash on delivery, 1 paid online), 1 open menu session, 1 question');

  // Delivery: dispatch, pickup, proof, cash on delivery, settlement
  const fleet = await drivers();
  {
    const o = waOrders[0];
    const job = await jobOf(o.orderId);
    await must('POST', M(`/jobs/${job}/assign`), { token: C.STAFF.manager.token, body: { driverId: fleet[0].driverId } });
    await must('POST', D(`/jobs/${job}/accept`), { token: fleet[0].token, body: { latitude: 30.063, longitude: 31.22 } });
    await kitchenTo(o.orderId, ['accepted', 'preparing', 'ready']);
    await must('POST', D(`/jobs/${job}/pickup`), { token: fleet[0].token, body: {} });
    await must('POST', D(`/jobs/${job}/en-route`), { token: fleet[0].token, body: { latitude: 30.064, longitude: 31.221 } });
    await deliverJob(job, fleet[0], o.total, 'Mariam (demo)');
  }
  {
    const o = waOrders[1];
    const job = await jobOf(o.orderId);
    await must('POST', M(`/jobs/${job}/assign`), { token: C.STAFF.manager.token, body: { driverId: fleet[1].driverId } });
    await must('POST', D(`/jobs/${job}/accept`), { token: fleet[1].token, body: { latitude: 30.062, longitude: 31.219 } });
    await kitchenTo(o.orderId, ['accepted', 'preparing', 'ready']);
    await must('POST', D(`/jobs/${job}/pickup`), { token: fleet[1].token, body: {} });
    await must('POST', D(`/jobs/${job}/en-route`), { token: fleet[1].token, body: { latitude: 30.0655, longitude: 31.2155 } });
  }
  await jobOf(waOrders[2].orderId);
  log('delivery: 1 delivered (photo proof, cash collected and settled), 1 on the way, 1 waiting for a driver');
  await setState({ demoLiveAt: new Date().toISOString() });
  return { live, waOrders };
}

// --- refresh: complete stale live fixtures the way staff would, then date them as history -------------------------
/**
 * `partialSince` (ISO time): an earlier run was interrupted while it created live fixtures; everything it placed since
 * then is completed too (whatever its age), so the fresh set created next is the only one.
 */
async function retireStaleLive(partialSince = null) {
  const cutoff = `now() - make_interval(hours => ${LIVE_STALE_HOURS})`;
  const since = partialSince ? new Date(partialSince).toISOString() : null;   // our own state; re-serialised before use in SQL
  const due = (col) => (since ? `(${col} < ${cutoff} or ${col} >= '${since}'::timestamptz)` : `${col} < ${cutoff}`);
  const retired = new Set();
  const counts = { orders: 0, deliveries: 0, visits: 0, requests: 0, reservations: 0 };
  const manager = C.STAFF.manager.token, cashier = C.STAFF.cashier.token;
  const fleet = await drivers();
  const driverFor = (driverId) => fleet.find((d) => d.driverId === driverId) ?? fleet[0];

  // Deliveries first: the driver completes the run (proof photo; cash on delivery collected and settled).
  for (const j of await q(`select j.id, j.status::text, j.driver_id, j.order_id, j.cod_amount_minor::int as cod, o.status::text as order_status
                             from delivery_jobs j join orders o on o.id = j.order_id
                            where j.org_id = $1 and j.status in ('unassigned', 'offered', 'assigned', 'accepted', 'picked_up', 'en_route') and ${due('o.placed_at')}`, [C.ORG])) {
    let driver = driverFor(j.driver_id);
    if (['unassigned', 'offered'].includes(j.status)) {
      driver = fleet[0];
      await must('POST', M(`/jobs/${j.id}/assign`), { token: manager, body: { driverId: driver.driverId } });
    }
    if (['unassigned', 'offered', 'assigned'].includes(j.status)) await must('POST', D(`/jobs/${j.id}/accept`), { token: driver.token, body: { latitude: 30.063, longitude: 31.22 } });
    const order = await must('GET', O(`/orders/${j.order_id}`), { token: C.OWNER.token });
    const path = ['accepted', 'preparing', 'ready'];
    const at = path.indexOf(order.status);
    if (['placed', 'accepted', 'preparing'].includes(order.status)) await kitchenTo(j.order_id, path.slice(at + 1));
    if (['unassigned', 'offered', 'assigned', 'accepted'].includes(j.status)) await must('POST', D(`/jobs/${j.id}/pickup`), { token: driver.token, body: {} });
    if (j.status !== 'en_route') await must('POST', D(`/jobs/${j.id}/en-route`), { token: driver.token, body: { latitude: 30.064, longitude: 31.221 } });
    await deliverJob(j.id, driver, j.cod, 'Guest at the door (demo)');
    retired.add(j.order_id); counts.deliveries++;
  }
  // Counter, website and table orders: collect what is due, finish the kitchen work, hand over or serve.
  for (const o of await q(`select id, fulfillment::text, visit_id, payment_status::text from orders
                            where org_id = $1 and status in ('awaiting_payment', 'placed', 'accepted', 'preparing', 'ready') and fulfillment <> 'delivery' and ${due('placed_at')}`, [C.ORG])) {
    let detail = await must('GET', O(`/orders/${o.id}`), { token: C.OWNER.token });
    if (detail.status === 'awaiting_payment' || (!o.visit_id && detail.paymentStatus === 'unpaid' && detail.status === 'placed' && o.fulfillment === 'pickup' && detail.channel === 'web')) {
      // Never paid online: the guest did not come back; cancelled like staff would.
      const r = await call('POST', O(`/orders/${o.id}/cancel`), { token: manager, body: { reason: 'Not collected (demo)', version: detail.version } });
      if (r.status < 300) { retired.add(o.id); counts.orders++; continue; }
    }
    if (!o.visit_id && !['paid', 'partially_refunded', 'refunded'].includes(detail.paymentStatus)) {
      await must('POST', O(`/orders/${o.id}/collect`), { token: cashier, headers: { 'Idempotency-Key': key('retire-cash') }, body: { method: 'cash' } });
    }
    detail = await must('GET', O(`/orders/${o.id}`), { token: C.OWNER.token });
    const steps = ['accepted', 'preparing', 'ready', o.fulfillment === 'dine_in' ? 'served' : 'picked_up'];
    const from = steps.indexOf(detail.status);
    await advance(o.id, steps.slice(from + 1), manager);
    retired.add(o.id); counts.orders++;
  }
  // Waiter and bill calls are answered.
  for (const r of await q(`select id from service_requests where org_id = $1 and status <> 'resolved' and ${due('created_at')}`, [C.ORG])) {
    await must('POST', O(`/requests/${r.id}/resolve`), { token: manager, body: { status: 'resolved' } });
    counts.requests++;
  }
  // Table visits: the bill is settled in cash and the table is closed.
  for (const v of await q(`select id from visits where org_id = $1 and status = 'open' and ${due('opened_at')}`, [C.ORG])) {
    const detail = await must('GET', O(`/visits/${v.id}`), { token: manager });
    const due = Number(detail?.totals?.dueMinor ?? detail?.bill?.dueMinor ?? detail?.dueMinor ?? 0);
    if (due > 0) await must('POST', O(`/visits/${v.id}/collect`), { token: cashier, headers: { 'Idempotency-Key': key('retire-visit') }, body: { method: 'cash' } });
    const [still] = await q(`select status from visits where id = $1 and org_id = $2`, [v.id, C.ORG]);
    if (still.status === 'open') await must('POST', O(`/visits/${v.id}/close`), { token: manager, body: { needsCleaning: false } });
    counts.visits++;
  }
  // Bookings whose time passed without the guest arriving are no-shows (held ones expire through the worker).
  for (const r of await q(`select id from reservations where org_id = $1 and status = 'confirmed' and starts_at < ${cutoff}`, [C.ORG])) {
    await must('POST', O(`/reservations/${r.id}/no-show`), { token: C.STAFF.host.token, body: {} });
    counts.reservations++;
  }
  // Stale fixtures completed above (and any an interrupted run completed without dating them) happened shortly after
  // they started: date the milestones accordingly. Fixtures of the partial set are minutes old and keep their real times.
  const settle = await q(`select id from orders where org_id = $1 and placed_at < ${cutoff}
                            and (id = any($2::uuid[]) or coalesce(fulfilled_at, cancelled_at) > placed_at + make_interval(hours => ${LIVE_STALE_HOURS}))`, [C.ORG, [...retired]]);
  await settleTimeline(settle.map((r) => r.id));
  await q(`update visits v set closed_at = least(now(), greatest(v.opened_at + interval '75 min',
             coalesce((select max(o.fulfilled_at) from orders o where o.visit_id = v.id), v.opened_at) + interval '15 min'))
           where v.org_id = $1 and v.status = 'closed' and v.closed_at > v.opened_at + interval '6 hours'`, [C.ORG]);
  await q(`update service_requests set resolved_at = created_at + interval '4 min' where org_id = $1 and resolved_at > created_at + interval '6 hours'`, [C.ORG]);
  log(`refresh: completed ${since ? `stale live fixtures and the partial set an interrupted run created since ${since}` : 'stale live fixtures'} — ${counts.orders} order(s), ${counts.deliveries} delivery run(s), ${counts.visits} visit(s), ${counts.requests} call(s); ${counts.reservations} no-show(s)`);
  return counts;
}

// --- 13. finance: fixed monthly costs (upsert per month and kind; DF-11) -----------------------------------------
async function upsertFixedCosts(historyFrom) {
  const cats = (await must('GET', O('/finance/expense-categories'), { token: C.STAFF.accountant.token })).items;
  const cat = (kind) => { const c = cats.find((x) => x.kind === kind); if (!c) throw new Error(`no expense category of kind ${kind}`); return c.id; };
  const existing = await q(`select e.id, e.external_ref, e.amount_minor::int as amount, e.tax_minor::int as tax, e.incurred_on::text as on, e.description, e.vendor, c.kind,
                                   to_char(e.incurred_on, 'YYYY-MM') as month
                              from expenses e join expense_categories c on c.id = e.category_id where e.org_id = $1`, [C.ORG]);
  let created = 0, updated = 0;
  for (const e of fixedCostSchedule({ from: historyFrom, to: C.today })) {
    // Rows from older loaders have no externalRef: they are matched by vendor and month and adopted.
    const row = existing.find((x) => x.external_ref === e.externalRef)
      ?? existing.find((x) => !x.external_ref && x.vendor === e.vendor && x.kind === e.kind && x.month === e.month);
    const body = { amountMinor: e.amountMinor, taxMinor: e.taxMinor, incurredOn: e.incurredOn, vendor: e.vendor, description: e.description, externalRef: e.externalRef };
    if (!row) {
      await must('POST', O('/finance/expenses'), { token: C.STAFF.accountant.token, body: { categoryId: cat(e.kind), ...body } });
      created++;
    } else if (row.external_ref !== e.externalRef || row.amount !== e.amountMinor || row.tax !== e.taxMinor || row.on !== e.incurredOn || row.description !== e.description) {
      await must('PATCH', O(`/finance/expenses/${row.id}`), { token: C.STAFF.accountant.token, body });
      updated++;
    }
  }
  log(`finance: fixed costs (rent, utilities, POS fees, payroll) for every month since ${historyFrom}: ${created} booked, ${updated} updated (partial months prorated, payroll month to date)`);
}

async function reconcileUpToNow() {
  // Older loaders ended the run an hour in the future; a period can never end after the run that covered it.
  const fixed = await q(`update reconciliation_runs set period_end = created_at
                          where org_id = $1 and period_end > created_at + interval '1 minute' and created_at > period_start returning id`, [C.ORG]);
  if (fixed.length) log(`reconciliation: ${fixed.length} run(s) from an older loader ended in the future; clamped to when they ran`);
  const [last] = await q(`select max(period_end) as at from reconciliation_runs where org_id = $1`, [C.ORG]);
  const from = last?.at ? new Date(last.at) : new Date(Date.now() - (DAYS + 2) * 86400_000);
  const to = new Date();   // never past now (DF-11)
  if (to - from < 3600_000) return;
  await must('POST', O('/payments/reconciliation/runs'), { token: C.STAFF.accountant.token, body: { provider: 'simulated', from: from.toISOString(), to: to.toISOString(), source: 'provider_api' } });
  log(`reconciliation run for ${from.toISOString()} .. ${to.toISOString()}`);
}

// --- 14. Studio website and the Smash & Co storefront (VP-05, VP-14); idempotent ---------------------------------
/**
 * Tenants loaded by an older loader keep two gaps the integrity check reports: dishes created without a photo, and
 * online checkout sessions of back-dated orders still stamped at load time (the old loader re-dated the order but not
 * its session). Both are repaired in place on the demo tenant only; nothing is deleted.
 */
async function repairOlderLoaderRows() {
  let photos = 0;
  for (const [legacyId, rel] of [...Object.entries(seedManifest.photos), ...Object.entries(seedManifest.smash.photos)]) {
    const prod = C.PRODUCTS[legacyId];
    if (legacyId.startsWith('_') || !prod) continue;
    const [has] = await q(`select 1 from products p join media_assets a on a.org_id = p.org_id and a.id = p.image_media_id where p.org_id = $1 and p.id = $2`, [C.ORG, prod.id]);
    if (has) continue;
    await upload(O(`/menu/products/${prod.id}/image`), C.OWNER.token, readFileSync(path.join(ROOT, 'supabase/seeds', rel)), `${legacyId}.webp`, 'image/webp', prod.name);
    photos++;
  }
  const stale = await q(`select distinct o.id from checkout_sessions s join orders o on o.id = s.order_id and o.org_id = s.org_id
                          where s.org_id = $1 and (s.created_at < o.placed_at - interval '1 minute' or s.created_at > o.placed_at + interval '1 day')`, [C.ORG]);
  if (stale.length) await settleTimeline(stale.map((r) => r.id));
  if (photos || stale.length) log(`repair: ${photos} dish photo(s) added, ${stale.length} order timeline(s) with load-time checkout sessions re-dated (older loader)`);
}

/**
 * Floors saved by an older loader only had the north wall and the door. Adds the missing legacy architecture (walls,
 * windows, the service bar, the pickup counter) through the floor API; objects already on a floor are kept as stored,
 * so a second run changes nothing (PAR-01).
 */
async function ensureFloorArchitecture() {
  const added = [];
  for (const [branch, code] of [[C.MAIN, 'main'], [C.SMASH, 'burger']]) {
    const cur = await must('GET', O(`/floor/${branch.id}`), { token: C.OWNER.token });
    const next = withArchitecture(cur.objects, code);
    if (!next.added.length) continue;
    const { branchId: _b, revision: _r, schemaVersion: _s, ...layout } = cur;
    await must('PUT', O(`/floor/${branch.id}`), { token: C.OWNER.token, body: { baseRevision: cur.revision, key: key('floor-arch'), layout: { ...layout, objects: next.objects } } });
    added.push(`${code}: ${next.added.join(', ')}`);
  }
  if (added.length) log(`floor: legacy room architecture added (${added.join('; ')})`);
}

/**
 * The Smash & Co storefront's guest signals (PAR-02): opening hours in the branch time zone, the Downtown district in
 * English and Arabic, and dish preparation times (the storefront's pickup estimate is their median). Fills only what
 * is missing, through the API; a second run changes nothing.
 */
async function ensureStorefrontSignals() {
  const [cur] = await q(`select district, district_ar as "districtAr", timezone, opening_hours as "openingHours" from branches where org_id = $1 and id = $2`, [C.ORG, C.SMASH.id]);
  const patch = smashBranchPatch(cur);
  if (Object.keys(patch).length) await must('PATCH', O(`/branches/${C.SMASH.id}`), { token: C.OWNER.token, body: patch });
  let prep = 0;
  for (const [legacyId, minutes] of Object.entries(SMASH_PREP_MINUTES)) {
    const prod = C.PRODUCTS[legacyId];
    if (!prod) continue;
    const [row] = await q(`select prep_minutes, version from products where org_id = $1 and id = $2`, [C.ORG, prod.id]);
    if (row && row.prep_minutes == null) { await must('PATCH', O(`/menu/products/${prod.id}`), { token: C.OWNER.token, body: { prepMinutes: minutes, version: row.version } }); prep++; }
  }
  if (Object.keys(patch).length || prep) log(`storefront: Smash & Co ${Object.keys(patch).join(', ') || 'branch unchanged'}; ${prep} dish preparation time(s)`);
}

/** Ingredients created by an older loader have no Arabic name; they get one through the API (PAR-06). */
async function ensureInventoryArabicNames() {
  let n = 0;
  for (const r of await q(`select id, name from inventory_items where org_id = $1 and coalesce(btrim(name_ar), '') = ''`, [C.ORG])) {
    if (!ITEM_AR[r.name]) continue;
    await must('PATCH', O(`/inventory/items/${r.id}`), { token: C.OWNER.token, body: { nameAr: ITEM_AR[r.name] } });
    n++;
  }
  if (n) log(`inventory: Arabic names for ${n} ingredient(s)`);
}

async function ensureBranding() {
  // Arabic names for every category (Arabic pages never fall back to English).
  for (const c of await q(`select id, name from menu_categories where org_id = $1 and coalesce(btrim(name_ar), '') = ''`, [C.ORG])) {
    if (CATEGORY_AR[c.name]) await must('PATCH', O(`/menu/categories/${c.id}`), { token: C.OWNER.token, body: { nameAr: CATEGORY_AR[c.name] } });
  }
  const site = await must('GET', O('/studio/website'), { token: C.OWNER.token });
  const [hasHero] = await q(`select 1 from websites w join media_assets a on a.org_id = w.org_id and a.id::text = w.theme->>'heroMediaId' where w.org_id = $1`, [C.ORG]);
  let publish = false;
  if (!hasHero) {
    const hero = await upload(O('/studio/media'), C.OWNER.token, readFileSync(path.join(ROOT, 'supabase/seeds', seedManifest.websiteHero.path)), 'olive-interior.webp', 'image/webp', seedManifest.websiteHero.alt);
    await must('PATCH', O('/studio/website'), { token: C.OWNER.token, body: { theme: { heroMediaId: hero.id ?? hero.mediaId } } });
    publish = true;
  }
  const highlights = site.sections.find((x) => x.kind === 'menu_highlights');
  const seabass = byName(/Seabass/), risotto = byName(/risotto/), chicken = byName(/Grilled chicken/);
  if (highlights && !(highlights.content?.productIds?.length)) {
    await must('PATCH', O(`/studio/website/sections/${highlights.id}`), { token: C.OWNER.token, body: { content: { headline: { en: 'Chef’s favourites', ar: 'اختيارات الشيف' }, productIds: [seabass.id, risotto.id, chicken.id] } } });
    publish = true;
  }
  if (publish || site.status !== 'published') await must('POST', O('/studio/website/publish'), { token: C.OWNER.token, body: { key: key('publish') } });

  // The burger branch trades under its own brand (legacy /burger storefront: legacy/public/burger.js, burger.css).
  const [store] = await q(`select s.is_published, s.hero_media_id is not null and exists (select 1 from media_assets a where a.id = s.hero_media_id and a.org_id = s.org_id) as has_hero
                             from branch_storefronts s where s.org_id = $1 and s.branch_id = $2`, [C.ORG, C.SMASH.id]);
  if (store?.is_published && store.has_hero) return;
  const smashHero = await upload(O('/studio/media'), C.OWNER.token, readFileSync(path.join(ROOT, 'supabase/seeds', seedManifest.smash.hero)), 'smash-hero.webp', 'image/webp', 'Double Smash burger (AI-generated food photography)');
  const smashPromo = ['b5', 'b0', 'b8'].map((id) => C.PRODUCTS[id].id);   // fries, burger, cola: "Any burger + classic fries + cola"
  await must('PUT', O(`/studio/storefronts/${C.SMASH.id}`), { token: C.OWNER.token, body: {
    slug: 'smash-and-co', brandName: 'Smash & Co', brandNameAr: 'سماش آند كو',
    tagline: { en: 'Smashed fresh. Served fast.', ar: 'طازج ومهروس. يُقدّم بسرعة.' },
    theme: { primaryColor: '#b51218', accentColor: '#ffd52f', inkColor: '#17120f', paperColor: '#fff8ed' },
    heroMediaId: smashHero.id ?? smashHero.mediaId,
    content: {
      headline: { en: 'Smashed fresh. Served fast.', ar: 'طازج ومهروس. يُقدّم بسرعة.' },
      body: { en: 'Lacy-edged patties, crisp fries and thick shakes. Made to order and ready when you are.', ar: 'قطع لحم بحواف مقرمشة، بطاطس ساخنة، وميلك شيك كثيف. يُحضّر عند الطلب ويجهز في وقتك.' },
      heroNote: { en: 'Made for the messy bite.', ar: 'مصنوع للقضمة الشهية.' },
      promo: { title: { en: 'The Smash combo.', ar: 'كومبو سماش.' }, body: { en: 'Any burger + classic fries + cola', ar: 'أي برجر + بطاطس كلاسيك + كولا' },
        ctaLabel: { en: 'Choose a burger', ar: 'اختر برجر' }, ctaCategoryId: C.categories.Burgers, productIds: smashPromo },
      sections: [
        { categoryId: C.categories.Burgers, eyebrow: { en: 'Our burgers', ar: 'برجرنا' }, title: { en: 'Burgers that hit different.', ar: 'برجر بطعم مختلف.' }, body: { en: '100% beef. Smashed to perfection.', ar: 'لحم بقري 100٪، مهروس بإتقان.' } },
        { categoryId: C.categories.Sides, title: { en: 'More to love.', ar: 'المزيد لتحبه.' }, body: { en: 'Crisp, golden, made for dipping.', ar: 'مقرمش وذهبي ومثالي للصوص.' } },
        { categoryId: C.categories.Shakes, title: { en: 'Shakes done right.', ar: 'ميلك شيك كما يجب.' }, body: { en: 'The perfect finish to your smash.', ar: 'الختام المثالي لوجبتك.' } },
        { categoryId: C.categories.Drinks, title: { en: 'Keep it cold.', ar: 'خليه بارد.' }, body: { en: 'The perfect finish to your smash.', ar: 'الختام المثالي لوجبتك.' } },
      ],
    },
    isPublished: true,
  } });
  log('storefront: Smash & Co branding on the burger branch (red/yellow, hero photo, combo, section copy), published at /r/the-olive-room/smash-and-co');
}

// --- first-load-only extras: marketing, refund, export, creative, intelligence, MCP ----------------------------------
async function firstLoadExtras(live) {
  const chicken = byName(/Grilled chicken/), soup = byName(/pumpkin soup/), seabass = byName(/Seabass/), smash = byName(/^Classic Smash$/);
  const mk = (p) => O(`/marketing${p}`);
  const tok = C.STAFF.marketing.token;
  const regulars = await must('POST', mk('/segments'), { token: tok, body: { name: 'Regulars: 3+ orders in 60 days (demo)', definition: { op: 'and', rules: [{ type: 'orders_gte', count: 3, withinDays: 60 }] } } });
  const waSeg = await must('POST', mk('/segments'), { token: tok, body: { name: 'Consented WhatsApp customers (demo)', definition: { op: 'and', rules: [{ type: 'consent', value: true }, { type: 'channel', channel: 'whatsapp' }] } } });
  const camp = await must('POST', mk('/campaigns'), { token: tok, body: { name: 'Weekend dinner offer (demo)', channel: 'whatsapp', segmentId: waSeg.id, objective: 'retention',
    content: { text: 'This weekend at The Olive Room: a complimentary hibiscus cooler with every main course. Order here! (demo message)' } } });
  await must('POST', mk(`/campaigns/${camp.id}/submit`), { token: tok });
  await must('POST', mk(`/campaigns/${camp.id}/approve`), { token: C.STAFF.manager.token });   // approved by a second person
  await must('POST', mk(`/campaigns/${camp.id}/send`), { token: tok });
  const link = await must('POST', mk('/links'), { token: tok, body: { campaignId: camp.id, destinationPath: `/order/${SLUG}`, utm: { content: 'weekend' } } });
  const click = await must('GET', `/public/l/${link.code}`);
  const attribution = Object.fromEntries(new URL(click.destination, 'http://localhost').searchParams.entries());
  const attributed = await must('POST', `/public/order/${SLUG}/orders`, { headers: { 'Idempotency-Key': key('attr') }, body: {
    branchId: C.MAIN.id, fulfillment: 'pickup', payment: 'online', lines: [line(chicken), line(soup)],
    customer: { name: 'Hana Mansour (demo)', phone: '+201090001001', marketingConsent: true }, attribution,
  } });
  {
    const t = attributed.checkout.url.split('/pay/')[1];
    await must('POST', `/public/pay/${t}/start`, { body: { method: 'card' } });
    await must('POST', `/public/pay/${t}/sandbox/complete`, { body: { outcome: 'success' } });
  }
  const draft = await must('POST', mk('/campaigns'), { token: tok, body: { name: 'Iftar set menu (demo draft)', channel: 'whatsapp', segmentId: regulars.id, objective: 'reactivation',
    content: { text: 'Our iftar set menu is back. Book your table. (demo draft)' } } });
  await must('POST', mk(`/campaigns/${draft.id}/submit`), { token: tok });
  await must('POST', mk('/promotions'), { token: tok, body: { code: 'WELCOME10', name: 'Welcome 10% (demo)', nameAr: 'خصم ترحيبي 10% (تجريبي)', kind: 'percent', value: 1000, maxDiscountMinor: 5000, minOrderMinor: 20000, channels: ['web'] } });
  log('marketing: 2 segments, 1 approved campaign sent on the sandbox channel with an attributed paid order, 1 awaiting approval, 1 promo code');

  const cats = (await must('GET', O('/finance/expense-categories'), { token: C.STAFF.accountant.token })).items;
  await must('POST', O('/finance/expenses'), { token: C.STAFF.accountant.token, body: { categoryId: cats.find((x) => x.kind === 'marketing').id, amountMinor: 250000, taxMinor: 0, incurredOn: addDays(C.today, -9), vendor: 'Flyer printing (demo)', externalRef: 'demo-marketing:flyers' } });
  const [cardPay] = await q(`select id from payments where org_id = $1 and method = 'card' and status = 'succeeded' order by created_at desc limit 1`, [C.ORG]);
  if (cardPay) await must('POST', O(`/payments/${cardPay.id}/refunds`), { token: C.OWNER.token, body: { amountMinor: 2000, reason: 'Missing sauce (demo)', key: key('refund') } });
  await must('POST', O('/finance/exports'), { token: C.STAFF.accountant.token, body: { kind: 'sales', from: addDays(C.today, -30), to: C.today, format: 'csv' } });
  log('finance: 1 partial refund, a CSV export');

  await must('POST', O('/studio/creative'), { token: tok, body: { kind: 'caption', locale: 'en', brief: 'Instagram caption for our seabass with lemon butter', productId: seabass.id, tone: 'premium', variants: 2 } });
  await must('POST', O('/studio/creative'), { token: tok, body: { kind: 'caption', locale: 'ar', brief: 'منشور إنستجرام عن برجر سماش الكلاسيكي', productId: smash.id, tone: 'playful', variants: 2 } });

  await call('GET', O(`/intelligence/forecast?branchId=${C.MAIN.id}&horizon=14&top=5`), { token: C.OWNER.token });
  await must('POST', O('/intelligence/assistant'), { token: C.OWNER.token, body: { message: 'How much did we sell in the last 7 days?' } });
  await must('POST', O('/intelligence/assistant'), { token: C.OWNER.token, body: { message: 'What are my top selling items this month?' } });
  const mcp = await must('POST', O('/mcp/clients'), { token: C.OWNER.token, body: {
    name: 'Claude Desktop (demo key)', actingRole: 'manager', rateLimitPerMin: 60,
    allowedTools: ['list_orders', 'get_order', 'get_sales_summary', 'list_top_items', 'create_payment_link', 'get_approval_status'],
  } });
  const K = { Authorization: `Bearer ${mcp.key}` };   // shown once by the API; never printed or stored here
  await must('POST', O('/mcp/tools/list_orders'), { headers: K, body: { input: { limit: 5 } } });
  await must('POST', O('/mcp/tools/get_sales_summary'), { headers: K, body: { input: { from: addDays(C.today, -7), to: C.today } } });
  const pending = await call('POST', O('/mcp/tools/create_payment_link'), { headers: K, body: { input: { orderId: live[0], description: 'Pay link requested by the AI client (demo)' } } });
  if (pending.body?.status !== 'approval_required') throw new Error(`MCP payment link: expected approval_required, got ${JSON.stringify(pending.body).slice(0, 200)}`);
  log('studio: 2 creative drafts (template mode); intelligence: forecast, 2 assistant questions; MCP: 1 client, 2 reads, 1 payment link awaiting approval');
}

// --- main ------------------------------------------------------------------------------------------------------
// One run at a time per tenant (scripts/demo/lib/lease.mjs); a second run exits 3 without touching anything.
const lease = await claimLease(q, SLUG);
if (!lease.owner) {
  console.error(`demo loader: another run holds the loader lease (${lease.heldBy ?? 'unknown'}) until ${lease.until ? new Date(lease.until).toISOString() : '?'}; nothing done`);
  await db.end();
  process.exit(3);
}
const heartbeat = setInterval(() => {
  renewLease(q, SLUG, lease.owner).then((ok) => { if (!ok) fail('lost the loader lease (another run took it over); stopping'); },
    (e) => console.warn(`  lease renewal failed: ${e.message}`));
}, RENEW_SECONDS * 1000);
heartbeat.unref();
const finish = async (status) => { clearInterval(heartbeat); await releaseLease(q, SLUG, lease.owner, status).catch(() => undefined); };
let decision;
let report;
try {
  const [{ today }] = await q(`select (now() at time zone 'Africa/Cairo')::date::text as today`);
  C.today = today;
  const [foreign] = await q(`select count(*)::int as n from organizations where slug <> $1 and coalesce((onboarding->>'demo')::boolean, false) = false`, [SLUG]);
  const [prior] = await q(`select id, coalesce((onboarding->>'demo')::boolean, false) as demo, onboarding->>'demoLoader' as state, onboarding->>'demoHistoryFrom' as history_from,
                                  onboarding->>'demoHistoryThrough' as history_through, onboarding->>'demoLiveAt' as live_at,
                                  onboarding->>'demoLiveStartedAt' as live_started_at,
                                  ((created_at at time zone 'Africa/Cairo')::date)::text as created_day, created_at
                             from organizations where slug = $1`, [SLUG]);
  decision = decideAction({ target, org: prior, foreign: foreign.n });
  if (decision.refuse) { await finish('failed'); fail(decision.refuse); }
  log(`mode: ${target.mode}; action: ${decision.action}${target.demoTenantOnly ? ' (only the demo tenant is created or updated)' : ''}`);

  if (decision.action === 'load') {
    await createTenant();
    const historyFrom = addDays(today, -DAYS);
    await placeHistory(historyFrom, addDays(today, -1), historyFrom, true);
    await setState({ demoHistoryFrom: historyFrom, demoHistoryThrough: addDays(today, -1) });
    const { live } = await createLive();
    await upsertFixedCosts(historyFrom);
    await reconcileUpToNow();
    await ensureBranding();
    await ensureFloorArchitecture();
    await ensureStorefrontSignals();
    await firstLoadExtras(live);
    await must('POST', O('/intelligence/insights/refresh'), { token: C.OWNER.token });
    await setState({ demoLoader: 'complete' });
  } else {
    await loadContext(prior.id);
    // Tenants from older loaders carry no dates in their state: their history ended the day before they were created.
    const [first] = await q(`select min(business_date)::text as d from orders where org_id = $1`, [C.ORG]);
    const historyFrom = prior.history_from ?? first?.d ?? addDays(prior.created_day, -DAYS);
    const historyThrough = prior.history_through ?? addDays(prior.created_day, -1);
    const liveAt = new Date(prior.live_at ?? prior.created_at);
    // createLive() writes demoLiveStartedAt first and demoLiveAt last: a later start means it was interrupted.
    const partialLive = prior.live_started_at && new Date(prior.live_started_at) > liveAt ? prior.live_started_at : null;
    if (partialLive) log(`live fixtures: an earlier run was interrupted while creating them (${partialLive}); that partial set is completed first`);
    const stale = Boolean(partialLive) || Date.now() - liveAt.getTime() > LIVE_STALE_HOURS * 3600_000;
    // A fresh live set is never older than the cutoff, so completing everything older than it is safe on every run:
    // items an earlier set left behind (bookings made days ahead, a visit from a set that was 5 h old when the next
    // set was created) are retired even while the current set is still fresh.
    await retireStaleLive(stale ? partialLive : null);
    const yesterday = addDays(today, -1);
    if (historyThrough < yesterday) {
      const gapFrom = addDays(historyThrough, 1);
      const from = daysFrom(gapFrom, yesterday) >= DAYS ? addDays(today, -DAYS) : gapFrom;   // a very old tenant gets the last DAYS days
      await placeHistory(from, yesterday, historyFrom, false);
      await setState({ demoHistoryFrom: historyFrom, demoHistoryThrough: yesterday });
    } else {
      log(`history already runs through ${historyThrough}`);
    }
    if (stale) await createLive();
    else log(`live fixtures are fresh (created ${liveAt.toISOString()}); kept`);
    await upsertFixedCosts(historyFrom);
    await reconcileUpToNow();
    await ensureBranding();
    await ensureFloorArchitecture();
    await ensureStorefrontSignals();
    await ensureInventoryArabicNames();
    await repairOlderLoaderRows();
    await call('POST', O('/intelligence/insights/refresh'), { token: C.OWNER.token });
  }
  report = await checkDemoIntegrity(q, { slug: SLUG });
  console.log(formatIntegrity(report));
} catch (e) {
  await finish('failed');
  throw e;
}
await finish(report.ok ? 'succeeded' : 'failed');
await db.end();
if (!report.ok) fail('the demo data failed its integrity check (see above)');
console.log(`\nDemo data ${decision.action === 'load' ? 'loaded' : 'refreshed'} for ${SLUG} (${C.ORG}). Accounts: owner@${DOMAIN}, platform-admin@${DOMAIN}, <role>@${DOMAIN} (manager, kitchen, cashier, marketing, accountant, host, waiter, driver1, driver2). Passwords come from the DEMO_*_PASSWORD variables.`);
