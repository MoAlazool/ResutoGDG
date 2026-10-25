import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { JwtService } from '../src/common/auth/jwt.service';
import { planStudioEdit, westernDigits } from '../src/modules/studio/ai/studio-edit-planner';
import { addMember, auth, bootTestApp, createTenant, seedMenu, sql, unique, type SeededMenu, type TestApp, type TestTenant, type TestUser } from './helpers';

// 21-STUDIO: the new section kinds (validation, rendering on the public site), templates, the product.discount.set
// change-set op and AI-assisted editing through change sets (rules planner → change set → canvas preview → approve →
// apply → publish by a person). Real database, real modules.

let t: TestApp;
let a: TestTenant;
let b: TestTenant;
let menu: SeededMenu;
let menuB: SeededMenu;
let manager: TestUser;
let marketing: TestUser;
let waiter: TestUser;
let jwt: JwtService;

const studio = (x: TestTenant) => `/v1/o/${x.orgId}/studio`;
const changeSets = (x: TestTenant) => `/v1/o/${x.orgId}/change-sets`;
const addSection = (u: TestUser, body: object, x = a) => t.http.post(`${studio(x)}/website/sections`).set(auth(u)).send(body);
const propose = (u: TestUser, body: object, x = a, key = unique('cs')) => t.http.post(changeSets(x)).set(auth(u)).set('Idempotency-Key', key).send(body);
const aiPropose = (u: TestUser, body: object, x = a, key = unique('ai')) => t.http.post(`${studio(x)}/ai/proposals`).set(auth(u)).set('Idempotency-Key', key).send(body);
const approve = (u: { token: string }, id: string, body: object = {}, x = a) => t.http.post(`${changeSets(x)}/${id}/approve`).set(auth(u)).send(body);
const publish = (u: TestUser, x = a) => t.http.post(`${studio(x)}/website/publish`).set(auth(u)).send({ key: unique('pub') });
const publicSite = (x: TestTenant) => t.http.get(`/v1/public/sites/${x.slug}`);
const price = async (id: string) => (await sql('select price_minor, compare_at_price_minor from products where id = $1', [id]))[0];
const discountOp = (productId: string, discountBps: number) => ({ type: 'product.discount.set', input: { productId, discountBps } });
/** A regular price edit in the menu editor (with the version it loaded). */
const editPrice = async (id: string, priceMinor: number) => {
  const [{ version }] = await sql('select version from products where id = $1', [id]);
  const res = await t.http.patch(`/v1/o/${a.orgId}/menu/products/${id}`).set(auth(a.owner)).send({ priceMinor, version });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
};

beforeAll(async () => {
  t = await bootTestApp();
  jwt = t.app.get(JwtService);
  a = await createTenant(t, { name: 'Studio Grill' });
  b = await createTenant(t, { name: 'Other Grill' });
  menu = await seedMenu(a);
  menuB = await seedMenu(b);
  manager = await addMember(t, a, 'manager');
  marketing = await addMember(t, a, 'marketing');
  waiter = await addMember(t, a, 'waiter');
  await sql(`update branches set opening_hours = $2, address = '12 Nile St', city = 'Cairo', phone = '+201001234567', accepts_pickup = true where id = $1`,
    [a.branchId, JSON.stringify([{ day: 5, opens: '12:00', closes: '23:00' }])]);
});
afterAll(async () => { await t?.close(); });

