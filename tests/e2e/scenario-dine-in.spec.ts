import {
  apiAs, apiCreateTenant, apiQrSheet, apiSaveFloor, apiSeedMenu, collectApiFailures, collectErrors, expect, expectNoHorizontalOverflow, newContext,
  paySandboxInBrowser, qrPath, sql, test, type Tenant,
} from './fixtures';

// Scenario 2 (dine-in) in real browsers against the real API: QR table ordering on
// a phone, the kitchen display, an equal split paid by two guests through the
// sandbox provider, and closing the visit.

test.describe.configure({ timeout: 180_000 });
test.use({ actionTimeout: 15_000 });

async function setup(request: import('@playwright/test').APIRequestContext) {
  const tenant = await apiCreateTenant(request);
  const menu = await apiSeedMenu(request, tenant);
  await apiSaveFloor(request, tenant);
  const qr = (await apiQrSheet(request, tenant)).find((x) => x.label === 'T1')!;
  return { tenant, menu, qr: qrPath(qr.url), tableId: qr.tableId };
}

const visitOf = async (t: Tenant, tableId: string) =>
  (await sql<{ id: string; status: string }>(`select id, status from visits where org_id = $1 and table_id = $2 order by opened_at desc limit 1`, [t.orgId, tableId]))[0];

