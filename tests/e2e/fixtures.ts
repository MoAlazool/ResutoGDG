// Reusable end-to-end fixtures: API helpers (sign up, create tenant, publish a
// site, upload media), SQL seed helpers against the e2e database, signing a
// browser in, and console-error collection.
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test as base, type APIRequestContext, type APIResponse, type Browser, type BrowserContext, type Locator, type Page, type PageAssertionsToHaveScreenshotOptions } from '@playwright/test';
import pg from 'pg';

export const API_URL = `http://localhost:${process.env.E2E_API_PORT ?? '4109'}`;
export const WEB_URL = `http://localhost:${process.env.E2E_WEB_PORT ?? '3109'}`;
export const DB_URL = process.env.E2E_DATABASE_URL ?? 'postgres://postgres@127.0.0.1:54329/resuto_e2e_f';
export const ROOT = path.resolve(__dirname, '../..');

let pool: pg.Pool | null = null;
export const db = () => (pool ??= new pg.Pool({ connectionString: DB_URL, max: 2 }));
export async function sql<T = any>(text: string, params: unknown[] = []): Promise<T[]> {
  return (await db().query(text, params as any[])).rows;
}

let n = 0;
export const unique = (p: string) => `${p}-${Date.now().toString(36)}-${++n}`;

export interface User { token: string; email: string; userId: string }
export interface Tenant { owner: User; orgId: string; branchId: string; slug: string }

export async function apiSignup(request: APIRequestContext, name = 'Owner'): Promise<User> {
  const email = `${unique('e2e')}@example.test`;
  const res = await request.post(`${API_URL}/v1/auth/dev/signup`, { data: { email, password: 'correct-horse-battery', fullName: name } });
  expect(res.status(), await res.text()).toBe(201);
  const body = await res.json();
  return { token: body.accessToken, email, userId: body.user.id };
}

/**
 * Every fixture restaurant is created from its own client address. In production one address may create 30
 * restaurants an hour (PS-13, shared limiter); a full e2e run creates more than that from one runner, which is many
 * owners signing up, not one abuser. The API trusts X-Forwarded-For only from loopback outside production
 * (trustProxySetting), so the limit itself is untouched; addresses come from 198.18.0.0/15 (RFC 2544 test range).
 */
let clientSeq = 0;
const fixtureClientIp = () => { const i = ++clientSeq + (process.pid % 200) * 256; return `198.18.${(i >> 8) & 255}.${(i & 255) || 1}`; };

export async function apiCreateTenant(request: APIRequestContext, opts: { name?: string; nameAr?: string; planId?: string; country?: 'EG' | 'SA'; openingHours?: Array<{ day: number; opens: string; closes: string }> } = {}): Promise<Tenant> {
  const owner = await apiSignup(request);
  const slug = unique('r').toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 40);
  const res = await request.post(`${API_URL}/v1/orgs`, {
    headers: { ...auth(owner), 'X-Forwarded-For': fixtureClientIp() },
    data: { name: opts.name ?? 'The Olive Room', nameAr: opts.nameAr ?? 'غرفة الزيتون', slug, country: opts.country ?? 'EG', planId: opts.planId ?? 'pro',
      branch: { name: 'Zamalek', city: 'Cairo', phone: '+201001234567', acceptsDelivery: true, deliveryFeeMinor: 3500,
        // Open around the clock (opens = closes is a 24-hour day) unless a spec passes its own hours: CI runs at any time
        // of day, and a scenario that places an order must not fail with branch_closed at night in Cairo. The
        // opening-hours rules themselves are covered by API tests (service-area, reservations availability).
        openingHours: opts.openingHours ?? [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, opens: '00:00', closes: '00:00' })) } },
  });
  expect(res.status(), await res.text()).toBe(201);
  const body = await res.json();
  return { owner, orgId: body.id, branchId: body.branchId, slug };
}

export const auth = (u: { token: string }) => ({ Authorization: `Bearer ${u.token}` });

