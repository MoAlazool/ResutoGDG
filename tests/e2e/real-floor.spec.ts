import { API_URL, apiAs, apiCreateTenant, apiQrSheet, apiSaveFloor, apiSeedMenu, collectApiFailures, collectErrors, expect, newContext, signIn, test, unique, WEB_URL, type Tenant } from './fixtures';

// Floor Studio, QR sheet and live floor against B1's REAL floor API (no request
// interception). F's floor.spec.ts covers the same UI against the §8 contract
// double; every place the real API behaves differently is recorded in
// docs/qa/BROWSER_DEFECTS.md.

const floorUrl = (t: Tenant, tab: 'studio' | 'live' | 'qr') => `/dashboard/${t.orgId}/floor?tab=${tab}`;
const layer = (page: import('@playwright/test').Page, label: string) => page.locator('.floor-layers').getByRole('option', { name: new RegExp(`^${label} `) });

async function guestOrder(request: import('@playwright/test').APIRequestContext, qrUrl: string, lines: unknown[]) {
  const qr = new URL(qrUrl).pathname.split('/t/')[1]!;
  const s = await request.post(`${API_URL}/v1/public/tables/${qr}/session`);
  expect(s.status(), await s.text()).toBe(200);
  const { token } = await s.json();
  const quote = await (await request.post(`${API_URL}/v1/public/visits/current/quote`, { headers: { 'X-Visit-Token': token }, data: { lines } })).json();
  const o = await request.post(`${API_URL}/v1/public/visits/current/orders`, {
    headers: { 'X-Visit-Token': token, 'Idempotency-Key': unique('order') }, data: { lines, notes: null, expectedTotalMinor: quote.totalMinor },
  });
  expect(o.status(), await o.text()).toBe(201);
  return { ...(await o.json()), totalMinor: quote.totalMinor as number };
}

