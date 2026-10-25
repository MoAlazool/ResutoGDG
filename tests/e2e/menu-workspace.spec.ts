import path from 'node:path';
import { request as playwrightRequest, type APIRequestContext, type Page } from '@playwright/test';
import {
  apiAs, apiCreateTenant, apiSeedMenu, collectApiFailures, collectErrors, expect, expectNoHorizontalOverflow, newContext, ROOT, test, type MenuSeed,
  type Tenant,
} from './fixtures';

// 21-MENU (plan §8 acceptance: bulk edit, availability, reorder): the menu workspace against the real API. Category
// reorder by keyboard and by drag, the inline availability switch (86 at the shell's branch), bulk edit (keyboard
// selection, price change with its preview, move to a category, sold out, archive), and Import as an action (CSV and
// .xlsx through the spreadsheet worker), with the assisted import still reachable at /menu-import.

const XLSX = path.join(ROOT, 'apps/web/lib/onboarding/__fixtures__/menu.xlsx');
const CSV = 'name,nameAr,category,price,description\r\nMint lemonade,ليمون بالنعناع,Drinks,55,Fresh\r\nBasbousa,بسبوسة,Desserts,60,\r\n';

interface Seeded { tenant: Tenant; menu: MenuSeed; drinks: string; desserts: string; tea: string; coffee: string }
async function seed(request: APIRequestContext): Promise<Seeded> {
  const tenant = await apiCreateTenant(request, { planId: 'pro' });
  const menu = await apiSeedMenu(request, tenant);
  const api = apiAs(request, tenant.owner);
  const base = `/o/${tenant.orgId}/menu`;
  const drinks = (await api.post(`${base}/categories`, { name: 'Drinks', nameAr: 'المشروبات' })).id;
  const desserts = (await api.post(`${base}/categories`, { name: 'Desserts', nameAr: 'الحلويات' })).id;
  const tea = (await api.post(`${base}/products`, { categoryId: drinks, name: 'Mint tea', nameAr: 'شاي بالنعناع', priceMinor: 2000 })).id;
  const coffee = (await api.post(`${base}/products`, { categoryId: drinks, name: 'Turkish coffee', nameAr: 'قهوة تركي', priceMinor: 3500 })).id;
  return { tenant, menu, drinks, desserts, tea, coffee };
}
let s: Seeded;
test.beforeEach(async () => {
  const request = await playwrightRequest.newContext();
  s = await seed(request);
  await request.dispose();
});

const menuView = async (request: APIRequestContext) => apiAs(request, s.tenant.owner).get(`/o/${s.tenant.orgId}/menu`);
const open = async (page: Page) => {
  await page.goto(`/dashboard/${s.tenant.orgId}/menu`);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole('table', { name: 'Dishes' })).toBeVisible();
};
const railNames = (page: Page) => page.getByRole('navigation', { name: 'Categories' }).locator('.menu-rail-name');
const row = (page: Page, name: string) => page.getByRole('table', { name: 'Dishes' }).getByRole('row').filter({ hasText: name });

test('category rail: reorder by keyboard and by drag, persisted; choosing a category filters the dishes', async ({ browser, request }) => {
  const { context, page } = await newContext(browser, { user: s.tenant.owner });
  const errors = collectErrors(page);
  const failures = collectApiFailures(page);
  try {
    await open(page);
    await expect(railNames(page)).toHaveText(['All dishes', 'Mains', 'Drinks', 'Desserts']);
    // Keyboard: the handle takes the arrow keys; each move is announced and saved.
    const handle = page.getByRole('button', { name: 'Reorder Desserts' });
    await handle.focus();
    await page.keyboard.press('ArrowUp');
    await expect(page.getByRole('status').filter({ hasText: 'Desserts moved to position 2 of 3.' })).toBeAttached();
    await page.keyboard.press('Home');
    await expect(railNames(page)).toHaveText(['All dishes', 'Desserts', 'Mains', 'Drinks']);
    await expect(handle).toBeFocused();
    await expect.poll(async () => (await menuView(request)).categories.filter((c: any) => c.isActive).sort((a: any, b: any) => a.sortOrder - b.sortOrder).map((c: any) => c.name))
      .toEqual(['Desserts', 'Mains', 'Drinks']);
    // Drag: Drinks dropped on the top half of Desserts lands first.
    const items = page.getByRole('navigation', { name: 'Categories' }).locator('li.menu-rail-item');
    await items.filter({ hasText: 'Drinks' }).dragTo(items.filter({ hasText: 'Desserts' }), { targetPosition: { x: 60, y: 4 } });
    await expect(railNames(page)).toHaveText(['All dishes', 'Drinks', 'Desserts', 'Mains']);
    await page.reload();
    await expect(railNames(page)).toHaveText(['All dishes', 'Drinks', 'Desserts', 'Mains']);
    // Choosing a category filters the table (and the URL keeps it).
    await page.getByRole('navigation', { name: 'Categories' }).getByRole('button', { name: /^Drinks/ }).click();
    await expect(page).toHaveURL(new RegExp(`cat=${s.drinks}`));
    await expect(page.getByRole('table', { name: 'Dishes' }).locator('tbody tr')).toHaveCount(2);
    await expect(row(page, 'Smash burger')).toHaveCount(0);
    // The category's menu renames it (touch screens reorder from here too).
    await page.getByRole('button', { name: 'Category actions: Mains' }).click();
    await page.getByRole('menuitem', { name: 'Move up' }).click();
    await expect(railNames(page)).toHaveText(['All dishes', 'Drinks', 'Mains', 'Desserts']);
    expect(errors).toEqual([]);
    expect(failures).toEqual([]);
  } finally {
    await context.close();
  }
});

