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
      await expect(g.getByRole('main')).toContainText('Table T1');
      await expectNoHorizontalOverflow(g);
      await g.getByRole('button', { name: 'Choose Smash burger' }).click();
      const sheet = g.getByRole('dialog', { name: 'Smash burger' });
      await expect(sheet.getByRole('button', { name: /^Add to order/ })).toBeDisabled(); // Size is required
      await sheet.getByRole('radio', { name: /^Large/ }).check();
      await expect(sheet.getByRole('button', { name: /^Add to order/ })).toContainText('215');
      await sheet.getByRole('button', { name: /^Add to order/ }).click();
      await expect(g.getByRole('status').filter({ hasText: 'Added to your order' })).toBeVisible();
      await g.getByRole('button', { name: /^View cart/ }).click();
      const cart = g.getByRole('dialog', { name: 'Your order' });
      await expect(cart).toContainText('Large');
      await expect(cart).toContainText(/Total\s*EGP\s*215\.00/);
      await cart.getByRole('button', { name: 'Confirm order' }).click();
      // The live status page replaces the menu: order #1 with its numbered steps.
      await expect(g.getByRole('heading', { level: 1, name: 'Your order is on its way.' })).toBeVisible();
      await expect(g.getByRole('main').getByRole('listitem').first()).toContainText('Order received');
    });

    const [order] = await sql<{ id: string; number: string; total_minor: string }>(`select id, number, total_minor from orders where org_id = $1`, [tenant.orgId]);
    expect(Number(order!.total_minor)).toBe(21500);

    await test.step('the KDS shows the ticket with its modifier and bumps it to ready, then served', async () => {
      const k = staff.page;
      await k.goto(`/kitchen/${tenant.orgId}`);
      const ticket = k.getByRole('region', { name: 'New orders' }).locator('article').filter({ hasText: 'Smash burger' });
      await expect(ticket).toBeVisible({ timeout: 15_000 });
      await expect(ticket).toContainText('Large');
      await expect(ticket).toContainText('Table T1');
      await ticket.getByRole('button', { name: 'Start preparing' }).click();
      const preparing = k.getByRole('region', { name: 'Preparing' }).locator('article').filter({ hasText: 'Smash burger' });
      await preparing.getByRole('button', { name: 'Mark ready' }).click();
      const ready = k.getByRole('region', { name: 'Ready to serve' }).locator('article').filter({ hasText: 'Smash burger' });
      await expect(ready).toBeVisible();
      await expect.poll(async () => (await sql(`select status from orders where id = $1`, [order!.id]))[0].status).toBe('ready');
      await ready.getByRole('button', { name: 'Mark served' }).click();
      await expect(ready).toHaveCount(0);
      await expect.poll(async () => (await sql(`select status from orders where id = $1`, [order!.id]))[0].status).toBe('served');
    });

    await test.step('guest A sees the order served and the bill due', async () => {
      const g = guestA.page;
      // The status page polls: the current step moves to "Served" without a reload.
      await expect(g.getByRole('main').locator('[aria-current="step"]')).toContainText('Served', { timeout: 15_000 });
      // A reload returns to the menu; "View order" brings the status back from the server.
      await g.reload();
      await g.getByRole('button', { name: 'View order' }).click();
      await expect(g.getByRole('main').locator('[aria-current="step"]')).toContainText('Served');
      await g.getByRole('main').getByRole('button', { name: 'View bill' }).click();
      const bill = g.getByRole('dialog', { name: 'Split & pay' });
      await expect(bill).toContainText(/Remaining\s*EGP\s*215\.00/);
    });

    await test.step('guest A splits the bill equally between two people', async () => {
      const g = guestA.page;
      await g.goto(`${qr}/pay`);
      await expect(g.getByRole('heading', { level: 1, name: 'Split & pay' })).toBeVisible();
      await expect(g.getByRole('main')).toContainText(/Remaining\s*EGP\s*215\.00/);
      await g.getByRole('button', { name: 'Split bill' }).click();
      await g.getByRole('dialog', { name: 'Split bill' }).getByRole('button', { name: 'Split equally' }).click();
      const equal = g.getByRole('dialog', { name: 'Split equally' });
      await equal.getByRole('spinbutton', { name: 'People' }).fill('2');
      await expect(equal.getByText('EGP 107.50')).toHaveCount(2);
      await equal.getByRole('button', { name: 'Create payment links' }).click();
      await expect(g.getByRole('link', { name: 'Pay this share' })).toHaveCount(2);
      await expect(g.getByRole('main')).toContainText('Share 1');
      await expect(g.getByRole('main')).toContainText('Share 2');
      await expectNoHorizontalOverflow(g);
    });

    await test.step('each guest pays one share with the sandbox provider', async () => {
      // Guest B joins the same table session from the QR, then opens the bill.
      // "Table T1" is server-rendered, so wait for the join itself before leaving the page (a slower browser would
      // otherwise abort it and open the bill without a session).
      const b = guestB.page;
      const joined = b.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith('/session'));
      await b.goto(qr);
      await expect(b.getByRole('main')).toContainText('Table T1');
      expect((await joined).ok()).toBe(true);
      await b.goto(`${qr}/pay`);
      await expect(b.getByRole('link', { name: 'Pay this share' })).toHaveCount(2);

      const a = guestA.page;
      await a.getByRole('link', { name: 'Pay this share' }).first().click();
      await expect(a).toHaveURL(/\/s\//);
      await expect(a.getByRole('main')).toContainText(/Your share\s*EGP\s*107\.50/);
      await a.getByRole('button', { name: 'Continue to payment' }).click();
      await paySandboxInBrowser(a);
      await expect(a.getByText('Payment successful')).toBeVisible({ timeout: 20_000 });

      await b.reload();
      await expect(b.getByRole('main')).toContainText(/Share 1\s*EGP\s*107\.50 · Paid/);
      await expect(b.getByRole('link', { name: 'Pay this share' })).toHaveCount(1);
      await b.getByRole('link', { name: 'Pay this share' }).click();
      await expect(b.getByRole('main')).toContainText(/Your share\s*EGP\s*107\.50/);
      await b.getByRole('button', { name: 'Continue to payment' }).click();
      await paySandboxInBrowser(b);
      await expect(b.getByText('Payment successful')).toBeVisible({ timeout: 20_000 });
    });

    await test.step('the bill shows settled', async () => {
      const a = guestA.page;
      await a.goto(`${qr}/pay`);
      await expect(a.getByText('Your current balance is settled.')).toBeVisible({ timeout: 15_000 });
      await expect(a.getByRole('main')).toContainText(/Remaining\s*EGP\s*0\.00/);
      const [o] = await sql(`select payment_status, paid_minor from orders where id = $1`, [order!.id]);
      expect(o).toMatchObject({ payment_status: 'paid', paid_minor: '21500' });
    });

    await test.step('staff closes the visit from the live floor without forcing', async () => {
      const s = staff.page;
      await s.goto(`/dashboard/${tenant.orgId}/floor?tab=live`);
      await s.getByRole('button', { name: /^T1,/ }).click();
      const detail = s.getByRole('region', { name: 'T1', exact: true });
      await expect(detail.getByText('Ready to close', { exact: true })).toBeVisible();
      await detail.getByRole('button', { name: 'Close visit' }).click();
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
    await expect(guest.page.getByRole('main')).toContainText('Table T1');
    await expect.poll(async () => (await visitOf(tenant, tableId))?.status).toBe('open');
    const first = (await visitOf(tenant, tableId))!;
    await apiAs(request, tenant.owner).post(`/o/${tenant.orgId}/visits/${first.id}/close`, {});
    await guest.page.reload();
    await expect(guest.page.getByText('This table session has ended')).toBeVisible();
    expect((await sql(`select count(*)::int as n from visits where table_id = $1`, [tableId]))[0].n).toBe(1);
  } finally {
    await guest.context.close();
  }
});

