import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RateLimiter } from '../src/common/http/rate-limiter';
import { SEARCH_PER_MINUTE } from '../src/modules/search/search.controller';
import { SEARCH_MAX_RESULTS } from '../src/modules/search/search.service';
import { addMember, auth, bootTestApp, createTenant, seedMenu, sql, type SeededMenu, type TestApp, type TestTenant, type TestUser } from './helpers';
import { addBranch, placeOrder } from './insights-fixtures';

// GET /o/:orgId/search (21-SHELL command palette): orders, customers and menu products, permission-checked per type,
// branch-scoped, tenant-isolated, rate-limited and bounded.

let t: TestApp;
let tenant: TestTenant;
let other: TestTenant;
let menu: SeededMenu;
let north: string;
let mainOrder: { id: string; number: string };
let northOrder: { id: string; number: string };
let mona: string;
let zed: string;
let northOnlyProduct: string;
let otherProduct: string;

const fries = (quantity = 1) => [{ productId: menu.products.fries, quantity }];
const search = (u: { token: string }, orgId: string, q: string, extra = '') =>
  t.http.get(`/v1/o/${orgId}/search?q=${encodeURIComponent(q)}${extra}`).set(auth(u));
const ids = (res: { body: { items: Array<{ id: string }> } }) => res.body.items.map((i) => i.id);
const types = (res: { body: { items: Array<{ type: string }> } }) => [...new Set(res.body.items.map((i) => i.type))].sort();

beforeAll(async () => {
  t = await bootTestApp();
  tenant = await createTenant(t, { country: 'EG' });
  menu = await seedMenu(tenant);
  north = await addBranch(t, tenant, 'North');
  const m = await placeOrder(t, tenant, { channel: 'web', fulfillment: 'pickup', lines: fries(2), customer: { name: 'Mona Adel', phone: '+201001111111' } });
  mainOrder = { id: m.id, number: m.number };
  mona = m.customerId!;
  const z = await placeOrder(t, tenant, { branchId: north, channel: 'web', fulfillment: 'pickup', lines: fries(1), customer: { name: 'Zed North', phone: '+201009999999' } });
  northOrder = { id: z.id, number: z.number };
  zed = z.customerId!;
  // A menu that applies only to the North branch, with an Arabic-named product.
  const [nm] = await sql(`insert into menus(org_id, branch_id, name) values ($1, $2, 'North menu') returning id`, [tenant.orgId, north]);
  const [nc] = await sql(`insert into menu_categories(org_id, menu_id, name) values ($1, $2, 'North mains') returning id`, [tenant.orgId, nm.id]);
  [{ id: northOnlyProduct }] = await sql(`insert into products(org_id, category_id, name, name_ar, price_minor, currency) values ($1, $2, 'Koshary bowl', 'طبق كشري', 6000, 'EGP') returning id`, [tenant.orgId, nc.id]);

  // Another restaurant with look-alike data that must never appear.
  other = await createTenant(t, { country: 'EG' });
  const om = await seedMenu(other);
  await placeOrder(t, other, { channel: 'web', fulfillment: 'pickup', lines: [{ productId: om.products.fries, quantity: 1 }], customer: { name: 'Mona Other', phone: '+201001111112' } });
  otherProduct = om.products.fries;
});
afterAll(async () => { await t.close(); });