test('availability switch: sold out at the shell branch until the end of the day, then available again', async ({ browser, request }) => {
  const { context, page } = await newContext(browser, { user: s.tenant.owner });
  const failures = collectApiFailures(page);
  try {
    await open(page);
    const sw = page.getByRole('switch', { name: 'Fries available at Zamalek' });
    await expect(sw).toBeChecked();
    await sw.uncheck();
    await expect(sw).not.toBeChecked();
    await expect(row(page, 'Fries')).toContainText(/Sold out/);
    const fries = async () => (await menuView(request)).products.find((p: any) => p.id === s.menu.fries).branchSettings.find((b: any) => b.branchId === s.tenant.branchId);
    await expect.poll(async () => (await fries())?.soldOut).toBe(true);
    expect((await fries()).soldOutUntil).toBeTruthy(); // the end of the branch's day
    // The click on the switch did not open the dish.
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await page.reload();
    await expect(page.getByRole('switch', { name: 'Fries available at Zamalek' })).not.toBeChecked();
    // The filter "Sold out" shows it alone.
    await page.getByRole('button', { name: 'Sold out', exact: true }).click();
    await expect(page.getByRole('table', { name: 'Dishes' }).locator('tbody tr')).toHaveCount(1);
    await page.getByRole('switch', { name: 'Fries available at Zamalek' }).check();
    await expect.poll(async () => (await fries())?.soldOut ?? false).toBe(false);
    await expect(page.getByText('No dishes match')).toBeVisible();
    expect(failures).toEqual([]);
  } finally {
    await context.close();
  }
});

test('bulk edit: keyboard selection, price change with preview, move to a category, sold out, archive', async ({ browser, request }) => {
  const { context, page } = await newContext(browser, { user: s.tenant.owner });
  const errors = collectErrors(page);
  const failures = collectApiFailures(page);
  try {
    await open(page);
    // Keys: j moves to the first dish, Space selects, j, Space; Enter opens the focused dish, Escape closes it.
    await page.keyboard.press('j');
    await expect(page.getByRole('table', { name: 'Dishes' }).locator('tbody tr').first()).toBeFocused();
    await page.keyboard.press(' ');
    await page.keyboard.press('j');
    await page.keyboard.press(' ');
    const bar = page.getByRole('region', { name: '2 selected' });
    await expect(bar).toBeVisible();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('dialog')).toBeVisible();
    await expect(page.getByRole('dialog').getByRole('textbox').first()).toHaveValue('Fries');
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(bar).toBeVisible();

    // Price change: +12.5 %, previewed before saving (185.00 → 208.13, 45.00 → 50.63, rounded to the piastre).
    await bar.getByRole('button', { name: 'Change price' }).click();
    const sheet = page.getByRole('dialog', { name: 'Change the price of 2 dishes' });
    await sheet.getByLabel('Percentage (%)').fill('12.5');
    const preview = sheet.getByRole('table', { name: 'Preview' });
    await expect(preview.getByRole('row').filter({ hasText: 'Smash burger' })).toContainText('208.13');
    await expect(preview.getByRole('row').filter({ hasText: 'Fries' })).toContainText('50.63');
    // Rounding to the nearest 0.50 changes the preview, not yet the menu.
    await sheet.getByLabel('Round the new price').selectOption('50');
    await expect(preview.getByRole('row').filter({ hasText: 'Smash burger' })).toContainText('208');
    await expect(preview.getByRole('row').filter({ hasText: 'Fries' })).toContainText('50.50');
    expect((await menuView(request)).products.find((p: any) => p.id === s.menu.fries).priceMinor).toBe(4500);
    await sheet.getByRole('button', { name: 'Save 2 prices' }).click();
    await expect(page.getByText('New prices saved for 2 dishes.')).toBeVisible();
    const prices = async () => Object.fromEntries((await menuView(request)).products.map((p: any) => [p.name, p.priceMinor]));
    await expect.poll(prices).toMatchObject({ 'Smash burger': 20800, Fries: 5050, 'Mint tea': 2000 });

    // Move both to Drinks (selection by pointer this time).
    await row(page, 'Smash burger').getByRole('checkbox', { name: 'Select dish' }).check();
    await row(page, 'Fries').getByRole('checkbox', { name: 'Select dish' }).check();
    await page.getByRole('region', { name: '2 selected' }).getByRole('button', { name: 'Move to category' }).click();
    await page.getByRole('menuitem', { name: 'Drinks' }).click();
    await expect(page.getByText('2 dishes moved to Drinks.')).toBeVisible();
    await expect.poll(async () => (await menuView(request)).products.filter((p: any) => p.categoryId === s.drinks).length).toBe(4);
    await expect(page.getByRole('navigation', { name: 'Categories' }).getByRole('button', { name: /^Drinks/ })).toContainText('4');

    // Sold out today for three dishes at once.
    for (const n of ['Smash burger', 'Fries', 'Mint tea']) await row(page, n).getByRole('checkbox', { name: 'Select dish' }).check();
    await page.getByRole('region', { name: '3 selected' }).getByRole('button', { name: 'Sold out today' }).click();
    await expect(page.getByText('3 dishes marked sold out at Zamalek for today.')).toBeVisible();
    await expect(page.getByRole('switch', { name: 'Mint tea available at Zamalek' })).not.toBeChecked();

    // Archive one, after confirming.
    await row(page, 'Turkish coffee').getByRole('checkbox', { name: 'Select dish' }).check();
    await page.getByRole('region', { name: '1 selected' }).getByRole('button', { name: 'Archive' }).click();
    await page.getByRole('alertdialog', { name: 'Archive 1 dish?' }).getByRole('button', { name: 'Archive' }).click();
    await expect(page.getByText('1 dish archived.')).toBeVisible();
    await expect(row(page, 'Turkish coffee')).toHaveCount(0);
    expect((await menuView(request)).products.find((p: any) => p.id === s.coffee).isActive).toBe(false);
    expect(errors).toEqual([]);
    expect(failures).toEqual([]);
  } finally {
    await context.close();
  }
});

