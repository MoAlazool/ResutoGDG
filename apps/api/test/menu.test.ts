import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TenantContext } from '../src/common/auth/context';
import { DbService } from '../src/common/db/db.service';
import { addMember, auth, bootTestApp, createTenant, sql, type TestApp, type TestTenant, type TestUser } from './helpers';

let t: TestApp;
let tenant: TestTenant;
let kitchen: TestUser;
let categoryId: string;

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082', 'hex');

beforeAll(async () => {
  t = await bootTestApp();
  tenant = await createTenant(t, { country: 'EG' });
  kitchen = await addMember(t, tenant, 'kitchen', [tenant.branchId]);
});
afterAll(async () => { await t.close(); });

const base = () => `/v1/o/${tenant.orgId}/menu`;

describe('menu CRUD', () => {
  it('creates categories and products with bilingual fields and reorders categories', async () => {
    const mains = await t.http.post(`${base()}/categories`).set(auth(tenant.owner)).send({ name: 'Mains', nameAr: 'الأطباق الرئيسية', defaultStation: 'Grill' });
    expect(mains.status).toBe(201);
    categoryId = mains.body.id;
    const drinks = await t.http.post(`${base()}/categories`).set(auth(tenant.owner)).send({ name: 'Drinks' });
    expect(drinks.body.sortOrder).toBe(1);

    const p = await t.http.post(`${base()}/products`).set(auth(tenant.owner)).send({
      categoryId, name: 'Koshari', nameAr: 'كشري', description: 'Rice, lentils, pasta', descriptionAr: 'أرز وعدس ومكرونة',
      priceMinor: 9500, costMinor: 3000, prepMinutes: 8, spiceLevel: 1, dietary: ['vegetarian'], allergens: ['wheat'], ingredients: ['rice', 'lentils'],
    });
    expect(p.status).toBe(201);
    expect(p.body).toMatchObject({ name: 'Koshari', nameAr: 'كشري', station: 'Grill', priceMinor: 9500, currency: 'EGP', version: 0, allergens: ['wheat'] });

    const reorder = await t.http.post(`${base()}/categories/reorder`).set(auth(tenant.owner)).send({ ids: [drinks.body.id, categoryId] });
    expect(reorder.status).toBe(201);
    const view = await t.http.get(base()).set(auth(tenant.owner));
    expect(view.status).toBe(200);
    expect(view.body.categories.filter((c: any) => c.isActive).map((c: any) => c.name)).toEqual(['Drinks', 'Mains']);
    expect(view.body.products.find((x: any) => x.id === p.body.id).costMinor).toBe(3000);
    expect(view.body.stations).toContain('Grill');
  });

  it('rejects stale versions with 409 and validates input', async () => {
    const p = await t.http.post(`${base()}/products`).set(auth(tenant.owner)).send({ categoryId, name: 'Fattah', priceMinor: 15000 });
    const ok = await t.http.patch(`${base()}/products/${p.body.id}`).set(auth(tenant.owner)).send({ version: 0, priceMinor: 16000 });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ priceMinor: 16000, version: 1 });
    const stale = await t.http.patch(`${base()}/products/${p.body.id}`).set(auth(tenant.owner)).send({ version: 0, name: 'Fatta' });
    expect(stale.status).toBe(409);
    expect(stale.body.error).toMatchObject({ code: 'stale_product', details: { version: 1 } });
    const bad = await t.http.post(`${base()}/products`).set(auth(tenant.owner)).send({ categoryId, name: '', priceMinor: -5 });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('validation_failed');
    const audit = await sql(`select action from audit_logs where org_id = $1 and entity_id = $2 order by id`, [tenant.orgId, p.body.id]);
    expect(audit.map((a) => a.action)).toEqual(['menu.product.created', 'menu.product.updated']);
    const events = await sql(`select count(*)::int as n from outbox_events where org_id = $1 and event_type = 'menu.updated'`, [tenant.orgId]);
    expect(events[0].n).toBeGreaterThan(2);
  });

  it('lets the kitchen 86 an item but not edit the menu', async () => {
    const p = await t.http.post(`${base()}/products`).set(auth(tenant.owner)).send({ categoryId, name: 'Molokhia', priceMinor: 7000 });
    const off = await t.http.post(`${base()}/products/${p.body.id}/availability`).set(auth(kitchen)).send({ branchId: tenant.branchId, available: false });
    expect(off.status).toBe(201);
    expect(off.body).toMatchObject({ available: false });
    // Not offered at this branch → not listed (sold out is reserved for tracked stock at 0).
    const pub = await t.http.get(`/v1/public/menu/${tenant.slug}`);
    const item = pub.body.categories.flatMap((c: any) => c.products).find((x: any) => x.id === p.body.id);
    expect(item).toBeUndefined();
    const edit = await t.http.patch(`${base()}/products/${p.body.id}`).set(auth(kitchen)).send({ version: 0, priceMinor: 1 });
    expect(edit.status).toBe(403);
    const create = await t.http.post(`${base()}/products`).set(auth(kitchen)).send({ categoryId, name: 'X', priceMinor: 1 });
    expect(create.status).toBe(403);
    expect((await t.http.get(base()).set(auth(kitchen))).status).toBe(200);
  });

  it('manages modifier groups, options and assignment; public menu hides costs', async () => {
    const p = await t.http.post(`${base()}/products`).set(auth(tenant.owner)).send({ categoryId, name: 'Shawarma', priceMinor: 12000, costMinor: 4000 });
    const g = await t.http.post(`${base()}/modifier-groups`).set(auth(tenant.owner)).send({ name: 'Bread', nameAr: 'الخبز', minSelect: 1, maxSelect: 1 });
    expect(g.status).toBe(201);
    const badRange = await t.http.post(`${base()}/modifier-groups`).set(auth(tenant.owner)).send({ name: 'Bad', minSelect: 3, maxSelect: 1 });
    expect(badRange.status).toBe(400);
    const o1 = await t.http.post(`${base()}/modifier-groups/${g.body.id}/options`).set(auth(tenant.owner)).send({ name: 'Saj', priceDeltaMinor: 0 });
    const o2 = await t.http.post(`${base()}/modifier-groups/${g.body.id}/options`).set(auth(tenant.owner)).send({ name: 'Baguette', nameAr: 'باجيت', priceDeltaMinor: 1500 });
    expect(o2.body.options).toHaveLength(2);
    const assign = await t.http.put(`${base()}/products/${p.body.id}/modifier-groups`).set(auth(tenant.owner)).send({ groupIds: [g.body.id] });
    expect(assign.status).toBe(200);
    expect(assign.body.modifierGroupIds).toEqual([g.body.id]);
    await t.http.patch(`${base()}/modifier-options/${o1.body.options[0].id}`).set(auth(tenant.owner)).send({ isAvailable: false });

    const branchPrice = await t.http.put(`${base()}/products/${p.body.id}/branches/${tenant.branchId}`).set(auth(tenant.owner)).send({ priceOverrideMinor: 13000 });
    expect(branchPrice.body).toMatchObject({ priceOverrideMinor: 13000, isAvailable: true });

    const pub = await t.http.get(`/v1/public/menu/${tenant.slug}`);
    expect(pub.status).toBe(200);
    expect(pub.body.org).toMatchObject({ slug: tenant.slug, currency: 'EGP' });
    expect(pub.body.branch.id).toBe(tenant.branchId);
    const item = pub.body.categories.flatMap((c: any) => c.products).find((x: any) => x.id === p.body.id);
    expect(item.priceMinor).toBe(13000);
    expect(item.modifierGroups[0]).toMatchObject({ name: 'Bread', nameAr: 'الخبز', minSelect: 1, maxSelect: 1 });
    expect(item.modifierGroups[0].options.map((o: any) => [o.name, o.available])).toEqual([['Saj', false], ['Baguette', true]]);
    const raw = JSON.stringify(pub.body);
    expect(raw).not.toContain('costMinor');
    expect(raw).not.toContain('stockQty');
    expect(raw).not.toContain('4000');
    expect((await t.http.get('/v1/public/menu/no-such-restaurant')).status).toBe(404);
  });

  it('uploads a product image through storage and serves a signed URL', async () => {
    const p = await t.http.post(`${base()}/products`).set(auth(tenant.owner)).send({ categoryId, name: 'Feteer', priceMinor: 9000 });
    const up = await t.http.post(`${base()}/products/${p.body.id}/image`).set(auth(tenant.owner)).attach('file', PNG, { filename: 'f.png', contentType: 'image/png' });
    expect(up.status).toBe(201);
    expect(up.body.imageMediaId).toBeTruthy();
    expect(up.body.imageUrl).toMatch(/^http:\/\/api\.test\/v1\/media\//);
    const fake = await t.http.post(`${base()}/products/${p.body.id}/image`).set(auth(tenant.owner)).attach('file', Buffer.from('not an image'), { filename: 'x.png', contentType: 'image/png' });
    expect(fake.status).toBe(422);
    expect(fake.body.error.code).toBe('media_type_mismatch');
  });

  it('hides other tenants behind 404', async () => {
    const other = await createTenant(t);
    const p = await t.http.post(`${base()}/products`).set(auth(tenant.owner)).send({ categoryId, name: 'Hawawshi', priceMinor: 8000 });
    expect((await t.http.get(`/v1/o/${tenant.orgId}/menu`).set(auth(other.owner))).status).toBe(404);
    // Another tenant cannot reach this product id through its own org either (RLS + lookups).
    const cross = await t.http.patch(`/v1/o/${other.orgId}/menu/products/${p.body.id}`).set(auth(other.owner)).send({ version: 0, name: 'Stolen' });
    expect(cross.status).toBe(404);
    const [row] = await sql('select name from products where id = $1', [p.body.id]);
    expect(row.name).toBe('Hawawshi');
  });
});

