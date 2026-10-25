import { request as playwrightRequest, type Page, type Request } from '@playwright/test';
import { apiAddMember, apiAs, apiCreateTenant, apiSeedMenu, collectApiFailures, collectErrors, expect, newContext, sql, test, workspaceNav, type Tenant, type User } from './fixtures';

// Insights area (21-INSIGHTS), Chromium: a drill-down from the overview command centre lands on the matching Insights
// view with the same period, comparison and branch; a member saves a report view and reopens it (and a colleague sees
// it once shared); the former Analytics tab links still work.

let tenant: Tenant;
let second: string;
let manager: User;

test.beforeAll(async () => {
  const request = await playwrightRequest.newContext();
  tenant = await apiCreateTenant(request, { planId: 'pro' });
  await apiSeedMenu(request, tenant);
  second = (await apiAs(request, tenant.owner).post(`/o/${tenant.orgId}/branches`, { name: 'Maadi' })).id;
  manager = await apiAddMember(request, tenant, 'manager');
  await request.dispose();
});

test.describe.configure({ timeout: 120_000 });

const base = () => `/dashboard/${tenant.orgId}`;
const localDate = (offsetDays = 0) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Cairo', year: 'numeric', month: '2-digit', day: '2-digit' })
  .format(new Date(Date.now() + offsetDays * 86_400_000));
const isSummary = (r: Request) => r.method() === 'GET' && r.url().includes(`/o/${tenant.orgId}/analytics/summary?`);
const params = (r: Request) => new URL(r.url()).searchParams;
async function homeReady(page: Page) {
  await expect(workspaceNav(page).getByRole('button', { name: /^(Operations|التشغيل)$/ })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole('heading', { name: 'Performance', level: 2 })).toBeVisible({ timeout: 20_000 });
}

test('drill-down from the overview keeps the period, comparison and branch', async ({ browser }) => {
  const { context, page } = await newContext(browser, { user: tenant.owner });
  const errors = collectErrors(page);
  const failures = collectApiFailures(page);
  try {
    await page.goto(`${base()}?period=7d&compare=last_year`);
    await homeReady(page);
    // The shell's branch: Maadi.
    await workspaceNav(page).getByRole('button', { name: /^Switch branch/ }).click();
    await page.getByRole('menuitem', { name: /Maadi/ }).click();
    const main = page.getByRole('main');
    const tile = main.locator('[data-section="performance"] a.rui-stat').first();
    await expect(tile).toHaveAttribute('href', `${base()}/analytics/sales?period=7d&compare=last_year&branch=${second}`);
    await expect(tile).toHaveAttribute('data-provenance', 'live');

    const summary = page.waitForRequest((r) => isSummary(r) && params(r).get('compare') === 'last_year');
    await tile.click();
    const q = params(await summary);
    expect(q.get('from')).toBe(localDate(-6));
    expect(q.get('to')).toBe(localDate());
    expect(q.get('branchId')).toBe(second);
    // The branch was applied to the shell and left the URL; the period and comparison stay in it.
    await expect(page).toHaveURL(new RegExp(`${base()}/analytics/sales\\?period=7d&compare=last_year$`));
    await expect(page.getByRole('heading', { name: 'Sales', level: 1 })).toBeVisible();
    await expect(main.getByLabel('Period', { exact: true })).toHaveValue('7d');
    await expect(main.getByRole('radio', { name: 'Same period last year' })).toHaveAttribute('aria-checked', 'true');
    await expect(main.getByRole('navigation', { name: 'Insights' }).getByRole('link', { name: 'Sales' })).toHaveAttribute('aria-current', 'page');
    await expect(workspaceNav(page).getByRole('button', { name: /^Switch branch/ })).toContainText('Maadi');

    // Back on the overview with custom dates and all branches: the ratings tile keeps both.
    await workspaceNav(page).getByRole('button', { name: /^Switch branch/ }).click();
    await page.getByRole('menuitem', { name: /All branches/ }).click();
    await page.goto(`${base()}?period=custom&from=${localDate(-20)}&to=${localDate(-2)}&compare=none`);
    await homeReady(page);
    const ratingsTile = main.locator('[data-section="performance"] a.rui-stat').last();
    await expect(ratingsTile).toHaveAttribute('href', `${base()}/analytics/ratings?period=custom&from=${localDate(-20)}&to=${localDate(-2)}&compare=none&branch=all`);
    const ratings = page.waitForRequest((r) => r.url().includes(`/o/${tenant.orgId}/analytics/ratings?`) && params(r).get('from') === localDate(-20));
    await ratingsTile.click();
    const rq = params(await ratings);
    expect(rq.get('to')).toBe(localDate(-2));
    expect(rq.get('branchId')).toBeNull();
    await expect(page).toHaveURL(new RegExp('/analytics/ratings\\?period=custom'));
    await expect(main.getByLabel('From', { exact: true })).toHaveValue(localDate(-20));
    expect(errors).toEqual([]);
    expect(failures).toEqual([]);
  } finally {
    await context.close();
  }
});

