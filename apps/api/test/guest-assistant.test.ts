import type { PublicMenu, PublicMenuProduct } from '@resuto/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { candidates, courseOf, planMeal, suggest, understand } from '../src/modules/guest/menu-assistant';
import { addMember, auth, bootTestApp, createTenant, seedMenu, sql, type SeededMenu, type TestApp, type TestTenant, type TestUser } from './helpers';
import { key, qrTokenFor, saveFloor, table } from './ops-fixtures';

// VP-20 / FT-20: "Help me choose" and cart suggestions are deterministic rules over the live menu and this branch's
// order history — no generative model, nothing metered, only real available dishes. VP-21 / FT-21 / VS-27: ratings
// after payment, read back as guest satisfaction in Analytics.

const p = (id: string, name: string, priceMinor: number, extra: Partial<PublicMenuProduct> = {}): PublicMenuProduct => ({
  id, name, nameAr: null, description: null, descriptionAr: null, priceMinor, imageUrl: null, allergens: [], dietary: [], spiceLevel: 0,
  available: true, prepMinutes: 15, modifierGroups: [], ...extra,
});
const menuOf = (cats: Array<[string, string | null, PublicMenuProduct[]]>): PublicMenu => ({
  org: { name: 'R', nameAr: null, currency: 'EGP', slug: 'r' },
  branch: { id: 'b', code: 'main', name: 'Main', nameAr: null, acceptsDineIn: true, acceptsPickup: true, acceptsDelivery: false, acceptsReservations: true, deliveryFeeMinor: 0, minOrderMinor: 0, address: null, city: null, phone: null },
  branches: [], categories: cats.map(([name, nameAr, products], i) => ({ id: `c${i}`, name, nameAr, products })),
});
const olive = menuOf([
  ['Starters', 'مقبلات', [p('burrata', 'Burrata', 14500, { dietary: ['vegetarian'], allergens: ['milk'] }), p('soup', 'Pumpkin soup', 9500, { dietary: ['vegetarian'] })]],
  ['Mains', 'أطباق رئيسية', [
    p('chicken', 'Grilled chicken', 28500), p('risotto', 'Mushroom risotto', 24500, { dietary: ['vegetarian'], allergens: ['milk'] }),
    p('seabass', 'Seabass', 34500, { allergens: ['fish', 'milk'] }), p('bowl', 'Garden bowl', 18500, { dietary: ['vegan'] }),
    p('chili', 'Chili beef', 26000, { spiceLevel: 2 }), p('gone', 'Sold-out special', 9000, { available: false }),
  ]],
  ['Desserts', 'حلويات', [p('fondant', 'Chocolate fondant', 12500, { allergens: ['milk', 'eggs', 'wheat'] })]],
  ['Drinks', 'مشروبات', [p('hibiscus', 'Hibiscus cooler', 6500), p('lemonade', 'Mint lemonade', 5500)]],
]);
const pop = new Map([['chicken', 40], ['risotto', 30], ['bowl', 10], ['hibiscus', 25], ['soup', 12], ['burrata', 20], ['fondant', 8]]);