test.describe('Floor Studio against the real floor API', () => {
  // Regression for H-1 (fixed): a new branch has no zones, so Studio sends `zone: null` for the first table; the API must accept it.
  test('the first table on a fresh branch (no zones yet) can be added and saved', async ({ page, request }) => {
    const tenant = await apiCreateTenant(request);
    await signIn(page, tenant.owner);
    await page.goto(floorUrl(tenant, 'studio'));
    await expect(page.getByText('All changes saved')).toBeVisible();
    await page.locator('.object-palette [data-kind="round"]').click();
    await page.getByRole('button', { name: 'Save layout' }).click();
    await expect(page.getByText('Floor layout saved. Guest maps are updated.')).toBeVisible();
    const saved = await apiAs(request, tenant.owner).get(`/o/${tenant.orgId}/floor/${tenant.branchId}`);
    expect(saved.tables).toHaveLength(1);
  });

  test('add, move and rotate a table, save, reload: the layout is persisted server-side', async ({ page, request }) => {
    const tenant = await apiCreateTenant(request);
    await apiSaveFloor(request, tenant);
    const errors = collectErrors(page);
    const failures = collectApiFailures(page);
    await signIn(page, tenant.owner);
    await page.goto(floorUrl(tenant, 'studio'));
    await expect(page.getByText('All changes saved')).toBeVisible();
    await expect(page.locator('.canvas-foot')).toContainText('2 tables · 8 seats');

    await page.locator('.object-palette [data-kind="round"]').click();
    await expect(page.locator('.canvas-foot')).toContainText('1 selected');
    const x0 = Number(await page.getByLabel('X', { exact: true }).inputValue());
    await page.locator('.studio-canvas').focus();
    await page.keyboard.press('Shift+ArrowRight');
    await page.keyboard.press('Shift+ArrowRight');
    await expect(page.getByLabel('X', { exact: true })).toHaveValue(String(x0 + 20));
    for (let i = 0; i < 3; i++) await page.getByRole('button', { name: '↻ 15°' }).click();
    await page.getByText('Advanced dimensions').click();
    await expect(page.getByLabel('Rotation °')).toHaveValue('45');
    await page.getByRole('button', { name: 'Save layout' }).click();
    await expect(page.getByText('Floor layout saved. Guest maps are updated.')).toBeVisible();
    await expect(page.getByText('All changes saved')).toBeVisible();

    const saved = await apiAs(request, tenant.owner).get(`/o/${tenant.orgId}/floor/${tenant.branchId}`);
    expect(saved.revision).toBe(2);
    const added = saved.tables.find((x: any) => x.label === 'T3');
    expect(added).toMatchObject({ shape: 'round', cx: x0 + 20, rotation: 45, zone: 'Main Room', status: 'available' });
    expect(added.id).toMatch(/^[0-9a-f-]{36}$/);

    await page.reload();
    await expect(page.getByText('All changes saved')).toBeVisible();
    await expect(page.getByText('Recovered your unsaved floor draft')).toHaveCount(0);
    await expect(page.locator('.canvas-foot')).toContainText('3 tables');
    await layer(page, 'T3').click();
    await page.getByText('Advanced dimensions').click();
    await expect(page.getByLabel('X', { exact: true })).toHaveValue(String(x0 + 20));
    await expect(page.getByLabel('Rotation °')).toHaveValue('45');
    expect(errors).toEqual([]);
    expect(failures).toEqual([]);
  });

  test('two managers save concurrently: the second gets the stale-layout conflict with reload and export', async ({ browser, request }) => {
    const tenant = await apiCreateTenant(request);
    await apiSaveFloor(request, tenant);
    const a = await newContext(browser, { user: tenant.owner });
    const b = await newContext(browser, { user: tenant.owner });
    try {
      for (const { page } of [a, b]) {
        await page.goto(floorUrl(tenant, 'studio'));
        await expect(page.getByText('All changes saved')).toBeVisible();
      }
      // Manager A adds a square table and saves first (revision 1 → 2).
      await a.page.locator('.object-palette [data-kind="square"]').click();
      await a.page.getByRole('button', { name: 'Save layout' }).click();
      await expect(a.page.getByText('Floor layout saved. Guest maps are updated.')).toBeVisible();

      // Manager B, still on revision 1, moves T1 and saves: refused, draft kept.
      await layer(b.page, 'T1').click();
      await b.page.locator('.studio-canvas').focus();
      await b.page.keyboard.press('Shift+ArrowDown');
      const conflictPut = b.page.waitForResponse((r) => r.request().method() === 'PUT' && r.url().includes('/floor/'));
      await b.page.keyboard.press('Control+s');
      const put = await conflictPut;
      expect(put.status()).toBe(409);
      expect((await put.json()).error).toMatchObject({ code: 'stale_layout', details: { currentRevision: 2 } });
      const conflict = b.page.locator('.floor-conflict');
      await expect(conflict).toContainText('Another version was saved. Your draft is safe.');
      await expect(conflict).toContainText('revision 2');
      await expect(b.page.locator('.canvas-foot')).toContainText(/2 tables|1 selected/);

      const download = b.page.waitForEvent('download');
      await conflict.getByRole('button', { name: 'Export draft' }).click();
      const file = await download;
      expect(file.suggestedFilename()).toMatch(/^resuto-floor-draft-.*\.json$/);
      const exported = JSON.parse(await (await import('node:fs/promises')).readFile((await file.path())!, 'utf8'));
      expect(exported.baseRevision).toBe(1);
      expect(exported.layout.tables).toHaveLength(2);

      await conflict.getByRole('button', { name: 'Reload saved floor' }).click();
      await b.page.locator('dialog.rui-confirm[open]').getByRole('button', { name: 'Reload saved floor' }).click();
      await expect(b.page.locator('.floor-conflict')).toHaveCount(0);
      await expect(b.page.locator('.canvas-foot')).toContainText('3 tables');
      const saved = await apiAs(request, tenant.owner).get(`/o/${tenant.orgId}/floor/${tenant.branchId}`);
      expect(saved.revision).toBe(2);
      expect(saved.tables.find((x: any) => x.label === 'T1').cy).toBe(220);
    } finally {
      await a.context.close();
      await b.context.close();
    }
  });

  test('removing a table with an open visit is refused (table_in_use) and nothing is archived', async ({ page, request }) => {
    const tenant = await apiCreateTenant(request);
    const layout = await apiSaveFloor(request, tenant);
    const t2 = layout.tables.find((x: any) => x.label === 'T2');
    await apiAs(request, tenant.owner).post(`/o/${tenant.orgId}/visits`, { tableId: t2.id, partySize: 2 });
    await signIn(page, tenant.owner);
    await page.goto(floorUrl(tenant, 'studio'));
    await expect(page.getByText('All changes saved')).toBeVisible();
    await layer(page, 'T2').click();
    await page.keyboard.press('Delete');
    await expect(page.locator('.canvas-foot')).toContainText('1 tables');
    const putDone = page.waitForResponse((r) => r.request().method() === 'PUT' && r.url().includes('/floor/'));
    await page.getByRole('button', { name: 'Save layout' }).click();
    const put = await putDone;
    expect(put.status()).toBe(409);
    expect((await put.json()).error).toMatchObject({ code: 'table_in_use', details: { tableId: t2.id } });
    await expect(page.locator('.layout-error')).toHaveText('Table T2 has an open visit or an upcoming reservation and cannot be removed. Close or move it first.');
    await expect(page.getByText('Unsaved changes')).toBeVisible();
    const saved = await apiAs(request, tenant.owner).get(`/o/${tenant.orgId}/floor/${tenant.branchId}`);
    expect(saved.revision).toBe(1);
    expect(saved.tables.map((x: any) => x.label)).toEqual(['T1', 'T2']);
  });

  test('the QR sheet shows one printable, scannable QR code per table', async ({ page, request }) => {
    const tenant = await apiCreateTenant(request);
    await apiSaveFloor(request, tenant, [{ label: 'T1', cx: 250, cy: 220 }, { label: 'T2', cx: 520, cy: 220 }, { label: 'T3', cx: 790, cy: 220 }]);
    const errors = collectErrors(page);
    await signIn(page, tenant.owner);
    await page.goto(floorUrl(tenant, 'studio'));
    await page.getByRole('tab', { name: 'Table QR codes' }).click();
    const cards = page.locator('.qr-card');
    await expect(cards).toHaveCount(3);
    await expect(cards.first().getByRole('img', { name: /T1/ })).toBeVisible();
    await expect(cards.nth(2)).toContainText('T3');
    // Server-rendered QR SVGs (real codes: many modules drawn as paths).
    expect(await cards.first().locator('svg path').count()).toBeGreaterThan(0);
    await expect(page.getByRole('button', { name: 'Print' })).toBeVisible();
    const items = await apiQrSheet(request, tenant);
    for (const item of items) expect(item.url).toMatch(new RegExp(`^${WEB_URL}/t/[A-Za-z0-9_-]{16,}$`));
    await page.emulateMedia({ media: 'print' });
    await expect(page.locator('.qr-print-root .no-print')).toBeHidden();
    await expect(cards.first()).toBeVisible();
    expect(errors).toEqual([]);
  });
});