// Regression for H-4 (fixed): the order status polls at its cadence (no tight refresh loop) and leaving it sticks.
// The cadence is the guest poll of PCL-18 (components/guest/schedule.ts): one request every 5 s while visible.
test('the order status polls at the 5 s guest cadence and stays closed when the guest goes back to the menu', async ({ browser, request }) => {
  const { qr } = await setup(request);
  const guest = await newContext(browser, { mobile: true });
  try {
    const g = guest.page;
    await g.goto(qr);
    await g.getByRole('button', { name: 'Add Fries' }).click();
    await g.getByRole('button', { name: /^View cart/ }).click();
    await g.getByRole('dialog', { name: 'Your order' }).getByRole('button', { name: 'Confirm order' }).click();
    const tracking = g.getByRole('heading', { level: 1, name: 'Your order is on its way.' });
    await expect(tracking).toBeVisible();
    let polls = 0;
    g.on('request', (r) => { if (/\/v1\/public\/visits\/current(\?|$)/.test(r.url())) polls++; });
    await g.waitForTimeout(10_000);
    expect(polls, 'visit polls in 10 s (5 s cadence → ≤ 3)').toBeLessThanOrEqual(3);
    expect(polls, 'the status keeps polling').toBeGreaterThanOrEqual(1);
    await g.getByRole('button', { name: 'Browse menu' }).click();
    await g.waitForTimeout(6000); // longer than one poll
    await expect(tracking).toHaveCount(0);
    await expect(g.getByRole('button', { name: 'View order' })).toBeVisible();
  } finally {
    await guest.context.close();
  }
});