describe('reading what the guest asked for', () => {
  it('understands English and Arabic, Arabic-Indic digits and number words', () => {
    expect(understand({ text: 'For three under EGP 1,000, not spicy please' })).toMatchObject({ party: 3, budgetMinor: 100000, mild: true, vegetarian: false });
    expect(understand({ text: 'إحنا ٣ وميزانيتنا ١٠٠٠ ومش عايزين حار' })).toMatchObject({ party: 3, budgetMinor: 100000, mild: true });
    expect(understand({ text: 'لشخصين نباتي بدون مكسرات' })).toMatchObject({ party: 2, vegetarian: true, exclude: ['tree_nuts'], mild: false });
    expect(understand({ text: 'I do not want it spicy' }).mild).toBe(true);
    expect(understand({ text: 'something spicy' }).mild).toBe(false);
    expect(understand({ text: 'احنا اربعة في حدود ٨٠٠ جنيه' })).toMatchObject({ party: 4, budgetMinor: 80000 });
    expect(understand({ text: 'two of us, nut allergy, gluten-free' })).toMatchObject({ party: 2, exclude: ['gluten', 'tree_nuts', 'wheat'] });
    // Mentioning an ingredient is not avoiding it.
    expect(understand({ text: 'extra cheese, no onions' }).exclude).toEqual([]);
    expect(understand({ text: 'I love cheese and want nuts on top' }).exclude).toEqual([]);
  });

  it('a "no" or an "allergy" covers every allergen in the list it introduces or closes (EN and AR)', () => {
    const ex = (text: string) => understand({ text }).exclude;
    expect(ex('no dairy or nuts')).toEqual(['milk', 'tree_nuts']);
    expect(ex('no nuts, dairy or eggs')).toEqual(['eggs', 'milk', 'tree_nuts']);
    expect(ex('without nuts and sesame')).toEqual(['sesame', 'tree_nuts']);
    expect(ex('allergic to milk and peanuts')).toEqual(['milk', 'peanuts']);
    expect(ex("I can't have gluten or shellfish")).toEqual(['gluten', 'shellfish', 'wheat']);
    expect(ex('I can\u2019t eat fish, and also eggs')).toEqual(['eggs', 'fish']);
    expect(ex('nuts and dairy allergy')).toEqual(['milk', 'tree_nuts']);
    expect(ex('dairy, egg and gluten free please')).toEqual(['eggs', 'gluten', 'milk', 'wheat']);
    expect(ex('بدون لبن ومكسرات')).toEqual(['milk', 'tree_nuts']);
    expect(ex('من غير لبن ولا بيض ولا سمسم')).toEqual(['eggs', 'milk', 'sesame']);
    expect(ex('عندي حساسية من الجلوتين والجمبري')).toEqual(['gluten', 'shellfish', 'wheat']);
    expect(ex('بدون سمك أو فول سوداني')).toEqual(['fish', 'peanuts']);
    // The list ends where the guest moves on to something else.
    expect(ex('no onions, extra cheese')).toEqual([]);
    expect(ex('no nuts, I would like cheese')).toEqual(['tree_nuts']);
    expect(ex('عايز جبنة بس بدون مكسرات')).toEqual(['tree_nuts']);
    // And a dish the plan proposes never carries any of them.
    const plan = planMeal(candidates(olive, pop), understand({ text: 'for 4, allergic to fish and dairy' }), 'EGP');
    const byId = new Map(olive.categories.flatMap((c) => c.products).map((x) => [x.id, x]));
    expect(plan.items.length).toBeGreaterThan(0);
    for (const i of plan.items) expect(byId.get(i.productId)!.allergens.filter((a) => a === 'fish' || a === 'milk')).toEqual([]);
  });

  it('explicit choices win over the text', () => {
    // Explicit choices win over the text; nothing said means a table for two with no budget.
    expect(understand({ text: 'for 6', party: 2, vegetarian: true })).toMatchObject({ party: 2, vegetarian: true });
    expect(understand({})).toMatchObject({ party: 2, budgetMinor: null, exclude: [] });
  });

  it('assigns courses from categories, then from the dish name in catch-all categories', () => {
    expect(courseOf({ name: 'Mains', nameAr: null }, { name: 'Cola', nameAr: null })).toBe('drink');
    expect(courseOf({ name: 'Burgers', nameAr: null }, { name: 'Smash burger', nameAr: null })).toBe('main');
    expect(courseOf({ name: 'Menu', nameAr: 'القائمة' }, { name: 'Fries', nameAr: null })).toBe('side');
    expect(courseOf({ name: 'Sweets', nameAr: null }, { name: 'Basbousa', nameAr: null })).toBe('dessert');
  });
});