describe('MENU_AVAILABILITY_PORT (ResutoMCP)', () => {
  it('is bound to Symbol.for token and enforces tenant, branch scope, audit and outbox', async () => {
    const port = t.app.get<any>(Symbol.for('resuto.MENU_AVAILABILITY_PORT'));
    const db = t.app.get(DbService);
    const p = await t.http.post(`${base()}/products`).set(auth(tenant.owner)).send({ categoryId, name: 'Sobia', priceMinor: 3000 });
    const mcp = new TenantContext(tenant.orgId, 'manager', null, null, 'mcp_client', 'client-1', 'mcp');
    const r = await db.scoped(mcp, (tx) => port.setAvailability(tx, mcp, { productId: p.body.id, branchId: tenant.branchId, available: false, reason: 'Out of dates', source: 'mcp' }));
    expect(r).toEqual({ productId: p.body.id, branchId: tenant.branchId, available: false });
    const [s] = await sql('select is_available from product_branch_settings where product_id = $1 and branch_id = $2', [p.body.id, tenant.branchId]);
    expect(s.is_available).toBe(false);
    const [audit] = await sql(`select actor_type, source, metadata from audit_logs where entity_id = $1 and action = 'menu.product.unavailable'`, [p.body.id]);
    expect(audit).toMatchObject({ actor_type: 'mcp_client', source: 'mcp', metadata: { source: 'mcp', reason: 'Out of dates' } });
    const [evt] = await sql(`select event_type from outbox_events where aggregate_id = $1 order by created_at desc limit 1`, [p.body.id]);
    expect(evt.event_type).toBe('menu.updated');

    const other = await createTenant(t);
    const otherCtx = new TenantContext(other.orgId, 'manager', null, null, 'mcp_client', 'client-2', 'mcp');
    await expect(db.scoped(otherCtx, (tx) => port.setAvailability(tx, otherCtx, { productId: p.body.id, branchId: other.branchId, available: true, source: 'mcp' })))
      .rejects.toMatchObject({ code: 'not_found' });
    const scoped = new TenantContext(tenant.orgId, 'manager', [other.branchId], null, 'mcp_client', 'client-3', 'mcp');
    await expect(db.scoped(scoped, (tx) => port.setAvailability(tx, scoped, { productId: p.body.id, branchId: tenant.branchId, available: true, source: 'mcp' })))
      .rejects.toMatchObject({ code: 'forbidden' });
  });
});

