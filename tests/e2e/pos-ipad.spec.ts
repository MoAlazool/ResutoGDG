import { randomUUID } from 'node:crypto';
import { request as playwrightRequest, type APIRequestContext, type APIResponse, type Page } from '@playwright/test';
import {
  API_URL, apiAddMember, apiAs, apiCreateTenant, apiSaveFloor, apiSeedMenu, collectApiFailures, collectErrors, expect, newContext, sql, test,
  type MenuSeed, type Tenant, type User,
} from './fixtures';

// 21-POSAPI cross-platform acceptance test in a real browser (docs/plans/RESUTO_2_1_PLAN.md §8; contract 0.2.0 in
// docs/api/IPAD_COMPATIBILITY.md). The iPad is simulated: a scripted HTTP client (Playwright's request context, no
// browser) that pairs with a manager-created code, holds its rpos_ credential, optionally sends a staff session in
// X-Resuto-Staff-Authorization, syncs menu/floor/orders, follows the per-branch event feed (dedupe by seq, resume from
// the last seq) and submits with a clientOrderId and the totals it showed. The staff side is the built web app: the
// Orders board, the Overview "Right now" and the full-screen kitchen display, where kitchen staff bump the ticket.
// Then reconnect and resync, offline replay with a price conflict, payment, inventory/analytics reconciliation and
// permissions. One isolated restaurant per run of this file; the tests run in order and share it.
//
// Chromium only: the staff steps drive pages. The device itself is browser-independent (request context only).

test.describe.configure({ mode: 'serial', timeout: 120_000 });

const STAFF = 'X-Resuto-Staff-Authorization';

interface PosEvent { seq: number; kind: string; entityType: string; entityId: string; payload: Record<string, any>; at: string }
interface PosEventPage { epoch: string; head: number; events: PosEvent[]; nextAfter: number; hasMore: boolean }
interface PosOrder { id: string; clientOrderId: string | null; number: string; status: string; paymentStatus: string; totalMinor: number; dueMinor: number;
  paidMinor: number; version: number; open: boolean; tableLabel: string | null; channel: string; lines: Array<{ id: string; name: string; quantity: number; lineTotalMinor: number }> }
interface Submitted { clientOrderId: string; order: PosOrder; repriced: unknown }

/** Pairing (POST /v1/pos/pair) is limited to 30 per client address per 10 minutes; each simulated iPad has its own address (RFC 2544 range, as in fixtures.ts). */
let ipSeq = 0;
const deviceIp = () => { const i = ++ipSeq + (process.pid % 200) * 256; return `198.19.${(i >> 8) & 255}.${(i & 255) || 1}`; };

async function body<T = any>(res: APIResponse, status: number): Promise<T> {
  const text = await res.text();
  expect(res.status(), `${res.url()} → ${res.status()} ${text}`).toBe(status);
  return text ? JSON.parse(text) : (undefined as T);
}

/**
 * The simulated iPad: an rpos_ device credential bound to one branch and acting role, an optional staff session, and
 * the client state the app persists (feed epoch and last applied seq, the order cursor, the projection of orders).
 */
class SimulatedIpad {
  epoch: string | null = null;
  lastSeq = 0;
  readonly log: PosEvent[] = [];
  ordersCursor: string | null = null;
  constructor(private api: APIRequestContext, readonly token: string, readonly id: string, readonly branchId: string, private staff: User | null = null) {}

  /** The same device with (or without) an employee signed in on it. */
  as(staff: User | null) { return new SimulatedIpad(this.api, this.token, this.id, this.branchId, staff); }

  private headers(extra: Record<string, string> = {}) {
    return { Authorization: `Bearer ${this.token}`, ...(this.staff ? { [STAFF]: `Bearer ${this.staff.token}` } : {}), ...extra };
  }
  get(path: string, opts: { timeout?: number } = {}) { return this.api.get(`${API_URL}/v1/pos${path}`, { headers: this.headers(), timeout: opts.timeout }); }
  post(path: string, data: unknown = {}) { return this.api.post(`${API_URL}/v1/pos${path}`, { headers: this.headers(), data }); }

  /**
   * Applies a page of events as the app does: dedupe by seq (at-least-once delivery), and every new event must be
   * exactly the last applied seq + 1 (a client-detected gap means resync). Returns the events that were new.
   */
  apply(page: PosEventPage): PosEvent[] {
    if (this.epoch !== null) expect(page.epoch, 'the feed epoch stays the same while resuming').toBe(this.epoch);
    this.epoch = page.epoch;
    const fresh: PosEvent[] = [];
    for (const e of page.events) {
      if (e.seq <= this.lastSeq) continue; // already applied
      expect(e.seq, `event ${e.kind} follows seq ${this.lastSeq}`).toBe(this.lastSeq + 1);
      this.lastSeq = e.seq;
      this.log.push(e);
      fresh.push(e);
    }
    return fresh;
  }

