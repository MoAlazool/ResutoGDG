import { request as playwrightRequest, type Page } from '@playwright/test';
import { apiCreateTenant, apiQrSheet, apiSaveFloor, apiSeedMenu, collectErrors, eventually, expect, newContext, qrPath, sql, test, type Tenant } from './fixtures';

// 21-CRM, Chromium: a guest's table QR scan arrives as a first-party beacon with no personal data, the Insights Funnel
// tab shows it with every step's source and completeness (and the Retention tab draws the cohort grid and the
// repeat-purchase curve) in English and Arabic, and the segment builder in Customers counts and saves a segment.

let tenant: Tenant;
let tablePath: string;

test.beforeAll(async () => {
  const request = await playwrightRequest.newContext();
  tenant = await apiCreateTenant(request, { planId: 'pro' });
  await apiSeedMenu(request, tenant);
  await apiSaveFloor(request, tenant);
  tablePath = qrPath((await apiQrSheet(request, tenant))[0]!.url);
  await request.dispose();
});

test.describe.configure({ timeout: 120_000 });

const EASTERN = /[٠-٩۰-۹]/;
const isBeacon = (url: string) => url.endsWith('/v1/public/funnel/beacon');

async function openInsightsTab(page: Page, tab: 'funnel' | 'retention') {
  await page.goto(`/dashboard/${tenant.orgId}/analytics?tab=${tab}`);
  await expect(page.getByTestId(`${tab}-panel`)).toBeVisible({ timeout: 30_000 });
}

