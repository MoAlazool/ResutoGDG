import AxeBuilder from '@axe-core/playwright';
import { request as pwRequest } from '@playwright/test';
import { apiCreateTenant, collectErrors, expect, expectNoHorizontalOverflow, matchScreenshot, publishSite, seedMenu, setLocale, signIn, sql, test, WEB_URL } from './fixtures';

const SHELL_404 = [/Failed to load resource.*404/];

test('edit in ResutoStudio → publish → /r/<slug> renders the new revision', async ({ page, request }) => {
  const tenant = await apiCreateTenant(request);
  const products = await seedMenu(tenant);
  await publishSite(request, tenant, { productIds: products });

  await signIn(page, tenant.owner);
  const errors = collectErrors(page, SHELL_404);
  await page.goto(`/dashboard/${tenant.orgId}/website`);
  await expect(page.getByRole('heading', { level: 1, name: 'Website' })).toBeVisible();
  await expect(page.getByText('Live · revision 1')).toBeVisible();
  // The canvas (a sandboxed frame) shows the draft.
  const canvas = page.frameLocator('iframe.ws-frame');
  await expect(canvas.locator('.restaurant-editorial h1')).toHaveText('Good food. Long conversations.');

  // Select the hero (navigator) and edit its headline in both languages in the inspector.
  await page.locator('.ws-sections li').filter({ hasText: 'Good food. Long conversations.' }).locator('.ws-list-pick').click();
  const inspector = page.locator('.ws-inspector');
  const headline = inspector.locator('fieldset.ws-loc').filter({ hasText: 'Headline' });
  await headline.getByLabel('English').fill('Seasonal plates in Zamalek.');
  await headline.getByLabel('Arabic').fill('أطباق موسمية في الزمالك.');
  await expect(page.getByRole('status').filter({ hasText: 'Unsaved changes' })).toBeVisible();
  await inspector.getByRole('button', { name: 'Apply' }).click();
  await expect(canvas.locator('.restaurant-editorial h1')).toHaveText('Seasonal plates in Zamalek.');
  await expect(page.getByText('Unpublished changes')).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: 'Saved' })).toBeVisible();

  // Draft changes stay private until publishing.
  await expect((await request.get(`/r/${tenant.slug}`)).ok()).toBeTruthy();
  await page.getByRole('button', { name: 'Publish' }).first().click();
  await page.locator('dialog.rui-confirm[open]').getByRole('button', { name: 'Publish' }).click();
  await expect(page.getByText('Live · revision 2')).toBeVisible();
  expect(errors).toEqual([]);

  // Public website (English).
  const site = await page.context().newPage();
  const siteErrors = collectErrors(site);
  await site.goto(`/r/${tenant.slug}`);
  await expect(site.getByRole('heading', { level: 1 })).toHaveText('Seasonal plates in Zamalek.');
  await expect(site).toHaveTitle('The Olive Room · Zamalek');
  await expect(site.locator('meta[name="description"]')).toHaveAttribute('content', 'Seasonal plates and warm hospitality in Zamalek.');
  await expect(site.locator('link[rel="canonical"]')).toHaveAttribute('href', new RegExp(`/r/${tenant.slug}$`));
  const ld = JSON.parse(await site.locator('script[type="application/ld+json"]').textContent() ?? '{}');
  expect(ld).toMatchObject({ '@type': 'Restaurant', name: 'The Olive Room', telephone: '+201001234567' });
  expect(ld.openingHoursSpecification).toHaveLength(7);
  await expect(site.locator('.dish-card h3')).toHaveText(['Burrata & heirloom tomato', 'Roasted pumpkin soup', 'Grilled chicken supreme']);
  await expect(site.locator('.dish-card').first()).toHaveAttribute('href', `/order/${tenant.slug}`);
  await expect(site.getByRole('link', { name: /Reserve a table/ })).toHaveAttribute('href', `/reserve/${tenant.slug}`);
  // No product cost reaches the public site: no cost field in the HTML or the RSC payload, no "cost" in the visible text.
  // (The page ships the guest dictionary, whose key names such as core.guest.loyalty.cost are not data.)
  expect(await site.content()).not.toMatch(/cost_?minor|"cost"\s*:/i);
  expect(await site.locator('body').innerText()).not.toMatch(/\bcost/i);
  expect(siteErrors).toEqual([]);
  await site.close();
});

test('restaurant website renders in Arabic (RTL) and at 390 px', async ({ page, request }) => {
  const tenant = await apiCreateTenant(request);
  await publishSite(request, tenant, { productIds: await seedMenu(tenant) });
  await setLocale(page, 'ar');
  await page.setViewportSize({ width: 390, height: 844 });
  const errors = collectErrors(page);
  await page.goto(`/r/${tenant.slug}`);
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('طعام طيب. وأحاديث طويلة.');
  await expect(page).toHaveTitle('غرفة الزيتون · الزمالك');
  await expect(page.locator('.dish-card h3').first()).toHaveText('بوراتا مع الطماطم');
  await expect(page.locator('.dish-card strong').first()).toContainText('145');
  await page.mouse.wheel(0, 6000);
  await expectNoHorizontalOverflow(page);
  expect(errors).toEqual([]);
});