  /** One read of the feed from the last applied seq (wait > 0 long-polls). */
  async page(after = this.lastSeq, wait = 0): Promise<PosEventPage> {
    const q = `after=${after}${this.epoch ? `&epoch=${this.epoch}` : ''}${wait ? `&wait=${wait}` : ''}`;
    return body<PosEventPage>(await this.get(`/events?${q}`, { timeout: (wait + 15) * 1000 }), 200);
  }

  /** Reads the feed to its head, applying every page; returns the new events. */
  async follow(): Promise<PosEvent[]> {
    const fresh: PosEvent[] = [];
    for (let i = 0; i < 20; i++) {
      const p = await this.page();
      fresh.push(...this.apply(p));
      if (!p.hasMore) return fresh;
    }
    throw new Error('the feed did not drain');
  }
}

async function pair(api: APIRequestContext, t: Tenant, manager: User, branchId: string, actingRole: 'waiter' | 'cashier' | 'kitchen', name: string) {
  const code = await apiAs(api, manager).post(`/o/${t.orgId}/pos/pairings`, { branchId, actingRole, name });
  expect(code.code).toMatch(/^[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}$/);
  const paired = await body(await api.post(`${API_URL}/v1/pos/pair`, {
    headers: { 'X-Forwarded-For': deviceIp() }, data: { code: code.code, platform: 'ipados', appVersion: '0.2.0-e2e', model: 'iPad13,1' },
  }), 201);
  expect(paired.token).toMatch(/^rpos_[A-Za-z0-9_-]{43}$/);
  expect(paired).toMatchObject({ orgId: t.orgId, contractVersion: '0.2.0', device: { branchId, actingRole, name, status: 'active' } });
  return new SimulatedIpad(api, paired.token, paired.device.id, branchId);
}

// ---------------------------------------------------------------------------------------------------------------------
let api: APIRequestContext;
let tenant: Tenant;
let menu: MenuSeed;
let kunafa: string;         // a tracked-stock product (5 at the branch)
let beef: string;           // an inventory item: the burger's recipe uses 150 g
let t1: string;             // table T1
let manager: User;
let waiterUser: User;
let kitchenUser: User;
let ipad: SimulatedIpad;    // waiter device, main branch (no staff session)
let kdsIpad: SimulatedIpad; // kitchen device, main branch
let other: Tenant;          // another restaurant

// What the steps hand on to each other.
let first: Submitted;       // the dine-in order of step 1
let firstBody: Record<string, unknown>;
let second: Submitted;      // the order replayed after the price change (step 5)
let paymentId: string;

test.beforeAll(async () => {
  api = await playwrightRequest.newContext();
  tenant = await apiCreateTenant(api, { planId: 'pro' });
  menu = await apiSeedMenu(api, tenant);
  const layout = await apiSaveFloor(api, tenant);
  t1 = layout.tables.find((x: { label: string }) => x.label === 'T1').id;
  const owner = apiAs(api, tenant.owner);
  const m = `/o/${tenant.orgId}/menu`;
  kunafa = (await owner.post(`${m}/products`, { categoryId: menu.categoryId, name: 'Kunafa', nameAr: 'كنافة', priceMinor: 6000, station: 'Grill', trackStock: true })).id;
  await owner.put(`${m}/products/${kunafa}/branches/${tenant.branchId}`, { stockQty: 5 });
  const inv = `/o/${tenant.orgId}/inventory`;
  beef = (await owner.post(`${inv}/items`, { name: 'Beef', unit: 'kg', costPerUnitMinor: 40000 })).id;
  await owner.put(`${inv}/recipes/${menu.burger}`, { components: [{ itemId: beef, quantity: 150, unit: 'g' }] });
  await owner.post(`${inv}/movements`, { kind: 'purchase', branchId: tenant.branchId, itemId: beef, quantity: 2 }, { 'Idempotency-Key': `beef-${randomUUID()}` });
  manager = await apiAddMember(api, tenant, 'manager');
  waiterUser = await apiAddMember(api, tenant, 'waiter');
  kitchenUser = await apiAddMember(api, tenant, 'kitchen');
  ipad = await pair(api, tenant, manager, tenant.branchId, 'waiter', 'Floor iPad');
  kdsIpad = await pair(api, tenant, manager, tenant.branchId, 'kitchen', 'Grill iPad');
  other = await apiCreateTenant(api, { name: 'Other Diner' });
});
test.afterAll(async () => { await api?.dispose(); });

const lane = (page: Page, name: string) => page.getByRole('region', { name, exact: true });
const statusOf = async (id: string) => (await sql<{ status: string; payment_status: string }>(`select status, payment_status from orders where id = $1`, [id]))[0];

