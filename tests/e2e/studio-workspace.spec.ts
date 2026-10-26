import { apiCreateTenant, collectErrors, expect, publishSite, seedMenu, signIn, sql, test, WEB_URL } from './fixtures';

// 21-STUDIO: the canvas workspace. (1) The canvas (22-STUDIO) is a script-free, same-origin frame the editor renders into:
// nothing in it runs, it never navigates, and every request it makes is same-origin (so it works behind cookie-based
// deployment protection).
// (2) AI-assisted editing through change sets with the rules planner (no model): proposal → before/after diff on the
// canvas → approve → applied to the draft (prices change) → the owner publishes → the public site shows it.

const SHELL_404 = [/Failed to load resource.*404/];

test('the canvas frame runs no script, makes only same-origin requests and never navigates; a click selects', async ({ page, request }) => {
  const tenant = await apiCreateTenant(request);
  await publishSite(request, tenant, { productIds: await seedMenu(tenant) });
  await signIn(page, tenant.owner);
  const errors = collectErrors(page, SHELL_404);
  // 22-STUDIO root cause: the old canvas was a separate page in an opaque-origin frame, so its scripts and stylesheets
  // were cross-site requests that a cookie-gated deployment (Vercel Authentication, SameSite=Lax) answered 401.
  const frameRequests: Array<{ url: string; type: string; site: string | null }> = [];
  page.on('request', async (r) => {
    if (r.frame() === page.mainFrame() || !r.url().startsWith(WEB_URL)) return;
    frameRequests.push({ url: r.url(), type: r.resourceType(), site: await r.headerValue('sec-fetch-site') });
  });
  await page.goto(`/dashboard/${tenant.orgId}/website`);
  const iframe = page.locator('iframe.ws-frame');
  await expect(iframe).toHaveAttribute('sandbox', 'allow-same-origin');
  await expect(iframe).not.toHaveAttribute('src', /./);
  const canvas = page.frameLocator('iframe.ws-frame');
  await expect(canvas.locator('.restaurant-editorial h1')).toHaveText('Good food. Long conversations.');
  // The rendered site is styled (the editor's stylesheets were copied in): the hero heading uses the site typography.
  expect(await canvas.locator('.restaurant-editorial h1').evaluate((h) => getComputedStyle(h).fontSize)).not.toBe('32px');
  const frame = page.frames().find((f) => f !== page.mainFrame() && f.url() === 'about:srcdoc')!;
  expect(frame).toBeTruthy();
  expect(frameRequests.filter((r) => r.type === 'script')).toEqual([]);
  expect(frameRequests.filter((r) => r.site !== 'same-origin')).toEqual([]);

  // Nothing in the frame can run: injected markup with script or event handlers stays inert.
  await page.evaluate(() => {
    const d = document.querySelector<HTMLIFrameElement>('iframe.ws-frame')!.contentDocument!;
    d.body.insertAdjacentHTML('beforeend', '<img src="data:," onerror="parent.__canvasPwned = 1"><svg onload="parent.__canvasPwned = 2"></svg>');
    const s = d.createElement('script');
    s.textContent = 'parent.__canvasPwned = 3';
    d.body.appendChild(s);
  });
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => (window as unknown as { __canvasPwned?: number }).__canvasPwned)).toBeUndefined();

  // Links and the language switch in the canvas do not navigate it, the editor, or change the editor's language.
  const editorUrl = page.url();
  await canvas.locator('a[href^="/order/"]').first().click();
  await canvas.locator('.lang-toggle').first().click();
  await page.waitForTimeout(300);
  expect(frame.url()).toBe('about:srcdoc');
  expect(page.url()).toBe(editorUrl);
  expect((await page.context().cookies()).find((c) => c.name === 'resuto_locale')?.value).toBe('en');

  // A click on a section selects it in the inspector.
  const inspector = page.locator('.ws-inspector');
  await inspector.getByRole('radio', { name: 'Section' }).click();
  await canvas.locator('.site-block[data-sid]').filter({ has: canvas.locator('h2') }).first().click();
  await expect(inspector.getByText('Select a section')).toBeHidden();
  await expect(canvas.locator('.site-block[data-selected]')).toHaveCount(1);
  expect(errors).toEqual([]);
});