describe('composing a meal', () => {
  const all = candidates(olive, pop);
  it('one main per guest (different dishes while they last), within budget, from available dishes only', () => {
    const r = planMeal(all, understand({ text: 'for 3 under 1000' }), 'EGP');
    expect(r.mode).toBe('rules');
    expect(r.outcome).toBe('fits');
    expect(r.estimatedTotalMinor).toBeLessThanOrEqual(100000);
    const ids = r.items.map((i) => i.productId);
    expect(ids).not.toContain('gone');
    const mains = r.items.filter((i) => i.reasons.includes('main'));
    expect(mains.reduce((s, i) => s + i.quantity, 0)).toBe(3);
    expect(new Set(mains.map((i) => i.productId)).size).toBe(3);
    expect(r.estimatedTotalMinor).toBe(r.items.reduce((s, i) => s + i.priceMinor * i.quantity, 0));
    // Same question, same answer.
    expect(planMeal(all, understand({ text: 'for 3 under 1000' }), 'EGP')).toEqual(r);
  });

  it('honours vegetarian, not spicy and allergens to avoid', () => {
    const veg = planMeal(all, understand({ text: 'vegetarian for two, no dairy' }), 'EGP');
    for (const i of veg.items) {
      const prod = olive.categories.flatMap((c) => c.products).find((x) => x.id === i.productId)!;
      if (i.reasons.includes('main') || i.reasons.includes('starter')) expect(prod.dietary.some((d) => d === 'vegetarian' || d === 'vegan')).toBe(true);
      expect(prod.allergens).not.toContain('milk');
    }
    expect(veg.items.map((i) => i.productId)).toContain('bowl');
    const mild = planMeal(all, understand({ text: 'for 6, not spicy' }), 'EGP');
    expect(mild.items.map((i) => i.productId)).not.toContain('chili');
  });

  it('says so when even the leanest meal is over budget, and when nothing fits the filters', () => {
    const tight = planMeal(all, understand({ text: 'for 4 under 300' }), 'EGP');
    expect(tight.outcome).toBe('over_budget');
    expect(tight.items.every((i) => i.reasons.includes('main'))).toBe(true);
    const none = planMeal(candidates(menuOf([['Mains', null, [p('steak', 'Steak', 40000)]]]), new Map()), understand({ text: 'vegetarian' }), 'EGP');
    expect(none).toMatchObject({ outcome: 'no_match', items: [], estimatedTotalMinor: 0 });
  });

  it('prices dishes with required options at their cheapest valid choice and returns that choice', () => {
    const burger = p('burger', 'Smash burger', 18500, { modifierGroups: [
      { id: 'size', name: 'Size', nameAr: null, minSelect: 1, maxSelect: 1, options: [
        { id: 'large', name: 'Large', nameAr: null, priceDeltaMinor: 3000, available: true }, { id: 'regular', name: 'Regular', nameAr: null, priceDeltaMinor: 0, available: true }] },
      { id: 'extras', name: 'Extras', nameAr: null, minSelect: 0, maxSelect: 2, options: [{ id: 'cheese', name: 'Cheese', nameAr: null, priceDeltaMinor: 1500, available: true }] },
    ] });
    const r = planMeal(candidates(menuOf([['Burgers', null, [burger]]]), new Map()), understand({ text: 'just me' }), 'EGP');
    expect(r.items).toEqual([expect.objectContaining({ productId: 'burger', priceMinor: 18500, quantity: 1, modifiers: [{ groupId: 'size', optionId: 'regular' }] })]);
  });
});

describe('cart suggestions', () => {
  const all = candidates(olive, pop);
  it('prefers dishes ordered together here, then a drink, then a dessert, never what is already in the cart', () => {
    expect(suggest(all, ['chicken'], new Map([['fondant', 5], ['soup', 1]]))).toMatchObject({ mode: 'pairings', reason: 'together', items: [{ productId: 'fondant' }] });
    expect(suggest(all, ['chicken'], new Map())).toMatchObject({ mode: 'rules', reason: 'drink', items: [{ productId: 'hibiscus' }, { productId: 'lemonade' }] });
    expect(suggest(all, ['chicken', 'hibiscus'], new Map())).toMatchObject({ reason: 'dessert', items: [{ productId: 'fondant' }] });
    expect(suggest(all, ['chicken', 'hibiscus', 'fondant'], new Map())).toEqual({ mode: 'none', reason: null, items: [] });
    expect(suggest(all, [], new Map()).mode).toBe('none');
  });
});

// ---------------------------------------------------------------------------------------------------------------
let t: TestApp;
let tenant: TestTenant;
let menu: SeededMenu;
let cashier: TestUser;
let owner: TestUser;
let qr: string;

beforeAll(async () => {
  t = await bootTestApp();
  tenant = await createTenant(t, { country: 'EG' });
  owner = tenant.owner;
  menu = await seedMenu(tenant);
  cashier = await addMember(t, tenant, 'cashier', [tenant.branchId]);
  const f = await saveFloor(t, tenant, [table('A1', 200, 200, { capacity: 4 })]);
  qr = await qrTokenFor(t, tenant, f.tables[0].id);
});
afterAll(async () => { await t.close(); });

const visitHeader = (token: string) => ({ 'X-Visit-Token': token });

