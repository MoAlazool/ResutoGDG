import { request as playwrightRequest, type Page } from '@playwright/test';
import {
  apiAs, apiCreateTenant, apiSeedMenu, collectErrors, expect, expectNoHorizontalOverflow, exploreLink, newContext, test, workspaceNav, type Tenant,
} from './fixtures';

// Staff shell (21-SHELL), Chromium: keyboard-only navigation through the seven areas, the command palette (Ctrl K)
// to a page and to a record, `g` shortcuts and the cheat sheet, the account menu, the one branch context (persisted
// across reloads), the Free plan shell with Explore Resuto, and the phone tab bar and drawer at 390 px.

let tenant: Tenant;
let second: string;

test.beforeAll(async () => {
  const request = await playwrightRequest.newContext();
  tenant = await apiCreateTenant(request, { planId: 'pro' });
  await apiSeedMenu(request, tenant);
  second = (await apiAs(request, tenant.owner).post(`/o/${tenant.orgId}/branches`, { name: 'Maadi' })).id;
  await request.dispose();
});

test.describe.configure({ timeout: 90_000 });

const base = () => `/dashboard/${tenant.orgId}`;
/** The shell is interactive (its navigation rendered from the restaurant, not the placeholder). */
async function ready(page: Page) {
  await expect(workspaceNav(page).getByRole('button', { name: /^(Operations|التشغيل)$/ })).toBeVisible({ timeout: 20_000 });
}
/** Tabs until `predicate` holds for the focused element (keyboard only), or fails after `max` presses. */
async function tabTo(page: Page, predicate: (el: { tag: string; text: string; label: string | null; href: string | null }) => boolean, max = 60) {
  for (let i = 0; i < max; i++) {
    await page.keyboard.press('Tab');
    const el = await page.evaluate(() => {
      const a = document.activeElement as HTMLElement | null;
      return { tag: a?.tagName ?? '', text: (a?.textContent ?? '').trim(), label: a?.getAttribute('aria-label') ?? null, href: a?.getAttribute('href') ?? null };
    });
    if (predicate(el)) return;
  }
  throw new Error('focus target not reached by Tab');
}

test('keyboard only: skip link, open an area, open a page, with a visible focus ring', async ({ browser }) => {
  const { context, page } = await newContext(browser, { user: tenant.owner });
  const errors = collectErrors(page);
  try {
    await page.goto(base());
    await ready(page);
    // The skip link is the first stop and moves focus to the page.
    await page.keyboard.press('Tab');
    await expect(page.getByRole('link', { name: 'Skip to content' })).toBeFocused();
    // Operations opens with Enter and shows its pages; Orders opens with Enter.
    await tabTo(page, (el) => el.tag === 'BUTTON' && el.text.startsWith('Operations'));
    const area = workspaceNav(page).getByRole('button', { name: 'Operations' });
    await expect(area).toHaveAttribute('aria-expanded', 'false');
    await page.keyboard.press('Enter');
    await expect(area).toHaveAttribute('aria-expanded', 'true');
    await tabTo(page, (el) => el.tag === 'A' && (el.href ?? '').endsWith('/orders'));
    const outline = await page.evaluate(() => getComputedStyle(document.activeElement!).outlineStyle);
    expect(outline).not.toBe('none');
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(new RegExp(`${base()}/orders$`));
    await expect(workspaceNav(page).locator('a[aria-current="page"]')).toHaveAttribute('href', `${base()}/orders`);
    // The current area stays open on its pages.
    await expect(area).toHaveAttribute('aria-expanded', 'true');
    // Collapsing the sidebar to icons is remembered across a reload.
    await workspaceNav(page).getByRole('button', { name: 'Collapse sidebar' }).focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('.ws')).toHaveAttribute('data-collapsed', 'true');
    await page.reload();
    await expect(page.locator('.ws')).toHaveAttribute('data-collapsed', 'true', { timeout: 15_000 });
    await workspaceNav(page).getByRole('button', { name: 'Expand sidebar' }).focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('.ws')).not.toHaveAttribute('data-collapsed');
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
});

