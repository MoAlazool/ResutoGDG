import AxeBuilder from '@axe-core/playwright';
import { collectErrors, expect, expectNoHorizontalOverflow, matchScreenshot, setLocale, test, WEB_URL } from './fixtures';

// The pricing teaser asks the billing module for public prices; that endpoint is
// owned by another agent, so a 404 from it is expected in this worktree.
const IGNORE = [/Failed to load resource.*404/];

for (const locale of ['en', 'ar'] as const) {
  for (const [device, viewport] of [['desktop', { width: 1440, height: 900 }], ['mobile', { width: 390, height: 844 }]] as const) {
    test(`landing renders in ${locale} on ${device} without console errors`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await setLocale(page, locale);
      const errors = collectErrors(page, IGNORE);
      await page.goto('/');
      await expect(page.locator('html')).toHaveAttribute('dir', locale === 'ar' ? 'rtl' : 'ltr');
      await expect(page.locator('html')).toHaveAttribute('lang', locale);
      await expect(page.getByRole('heading', { level: 1 })).toContainText(locale === 'ar' ? 'الصالة.' : 'Run the room.');
      for (const id of ['studio', 'reserve', 'import', 'service', 'kitchen', 'payments', 'operations', 'connect', 'pricing']) {
        await expect(page.locator(`#${id}`)).toBeAttached();
      }
      // Demo and sign-up links point at the 2.0 routes.
      await expect(page.locator('.lp-hero-cta a').first()).toHaveAttribute('href', /^\/r\/[a-z0-9-]+$/);
      await expect(page.locator('.lp-cta a[href="/signup"]')).toBeVisible();
      await page.mouse.wheel(0, 20000);
      await page.waitForTimeout(400);
      await expectNoHorizontalOverflow(page);
      expect(errors).toEqual([]);
    });
  }
}

test('landing has SEO metadata, structured data, robots and sitemap', async ({ page, request }) => {
  await page.goto('/');
  await expect(page).toHaveTitle(/Resuto/);
  await expect(page.locator('meta[name="description"]')).toHaveAttribute('content', /restaurant operating system/i);
  await expect(page.locator('meta[property="og:image"]')).toHaveAttribute('content', /og-resuto\.png/);
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', new RegExp(`${WEB_URL.replace(/^https?:\/\//, '')}/?$`));
  const ld = JSON.parse(await page.locator('script[type="application/ld+json"]').first().textContent() ?? '{}');
  expect(ld['@type']).toBe('SoftwareApplication');
  const robots = await (await request.get('/robots.txt')).text();
  expect(robots).toContain('Disallow: /dashboard');
  expect(robots).toContain('Sitemap:');
  expect(await (await request.get('/sitemap.xml')).text()).toContain('<loc>');
});

test('landing interactions: hero table detail, studio panel, reservation ticket, phone ordering', async ({ page }) => {
  await page.goto('/');
  // Hero: clicking a table shows its detail.
  await page.locator('#hero-floor .svg-table').first().click();
  await expect(page.locator('#hero-table strong')).toHaveText('T1');
  // Studio: select a table and give it more seats (visitor takes over the tour).
  await page.locator('#studio').scrollIntoViewIfNeeded();
  await page.locator('#studio-canvas .svg-table').first().click();
  const seats = page.locator('#lp-seats');
  const before = Number(await seats.textContent());
  await page.locator('[data-lp="seats"][data-arg="1"]').click();
  await expect(seats).toHaveText(String(before + 1));
  await expect(page.locator('#studio .lp-guide')).toHaveAttribute('data-state', /manual|still/);
  // Reservation: choose a table, a slot and the party, then confirm.
  await page.locator('#rsv').scrollIntoViewIfNeeded();
  // With reduced motion the demo starts on its completed booking; reopen the first step.
  await page.locator('[data-rsv="open"][data-arg="0"]').click();
  await page.locator('[data-rsv="table"]').nth(1).click();
  await page.locator('[data-rsv="open"][data-arg="1"]').click();
  await page.locator('[data-rsv="slot"][data-arg="20:00"]').click();
  await page.locator('[data-rsv="open"][data-arg="2"]').click();
  await page.locator('[data-rsv="guests"][data-arg="4"]').click();
  await page.locator('[data-rsv="confirm"]').click();
  await expect(page.locator('#rsv')).toHaveClass(/is-done/);
  await expect(page.locator('[data-field="guests"] dd')).toHaveText(/4/);
  // Guest phone: add a dish, review, confirm.
  await page.locator('#service').scrollIntoViewIfNeeded();
  await page.locator('[data-lp="service"][data-arg="1"]').click();
  await page.locator('[data-lp="add"]').first().click();
  await page.locator('[data-lp="cart"]').click();
  await page.locator('[data-lp="confirm"]').click();
  await expect(page.locator('.lp-track li').first()).toBeVisible();
  // Kitchen: add a sample order and advance it.
  await page.locator('#kds').scrollIntoViewIfNeeded();
  const active = Number(await page.locator('#kds-active').textContent());
  await page.locator('[data-kds="new"]').click();
  await expect(page.locator('#kds-active')).toHaveText(String(active + 1));
});

test('landing visual snapshot (English, desktop)', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => document.fonts.ready);
  await matchScreenshot(page, 'landing-en-hero.png', { fullPage: false });
  await page.locator('#pricing').scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
  await matchScreenshot(page.locator('#connect'), 'landing-en-connect.png');
});

test('landing visual snapshot (Arabic, mobile)', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await setLocale(page, 'ar');
  await page.goto('/');
  await page.evaluate(() => document.fonts.ready);
  await matchScreenshot(page, 'landing-ar-mobile-hero.png', { fullPage: false });
});

test('landing has no serious accessibility violations', async ({ page }) => {
  await page.goto('/');
  await page.mouse.wheel(0, 20000);
  await page.waitForTimeout(500);
  const results = await new AxeBuilder({ page }).disableRules(['color-contrast']).analyze();
  const serious = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(serious.map((v) => `${v.id}: ${v.nodes.slice(0, 3).map((x) => x.target.join(' ')).join(' | ')}`)).toEqual([]);
});

test.describe('with motion allowed', () => {
  test.use({ contextOptions: { reducedMotion: 'no-preference' } });
  test('the guided demos play, pause and hand over to the visitor', async ({ page }) => {
    await page.goto('/');
    await page.locator('#studio').scrollIntoViewIfNeeded();
    const guide = page.locator('#studio .lp-guide');
    await expect(guide).toHaveAttribute('data-state', 'auto');
    await expect(guide.locator('.lp-guide-text')).toHaveText(/Draw the room|Place the tables|Change a table|Give it more seats|Save/, { timeout: 15_000 });
    await guide.locator('.lp-guide-toggle').click();
    await expect(guide).toHaveAttribute('data-state', 'paused');
    await guide.locator('.lp-guide-toggle').click();
    await expect(guide).toHaveAttribute('data-state', 'auto');
    // Hero ticker advances the service feed.
    await page.evaluate(() => window.scrollTo(0, 0));
    const first = await page.locator('#hero-feed li').first().textContent();
    await expect.poll(async () => page.locator('#hero-feed li').first().textContent(), { timeout: 10_000 }).not.toBe(first);
    // Kitchen: a visitor click takes over.
    await page.locator('#kds').scrollIntoViewIfNeeded();
    await page.locator('[data-kds="station"][data-arg="Grill"]').click();
    await expect(page.locator('#kds .lp-guide')).toHaveAttribute('data-state', 'manual');
  });
});
