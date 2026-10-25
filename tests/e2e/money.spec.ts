import { request as playwrightRequest, type APIRequestContext, type Page, type Request } from '@playwright/test';
import {
  apiAs, apiCreateTenant, apiQrSheet, apiSaveFloor, apiSeedMenu, API_URL, collectApiFailures, collectErrors, eventually, expect, navLinkFor, newContext, sql, test, unique,
  workspaceNav, type MenuSeed, type Tenant,
} from './fixtures';

// 21-MONEY (plan §8 acceptance), Chromium against the real API in sandbox mode (no real payment or billing provider):
//   - plan change: an upgrade unlocks its modules at once; a downgrade is scheduled for the period end and, once the
//     billing lifecycle applies it, the lost modules show as LockedFeature previews — never as disabled controls;
//   - payments: the FilterBar (test/live, method, status) filters on the server and a row opens the payment sheet
//     whose refund timeline keeps manual refunds honest until they are completed;
//   - finance: the period picker and comparison, provenance on the figures, and the export centre (create, download,
//     download again).

test.describe.configure({ timeout: 180_000 });

/** Places a QR dine-in order through the public API and returns its id and total. */
async function placeQrOrder(request: APIRequestContext, t: Tenant, menu: MenuSeed, quantity = 2) {
  const qr = (await apiQrSheet(request, t))[0]!;
  const s = await (await request.post(`${API_URL}/v1/public/tables/${new URL(qr.url).pathname.split('/t/')[1]}/session`)).json();
  const lines = [{ productId: menu.fries, quantity, modifiers: [] }];
  const quote = await (await request.post(`${API_URL}/v1/public/visits/current/quote`, { headers: { 'X-Visit-Token': s.token }, data: { lines } })).json();
  const res = await request.post(`${API_URL}/v1/public/visits/current/orders`, { headers: { 'X-Visit-Token': s.token, 'Idempotency-Key': unique('o') }, data: { lines, expectedTotalMinor: quote.totalMinor } });
  expect(res.ok(), await res.text()).toBeTruthy();
  const order = await res.json();
  return { id: (order.id ?? order.order?.id) as string, totalMinor: quote.totalMinor as number };
}

/** Last calendar month in the restaurant's time zone (Africa/Cairo for the fixture restaurants). */
function lastMonth() {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Cairo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const [y, m] = today.split('-').map(Number) as [number, number];
  const py = m === 1 ? y - 1 : y;
  const pm = m === 1 ? 12 : m - 1;
  const last = new Date(Date.UTC(py, pm, 0)).getUTCDate();
  const mm = String(pm).padStart(2, '0');
  return { from: `${py}-${mm}-01`, to: `${py}-${mm}-${String(last).padStart(2, '0')}` };
}
/** The same date a year earlier (29 February becomes 28 February). */
function minusYear(d: string) {
  const [y, m, day] = d.split('-').map(Number) as [number, number, number];
  const last = new Date(Date.UTC(y - 1, m, 0)).getUTCDate();
  return `${y - 1}-${String(m).padStart(2, '0')}-${String(Math.min(day, last)).padStart(2, '0')}`;
}

/** Buttons, inputs and selects shown disabled in the page body (the plan never locks a module with disabled controls). */
const disabledControls = (page: Page) => page.locator('main').locator('button:disabled, input:disabled, select:disabled, textarea:disabled, [aria-disabled="true"]');