describe('record search', () => {
  it('finds orders by number (with or without #), customers by name and phone, products by English and Arabic name', async () => {
    const byNumber = await search(tenant.owner, tenant.orgId, `#${mainOrder.number}`);
    expect(byNumber.status).toBe(200);
    expect(byNumber.body.searched).toEqual(['orders', 'customers', 'products']);
    expect(byNumber.body.items.filter((i: any) => i.type === 'order').map((i: any) => i.id)).toContain(mainOrder.id);
    const order = byNumber.body.items.find((i: any) => i.id === mainOrder.id);
    expect(order).toMatchObject({ type: 'order', number: mainOrder.number, branchId: tenant.branchId, customerName: 'Mona Adel', totalMinor: 9000, currency: 'EGP' });

    const byName = await search(tenant.owner, tenant.orgId, 'mona');
    expect(byName.body.items).toEqual([{ type: 'customer', id: mona, displayName: 'Mona Adel', phone: '+201001111111' }]);
    expect(ids(await search(tenant.owner, tenant.orgId, '9999'))).toEqual([zed]);
    // Arabic-Indic digits are read as Western digits.
    expect(ids(await search(tenant.owner, tenant.orgId, '٩٩٩٩'))).toEqual([zed]);

    const fr = await search(tenant.owner, tenant.orgId, 'fri');
    expect(fr.body.items).toEqual([{ type: 'product', id: menu.products.fries, name: 'Fries', nameAr: null, priceMinor: 4500, currency: 'EGP' }]);
    expect(ids(await search(tenant.owner, tenant.orgId, 'كشري'))).toEqual([northOnlyProduct]);
  });

  it('treats LIKE wildcards as text and validates the query', async () => {
    expect((await search(tenant.owner, tenant.orgId, '%')).body.items).toEqual([]);
    expect((await search(tenant.owner, tenant.orgId, '_')).body.items).toEqual([]);
    expect((await search(tenant.owner, tenant.orgId, '   ')).status).toBe(400);
    expect((await t.http.get(`/v1/o/${tenant.orgId}/search`).set(auth(tenant.owner))).status).toBe(400);
    expect((await search(tenant.owner, tenant.orgId, 'x'.repeat(81))).status).toBe(400);
    expect((await search(tenant.owner, tenant.orgId, 'mona', '&branchId=not-a-uuid')).status).toBe(400);
  });

  it('is bounded to 20 hits in all', async () => {
    const values = Array.from({ length: 30 }, (_, i) => `($1, $2, 'Bulk dish ${String(i).padStart(2, '0')}', 1000, 'EGP')`).join(', ');
    await sql(`insert into products(org_id, category_id, name, price_minor, currency) values ${values}`, [tenant.orgId, menu.categoryId]);
    const res = await search(tenant.owner, tenant.orgId, 'bulk dish');
    expect(res.status).toBe(200);
    expect(res.body.items.length).toBeLessThanOrEqual(SEARCH_MAX_RESULTS);
    expect(res.body.items.length).toBeGreaterThan(0);
  });
});

describe('branch scope', () => {
  it('narrows to the shell branch when one is given', async () => {
    const main = await search(tenant.owner, tenant.orgId, 'north', `&branchId=${tenant.branchId}`);
    // Zed only ordered at North; the North-only menu does not apply to the main branch.
    expect(ids(main)).not.toContain(zed);
    expect(ids(await search(tenant.owner, tenant.orgId, 'koshary', `&branchId=${tenant.branchId}`))).toEqual([]);
    expect(ids(await search(tenant.owner, tenant.orgId, 'koshary', `&branchId=${north}`))).toEqual([northOnlyProduct]);
    expect(ids(await search(tenant.owner, tenant.orgId, 'north', `&branchId=${north}`))).toContain(zed);
  });

  it('a branch-scoped member sees only their branches and cannot ask for another one', async () => {
    const mainCashier = await addMember(t, tenant, 'cashier', [tenant.branchId]);
    const zedSearch = await search(mainCashier, tenant.orgId, 'zed');
    expect(zedSearch.status).toBe(200);
    expect(ids(zedSearch)).toEqual([]);
    expect(ids(await search(mainCashier, tenant.orgId, 'mona'))).toEqual([mona]);
    const numberHits = (await search(mainCashier, tenant.orgId, northOrder.number)).body.items.map((i: any) => i.id);
    expect(numberHits).not.toContain(northOrder.id);
    expect(ids(await search(mainCashier, tenant.orgId, 'koshary'))).toEqual([]);
    const denied = await search(mainCashier, tenant.orgId, 'zed', `&branchId=${north}`);
    expect(denied.status).toBe(403);
  });
});

