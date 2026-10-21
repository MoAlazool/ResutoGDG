// Branch storefront branding (audit VP-05) and concept-correct website highlights (audit DF-09).
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addMember, auth, bootTestApp, createTenant, sql, type TestApp, type TestTenant } from './helpers';

let t: TestApp;
let tenant: TestTenant;
let burgerBranch: string;
let burgersCat: string;
let mainDish: string;
let burger: string;
let heroMedia: string;
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const studio = () => `/v1/o/${tenant.orgId}/studio`;
const publish = () => t.http.post(`${studio()}/website/publish`).set(auth(tenant.owner)).send({ key: `pub-${randomUUID()}` });
const brand = (over: Record<string, unknown> = {}) => ({
  slug: 'smash-and-co', brandName: 'Smash & Co', brandNameAr: 'سماش آند كو', tagline: { en: 'Smashed fresh. Served fast.', ar: 'طازج ومهروس. يُقدّم بسرعة.' },
  theme: { primaryColor: '#d7261e', accentColor: '#ffd23f' }, heroMediaId: heroMedia,
  content: { headline: { en: 'Smashed fresh. Served fast.' }, sections: [{ categoryId: burgersCat, title: { en: 'Burgers that hit different.' } }] },
  isPublished: true, ...over,
});

beforeAll(async () => {
  t = await bootTestApp();
  tenant = await createTenant(t, { name: 'Olive Test' });
  const b = await t.http.post(`/v1/o/${tenant.orgId}/branches`).set(auth(tenant.owner)).send({ name: 'Burger bar', code: 'burger', acceptsDelivery: true });
  expect(b.status).toBe(201);
  burgerBranch = b.body.id;
  const [menu] = await sql(`select id from menus where org_id = $1 limit 1`, [tenant.orgId]);
  const [mains] = await sql(`insert into menu_categories(org_id, menu_id, name) values ($1, $2, 'Mains') returning id`, [tenant.orgId, menu.id]);
  const [burgers] = await sql(`insert into menu_categories(org_id, menu_id, name) values ($1, $2, 'Burgers') returning id`, [tenant.orgId, menu.id]);
  burgersCat = burgers.id;
  const product = async (cat: string, name: string) => (await sql(
    `insert into products(org_id, category_id, name, price_minor, currency, station) values ($1, $2, $3, 10000, 'EGP', 'Grill') returning id`, [tenant.orgId, cat, name]))[0].id;
  mainDish = await product(mains.id, 'Seabass');
  burger = await product(burgers.id, 'Classic Smash');
  // Each branch serves its own menu (as the demo does): the main branch does not sell burgers, the burger bar not seabass.
  await sql(`insert into product_branch_settings(org_id, product_id, branch_id, is_available) values ($1, $2, $3, false), ($1, $4, $5, false)`,
    [tenant.orgId, burger, tenant.branchId, mainDish, burgerBranch]);
  const up = await t.http.post(`${studio()}/media`).set(auth(tenant.owner)).attach('file', PNG, { filename: 'hero.png', contentType: 'image/png' });
  expect(up.status).toBe(201);
  heroMedia = up.body.id;
});
afterAll(async () => { await t.close(); });