test.describe('Live floor against the real visits API', () => {
  test('seat a walk-in, the unpaid balance forces a confirmed close', async ({ page, request }) => {
    const tenant = await apiCreateTenant(request);
    const menu = await apiSeedMenu(request, tenant);
    await apiSaveFloor(request, tenant);
    const errors = collectErrors(page, [/Failed to load resource.*409/]);
    await signIn(page, tenant.owner);
    await page.goto(floorUrl(tenant, 'live'));
    await expect(page.locator('.live-kpis')).toContainText('Tables free');
    await page.getByRole('button', { name: /^T1,/ }).click();
    await page.getByLabel('Party size').fill('3');
    await page.getByRole('button', { name: '+ Seat a walk-in' }).click();
    await expect(page.getByText('T1 seated.')).toBeVisible();
    await expect(page.locator('.live-panel .badge').first()).toHaveText('Seated');

    // A guest at T1 orders through the table QR (joins the staff-opened visit).
    const qr = (await apiQrSheet(request, tenant)).find((x) => x.label === 'T1')!;
    const order = await guestOrder(request, qr.url, [{ productId: menu.fries, quantity: 2, modifiers: [] }]);
    expect(order.totalMinor).toBeGreaterThan(0);
    await expect(page.locator('.live-panel')).toContainText('EGP', { timeout: 15_000 });
    await expect(page.locator('.live-panel .badge').first()).toHaveText('Ordered', { timeout: 15_000 });

    await page.getByRole('button', { name: 'Close table' }).click();
    const dialog = page.locator('dialog.rui-confirm[open]');
    await expect(dialog).toContainText('Close with an open balance?');
    await expect(dialog).toContainText('Settle the bill');
    await dialog.getByRole('button', { name: 'Close anyway' }).click();
    await expect(page.getByText('T1 closed.')).toBeVisible();
    const visit = await apiAs(request, tenant.owner).get(`/o/${tenant.orgId}/visits/${(await apiAs(request, tenant.owner).get(`/o/${tenant.orgId}/orders/${order.id}`)).visitId}`);
    expect(visit).toMatchObject({ status: 'closed' });
    expect(errors).toEqual([]);
  });

  // Regression for H-2 (fixed): closing from the live floor sends `{}`; the table must then need cleaning so "Mark clean" is reachable.
  test('after closing, the table needs cleaning and "Mark clean" returns it to Available', async ({ page, request }) => {
    const tenant = await apiCreateTenant(request);
    await apiSaveFloor(request, tenant);
    await signIn(page, tenant.owner);
    await page.goto(floorUrl(tenant, 'live'));
    await page.getByRole('button', { name: /^T1,/ }).click();
    await page.getByRole('button', { name: '+ Seat a walk-in' }).click();
    await expect(page.getByText('T1 seated.')).toBeVisible();
    await page.getByRole('button', { name: 'Close table' }).click();
    await expect(page.getByText('T1 closed.')).toBeVisible();
    await expect(page.locator('.live-panel .badge').first()).toHaveText('Needs cleaning', { timeout: 5_000 });
    await page.getByRole('button', { name: 'Mark clean' }).click();
    await expect(page.getByText('T1 is ready for guests.')).toBeVisible();
    await expect(page.locator('.live-panel .badge').first()).toHaveText('Available');
  });
});