test('a table QR scan is a first-party beacon without personal data, counted in the Funnel tab', async ({ browser }) => {
  const guest = await newContext(browser, { mobile: true });
  const beacons: Array<{ body: string; headers: Record<string, string> }> = [];
  guest.page.on('request', (r) => { if (isBeacon(r.url())) beacons.push({ body: r.postData() ?? '', headers: r.headers() }); });
  await guest.page.goto(tablePath);
  await eventually(async () => beacons.some((b) => b.body.includes('"qr_scan"')), { message: 'qr_scan beacon' });
  const scan = JSON.parse(beacons.find((b) => b.body.includes('"qr_scan"'))!.body);
  expect(Object.keys(scan).sort()).toEqual(['b', 'e', 'o', 's', 'sid']);
  expect(scan).toMatchObject({ e: 'qr_scan', s: 't', o: tenant.slug, b: tenant.branchId });
  expect(beacons.every((b) => !/phone|email|name|customer|href|url/i.test(b.body))).toBe(true);
  // No cookie and nothing in localStorage for it: the tab id lives in sessionStorage only.
  expect(await guest.page.evaluate(() => Object.keys(localStorage).filter((k) => k.includes('fsid')))).toEqual([]);
  expect(await guest.page.evaluate(() => sessionStorage.getItem('resuto.fsid'))).toMatch(/^[A-Za-z0-9_-]{16,32}$/);
  const [row] = await eventually(async () => {
    const rows = await sql(`select kind, surface, branch_id, customer_id, session_key from attribution_events where org_id = $1 and kind = 'qr_scan'`, [tenant.orgId]);
    return rows.length ? rows : null;
  }, { message: 'stored qr_scan' });
  expect(row).toMatchObject({ kind: 'qr_scan', surface: 't', branch_id: tenant.branchId, customer_id: null });
  expect(row.session_key).not.toBe(scan.sid);
  await guest.context.close();

  const { context, page } = await newContext(browser, { user: tenant.owner });
  const errors = collectErrors(page);
  try {
    await openInsightsTab(page, 'funnel');
    const panel = page.getByTestId('funnel-panel');
    await expect(panel.getByRole('heading', { name: 'Growth funnel' })).toBeVisible();
    const rows = panel.locator('table tbody tr');
    await expect(rows).toHaveCount(6);
    const rowOf = (step: string) => rows.filter({ has: page.locator('strong', { hasText: new RegExp(`^${step}$`) }) });
    const qr = rowOf('QR scans');
    await expect(qr).toContainText('Lower bound');
    await expect(qr).toContainText('attribution_events');
    await expect(qr.locator('.num').first()).toHaveText('1');
    await expect(rowOf('Visits')).toContainText('Estimate');
    await expect(rowOf('Orders')).toContainText('Complete');
    await expect(panel.locator('.rui-funnel-step')).toHaveCount(6);
    await expect(panel).toContainText('Ad Pixels still wait for each guest’s consent');

    await openInsightsTab(page, 'retention');
    await expect(page.getByTestId('retention-panel').getByRole('heading', { name: 'Retention by first-order month' })).toBeVisible();
    await expect(page.getByTestId('retention-panel').getByRole('heading', { name: 'Repeat purchases' })).toBeVisible();

    // Arabic, right to left, Western digits.
    await context.addCookies([{ name: 'resuto_locale', value: 'ar', url: new URL(page.url()).origin }]);
    await openInsightsTab(page, 'funnel');
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    await expect(page.getByTestId('funnel-panel')).toContainText('مسح رموز QR');
    await expect(page.getByTestId('funnel-panel')).toContainText('حد أدنى');
    expect(EASTERN.test(await page.getByTestId('funnel-panel').innerText())).toBe(false);
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
});

test('the segment builder in Customers counts matching customers and saves a segment', async ({ browser }) => {
  const { context, page } = await newContext(browser, { user: tenant.owner });
  const errors = collectErrors(page);
  try {
    await page.goto(`/dashboard/${tenant.orgId}/customers`);
    await page.getByRole('tab', { name: 'Segments' }).click();
    await expect(page).toHaveURL(/view=segments/);
    const builder = page.locator('.crm-seg');
    await expect(builder.getByRole('heading', { name: 'Segment builder' })).toBeVisible({ timeout: 30_000 });
    const preview = page.waitForRequest((r) => r.method() === 'POST' && r.url().endsWith('/marketing/segments/preview'));
    await expect(page.getByTestId('segment-count')).toContainText('customers match', { timeout: 15_000 });
    await preview;
    // Add an "any of" group (a branch rule), then a channel rule inside it.
    await builder.getByRole('button', { name: 'Add a group' }).first().click();
    await expect(builder.locator('fieldset.crm-seg-group')).toHaveCount(2);
    const nested = builder.locator('fieldset.crm-seg-group').nth(1);
    await nested.getByRole('button', { name: 'Add a rule' }).click();
    await nested.locator('.crm-seg-rule').last().getByLabel('Rule').selectOption('channel');
    await nested.locator('.crm-seg-rule').last().getByLabel('Channel').selectOption('qr');
    const recount = page.waitForRequest((r) => r.url().endsWith('/marketing/segments/preview') && (r.postData() ?? '').includes('"channel":"qr"'));
    await recount;
    await expect(page.getByTestId('segment-count')).toContainText('can receive marketing');
    // Save.
    await builder.getByLabel('Segment name').fill('Main branch or QR guests');
    const saved = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith(`/o/${tenant.orgId}/marketing/segments`));
    await builder.getByRole('button', { name: 'Save segment' }).click();
    const res = await saved;
    expect(res.status()).toBe(201);
    expect(JSON.parse(res.request().postData() ?? '{}').definition).toMatchObject({ op: 'and', rules: expect.arrayContaining([
      expect.objectContaining({ op: 'or', rules: expect.arrayContaining([{ type: 'channel', channel: 'qr' }]) })]) });
    await expect(builder).toContainText('Saved “Main branch or QR guests”');
    await expect(builder.locator('table')).toContainText('Main branch or QR guests');
    // Keyboard: the view tabs are reachable and the list comes back.
    await page.getByRole('tab', { name: 'Customers' }).click();
    await expect(page).not.toHaveURL(/view=segments/);
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
});