/** Menu rows inserted directly (the menu module is owned by another agent). Prices in minor units. */
export async function seedMenu(t: Tenant) {
  const [menu] = await sql(`select id from menus where org_id = $1 limit 1`, [t.orgId]);
  const [cat] = await sql(`insert into menu_categories(org_id, menu_id, name, name_ar) values ($1, $2, 'Starters', 'المقبلات') returning id`, [t.orgId, menu.id]);
  const dishes: Array<[string, string, number, string, string]> = [
    ['Burrata & heirloom tomato', 'بوراتا مع الطماطم', 14500, 'Creamy burrata, ripe tomatoes and fresh basil.', 'بوراتا كريمية وطماطم ناضجة وريحان طازج.'],
    ['Roasted pumpkin soup', 'شوربة القرع المشوي', 9500, 'Silky roasted pumpkin, gently seasoned.', 'قرع مشوي ناعم بتتبيلة خفيفة.'],
    ['Grilled chicken supreme', 'دجاج مشوي مع الخضروات', 28500, 'Grilled chicken with seasonal vegetables.', 'دجاج مشوي مع خضروات الموسم.'],
  ];
  const ids: string[] = [];
  for (const [i, [name, nameAr, price, desc, descAr]] of dishes.entries()) {
    const [p] = await sql(`insert into products(org_id, category_id, name, name_ar, price_minor, cost_minor, currency, description, description_ar, sort_order)
      values ($1, $2, $3, $4, $5, $6, 'EGP', $7, $8, $9) returning id`, [t.orgId, cat.id, name, nameAr, price, Math.round(price * 0.3), desc, descAr, i]);
    ids.push(p.id);
  }
  return ids;
}

export async function uploadImage(request: APIRequestContext, t: Tenant, file: string, alt: string): Promise<string> {
  const res = await request.post(`${API_URL}/v1/o/${t.orgId}/studio/media`, {
    headers: auth(t.owner),
    multipart: { file: { name: path.basename(file), mimeType: file.endsWith('.png') ? 'image/png' : 'image/webp', buffer: readFileSync(file) }, alt },
  });
  expect(res.status(), await res.text()).toBe(201);
  return (await res.json()).id;
}

/** Builds and publishes a complete Olive-template website through the Studio API. */
export async function publishSite(request: APIRequestContext, t: Tenant, opts: { productIds?: string[] } = {}) {
  const h = auth(t.owner);
  const base = `${API_URL}/v1/o/${t.orgId}/studio`;
  const hero = await uploadImage(request, t, path.join(ROOT, 'apps/web/public/brand/olive-interior.webp'), 'Dining room with olive banquettes');
  const plate = await uploadImage(request, t, path.join(ROOT, 'apps/web/public/brand/olive-burrata.webp'), 'Burrata with heirloom tomatoes');
  expect((await request.patch(`${base}/website`, { headers: h, data: {
    template: 'olive', theme: { heroMediaId: hero },
    seo: { title: { en: 'The Olive Room · Zamalek', ar: 'غرفة الزيتون · الزمالك' }, description: { en: 'Seasonal plates and warm hospitality in Zamalek.', ar: 'أطباق موسمية وضيافة دافئة في الزمالك.' } },
  } })).status()).toBe(200);
  const site = await (await request.get(`${base}/website`, { headers: h })).json();
  const byKind = (k: string) => site.sections.find((s: any) => s.kind === k);
  await request.patch(`${base}/website/sections/${byKind('hero').id}`, { headers: h, data: { content: {
    eyebrow: { en: 'The Olive Room', ar: 'غرفة الزيتون' },
    headline: { en: 'Good food. Long conversations.', ar: 'طعام طيب. وأحاديث طويلة.' },
    body: { en: 'Seasonal plates, warm hospitality and a place at our table.', ar: 'أطباق موسمية وضيافة دافئة ومكان على مائدتنا.' },
  } } });
  await request.post(`${base}/website/sections`, { headers: h, data: { kind: 'about', content: {
    headline: { en: 'Dinner, without the back-and-forth.', ar: 'عشاء بلا انتظار.' }, body: { en: 'Choose confidently. Order at your pace.', ar: 'اختر بثقة. واطلب على مهلك.' }, mediaId: plate,
  } } });
  if (opts.productIds?.length) await request.patch(`${base}/website/sections/${byKind('menu_highlights').id}`, { headers: h, data: { content: { headline: { en: 'Menu', ar: 'القائمة' }, productIds: opts.productIds } } });
  const ids = (await (await request.get(`${base}/website`, { headers: h })).json()).sections.map((s: any) => s.id);
  const about = ids.pop();
  ids.splice(1, 0, about);
  await request.post(`${base}/website/sections/reorder`, { headers: h, data: { ids } });
  const pub = await request.post(`${base}/website/publish`, { headers: h, data: { key: unique('publish') } });
  expect(pub.status(), await pub.text()).toBe(200);
}