describe('branch storefronts', () => {
  it('stores branding for a branch and serves it publicly once published', async () => {
    const draft = await t.http.put(`${studio()}/storefronts/${burgerBranch}`).set(auth(tenant.owner)).send(brand({ isPublished: false }));
    expect(draft.status).toBe(200);
    expect(draft.body).toMatchObject({ branchId: burgerBranch, slug: 'smash-and-co', brandName: 'Smash & Co', isPublished: false });
    expect((await t.http.get(`/v1/public/sites/${tenant.slug}/storefronts/smash-and-co`)).status).toBe(404);

    const saved = await t.http.put(`${studio()}/storefronts/${burgerBranch}`).set(auth(tenant.owner)).send(brand());
    expect(saved.status).toBe(200);
    // Not public while the restaurant website itself is unpublished: its site and logo links would lead to a 404.
    expect((await t.http.get(`/v1/public/sites/${tenant.slug}`)).status).toBe(404);
    expect((await t.http.get(`/v1/public/sites/${tenant.slug}/storefronts/smash-and-co`)).status).toBe(404);
    expect((await publish()).status).toBeLessThan(300);
    const pub = await t.http.get(`/v1/public/sites/${tenant.slug}/storefronts/smash-and-co`);
    expect(pub.status).toBe(200);
    expect(pub.body).toMatchObject({
      slug: 'smash-and-co',
      org: { slug: tenant.slug, demo: false },
      branch: { id: burgerBranch, code: 'burger' },
      brand: { name: 'Smash & Co', nameAr: 'سماش آند كو', primaryColor: '#d7261e', accentColor: '#ffd23f', inkColor: '#17120f', paperColor: '#fff8ed' },
      links: { site: `/r/${tenant.slug}`, order: `/order/${tenant.slug}?branch=burger` },
    });
    expect(pub.body.brand.heroUrl).toMatch(/^http/);
    expect(JSON.stringify(pub.body)).not.toMatch(/cost|qr_?token|internal/i);
  });

  it('validates slugs, colours and references, and keeps slugs unique per restaurant', async () => {
    const put = (body: object, branch = burgerBranch) => t.http.put(`${studio()}/storefronts/${branch}`).set(auth(tenant.owner)).send(body);
    expect((await put(brand({ slug: 'revalidate' }))).status).toBe(400);
    expect((await put(brand({ slug: 'Bad Slug' }))).status).toBe(400);
    expect((await put(brand({ theme: { primaryColor: 'red', accentColor: '#ffd23f' } }))).status).toBe(400);
    expect((await put(brand({ heroMediaId: randomUUID() }))).status).toBe(422);
    expect((await put(brand({ content: { sections: [{ categoryId: randomUUID() }] } }))).status).toBe(422);
    expect((await put(brand(), tenant.branchId)).status).toBe(409);
    expect((await put(brand(), randomUUID())).status).toBe(404);
  });

  it('goes offline again when the restaurant website is taken back to draft', async () => {
    expect((await publish()).status).toBeLessThan(300);
    expect((await t.http.get(`/v1/public/sites/${tenant.slug}/storefronts/smash-and-co`)).status).toBe(200);
    await sql(`update websites set status = 'draft' where org_id = $1`, [tenant.orgId]);
    try {
      expect((await t.http.get(`/v1/public/sites/${tenant.slug}`)).status).toBe(404);
      expect((await t.http.get(`/v1/public/sites/${tenant.slug}/storefronts/smash-and-co`)).status).toBe(404);
    } finally {
      await sql(`update websites set status = 'published' where org_id = $1`, [tenant.orgId]);
    }
    expect((await t.http.get(`/v1/public/sites/${tenant.slug}/storefronts/smash-and-co`)).status).toBe(200);
  });

  it('lists published storefronts on the restaurant website', async () => {
    expect((await publish()).status).toBeLessThan(300);
    const site = await t.http.get(`/v1/public/sites/${tenant.slug}`);
    expect(site.status).toBe(200);
    expect(site.body.storefronts).toEqual([expect.objectContaining({ slug: 'smash-and-co', branchCode: 'burger', name: 'Smash & Co', path: `/r/${tenant.slug}/smash-and-co` })]);
    expect(site.body.org.demo).toBe(false);
  });

  it('keeps the restaurant highlights to dishes of its own concept, not dishes sold only under a storefront brand (DF-09)', async () => {
    const site = await t.http.get(`/v1/public/sites/${tenant.slug}`);
    const names = site.body.menuHighlights.map((m: any) => m.name);
    expect(names).toContain('Seabass');
    expect(names).not.toContain('Classic Smash');
  });

  it('never highlights a dish no active branch sells, even when it was pinned', async () => {
    const [ghost] = await sql(`insert into products(org_id, category_id, name, price_minor, currency, station) values ($1, $2, 'Retired special', 9000, 'EGP', 'Grill') returning id`, [tenant.orgId, burgersCat]);
    await sql(`insert into product_branch_settings(org_id, product_id, branch_id, is_available) values ($1, $2, $3, false), ($1, $2, $4, false)`, [tenant.orgId, ghost.id, tenant.branchId, burgerBranch]);
    const ws = await t.http.get(`${studio()}/website`).set(auth(tenant.owner));
    const hl = ws.body.sections.find((s: any) => s.kind === 'menu_highlights');
    expect((await t.http.patch(`${studio()}/website/sections/${hl.id}`).set(auth(tenant.owner)).send({ content: { productIds: [ghost.id, burger, mainDish] } })).status).toBe(200);
    await publish();
    const site = await t.http.get(`/v1/public/sites/${tenant.slug}`);
    // The owner's pins are kept (Classic Smash is sold at the burger bar), the dish nobody sells is dropped.
    expect(site.body.menuHighlights.map((m: any) => m.name)).toEqual(['Classic Smash', 'Seabass']);
  });

  it('tells guests the branch district in both languages and its opening hours and time zone (PAR-02)', async () => {
    const path = `/v1/public/sites/${tenant.slug}/storefronts/smash-and-co`;
    expect((await publish()).status).toBeLessThan(300);
    // A branch without a district says so (null), it does not invent one.
    expect((await t.http.get(path)).body.branch).toMatchObject({ district: null, districtAr: null });
    const hours = [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, opens: '11:00', closes: '00:00' }));
    const patch = await t.http.patch(`/v1/o/${tenant.orgId}/branches/${burgerBranch}`).set(auth(tenant.owner))
      .send({ district: ' Downtown ', districtAr: 'وسط البلد', timezone: 'Africa/Cairo', openingHours: hours });
    expect(patch.status).toBe(200);
    expect(patch.body).toMatchObject({ district: 'Downtown', districtAr: 'وسط البلد' });
    const pub = await t.http.get(path);
    expect(pub.body.branch).toMatchObject({ district: 'Downtown', districtAr: 'وسط البلد', timezone: 'Africa/Cairo', openingHours: hours });
    // Clearing the field stores null (never an empty string), and over-long names are refused.
    expect((await t.http.patch(`/v1/o/${tenant.orgId}/branches/${burgerBranch}`).set(auth(tenant.owner)).send({ districtAr: '' })).body.districtAr).toBeNull();
    expect((await t.http.patch(`/v1/o/${tenant.orgId}/branches/${burgerBranch}`).set(auth(tenant.owner)).send({ district: 'x'.repeat(81) })).status).toBe(400);
    expect((await t.http.get(path)).body.branch).toMatchObject({ district: 'Downtown', districtAr: null });
  });

  it('marks the demo tenant so the site can label it an example restaurant', async () => {
    await sql(`update organizations set onboarding = onboarding || '{"demo": true}'::jsonb where id = $1`, [tenant.orgId]);
    expect((await t.http.get(`/v1/public/sites/${tenant.slug}`)).body.org.demo).toBe(true);
    expect((await t.http.get(`/v1/public/sites/${tenant.slug}/storefronts/smash-and-co`)).body.org.demo).toBe(true);
    await sql(`update organizations set onboarding = onboarding - 'demo' where id = $1`, [tenant.orgId]);
  });

  it('lets only studio publishers save storefronts; branch-scoped staff cannot read other branches', async () => {
    const kitchen = await addMember(t, tenant, 'kitchen', [tenant.branchId]);
    expect((await t.http.put(`${studio()}/storefronts/${burgerBranch}`).set(auth(kitchen)).send(brand())).status).toBe(403);
    const marketing = await addMember(t, tenant, 'marketing', [tenant.branchId]);
    expect((await t.http.get(`${studio()}/storefronts/${burgerBranch}`).set(auth(marketing))).status).toBe(404);
    const other = await createTenant(t);
    expect((await t.http.get(`/v1/o/${other.orgId}/studio/storefronts/${burgerBranch}`).set(auth(other.owner))).status).toBe(404);
  });
});