test('Ctrl K opens the command palette: a page by name (English and Arabic) and a dish from the record search', async ({ browser }) => {
  for (const locale of ['en', 'ar'] as const) {
    const { context, page } = await newContext(browser, { user: tenant.owner, locale });
    try {
      await page.goto(base());
      await ready(page);
      await page.keyboard.press('Control+k');
      const input = page.getByRole('combobox', { name: locale === 'ar' ? 'لوحة الأوامر' : 'Command palette' });
      await expect(input).toBeFocused();
      await input.fill(locale === 'ar' ? 'التحليلات' : 'analyt');
      await expect(page.getByRole('option').first()).toHaveAttribute('aria-selected', 'true');
      await page.keyboard.press('Enter');
      await expect(page).toHaveURL(new RegExp(`${base()}/analytics$`));
      await expect(page.getByRole('dialog')).toHaveCount(0);
    } finally {
      await context.close();
    }
  }
  const { context, page } = await newContext(browser, { user: tenant.owner });
  try {
    await page.goto(base());
    await ready(page);
    await page.getByRole('button', { name: /Search or jump to/ }).click();
    const input = page.getByRole('combobox', { name: 'Command palette' });
    await input.fill('smash');
    const dish = page.getByRole('option').filter({ hasText: 'Smash burger' });
    await expect(dish).toBeVisible();
    await expect(dish).toContainText('Menu item');
    await dish.click();
    await expect(page).toHaveURL(/\/menu\?product=/);
    // The dish opens in the editor.
    await expect(page.getByRole('dialog')).toBeVisible();
    await expect(page.getByRole('dialog').getByRole('textbox').first()).toHaveValue('Smash burger');
  } finally {
    await context.close();
  }
});

test('g then a letter navigates, ? shows the cheat sheet, and both stay quiet while typing', async ({ browser }) => {
  const { context, page } = await newContext(browser, { user: tenant.owner });
  try {
    await page.goto(base());
    await ready(page);
    await page.locator('body').click({ position: { x: 600, y: 400 } });
    await page.keyboard.press('g');
    await page.keyboard.press('o');
    await expect(page).toHaveURL(new RegExp(`${base()}/orders$`));
    await page.keyboard.press('g');
    await page.keyboard.press('c');
    await expect(page).toHaveURL(new RegExp(`${base()}/customers$`));
    // Typing "go" into the customers search box does not navigate.
    const search = page.getByRole('searchbox').or(page.getByLabel('Search')).first();
    await search.click();
    await page.keyboard.type('go');
    await page.waitForTimeout(300);
    await expect(page).toHaveURL(/\/customers(\?.*)?$/);
    await search.blur();
    await page.locator('h1').first().click();
    await page.keyboard.press('Shift+?');
    const sheet = page.getByRole('dialog', { name: 'Keyboard shortcuts' });
    await expect(sheet).toBeVisible();
    await expect(sheet).toContainText('Open the command palette');
    await expect(sheet).toContainText('Orders');
    await page.keyboard.press('Escape');
    await expect(sheet).toBeHidden();
  } finally {
    await context.close();
  }
});

test('the account menu holds sign-out as its own choice', async ({ browser }) => {
  const { context, page } = await newContext(browser, { user: tenant.owner });
  try {
    await page.goto(base());
    await ready(page);
    const profile = workspaceNav(page).getByRole('button', { name: /^Account menu:/ });
    await profile.click();
    // Opening the profile no longer signs out.
    await expect(page).toHaveURL(new RegExp(`${base()}$`));
    const menu = page.getByRole('menu', { name: 'Account menu' });
    await expect(menu.getByRole('menuitem')).toHaveText(['Account security', /العربية/, /Open guest experience/, 'Setup guide', 'Sign out']);
    await menu.getByRole('menuitem', { name: 'Account security' }).click();
    await expect(page).toHaveURL(/\/account\/security$/);
    await page.goto(base());
    await ready(page);
    await workspaceNav(page).getByRole('button', { name: /^Account menu:/ }).click();
    await page.getByRole('menu', { name: 'Account menu' }).getByRole('menuitem', { name: 'Sign out' }).click();
    await expect(page).toHaveURL(/\/login/);
  } finally {
    await context.close();
  }
});

test('one branch context: the shell switcher drives every screen and is remembered', async ({ browser }) => {
  const { context, page } = await newContext(browser, { user: tenant.owner });
  try {
    // The overview supports all branches, and opens on them.
    await page.goto(base());
    await ready(page);
    const chip = workspaceNav(page).getByRole('button', { name: /^Switch branch/ });
    await expect(chip).toContainText('All branches');
    // Orders works on one branch: the shell shows that branch there, with no branch select on the page.
    await page.goto(`${base()}/orders`);
    await expect(chip).toContainText('Zamalek');
    await expect(page.getByRole('main').getByRole('combobox', { name: 'Branch' })).toHaveCount(0);
    await chip.click();
    await expect(page.getByRole('menu', { name: 'Switch branch' }).getByRole('menuitem')).toHaveText([/Zamalek/, /Maadi/]);
    await page.getByRole('menuitem', { name: /Maadi/ }).click();
    await expect(chip).toContainText('Maadi');
    // After a reload the orders screen reads its board (the branch's kitchen feed) or its list for the remembered branch.
    await page.reload();
    const feed = await page.waitForRequest((r) => r.url().includes(`/o/${tenant.orgId}/kitchen/`)
      || (r.url().includes(`/o/${tenant.orgId}/orders?`) && r.url().includes('branchId=')));
    expect(feed.url()).toContain(second);
    expect(feed.url()).not.toContain(tenant.branchId);
    await expect(workspaceNav(page).getByRole('button', { name: /^Switch branch/ })).toContainText('Maadi');
    // The overview follows the shell's branch too (no own branch select).
    const overviewCall = page.waitForRequest((r) => r.url().includes('/analytics/overview') && r.url().includes(`branchId=${second}`));
    await page.goto(base());
    await overviewCall;
    await expect(page.getByRole('main').getByRole('combobox', { name: 'Branch' })).toHaveCount(0);
    // "All branches" is offered where the screen supports it, and is remembered.
    await workspaceNav(page).getByRole('button', { name: /^Switch branch/ }).click();
    await page.getByRole('menuitem', { name: /All branches/ }).click();
    await page.reload();
    await expect(workspaceNav(page).getByRole('button', { name: /^Switch branch/ })).toContainText('All branches', { timeout: 15_000 });
  } finally {
    await context.close();
  }
});