describe('new section kinds', () => {
  it('adds promo_banner, offers, social, faq and menu_full sections with their own fields', async () => {
    const bodies = [
      { kind: 'promo_banner', content: { headline: { en: 'Eid nights', ar: 'ليالي العيد' }, badge: { en: 'New' }, promotionCode: 'EIDNIGHT', layout: { tone: 'accent', align: 'center' } } },
      { kind: 'offers', content: { headline: { en: 'Offers' }, productIds: [menu.products.fries, menu.products.soda], badge: { en: 'Eid special' } } },
      { kind: 'social', content: { headline: { en: 'Follow us', ar: 'تابعونا' } } },
      { kind: 'faq', content: { items: [{ title: { en: 'Do you deliver?' }, body: { en: 'Yes, across Zamalek.' } }] } },
      { kind: 'menu_full', content: { categoryIds: [menu.categoryId], layout: { columns: 3, spacing: 'compact' } } },
    ];
    for (const body of bodies) {
      const res = await addSection(a.owner, body);
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      expect(res.body).toMatchObject({ kind: body.kind, isVisible: true });
    }
  });

  it('refuses fields a kind cannot show and FAQ entries without an answer (400 with the field path)', async () => {
    const wrong = await addSection(a.owner, { kind: 'faq', content: { productIds: [menu.products.fries] } });
    expect(wrong.status).toBe(400);
    expect(wrong.body.error.code).toBe('validation_failed');
    expect(JSON.stringify(wrong.body.error.details)).toContain('content.productIds');
    const noAnswer = await addSection(a.owner, { kind: 'faq', content: { items: [{ title: { en: 'Parking?' } }] } });
    expect(noAnswer.status).toBe(400);
    expect(JSON.stringify(noAnswer.body.error.details)).toContain('content.items.0.body');
    const badLayout = await addSection(a.owner, { kind: 'offers', content: { layout: { columns: 7 } } });
    expect(badLayout.status).toBe(400);
    const badCode = await addSection(a.owner, { kind: 'offers', content: { promotionCode: 'no spaces!' } });
    expect(badCode.status).toBe(400);
  });

  it('checks an edit against the section kind (422 section_content_invalid) and references against this restaurant', async () => {
    const faq = (await addSection(a.owner, { kind: 'faq', content: {} })).body;
    const edit = await t.http.patch(`${studio(a)}/website/sections/${faq.id}`).set(auth(a.owner)).send({ content: { mediaIds: [] , categoryIds: [menu.categoryId] } });
    expect(edit.status).toBe(422);
    expect(edit.body.error.code).toBe('section_content_invalid');
    // Another restaurant's category or dish is refused.
    const cat = await addSection(a.owner, { kind: 'menu_full', content: { categoryIds: [menuB.categoryId] } });
    expect(cat.status).toBe(422);
    expect(cat.body.error.code).toBe('unknown_category');
    const dish = await addSection(a.owner, { kind: 'offers', content: { productIds: [menuB.products.fries] } });
    expect(dish.status).toBe(422);
    expect(dish.body.error.code).toBe('unknown_product');
    await t.http.delete(`${studio(a)}/website/sections/${faq.id}`).set(auth(a.owner));
  });

  it('refuses people without studio:write, other restaurants and anonymous callers', async () => {
    expect((await addSection(waiter, { kind: 'social', content: {} })).status).toBe(403);
    // Another restaurant's owner is not told this one exists (404, as everywhere).
    expect((await addSection(b.owner, { kind: 'social', content: {} })).status).toBe(404);
    expect((await t.http.post(`${studio(a)}/website/sections`).send({ kind: 'social', content: {} })).status).toBe(401);
    expect((await t.http.post(`${studio(a)}/website/template`).set(auth(waiter)).send({ family: 'bistro', variant: 'full' })).status).toBe(403);
    // A plan without the Studio module cannot use it.
    const starter = await createTenant(t, { name: 'Starter Grill', planId: 'starter' });
    const res = await addSection(starter.owner, { kind: 'faq', content: {} }, starter);
    expect(res.status).toBe(402);
    expect(res.body.error.code).toBe('module_not_entitled');
    expect((await aiPropose(starter.owner, { prompt: 'Add a FAQ section' }, starter)).status).toBe(402);
  });
});