test('AI editing: proposal → canvas before/after diff → approve → applied, not published → publish', async ({ page, request }) => {
  const tenant = await apiCreateTenant(request);
  const products = await seedMenu(tenant);
  await publishSite(request, tenant, { productIds: products });
  await signIn(page, tenant.owner);
  const errors = collectErrors(page, SHELL_404);
  await page.goto(`/dashboard/${tenant.orgId}/website?tab=creative`);
  const inspector = page.locator('.ws-inspector');
  await expect(inspector.getByRole('radio', { name: 'AI' })).toHaveAttribute('aria-checked', 'true');
  await inspector.getByLabel('What should change?').fill('Add an Eid offers section with these 3 products at 15% off');
  for (const name of ['Burrata & heirloom tomato', 'Roasted pumpkin soup', 'Grilled chicken supreme']) await inspector.getByLabel(name).check();
  await inspector.getByRole('button', { name: 'Propose change' }).click();

  // The change set: one website section and three dish discounts, waiting for approval; labelled as rules, not AI.
  await expect(inspector.getByRole('heading', { name: 'Eid offers' })).toBeVisible();
  await expect(inspector.getByText('Resuto rules · not AI')).toBeVisible();
  await expect(inspector.getByRole('region', { name: 'Add a website section' })).toBeVisible();
  await expect(inspector.getByRole('region', { name: 'Discount a menu item' })).toHaveCount(3);
  const [cs] = await sql(`select id, status, origin from change_sets where org_id = $1 order by created_at desc limit 1`, [tenant.orgId]);
  expect(cs).toMatchObject({ status: 'pending_approval', origin: 'studio_ai' });
  expect(await sql(`select price_minor from products where id = $1`, [products[0]])).toEqual([{ price_minor: '14500' }]);

  // After: the proposed section is marked on the canvas with the discounted prices; Before: the draft as it is.
  const canvas = page.frameLocator('iframe.ws-frame');
  const proposed = canvas.locator('.site-block[data-diff="added"]');
  await expect(proposed).toBeVisible();
  await expect(proposed.locator('h2')).toHaveText('Eid offers');
  await expect(proposed.locator('.site-badge-float').first()).toHaveText('15% off');
  await expect(proposed.locator('.site-offer-price strong').first()).toContainText('123.25');
  await expect(proposed.locator('.site-offer-price s').first()).toContainText('145.00');
  await page.getByRole('radio', { name: 'Before' }).click();
  await expect(canvas.locator('.site-block[data-diff]')).toHaveCount(0);
  await expect(canvas.getByRole('heading', { name: 'Eid offers' })).toHaveCount(0);
  await page.getByRole('radio', { name: 'After' }).click();
  await expect(proposed).toBeVisible();

  // Approve (the owner has no authenticator, so no step-up): applied to the draft, prices changed, nothing published.
  await inspector.getByRole('button', { name: 'Approve and apply' }).click();
  await expect(inspector.getByText('Applied to the draft. Check the canvas, then publish.')).toBeVisible();
  expect(await sql(`select price_minor, compare_at_price_minor from products where id = $1`, [products[0]])).toEqual([{ price_minor: '12325', compare_at_price_minor: '14500' }]);
  expect((await sql(`select status from change_sets where id = $1`, [cs.id]))[0].status).toBe('applied');
  await expect(page.getByText('Live · revision 1')).toBeVisible();
  await expect(canvas.locator('.site-offers h2')).toHaveText('Eid offers');
  await expect(canvas.locator('.site-block[data-diff]')).toHaveCount(0);
  const site = await page.context().newPage();
  await site.goto(`/r/${tenant.slug}`);
  await expect(site.getByRole('heading', { name: 'Eid offers' })).toHaveCount(0);

  // The owner publishes.
  await page.getByRole('toolbar').getByRole('button', { name: 'Publish' }).click();
  await page.locator('dialog.rui-confirm[open]').getByRole('button', { name: 'Publish' }).click();
  await expect(page.getByText('Live · revision 2')).toBeVisible();
  await site.reload();
  await expect(site.getByRole('heading', { name: 'Eid offers' })).toBeVisible();
  await expect(site.locator('.site-offers .site-badge-float').first()).toHaveText('15% off');
  // Server-rendered JSON-LD: the discounted dish carries its list price.
  const ld = JSON.parse(await site.locator('script[type="application/ld+json"]').first().textContent() ?? '{}');
  expect(ld['@type']).toBe('Restaurant');
  const items = ld.hasMenu.hasMenuSection.flatMap((s: any) => s.hasMenuItem);
  const burrata = items.find((i: any) => i.name === 'Burrata & heirloom tomato');
  expect(burrata.offers).toMatchObject({ price: '123.25', priceCurrency: 'EGP' });
  expect(burrata.offers.priceSpecification[1]).toMatchObject({ price: '145.00', priceType: 'https://schema.org/ListPrice' });
  await site.close();
  expect(errors).toEqual([]);
});