/** Signs the browser in with an API-issued dev token (same storage the app uses). */
export async function signIn(page: Page, user: User, locale: 'en' | 'ar' = 'en') {
  await page.context().addCookies([{ name: 'resuto_locale', value: locale, url: WEB_URL }]);
  // The session lives in localStorage, so it is written from a same-origin page that runs no app code: on /login the
  // page hydrates after the write, sees the session and redirects to the dashboard, which raced the caller's next
  // navigation in WebKit ("navigation interrupted by another navigation").
  await page.goto('/robots.txt');
  await page.evaluate(([token, email]) => localStorage.setItem('resuto_session', JSON.stringify({ accessToken: token, expiresAt: Date.now() + 3600e3, email })), [user.token, user.email]);
}

export async function setLocale(page: Page, locale: 'en' | 'ar') {
  await page.context().addCookies([{ name: 'resuto_locale', value: locale, url: WEB_URL }]);
}

/**
 * Console errors on a page. Failed requests to dashboard routes owned by other
 * agents (not built in this worktree) are reported by the shell and ignored here.
 */
export function collectErrors(page: Page, ignore: RegExp[] = []) {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error' && !ignore.some((r) => r.test(m.text())) && !isCancelledRscFetch(m.text()) && !isTraceSnapshotInScriptlessFrame(m.text(), m.location().url)) errors.push(m.text());
  });
  page.on('pageerror', (e) => { if (!isCancelledRscFetch(e.message)) errors.push(`pageerror: ${e.message}`); });
  return errors;
}

/**
 * A navigation cancels Next's in-flight RSC link prefetches for this app's own pages. WebKit reports each one as
 * "<url>?_rsc=… due to access control checks." plus Next's "Failed to fetch RSC payload for <url>. Falling back to
 * browser navigation. TypeError: Load failed" (Chromium reports nothing). Only same-origin RSC requests match;
 * any other error, including a real cross-origin access-control failure, is still recorded.
 */
export function isCancelledRscFetch(text: string): boolean {
  const host = new URL(WEB_URL).host.replace(/[.]/g, '\\.');
  return new RegExp(`//?${host}/[^\\s?]*\\?_rsc=\\S+ due to access control checks\\.$`).test(text)
    || new RegExp(`^Failed to fetch RSC payload for https?://${host}/\\S*\\. Falling back to browser navigation\\. TypeError: Load failed$`).test(text);
}

/**
 * Playwright's trace recorder (trace: 'retain-on-failure') adds its snapshot script to every new document. The Studio
 * canvas (22-STUDIO) is a srcdoc frame sandboxed without allow-scripts, so Chromium refuses that script and logs one
 * error per frame document ("about:blank", then "about:srcdoc"). Only that exact refusal, from those frame documents, is
 * ignored: the app never runs script in the canvas (tests/e2e/studio-workspace.spec.ts proves injected script stays inert).
 */
export function isTraceSnapshotInScriptlessFrame(text: string, url: string | undefined): boolean {
  return /^about:(blank|srcdoc)$/.test(url ?? '')
    && /^Blocked script execution in 'about:(blank|srcdoc)' because the document's frame is sandboxed and the 'allow-scripts' permission is not set\.$/.test(text);
}

/** No element may make the page scroll sideways (RTL and 390 px layouts). */
export async function expectNoHorizontalOverflow(page: Page) {
  const { scroll, client } = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
  expect(scroll, 'page must not scroll horizontally').toBeLessThanOrEqual(client + 1);
}

export const test = base;
export { expect };

// ---------------------------------------------------------------------------
// Agent H additions (real-API browser scenarios). Append-only; the exports above
// are unchanged.
// ---------------------------------------------------------------------------

/** 1×1 PNG used as a delivery proof photo. */
export const TINY_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

/** Phone-sized context options (390 px, touch) for guests and drivers. */
export const MOBILE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true } as const;