describe('templates', () => {
  it('applies a style family and adds the layout’s missing sections without deleting any', async () => {
    const before = (await t.http.get(`${studio(a)}/website`).set(auth(a.owner))).body;
    const res = await t.http.post(`${studio(a)}/website/template`).set(auth(a.owner)).send({ family: 'street_food', variant: 'offers_led' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.website).toMatchObject({ template: 'smash', theme: { primaryColor: '#b51218', font: 'manrope' } });
    const kinds = res.body.sections.map((s: any) => s.kind);
    for (const k of ['promo_banner', 'hero', 'offers', 'menu_highlights', 'ordering', 'faq', 'social']) expect(kinds).toContain(k);
    expect(res.body.sections.length).toBe(before.sections.length + res.body.addedSectionIds.length);
    for (const s of before.sections) expect(res.body.sections.map((x: any) => x.id)).toContain(s.id);
    const again = await t.http.post(`${studio(a)}/website/template`).set(auth(a.owner)).send({ family: 'street_food', variant: 'offers_led' });
    expect(again.body.addedSectionIds).toEqual([]);
    expect((await t.http.post(`${studio(a)}/website/template`).set(auth(a.owner)).send({ family: 'nope_family', variant: 'full' })).body.error.code).toBe('unknown_template');
    // Back to the olive renderer for the rest of the file.
    await t.http.post(`${studio(a)}/website/template`).set(auth(a.owner)).send({ family: 'bistro', variant: 'full', addSections: false });
  });
});

describe('public site renders the new kinds from live data', () => {
  it('offers show dishes with their was-price and a live promotion badge; the full menu lists categories; no cost leaks', async () => {
    await sql(`insert into promotions(org_id, code, name, kind, value) values ($1, 'EIDNIGHT', 'Eid nights', 'percent', 1000)`, [a.orgId]);
    await sql('update products set price_minor = 3825, compare_at_price_minor = 4500 where id = $1', [menu.products.fries]);
    await sql(`update organizations set social_links = $2 where id = $1`, [a.orgId, JSON.stringify({ instagram: 'https://instagram.com/studiogrill' })]);
    expect((await publish(a.owner)).status).toBe(200);
    const site = (await publicSite(a)).body;
    const offers = site.sections.find((s: any) => s.kind === 'offers');
    expect(offers.content.products.map((p: any) => p.id)).toEqual([menu.products.fries, menu.products.soda]);
    expect(offers.content.products[0]).toMatchObject({ priceMinor: 3825, compareAtMinor: 4500 });
    expect(offers.content.products[1].compareAtMinor).toBeNull();
    const banner = site.sections.find((s: any) => s.kind === 'promo_banner');
    expect(banner.content.promotion).toMatchObject({ code: 'EIDNIGHT', kind: 'percent', value: 1000 });
    const full = site.sections.find((s: any) => s.kind === 'menu_full');
    expect(full.content.menu[0]).toMatchObject({ id: menu.categoryId, name: 'Mains' });
    expect(full.content.menu[0].items.map((p: any) => p.name)).toContain('Smash burger');
    expect(site.org.socialLinks).toEqual({ instagram: 'https://instagram.com/studiogrill' });
    expect(JSON.stringify(site)).not.toMatch(/cost_?minor|"cost"|stock_qty|redemption/i);
    // An inactive or expired promotion is not shown as a badge.
    await sql(`update promotions set is_active = false where org_id = $1 and code = 'EIDNIGHT'`, [a.orgId]);
    expect((await publicSite(a)).body.sections.find((s: any) => s.kind === 'promo_banner').content.promotion).toBeNull();
    // A later regular price edit ends the discount (the was-price would no longer be true).
    await editPrice(menu.products.fries, 4000);
    expect(await price(menu.products.fries)).toMatchObject({ price_minor: 4000, compare_at_price_minor: null });
    await sql('update products set price_minor = 4500 where id = $1', [menu.products.fries]);
  });
});

describe('change-set op product.discount.set', () => {
  it('proposes a dish discount for approval (prices group), applies it from the original price and removes it with 0', async () => {
    const res = await propose(manager, { title: 'Burger 20%', ops: [discountOp(menu.products.burger, 2000)] });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body).toMatchObject({ status: 'pending_approval', policy: { mode: 'approval', groups: { prices: 'approval' } } });
    const [op] = res.body.ops;
    expect(op).toMatchObject({ type: 'product.discount.set', group: 'prices', target: { type: 'product', id: menu.products.burger },
      before: { priceMinor: 18500, compareAtMinor: null }, after: { priceMinor: 14800, compareAtMinor: 18500, discountBps: 2000 } });
    expect(op.summary).toBe('Put "Smash burger" at 20% off: 148.00 EGP instead of 185.00 EGP');
    expect(await price(menu.products.burger)).toMatchObject({ price_minor: 18500, compare_at_price_minor: null });
    const ok = await approve(a.owner, res.body.id, { previewDigest: res.body.previewDigest });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.status).toBe('applied');
    expect(await price(menu.products.burger)).toMatchObject({ price_minor: 14800, compare_at_price_minor: 18500 });
    // A second discount starts from the original price, not the discounted one.
    const second = (await propose(manager, { title: 'Burger 10%', ops: [discountOp(menu.products.burger, 1000)] })).body;
    expect((await approve(a.owner, second.id)).body.status).toBe('applied');
    expect(await price(menu.products.burger)).toMatchObject({ price_minor: 16650, compare_at_price_minor: 18500 });
    const end = (await propose(manager, { title: 'End', ops: [discountOp(menu.products.burger, 0)] })).body;
    expect((await approve(a.owner, end.id)).body.status).toBe('applied');
    expect(await price(menu.products.burger)).toMatchObject({ price_minor: 18500, compare_at_price_minor: null });
    const audit = await sql(`select action from audit_logs where entity_type = 'product' and entity_id = $1 and action = 'menu.product.discount_set'`, [menu.products.burger]);
    expect(audit).toHaveLength(3);
  });

  it('keeps discounts in bounds and refuses removing a discount that does not exist', async () => {
    for (const bps of [50, 9500]) {
      const r = await propose(manager, { title: 'bad', ops: [discountOp(menu.products.fries, bps)] });
      expect(r.status).toBe(422);
      expect(r.body.error.code).toBe('discount_out_of_bounds');
    }
    expect((await propose(manager, { title: 'bad', ops: [discountOp(menu.products.fries, 10001)] })).status).toBe(400);
    const none = await propose(manager, { title: 'none', ops: [discountOp(menu.products.fries, 0)] });
    expect(none.status).toBe(422);
    expect(none.body.error.code).toBe('no_discount');
  });

  it('refuses another restaurant’s dish and proposers without menu:write; stores nothing', async () => {
    const before = (await sql('select count(*)::int as n from change_sets where org_id = $1', [a.orgId]))[0].n;
    const cross = await propose(manager, { title: 'cross', ops: [discountOp(menuB.products.fries, 1500)] });
    expect(cross.status).toBe(404);
    expect((await price(menuB.products.fries)).price_minor).toBe(4500);
    const noPerm = await propose(marketing, { title: 'mkt', ops: [discountOp(menu.products.fries, 1500)] });
    expect(noPerm.status).toBe(403);
    expect((await sql('select count(*)::int as n from change_sets where org_id = $1', [a.orgId]))[0].n).toBe(before);
    // A set of tenant A cannot be approved through tenant B.
    const own = (await propose(manager, { title: 'own', ops: [discountOp(menu.products.soda, 1500)] })).body;
    expect((await approve(b.owner, own.id, {}, b)).status).toBe(404);
    await t.http.post(`${changeSets(a)}/${own.id}/reject`).set(auth(a.owner)).send({});
  });

  it('invalidates the set when the dish changed after the proposal (never merged)', async () => {
    const cs = (await propose(manager, { title: 'stale', ops: [discountOp(menu.products.soda, 1500)] })).body;
    await editPrice(menu.products.soda, 2700);
    const res = await approve(a.owner, cs.id);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('change_set_invalidated');
    expect((await t.http.get(`${changeSets(a)}/${cs.id}`).set(auth(a.owner))).body.status).toBe('invalidated');
    expect(await price(menu.products.soda)).toMatchObject({ price_minor: 2700, compare_at_price_minor: null });
    await sql('update products set price_minor = 2500 where id = $1', [menu.products.soda]);
  });

  it('needs the owner above the discount threshold and an aal2 session from an approver with a verified factor', async () => {
    const big = (await propose(manager, { title: 'big', ops: [discountOp(menu.products.fries, 4000)] })).body;
    expect(big.policy.requiresOwner).toBe(true);
    const mgr2 = await addMember(t, a, 'manager');
    expect((await approve(mgr2, big.id)).body.error.code).toBe('owner_approval_required');
    await sql(`insert into auth.mfa_factors(user_id, friendly_name, factor_type, status) values ($1, 'Authenticator app', 'totp', 'verified')`, [a.owner.userId]);
    const weak = await approve(a.owner, big.id);
    expect(weak.status).toBe(403);
    expect(weak.body.error.code).toBe('mfa_required');
    const strong = { token: await jwt.issue(a.owner.userId, a.owner.email, 600, { aal: 'aal2' }) };
    const ok = await approve(strong, big.id);
    expect(ok.body.status).toBe('applied');
    const [decision] = await sql('select aal from change_decisions where change_set_id = $1', [big.id]);
    expect(decision.aal).toBe('aal2');
    await sql(`delete from auth.mfa_factors where user_id = $1`, [a.owner.userId]);
    const end = (await propose(manager, { title: 'end', ops: [discountOp(menu.products.fries, 0)] })).body;
    await approve(a.owner, end.id);
  });
});