describe('permissions per result type', () => {
  let roles: Record<'kitchen' | 'marketing' | 'accountant' | 'driver', TestUser>;
  beforeAll(async () => {
    roles = {
      kitchen: await addMember(t, tenant, 'kitchen'),
      marketing: await addMember(t, tenant, 'marketing'),
      accountant: await addMember(t, tenant, 'accountant'),
      driver: await addMember(t, tenant, 'driver'),
    };
  });

  it('includes only the record types the role may read', async () => {
    // Kitchen: orders and the menu, never customer contact details.
    const kitchen = await search(roles.kitchen, tenant.orgId, 'mona');
    expect(kitchen.body.searched).toEqual(['orders', 'products']);
    expect(kitchen.body.items).toEqual([]);
    expect(types(await search(roles.kitchen, tenant.orgId, 'fries'))).toEqual(['product']);
    // Marketing: customers and the menu, no orders.
    const marketing = await search(roles.marketing, tenant.orgId, mainOrder.number);
    expect(marketing.body.searched).toEqual(['customers', 'products']);
    expect(marketing.body.items.some((i: any) => i.type === 'order')).toBe(false);
    expect(types(await search(roles.marketing, tenant.orgId, 'mona'))).toEqual(['customer']);
    // Accountant: orders only.
    const accountant = await search(roles.accountant, tenant.orgId, 'mona');
    expect(accountant.body.searched).toEqual(['orders']);
    expect(accountant.body.items).toEqual([]);
    expect(types(await search(roles.accountant, tenant.orgId, `#${mainOrder.number}`))).toEqual(['order']);
  });

  it('refuses a role that may read none of them', async () => {
    const res = await search(roles.driver, tenant.orgId, 'mona');
    expect(res.status).toBe(403);
  });
});

describe('tenant isolation', () => {
  it('never returns another restaurant\'s records', async () => {
    const mine = await search(tenant.owner, tenant.orgId, 'mona');
    expect(mine.body.items.map((i: any) => i.displayName)).toEqual(['Mona Adel']);
    expect(ids(await search(tenant.owner, tenant.orgId, 'fries'))).not.toContain(otherProduct);
  });

  it('refuses a member of another restaurant and an anonymous caller', async () => {
    const res = await search(other.owner, tenant.orgId, 'mona');
    expect([403, 404]).toContain(res.status);
    expect(JSON.stringify(res.body)).not.toContain('Mona Adel');
    expect((await t.http.get(`/v1/o/${tenant.orgId}/search?q=mona`)).status).toBe(401);
  });

  it('does not let a branch from another restaurant widen the scope', async () => {
    const res = await search(tenant.owner, tenant.orgId, 'fries', `&branchId=${other.branchId}`);
    expect(res.status).toBe(404);
    expect(JSON.stringify(res.body)).not.toContain('Fries');
  });
});

describe('rate limit', () => {
  it('limits searches per member per minute', async () => {
    const member = await addMember(t, tenant, 'manager');
    const limiter = t.app.get(RateLimiter);
    const me = await t.http.get('/v1/me').set(auth(member));
    expect(me.status).toBe(200);
    // Use up the window directly, then the next request is refused with 429 and Retry-After.
    for (let i = 0; i < SEARCH_PER_MINUTE; i++) limiter.hit(`search:${tenant.orgId}:${member.userId}`, SEARCH_PER_MINUTE);
    const res = await search(member, tenant.orgId, 'mona');
    expect(res.status).toBe(429);
    expect(res.headers['retry-after']).toBeDefined();
    // Another member is unaffected.
    expect((await search(tenant.owner, tenant.orgId, 'mona')).status).toBe(200);
  });
});
