import type { Page } from '@playwright/test';
import { apiCreateTenant, apiQrSheet, apiSaveFloor, apiSeedMenu, expect, matchScreenshot, publishSite, qrPath, seedMenu, setLocale, signIn, test } from './fixtures';

// CR-11: visual-fidelity gate for the restored surfaces. Captures are deterministic: a fixed clock, motion reduced,
// CSS animations and the caret off, web fonts awaited, and every per-run value (slugs, ids, order numbers, relative
// times) masked. Baselines live per rendering environment (playwright.config.ts snapshotPathTemplate):
//   __visual__/local/…   this development container's Chromium and fonts
//   __visual__/docker/…  the official Playwright image used by CI (.github/workflows/ci.yml, job "visual")
// so a font or rasteriser difference between machines is never mistaken for a regression. Which baseline was compared
// side by side with which legacy capture is recorded in docs/ui/visual-baselines.json.
//
// Run: E2E_VISUAL=1 pnpm e2e --project=visual   (add --update-snapshots after an approved change)

const FIXED = new Date('2026-10-20T18:30:00+02:00');   // a Tuesday evening in Cairo, inside opening hours

test.describe.configure({ mode: 'serial', timeout: 120_000 });

async function settle(page: Page) {
  await page.evaluate(() => document.fonts.ready);
  await page.waitForLoadState('networkidle').catch(() => undefined);
  await page.waitForFunction(() => !document.querySelector('.skeleton, [aria-busy="true"]'), null, { timeout: 20_000 }).catch(() => undefined);
  await page.waitForTimeout(300);
}
/** Elements whose text changes per run (generated slugs and ids, numbers, clocks). */
const dynamic = (page: Page) => [page.locator('time'), page.locator('[data-dynamic], [data-visual-mask]'), page.locator('bdi:has-text("#")'),
  page.getByText(/Measured from current restaurant data|refreshes every/)];

async function shot(page: Page, name: string, opts: { fullPage?: boolean } = {}) {
  await settle(page);
  await matchScreenshot(page, `${name}.png`, { fullPage: opts.fullPage ?? false, mask: dynamic(page), maxDiffPixelRatio: 0.01 });
}

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(FIXED);
});

test.describe('public surfaces', () => {
  for (const [name, path, locale, mobile] of [
    ['landing-en-desktop', '/', 'en', false], ['landing-ar-mobile', '/', 'ar', true],
    ['pricing-en-desktop', '/pricing', 'en', false], ['login-en-desktop', '/login', 'en', false],
  ] as const) {
    test(name, async ({ page }) => {
      if (mobile) await page.setViewportSize({ width: 390, height: 844 });
      await setLocale(page, locale);
      await page.goto(path);
      await shot(page, name);
    });
  }
});

test.describe('restaurant and guest surfaces', () => {
  test('restaurant site, web order, reserve and the QR table menu', async ({ page, request }) => {
    const tenant = await apiCreateTenant(request);
    const products = await seedMenu(tenant);
    await publishSite(request, tenant, { productIds: products });
    await apiSaveFloor(request, tenant);
    const qr = qrPath((await apiQrSheet(request, tenant)).find((x) => x.label === 'T1')!.url);

    await page.goto(`/r/${tenant.slug}`);
    await shot(page, 'restaurant-en-desktop');
    await page.setViewportSize({ width: 390, height: 844 });
    await setLocale(page, 'ar');
    await page.goto(`/r/${tenant.slug}`);
    await shot(page, 'restaurant-ar-mobile');
    await setLocale(page, 'en');
    await page.goto(`/order/${tenant.slug}`);
    await shot(page, 'order-en-mobile');
    await page.goto(`/reserve/${tenant.slug}`);
    await shot(page, 'reserve-en-mobile');
    await page.goto(qr);
    await shot(page, 'table-menu-en-mobile');
  });
});

test.describe('staff surfaces', () => {
  test('overview, floor, kitchen display, orders and settings', async ({ page, request }) => {
    const tenant = await apiCreateTenant(request);
    await apiSeedMenu(request, tenant);
    await apiSaveFloor(request, tenant);
    await signIn(page, tenant.owner);
    const d = `/dashboard/${tenant.orgId}`;
    for (const [name, path] of [
      ['staff-overview-en', d], ['staff-floor-en', `${d}/floor?tab=live`], ['staff-orders-en', `${d}/orders`],
      ['staff-settings-en', `${d}/settings`], ['kds-en', `/kitchen/${tenant.orgId}`],
    ] as const) {
      await page.goto(path);
      await shot(page, name);
    }
  });
});