test('restaurant website visual snapshot', async ({ page, request }) => {
  const tenant = await apiCreateTenant(request);
  await publishSite(request, tenant, { productIds: await seedMenu(tenant) });
  await page.goto(`/r/${tenant.slug}`);
  await page.evaluate(() => document.fonts.ready);
  await page.waitForLoadState('networkidle');
  // Dynamic values (footer year) are masked; everything else must match the committed baseline.
  await matchScreenshot(page, 'restaurant-olive-en.png', { fullPage: true, mask: [page.locator('footer span').first()] });
});

test('custom domains resolve to the same tenant; unknown hosts get a 404 page', async ({ request }) => {
  const tenant = await apiCreateTenant(request);
  await publishSite(request, tenant);
  const host = `${tenant.slug}.example-restaurant.com`;
  // Ownership verification needs a public DNS record; the verified state is arranged in the database
  // (the TXT verification flow itself is covered by apps/api/test/studio.test.ts with a stubbed resolver).
  const [site] = await sql('select id from websites where org_id = $1', [tenant.orgId]);
  await sql(`insert into custom_domains(org_id, website_id, hostname, verification_token, status, verified_at) values ($1, $2, $3, 'resuto-e2e', 'verified', now())`, [tenant.orgId, site.id, host]);

  const ctx = await pwRequest.newContext({ baseURL: WEB_URL });
  const res = await ctx.get('/', { headers: { host } });
  expect(res.status()).toBe(200);
  const html = await res.text();
  expect(html).toContain('Good food. Long conversations.');
  expect(html).toContain('href="/order"');
  const unknown = await ctx.get('/', { headers: { host: 'nobody.example-unknown.com' } });
  expect(unknown.status()).toBe(404);
  expect(await unknown.text()).toContain('This website is not available');
  // App hosts are never rewritten.
  expect((await ctx.get('/', { headers: { host: 'localhost:3109' } })).status()).toBe(200);
  await ctx.dispose();
});

test('Studio editor manages media, domains and labelled AI creative', async ({ page, request }) => {
  const tenant = await apiCreateTenant(request);
  await seedMenu(tenant);
  await signIn(page, tenant.owner);
  await page.goto(`/dashboard/${tenant.orgId}/website`);
  // Domains live in the site inspector (the navigation's Domains item opens it with ?tab=domains).
  await page.locator('.ws-inspector').getByRole('radio', { name: 'Site' }).click();
  await page.locator('.ws-inspector').getByRole('tab', { name: 'Domains' }).click();
  await page.getByLabel('Domain').fill(`www.${tenant.slug}.example.com`);
  await page.getByRole('button', { name: 'Add domain' }).click();
  await expect(page.getByText('Waiting for DNS record')).toBeVisible();
  await expect(page.locator('.ws-dns code').first()).toHaveText(`_resuto-verify.www.${tenant.slug}.example.com`);
  await expect(page.getByText('Manual setup (no hosting API configured)')).toBeVisible();

  await page.locator('.ws-inspector').getByRole('radio', { name: 'AI' }).click();
  await page.getByRole('tab', { name: 'Copy drafts' }).click();
  await page.getByLabel('Brief').fill('Weekend brunch is back from 10 am');
  await page.getByRole('button', { name: 'Generate drafts' }).click();
  await expect(page.getByText('Template · no AI').first()).toBeVisible();
  await page.getByRole('button', { name: 'Approve' }).first().click();
  await expect(page.getByRole('main').getByRole('article').first().getByText('Approved', { exact: true })).toBeVisible();
});

test('Studio pages have no serious accessibility violations', async ({ page, request }) => {
  const tenant = await apiCreateTenant(request);
  await publishSite(request, tenant, { productIds: await seedMenu(tenant) });
  await page.goto(`/r/${tenant.slug}`);
  const site = await new AxeBuilder({ page }).disableRules(['color-contrast']).analyze();
  expect(site.violations.filter((v) => ['serious', 'critical'].includes(v.impact ?? '')).map((v) => v.id)).toEqual([]);
  await signIn(page, tenant.owner);
  await page.goto(`/dashboard/${tenant.orgId}/website`);
  await expect(page.locator('.ws-sections li').first()).toBeVisible();
  await expect(page.frameLocator('iframe.ws-frame').locator('.site-root')).toBeVisible();
  // The canvas frame renders the public site, checked above; the editor around it is checked here.
  const editor = await new AxeBuilder({ page }).exclude('.ws-stage').disableRules(['color-contrast']).analyze();
  expect(editor.violations.filter((v) => ['serious', 'critical'].includes(v.impact ?? '')).map((v) => `${v.id}: ${v.nodes[0]?.target.join(' ')}`)).toEqual([]);
});