// ---------------------------------------------------------------------------------------------------------------------
test('1. the iPad syncs, quotes and submits a dine-in order; a replay is idempotent, a changed body is refused', async () => {
  // Session without and with an employee signed in on the device.
  const bare = await body(await ipad.get('/session'), 200);
  expect(bare).toMatchObject({ device: { id: ipad.id, branchId: tenant.branchId, actingRole: 'waiter' }, branch: { id: tenant.branchId },
    staff: null, requireStaff: false, contractVersion: '0.2.0', feed: { epoch: expect.any(String), head: expect.any(Number) } });
  expect(bare.permissions).toContain('orders:write');
  const waiter = ipad.as(waiterUser);
  const signedIn = await body(await waiter.get('/session'), 200);
  expect(signedIn.staff).toMatchObject({ id: waiterUser.userId, email: waiterUser.email, role: 'waiter' });

  // Start following the feed where it is now (a freshly paired device).
  ipad.epoch = bare.feed.epoch;
  ipad.lastSeq = bare.feed.head;

  // Menu, floor and open orders.
  const m = await body(await ipad.get('/sync/menu'), 200);
  expect(m.unchanged).toBe(false);
  const products = new Map<string, any>(m.categories.flatMap((c: any) => c.products).map((p: any) => [p.id, p]));
  expect(products.get(menu.burger)).toMatchObject({ priceMinor: 18500, available: true, station: 'Grill', stockQty: null });
  expect(products.get(kunafa)).toMatchObject({ priceMinor: 6000, available: true, stockQty: 5 });
  expect((await body(await ipad.get(`/sync/menu?since=${encodeURIComponent(m.cursor)}`), 200))).toEqual({ cursor: m.cursor, unchanged: true });
  const floor = await body(await ipad.get('/sync/floor'), 200);
  expect(floor.tables.map((x: any) => x.label).sort()).toEqual(['T1', 'T2']);
  const orders = await body(await ipad.get('/sync/orders'), 200);
  expect(orders).toMatchObject({ mode: 'full', orders: [] });
  ipad.ordersCursor = orders.cursor;

  // The device prices the cart with the server and submits what it showed (a waiter is signed in).
  const lines = [
    { productId: menu.burger, quantity: 1, modifiers: [{ groupId: menu.sizeGroup, optionId: menu.large }, { groupId: menu.extrasGroup, optionId: menu.cheese }] },
    { productId: menu.fries, quantity: 1, notes: 'extra crispy' },
    { productId: kunafa, quantity: 2 },
  ];
  const quote = await body(await waiter.post('/orders/quote', { fulfillment: 'dine_in', lines }), 200);
  expect(quote.lines.map((l: any) => l.lineTotalMinor)).toEqual([23000, 4500, 12000]);
  expect(quote.subtotalMinor).toBe(39500);
  firstBody = {
    clientOrderId: randomUUID(), fulfillment: 'dine_in', tableId: t1, guests: 2,
    lines: lines.map((l, i) => ({ ...l, expectedLineTotalMinor: quote.lines[i].lineTotalMinor })),
    expectedTotalMinor: quote.totalMinor, repricing: 'reject', takenAt: new Date().toISOString(),
  };
  const res = await waiter.post('/orders', firstBody);
  first = await body<Submitted>(res, 201);
  expect(res.headers()['idempotent-replayed']).toBeUndefined();
  expect(first.repriced).toBeNull();
  expect(first.order).toMatchObject({ clientOrderId: firstBody.clientOrderId, channel: 'pos', status: 'placed', paymentStatus: 'unpaid',
    tableLabel: 'T1', totalMinor: quote.totalMinor, version: 0, open: true });

  // The API persisted it once, attributed to the waiter on this device.
  expect(await sql(`select o.channel, o.total_minor::int as total, s.device_id from orders o join pos_order_submissions s on s.order_id = o.id where o.id = $1`, [first.order.id]))
    .toEqual([{ channel: 'pos', total: quote.totalMinor, device_id: ipad.id }]);
  expect((await sql(`select actor_type, actor_id from order_events where order_id = $1 and event_type = 'created'`, [first.order.id]))[0])
    .toEqual({ actor_type: 'user', actor_id: waiterUser.userId });

  // Offline queue retry: same clientOrderId, same body → the same order, marked as a replay.
  const replay = await waiter.post('/orders', firstBody);
  expect(await body(replay, 201)).toEqual(first);
  expect(replay.headers()['idempotent-replayed']).toBe('true');
  // Without the staff session the body is the same, so it is still the same submission.
  expect((await body(await ipad.post('/orders', firstBody), 201)).order.id).toBe(first.order.id);
  // Same id, different body → refused, nothing new.
  const reused = await ipad.post('/orders', { ...firstBody, lines: [{ productId: menu.fries, quantity: 3 }], expectedTotalMinor: undefined });
  expect((await body(reused, 409)).error.code).toBe('client_order_id_reused');
  expect((await sql(`select count(*)::int as n from orders where org_id = $1`, [tenant.orgId]))[0].n).toBe(1);

  // The device's own feed announces it.
  const fresh = await ipad.follow();
  expect(fresh.filter((e) => e.payload.orderId === first.order.id).map((e) => e.kind)).toEqual(expect.arrayContaining(['order.created', 'print_job.created']));
  expect(fresh.find((e) => e.kind === 'order.created')!.payload).toMatchObject({ orderId: first.order.id, status: 'placed', channel: 'pos', totalMinor: quote.totalMinor });
});

