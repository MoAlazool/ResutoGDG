import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { request as playwrightRequest, type Page } from '@playwright/test';
import {
  apiAs, apiCreateTenant, apiQrSheet, apiSaveFloor, apiSeedMenu, API_URL, collectApiFailures, collectErrors, expect, exploreLink, navLinkFor, newContext, ROOT, test, unique,
  workspaceNav, type Tenant,
} from './fixtures';

// Owner journey across every dashboard page, in English and Arabic, at 1280 px and
// 390 px, against the real API: each page must render without console errors,
// failed API calls or horizontal overflow. One WebP screenshot per page in each
// language is written to __screenshots__/owner/ (en @1280, ar @390).

const PAGES = [
  'overview', 'orders', 'menu', 'reservations', 'inventory', 'customers', 'analytics', 'inbox', 'marketing', 'payments', 'finance', 'compliance',
  'intelligence', 'mcp', 'website', 'billing', 'team', 'settings', 'audit', 'integrations', 'delivery',
] as const;
type PageKey = (typeof PAGES)[number];

/** Known page defects (see docs/qa/BROWSER_DEFECTS.md); those tests are marked expected-to-fail. */
const DEFECTS: Partial<Record<PageKey, string>> = {};

const SHOTS = path.join(ROOT, 'tests/e2e/__screenshots__/owner');
const sharp = (() => {
  try { return createRequire(createRequire(path.join(ROOT, 'apps/web/package.json')).resolve('next/package.json'))('sharp'); } catch { return null; }
})();

async function saveShot(page: Page, name: string) {
  const png = await page.screenshot({ animations: 'disabled', caret: 'hide' });
  mkdirSync(SHOTS, { recursive: true });
  if (sharp) {
    let quality = 70;
    let webp: Buffer = await sharp(png).webp({ quality }).toBuffer();
    while (webp.length > 300_000 && quality > 30) webp = await sharp(png).webp({ quality: (quality -= 15) }).toBuffer();
    writeFileSync(path.join(SHOTS, `${name}.webp`), webp);
  } else if (png.length <= 300_000) {
    writeFileSync(path.join(SHOTS, `${name}.png`), png);
  }
}

let tenant: Tenant;

test.beforeAll(async () => {
  // A realistic owner: menu, floor, a paid dine-in order and a pending WhatsApp sandbox channel.
  const request = await playwrightRequest.newContext();
  tenant = await apiCreateTenant(request, { planId: 'pro' });
  const menu = await apiSeedMenu(request, tenant);
  await apiSaveFloor(request, tenant);
  const qr = (await apiQrSheet(request, tenant))[0]!;
  const s = await (await request.post(`${API_URL}/v1/public/tables/${new URL(qr.url).pathname.split('/t/')[1]}/session`)).json();
  const lines = [{ productId: menu.fries, quantity: 2, modifiers: [] }];
  const quote = await (await request.post(`${API_URL}/v1/public/visits/current/quote`, { headers: { 'X-Visit-Token': s.token }, data: { lines } })).json();
  await request.post(`${API_URL}/v1/public/visits/current/orders`, { headers: { 'X-Visit-Token': s.token, 'Idempotency-Key': unique('o') }, data: { lines, expectedTotalMinor: quote.totalMinor } });
  await apiAs(request, tenant.owner).post(`/o/${tenant.orgId}/connect/channels`, { transport: 'sandbox', displayName: 'WhatsApp sandbox' });
  await request.dispose();
});

test.describe.configure({ timeout: 120_000 });