describe('menu import (§8 rows)', () => {
  it('previews with legacy review semantics and commits idempotently', async () => {
    const rows = [
      { externalId: 'pos-1', name: 'Foul', category: 'Breakfast', priceMinor: 3500, allergens: ['beans'] },
      { externalId: 'pos-2', name: 'Taameya', nameAr: 'طعمية', category: 'Breakfast', priceMinor: 2000, station: 'Fryer' },
      { name: 'foul', category: 'Breakfast', priceMinor: 0 },
    ];
    const bad = await t.http.post(`${base()}/import/preview`).set(auth(tenant.owner)).send({ rows, source: 'foodics' });
    expect(bad.status).toBe(201);
    expect(bad.body.summary).toMatchObject({ total: 3, create: 3, errors: 1, newCategories: ['Breakfast'] });
    expect(bad.body.rows[2].errors).toEqual(expect.arrayContaining(['Duplicate item', 'Price must be a positive amount with up to two decimals']));
    const refused = await t.http.post(`${base()}/import/commit`).set(auth(tenant.owner)).send({ rows, source: 'foodics', key: 'import-bad-1' });
    expect(refused.status).toBe(422);
    expect(refused.body.error.code).toBe('import_has_errors');

    const good = rows.slice(0, 2);
    const commit = () => t.http.post(`${base()}/import/commit`).set(auth(tenant.owner)).send({ rows: good, source: 'foodics', key: 'import-good-1' });
    const first = await commit();
    expect(first.status).toBe(201);
    expect(first.body).toEqual({ created: 2, updated: 0, categoriesCreated: ['Breakfast'] });
    const replay = await commit();
    expect(replay.body).toEqual(first.body);
    const reused = await t.http.post(`${base()}/import/commit`).set(auth(tenant.owner)).send({ rows: good.slice(0, 1), source: 'foodics', key: 'import-good-1' });
    expect(reused.status).toBe(409);
    // POS drafts start unavailable until reviewed (legacy behaviour).
    const [s] = await sql(`select s.is_available from product_branch_settings s join products p on p.id = s.product_id where p.external_ref = 'pos-2' and p.org_id = $1`, [tenant.orgId]);
    expect(s.is_available).toBe(false);

    // Re-importing by external id updates instead of duplicating.
    const again = await t.http.post(`${base()}/import/preview`).set(auth(tenant.owner)).send({ rows: [{ externalId: 'pos-1', name: 'Foul medames', category: 'Breakfast', priceMinor: 4000 }], source: 'odoo' });
    expect(again.body.rows[0]).toMatchObject({ action: 'update', errors: [] });
  });

  it('accepts legacy CSV exports with formula-safe parsing', async () => {
    const csv = 'name,category,price_egp,station,allergens\r\n"Om Ali","Desserts",65.50,Pastry,milk|tree nuts\r\n"Basbousa, honey",Desserts,40,Pastry,\r\n';
    const preview = await t.http.post(`${base()}/import/preview`).set(auth(tenant.owner)).send({ csv, source: 'csv' });
    expect(preview.status).toBe(201);
    expect(preview.body.rows.map((r: any) => [r.item.name, r.item.priceMinor, r.item.allergens])).toEqual([
      ['Om Ali', 6550, ['milk', 'tree nuts']], ['Basbousa, honey', 4000, []],
    ]);
    const broken = await t.http.post(`${base()}/import/preview`).set(auth(tenant.owner)).send({ csv: 'name,category\n"unclosed,Desserts', source: 'csv' });
    expect(broken.status).toBe(422);
    expect(broken.body.error.code).toBe('invalid_csv');
    expect((await t.http.post(`${base()}/import/preview`).set(auth(kitchen)).send({ csv, source: 'csv' })).status).toBe(403);
  });
});