// ---------------------------------------------------------------------------------------------------------------------
test('2. web: the Orders board, the Overview "Right now" and the full-screen KDS show the iPad order', async ({ browser }) => {
  const staff = await newContext(browser, { user: tenant.owner });
  const kitchen = await newContext(browser, { user: kitchenUser });
  const errors = [collectErrors(staff.page), collectErrors(kitchen.page)];
  const failures = [collectApiFailures(staff.page), collectApiFailures(kitchen.page)];
  try {
    await test.step('Orders board: the card is in New orders, from the POS, at table T1', async () => {
      const p = staff.page;
      await p.goto(`/dashboard/${tenant.orgId}/orders`);
      const card = lane(p, 'New orders').locator('article').filter({ hasText: 'Table T1' });
      await expect(card).toHaveCount(1, { timeout: 15_000 });
      await expect(card.locator('.ticket-number')).toHaveText(`#${first.order.number.padStart(3, '0')}`);
      await expect(card.locator('.ticket-source')).toContainText('POS');
      await expect(card).toContainText('Smash burger');
      await expect(card).toContainText('Large');
      await expect(card).toContainText('Kunafa');
      await expect(lane(p, 'New orders').locator('.rui-lane-count')).toHaveText('1');
    });

    await test.step('Overview "Right now": one order in progress, placed', async () => {
      const p = staff.page;
      await p.goto(`/dashboard/${tenant.orgId}`);
      const now = p.locator('main section[data-section="now"]');
      await expect(now.getByRole('heading', { name: 'Right now', level: 2 })).toBeVisible({ timeout: 20_000 });
      const stages = now.getByRole('list', { name: 'Orders in progress' });
      await expect(stages.getByRole('listitem')).toHaveText([/^Placed\s*1$/, /^Accepted\s*0$/, /^Preparing\s*0$/, /^Ready\s*0$/]);
      await expect(now.locator('article[aria-labelledby="now-kitchen"]')).toContainText('Grill');
      await expect(now.locator('article[aria-labelledby="now-tables"]')).toContainText(/1\s*\/\s*2/);
    });

    await test.step('the full-screen KDS (/kitchen/:orgId) shows the ticket to kitchen staff', async () => {
      const k = kitchen.page;
      await k.goto(`/kitchen/${tenant.orgId}`);
      await expect(k.getByRole('heading', { level: 1, name: 'Kitchen display' })).toBeVisible();
      const ticket = lane(k, 'New orders').locator('article').filter({ hasText: 'Table T1' });
      await expect(ticket).toHaveCount(1, { timeout: 15_000 });
      await expect(ticket).toContainText('Smash burger');
      await expect(ticket).toContainText('Cheese');
      await expect(ticket).toContainText('extra crispy');
      await expect(ticket.locator('.ticket-source')).toContainText('POS');
    });

    // The kitchen iPad sees the same ticket through the device API.
    const tickets = await body(await kdsIpad.get('/kitchen/tickets?station=Grill'), 200);
    expect(tickets.tickets.map((x: any) => [x.id, x.status])).toEqual([[first.order.id, 'placed']]);

    for (const e of errors) expect(e).toEqual([]);
    for (const f of failures) expect(f).toEqual([]);
  } finally {
    await Promise.all([staff.context.close(), kitchen.context.close()]);
  }
});