describe('assistant and suggestions over HTTP', () => {
  it('table and web guests get plans and pairings from the live menu and this branch\'s history', async () => {
    const scan = await t.http.post(`/v1/public/tables/${qr}/session`).expect(200);
    await sql(`update product_branch_settings set stock_qty = 0 where product_id = $1`, [menu.products.limited]);
    const plan = await t.http.post('/v1/public/visits/current/assistant').set(visitHeader(scan.body.token)).send({ text: 'إحنا ٢ وميزانيتنا ٧٠٠' });
    expect(plan.status, JSON.stringify(plan.body)).toBe(200);
    expect(plan.body).toMatchObject({ mode: 'rules', understood: { party: 2, budgetMinor: 70000 }, allergenNotice: true });
    const menuIds = [menu.products.burger, menu.products.fries, menu.products.soda];
    expect(plan.body.items.length).toBeGreaterThan(0);
    for (const i of plan.body.items) expect(menuIds).toContain(i.productId);
    expect(plan.body.items.map((i: any) => i.productId)).not.toContain(menu.products.limited);
    // The plan can be quoted as is (required options already chosen).
    const quote = await t.http.post('/v1/public/visits/current/quote').set(visitHeader(scan.body.token))
      .send({ lines: plan.body.items.map((i: any) => ({ productId: i.productId, quantity: i.quantity, modifiers: i.modifiers })) });
    expect(quote.status, JSON.stringify(quote.body)).toBe(200);
    expect(quote.body.totalMinor).toBe(plan.body.estimatedTotalMinor);

    // Two web orders with burger + soda make soda the pairing for a burger.
    const m = await t.http.get(`/v1/public/order/${tenant.slug}`).expect(200);
    const lines = [{ productId: menu.products.burger, quantity: 1, modifiers: [{ groupId: menu.groups.size, optionId: menu.options.regular }] }, { productId: menu.products.soda, quantity: 1 }];
    for (let i = 0; i < 2; i++) {
      const q = await t.http.post(`/v1/public/order/${tenant.slug}/quote`).send({ branchId: m.body.branch.id, fulfillment: 'pickup', lines }).expect(200);
      await t.http.post(`/v1/public/order/${tenant.slug}/orders`).set('Idempotency-Key', key('pair')).send({ branchId: m.body.branch.id, fulfillment: 'pickup',
        payment: 'pay_at_pickup', lines, expectedTotalMinor: q.body.totalMinor, customer: { name: 'Pair', phone: `0100000${4000 + i}` } }).expect(201);
    }
    const s = await t.http.post(`/v1/public/order/${tenant.slug}/suggestions`).send({ productIds: [menu.products.burger] }).expect(200);
    expect(s.body).toMatchObject({ mode: 'pairings', reason: 'together', items: [{ productId: menu.products.soda }] });
    const visitS = await t.http.post('/v1/public/visits/current/suggestions').set(visitHeader(scan.body.token)).send({ productIds: [menu.products.burger] }).expect(200);
    expect(visitS.body.items[0].productId).toBe(menu.products.soda);
    const web = await t.http.post(`/v1/public/order/${tenant.slug}/assistant`).send({ text: 'for 1', budgetMinor: 100000 }).expect(200);
    expect(web.body.items.length).toBeGreaterThan(0);
    expect((await t.http.post(`/v1/public/order/${tenant.slug}/assistant`).send({ party: 99 })).status).toBe(400);
    await sql(`update product_branch_settings set stock_qty = 100 where product_id = $1`, [menu.products.limited]);
  });
});

