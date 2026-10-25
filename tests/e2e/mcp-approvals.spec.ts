import { request as playwrightRequest } from '@playwright/test';
import { apiAs, apiCreateTenant, apiSeedMenu, API_URL, collectErrors, expect, newContext, sql, test, unique, type Tenant } from './fixtures';

// 21-MCP acceptance in the browser: the connection wizard creates a key connection and its test call answers; an AI
// assistant proposes the "Eid section + 3 products at 15 %" change set over the MCP runtime; the owner opens it in the
// approvals inbox, sees the before/after, approves with a reason, and the offer and the published section exist.

let tenant: Tenant;
let products: string[];

test.beforeAll(async () => {
  const request = await playwrightRequest.newContext();
  tenant = await apiCreateTenant(request, { planId: 'pro' });
  const menu = await apiSeedMenu(request, tenant);
  const third = await apiAs(request, tenant.owner).post(`/o/${tenant.orgId}/menu/products`, { categoryId: menu.categoryId, name: 'Kunafa', nameAr: 'كنافة', priceMinor: 9000 });
  products = [menu.burger, menu.fries, third.id];
  await request.dispose();
});

test.describe.configure({ timeout: 120_000 });

test('connection wizard: other assistant, default groups, key shown once, test call answers', async ({ browser }) => {
  const { context, page } = await newContext(browser, { user: tenant.owner });
  const errors = collectErrors(page);
  await page.goto(`/dashboard/${tenant.orgId}/mcp/new`);
  await expect(page.getByRole('heading', { name: 'Connect an AI assistant' })).toBeVisible();
  // Honest labels: sign-in method per assistant, and none is "verified".
  await expect(page.getByText('Not verified yet')).toHaveCount(3);
  await page.getByRole('radio', { name: /Other assistant or developer/ }).check();
  await page.getByRole('button', { name: 'Next' }).click();
  await expect(page.getByRole('heading', { name: 'Connect with a connection key' })).toBeVisible();
  await page.getByRole('button', { name: 'Next' }).click();
  await page.getByLabel('Connection name').fill('E2E wizard key');
  await page.getByRole('button', { name: 'Next' }).click();
  // Permission groups: the defaults (orders/analytics, menu) are ticked; raw tools sit under Advanced.
  await expect(page.getByText('Advanced: add individual tools')).toBeVisible();
  await page.getByRole('button', { name: 'Next' }).click();
  await expect(page.getByRole('columnheader', { name: 'Restaurant policy' })).toBeVisible();
  await page.getByRole('button', { name: 'Next' }).click();
  await page.getByRole('button', { name: 'Create connection' }).click();
  await expect(page.getByText('Connected: E2E wizard key')).toBeVisible();
  await expect(page.locator('code', { hasText: /^rmcp_/ })).toBeVisible();
  await expect(page.getByText(/Test call answered:/)).toBeVisible();
  const [row] = await sql(`select permission_groups, auth_kind from mcp_clients where org_id = $1 and name = 'E2E wizard key'`, [tenant.orgId]);
  expect(row).toEqual({ permission_groups: ['orders_analytics', 'menu'], auth_kind: 'key' });
  expect(errors).toEqual([]);
  await context.close();
});

test('Eid change set from MCP: approved in the approvals inbox, then applied and audited', async ({ browser }) => {
  const request = await playwrightRequest.newContext();
  const owner = apiAs(request, tenant.owner);
  const conn = await owner.post(`/o/${tenant.orgId}/mcp/clients`, {
    name: 'E2E Eid assistant', actingRole: 'manager', groups: ['menu', 'website_drafts', 'website_publish', 'promotions'], rateLimitPerMin: 600,
  });
  const proposed = await request.post(`${API_URL}/v1/o/${tenant.orgId}/mcp/tools/propose_changes`, {
    headers: { Authorization: `Bearer ${conn.key}` },
    data: { input: { title: 'Eid offers', summary: 'Eid section with three dishes at 15% off', idempotencyKey: unique('eid'), ops: [
      { type: 'website.section.add', input: { kind: 'menu_highlights', content: { headline: { en: 'Eid offers', ar: 'عروض العيد' }, productIds: products } } },
      { type: 'promotion.create', input: { name: 'Eid 15', nameAr: 'خصم العيد', code: 'EID15', kind: 'percent', value: 1500 } },
      { type: 'website.publish', input: { note: 'Eid' } },
    ] } },
  });
  const body = await proposed.json();
  expect(proposed.status(), JSON.stringify(body)).toBe(202);
  expect(body.output).toMatchObject({ status: 'approval_required' });
  const changeSetId: string = body.output.changeSetId;
  expect(await sql(`select 1 from promotions where org_id = $1 and code = 'EID15'`, [tenant.orgId])).toEqual([]);

  const { context, page } = await newContext(browser, { user: tenant.owner });
  const errors = collectErrors(page);
  await page.goto(`/dashboard/${tenant.orgId}/approvals?origin=mcp`);
  await expect(page.getByRole('heading', { name: 'Approvals' })).toBeVisible();
  await page.getByRole('link', { name: 'Eid offers' }).click();
  await expect(page).toHaveURL(new RegExp(`/approvals/${changeSetId}$`));
  // Every op with its before/after, and who must approve.
  await expect(page.getByRole('region', { name: 'Create an offer' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Add a website section' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Publish the website' })).toBeVisible();
  await expect(page.getByText('Waiting for approval').first()).toBeVisible();
  await page.getByLabel('Reason').fill('Approved for Eid');
  await page.getByRole('button', { name: 'Approve' }).click();
  await expect(page.getByText('Approved and applied.')).toBeVisible();

  expect(await sql(`select kind, value from promotions where org_id = $1 and code = 'EID15'`, [tenant.orgId])).toEqual([{ kind: 'percent', value: 1500 }]);
  const view = await owner.get(`/o/${tenant.orgId}/change-sets/${changeSetId}`);
  expect(view).toMatchObject({ status: 'applied', decisionNote: 'Approved for Eid', origin: 'mcp', sourceTool: 'propose_changes' });
  const actions = (await sql(`select action from audit_logs where entity_type = 'change_set' and entity_id = $1 order by id`, [changeSetId])).map((r: any) => r.action);
  expect(actions).toEqual(expect.arrayContaining(['change_set.pending_approval', 'change_set.approved', 'change_set.applied']));
  // The audit timeline on the page shows the decision.
  await expect(page.getByText('Approved for Eid').first()).toBeVisible();
  expect(errors).toEqual([]);
  await context.close();
  await request.dispose();
});
