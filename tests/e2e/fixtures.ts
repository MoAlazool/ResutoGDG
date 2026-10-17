// Reusable end-to-end fixtures: API helpers (sign up, create tenant, publish a
// site, upload media), SQL seed helpers against the e2e database, signing a
// browser in, and console-error collection.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test as base, type APIRequestContext, type Page } from '@playwright/test';
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

export async function apiCreateTenant(request: APIRequestContext, opts: { name?: string; nameAr?: string; planId?: string; country?: 'EG' | 'SA' } = {}): Promise<Tenant> {
  const owner = await apiSignup(request);
  const slug = unique('r').toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 40);
  const res = await request.post(`${API_URL}/v1/orgs`, {
    headers: auth(owner),
    data: { name: opts.name ?? 'The Olive Room', nameAr: opts.nameAr ?? 'غرفة الزيتون', slug, country: opts.country ?? 'EG', planId: opts.planId ?? 'pro',
      branch: { name: 'Zamalek', city: 'Cairo', phone: '+201001234567', acceptsDelivery: true, deliveryFeeMinor: 3500,
        openingHours: [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, opens: '12:00', closes: '23:30' })) } },
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
  const hero = await uploadImage(request, t, path.join(ROOT, 'apps/web/public/landing/olive-interior.webp'), 'Dining room with olive banquettes');
  const plate = await uploadImage(request, t, path.join(ROOT, 'apps/web/public/landing/olive-burrata.webp'), 'Burrata with heirloom tomatoes');
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
  expect(pub.status(), await pub.text()).toBe(201);
}

/** Signs the browser in with an API-issued dev token (same storage the app uses). */
export async function signIn(page: Page, user: User, locale: 'en' | 'ar' = 'en') {
  await page.context().addCookies([{ name: 'resuto_locale', value: locale, url: WEB_URL }]);
  await page.goto('/login');
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
  page.on('console', (m) => { if (m.type() === 'error' && !ignore.some((r) => r.test(m.text()))) errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  return errors;
}

/** No element may make the page scroll sideways (RTL and 390 px layouts). */
export async function expectNoHorizontalOverflow(page: Page) {
  const { scroll, client } = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
  expect(scroll, 'page must not scroll horizontally').toBeLessThanOrEqual(client + 1);
}

export const test = base;
export { expect };