test('save a report view and reopen it; a shared report reaches a colleague', async ({ browser }) => {
  const { context, page } = await newContext(browser, { user: tenant.owner });
  const errors = collectErrors(page);
  try {
    await page.goto(`${base()}/analytics/sales?period=7d&compare=none`);
    const main = page.getByRole('main');
    await expect(page.getByRole('heading', { name: 'Sales', level: 1 })).toBeVisible({ timeout: 20_000 });
    await main.getByRole('button', { name: 'Save view' }).click();
    const form = main.getByRole('dialog', { name: 'Save view' });
    await form.getByLabel('Report name').fill('Weekly sales, no comparison');
    await form.getByRole('switch', { name: 'Share with the team' }).check();
    const saved = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith(`/o/${tenant.orgId}/reports`) && r.status() === 201);
    await form.getByRole('button', { name: 'Save report' }).click();
    const report = await (await saved).json();
    expect(report).toMatchObject({ name: 'Weekly sales, no comparison', section: 'sales', view: { period: '7d', compare: 'none' }, branchId: null, shared: true });
    await expect(page).toHaveURL(new RegExp(`report=${report.id}`));
    const [row] = await sql(`select user_id, shared, section, view from saved_reports where id = $1`, [report.id]);
    expect(row).toMatchObject({ user_id: tenant.owner.userId, shared: true, section: 'sales', view: { period: '7d', compare: 'none' } });

    // Reopen it from the overview's list on another period.
    await page.goto(`${base()}/analytics?period=today`);
    const list = main.locator('#saved-reports');
    const link = list.getByRole('link', { name: 'Weekly sales, no comparison' });
    await expect(link).toBeVisible({ timeout: 20_000 });
    const summary = page.waitForRequest((r) => isSummary(r) && params(r).get('compare') === 'none' && params(r).get('from') === localDate(-6));
    await link.click();
    expect(params(await summary).get('to')).toBe(localDate());
    await expect(page).toHaveURL(new RegExp(`/analytics/sales\\?period=7d&compare=none&report=${report.id}$`));
    await expect(main.getByLabel('Period', { exact: true })).toHaveValue('7d');
    await expect(main.getByRole('radio', { name: 'No comparison' })).toHaveAttribute('aria-checked', 'true');
    await expect(main.getByText('Weekly sales, no comparison')).toBeVisible();
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }

  // The colleague sees it under "Shared by colleagues", read-only, and opens the same view.
  const other = await newContext(browser, { user: manager });
  try {
    const page = other.page;
    await page.goto(`${base()}/analytics`);
    const list = page.getByRole('main').locator('#saved-reports');
    await expect(list.getByRole('link', { name: 'Weekly sales, no comparison' })).toBeVisible({ timeout: 20_000 });
    await expect(list.getByRole('button', { name: /Delete/ })).toHaveCount(0);
    const summary = page.waitForRequest((r) => isSummary(r) && params(r).get('compare') === 'none');
    await list.getByRole('link', { name: 'Weekly sales, no comparison' }).click();
    expect(params(await summary).get('from')).toBe(localDate(-6));
  } finally {
    await other.context.close();
  }
});

test('the former Analytics tabs and the intelligence customers screen still open their views (also in Arabic)', async ({ browser }) => {
  const { context, page } = await newContext(browser, { user: tenant.owner, locale: 'ar' });
  try {
    await page.goto(`${base()}/analytics?tab=guests`);
    await expect(page).toHaveURL(new RegExp(`${base()}/analytics/ratings`), { timeout: 20_000 });
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    const nav = page.getByRole('main').getByRole('navigation', { name: 'الرؤى' });
    await expect(nav.getByRole('link', { name: 'التقييمات' })).toHaveAttribute('aria-current', 'page');
    await expect(nav).not.toContainText(/[٠-٩]/);
    await page.goto(`${base()}/intelligence/customers`);
    await expect(page).toHaveURL(new RegExp(`${base()}/analytics/customers`));
    await page.goto(`${base()}/intelligence/forecast`);
    await expect(nav.getByRole('link', { name: 'التوقعات' })).toHaveAttribute('aria-current', 'page');
    // An unknown analytics view opens the overview.
    await page.goto(`${base()}/analytics/nope`);
    await expect(page).toHaveURL(new RegExp(`${base()}/analytics$`));
  } finally {
    await context.close();
  }
});