// ---------------------------------------------------------------------------------------------------------------------
test('plan change: an upgrade unlocks its modules; a downgrade shows them as LockedFeature previews, never disabled controls', async ({ browser }) => {
  const request = await playwrightRequest.newContext();
  const t = await apiCreateTenant(request, { planId: 'free' });
  await request.dispose();
  const { context, page } = await newContext(browser, { user: t.owner });
  const errors = collectErrors(page);
  const failures = collectApiFailures(page);
  const billing = `/dashboard/${t.orgId}/billing`;
  try {
    await page.goto(billing);
    await expect(page.getByRole('heading', { name: 'Plan & billing', level: 1 })).toBeVisible({ timeout: 20_000 });
    // The Settings cluster's section list (SettingsPage template) marks this page.
    await expect(page.getByRole('navigation', { name: 'Settings sections' }).getByRole('link', { name: 'Plan & billing' })).toHaveAttribute('aria-current', 'page');
    await expect(page.getByTestId('current-plan')).toHaveText('Free QR');
    // Usage meters with the plan's real limits: 1 of 1 branch, 1 of 2 staff accounts.
    const meters = page.getByTestId('usage-meters');
    await expect(meters.locator('[data-metric="branches"]')).toContainText('1 of 1');
    await expect(meters.locator('[data-metric="branches"] progress')).toHaveAttribute('max', '1');
    await expect(meters.locator('[data-metric="staff"]')).toContainText('1 of 2');
    await expect(meters.locator('[data-metric="mcp_calls"]')).toContainText('Not included in this plan');
    // ResutoPay is outside the Free plan: a LockedFeature preview naming the plan that includes it.
    const locked = page.getByTestId('locked-modules');
    const pay = locked.locator('.rui-locked').filter({ has: page.getByRole('heading', { name: 'ResutoPay' }) });
    await expect(pay).toBeVisible();
    await expect(pay).toContainText('In Starter');
    await expect(pay.getByRole('link', { name: 'Compare plans' })).toHaveAttribute('href', '#change-plan');
    await expect(page.getByTestId('included-modules').locator('[data-module="pay"]')).toHaveCount(0);
    await expect(navLinkFor(page, '/payments')).toHaveCount(0);
    // The plan catalogue matrix reads the plans as they are in effect.
    await expect(page.getByTestId('plan-matrix')).toBeVisible({ timeout: 20_000 });
    await expect(disabledControls(page)).toHaveCount(0);

    // Upgrade to Starter (sandbox: no billing provider, nothing is charged): applies now and unlocks ResutoPay.
    await page.locator('[data-plan="starter"]').click();
    await expect(page.locator('[data-plan="starter"]')).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByTestId('plan-quote')).toContainText('per month');
    await page.getByRole('button', { name: 'Apply change' }).click();
    await expect(page.getByText('Plan changed. New modules are available now.')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId('current-plan')).toHaveText('Starter');
    await expect(page.getByTestId('included-modules').locator('[data-module="pay"]')).toBeVisible();
    await expect(page.getByTestId('locked-modules').getByRole('heading', { name: 'ResutoPay' })).toHaveCount(0);
    // The item is in the (collapsible) Money area of the sidebar: present, not locked.
    await expect(navLinkFor(page, '/payments')).toBeAttached({ timeout: 20_000 });
    await expect(page.getByTestId('usage-meters').locator('[data-metric="staff"]')).toContainText('1 of 5');
    await expect(disabledControls(page)).toHaveCount(0);

    await page.goto(`/dashboard/${t.orgId}/payments`);
    await expect(page.getByRole('heading', { name: 'Payments', level: 1 })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText('This module is not in your plan')).toHaveCount(0);
    await expect(page.getByRole('table', { name: 'Payments' }).or(page.getByText('No payments yet'))).toBeVisible();

    // Downgrade back to Free: scheduled for the end of the period (modules stay until then).
    await page.goto(billing);
    await page.locator('[data-plan="free"]').click();
    await page.getByRole('button', { name: 'Apply change' }).click();
    await expect(page.getByText('Change scheduled for the end of your current period.')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId('pending-change')).toContainText('Free QR');
    await expect(page.getByTestId('included-modules').locator('[data-module="pay"]')).toBeVisible();

    // The period ends: move it into the past and let the worker's billing lifecycle job run on its next check.
    // (A paid plan starts with a trial, so its end is the boundary for a trialing subscription.)
    await sql(`update subscriptions set current_period_end = now() - interval '1 minute', trial_ends_at = case when trial_ends_at is null then null else now() - interval '1 minute' end where org_id = $1`, [t.orgId]);
    await sql(`update job_leases set last_started_at = null where job = 'billing.lifecycle'`);
    await eventually(async () => (await sql(`select plan_id from subscriptions where org_id = $1`, [t.orgId]))[0]?.plan_id === 'free',
      { timeout: 120_000, interval: 1_000, message: 'the scheduled downgrade was applied' });

    expect(errors).toEqual([]);
    expect(failures).toEqual([]);
  } finally {
    await context.close();
  }

  // After the period end, in a new session: the open session's shell renders first from its stored snapshot, which
  // predates the downgrade the billing job applied in the background (a shell concern, reported separately).
  const fresh = await newContext(browser, { user: t.owner });
  const freshErrors = collectErrors(fresh.page);
  const freshFailures = collectApiFailures(fresh.page);
  try {
    const p2 = fresh.page;
    await p2.goto(billing);
    await expect(p2.getByTestId('current-plan')).toHaveText('Free QR', { timeout: 20_000 });
    const lockedPay = p2.getByTestId('locked-modules').locator('.rui-locked').filter({ has: p2.getByRole('heading', { name: 'ResutoPay' }) });
    await expect(lockedPay).toBeVisible();
    // The preview is inert and hidden from assistive technology; its only actions are real links.
    await expect(lockedPay.locator('.rui-locked-preview')).toHaveAttribute('aria-hidden', 'true');
    await expect(p2.getByTestId('included-modules').locator('[data-module="pay"]')).toHaveCount(0);
    await expect(p2.getByTestId('pending-change')).toHaveCount(0);
    await expect(p2.getByTestId('plan-matrix')).toBeVisible({ timeout: 20_000 });
    await expect(disabledControls(p2)).toHaveCount(0);
    await expect(navLinkFor(p2, '/payments')).toHaveCount(0);

    // The module page shows the upgrade prompt, not disabled controls, and makes no module API calls.
    await p2.goto(`/dashboard/${t.orgId}/payments`);
    await expect(p2.locator('.empty strong')).toHaveText('This module is not in your plan', { timeout: 20_000 });
    await expect(p2.getByRole('link', { name: 'Upgrade' })).toHaveAttribute('href', billing);
    await expect(disabledControls(p2)).toHaveCount(0);
    await p2.waitForTimeout(500);
    expect(freshErrors).toEqual([]);
    expect(freshFailures).toEqual([]);
  } finally {
    await fresh.context.close();
  }
});