for (const key of PAGES) {
  const defect = DEFECTS[key];
  (defect ? test.fail : test)(`owner page "${key}" loads cleanly in en/ar at 1280 and 390 px`, async ({ browser }) => {
    const href = `/dashboard/${tenant.orgId}${key === 'overview' ? '' : `/${key}`}`;
    const problems: string[] = [];
    for (const locale of ['en', 'ar'] as const) {
      for (const width of [1280, 390] as const) {
        const { context, page } = await newContext(browser, { user: tenant.owner, locale });
        await page.setViewportSize({ width, height: width === 390 ? 844 : 860 });
        const errors = collectErrors(page);
        const failures = collectApiFailures(page);
        const tag = `${locale}@${width}`;
        try {
          await page.goto(href);
          await expect(workspaceNav(page)).toBeAttached({ timeout: 15_000 });
          await expect(page.locator('h1').first()).toBeVisible({ timeout: 15_000 });
          await page.waitForLoadState('networkidle', { timeout: 6_000 }).catch(() => undefined);
          await page.waitForTimeout(800);
          await expect(page.locator('html')).toHaveAttribute('dir', locale === 'ar' ? 'rtl' : 'ltr');
          const danger = await page.locator('.notice-danger:visible').allInnerTexts();
          if (danger.length) problems.push(`${tag}: error notice ${JSON.stringify(danger)}`);
          if (await page.getByText('This module is not in your plan').or(page.getByText('هذه الوحدة غير مضمنة في خطتك')).count()) problems.push(`${tag}: upgrade prompt on a pro plan`);
          const { scroll, client, culprit } = await page.evaluate(() => {
            const de = document.documentElement;
            const wide = [...document.querySelectorAll<HTMLElement>('body *')].find((el) => {
              const r = el.getBoundingClientRect();
              return r.width > 0 && (r.right > de.clientWidth + 1 || r.left < -1) && getComputedStyle(el).position !== 'fixed';
            });
            return { scroll: de.scrollWidth, client: de.clientWidth, culprit: wide ? `${wide.tagName.toLowerCase()}.${[...wide.classList].join('.')}` : null };
          });
          if (scroll > client + 1) problems.push(`${tag}: horizontal overflow ${scroll}px > ${client}px (${culprit})`);
          if ((locale === 'en' && width === 1280) || (locale === 'ar' && width === 390)) await saveShot(page, `${key}-${locale}-${width}`);
        } catch (e) {
          problems.push(`${tag}: ${(e as Error).message.split('\n')[0]}`);
        } finally {
          for (const err of errors) problems.push(`${tag}: console ${err.slice(0, 200)}`);
          for (const f of failures) problems.push(`${tag}: api ${f}`);
          await context.close();
        }
      }
    }
    expect(problems, problems.join('\n')).toEqual([]);
  });
}

const PAID = ['marketing', 'delivery', 'finance'] as const;
const UPGRADE = { en: { title: 'This module is not in your plan', cta: 'Upgrade' }, ar: { title: 'هذه الوحدة غير مضمنة في خطتك', cta: 'ترقية' } } as const;
/** The Explore Resuto previews of the PAID modules above (marketing, delivery, finance). */
const EXPLORE = { en: ['Resuto Marketing', 'ResutoDriver', 'Resuto Finance'], ar: ['ريسوتو للتسويق', 'ريسوتو درايفر', 'ريسوتو المالية'] } as const;

test('a free-plan owner sees the upgrade prompt on paid module pages (en/ar) and the API refuses with 402', async ({ browser }) => {
  const request = await playwrightRequest.newContext();
  const free = await apiCreateTenant(request, { planId: 'free' });
  const denied = await apiAs(request, free.owner).raw('get', `/o/${free.orgId}/marketing/campaigns`);
  expect(denied.status()).toBe(402);
  expect((await denied.json()).error.code).toMatch(/module|entitle|plan/);
  await request.dispose();
  for (const locale of ['en', 'ar'] as const) {
    const { context, page } = await newContext(browser, { user: free.owner, locale });
    const errors = collectErrors(page, [/status of 402/]);
    const failures = collectApiFailures(page, [{ url: /./, status: 402 }]);
    try {
      for (const key of PAID) {
        await page.goto(`/dashboard/${free.orgId}/${key}`);
        await expect(page.locator('.empty strong')).toHaveText(UPGRADE[locale].title);
        await expect(page.getByRole('link', { name: UPGRADE[locale].cta })).toHaveAttribute('href', `/dashboard/${free.orgId}/billing`);
        // Paid modules are not offered as (disabled) navigation entries; Explore Resuto lists them instead (21-SHELL).
        await expect(navLinkFor(page, `/${key}`)).toHaveCount(0);
        await expect(exploreLink(page)).toBeVisible();
      }
      await exploreLink(page).click();
      await expect(page).toHaveURL(/\/explore$/);
      for (const title of EXPLORE[locale]) await expect(page.getByRole('heading', { name: title })).toBeVisible();
      await page.goBack();
      await page.getByRole('link', { name: UPGRADE[locale].cta }).click();
      await expect(page).toHaveURL(/\/billing$/);
      expect(errors).toEqual([]);
      expect(failures).toEqual([]);
    } finally {
      await context.close();
    }
  }
});

// Regression for H-7 (fixed): the shell waits for the org's module list, so gated pages never mount and fire module API calls that 402.
test('a gated (unentitled) page makes no module API calls and logs no errors', async ({ browser }) => {
  const request = await playwrightRequest.newContext();
  const free = await apiCreateTenant(request, { planId: 'free' });
  await request.dispose();
  const { context, page } = await newContext(browser, { user: free.owner });
  const errors = collectErrors(page);
  const failures = collectApiFailures(page);
  try {
    for (const key of PAID) {
      await page.goto(`/dashboard/${free.orgId}/${key}`);
      await expect(page.locator('.empty strong')).toHaveText(UPGRADE.en.title);
      await page.waitForTimeout(500);
    }
    expect(failures).toEqual([]);
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
});
