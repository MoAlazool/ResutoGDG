import { request as playwrightRequest } from '@playwright/test';
import {
  API_URL, apiAs, apiCreateTenant, apiSignup, collectErrors, expect, expectNoHorizontalOverflow, newContext, sql, test, unique,
  type Tenant, type User,
} from './fixtures';

// 21-ADMIN in the browser: the operator console on the 2.1 design. A platform superadmin sees the console (EN and
// AR, phone tab bar), reaches a restaurant from the list with the keyboard alone, and sees the provider apps with
// their readiness and the URLs to register while a stored secret never reaches the page. A restaurant owner without
// a platform role is refused in the browser and by the API (403), and the API refuses anonymous calls (401).

let tenant: Tenant;
let superadmin: User;
const NAME = unique('Keyboard Bistro');
const SECRET = 'e2e-admin-console-secret-4321';

test.beforeAll(async () => {
  const request = await playwrightRequest.newContext();
  tenant = await apiCreateTenant(request, { name: NAME, nameAr: 'مطعم لوحة المفاتيح' });
  superadmin = await apiSignup(request, 'Console Operator');
  await sql(`insert into platform_admins(user_id, role) values ($1, 'superadmin') on conflict do nothing`, [superadmin.userId]);
  await apiAs(request, superadmin).put('/admin/providers/snapchat_ads', { appId: 'snap-e2e-console-app', secrets: { appSecret: SECRET } });
  await request.dispose();
});

test.afterAll(async () => { await sql(`delete from platform_provider_apps where provider = 'snapchat_ads'`); });