test('QR order with a modifier → KDS ready → served → equal split paid by two guests → visit closed', async ({ browser, request }) => {
  const { tenant, qr, tableId } = await setup(request);
  const guestA = await newContext(browser, { mobile: true });
  const guestB = await newContext(browser, { mobile: true });
  const staff = await newContext(browser, { user: tenant.owner });
  const errors = [collectErrors(guestA.page), collectErrors(guestB.page), collectErrors(staff.page, [/Failed to load resource/])];
  const failures = [collectApiFailures(guestA.page), collectApiFailures(guestB.page)];
  try {
    await test.step('guest A scans the table QR on a phone and orders a Large burger', async () => {
      const g = guestA.page;
      await g.goto(qr);
      await expect(g.locator('.g-brand')).toContainText('Table T1');
      await expectNoHorizontalOverflow(g);
      const burger = g.locator('.g-dish').filter({ hasText: 'Smash burger' });
      await burger.getByRole('button', { name: /Choose/ }).click();
      const sheet = g.getByRole('dialog');
      await expect(sheet.getByRole('button', { name: /^Add to order/ })).toBeDisabled(); // Size is required
      await sheet.locator('.g-option').filter({ hasText: 'Large' }).click();
      await expect(sheet.getByRole('button', { name: /^Add to order/ })).toContainText('215');
      await sheet.getByRole('button', { name: /^Add to order/ }).click();
      await expect(g.getByRole('status')).toContainText('Added to your order');
      await g.getByRole('button', { name: 'View cart' }).click();
      const cart = g.getByRole('dialog', { name: 'Your order' });
      await expect(cart.locator('.g-grand')).toContainText('215');
      await cart.getByRole('button', { name: 'Send to kitchen' }).click();
      await expect(g.getByRole('dialog', { name: /^Order #/ })).toBeVisible();
      await expect(g.locator('.g-timeline')).toBeVisible();
    });

    const [order] = await sql<{ id: string; number: string; total_minor: string }>(`select id, number, total_minor from orders where org_id = $1`, [tenant.orgId]);
    expect(Number(order!.total_minor)).toBe(21500);

    await test.step('the KDS shows the ticket with its modifier and bumps it to ready, then served', async () => {
      const k = staff.page;
      await k.goto(`/kitchen/${tenant.orgId}`);
      const ticket = k.locator('.kds-col').filter({ hasText: 'New orders' }).locator('article').filter({ hasText: 'Smash burger' });
      await expect(ticket).toBeVisible({ timeout: 15_000 });
      await expect(ticket).toContainText('Large');
      await expect(ticket).toContainText('Table T1');
      await ticket.getByRole('button', { name: 'Start preparing' }).click();
      const preparing = k.locator('.kds-col').filter({ hasText: 'Preparing' }).locator('article').filter({ hasText: 'Smash burger' });
      await preparing.getByRole('button', { name: 'Ready' }).click();
      const ready = k.locator('.kds-col').filter({ hasText: 'Ready to serve' }).locator('article').filter({ hasText: 'Smash burger' });
      await expect(ready).toBeVisible();
      await expect.poll(async () => (await sql(`select status from orders where id = $1`, [order!.id]))[0].status).toBe('ready');
      await ready.getByRole('button', { name: 'Served' }).click();
      await expect(ready).toHaveCount(0);
      await expect.poll(async () => (await sql(`select status from orders where id = $1`, [order!.id]))[0].status).toBe('served');
    });

    await test.step('guest A sees the order served and the bill due', async () => {
      const g = guestA.page;
      const tracking = g.getByRole('dialog', { name: /^Order #/ });
      await expect(tracking.locator('[aria-current="step"]')).toContainText('Served', { timeout: 10_000 });
      // Closing the tracking sheet does not stick while it polls (H-4), so reload instead.
      await g.reload();
      await expect(g.getByRole('button', { name: /^Order #1 .*Served$/ })).toBeVisible();
      await g.getByRole('button', { name: /^View bill/ }).click();
      await expect(g.getByRole('dialog', { name: 'Bill · Table T1' })).toContainText('215');
    });

    await test.step('guest A splits the bill equally between two people', async () => {
      const g = guestA.page;
      await g.goto(`${qr}/pay`);
      await expect(g.locator('.pay-totals .due')).toContainText('215');
      await g.getByRole('link', { name: 'Split the bill' }).click();
      await expect(g).toHaveURL(/\/pay\/split$/);
      await expect(g.locator('.pay-lines li')).toHaveCount(2);
      await expect(g.locator('.pay-lines li').first()).toContainText('107.50');
      await g.getByRole('button', { name: 'Create split' }).click();
      await expect(g).toHaveURL(new RegExp(`${qr}/pay$`));
      await expect(g.getByText('This bill is split')).toBeVisible();
      await expect(g.locator('.pay-share')).toHaveCount(2);
      await expectNoHorizontalOverflow(g);
    });

    await test.step('each guest pays one share with the sandbox provider', async () => {
      // Guest B joins the same table session from the QR, then opens the bill.
      const b = guestB.page;
      await b.goto(qr);
      await expect(b.locator('.g-brand')).toContainText('Table T1');
      await b.goto(`${qr}/pay`);
      await expect(b.locator('.pay-share')).toHaveCount(2);

      const a = guestA.page;
      await a.locator('.pay-share').nth(0).getByRole('link', { name: 'Pay my share' }).click();
      await expect(a).toHaveURL(/\/s\//);
      await expect(a.locator('.pay-amount')).toContainText('107.50');
      await a.getByRole('button', { name: 'Pay my share' }).click();
      await paySandboxInBrowser(a);
      await expect(a.getByText('Payment successful')).toBeVisible({ timeout: 20_000 });

      await b.reload();
      await expect(b.locator('.pay-share').nth(0)).toContainText('Paid');
      await b.locator('.pay-share').nth(1).getByRole('link', { name: 'Pay my share' }).click();
      await expect(b.locator('.pay-amount')).toContainText('107.50');
      await b.getByRole('button', { name: 'Pay my share' }).click();
      await paySandboxInBrowser(b);
      await expect(b.getByText('Payment successful')).toBeVisible({ timeout: 20_000 });
    });

    await test.step('the bill shows settled', async () => {
      const a = guestA.page;
      await a.goto(`${qr}/pay`);
      await expect(a.getByText('All shares are paid.')).toBeVisible({ timeout: 15_000 });
      await expect(a.locator('.pay-totals .due')).toContainText('0');
      const [o] = await sql(`select payment_status, paid_minor from orders where id = $1`, [order!.id]);
      expect(o).toMatchObject({ payment_status: 'paid', paid_minor: '21500' });
    });

    await test.step('staff closes the visit from the live floor without forcing', async () => {
      const s = staff.page;
      await s.goto(`/dashboard/${tenant.orgId}/floor?tab=live`);
      await s.getByRole('button', { name: /^T1,/ }).click();
      await expect(s.locator('.live-panel .badge').first()).toHaveText('Paid');
      await s.getByRole('button', { name: 'Close table' }).click();
      await expect(s.getByText('T1 closed.')).toBeVisible();
      await expect(s.locator('dialog.rui-confirm[open]')).toHaveCount(0);
      expect((await visitOf(tenant, tableId))!.status).toBe('closed');
    });

    for (const e of errors) expect(e).toEqual([]);
    for (const f of failures) expect(f).toEqual([]);
  } finally {
    await Promise.all([guestA.context.close(), guestB.context.close(), staff.context.close()]);
  }
});

// Regression for H-3 (fixed): after staff close the visit, reloading /t/<qr> must tell the guest the session ended, not silently open a new visit.
test('after staff close the visit, reloading the guest page shows the session ended', async ({ browser, request }) => {
  const { tenant, qr, tableId } = await setup(request);
  const guest = await newContext(browser, { mobile: true });
  try {
    await guest.page.goto(qr);
    await expect(guest.page.locator('.g-brand')).toContainText('Table T1');
    const first = (await visitOf(tenant, tableId))!;
    await apiAs(request, tenant.owner).post(`/o/${tenant.orgId}/visits/${first.id}/close`, {});
    await guest.page.reload();
    await expect(guest.page.getByRole('heading', { name: 'This table session has ended' })).toBeVisible();
    expect((await sql(`select count(*)::int as n from visits where table_id = $1`, [tableId]))[0].n).toBe(1);
  } finally {
    await guest.context.close();
  }
});

// Regression for H-4 (fixed): the order-tracking sheet polls at its cadence (no tight refresh loop) and closing it sticks.
test('the order-tracking sheet polls at the 2.5 s cadence and stays closed when dismissed', async ({ browser, request }) => {
  const { qr } = await setup(request);
  const guest = await newContext(browser, { mobile: true });
  try {
    const g = guest.page;
    await g.goto(qr);
    await g.locator('.g-dish').filter({ hasText: 'Fries' }).getByRole('button', { name: /Add/ }).click();
    await g.getByRole('button', { name: 'View cart' }).click();
    await g.getByRole('dialog', { name: 'Your order' }).getByRole('button', { name: 'Send to kitchen' }).click();
    const tracking = g.getByRole('dialog', { name: /^Order #/ });
    await expect(tracking).toBeVisible();
    let polls = 0;
    g.on('request', (r) => { if (/\/v1\/public\/visits\/current\/orders\//.test(r.url())) polls++; });
    await g.waitForTimeout(5000);
    expect(polls, 'order-status requests in 5 s (2.5 s poll → ≤ 3)').toBeLessThanOrEqual(3);
    await tracking.getByRole('button', { name: 'Back to the menu' }).click();
    await g.waitForTimeout(3000);
    await expect(tracking).toHaveCount(0);
  } finally {
    await guest.context.close();
  }
});