describe('guest ratings after payment', () => {
  it('a table can rate once its bill is settled, once; staff see it as guest satisfaction', async () => {
    const scan = await t.http.post(`/v1/public/tables/${qr}/session`).expect(200);
    const token = scan.body.token as string;
    const rate = (body: Record<string, unknown>) => t.http.post('/v1/public/visits/current/rating').set(visitHeader(token)).send(body);
    expect((await rate({ overall: 5 })).body.error.code).toBe('not_paid_yet'); // nothing ordered yet
    const q = await t.http.post('/v1/public/visits/current/quote').set(visitHeader(token)).send({ lines: [{ productId: menu.products.fries, quantity: 2 }] });
    await t.http.post('/v1/public/visits/current/orders').set(visitHeader(token)).set('Idempotency-Key', key('rate'))
      .send({ lines: [{ productId: menu.products.fries, quantity: 2 }], expectedTotalMinor: q.body.totalMinor }).expect(201);
    expect((await rate({ overall: 5 })).status).toBe(409); // ordered but unpaid
    await t.http.post(`/v1/o/${tenant.orgId}/visits/${scan.body.visitId}/collect`).set(auth(cashier)).set('Idempotency-Key', key('cash')).send({ method: 'cash' }).expect(201);
    expect((await rate({ overall: 0 })).status).toBe(400);
    const ok = await rate({ overall: 4, food: 5, service: 4, speed: 3, value: 4, comment: 'الأكل ممتاز، الخدمة بطيئة شوية' });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body).toEqual({ ok: true, duplicate: false });
    expect((await rate({ overall: 1 })).body).toEqual({ ok: true, duplicate: true }); // one rating per visit; the first stands
    expect((await t.http.get('/v1/public/visits/current').set(visitHeader(token))).body.rated).toBe(true);
    const [row] = await sql(`select overall, food, comment, source from guest_ratings where visit_id = $1`, [scan.body.visitId]);
    expect(row).toEqual({ overall: 4, food: 5, comment: 'الأكل ممتاز، الخدمة بطيئة شوية', source: 'table' });

    // After staff close the table the token still rates within the day (here: duplicate), but never orders.
    await t.http.post(`/v1/o/${tenant.orgId}/visits/${scan.body.visitId}/close`).set(auth(cashier)).send({ needsCleaning: false });
    expect((await rate({ overall: 2 })).body).toEqual({ ok: true, duplicate: true });
    expect((await t.http.post('/v1/public/visits/current/rating').set(visitHeader('x'.repeat(40))).send({ overall: 5 })).status).toBe(401);

    // Web orders: only once paid or handed over.
    const m = await t.http.get(`/v1/public/order/${tenant.slug}`).expect(200);
    const lines = [{ productId: menu.products.soda, quantity: 1 }];
    const wq = await t.http.post(`/v1/public/order/${tenant.slug}/quote`).send({ branchId: m.body.branch.id, fulfillment: 'pickup', lines }).expect(200);
    const order = await t.http.post(`/v1/public/order/${tenant.slug}/orders`).set('Idempotency-Key', key('web-rate')).send({ branchId: m.body.branch.id,
      fulfillment: 'pickup', payment: 'pay_at_pickup', lines, expectedTotalMinor: wq.body.totalMinor, customer: { name: 'Web', phone: '01000005555' } }).expect(201);
    const ref = order.body.order.publicRef;
    expect((await t.http.post(`/v1/public/order/${tenant.slug}/orders/${ref}/rating`).send({ overall: 5 })).body.error.code).toBe('not_paid_yet');
    await sql(`update orders set status = 'picked_up' where public_ref = $1`, [ref]);
    expect((await t.http.post(`/v1/public/order/${tenant.slug}/orders/${ref}/rating`).send({ overall: 3, comment: 'Cold fries' })).body).toEqual({ ok: true, duplicate: false });
    expect((await t.http.post(`/v1/public/order/${tenant.slug}/orders/0123456789abcdef/rating`).send({ overall: 3 })).status).toBe(404);

    // Analytics: guest satisfaction for the period.
    const [{ today }] = await sql(`select (now() at time zone 'Africa/Cairo')::date::text as today`);
    const a = await t.http.get(`/v1/o/${tenant.orgId}/analytics/ratings?from=${today}&to=${today}`).set(auth(owner)).expect(200);
    expect(a.body).toMatchObject({ count: 2, averages: { overall: 3.5, food: 5, service: 4, speed: 3, value: 4 }, distribution: [0, 0, 1, 1, 0],
      bySource: [{ source: 'table', count: 1, average: 4 }, { source: 'web', count: 1, average: 3 }], meta: { kind: 'measured' } });
    expect(a.body.comments.map((c: any) => c.comment).sort()).toEqual(['Cold fries', 'الأكل ممتاز، الخدمة بطيئة شوية'].sort());
    expect(JSON.stringify(a.body)).not.toMatch(/01000005555|\+20/);
    // Cashiers cannot read analytics.
    expect((await t.http.get(`/v1/o/${tenant.orgId}/analytics/ratings?from=${today}&to=${today}`).set(auth(cashier))).status).toBe(403);
  });
});
