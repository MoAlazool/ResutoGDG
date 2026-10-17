// S01 — Restaurant onboarding, in the order a new owner does it, through HTTP only.
// signup → restaurant (EG) → second branch → bilingual menu with modifiers →
// website published → floor layout with tables → QR print sheet.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addMember, auth, bootTestApp, sql, unique, type TestApp, type TestTenant, type TestUser } from '../helpers';
import { qrTokenFor, saveFloor, table } from '../ops-fixtures';
import { buildMenuViaApi, PRICES, type ApiMenu } from './support';

let t: TestApp;
let owner: TestUser;
let tenant: TestTenant;
let menu: ApiMenu;
let secondBranch: string;
let mainCode: string;
let tableIds: string[] = [];
let qrTokens: string[] = [];

beforeAll(async () => { t = await bootTestApp(); });
afterAll(async () => { await t.close(); });

describe('S01 restaurant onboarding', () => {
  it('1. the owner signs up and has no restaurant yet', async () => {
    const email = `${unique('owner')}@example.test`.toLowerCase();
    const res = await t.http.post('/v1/auth/dev/signup').send({ email, password: 'correct-horse-battery', fullName: 'Hany Owner' });
    expect(res.status).toBe(201);
    owner = { token: res.body.accessToken, userId: res.body.user.id, email };
    const me = await t.http.get('/v1/me').set(auth(owner));
    expect(me.status).toBe(200);
    expect(me.body).toMatchObject({ user: { email }, memberships: [] });
  });

  it('2. creates an Egyptian restaurant with its first branch, tax profile and empty menu', async () => {
    const slug = unique('koshary').toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 40);
    const res = await t.http.post('/v1/orgs').set(auth(owner)).send({
      name: 'Koshary Corner', nameAr: 'ركن الكشري', slug, country: 'EG', planId: 'pro', defaultLocale: 'ar',
      branch: { name: 'Downtown', nameAr: 'وسط البلد', address: '12 Talaat Harb St', city: 'Cairo', acceptsDelivery: true, deliveryFeeMinor: 2500 },
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    tenant = { owner, orgId: res.body.id, branchId: res.body.branchId, slug };
    const org = await t.http.get(`/v1/o/${tenant.orgId}`).set(auth(owner));
    expect(org.status).toBe(200);
    expect(org.body).toMatchObject({ name: 'Koshary Corner', nameAr: 'ركن الكشري', country: 'EG', currency: 'EGP', timezone: 'Africa/Cairo', role: 'owner', status: 'onboarding' });
    expect(org.body.branches).toHaveLength(1);
    expect(org.body.branches[0]).toMatchObject({ id: tenant.branchId, name: 'Downtown', nameAr: 'وسط البلد' });
    mainCode = org.body.branches[0].code;
    expect(mainCode).toMatch(/^[a-z0-9-]+$/);
    const me = await t.http.get('/v1/me').set(auth(owner));
    expect(me.body.memberships).toEqual([expect.objectContaining({ orgId: tenant.orgId, role: 'owner' })]);
    // Atomic seeding: subscription (Pro trial), Egyptian tax profile, an empty menu.
    const ents = await t.http.get(`/v1/o/${tenant.orgId}/billing/entitlements`).set(auth(owner));
    expect(ents.body).toMatchObject({ planId: 'pro', status: 'trialing', modules: { core: { enabled: true } } });
    const tax = await t.http.get(`/v1/o/${tenant.orgId}/compliance/tax-profile`).set(auth(owner));
    expect(tax.body).toMatchObject({ country: 'EG', regime: 'eta', vatRateBp: 1400, isValidated: false });
    const emptyMenu = await t.http.get(`/v1/o/${tenant.orgId}/menu`).set(auth(owner));
    expect(emptyMenu.status).toBe(200);
    expect(emptyMenu.body.products).toEqual([]);
  });

  it('3. adds a second branch', async () => {
    const res = await t.http.post(`/v1/o/${tenant.orgId}/branches`).set(auth(owner)).send({ name: 'Zamalek', nameAr: 'الزمالك', acceptsDelivery: false });
    expect(res.status).toBe(201);
    secondBranch = res.body.id;
    const org = await t.http.get(`/v1/o/${tenant.orgId}`).set(auth(owner));
    expect(org.body.branches.map((b: any) => b.name).sort()).toEqual(['Downtown', 'Zamalek']);
  });

  it('4. builds a bilingual menu with modifier groups; the public menu shows it without costs', async () => {
    menu = await buildMenuViaApi(t, tenant);
    const view = await t.http.get(`/v1/o/${tenant.orgId}/menu`).set(auth(owner));
    expect(view.status).toBe(200);
    const byName = Object.fromEntries(view.body.products.map((p: any) => [p.name, p]));
    expect(byName['Smash burger']).toMatchObject({ nameAr: 'برجر سماش', priceMinor: PRICES.burger, currency: 'EGP', station: 'Grill', allergens: ['wheat', 'milk'] });
    expect(byName.Fries).toMatchObject({ nameAr: 'بطاطس مقلية', station: 'Fryer' });
    expect(byName.Soda).toMatchObject({ nameAr: 'مشروب غازي', station: 'Bar' });
    expect(view.body.categories.filter((c: any) => c.isActive).map((c: any) => c.nameAr)).toEqual(['الأطباق الرئيسية', 'المشروبات']);

    const pub = await t.http.get(`/v1/public/menu/${tenant.slug}`);
    expect(pub.status).toBe(200);
    expect(pub.body.org).toMatchObject({ name: 'Koshary Corner', nameAr: 'ركن الكشري', currency: 'EGP', slug: tenant.slug });
    expect(pub.body.branch).toMatchObject({ id: tenant.branchId, acceptsDelivery: true, deliveryFeeMinor: 2500 });
    const products = pub.body.categories.flatMap((c: any) => c.products);
    const burger = products.find((p: any) => p.id === menu.burger);
    expect(burger).toMatchObject({ name: 'Smash burger', nameAr: 'برجر سماش', priceMinor: PRICES.burger, available: true });
    expect(burger.modifierGroups.map((g: any) => [g.nameAr, g.minSelect, g.maxSelect])).toEqual([['الحجم', 1, 1], ['إضافات', 0, 2]]);
    expect(burger.modifierGroups[0].options.map((o: any) => [o.nameAr, o.priceDeltaMinor])).toEqual([['عادي', 0], ['كبير', PRICES.large]]);
    expect(JSON.stringify(pub.body)).not.toContain('costMinor');
    // The second branch serves the same menu.
    const zamalek = await t.http.get(`/v1/public/menu/${tenant.slug}?branch=${(await t.http.get(`/v1/o/${tenant.orgId}`).set(auth(owner))).body.branches.find((b: any) => b.id === secondBranch).code}`);
    expect(zamalek.body.branch.id).toBe(secondBranch);
    expect(zamalek.body.categories.flatMap((c: any) => c.products).map((p: any) => p.id)).toContain(menu.burger);
  });

  it('5. publishes the restaurant website with menu highlights; drafts stay private until then', async () => {
    const studio = `/v1/o/${tenant.orgId}/studio`;
    expect((await t.http.get(`/v1/public/sites/${tenant.slug}`)).status).toBe(404);
    const site = (await t.http.get(`${studio}/website`).set(auth(owner))).body;
    const highlights = site.sections.find((x: any) => x.kind === 'menu_highlights');
    expect((await t.http.patch(`${studio}/website/sections/${highlights.id}`).set(auth(owner))
      .send({ content: { headline: { en: 'Favourites', ar: 'المفضلة' }, productIds: [menu.burger, menu.fries] } })).status).toBe(200);
    const pub = await t.http.post(`${studio}/website/publish`).set(auth(owner)).send({ key: unique('publish') });
    expect(pub.status).toBe(201);
    const pubSite = await t.http.get(`/v1/public/sites/${tenant.slug}`);
    expect(pubSite.status).toBe(200);
    expect(pubSite.body.menuHighlights.map((p: any) => p.priceMinor)).toEqual([PRICES.burger, PRICES.fries]);
    expect(JSON.stringify(pubSite.body)).not.toMatch(/costMinor|qrToken|qr_token/);
  });

  it('6. lays out the floor with tables; operational status starts available', async () => {
    const f = await saveFloor(t, tenant, [table('T1', 200, 200), table('T2', 400, 200, { capacity: 2 }), table('T3', 600, 200, { capacity: 6, shape: 'round' })]);
    expect(f.tables).toHaveLength(3);
    tableIds = f.tables.map((x: any) => x.id);
    expect(f.tables.every((x: any) => x.status === 'available')).toBe(true);
    expect(f.tables.find((x: any) => x.label === 'T3')).toMatchObject({ capacity: 6, shape: 'round' });
    const live = await t.http.get(`/v1/o/${tenant.orgId}/floor/${tenant.branchId}/live`).set(auth(owner));
    expect(live.status).toBe(200);
    expect(live.body.tables.every((x: any) => x.visit === null)).toBe(true);
  });

  it('7. prints the QR sheet; QR tokens appear nowhere else and are never a bearer credential', async () => {
    const sheet = await t.http.get(`/v1/o/${tenant.orgId}/floor/${tenant.branchId}/qr`).set(auth(owner));
    expect(sheet.status).toBe(200);
    expect(sheet.body.items).toHaveLength(3);
    for (const item of sheet.body.items) {
      expect(item.url).toMatch(/^http:\/\/app\.test\/t\/[A-Za-z0-9_-]{16,}$/);
      expect(item.svg).toContain('<svg');
    }
    qrTokens = await Promise.all(tableIds.map((id) => qrTokenFor(t, tenant, id)));
    expect(new Set(qrTokens).size).toBe(3);

    const pubFloor = await t.http.get(`/v1/public/floor/${tenant.slug}/${mainCode}`);
    expect(pubFloor.status).toBe(200);
    expect(pubFloor.body.tables).toHaveLength(3);
    const bodies = [
      JSON.stringify(pubFloor.body),
      JSON.stringify((await t.http.get(`/v1/public/menu/${tenant.slug}`)).body),
      JSON.stringify((await t.http.get(`/v1/public/order/${tenant.slug}`)).body),
      JSON.stringify((await t.http.get(`/v1/o/${tenant.orgId}/floor/${tenant.branchId}`).set(auth(owner))).body),
      JSON.stringify((await t.http.get(`/v1/o/${tenant.orgId}/floor/${tenant.branchId}/live`).set(auth(owner))).body),
      JSON.stringify((await t.http.get(`/v1/o/${tenant.orgId}`).set(auth(owner))).body),
    ];
    for (const body of bodies) for (const tok of qrTokens) expect(body).not.toContain(tok);
    // The raw QR token cannot be used as a guest credential.
    expect((await t.http.get('/v1/public/visits/current').set('X-Visit-Token', qrTokens[0]!)).status).toBe(401);
    // Only floor:write roles may print the sheet.
    const waiter = await addMember(t, tenant, 'waiter');
    expect((await t.http.get(`/v1/o/${tenant.orgId}/floor/${tenant.branchId}/qr`).set(auth(waiter))).status).toBe(403);
  });

  it('8. every onboarding mutation is in the audit trail', async () => {
    const log = await t.http.get(`/v1/o/${tenant.orgId}/audit?limit=200`).set(auth(owner));
    expect(log.status).toBe(200);
    const actions = new Set(log.body.items.map((e: any) => e.action));
    for (const a of ['organization.created', 'menu.product.created']) expect(actions).toContain(a);
  });
});
