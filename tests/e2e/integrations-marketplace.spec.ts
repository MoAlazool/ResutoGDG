import { request as playwrightRequest } from '@playwright/test';
import { apiAs, apiCreateTenant, apiSignup, API_URL, collectErrors, expect, newContext, sql, test, type Tenant, type User } from './fixtures';

// 21-INT in the browser (plan §6.3): the marketplace's category filter and search, the honest chips, a provider's
// connection sheet (connect method, capabilities "verification pending", disconnect), and the operator console
// refusing a restaurant owner while a platform superadmin sees masked secrets only. Nothing reaches a provider.

let tenant: Tenant;
let superadmin: User;
const SECRET = 'e2e-console-secret-value-7788';

test.beforeAll(async () => {
  const request = await playwrightRequest.newContext();
  tenant = await apiCreateTenant(request);
  // A pasted-key test connection (Gemini, the restaurant's own key): created, never checked against Google.
  await apiAs(request, tenant.owner).post(`/o/${tenant.orgId}/integrations/connections`, { provider: 'gemini_byok', environment: 'sandbox', credentials: { apiKey: 'AIza-e2e-test-key-000000' } });
  superadmin = await apiSignup(request, 'Platform');
  await sql(`insert into platform_admins(user_id, role) values ($1, 'superadmin') on conflict do nothing`, [superadmin.userId]);
  await request.dispose();
});

test.afterAll(async () => { await sql(`delete from platform_provider_apps where provider = 'tiktok_ads'`); });

test('marketplace: category filter, search and honest chips', async ({ browser }) => {
  const { context, page } = await newContext(browser, { user: tenant.owner });
  const errors = collectErrors(page);
  await page.goto(`/dashboard/${tenant.orgId}/integrations`);
  const grid = page.getByRole('list', { name: 'Marketplace' });
  await expect(grid.locator('[data-card="meta_ads"]')).toBeVisible();
  // Stripe does not onboard Egyptian businesses; Gemini is waiting for its first check; sandboxes are labelled.
  await expect(grid.locator('[data-card="stripe"]')).toContainText('Not yet available');
  await expect(grid.locator('[data-card="gemini_byok"]')).toContainText('Needs attention');
  await expect(grid.locator('[data-card="pos_sandbox"]')).toContainText('Sandbox');
  await expect(page.getByText(/^Verified$/)).toHaveCount(0);

  await page.getByRole('group', { name: 'Category' }).getByRole('button', { name: 'POS', exact: true }).click();
  await expect(grid.locator('[data-card="foodics"]')).toBeVisible();
  await expect(grid.locator('[data-card="odoo"]')).toBeVisible();
  await expect(grid.locator('[data-card="meta_ads"]')).toHaveCount(0);
  await page.getByRole('group', { name: 'Category' }).getByRole('button', { name: 'All', exact: true }).click();
  await page.getByRole('searchbox', { name: 'Search integrations' }).fill('whatsapp');
  await expect(grid.locator('[data-card="whatsapp_cloud"]')).toBeVisible();
  await expect(grid.locator('[data-card="foodics"]')).toHaveCount(0);
  expect(errors).toEqual([]);
  await context.close();
});

test('connection sheet: connect methods, capabilities pending verification, disconnect', async ({ browser }) => {
  const { context, page } = await newContext(browser, { user: tenant.owner });
  const errors = collectErrors(page);
  await page.goto(`/dashboard/${tenant.orgId}/integrations`);
  const grid = page.getByRole('list', { name: 'Marketplace' });

  // OAuth provider: "Continue with Foodics" (Resuto's Foodics app is not set up on this server) and keys under Advanced.
  await grid.locator('[data-card="foodics"]').click();
  let sheet = page.getByRole('dialog', { name: /Foodics/ });
  await expect(sheet.getByRole('button', { name: 'Continue with Foodics' })).toBeDisabled();
  await expect(sheet.getByText('Advanced: enter keys yourself')).toBeVisible();
  await expect(sheet.getByText('Implemented; external verification pending').first()).toBeVisible();
  await sheet.getByRole('button', { name: 'Close' }).click();

  // WhatsApp: the official path through the Inbox stepper (no QR mode anywhere).
  await grid.locator('[data-card="whatsapp_cloud"]').click();
  sheet = page.getByRole('dialog', { name: /WhatsApp/ });
  await expect(sheet.getByRole('link', { name: 'Set up WhatsApp' })).toHaveAttribute('href', `/dashboard/${tenant.orgId}/inbox?connect=whatsapp`);
  await expect(sheet.getByText(/QR/)).toHaveCount(0);
  await sheet.getByRole('button', { name: 'Close' }).click();

  // The connected Gemini key: why it needs attention, its access, and disconnect (credentials deleted).
  await grid.locator('[data-card="gemini_byok"]').click();
  sheet = page.getByRole('dialog', { name: /Gemini/ });
  await expect(sheet.getByText('Waiting for the first successful check.')).toBeVisible();
  await expect(sheet.getByText('This provider does not report which permissions were granted.')).toBeVisible();
  await expect(sheet.locator('code', { hasText: /apiKey/ })).toBeVisible();
  await expect(sheet.getByText('AIza-e2e-test-key-000000')).toHaveCount(0);
  await sheet.getByRole('button', { name: 'Disconnect' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Disconnect' }).click();
  await expect(grid.locator('[data-card="gemini_byok"]')).toContainText('Not connected');
  const [row] = await sql(`select status, credentials_encrypted from integration_connections where org_id = $1 and provider = 'gemini_byok'`, [tenant.orgId]);
  expect(row).toEqual({ status: 'revoked', credentials_encrypted: null });
  expect(errors).toEqual([]);
  await context.close();
});

test('operator console: refused for a restaurant owner; a superadmin sees masked secrets only', async ({ browser }) => {
  const request = await playwrightRequest.newContext();
  expect((await request.get(`${API_URL}/v1/admin/providers`, { headers: { Authorization: `Bearer ${tenant.owner.token}` } })).status()).toBe(403);
  await request.dispose();

  const owner = await newContext(browser, { user: tenant.owner });
  await owner.page.goto('/admin/providers');
  await expect(owner.page.getByText('Platform administrators only.')).toBeVisible();
  await expect(owner.page.getByRole('heading', { name: 'Resuto’s provider apps' })).toHaveCount(0);
  await owner.context.close();

  const { context, page } = await newContext(browser, { user: superadmin });
  await page.goto('/admin/providers');
  await expect(page.getByRole('heading', { name: 'Resuto’s provider apps' })).toBeVisible();
  const tiktok = page.getByRole('form', { name: 'TikTok for Business (Marketing API)' });
  await tiktok.getByLabel('App / client id').fill('7300000000000000001');
  await tiktok.getByLabel('App secret').fill(SECRET);
  await tiktok.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Saved. Secrets are stored sealed.')).toBeVisible();
  await expect(tiktok.getByText('Set (…7788)')).toBeVisible();
  await expect(tiktok.getByLabel('App secret')).toHaveValue('');
  expect(await page.content()).not.toContain(SECRET);
  await expect(page.getByText('http://localhost:' + (process.env.E2E_API_PORT ?? '4109') + '/v1/public/integrations/oauth/tiktok_ads/callback')).toBeVisible();
  await context.close();
});
