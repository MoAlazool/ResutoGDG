import { API_URL, apiCreateTenant, apiQrSheet, apiSaveFloor, apiSeedMenu, collectApiFailures, collectErrors, expect, newContext, sql, test, unique, type Tenant } from './fixtures';

// 21-OPS: keyboard order triage on the Orders board (j/k, a, Enter, x + bulk move) and the kitchen display's bump
// flow (1-9, Enter, arrows, b), against the real API. The dashboard's Kitchen link opens the one full-screen display.

test.describe.configure({ timeout: 120_000 });

async function guestOrder(request: import('@playwright/test').APIRequestContext, qrUrl: string, productId: string) {
  const qr = new URL(qrUrl).pathname.split('/t/')[1]!;
  const s = await request.post(`${API_URL}/v1/public/tables/${qr}/session`);
  expect(s.status(), await s.text()).toBe(200);
  const { token } = await s.json();
  const lines = [{ productId, quantity: 1, modifiers: [] }];
  const quote = await (await request.post(`${API_URL}/v1/public/visits/current/quote`, { headers: { 'X-Visit-Token': token }, data: { lines } })).json();
  const o = await request.post(`${API_URL}/v1/public/visits/current/orders`, {
    headers: { 'X-Visit-Token': token, 'Idempotency-Key': unique('order') }, data: { lines, notes: null, expectedTotalMinor: quote.totalMinor },
  });
  expect(o.status(), await o.text()).toBe(201);
  return (await o.json()).order?.id ?? (await o.json()).id;
}

async function setup(request: import('@playwright/test').APIRequestContext) {
  const tenant = await apiCreateTenant(request);
  const menu = await apiSeedMenu(request, tenant);
  await apiSaveFloor(request, tenant);
  const qrs = await apiQrSheet(request, tenant);
  for (const label of ['T1', 'T2']) await guestOrder(request, qrs.find((q) => q.label === label)!.url, menu.fries);
  return tenant;
}

const statusOf = async (t: Tenant, table: string) =>
  (await sql<{ status: string }>(`select o.status from orders o join dining_tables t on t.id = o.table_id where o.org_id = $1 and t.label = $2`, [t.orgId, table]))[0]?.status;

test('orders board: keyboard triage with j/k, a, Enter and a bulk move', async ({ browser, request }) => {
  const tenant = await setup(request);
  const { context, page } = await newContext(browser, { user: tenant.owner });
  const errors = collectErrors(page);
  const failures = collectApiFailures(page);
  try {
    await page.goto(`/dashboard/${tenant.orgId}/orders`);
    const lane = (name: string) => page.getByRole('region', { name, exact: true });
    await expect(lane('New orders').locator('article')).toHaveCount(2, { timeout: 15_000 });
    await expect(lane('New orders').locator('.rui-lane-count')).toHaveText('2');

    // j focuses the first card; a moves it to Preparing (its version travels with the bump).
    await page.locator('h1').first().click();
    await page.keyboard.press('j');
    const first = page.locator('article:focus');
    await expect(first).toHaveCount(1);
    const firstTable = (await first.locator('.ticket-source').innerText()).includes('T1') ? 'T1' : 'T2';
    const other = firstTable === 'T1' ? 'T2' : 'T1';
    await page.keyboard.press('a');
    await expect(lane('Preparing').locator('article').filter({ hasText: `Table ${firstTable}` })).toBeVisible();
    await expect.poll(() => statusOf(tenant, firstTable)).toBe('preparing');

    // Enter opens the focused order in the sheet; Escape closes it.
    await page.locator('article').filter({ hasText: `Table ${other}` }).focus();
    await page.keyboard.press('Enter');
    const sheet = page.getByRole('dialog', { name: /^Order #/ });
    await expect(sheet).toBeVisible();
    await expect(sheet).toContainText('Fries');
    await page.keyboard.press('Escape');
    await expect(sheet).toBeHidden();

    // x selects both cards (k moves back across lanes), and the bulk bar moves each to its own next step.
    await page.locator('article').filter({ hasText: `Table ${other}` }).focus();
    await page.keyboard.press('x');
    await page.keyboard.press('j');
    await page.keyboard.press('x');
    const bulk = page.getByRole('group', { name: 'Selected orders' });
    await expect(bulk).toContainText('2 orders selected');
    await bulk.getByRole('button', { name: 'Move to next step' }).click();
    await expect(page.getByRole('status').filter({ hasText: '2 orders moved to their next step.' })).toBeVisible();
    await expect.poll(() => statusOf(tenant, other)).toBe('preparing');
    await expect.poll(() => statusOf(tenant, firstTable)).toBe('ready');
    await expect(lane('Ready to serve').locator('article').filter({ hasText: `Table ${firstTable}` })).toBeVisible();

    // The ? cheat sheet lists the board's keys.
    await page.locator('h1').first().click();
    await page.keyboard.press('Shift+?');
    const cheat = page.getByRole('dialog', { name: 'Keyboard shortcuts' });
    await expect(cheat).toContainText('Move to the next step');
    await page.keyboard.press('Escape');
    expect(errors).toEqual([]);
    expect(failures).toEqual([]);
  } finally {
    await context.close();
  }
});

test('kitchen display: the dashboard link opens it full screen, and the bump bar moves tickets', async ({ browser, request }) => {
  const tenant = await setup(request);
  const { context, page } = await newContext(browser, { user: tenant.owner });
  const errors = collectErrors(page);
  try {
    // One route: the dashboard's Kitchen page forwards to the full-screen display.
    await page.goto(`/dashboard/${tenant.orgId}/kitchen`);
    await expect(page).toHaveURL(new RegExp(`/kitchen/${tenant.orgId}$`));
    await expect(page.getByRole('heading', { level: 1, name: 'Kitchen display' })).toBeVisible();
    const lane = (name: string) => page.getByRole('region', { name, exact: true });
    await expect(lane('New orders').locator('article')).toHaveCount(2, { timeout: 15_000 });

    // Wall-tablet targets: every action on a card is at least 44 px tall.
    for (const h of await lane('New orders').locator('.ticket-actions .btn').evaluateAll((els) => els.map((e) => e.getBoundingClientRect().height))) {
      expect(h).toBeGreaterThanOrEqual(44);
    }

    // 1 picks the first ticket, Enter bumps it to Preparing; the focus stays in New orders on the next ticket.
    await page.keyboard.press('1');
    const picked = (await page.locator('article:focus .ticket-source').innerText()).includes('T1') ? 'T1' : 'T2';
    const second = picked === 'T1' ? 'T2' : 'T1';
    await page.keyboard.press('Enter');
    await expect.poll(() => statusOf(tenant, picked)).toBe('preparing');
    await expect(page.locator('article:focus')).toContainText(`Table ${second}`);

    // Right moves to the Preparing lane, b marks it ready, Enter serves it.
    await page.keyboard.press('ArrowRight');
    await expect(page.locator('article:focus')).toContainText(`Table ${picked}`);
    await page.keyboard.press('b');
    await expect.poll(() => statusOf(tenant, picked)).toBe('ready');
    await expect(lane('Ready to serve').locator('article').filter({ hasText: `Table ${picked}` })).toBeVisible();
    await lane('Ready to serve').locator('article').filter({ hasText: `Table ${picked}` }).focus();
    await page.keyboard.press('Enter');
    await expect.poll(() => statusOf(tenant, picked)).toBe('served');
    await expect(statusOf(tenant, second)).resolves.toBe('placed');
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
});