// ---------------------------------------------------------------------------------------------------------------------
test('3. kitchen staff bump the ticket in the KDS: the iPad gets ticket.status_changed, its order delta shows it, the web board moves the card', async ({ browser }) => {
  const staff = await newContext(browser, { user: tenant.owner });
  const kitchen = await newContext(browser, { user: kitchenUser });
  const errors = [collectErrors(staff.page), collectErrors(kitchen.page)];
  const failures = [collectApiFailures(staff.page), collectApiFailures(kitchen.page)];
  try {
    const board = staff.page;
    await board.goto(`/dashboard/${tenant.orgId}/orders`);
    await expect(lane(board, 'New orders').locator('article').filter({ hasText: 'Table T1' })).toHaveCount(1, { timeout: 15_000 });
    const k = kitchen.page;
    await k.goto(`/kitchen/${tenant.orgId}`);
    const ticket = lane(k, 'New orders').locator('article').filter({ hasText: 'Table T1' });
    await expect(ticket).toHaveCount(1, { timeout: 15_000 });

    // The iPad is long-polling the feed when the kitchen bumps.
    const before = ipad.lastSeq;
    const poll = ipad.page(before, 15);
    await ticket.getByRole('button', { name: 'Start preparing' }).click();
    await expect(lane(k, 'Preparing').locator('article').filter({ hasText: 'Table T1' })).toBeVisible();
    await expect.poll(async () => (await statusOf(first.order.id)).status).toBe('preparing');

    const woke = await poll;
    expect(woke.events.length, 'the long-poll answers with the new events').toBeGreaterThan(0);
    ipad.apply(woke);
    // Everything the bump wrote (one transaction) is applied, each event exactly the previous seq + 1.
    await expect.poll(async () => { await ipad.follow(); return ipad.log.filter((e) => e.seq > before && e.kind === 'ticket.status_changed').length; }).toBe(1);
    const mine = ipad.log.filter((e) => e.seq > before);
    expect(mine.map((e) => e.seq)).toEqual(mine.map((_, i) => before + 1 + i));
    const changed = mine.find((e) => e.kind === 'ticket.status_changed')!;
    expect(changed).toMatchObject({ entityType: 'order', entityId: first.order.id,
      payload: { orderId: first.order.id, number: first.order.number, scope: 'order', from: 'placed', to: 'preparing', orderStatus: 'preparing' } });
    expect(mine.filter((e) => e.kind === 'order.updated').at(-1)!.payload).toMatchObject({ orderId: first.order.id, status: 'preparing', version: changed.payload.version });

    // At least once: re-reading from the earlier point returns the same events with the same seq; the device applies none twice.
    const again = await ipad.page(before);
    expect(again.events.map((e) => e.seq)).toEqual(mine.map((e) => e.seq));
    expect(again.events).toEqual(mine);
    expect(ipad.apply(again)).toEqual([]);
    expect(new Set(ipad.log.map((e) => e.seq)).size).toBe(ipad.log.length);

    // The order cursor gives the order in its new state.
    const delta = await body(await ipad.get(`/sync/orders?cursor=${encodeURIComponent(ipad.ordersCursor!)}`), 200);
    expect(delta.mode).toBe('delta');
    expect(delta.orders.map((o: PosOrder) => [o.id, o.status, o.version])).toEqual([[first.order.id, 'preparing', changed.payload.version]]);
    ipad.ordersCursor = delta.cursor;
    expect(await body(await ipad.get(`/sync/orders?cursor=${encodeURIComponent(ipad.ordersCursor!)}`), 200)).toMatchObject({ mode: 'delta', orders: [] });

    // The web Orders board (polling) moves the card without a reload; the overview counts it as preparing.
    await expect(lane(board, 'Preparing').locator('article').filter({ hasText: 'Table T1' })).toBeVisible({ timeout: 15_000 });
    await expect(lane(board, 'New orders').locator('article')).toHaveCount(0);
    await board.goto(`/dashboard/${tenant.orgId}`);
    await expect(board.locator('main section[data-section="now"]').getByRole('list', { name: 'Orders in progress' }).getByRole('listitem'))
      .toHaveText([/^Placed\s*0$/, /^Accepted\s*0$/, /^Preparing\s*1$/, /^Ready\s*0$/], { timeout: 20_000 });

    for (const e of errors) expect(e).toEqual([]);
    for (const f of failures) expect(f).toEqual([]);
  } finally {
    await Promise.all([staff.context.close(), kitchen.context.close()]);
  }
});

// ---------------------------------------------------------------------------------------------------------------------
test('4. reconnect: the iPad resumes from its last seq; a foreign epoch or a cursor ahead is resync_required; a full resync works', async () => {
  // While the iPad is offline, the kitchen marks the order ready (staff route, from the web KDS's API).
  const disconnectedAt = ipad.lastSeq;
  const current = await body<PosOrder>(await ipad.get(`/orders/${first.order.id}`), 200);
  await apiAs(api, kitchenUser).post(`/o/${tenant.orgId}/kitchen/orders/${first.order.id}/bump`, { to: 'ready', version: current.version });

  // Back online: resume from the last applied seq with the stored epoch.
  const resumed = await ipad.page();
  expect(resumed.epoch).toBe(ipad.epoch);
  expect(resumed.events[0]!.seq).toBe(disconnectedAt + 1);
  ipad.apply(resumed);
  await ipad.follow();
  expect(ipad.log.filter((e) => e.seq > disconnectedAt && e.kind === 'ticket.status_changed').map((e) => e.payload.to)).toEqual(['ready']);
  // Caught up: an empty page at the head.
  expect(await ipad.page()).toMatchObject({ events: [], nextAfter: ipad.lastSeq, head: ipad.lastSeq, hasMore: false });

  // A foreign epoch (another database or branch feed) and a cursor ahead of the head must resync.
  const resync = async (q: string, reason: string) => {
    const err = (await body(await ipad.get(`/events?${q}`), 409)).error;
    expect(err).toMatchObject({ code: 'resync_required', details: { reason, epoch: ipad.epoch, head: ipad.lastSeq } });
    return err.details as { epoch: string; head: number };
  };
  await resync(`after=${ipad.lastSeq}&epoch=${randomUUID()}`, 'epoch_mismatch');
  const details = await resync(`after=${ipad.lastSeq + 5}&epoch=${ipad.epoch}`, 'cursor_ahead');

  // The resync procedure: drop the projections, sync everything without cursors, follow the feed from head.
  const menuSync = await body(await ipad.get('/sync/menu'), 200);
  expect(menuSync.unchanged).toBe(false);
  expect((await body(await ipad.get('/sync/floor'), 200)).tables).toHaveLength(2);
  const full = await body(await ipad.get('/sync/orders'), 200);
  expect(full.mode).toBe('full');
  expect(full.orders.map((o: PosOrder) => [o.id, o.status])).toEqual([[first.order.id, 'ready']]);
  ipad.ordersCursor = full.cursor;
  ipad.epoch = details.epoch;
  ipad.lastSeq = details.head;
  ipad.log.length = 0;
  expect(await ipad.page()).toMatchObject({ events: [], head: details.head, hasMore: false });
  expect(await body(await ipad.get(`/sync/orders?cursor=${encodeURIComponent(full.cursor)}`), 200)).toMatchObject({ mode: 'delta', orders: [] });
});

