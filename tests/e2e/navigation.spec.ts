import { request as playwrightRequest, type Page } from '@playwright/test';
import { apiCreateTenant, apiSeedMenu, expect, expectNoHorizontalOverflow, newContext, test, workspaceNav, type Tenant } from './fixtures';

// Navigation correctness (22-TYPE), Chromium, English and Arabic: every sidebar item is clicked; the URL is the item's
// route (with its query), exactly one item is marked as the current page (the clicked one, in its own area), the page
// shows its level-1 heading, and the sidebar never scrolls sideways. Also: the QR codes item stays in Menu & Store, the
// Domains tab item and the Website studio item highlight separately, /studio opens the website studio, and the
// navigation stays reachable at 1366×768 and 1024×768.

let tenant: Tenant;

test.beforeAll(async () => {
  const request = await playwrightRequest.newContext();
  tenant = await apiCreateTenant(request, { planId: 'pro' });
  await apiSeedMenu(request, tenant);
  await request.dispose();
});

test.describe.configure({ timeout: 240_000 });

const base = () => `/dashboard/${tenant.orgId}`;
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

async function ready(page: Page) {
  await expect(workspaceNav(page).getByRole('button', { name: /^(Operations|التشغيل)$/ })).toBeVisible({ timeout: 30_000 });
}

/** Every navigation link of the sidebar (primary areas and the Settings cluster), opening each area to read it. */
async function allItems(page: Page): Promise<Array<{ href: string; name: string }>> {
  const nav = workspaceNav(page);
  const closed = nav.locator('.ws-area-btn[aria-expanded="false"]');
  while (await closed.count()) await closed.first().click();
  return nav.locator('.ws-sub a.ws-nav-link').evaluateAll((links) => links.map((a) => ({ href: a.getAttribute('href')!, name: (a.textContent ?? '').trim() })));
}

/** Clicks the item with `href`, opening its area first when it is closed. */
async function clickItem(page: Page, href: string) {
  const nav = workspaceNav(page);
  const link = nav.locator(`.ws-sub a.ws-nav-link[href="${href}"]`);
  if (!(await link.isVisible())) {
    const area = nav.locator('.ws-area', { has: page.locator(`a[href="${href}"]`) }).locator('.ws-area-btn');
    await area.click();
  }
  await link.click();
}

/** The sidebar's current page: exactly one link, the expected one. */
async function expectCurrent(page: Page, href: string) {
  const nav = workspaceNav(page);
  await expect(nav.locator('a[aria-current="page"]')).toHaveCount(1);
  await expect(nav.locator('a[aria-current="page"]')).toHaveAttribute('href', href);
  // Its area is the one marked current (and open).
  const area = nav.locator('.ws-area', { has: page.locator(`a[href="${href}"][aria-current="page"]`) });
  await expect(area).toHaveAttribute('data-current');
  await expect(nav.locator('.ws-area[data-current]')).toHaveCount(1);
}

async function expectNoSidebarSideScroll(page: Page) {
  const s = await page.locator('.ws-sidebar').evaluate((el) => {
    const nav = el.querySelector(':scope > .ws-nav') as HTMLElement | null;
    return { sw: el.scrollWidth, cw: el.clientWidth, nsw: nav?.scrollWidth ?? 0, ncw: nav?.clientWidth ?? 0 };
  });
  expect(s.sw, 'the sidebar does not scroll sideways').toBeLessThanOrEqual(s.cw + 1);
  expect(s.nsw, 'the navigation list does not scroll sideways').toBeLessThanOrEqual(s.ncw + 1);
}

for (const locale of ['en', 'ar'] as const) {
  test(`every sidebar item opens its page, is the one current item and shows the page heading (${locale})`, async ({ browser }) => {
    const { context, page } = await newContext(browser, { user: tenant.owner, locale });
    try {
      await page.goto(base());
      await ready(page);
      const items = await allItems(page);
      // The owner of a Pro restaurant with table service sees every area's pages (lib/nav.ts).
      for (const path of ['', '/orders', '/kitchen', '/floor', '/menu', '/website', '/qr', '/website?tab=domains', '/customers', '/payments', '/analytics', '/integrations', '/settings', '/team']) {
        expect(items.map((i) => i.href), path).toContain(base() + path);
      }
      expect(items.length).toBeGreaterThan(25);
      for (const { href, name } of items) {
        await test.step(`${name} → ${href}`, async () => {
          if (!(await workspaceNav(page).isVisible())) { await page.goto(base()); await ready(page); }
          await clickItem(page, href);
          if (href === `${base()}/kitchen`) {
            // The Kitchen item opens the full-screen kitchen display (one implementation, 21-OPS).
            await expect(page).toHaveURL(new RegExp(`/kitchen/${tenant.orgId}$`), { timeout: 20_000 });
            await page.goto(base());
            await ready(page);
            return;
          }
          const [path, query] = href.split('?');
          await expect(page).toHaveURL(new RegExp(`${escape(path!)}${query ? `\\?${escape(query)}` : '(\\?.*)?$'}`), { timeout: 20_000 });
          await expectCurrent(page, href);
          // The page heading: the screen's own h1 (the website studio's is in its toolbar header).
          await expect(page.locator('#workspace-main h1').first(), `${href} has a page heading`).toBeVisible({ timeout: 20_000 });
          await expectNoSidebarSideScroll(page);
        });
      }
    } finally {
      await context.close();
    }
  });
}

