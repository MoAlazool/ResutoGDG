import { request as playwrightRequest, type Page, type Request } from '@playwright/test';
import { apiAs, apiCreateTenant, apiSeedMenu, collectErrors, expect, newContext, setLocale, sql, test, workspaceNav, type Tenant } from './fixtures';

// Overview command centre (21-HOME), Chromium: the period picker and comparison drive GET analytics/overview (and stay
// in the URL across a reload), the shell's branch switcher drives every request on the page (no branch select of its
// own), "Needs attention" links to the screen that resolves an item, and "Customise" (show/hide/reorder) is saved per
// user and survives a reload.

let tenant: Tenant;
let second: string;

test.beforeAll(async () => {
  const request = await playwrightRequest.newContext();
  tenant = await apiCreateTenant(request, { planId: 'pro' });
  await apiSeedMenu(request, tenant);
  second = (await apiAs(request, tenant.owner).post(`/o/${tenant.orgId}/branches`, { name: 'Maadi' })).id;
  await request.dispose();
  // Something that needs attention: an AI creative draft waiting for review.
  await sql(`insert into creative_assets(org_id, kind, prompt, output, provider) values ($1, 'caption', 'Eid', '{"text":"Eid"}', 'template_rules')`, [tenant.orgId]);
});

test.describe.configure({ timeout: 120_000 });

const base = () => `/dashboard/${tenant.orgId}`;
const localDate = (offsetDays = 0) => {
  const d = new Date(Date.now() + offsetDays * 86_400_000);
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Cairo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
};
const isOverview = (r: Request) => r.method() === 'GET' && r.url().includes(`/o/${tenant.orgId}/analytics/overview?`);
const params = (r: Request) => new URL(r.url()).searchParams;
async function ready(page: Page) {
  await expect(workspaceNav(page).getByRole('button', { name: /^(Operations|التشغيل)$/ })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole('heading', { name: 'Performance', level: 2 })).toBeVisible({ timeout: 20_000 });
}
const sectionOrder = (page: Page) => page.locator('main section[data-section]').evaluateAll((els) => els.map((e) => e.getAttribute('data-section')));