// ---------------------------------------------------------------------------------------------------------------------
test('5. offline replay: a price change while offline is 409 pos_price_changed and creates nothing; the reviewed resubmit is 201; by-client-id reconciles', async () => {
  // Online: the waiter quotes 2 fries; then the iPad goes offline with the order queued.
  const lines = [{ productId: menu.fries, quantity: 2 }];
  const shown = await body(await ipad.post('/orders/quote', { fulfillment: 'pickup', lines }), 200);
  expect(shown.lines[0].lineTotalMinor).toBe(9000);
  const queued = {
    clientOrderId: randomUUID(), fulfillment: 'pickup', customer: { name: 'Salma' },
    lines: lines.map((l, i) => ({ ...l, expectedLineTotalMinor: shown.lines[i].lineTotalMinor })), expectedTotalMinor: shown.totalMinor,
  };

  // Meanwhile a manager changes the price at this branch on the staff API.
  const head = ipad.lastSeq;
  await apiAs(api, manager).put(`/o/${tenant.orgId}/menu/products/${menu.fries}/branches/${tenant.branchId}`, { priceOverrideMinor: 5000 });

  // Back online: the queued submit is refused with the current values; nothing is created.
  const ordersBefore = (await sql(`select count(*)::int as n from orders where org_id = $1`, [tenant.orgId]))[0].n;
  const refused = (await body(await ipad.post('/orders', queued), 409)).error;
  expect(refused).toMatchObject({ code: 'pos_price_changed', details: {
    currency: 'EGP', expectedTotalMinor: shown.totalMinor,
    lines: [{ index: 0, productId: menu.fries, expectedLineTotalMinor: 9000, currentLineTotalMinor: 10000, currentUnitPriceMinor: 5000, currentModifiersTotalMinor: 0 }],
  } });
  expect(refused.details.currentTotalMinor).toBeGreaterThan(shown.totalMinor);
  expect(refused.details.menuCursor).toEqual(expect.any(String));
  expect((await sql(`select count(*)::int as n from orders where org_id = $1`, [tenant.orgId]))[0].n).toBe(ordersBefore);
  expect((await sql(`select count(*)::int as n from pos_order_submissions where client_order_id = $1`, [queued.clientOrderId]))[0].n).toBe(0);
  expect((await body(await ipad.get(`/orders/by-client-id/${queued.clientOrderId}`), 404)).error.code).toBe('not_found');

  // The feed told the device about the price; the menu sync carries it.
  await ipad.follow();
  expect(ipad.log.some((e) => e.seq > head && e.kind === 'availability.changed' && e.payload.productId === menu.fries && e.payload.priceOverrideMinor === 5000)).toBe(true);
  const fries = (await body(await ipad.get('/sync/menu'), 200)).categories.flatMap((c: any) => c.products).find((p: any) => p.id === menu.fries);
  expect(fries.priceMinor).toBe(5000);

  // The waiter reviews the new totals and resubmits the same clientOrderId.
  const reviewed = await body(await ipad.post('/orders/quote', { fulfillment: 'pickup', lines }), 200);
  expect(reviewed.totalMinor).toBe(refused.details.currentTotalMinor);
  const res = await ipad.post('/orders', { ...queued, lines: lines.map((l, i) => ({ ...l, expectedLineTotalMinor: reviewed.lines[i].lineTotalMinor })), expectedTotalMinor: reviewed.totalMinor });
  second = await body<Submitted>(res, 201);
  expect(res.headers()['idempotent-replayed']).toBeUndefined();
  expect(second.order).toMatchObject({ clientOrderId: queued.clientOrderId, totalMinor: reviewed.totalMinor, status: 'placed' });

  // Reconciliation by client order id: accepted with the original response (any device of the branch may ask);
  // an id that was never submitted is 404.
  expect(await body(await ipad.get(`/orders/by-client-id/${queued.clientOrderId}`), 200))
    .toEqual({ state: 'accepted', orderId: second.order.id, number: second.order.number, response: second });
  expect((await body(await kdsIpad.get(`/orders/by-client-id/${first.clientOrderId}`), 200))).toMatchObject({ state: 'accepted', orderId: first.order.id, response: first });
  expect((await body(await ipad.get(`/orders/by-client-id/${randomUUID()}`), 404)).error.code).toBe('not_found');
});