async function okJson<T = any>(res: APIResponse): Promise<T> {
  const text = await res.text();
  expect(res.ok(), `${res.url()} → ${res.status()} ${text}`).toBeTruthy();
  return text ? JSON.parse(text) : (undefined as T);
}

/** Thin JSON client for one user against the real API (`p` is the path after `/v1`). */
export function apiAs(request: APIRequestContext, user: { token: string }) {
  const h = auth(user);
  return {
    get: async <T = any>(p: string) => okJson<T>(await request.get(`${API_URL}/v1${p}`, { headers: h })),
    post: async <T = any>(p: string, data: unknown = {}, headers: Record<string, string> = {}) =>
      okJson<T>(await request.post(`${API_URL}/v1${p}`, { headers: { ...h, ...headers }, data })),
    put: async <T = any>(p: string, data: unknown) => okJson<T>(await request.put(`${API_URL}/v1${p}`, { headers: h, data })),
    patch: async <T = any>(p: string, data: unknown) => okJson<T>(await request.patch(`${API_URL}/v1${p}`, { headers: h, data })),
    raw: (method: 'get' | 'post' | 'put' | 'patch' | 'delete', p: string, data?: unknown, headers: Record<string, string> = {}) =>
      request[method](`${API_URL}/v1${p}`, { headers: { ...h, ...headers }, data }),
  };
}

export interface MenuSeed { categoryId: string; burger: string; fries: string; sizeGroup: string; regular: string; large: string; extrasGroup: string; cheese: string }

/** Seeds a small bilingual menu through B1's menu API: a burger with a required Size and optional Extras, and plain fries. */
export async function apiSeedMenu(request: APIRequestContext, t: Tenant): Promise<MenuSeed> {
  const api = apiAs(request, t.owner);
  const base = `/o/${t.orgId}/menu`;
  const cat = await api.post(`${base}/categories`, { name: 'Mains', nameAr: 'الأطباق الرئيسية', defaultStation: 'Grill' });
  const burger = await api.post(`${base}/products`, { categoryId: cat.id, name: 'Smash burger', nameAr: 'برجر سماش', description: 'Double patty, pickles.', descriptionAr: 'قطعتان مع مخلل.', priceMinor: 18500, station: 'Grill' });
  const fries = await api.post(`${base}/products`, { categoryId: cat.id, name: 'Fries', nameAr: 'بطاطس', priceMinor: 4500, station: 'Grill' });
  // Creating an option returns its whole group (with options).
  const option = async (groupId: string, body: Record<string, unknown>) =>
    ((await api.post(`${base}/modifier-groups/${groupId}/options`, body)).options as Array<{ id: string; name: string }>).find((o) => o.name === body.name)!.id;
  const size = await api.post(`${base}/modifier-groups`, { name: 'Size', nameAr: 'الحجم', minSelect: 1, maxSelect: 1 });
  const regular = await option(size.id, { name: 'Regular', nameAr: 'عادي', priceDeltaMinor: 0 });
  const large = await option(size.id, { name: 'Large', nameAr: 'كبير', priceDeltaMinor: 3000 });
  const extras = await api.post(`${base}/modifier-groups`, { name: 'Extras', nameAr: 'إضافات', minSelect: 0, maxSelect: 2 });
  const cheese = await option(extras.id, { name: 'Cheese', nameAr: 'جبنة', priceDeltaMinor: 1500 });
  await api.put(`${base}/products/${burger.id}/modifier-groups`, { groupIds: [size.id, extras.id] });
  return { categoryId: cat.id, burger: burger.id, fries: fries.id, sizeGroup: size.id, regular, large, extrasGroup: extras.id, cheese };
}

export interface FloorTableSeed { label: string; capacity?: number; shape?: 'square' | 'round' | 'rect'; cx: number; cy: number; reservable?: boolean }