describe('AI-assisted editing through change sets', () => {
  it('turns "Eid offers with these 3 dishes at 15% off" into one pending change set; the canvas preview shows it; approval applies it; nothing is published', async () => {
    const live = (await t.http.get(`${studio(a)}/website`).set(auth(a.owner))).body.website.publishedRevision;
    const products = [menu.products.burger, menu.products.fries, menu.products.soda];
    const res = await aiPropose(manager, { prompt: 'Add an Eid offers section with these 3 products at 15% off', productIds: products });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const cs = res.body.changeSet;
    expect(res.body.plan).toMatchObject({ planner: 'resuto_rules', model: null });
    expect(cs).toMatchObject({ origin: 'studio_ai', status: 'pending_approval', title: 'Eid offers', proposedBy: manager.userId });
    expect(cs.ops.map((o: any) => o.type)).toEqual(['website.section.add', 'product.discount.set', 'product.discount.set', 'product.discount.set']);
    expect(cs.ops.map((o: any) => o.type)).not.toContain('website.publish');
    expect(cs.ops[0].input).toMatchObject({ kind: 'offers', content: { headline: { en: 'Eid offers', ar: 'عروض العيد' }, productIds: products,
      badge: { en: '15% off', ar: 'خصم 15%' } } });

    // Canvas preview: the draft with the proposed section and the discounted prices, nothing written.
    const pv = await t.http.get(`${studio(a)}/website/preview/change-sets/${cs.id}`).set(auth(manager));
    expect(pv.status, JSON.stringify(pv.body)).toBe(200);
    expect(pv.body.diff).toEqual({ changeSetId: cs.id, added: [cs.ops[0].id], changed: [], repriced: products });
    const proposed = pv.body.sections.find((s: any) => s.id === cs.ops[0].id);
    expect(proposed.content.products.map((p: any) => [p.id, p.priceMinor, p.compareAtMinor])).toEqual([
      [menu.products.burger, 15725, 18500], [menu.products.fries, 3825, 4500], [menu.products.soda, 2125, 2500]]);
    expect(await price(menu.products.burger)).toMatchObject({ price_minor: 18500, compare_at_price_minor: null });
    // Another restaurant cannot read the preview; someone without changes:read who did not propose it cannot either.
    expect((await t.http.get(`${studio(b)}/website/preview/change-sets/${cs.id}`).set(auth(b.owner))).status).toBe(404);

    const ok = await approve(a.owner, cs.id, { previewDigest: cs.previewDigest });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.status).toBe('applied');
    expect(await price(menu.products.fries)).toMatchObject({ price_minor: 3825, compare_at_price_minor: 4500 });
    const draft = (await t.http.get(`${studio(a)}/website`).set(auth(a.owner))).body;
    expect(draft.sections.some((s: any) => s.kind === 'offers' && s.content.headline?.en === 'Eid offers')).toBe(true);
    expect(draft.website.publishedRevision).toBe(live);
    expect(draft.website.hasUnpublishedChanges).toBe(true);
    // After applying, the preview is the draft itself with the section the set created marked (no double overlay).
    const created = draft.sections.find((s: any) => s.kind === 'offers' && s.content.headline?.en === 'Eid offers').id;
    const after = (await t.http.get(`${studio(a)}/website/preview/change-sets/${cs.id}`).set(auth(manager))).body;
    expect(after.diff.added).toEqual([created]);
    expect(after.sections.filter((s: any) => s.content.headline?.en === 'Eid offers')).toHaveLength(1);
    expect(after.sections.find((s: any) => s.id === created).content.products[0]).toMatchObject({ priceMinor: 15725, compareAtMinor: 18500 });
    // Publishing is a separate, explicit step.
    const pub = await publish(a.owner);
    expect(pub.status).toBe(200);
    const site = (await publicSite(a)).body;
    expect(site.sections.some((s: any) => s.kind === 'offers' && s.content.headline?.en === 'Eid offers')).toBe(true);
    for (const p of products) {
      const end = (await propose(manager, { title: 'end', ops: [discountOp(p, 0)] })).body;
      await approve(a.owner, end.id);
    }
  });

  it('creates an offer code instead of dish discounts when the request names one, and replays per Idempotency-Key', async () => {
    const key = unique('ai-code');
    const body = { prompt: 'Add a Ramadan offers banner: 20% off with code IFTAR20', locale: 'en' };
    const first = await aiPropose(manager, body, a, key);
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    const ops = first.body.changeSet.ops;
    expect(ops.map((o: any) => o.type)).toEqual(['website.section.add', 'promotion.create']);
    expect(ops[0].input).toMatchObject({ kind: 'promo_banner', content: { promotionCode: 'IFTAR20', headline: { en: 'Ramadan offers' } } });
    expect(ops[1].input).toMatchObject({ code: 'IFTAR20', kind: 'percent', value: 2000 });
    const replay = await aiPropose(manager, body, a, key);
    expect(replay.body.changeSet).toMatchObject({ id: first.body.changeSet.id, replayed: true });
    // The canvas shows the badge of the offer the set creates.
    const pv = (await t.http.get(`${studio(a)}/website/preview/change-sets/${first.body.changeSet.id}`).set(auth(manager))).body;
    expect(pv.sections.find((s: any) => s.id === ops[0].id).content.promotion).toMatchObject({ code: 'IFTAR20', value: 2000 });
    await t.http.post(`${changeSets(a)}/${first.body.changeSet.id}/reject`).set(auth(a.owner)).send({});
    // A rejected set can still be looked at as it was proposed.
    const rejected = (await t.http.get(`${studio(a)}/website/preview/change-sets/${first.body.changeSet.id}`).set(auth(manager))).body;
    expect(rejected.sections.some((s: any) => s.id === ops[0].id)).toBe(true);
  });

  it('answers FAQ requests from branch data, refuses unclear or unauthorised requests and other restaurants’ dishes', async () => {
    const faq = await aiPropose(manager, { prompt: 'Add a FAQ section', locale: 'en' });
    expect(faq.status).toBe(201);
    const items = faq.body.changeSet.ops[0].input.content.items;
    expect(items[0]).toEqual({ title: { en: 'When are you open?', ar: 'ما مواعيد العمل؟' }, body: { en: 'Friday 12:00–23:00', ar: 'الجمعة 12:00–23:00' } });
    expect(JSON.stringify(items)).toContain('12 Nile St, Cairo');
    await t.http.post(`${changeSets(a)}/${faq.body.changeSet.id}/reject`).set(auth(a.owner)).send({});

    const unclear = await aiPropose(manager, { prompt: 'make it nicer please' });
    expect(unclear.status).toBe(422);
    expect(unclear.body.error.code).toBe('ai_request_unclear');
    const cross = await aiPropose(manager, { prompt: 'Eid offers at 15% off', productIds: [menuB.products.fries] });
    expect(cross.status).toBe(422);
    expect(cross.body.error.code).toBe('unknown_product');
    // Marketing may edit the website but not prices: the discount part refuses the whole set.
    const mkt = await aiPropose(marketing, { prompt: 'Eid offers with these at 15% off', productIds: [menu.products.fries] });
    expect(mkt.status).toBe(403);
    expect((await aiPropose(waiter, { prompt: 'Add a FAQ section' })).status).toBe(403);
    expect((await t.http.post(`${studio(a)}/ai/proposals`).set(auth(manager)).send({ prompt: 'Add a FAQ section' })).body.error.code).toBe('idempotency_key_required');
    expect((await aiPropose(b.owner, { prompt: 'Add a FAQ section' })).status).toBe(404);
  });
});

