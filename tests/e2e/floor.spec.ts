import AxeBuilder from '@axe-core/playwright';
import { apiCreateTenant, API_URL, expect, expectNoHorizontalOverflow, signIn, test } from './fixtures';
import { concurrentSave, mockFloorApi, seedFloor } from './floor-api-mock';

// B1's floor module (GET/PUT /floor/:branchId, /live, /qr, visits) is not part of this
// worktree, so these specs drive the Floor Studio UI against an in-browser double of
// the §8 HTTP contract (tests/e2e/floor-api-mock.ts). They exercise the UI behaviour
// only; the real floor API is verified by Agent B1's own tests.
test.describe('Floor Studio (against the §8 floor contract double — B1 API absent in this worktree)', () => {
  test('edit, undo, persist the draft across reloads and save with baseRevision', async ({ page, request }) => {
    const tenant = await apiCreateTenant(request);
    const state = seedFloor();
    await signIn(page, tenant.owner);
    await mockFloorApi(page, API_URL, tenant.orgId, state);
    await page.goto(`/dashboard/${tenant.orgId}/floor?tab=studio`);
    await expect(page.getByText('All changes saved')).toBeVisible();
    await expect(page.locator('.canvas-foot')).toContainText('3 tables · 10 seats');

    // Add a round table from the palette, then move it with the keyboard.
    await page.locator('.object-palette [data-kind="round"]').click();
    await expect(page.locator('.canvas-foot')).toContainText('1 selected');
    await expect(page.getByText('Unsaved changes')).toBeVisible();
    const x0 = Number(await page.getByLabel('X', { exact: true }).inputValue());
    await page.locator('.studio-canvas').focus();
    await page.keyboard.press('Shift+ArrowRight');
    await expect(page.getByLabel('X', { exact: true })).toHaveValue(String(x0 + 10));
    // Drag it on the canvas.
    const table = page.locator('.studio-canvas [data-object-id^="new-"]');
    const box = (await table.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 60, box.y + box.height / 2 + 40, { steps: 6 });
    await page.mouse.up();
    const moved = Number(await page.getByLabel('X', { exact: true }).inputValue());
    expect(moved).toBeGreaterThan(x0 + 10);
    // Undo the drag, redo it.
    await page.getByRole('button', { name: 'Undo' }).click();
    await expect(page.getByLabel('X', { exact: true })).toHaveValue(String(x0 + 10));
    await page.getByRole('button', { name: 'Redo' }).click();
    await expect(page.getByLabel('X', { exact: true })).toHaveValue(String(moved));

    // The draft survives a reload (sessionStorage).
    await page.reload();
    await expect(page.getByText('Recovered your unsaved floor draft')).toBeVisible();
    await expect(page.locator('.canvas-foot')).toContainText('4 tables');

    // Save: PUT carries baseRevision; new tables are sent without ids.
    await page.getByRole('button', { name: 'Save layout' }).click();
    await expect(page.getByText('Floor layout saved. Guest maps are updated.')).toBeVisible();
    await expect(page.getByText('All changes saved')).toBeVisible();
    expect(state.puts).toHaveLength(1);
    expect(state.puts[0]).toMatchObject({ baseRevision: 4, tables: 4 });
    expect(state.revision).toBe(5);
    expect(await page.evaluate(() => Object.keys(sessionStorage).filter((k) => k.startsWith('resuto.floor.draft')).length)).toBe(0);
  });

  test('a stale save keeps the draft and offers reload/export, never overwriting', async ({ page, request }) => {
    const tenant = await apiCreateTenant(request);
    const state = seedFloor();
    await signIn(page, tenant.owner);
    await mockFloorApi(page, API_URL, tenant.orgId, state);
    await page.goto(`/dashboard/${tenant.orgId}/floor?tab=studio`);
    await page.locator('.object-palette [data-kind="square"]').click();
    concurrentSave(state); // another manager saves revision 5
    await page.keyboard.press('Control+s');
    const conflict = page.locator('.floor-conflict');
    await expect(conflict).toContainText('Another version was saved. Your draft is safe.');
    await expect(conflict).toContainText('revision 5');
    expect(state.puts).toHaveLength(0);
    await expect(page.locator('.floor-layers .layer')).toHaveCount(7);
    const download = page.waitForEvent('download');
    await conflict.getByRole('button', { name: 'Export draft' }).click();
    expect((await download).suggestedFilename()).toMatch(/^resuto-floor-draft-.*\.json$/);
    await conflict.getByRole('button', { name: 'Reload saved floor' }).click();
    await page.locator('dialog.rui-confirm[open]').getByRole('button', { name: 'Reload saved floor' }).click();
    await expect(page.locator('.canvas-foot')).toContainText('3 tables');
    await expect(page.locator('.floor-conflict')).toHaveCount(0);
  });

  test('align, distribute, duplicate, delete and discard', async ({ page, request }) => {
    const tenant = await apiCreateTenant(request);
    await signIn(page, tenant.owner);
    await mockFloorApi(page, API_URL, tenant.orgId, seedFloor());
    await page.goto(`/dashboard/${tenant.orgId}/floor?tab=studio`);
    const layers = page.locator('.floor-layers .layer');
    await layers.filter({ hasText: 'T2' }).click();
    for (let i = 0; i < 3; i++) await page.keyboard.press('Shift+ArrowDown');
    await layers.filter({ hasText: 'T1' }).click();
    await layers.filter({ hasText: 'T2' }).click({ modifiers: ['Shift'] });
    await layers.filter({ hasText: 'T3' }).click({ modifiers: ['Shift'] });
    await expect(page.locator('.canvas-foot')).toContainText('3 selected');
    await page.getByText('Align & space multiple objects').click();
    await page.getByRole('button', { name: 'Bottom ↓' }).click();
    await page.getByRole('button', { name: 'Space ↔' }).click();
    await page.keyboard.press('Escape');
    await layers.filter({ hasText: 'T2' }).click();
    await page.keyboard.press('Control+d');
    await expect(page.locator('.canvas-foot')).toContainText('1 selected');
    await expect(layers.filter({ hasText: 'T2 copy' })).toHaveCount(1);
    await page.keyboard.press('Delete');
    await expect(layers.filter({ hasText: 'T2 copy' })).toHaveCount(0);
    await page.getByRole('button', { name: 'Discard' }).click();
    await page.locator('dialog.rui-confirm[open]').getByRole('button', { name: 'Discard' }).click();
    await expect(page.getByText('All changes saved')).toBeVisible();
  });

  test('2D/2.5D guest preview, QR sheet and live floor operations', async ({ page, request }) => {
    const tenant = await apiCreateTenant(request);
    const state = seedFloor();
    await signIn(page, tenant.owner);
    await mockFloorApi(page, API_URL, tenant.orgId, state);
    await page.goto(`/dashboard/${tenant.orgId}/floor?tab=studio`);
    await page.getByRole('button', { name: 'Guest preview' }).click();
    const preview = page.locator('.floor-perspective');
    await expect(preview).toHaveAttribute('data-view', '3d');
    await preview.getByRole('button', { name: '2D' }).click();
    await expect(preview).toHaveAttribute('data-view', '2d');
    await page.keyboard.press('Escape');

    // The Studio is full screen (VS-23): staff leave it with "Back to service", then use the floor tabs.
    await expect(page.getByRole('tab', { name: 'Table QR codes' }), 'no tab bar hidden behind the full-screen Studio').toHaveCount(0);
    await page.getByRole('link', { name: /Back to service/ }).click();
    await page.getByRole('tab', { name: 'Table QR codes' }).click();
    await expect(page.locator('.qr-card')).toHaveCount(3);
    await expect(page.locator('.qr-card svg').first()).toBeVisible();

    await page.getByRole('tab', { name: 'Floor overview' }).click();
    await expect(page.getByRole('region', { name: 'Floor overview', exact: true })).toContainText('Tables available');
    await page.getByRole('button', { name: /^T1,/ }).click();
    const detail = page.getByRole('region', { name: 'T1', exact: true });
    await detail.getByRole('button', { name: /Seat guests/ }).click();
    await expect(page.getByText('T1 seated.')).toBeVisible();
    await expect(detail.getByText('Seated', { exact: true })).toBeVisible();
    await detail.getByRole('button', { name: 'Close visit' }).click();
    await expect(detail.getByRole('button', { name: /Mark as clean/ })).toBeVisible();
    await detail.getByRole('button', { name: /Mark as clean/ }).click();
    await expect(detail.getByText('Available', { exact: true })).toBeVisible();
  });

  test('Floor Studio works in Arabic (RTL) at 390 px and has no serious a11y violations', async ({ page, request }) => {
    const tenant = await apiCreateTenant(request);
    await signIn(page, tenant.owner, 'ar');
    await mockFloorApi(page, API_URL, tenant.orgId, seedFloor());
    await page.goto(`/dashboard/${tenant.orgId}/floor?tab=studio`);
    await expect(page.locator('.floor-studio')).toHaveAttribute('dir', 'rtl');
    await expect(page.getByRole('heading', { name: 'استوديو الصالة' })).toBeVisible();
    const results = await new AxeBuilder({ page }).include('.floor-studio').disableRules(['color-contrast']).analyze();
    expect(results.violations.filter((v) => ['serious', 'critical'].includes(v.impact ?? '')).map((v) => `${v.id}: ${v.nodes[0]?.target.join(' ')}`)).toEqual([]);
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByRole('button', { name: 'العناصر' })).toBeVisible();
    await expectNoHorizontalOverflow(page);
  });
});