/** Saves a floor (one "Main Room" zone, an entrance and the given tables) through B1's floor API; returns the saved layout. */
export async function apiSaveFloor(request: APIRequestContext, t: Tenant, tables: FloorTableSeed[] = [{ label: 'T1', cx: 250, cy: 220 }, { label: 'T2', cx: 520, cy: 220 }]) {
  const api = apiAs(request, t.owner);
  const current = await api.get(`/o/${t.orgId}/floor/${t.branchId}`);
  return api.put(`/o/${t.orgId}/floor/${t.branchId}`, {
    baseRevision: current.revision, key: unique('floor'),
    layout: {
      width: current.width, height: current.height, background: current.background,
      zones: [{ id: 'z-main', type: 'zone', label: 'Main Room', x: 600, y: 300, width: 1080, height: 470, rotation: 0, color: '#e9e6dc' }],
      objects: [{ id: 'o-door', type: 'door', label: 'Entrance', x: 110, y: 742, width: 110, height: 35, rotation: 0 }],
      tables: tables.map((x) => ({ label: x.label, capacity: x.capacity ?? 4, zone: 'Main Room', shape: x.shape ?? 'square', cx: x.cx, cy: x.cy, width: 100, height: 100, rotation: 0, reservable: x.reservable ?? true })),
    },
  });
}

/** The staff print sheet (`GET /floor/:branchId/qr`), the only place table QR URLs appear. */
export async function apiQrSheet(request: APIRequestContext, t: Tenant): Promise<Array<{ tableId: string; label: string; url: string; svg: string }>> {
  return (await apiAs(request, t.owner).get(`/o/${t.orgId}/floor/${t.branchId}/qr`)).items;
}

/** Path part (`/t/<qr>`) of a QR URL issued for APP_ORIGIN. */
export const qrPath = (url: string) => new URL(url).pathname;

/** Invites a newly signed-up member (not yet accepted). Returns the user and the raw invitation token. */
export async function apiInvite(request: APIRequestContext, t: Tenant, role: string, branchIds: string[] | null = null) {
  const user = await apiSignup(request, `${role[0]!.toUpperCase()}${role.slice(1)} ${unique('m').slice(-4)}`);
  const inv = await apiAs(request, t.owner).post(`/o/${t.orgId}/invitations`, { email: user.email, role, branchIds });
  return { user, token: inv.token as string };
}

/** Invites and accepts through the API (for staff whose onboarding is not under test). */
export async function apiAddMember(request: APIRequestContext, t: Tenant, role: string, branchIds: string[] | null = null) {
  const { user, token } = await apiInvite(request, t, role, branchIds);
  await apiAs(request, user).post('/invitations/accept', { token });
  return user;
}

/** A fresh browser context, optionally signed in as `user`, phone-sized and localised. */
/**
 * Phone contexts use the running project's device when it is a phone (the WebKit iPhone 13 project, CR-10), so the
 * guest and driver flows run with that device's viewport, touch, pixel ratio and user agent; otherwise the 390 px
 * Chromium profile.
 */
function phoneProfile() {
  try {
    const use = base.info().project.use;
    if (use.isMobile && use.viewport) {
      return { viewport: use.viewport, userAgent: use.userAgent, deviceScaleFactor: use.deviceScaleFactor, isMobile: true, hasTouch: use.hasTouch ?? true };
    }
  } catch { /* called outside a test */ }
  return MOBILE;
}

export async function newContext(browser: Browser, opts: { user?: User; locale?: 'en' | 'ar'; mobile?: boolean } = {}): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ baseURL: WEB_URL, reducedMotion: 'reduce', ...(opts.mobile ? phoneProfile() : { viewport: { width: 1280, height: 860 } }) });
  await context.addCookies([{ name: 'resuto_locale', value: opts.locale ?? 'en', url: WEB_URL }]);
  const page = await context.newPage();
  if (opts.user) await signIn(page, opts.user, opts.locale ?? 'en');
  return { context, page };
}

/**
 * Records every failed call to the Resuto API (status ≥ 400 or a network failure).
 * `allow` lists expected failures per URL pattern (e.g. intentional 402/403 checks).
 */
export function collectApiFailures(page: Page, allow: Array<{ url: RegExp; status?: number }> = []) {
  const failures: string[] = [];
  page.on('response', (r) => {
    if (!r.url().startsWith(API_URL) || r.request().method() === 'OPTIONS' || r.status() < 400) return;
    if (allow.some((a) => a.url.test(r.url()) && (a.status === undefined || a.status === r.status()))) return;
    failures.push(`${r.request().method()} ${r.url().replace(API_URL, '')} → ${r.status()}`);
  });
  page.on('requestfailed', (r) => {
    if (!r.url().startsWith(API_URL)) return;
    const reason = r.failure()?.errorText ?? 'failed';
    if (/ERR_ABORTED|NS_BINDING_ABORTED|Load request cancelled/.test(reason)) return; // navigations cancel in-flight polls (Chromium, Firefox, WebKit wording)
    failures.push(`${r.method()} ${r.url().replace(API_URL, '')} → ${reason}`);
  });
  return failures;
}

