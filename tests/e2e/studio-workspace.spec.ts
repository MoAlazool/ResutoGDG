import { apiCreateTenant, collectErrors, expect, publishSite, seedMenu, signIn, sql, test } from './fixtures';

// 21-STUDIO: the canvas workspace. (1) The canvas iframe is isolated from the editor: it cannot read the editor's
// storage, cookies or DOM, and the editor ignores messages that do not come from its own frame with the expected shape.
// (2) AI-assisted editing through change sets with the rules planner (no model): proposal → before/after diff on the
// canvas → approve → applied to the draft (prices change) → the owner publishes → the public site shows it.

const SHELL_404 = [/Failed to load resource.*404/];

test('the canvas frame is sandboxed: no access to the editor’s storage, cookies or DOM; foreign messages are ignored', async ({ page, request }) => {
  const tenant = await apiCreateTenant(request);
  await publishSite(request, tenant, { productIds: await seedMenu(tenant) });
  await signIn(page, tenant.owner);
  const errors = collectErrors(page, SHELL_404);
  await page.goto(`/dashboard/${tenant.orgId}/website`);
  const iframe = page.locator('iframe.ws-frame');
  await expect(iframe).toHaveAttribute('sandbox', 'allow-scripts');
  const canvas = page.frameLocator('iframe.ws-frame');
  await expect(canvas.locator('.restaurant-editorial h1')).toHaveText('Good food. Long conversations.');
  const frame = page.frames().find((f) => f.url().endsWith('/studio-canvas'))!;
  expect(frame).toBeTruthy();

  // The editor keeps its session in localStorage; the canvas, with an opaque origin, can reach none of it.
  expect(await page.evaluate(() => Object.keys(localStorage).length)).toBeGreaterThan(0);
  const probe = await frame.evaluate(() => {
    const attempt = (fn: () => unknown) => { try { fn(); return 'allowed'; } catch (e) { return (e as Error).name; } };
    return {
      origin: self.origin,
      localStorage: attempt(() => window.localStorage.getItem('x')),
      sessionStorage: attempt(() => window.sessionStorage.getItem('x')),
      cookie: attempt(() => document.cookie),
      parentDom: attempt(() => window.parent.document.body.innerHTML),
      parentStorage: attempt(() => (window.parent as Window).localStorage.length),
    };
  });
  expect(probe).toEqual({ origin: 'null', localStorage: 'SecurityError', sessionStorage: 'SecurityError', cookie: 'SecurityError',
    parentDom: 'SecurityError', parentStorage: 'SecurityError' });

  // Links in the canvas do not navigate it (a click selects instead).
  await canvas.locator('a[href^="/order/"]').first().click();
  expect(frame.url()).toMatch(/\/studio-canvas$/);

  const inspector = page.locator('.ws-inspector');
  await inspector.getByRole('radio', { name: 'Section' }).click();
  await expect(inspector.getByText('Select a section')).toBeVisible();
  const [hero] = await sql(`select s.id from website_sections s join websites w on w.id = s.website_id where w.org_id = $1 and s.kind = 'about' limit 1`, [tenant.orgId]);
  const valid = { protocol: 'resuto-studio-canvas', v: 1, type: 'select', id: hero.id };
  // A select message with the right shape but from another origin, or from the editor's own window, is ignored.
  await page.evaluate((data) => {
    const f = document.querySelector<HTMLIFrameElement>('iframe.ws-frame')!;
    window.dispatchEvent(new MessageEvent('message', { data, origin: 'https://evil.example', source: f.contentWindow }));
    window.dispatchEvent(new MessageEvent('message', { data, origin: 'null', source: window }));
    window.postMessage(data, '*');
    window.dispatchEvent(new MessageEvent('message', { data: { ...data, id: 'javascript:alert(1)' }, origin: 'null', source: f.contentWindow }));
  }, valid);
  await page.waitForTimeout(300);
  await expect(inspector.getByText('Select a section')).toBeVisible();
  // The same message from the canvas frame itself is accepted.
  await frame.evaluate((data) => window.parent.postMessage(data, window.location.origin), valid);
  await expect(inspector.getByText('Select a section')).toBeHidden();
  await expect(inspector.locator('.badge').first()).toHaveText('About');
  // The canvas ignores render messages that do not come from the editor.
  await frame.evaluate(() => {
    const site = { slug: 'x', sections: [], branches: [], menuHighlights: [], org: {}, theme: {}, seo: {}, links: {} };
    window.postMessage({ protocol: 'resuto-studio-canvas', v: 1, type: 'render', site, locale: 'en', selected: null, compare: null }, '*');
  });
  await page.waitForTimeout(300);
  await expect(canvas.locator('.restaurant-editorial h1')).toHaveText('Good food. Long conversations.');
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