test('the QR codes item has its own page in Menu & Store; the website studio and its Domains tab highlight separately', async ({ browser }) => {
  const { context, page } = await newContext(browser, { user: tenant.owner });
  try {
    await page.goto(`${base()}/qr`);
    await ready(page);
    await expectCurrent(page, `${base()}/qr`);
    await expect(page.getByRole('heading', { level: 1, name: 'QR codes' })).toBeVisible();
    await expect(workspaceNav(page).locator('.ws-area[data-current] > .ws-area-btn')).toHaveText(/Menu & Store/);
    // The floor's own QR tab stays with the floor (Operations), as before.
    await page.goto(`${base()}/floor?tab=qr`);
    await ready(page);
    await expectCurrent(page, `${base()}/floor`);
    await page.goto(`${base()}/website?tab=domains`);
    await ready(page);
    await expectCurrent(page, `${base()}/website?tab=domains`);
    await page.goto(`${base()}/website`);
    await ready(page);
    await expectCurrent(page, `${base()}/website`);
    await expect(workspaceNav(page).locator('a[aria-current="page"]')).toHaveText('Website studio');
    // /studio is the website studio's other address.
    await page.goto(`${base()}/studio`);
    await expect(page).toHaveURL(new RegExp(`${base()}/website$`));
    await ready(page);
    await expectCurrent(page, `${base()}/website`);
  } finally {
    await context.close();
  }
});

for (const viewport of [{ width: 1366, height: 768 }, { width: 1280, height: 800 }, { width: 1024, height: 768 }]) {
  test(`at ${viewport.width}×${viewport.height} the brand, restaurant, every area, Settings and the account stay reachable (en, ar)`, async ({ browser }) => {
    for (const locale of ['en', 'ar'] as const) {
      const { context: ctx, page } = await newContext(browser, { user: tenant.owner, locale });
      try {
        await page.setViewportSize(viewport);
        await page.goto(`${base()}/finance`);
        await ready(page);
        const nav = workspaceNav(page);
        await expect(nav.locator('.ws-brand')).toBeInViewport();
        await expect(nav.locator('.ws-chip').first()).toBeInViewport();
        // The footer (Settings, account) stays on screen; only the list scrolls.
        await expect(nav.locator('.ws-sidebar-bottom .ws-area-btn')).toBeInViewport();
        await expect(nav.locator('.ws-profile')).toBeInViewport();
        // Open every area: the last one is reached by scrolling the list, never the page.
        const closed = page.locator('.ws-sidebar > .ws-nav .ws-area-btn[aria-expanded="false"]');
        while (await closed.count()) await closed.first().click();
        const last = page.locator('.ws-sidebar > .ws-nav .ws-sub a').last();
        await last.scrollIntoViewIfNeeded();
        await expect(last).toBeInViewport();
        await expect(nav.locator('.ws-profile')).toBeInViewport();
        await expectNoSidebarSideScroll(page);
        await expectNoHorizontalOverflow(page);
        // Rows are at least 36 px tall and labels are not smaller than the nav tokens.
        const rows = await nav.locator('.ws-nav-link, .ws-area-btn').evaluateAll((els) => els.filter((e) => (e as HTMLElement).offsetParent)
          .map((e) => ({ h: e.getBoundingClientRect().height, size: parseFloat(getComputedStyle(e).fontSize) })));
        expect(Math.min(...rows.map((r) => r.h))).toBeGreaterThanOrEqual(36);
        expect(Math.min(...rows.map((r) => r.size))).toBeGreaterThanOrEqual(locale === 'ar' ? 15 : 13.5);
      } finally {
        await ctx.close();
      }
    }
  });
}