// ---------------------------------------------------------------------------------------------------------------------
test('6. payment: the iPad serves the order and records cash with a clientPaymentId; payment.captured arrives; the web shows it paid; a replay returns the first payment', async ({ browser }) => {
  const waiter = ipad.as(waiterUser);
  const current = await body<PosOrder>(await waiter.get(`/orders/${first.order.id}`), 200);
  expect(current).toMatchObject({ status: 'ready', paymentStatus: 'unpaid', dueMinor: first.order.totalMinor });
  // A stale version (the one the iPad had before the kitchen moved it) is a conflict with the current version.
  const stale = (await body(await waiter.post(`/orders/${first.order.id}/transition`, { to: 'served', version: first.order.version }), 409)).error;
  expect(stale).toMatchObject({ code: 'stale_order', details: { version: current.version } });
  expect((await body(await waiter.post(`/orders/${first.order.id}/transition`, { to: 'served', version: current.version }), 200)).status).toBe('served');

  const head = ipad.lastSeq;
  const clientPaymentId = randomUUID();
  const paid = await body(await waiter.post(`/orders/${first.order.id}/payments`, { clientPaymentId, method: 'cash' }), 201);
  expect(paid).toMatchObject({ amountMinor: first.order.totalMinor, paymentStatus: 'paid', dueMinor: 0 });
  paymentId = paid.paymentId;

  // The offline queue replays the payment: the first payment again, no second one; a different method is refused.
  expect((await body(await waiter.post(`/orders/${first.order.id}/payments`, { clientPaymentId, method: 'cash' }), 201)).paymentId).toBe(paymentId);
  expect((await body(await waiter.post(`/orders/${first.order.id}/payments`, { clientPaymentId, method: 'card' }), 409)).error.code).toBe('idempotency_key_reused');
  expect((await sql(`select count(*)::int as n from payments where order_id = $1`, [first.order.id]))[0].n).toBe(1);

  await ipad.follow();
  const captured = ipad.log.filter((e) => e.seq > head && e.kind === 'payment.captured');
  expect(captured).toHaveLength(1);
  expect(captured[0]).toMatchObject({ entityType: 'payment', entityId: paymentId,
    payload: { paymentId, method: 'cash', amountMinor: first.order.totalMinor, orderId: first.order.id, isTest: false } });
  expect(ipad.log.filter((e) => e.seq > head && e.kind === 'order.updated' && e.payload.orderId === first.order.id).at(-1)!.payload)
    .toMatchObject({ paymentStatus: 'paid', dueMinor: 0 });

  // The web order shows it paid.
  const staff = await newContext(browser, { user: tenant.owner });
  const errors = collectErrors(staff.page);
  const failures = collectApiFailures(staff.page);
  try {
    await staff.page.goto(`/dashboard/${tenant.orgId}/orders?order=${first.order.id}`);
    const sheet = staff.page.getByRole('dialog', { name: `Order #${first.order.number}` });
    await expect(sheet).toBeVisible({ timeout: 15_000 });
    await expect(sheet.locator('.badge-ok').filter({ hasText: /^Paid$/ })).toBeVisible();
    await expect(sheet).toContainText('Served');
    await expect(sheet).not.toContainText('Unpaid');
    await sheet.locator('summary').filter({ hasText: 'History' }).click();
    await expect(sheet.getByRole('listitem').filter({ hasText: /^Cash · / })).toHaveCount(1);
    expect(errors).toEqual([]);
    expect(failures).toEqual([]);
  } finally {
    await staff.context.close();
  }
});