test('period, comparison and the shell branch drive the overview, and the period survives a reload', async ({ browser }) => {
  const { context, page } = await newContext(browser, { user: tenant.owner });
  const errors = collectErrors(page);
  try {
    // Default: today, compared with the previous period, all branches (the overview supports "All branches").
    const first = page.waitForRequest(isOverview);
    await page.goto(base());
    const r0 = params(await first);
    await ready(page);
    expect(r0.get('from')).toBe(localDate());
    expect(r0.get('to')).toBe(localDate());
    expect(r0.get('compare')).toBe('previous_period');
    expect(r0.get('branchId')).toBeNull();
    const main = page.getByRole('main');
    await expect(main.getByRole('combobox', { name: 'Branch' })).toHaveCount(0);
    // Every KPI says where it comes from.
    await expect(main.locator('[data-section="performance"] .rui-stat')).toHaveCount(5);
    await expect(main.locator('[data-section="performance"] .rui-stat[data-provenance="live"]').first()).toBeVisible();

    // Last 7 days.
    const seven = page.waitForRequest((r) => isOverview(r) && params(r).get('from') === localDate(-6));
    await main.getByRole('radio', { name: 'Last 7 days' }).click();
    expect(params(await seven).get('to')).toBe(localDate());
    await expect(page).toHaveURL(/period=7d/);

    // Same period last year.
    const ly = page.waitForRequest((r) => isOverview(r) && params(r).get('compare') === 'last_year');
    await main.getByRole('radiogroup', { name: 'Compare with' }).getByRole('radio', { name: 'Same period last year' }).click();
    expect(params(await ly).get('from')).toBe(localDate(-6));
    await expect(page).toHaveURL(/compare=last_year/);

    // A reload keeps both.
    const again = page.waitForRequest((r) => isOverview(r) && params(r).get('compare') === 'last_year' && params(r).get('from') === localDate(-6));
    await page.reload();
    await again;
    await ready(page);
    await expect(main.getByRole('radio', { name: 'Last 7 days' })).toHaveAttribute('aria-checked', 'true');
    await expect(main.getByRole('radio', { name: 'Same period last year' })).toHaveAttribute('aria-checked', 'true');

    // Custom dates.
    await main.getByRole('radio', { name: 'Custom dates' }).click();
    const from = main.getByLabel('From', { exact: true });
    await expect(from).toBeVisible();
    const custom = page.waitForRequest((r) => isOverview(r) && params(r).get('from') === localDate(-20));
    await from.fill(localDate(-20));
    // Custom starts from the range that was shown (the last 7 days), so the end stays today.
    expect(params(await custom).get('to')).toBe(localDate());
    await expect(page).toHaveURL(new RegExp(`period=custom.*from=${localDate(-20)}`));

    // The shell's branch switcher drives the overview and the attention list.
    const branchOverview = page.waitForRequest((r) => isOverview(r) && params(r).get('branchId') === second);
    const branchAttention = page.waitForRequest((r) => r.url().includes(`/o/${tenant.orgId}/attention?branchId=${second}`));
    await workspaceNav(page).getByRole('button', { name: /^Switch branch/ }).click();
    await page.getByRole('menuitem', { name: /Maadi/ }).click();
    await branchOverview;
    await branchAttention;
    await workspaceNav(page).getByRole('button', { name: /^Switch branch/ }).click();
    await page.getByRole('menuitem', { name: /All branches/ }).click();
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
});

test('needs attention links to the screen that resolves it', async ({ browser }) => {
  const { context, page } = await newContext(browser, { user: tenant.owner });
  try {
    await page.goto(base());
    await ready(page);
    const item = page.locator('[data-section="attention"] li[data-kind="creative_approvals"]');
    await expect(item).toBeVisible();
    await expect(item).toContainText('Creative awaiting review');
    await expect(item.locator('.rui-provenance')).toContainText('Live');
    await expect(item.getByRole('link', { name: /Open/ })).toHaveAttribute('href', `${base()}/website?tab=creative`);
  } finally {
    await context.close();
  }
});

test('Customise: hide and reorder sections, saved for the user and kept after a reload', async ({ browser }) => {
  const { context, page } = await newContext(browser, { user: tenant.owner });
  const errors = collectErrors(page);
  try {
    await page.goto(base());
    await ready(page);
    expect(await sectionOrder(page)).toEqual(['now', 'performance', 'attention', 'customers', 'actions']);

    await page.getByRole('button', { name: 'Customise' }).click();
    const sheet = page.getByRole('dialog', { name: 'Customise the overview' });
    await expect(sheet).toBeVisible();
    const saved = () => page.waitForResponse((r) => r.request().method() === 'PUT' && r.url().endsWith(`/o/${tenant.orgId}/preferences/overview`) && r.status() === 200);
    let put = saved();
    await sheet.getByRole('switch', { name: 'Customers & channels' }).click();
    await put;
    put = saved();
    await sheet.getByRole('button', { name: 'Move Needs attention up' }).click();
    await put;
    put = saved();
    await sheet.getByRole('button', { name: 'Move Needs attention up' }).click();
    await put;
    await expect(sheet.getByRole('status')).toHaveText('Saved');
    await sheet.getByRole('button', { name: 'Done' }).click();
    await expect(sheet).toBeHidden();
    expect(await sectionOrder(page)).toEqual(['attention', 'now', 'performance', 'actions']);

    await page.reload();
    await expect(page.getByRole('heading', { name: 'Needs attention', level: 2 })).toBeVisible({ timeout: 20_000 });
    await expect.poll(() => sectionOrder(page)).toEqual(['attention', 'now', 'performance', 'actions']);
    await expect(page.getByRole('heading', { name: 'Customers & channels', level: 2 })).toHaveCount(0);

    // In Arabic (same user, same saved layout), right to left with Western digits.
    await setLocale(page, 'ar');
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    await expect(page.getByRole('heading', { name: 'يحتاج انتباهك', level: 2 })).toBeVisible({ timeout: 20_000 });
    await expect.poll(() => sectionOrder(page)).toEqual(['attention', 'now', 'performance', 'actions']);
    expect(await page.getByRole('main').innerText()).not.toMatch(/[٠-٩]/);

    // Reset to default.
    await page.getByRole('button', { name: 'تخصيص' }).click();
    const ar = page.getByRole('dialog', { name: 'تخصيص النظرة العامة' });
    const reset = saved();
    await ar.getByRole('button', { name: 'استعادة الترتيب الافتراضي' }).click();
    await reset;
    await ar.getByRole('button', { name: 'تم', exact: true }).click();
    await expect.poll(() => sectionOrder(page)).toEqual(['now', 'performance', 'attention', 'customers', 'actions']);
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
});