test('a platform operator sees the console: sections, role, account menu; Arabic is right-to-left', async ({ browser }) => {
  const { context, page } = await newContext(browser, { user: superadmin });
  const errors = collectErrors(page);
  await page.goto('/admin');
  await expect(page.getByRole('heading', { name: 'Restaurants', level: 1 })).toBeVisible();
  const nav = page.getByRole('navigation', { name: 'Resuto admin' });
  await expect(nav.getByRole('link')).toHaveText(['Restaurants', 'Prices', 'Operations', 'Provider apps']);
  await expect(nav.getByRole('link', { name: 'Restaurants' })).toHaveAttribute('aria-current', 'page');
  await expect(page.getByText('Role: Superadmin').first()).toBeVisible();

  await nav.getByRole('link', { name: 'Operations' }).click();
  await expect(page).toHaveURL(/\/admin\/operations$/);
  await expect(page.getByRole('heading', { name: 'Operations', level: 1 })).toBeVisible();
  await expect(page.locator('[data-tile]')).toHaveCount(4);
  await expect(page.locator('[data-tile] .rui-provenance').first()).toHaveText('Live');
  await expect(nav.getByRole('link', { name: 'Operations' })).toHaveAttribute('aria-current', 'page');

  // The account menu opens without signing out.
  await page.getByRole('button', { name: /^Account menu: / }).first().click();
  await expect(page.getByRole('menuitem', { name: 'Sign out' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page).toHaveURL(/\/admin\/operations$/);
  expect(errors).toEqual([]);
  await context.close();

  const ar = await newContext(browser, { user: superadmin, locale: 'ar' });
  await ar.page.goto('/admin');
  await expect(ar.page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(ar.page.getByRole('heading', { name: 'المطاعم', level: 1 })).toBeVisible();
  await expect(ar.page.getByRole('navigation', { name: 'إدارة ريسوتو' }).getByRole('link', { name: 'الأسعار' })).toBeVisible();
  await expect(ar.page.getByText('الدور: مسؤول أعلى').first()).toBeVisible();
  await expectNoHorizontalOverflow(ar.page);
  await ar.context.close();
});

test('restaurants list: search, then reach the restaurant with the keyboard alone', async ({ browser }) => {
  const { context, page } = await newContext(browser, { user: superadmin });
  const errors = collectErrors(page);
  await page.goto('/admin');
  const search = page.getByRole('searchbox', { name: 'Search by name, slug or id' });
  await search.fill(tenant.slug);
  await expect(page).toHaveURL(new RegExp(`[?&]q=${tenant.slug}`));
  const table = page.getByRole('table', { name: 'Restaurants' });
  const rowLink = table.getByRole('link', { name: new RegExp(NAME) });
  await expect(rowLink).toBeVisible();
  await expect(table.getByRole('row')).toHaveCount(2); // header + the one match
  await expect(page.locator('.rui-filter-chip')).toHaveText([`Search: ${tenant.slug}`]);

  // Tab from the search box until the row's link has focus, then open it with Enter.
  await search.focus();
  let reached = false;
  for (let i = 0; i < 40 && !reached; i++) {
    await page.keyboard.press('Tab');
    reached = await rowLink.evaluate((el) => el === document.activeElement);
  }
  expect(reached, 'the row link is reachable with Tab').toBe(true);
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(new RegExp(`/admin/tenants/${tenant.orgId}$`));
  await expect(page.getByRole('heading', { name: NAME, level: 1 })).toBeVisible();
  await expect(page.getByRole('complementary', { name: 'Overview' })).toContainText(tenant.orgId);
  await expect(page.getByRole('button', { name: 'Suspend restaurant' })).toBeVisible();
  await page.getByRole('link', { name: 'Restaurants' }).first().focus();
  expect(errors).toEqual([]);
  await context.close();
});

test('provider apps: readiness and the URLs to register; a stored secret is never sent to the page', async ({ browser }) => {
  const { context, page } = await newContext(browser, { user: superadmin });
  const errors = collectErrors(page);
  await page.goto('/admin/providers');
  await expect(page.getByRole('heading', { name: 'Resuto’s provider apps' })).toBeVisible();
  for (const p of ['meta', 'tiktok_ads', 'snapchat_ads', 'foodics']) await expect(page.locator(`section[data-provider="${p}"]`)).toBeVisible();
  const snap = page.locator('section[data-provider="snapchat_ads"]');
  await expect(snap.getByText(/\d+ of \d+ ready/).first()).toBeVisible();
  await expect(snap.getByText('Set (…4321)')).toBeVisible();
  await expect(snap.getByLabel('App secret')).toHaveValue('');
  await expect(snap.getByRole('button', { name: 'Copy' }).first()).toBeVisible();
  await expect(snap.locator('code').filter({ hasText: '/v1/public/integrations/oauth/snapchat_ads/callback' })).toBeVisible();
  expect(await page.content()).not.toContain(SECRET);
  // The section navigation lists every app.
  await expect(page.getByRole('navigation', { name: 'Provider apps' }).getByRole('link')).toHaveCount(4);
  expect(errors).toEqual([]);
  await context.close();
});

test('a member without a platform role is refused by the console and the API; anonymous calls get 401', async ({ browser }) => {
  const request = await playwrightRequest.newContext();
  for (const path of ['/admin/me', '/admin/tenants', `/admin/tenants/${tenant.orgId}`, '/admin/operations', '/admin/prices', '/admin/providers']) {
    expect((await request.get(`${API_URL}/v1${path}`, { headers: { Authorization: `Bearer ${tenant.owner.token}` } })).status(), path).toBe(403);
    expect((await request.get(`${API_URL}/v1${path}`)).status(), path).toBe(401);
  }
  await request.dispose();

  const owner = await newContext(browser, { user: tenant.owner });
  for (const path of ['/admin', '/admin/providers', `/admin/tenants/${tenant.orgId}`]) {
    await owner.page.goto(path);
    await expect(owner.page.getByText('Platform administrators only.')).toBeVisible();
    await expect(owner.page.getByRole('navigation', { name: 'Resuto admin' })).toHaveCount(0);
    await expect(owner.page.getByRole('table')).toHaveCount(0);
  }
  await owner.context.close();
});

test('phone: the console navigation is a bottom tab bar and nothing scrolls sideways', async ({ browser }) => {
  const { context, page } = await newContext(browser, { user: superadmin, mobile: true });
  await page.goto('/admin/prices');
  const tabs = page.getByRole('navigation', { name: 'Main sections' });
  await expect(tabs.getByRole('link')).toHaveCount(4);
  await expect(tabs.getByRole('link', { name: 'Prices' })).toHaveAttribute('aria-current', 'page');
  await expect(page.getByRole('heading', { name: 'Plan and module prices', level: 1 })).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await context.close();
});