// ---------------------------------------------------------------------------------------------------------------------
test('7. consistency: inventory depletion and the analytics overview reconcile with the order totals', async () => {
  // Tracked product stock: 5 − 2 kunafa; the device menu sync shows it.
  expect((await sql(`select stock_qty from product_branch_settings where product_id = $1 and branch_id = $2`, [kunafa, tenant.branchId]))[0].stock_qty).toBe(3);
  const kun = (await body(await ipad.get('/sync/menu'), 200)).categories.flatMap((c: any) => c.products).find((p: any) => p.id === kunafa);
  expect(kun).toMatchObject({ stockQty: 3, available: true });
  // Recipe depletion: one burger × 150 g of beef, from 2 kg.
  expect(await sql(`select quantity_delta::text as q from stock_movements where reference_id = $1 and reason = 'sale'`, [first.order.id])).toEqual([{ q: '-0.150' }]);
  expect(Number((await sql(`select quantity from stock_levels where branch_id = $1 and item_id = $2`, [tenant.branchId, beef]))[0].quantity)).toBeCloseTo(1.85, 3);

  // Analytics over the local dates the two POS orders were placed on (not "today": no reliance on the time of day).
  // A branch without its own timezone uses the restaurant's.
  const [{ from, to }] = await sql<{ from: string; to: string }>(`select min(d)::text as from, max(d)::text as to from (
      select (o.placed_at at time zone coalesce(b.timezone, g.timezone))::date as d
      from orders o join branches b on b.id = o.branch_id join organizations g on g.id = o.org_id where o.id = any($1::uuid[])) x`, [[first.order.id, second.order.id]]);
  expect(from).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  const net = first.order.totalMinor + second.order.totalMinor;
  const owner = apiAs(api, tenant.owner);
  const summary = await owner.get(`/o/${tenant.orgId}/analytics/summary?from=${from}&to=${to}`);
  expect(summary.byChannel.find((c: any) => c.key === 'pos')).toMatchObject({ orders: 2, netMinor: net });
  expect(summary.totals).toMatchObject({ orders: 2, netMinor: net, paidMinor: first.order.totalMinor });
  expect(summary.byPaymentMethod).toEqual([{ method: 'cash', collectedMinor: first.order.totalMinor, refundedMinor: 0, netMinor: first.order.totalMinor }]);
  const overview = await owner.get(`/o/${tenant.orgId}/analytics/overview?from=${from}&to=${to}`);
  expect(overview.period.current).toMatchObject({ orders: 2, netMinor: net });
  // Live: the paid, served dine-in order still sits on an open visit; the replayed pickup order is placed.
  expect(overview.live.byStatus).toMatchObject({ placed: 1 });
});

// ---------------------------------------------------------------------------------------------------------------------
test('8. permissions: another branch\'s device sees 404, a revoked device 401, staff of another restaurant 403, a manager on a kitchen device cannot submit', async () => {
  const orderId = first.order.id;
  // A device of branch B (same restaurant) cannot read or act on branch A's order.
  const branchB = (await apiAs(api, tenant.owner).post(`/o/${tenant.orgId}/branches`, { name: 'Corniche' })).id as string;
  const tillB = await pair(api, tenant, manager, branchB, 'cashier', 'Corniche till');
  for (const res of [
    await tillB.get(`/orders/${orderId}`),
    await tillB.post(`/orders/${orderId}/transition`, { to: 'served', version: 0 }),
    await tillB.post(`/orders/${orderId}/payments`, { clientPaymentId: randomUUID(), method: 'cash' }),
    await tillB.post(`/orders/${orderId}/receipt`, { clientRequestId: randomUUID() }),
    await tillB.get(`/orders/by-client-id/${first.clientOrderId}`),
  ]) {
    expect((await body(res, 404)).error.code).toBe('not_found');
  }
  const feedB = await tillB.follow();
  expect(feedB.some((e) => e.payload.orderId === orderId || e.entityId === orderId)).toBe(false);
  expect((await body(await tillB.get('/sync/orders'), 200)).orders).toEqual([]);

  // A revoked device is refused at once (with or without a staff session).
  const lost = await pair(api, tenant, manager, tenant.branchId, 'waiter', 'Lost iPad');
  await body(await lost.get('/session'), 200);
  await apiAs(api, manager).post(`/o/${tenant.orgId}/pos/devices/${lost.id}/revoke`, { reason: 'Lost' });
  for (const res of [await lost.get('/session'), await lost.get(`/events?after=0`), await lost.as(waiterUser).post('/orders', { ...firstBody, clientOrderId: randomUUID() })]) {
    expect((await body(res, 401)).error.code).toBe('device_revoked');
  }

  // Staff of another restaurant signed in on this restaurant's iPad.
  for (const res of [await ipad.as(other.owner).get('/session'), await ipad.as(other.owner).post('/orders', { ...firstBody, clientOrderId: randomUUID() })]) {
    const err = (await body(res, 403)).error;
    expect(err.code).toBe('pos_staff_not_allowed');
    expect(JSON.stringify(err)).not.toContain(other.orgId);
  }

  // A manager signed in on a kitchen device works the kitchen but cannot take an order: the device's role is the ceiling.
  const mgrOnKds = kdsIpad.as(manager);
  const session = await body(await mgrOnKds.get('/session'), 200);
  expect(session.staff).toMatchObject({ id: manager.userId, role: 'manager' });
  expect(session.permissions).not.toContain('orders:write');
  expect((await body(await mgrOnKds.post('/orders', { ...firstBody, clientOrderId: randomUUID() }), 403)).error.code).toBe('forbidden');
  await body(await mgrOnKds.get('/kitchen/tickets'), 200);

  // Nothing above created an order.
  expect((await sql(`select count(*)::int as n from orders where org_id = $1`, [tenant.orgId]))[0].n).toBe(2);
});