// ---------------------------------------------------------------------------------------------------------------------
let payTenant: Tenant;
let cashPaymentId: string;
let testPaymentId: string;

test.describe('payments and finance', () => {
  test.beforeAll(async () => {
    const request = await playwrightRequest.newContext();
    payTenant = await apiCreateTenant(request, { planId: 'pro' });
    const menu = await apiSeedMenu(request, payTenant);
    await apiSaveFloor(request, payTenant);
    const owner = apiAs(request, payTenant.owner);
    // A live cash payment recorded by staff.
    const cashOrder = await placeQrOrder(request, payTenant, menu, 2);
    const due = await owner.get(`/o/${payTenant.orgId}/payments/due?orderId=${cashOrder.id}`);
    cashPaymentId = (await owner.post(`/o/${payTenant.orgId}/payments/collect`, { orderId: cashOrder.id, method: 'cash', amountMinor: due.dueMinor, key: unique('collect') })).id;
    // A sandbox (test) card payment through a payment link and the sandbox provider.
    const cardOrder = await placeQrOrder(request, payTenant, menu, 1);
    const link = await owner.post(`/o/${payTenant.orgId}/payments/links`, { orderId: cardOrder.id, key: unique('link') });
    const token = (link.url as string).split('/pay/')[1]!;
    expect((await request.post(`${API_URL}/v1/public/pay/${token}/start`, { data: { method: 'card' } })).ok()).toBeTruthy();
    expect((await request.post(`${API_URL}/v1/public/pay/${token}/sandbox/complete`, { data: { outcome: 'success' } })).ok()).toBeTruthy();
    const [p] = await sql(`select id from payments where org_id = $1 and is_test and status = 'succeeded'`, [payTenant.orgId]);
    testPaymentId = p.id;
    await request.dispose();
  });

  const isList = (r: Request) => r.method() === 'GET' && /\/v1\/o\/[^/]+\/payments\?/.test(r.url());

  test('payments: test/live, method and status filters run on the server; the refund sheet keeps manual refunds honest', async ({ browser }) => {
    const { context, page } = await newContext(browser, { user: payTenant.owner });
    const errors = collectErrors(page);
    const failures = collectApiFailures(page);
    try {
      await page.goto(`/dashboard/${payTenant.orgId}/payments`);
      await expect(page.getByRole('heading', { name: 'Payments', level: 1 })).toBeVisible({ timeout: 20_000 });
      const table = page.getByRole('table', { name: 'Payments' });
      await expect(table.getByRole('row')).toHaveCount(3, { timeout: 20_000 }); // header + 2 payments

      // Test only: the API is asked for mode=test and only the sandbox payment is listed.
      const testOnly = page.waitForRequest((r) => isList(r) && new URL(r.url()).searchParams.get('mode') === 'test');
      await page.getByTestId('payment-filters').getByLabel('Test or live').selectOption('test');
      await testOnly;
      await expect(page).toHaveURL(/[?&]mode=test/);
      await expect(table.getByRole('row')).toHaveCount(2);
      await expect(table.getByRole('row').nth(1)).toContainText('test');
      await expect(page.getByRole('list', { name: 'Active filters' })).toContainText('Test or live: Test only');

      // Live cash: method and mode combine; the chip removes one filter at a time.
      await page.getByTestId('payment-filters').getByLabel('Test or live').selectOption('live');
      await page.getByTestId('payment-filters').getByLabel('Method').selectOption('cash');
      await expect(page).toHaveURL(/method=cash/);
      await expect(table.getByRole('row')).toHaveCount(2);
      await expect(table.getByRole('row').nth(1)).toContainText('Cash');
      await page.getByTestId('payment-filters').getByLabel('Status').selectOption('refunded');
      await expect(page.getByText('No payments yet')).toBeVisible();
      await page.getByRole('button', { name: 'Remove filter: Status: Refunded' }).click();
      await expect(table.getByRole('row')).toHaveCount(2);
      // The filters survive a reload (they live in the URL).
      await page.reload();
      await expect(page.getByTestId('payment-filters').getByLabel('Method')).toHaveValue('cash');
      await expect(table.getByRole('row')).toHaveCount(2, { timeout: 20_000 });

      // Open the cash payment in the sheet and refund part of it by hand.
      await table.getByRole('row').nth(1).click();
      const sheet = page.getByRole('dialog', { name: 'Payment' });
      await expect(sheet).toBeVisible();
      await expect(sheet.getByTestId('payment-detail')).toBeVisible({ timeout: 20_000 });
      const timeline = sheet.getByTestId('refund-timeline');
      await expect(timeline).toContainText('Payment Succeeded');
      await expect(timeline).toContainText('No refunds on this payment.');
      await sheet.getByLabel(/^Amount/).fill('5');
      await sheet.getByLabel(/^Reason/).fill('Cold fries');
      await sheet.getByRole('button', { name: /^Refund .+/ }).click();
      // Cash: the refund needs a manual refund and says so; it is not shown as done.
      await expect(timeline).toContainText('Refund Needs manual refund', { timeout: 20_000 });
      await expect(timeline.locator('[data-refund="manual_required"]')).toContainText('Cold fries');
      await expect(sheet.getByRole('button', { name: /^Mark as completed/ })).toBeVisible();
      await sheet.getByRole('button', { name: /^Mark as completed/ }).click();
      await expect(timeline).toContainText('Refund Refunded', { timeout: 20_000 });
      await expect(sheet.getByRole('button', { name: /^Mark as completed/ })).toHaveCount(0);
      const [refund] = await sql(`select status from refunds where payment_id = $1`, [cashPaymentId]);
      expect(refund.status).toBe('succeeded');
      // The full page shows the same history.
      await sheet.getByRole('link', { name: 'Open full page' }).click();
      await expect(page).toHaveURL(new RegExp(`/payments/${cashPaymentId}$`));
      await expect(page.getByTestId('refund-timeline')).toContainText('Refund Refunded', { timeout: 20_000 });
      expect(errors).toEqual([]);
      expect(failures).toEqual([]);
    } finally {
      await context.close();
    }
    expect(testPaymentId).toBeTruthy();
  });

  test('finance: period picker and comparison, provenance on the figures, and the export centre downloads and re-downloads', async ({ browser }) => {
    const { context, page } = await newContext(browser, { user: payTenant.owner });
    const errors = collectErrors(page);
    const failures = collectApiFailures(page);
    try {
      await page.goto(`/dashboard/${payTenant.orgId}/finance`);
      await expect(page.getByRole('heading', { name: 'Finance', level: 1 })).toBeVisible({ timeout: 20_000 });
      // SectionNav (FINANCE_SECTIONS) marks the overview.
      await expect(page.getByRole('navigation', { name: 'Finance', exact: true }).getByRole('link', { name: 'Overview' })).toHaveAttribute('aria-current', 'page');
      const kpis = page.getByTestId('finance-kpis');
      // Every figure names its source; the first comparison is the previous period.
      await expect(kpis.locator('[data-stat="gross"]')).toContainText('Live', { timeout: 20_000 });
      await expect(kpis.locator('[data-stat="collected"] .rui-provenance')).toHaveText('Live');
      await expect(kpis.locator('[data-stat="operatingProfit"] .rui-provenance')).toBeVisible();
      await expect(page.getByTestId('finance-period')).toContainText('compared with');

      // Last month compared with the same period last year: both ranges go to the finance API.
      const { from, to } = lastMonth();
      const overview = (f: string, t: string) => page.waitForRequest((r) => r.method() === 'GET' && r.url().includes('/finance/overview?')
        && new URL(r.url()).searchParams.get('from') === f && new URL(r.url()).searchParams.get('to') === t);
      const current = overview(from, to);
      await page.getByLabel(/^Period/).selectOption('last_month');
      await current;
      await expect(page).toHaveURL(new RegExp(`from=${from}&to=${to}`));
      const lastYear = overview(minusYear(from), minusYear(to));
      await page.getByLabel(/^Compare with/).selectOption('last_year');
      await lastYear;
      await expect(page).toHaveURL(/compare=last_year/);
      // The period travels to the other sections.
      await page.getByRole('navigation', { name: 'Finance', exact: true }).getByRole('link', { name: 'Exports' }).click();
      await expect(page).toHaveURL(new RegExp(`/finance/exports\\?from=${from}`));

      // Export centre: create a payments export (downloads at once), then download it again from the history.
      await page.goto(`/dashboard/${payTenant.orgId}/finance/exports`);
      await expect(page.getByRole('heading', { name: 'Export centre' })).toBeVisible({ timeout: 20_000 });
      await page.locator('[data-kind="payments"]').click();
      const first = page.waitForEvent('download');
      await page.getByRole('button', { name: 'Create export' }).click();
      const file = await first;
      expect(file.suggestedFilename()).toMatch(/\.csv$/);
      await expect(page.getByRole('status').filter({ hasText: 'is ready and was downloaded' })).toBeVisible();
      const history = page.getByRole('table', { name: 'Created exports' });
      const row = history.getByRole('row').filter({ hasText: 'Payments' }).first();
      await expect(row).toContainText('Ready');
      await expect(row).toContainText('Stored with its checksum');
      const again = page.waitForEvent('download');
      await row.getByRole('button', { name: 'Download again' }).click();
      expect((await again).suggestedFilename()).toBe(file.suggestedFilename());
      const [stored] = await sql(`select count(*)::int as n from financial_exports where org_id = $1 and kind = 'payments'`, [payTenant.orgId]);
      expect(stored.n).toBe(1);
      expect(errors).toEqual([]);
      expect(failures).toEqual([]);
    } finally {
      await context.close();
    }
  });

  test('compliance: the regime stepper never claims certification (en/ar)', async ({ browser }) => {
    const request = await playwrightRequest.newContext();
    await apiAs(request, payTenant.owner).put(`/o/${payTenant.orgId}/compliance/tax-profile`, { regime: 'eta' });
    await request.dispose();
    for (const locale of ['en', 'ar'] as const) {
      const { context, page } = await newContext(browser, { user: payTenant.owner, locale });
      try {
        await page.goto(`/dashboard/${payTenant.orgId}/compliance`);
        await expect(workspaceNav(page)).toBeAttached({ timeout: 20_000 });
        const stepper = page.getByTestId('stepper-eta');
        await expect(stepper).toBeVisible({ timeout: 20_000 });
        await expect(stepper.locator('[data-step="certification"]')).toHaveAttribute('data-state', 'not_certified');
        await expect(stepper.locator('[data-step="certification"]')).toContainText(locale === 'en' ? 'Not certified' : 'غير معتمد');
        await expect(stepper.locator('[data-step="portal"]')).toHaveAttribute('data-state', 'outside');
        await expect(stepper.locator('[data-step="submission"]')).not.toHaveAttribute('data-state', 'done');
        expect(await stepper.innerText()).not.toMatch(/[٠-٩]/);
      } finally {
        await context.close();
      }
    }
  });
});