test('the Free plan shell: Home, Menu, Store design, QR codes, Settings and Explore Resuto', async ({ browser }) => {
  const request = await playwrightRequest.newContext();
  const free = await apiCreateTenant(request, { planId: 'free' });
  await request.dispose();
  const { context, page } = await newContext(browser, { user: free.owner });
  try {
    await page.goto(`/dashboard/${free.orgId}`);
    const nav = workspaceNav(page);
    await expect(nav.getByRole('button', { name: 'Menu & Store' })).toBeVisible({ timeout: 20_000 });
    await expect(nav.getByRole('button', { name: 'Home' })).toBeVisible();
    for (const hidden of ['Operations', 'Customers', 'Money', 'Insights', 'AI & Apps']) await expect(nav.getByRole('button', { name: hidden })).toHaveCount(0);
    await nav.getByRole('button', { name: 'Menu & Store' }).click();
    await expect(nav.getByRole('link', { name: 'Menu', exact: true })).toBeVisible();
    await expect(nav.getByRole('link', { name: 'Store design' })).toBeVisible();
    await expect(nav.getByRole('link', { name: 'QR codes' })).toBeVisible();
    await expect(nav.locator('a[href$="/orders"]')).toHaveCount(0);
    await exploreLink(page).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Explore Resuto' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Restaurant operations' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'See plans' }).first()).toHaveAttribute('href', `/dashboard/${free.orgId}/billing`);
  } finally {
    await context.close();
  }
});

test('phones (390 px): bottom tab bar and the drawer with the full navigation, in English and Arabic', async ({ browser }) => {
  for (const locale of ['en', 'ar'] as const) {
    const { context, page } = await newContext(browser, { user: tenant.owner, locale, mobile: true });
    try {
      await page.goto(base());
      const bar = page.getByRole('navigation', { name: locale === 'ar' ? 'الأقسام الرئيسية' : 'Main sections' });
      await expect(bar).toBeVisible({ timeout: 20_000 });
      const tabs = bar.locator(':scope > a, :scope > button');
      await expect(tabs).toHaveCount(5);
      await expect(tabs).toHaveText(locale === 'ar'
        ? ['الرئيسية', 'التشغيل', 'العملاء', 'الرؤى', 'المزيد']
        : ['Home', 'Operations', 'Customers', 'Insights', 'More']);
      await expect(tabs.first()).toHaveAttribute('aria-current', 'page');
      // The sidebar's list is not shown on phones (the tab bar and the drawer replace the chip strip).
      await expect(workspaceNav(page).getByRole('button', { name: locale === 'ar' ? 'التشغيل' : 'Operations' })).toBeHidden();
      await expectNoHorizontalOverflow(page);
      const box = await bar.boundingBox();
      expect(box && Math.round(box.y + box.height)).toBe(844);
      await tabs.nth(1).click();
      await expect(page).toHaveURL(new RegExp(`${base()}/orders$`));
      await expect(tabs.nth(1)).toHaveAttribute('aria-current', 'page');
      // More opens the drawer from the reading end with every area, Settings and the account actions.
      await tabs.nth(4).click();
      const drawer = page.getByRole('dialog', { name: locale === 'ar' ? 'القائمة' : 'Menu' });
      await expect(drawer).toBeVisible();
      await drawer.getByRole('button', { name: locale === 'ar' ? 'المال' : 'Money' }).click();
      await drawer.getByRole('link', { name: locale === 'ar' ? 'المدفوعات' : 'Payments' }).click();
      await expect(page).toHaveURL(new RegExp(`${base()}/payments$`));
      await expect(drawer).toBeHidden();
      await expectNoHorizontalOverflow(page);
    } finally {
      await context.close();
    }
  }
});