test('import action: CSV and Excel through the review step; the assisted import stays at /menu-import', async ({ browser, request }) => {
  const { context, page } = await newContext(browser, { user: s.tenant.owner });
  const errors = collectErrors(page);
  const failures = collectApiFailures(page);
  try {
    await open(page);
    await page.getByRole('button', { name: 'Import', exact: true }).click();
    const sheet = page.getByRole('dialog', { name: 'Import menu' });
    await sheet.locator('input[type="file"]').setInputFiles({ name: 'menu.csv', mimeType: 'text/csv', buffer: Buffer.from(CSV) });
    await expect(sheet.getByRole('region', { name: 'Rows to import' })).toContainText('Mint lemonade');
    await expect(sheet.getByText('New categories: Desserts')).toHaveCount(0); // Desserts exists already
    await sheet.getByRole('button', { name: 'Import reviewed rows' }).click();
    await expect(sheet.getByText('Imported: 2 new, 0 updated.')).toBeVisible();
    // The workbook (first sheet read in the browser's spreadsheet worker).
    await sheet.locator('input[type="file"]').setInputFiles(XLSX);
    await expect(sheet.getByRole('region', { name: 'Rows to import' })).toContainText('Lemon tart');
    await sheet.getByRole('button', { name: 'Import reviewed rows' }).click();
    await expect(sheet.getByText('Imported: 3 new, 0 updated.')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(row(page, 'Mint lemonade')).toBeVisible();
    await expect(row(page, 'Croissant')).toBeVisible();
    const names = (await menuView(request)).products.map((p: any) => p.name);
    expect(names).toEqual(expect.arrayContaining(['Mint lemonade', 'Basbousa', 'Flat white', 'Croissant', 'Lemon tart']));
    // i opens the import from the keyboard (focus is back on the Import button); its assisted tab links to
    // /menu-import, which links back.
    await page.keyboard.press('i');
    await expect(sheet).toBeVisible();
    await sheet.getByRole('radio', { name: 'Photo, PDF or text' }).click();
    await sheet.getByRole('link', { name: 'Open assisted import' }).click();
    await expect(page).toHaveURL(new RegExp(`/dashboard/${s.tenant.orgId}/menu-import$`));
    await page.getByRole('link', { name: 'Back to the menu' }).click();
    await expect(page).toHaveURL(new RegExp(`/dashboard/${s.tenant.orgId}/menu$`));
    // Old links to the former Import tab open the action.
    await page.goto(`/dashboard/${s.tenant.orgId}/menu?tab=import`);
    await expect(page.getByRole('dialog', { name: 'Import menu' })).toBeVisible();
    expect(errors).toEqual([]);
    expect(failures).toEqual([]);
  } finally {
    await context.close();
  }
});

test('Arabic at 390 px: the rail becomes category chips, RTL, no sideways scroll, Western digits', async ({ browser }) => {
  const { context, page } = await newContext(browser, { user: s.tenant.owner, locale: 'ar', mobile: true });
  try {
    await page.goto(`/dashboard/${s.tenant.orgId}/menu`);
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    await expect(page.getByRole('navigation', { name: 'الأقسام' }).locator('.menu-rail-name')).toHaveText(['كل الأطباق', 'الأطباق الرئيسية', 'المشروبات', 'الحلويات']);
    await expect(page.getByRole('switch', { name: 'بطاطس متاح في Zamalek' })).toBeVisible();
    await expectNoHorizontalOverflow(page);
    const text = await page.locator('main').innerText();
    expect(text).not.toMatch(/[٠-٩۰-۹]/);
    expect(text).toContain('185');
  } finally {
    await context.close();
  }
});