describe('rules planner (unit)', () => {
  const ctx = {
    restaurant: { name: 'R', nameAr: null }, sections: [{ id: '00000000-0000-4000-8000-000000000001', kind: 'hero', content: { headline: { en: 'Old' } } }],
    products: [{ id: '00000000-0000-4000-8000-0000000000a1', name: 'Koshari', nameAr: 'كشري' }, { id: '00000000-0000-4000-8000-0000000000a2', name: 'Feteer', nameAr: 'فطير' }],
    branches: [],
  };
  it('reads Arabic requests with Arabic-Indic digits and dish names', () => {
    const plan = planStudioEdit({ prompt: 'أضف قسم عروض العيد على الكشري والفطير بخصم ١٥٪', locale: 'ar' }, ctx);
    expect(plan.ops.map((o) => o.type)).toEqual(['website.section.add', 'product.discount.set', 'product.discount.set']);
    expect((plan.ops[1]!.input as any).discountBps).toBe(1500);
    expect(westernDigits('٠١٢٣٤٥٦٧٨٩۰۹')).toBe('012345678909');
  });
  it('retitles an existing section and never proposes publishing', () => {
    const plan = planStudioEdit({ prompt: 'Change the hero headline to "Fresh every day"', locale: 'en' }, ctx);
    expect(plan.ops).toEqual([{ type: 'website.section.update', input: { sectionId: ctx.sections[0]!.id, content: { headline: { en: 'Fresh every day' } } } }]);
    for (const prompt of ['Add offers and publish the website', 'publish now with 10% off the Koshari']) {
      expect(planStudioEdit({ prompt, locale: 'en' }, ctx).ops.map((o) => o.type)).not.toContain('website.publish');
    }
  });
  it('does not mistake "QR code" for an offer code', () => {
    const plan = planStudioEdit({ prompt: 'Add offers for the QR code menu at 10% off the Koshari', locale: 'en' }, ctx);
    expect(plan.ops.map((o) => o.type)).toEqual(['website.section.add', 'product.discount.set']);
  });
});
