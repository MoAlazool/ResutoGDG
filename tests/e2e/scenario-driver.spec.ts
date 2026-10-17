import {
  API_URL, apiAs, apiCreateTenant, apiInvite, apiSeedMenu, collectApiFailures, collectErrors, eventually, expect, expectNoHorizontalOverflow, newContext,
  sql, test, TINY_PNG, unique, WEB_URL,
} from './fixtures';

// Scenario 4 (delivery): a COD delivery order → the dispatch board assigns a driver
// who joined through /invite/<token> → the driver app (390 px) accepts, waits for
// the kitchen, picks up, uploads a proof photo, collects cash and delivers → the
// dispatcher sees it delivered and the order is paid.

test.describe.configure({ timeout: 180_000 });
test.use({ actionTimeout: 15_000 });

test('delivery order → dispatcher assigns an invited driver → driver delivers with proof photo and COD → order paid', async ({ browser, request }) => {
  const tenant = await apiCreateTenant(request);
  const menu = await apiSeedMenu(request, tenant);
  await sql(`update branches set latitude = 30.0444, longitude = 31.2357 where id = $1`, [tenant.branchId]);
  const { user: driverUser, token: inviteToken } = await apiInvite(request, tenant, 'driver', [tenant.branchId]);

  const driver = await newContext(browser, { user: driverUser, mobile: true });
  await driver.context.grantPermissions(['geolocation'], { origin: WEB_URL });
  await driver.context.setGeolocation({ latitude: 30.046, longitude: 31.238 });
  const dispatcher = await newContext(browser, { user: tenant.owner });
  const errors = [collectErrors(driver.page), collectErrors(dispatcher.page)];
  const failures = [collectApiFailures(driver.page), collectApiFailures(dispatcher.page)];
  const d = driver.page;
  const m = dispatcher.page;
  try {
    await test.step('the driver accepts the invitation and goes online', async () => {
      await d.goto(`/invite/${inviteToken}`);
      await d.getByRole('button', { name: 'Accept invitation' }).click();
      await expect(d).toHaveURL(/\/driver$/);
      await expect(d.getByRole('heading', { name: 'Your deliveries' })).toBeVisible();
      await d.getByRole('group', { name: 'Availability' }).getByRole('button', { name: 'Online' }).click();
      await expect(d.getByRole('group', { name: 'Availability' }).getByRole('button', { name: 'Online' })).toHaveAttribute('aria-pressed', 'true');
      await expectNoHorizontalOverflow(d);
    });

    // A customer orders delivery from the website, cash on delivery.
    const lines = [{ productId: menu.burger, quantity: 1, modifiers: [{ groupId: menu.sizeGroup, optionId: menu.regular }] }, { productId: menu.fries, quantity: 1, modifiers: [] }];
    const res = await request.post(`${API_URL}/v1/public/order/${tenant.slug}/orders`, {
      headers: { 'Idempotency-Key': unique('web') },
      data: {
        branchId: tenant.branchId, fulfillment: 'delivery', lines, payment: 'cod',
        customer: { name: 'Salma Hassan', phone: '+201005550123' },
        deliveryAddress: { line1: '5 Tahrir Square', area: 'Downtown', city: 'Cairo', latitude: 30.0450, longitude: 31.2400, notes: 'Floor 3' },
      },
    });
    expect(res.status(), await res.text()).toBe(201);
    const placed = await res.json();
    const orderId: string = placed.order.id;
    const [order] = await sql<{ number: string; total_minor: string; payment_status: string }>(`select number, total_minor, payment_status from orders where id = $1`, [orderId]);
    expect(order!.payment_status).toBe('unpaid');
    const job = await eventually(async () => (await sql(`select id, status, cod_amount_minor from delivery_jobs where order_id = $1`, [orderId]))[0], { message: 'delivery job created by the worker' });
    expect(job).toMatchObject({ status: 'unassigned', cod_amount_minor: order!.total_minor });

    await test.step('the dispatcher assigns the driver on the board', async () => {
      await m.goto(`/dashboard/${tenant.orgId}/delivery`);
      const waiting = m.locator('section.card').filter({ has: m.getByRole('heading', { name: 'Waiting for a driver' }) });
      const row = waiting.locator('div.card').filter({ has: m.getByRole('button', { name: `Order #${order!.number}`, exact: true }) });
      await expect(row).toBeVisible({ timeout: 15_000 });
      await row.getByRole('combobox', { name: 'Choose driver' }).selectOption({ index: 1 });
      await row.getByRole('button', { name: 'Assign', exact: true }).click();
      const active = m.locator('section.card').filter({ has: m.getByRole('heading', { name: 'Active', exact: true }) });
      await expect(active.getByRole('button', { name: `Order #${order!.number}` })).toBeVisible();
    });

    await test.step('the driver accepts; pickup waits for the kitchen', async () => {
      await d.reload();
      const card = d.locator('a', { hasText: `Order #${order!.number}` });
      await expect(card).toBeVisible({ timeout: 15_000 });
      await card.click();
      await expect(d).toHaveURL(/\/driver\/jobs\//);
      await d.getByRole('button', { name: 'Accept' }).click();
      await expect(d.getByText('Waiting for the kitchen to mark this order ready before pickup.')).toBeVisible();
      await expect(d.getByRole('button', { name: 'Confirm pickup' })).toBeDisabled();
      await expectNoHorizontalOverflow(d);
    });

    await test.step('the kitchen readies the order on the KDS', async () => {
      await m.goto(`/kitchen/${tenant.orgId}`);
      const ticket = m.locator('article').filter({ hasText: 'Smash burger' });
      await ticket.getByRole('button', { name: 'Start preparing' }).click();
      await m.locator('article').filter({ hasText: 'Smash burger' }).getByRole('button', { name: 'Ready' }).click();
      await expect.poll(async () => (await sql(`select status from orders where id = $1`, [orderId]))[0].status).toBe('ready');
    });

    await test.step('the driver picks up, starts the delivery, uploads a proof photo and collects the cash', async () => {
      await d.reload();
      await d.getByRole('button', { name: 'Confirm pickup' }).click();
      await expect(d.getByText('Picked up').first()).toBeVisible();
      await d.getByRole('button', { name: 'Start delivery' }).click();
      await expect(d.getByText('On the way').first()).toBeVisible();
      await d.getByRole('button', { name: 'Delivered' }).click();
      const upload = d.waitForResponse((r) => r.url().includes('/proof-photo'));
      await d.locator('#proof-photo').setInputFiles({ name: 'proof.png', mimeType: 'image/png', buffer: TINY_PNG });
      expect((await upload).status()).toBe(201);
      await expect(d.getByRole('img', { name: 'Photo attached' })).toBeVisible();
      await expect(d.getByLabel('Cash collected')).toHaveValue((Number(order!.total_minor) / 100).toFixed(2));
      await d.getByLabel('Received by').fill('Salma');
      await d.getByRole('button', { name: 'Confirm delivery' }).click();
      await expect(d).toHaveURL(/\/driver$/);
      await expectNoHorizontalOverflow(d);
    });

    await test.step('the dispatcher sees it delivered with the proof, and the order is paid', async () => {
      await m.goto(`/dashboard/${tenant.orgId}/delivery`);
      const recent = m.locator('section.card').filter({ has: m.getByRole('heading', { name: 'Closed in the last 12 hours' }) });
      await expect(recent.getByRole('button', { name: `Order #${order!.number}` })).toBeVisible();
      await expect(recent).toContainText('Delivered');
      await recent.getByRole('button', { name: `Order #${order!.number}` }).click();
      const modal = m.getByRole('dialog');
      await expect(modal).toContainText('Proof of delivery');
      await expect(modal.getByRole('img', { name: 'Proof of delivery' })).toBeVisible();
      const [o] = await sql(`select status, payment_status, paid_minor, total_minor from orders where id = $1`, [orderId]);
      expect(o).toMatchObject({ status: 'delivered', payment_status: 'paid' });
      expect(o.paid_minor).toBe(o.total_minor);
      const [j] = await sql(`select status, cash_status, cash_collected_minor from delivery_jobs where id = $1`, [job.id]);
      expect(j).toMatchObject({ status: 'delivered', cash_status: 'collected', cash_collected_minor: order!.total_minor });
      const me = await apiAs(request, driverUser).get(`/o/${tenant.orgId}/driver/me`);
      expect(me.cashOnHandMinor).toBe(Number(order!.total_minor));
    });

    for (const e of errors) expect(e).toEqual([]);
    for (const f of failures) expect(f).toEqual([]);
  } finally {
    await Promise.all([driver.context.close(), dispatcher.context.close()]);
  }
});

// DEFECT: H-6 the KDS "Out for delivery" button on a ready delivery ticket transitions the order straight to `delivered` (COD unpaid, driver job still `accepted`).
test.fail('the KDS hand-over of a driver-dispatched delivery ticket does not mark the order delivered behind the driver', async ({ browser, request }) => {
  const tenant = await apiCreateTenant(request);
  const menu = await apiSeedMenu(request, tenant);
  const { user: driverUser, token } = await apiInvite(request, tenant, 'driver', [tenant.branchId]);
  const driverApi = apiAs(request, driverUser);
  await driverApi.post('/invitations/accept', { token });
  const res = await request.post(`${API_URL}/v1/public/order/${tenant.slug}/orders`, {
    headers: { 'Idempotency-Key': unique('web') },
    data: { branchId: tenant.branchId, fulfillment: 'delivery', lines: [{ productId: menu.fries, quantity: 2, modifiers: [] }], payment: 'cod',
      customer: { name: 'Omar', phone: '+201005550456' }, deliveryAddress: { line1: '12 Nile Corniche', city: 'Cairo' } },
  });
  expect(res.status(), await res.text()).toBe(201);
  const orderId: string = (await res.json()).order.id;
  const job = await eventually(async () => (await sql(`select id from delivery_jobs where order_id = $1`, [orderId]))[0], { message: 'delivery job' });
  const [drv] = await sql(`select id from drivers where org_id = $1 and user_id = $2`, [tenant.orgId, driverUser.userId]);
  await apiAs(request, tenant.owner).post(`/o/${tenant.orgId}/delivery/jobs/${job.id}/assign`, { driverId: drv.id }, { 'Idempotency-Key': unique('assign') });
  await driverApi.post(`/o/${tenant.orgId}/driver/jobs/${job.id}/accept`, {});

  const staff = await newContext(browser, { user: tenant.owner });
  try {
    const k = staff.page;
    await k.goto(`/kitchen/${tenant.orgId}`);
    const ticket = () => k.locator('article').filter({ hasText: 'Fries' });
    await ticket().getByRole('button', { name: 'Start preparing' }).click();
    await ticket().getByRole('button', { name: 'Ready' }).click();
    await expect.poll(async () => (await sql(`select status from orders where id = $1`, [orderId]))[0].status).toBe('ready');
    // The pass hands the bag to the driver.
    await ticket().getByRole('button', { name: 'Out for delivery' }).click();
    await expect(ticket()).toHaveCount(0);
    const [o] = await sql(`select status, payment_status from orders where id = $1`, [orderId]);
    expect(o.status, 'the order is only delivered when the driver delivers it').not.toBe('delivered');
    const pickup = await driverApi.raw('post', `/o/${tenant.orgId}/driver/jobs/${job.id}/pickup`, {});
    expect(pickup.status(), await pickup.text()).toBe(200);
  } finally {
    await staff.context.close();
  }
});
