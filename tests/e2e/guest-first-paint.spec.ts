import pg from 'pg';
import { inspectGuestShell } from '../../scripts/perf/lib/guest-shell.mjs';
import { DB_URL, WEB_URL, apiCreateTenant, apiQrSheet, apiSaveFloor, apiSeedMenu, expect, qrPath, sql, test } from './fixtures';

// PERF-01: the guest ordering page (/order/<slug>) and the QR table page (/t/<qr>) carry their heading and menu in the
// server HTML itself, not behind a streamed loading boundary (scripts/perf/guest-shell.mjs, run here against the real
// build and API). And when the server's menu read is slow, the QR page of a table that is not taking orders still
// shows the menu: the page renders its skeleton and the browser loads the branch's public menu (review of PERF-01: the
// skeleton used to stay up for good, because only a table visit loaded the menu in the browser).

test('the heading and menu are in the server HTML of both guest pages (no loading boundary)', async ({ request }) => {
  const tenant = await apiCreateTenant(request);
  await apiSeedMenu(request, tenant);
  await apiSaveFloor(request, tenant);
  const qr = qrPath((await apiQrSheet(request, tenant)).find((x) => x.label === 'T2')!.url);
  for (const path of [`/order/${tenant.slug}`, qr]) {
    await request.get(`${WEB_URL}${path}`);   // the first request fills the server's shared cache
    const res = await request.get(`${WEB_URL}${path}`);
    expect(res.status(), path).toBe(200);
    const shell = inspectGuestShell(await res.text());
    expect(shell.problems, path).toEqual([]);
    expect(shell.ok, path).toBe(true);
  }
});

test('slow menu read, table not taking orders: skeleton first, then the public menu loaded in the browser', async ({ request, page }) => {
  // A fresh table of a fresh restaurant: its menu is not in the server cache yet. The menu tables are locked for
  // longer than the menu budget (1.2 s), so the server renders the page without the menu.
  const tenant = await apiCreateTenant(request);
  await apiSeedMenu(request, tenant);
  await apiSaveFloor(request, tenant, [{ label: 'C1', cx: 250, cy: 220 }]);
  const qr = (await apiQrSheet(request, tenant)).find((x) => x.label === 'C1')!;
  await sql(`update dining_tables set status = 'cleaning' where id = $1`, [qr.tableId]);

  const locker = new pg.Client({ connectionString: DB_URL });
  await locker.connect();
  const api: string[] = [];
  page.on('request', (r) => { if (/\/v1\/public\//.test(r.url())) api.push(`${r.method()} ${new URL(r.url()).pathname}`); });
  try {
    await locker.query('begin');
    await locker.query('lock table products, menus, menu_versions, menu_categories, product_branch_settings in access exclusive mode');
    const release = new Promise((r) => setTimeout(r, 2500)).then(() => locker.query('commit'));
    await page.goto(qrPath(qr.url), { waitUntil: 'commit' });
    await expect(page.locator('h1')).toBeVisible();
    await expect(page.locator('.gx-menu-skeleton')).toBeVisible();
    await expect(page.getByText('Ask our team to open your table to order.')).toBeVisible();
    await release;
    // The lock is gone: the browser's own menu read finishes and the dishes replace the skeleton.
    await expect(page.getByRole('button', { name: /Smash burger/ }).first()).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('.gx-menu-skeleton')).toHaveCount(0);
    expect(api).toContain(`GET /v1/public/menu/${tenant.slug}`);
    expect(api.some((x) => x.endsWith('/session'))).toBe(false);   // no session for a table that is not taking orders
  } finally {
    await locker.query('rollback').catch(() => {});
    await locker.end();
  }
});