/** Polls `fn` until it returns a truthy value (server-side effects such as outbox handlers). */
export async function eventually<T>(fn: () => Promise<T | null | undefined | false>, opts: { timeout?: number; interval?: number; message?: string } = {}): Promise<T> {
  const until = Date.now() + (opts.timeout ?? 20_000);
  let last: unknown;
  while (Date.now() < until) {
    try { const v = await fn(); if (v) return v as T; last = v; } catch (e) { last = e; }
    await new Promise((r) => setTimeout(r, opts.interval ?? 400));
  }
  throw new Error(`${opts.message ?? 'condition not met'} (last: ${last instanceof Error ? last.message : JSON.stringify(last)})`);
}

/**
 * On a hosted checkout (`/pay/<token>`): choose an online method, pay with the sandbox provider, land back on the receipt.
 * Works in either language: `method` matches the method's label (EN "Card", AR "بطاقة").
 */
export async function paySandboxInBrowser(page: Page, method: RegExp = /Card/) {
  await expect(page).toHaveURL(/\/pay\/[^/?]+/);
  await page.getByRole('radio').filter({ hasText: method }).first().click();
  await page.getByRole('button', { name: /^(Pay|ادفع) / }).click();
  await expect(page).toHaveURL(/\/pay\/[^/]+\/sandbox/);
  await page.getByRole('button', { name: /^(Simulate successful payment|محاكاة دفع ناجح)$/ }).click();
  await expect(page).toHaveURL(/\/pay\/[^/]+\?return=1/);
}

// ---------------------------------------------------------------------------
// REM-W09: the dashboard shell by role and accessible name (not CSS classes), in either language.
// ---------------------------------------------------------------------------

/** The dashboard's workspace navigation: the `<aside>` landmark labelled "Workspace navigation" (AR "تنقل مساحة العمل"). */
export const workspaceNav = (page: Page) => page.getByRole('complementary', { name: /^(Workspace navigation|تنقل مساحة العمل)$/ });

/** A link to a dashboard page in the workspace navigation (`path` relative to the restaurant, e.g. "/orders"). */
export const navLinkFor = (page: Page, path: string) => workspaceNav(page).locator(`a[href$="${path}"]`);

/** The "Explore Resuto" entry: modules outside the plan are listed there, never as disabled navigation (21-SHELL). */
export const exploreLink = (page: Page) => workspaceNav(page).getByRole('link', { name: /^(Explore Resuto|اكتشف ريسوتو)$/ });

/**
 * expect(target).toHaveScreenshot(name), except that the CI visual job (E2E_RECORD_MISSING_BASELINES=1) records a
 * baseline that is not committed yet instead of failing: it is written where toHaveScreenshot looks for it and
 * uploaded with the job's artifact for the owner to approve (docs/ui/visual-baselines.json, CR-11). A committed
 * baseline is always compared. Playwright 1.56's --update-snapshots=missing writes the file but fails the test.
 */
export async function matchScreenshot(target: Page | Locator, name: string, options: Pick<PageAssertionsToHaveScreenshotOptions, 'fullPage' | 'mask' | 'maxDiffPixelRatio' | 'style'> = {}) {
  const expected = test.info().snapshotPath(name, { kind: 'screenshot' });
  if (process.env.E2E_RECORD_MISSING_BASELINES === '1' && !existsSync(expected)) {
    mkdirSync(path.dirname(expected), { recursive: true });
    const { maxDiffPixelRatio: _, ...shot } = options;
    await target.screenshot({ ...shot, path: expected, animations: 'disabled', caret: 'hide', scale: 'css' });
    test.info().annotations.push({ type: 'baseline recorded (not compared)', description: path.relative(ROOT, expected) });
    return;
  }
  if ('goto' in target) await expect(target).toHaveScreenshot(name, options);
  else await expect(target).toHaveScreenshot(name, options);
}
