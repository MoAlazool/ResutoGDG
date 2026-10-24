// 21-ONB increment 1 (plan §6.2): Free QR-menu onboarding backend.
//   - setup steps follow the plan and service model (Free: no legal name, floor or payments needed to launch);
//   - social links: validated https links per network, org:manage to change, shown on the public menu and site;
//   - the view-only menu QR (/m/<slug>, SVG + PNG): never an ordering QR, no token;
//   - web address availability with reserved words, and signup refusing a reserved address.
// Every new endpoint has its negative authorization cases here.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addMember, auth, bootTestApp, createTenant, seedMenu, signup, sql, unique, type TestApp, type TestTenant, type TestUser } from './helpers';
import { key } from './ops-fixtures';

let t: TestApp;
let free: TestTenant;
let paid: TestTenant;
let other: TestTenant;
let waiter: TestUser;
let manager: TestUser;
let driver: TestUser;
let host: TestUser;

beforeAll(async () => {
  t = await bootTestApp();
  free = await createTenant(t, { planId: 'free' });
  paid = await createTenant(t, { planId: 'pro' });
  other = await createTenant(t, { planId: 'free' });
  // Free allows two staff accounts (the owner and one more): the waiter. The other roles join the paid restaurant.
  waiter = await addMember(t, free, 'waiter');
  manager = await addMember(t, paid, 'manager');
  driver = await addMember(t, paid, 'driver');
  host = await addMember(t, paid, 'host');
});
afterAll(async () => { await t.close(); });

const O = (tenant: TestTenant, path: string) => `/v1/o/${tenant.orgId}${path}`;
const setup = async (tenant: TestTenant) => {
  const res = await t.http.get(O(tenant, '/setup')).set(auth(tenant.owner));
  expect(res.status).toBe(200);
  return { ...res.body, step: Object.fromEntries(res.body.steps.map((s: any) => [s.step, s])) } as any;
};

describe('setup steps follow the plan and the service model', () => {
  it('on Free, legal name, floor and payments are optional, and launch needs none of them', async () => {
    const s = await setup(free);
    expect(s.planId).toBe('free');
    expect(s.step.floor.required).toBe(false);
    expect(s.step.payments.required).toBe(false);
    // The restaurant name is set at signup: the profile step is done without a legal name, which stays recommended.
    expect(s.step.profile).toMatchObject({ required: true, done: true, detail: { missing: [], optional: ['legalName'] } });
    expect(s.steps.map((x: any) => x.step)).toEqual(['welcome', 'profile', 'branch', 'mode', 'menu', 'floor', 'payments', 'launch']);

    const early = await t.http.post(O(free, '/setup/launch')).set(auth(free.owner)).send({});
    expect(early.status).toBe(409);
    expect(early.body.error.details.missing).toEqual(['branch', 'mode', 'menu']);

    await t.http.patch(O(free, `/branches/${free.branchId}`)).set(auth(free.owner))
      .send({ address: '1 Nile St', openingHours: [{ day: 1, opens: '09:00', closes: '23:00' }] }).expect(200);
    await t.http.put(O(free, `/branches/${free.branchId}/service-mode`)).set(auth(free.owner)).send({ mode: 'tables' }).expect(200);
    await seedMenu(free);
    // No legal name and no tables on the floor (seedMenu adds one table; remove it): still ready on Free.
    await sql(`update dining_tables set is_active = false where branch_id = $1`, [free.branchId]);
    const ready = await setup(free);
    expect(ready.step.floor).toMatchObject({ required: false, done: false });
    expect(ready.ready).toBe(true);
    const launch = await t.http.post(O(free, '/setup/launch')).set(auth(free.owner)).send({});
    expect(launch.status).toBe(200);
    expect(launch.body).toMatchObject({ launched: true, ready: true, status: 'active', planId: 'free' });
  });

  it('on a paid plan the legal name and (for table service) the floor stay required', async () => {
    const s = await setup(paid);
    expect(s.planId).toBe('pro');
    expect(s.step.profile).toMatchObject({ required: true, done: false, detail: { missing: ['legalName'], optional: [] } });
    expect(s.step.floor.required).toBe(true);
    expect(s.step.payments.required).toBe(false);
    // Counter service has no floor to set up, so the floor is not a gate there.
    await t.http.put(O(paid, `/branches/${paid.branchId}/service-mode`)).set(auth(paid.owner)).send({ mode: 'counter' }).expect(200);
    expect((await setup(paid)).step.floor).toMatchObject({ required: false, done: true });
    await t.http.put(O(paid, `/branches/${paid.branchId}/service-mode`)).set(auth(paid.owner)).send({ mode: 'tables' }).expect(200);
  });

  it('a lapsed paid trial gets the Free requirements (it is on Free now)', async () => {
    const lapsed = await createTenant(t, { planId: 'growth' });
    await sql(`update subscriptions set status = 'unpaid' where org_id = $1`, [lapsed.orgId]);
    const s = await setup(lapsed);
    expect(s.planId).toBe('free');
    expect(s.step.floor.required).toBe(false);
    expect(s.step.profile.detail.missing).toEqual([]);
  });

  it('still needs org:manage', async () => {
    expect((await t.http.get(O(paid, '/setup')).set(auth(manager))).status).toBe(403);
    // Another restaurant's owner is not told the restaurant exists.
    expect((await t.http.get(O(free, '/setup')).set(auth(other.owner))).status).toBe(404);
  });
});

describe('social links', () => {
  const put = (tenant: TestTenant, user: TestUser, body: unknown) => t.http.put(O(tenant, '/social-links')).set(auth(user)).send(body as object);

  it('stores normalized https links per network and shows them on the public menu and the org profile', async () => {
    expect((await t.http.get(O(free, '/social-links')).set(auth(free.owner))).body).toEqual({ socialLinks: {} });
    const menuBefore = await t.http.get(`/v1/public/menu/${free.slug}`);
    expect(menuBefore.status).toBe(200);
    expect(menuBefore.body.org.socialLinks).toEqual({});
    const etagBefore = menuBefore.headers.etag;

    const res = await put(free, free.owner, {
      instagram: 'https://www.instagram.com/onb.cafe', facebook: 'https://facebook.com/onbcafe', tiktok: 'https://www.tiktok.com/@onbcafe',
      x: 'https://x.com/onbcafe', snapchat: 'https://www.snapchat.com/add/onbcafe', whatsapp: 'https://wa.me/201001234567',
      google_maps: 'https://maps.app.goo.gl/AbCdEf123', website: 'https://ONB-cafe.example',
    });
    expect(res.status).toBe(200);
    expect(res.body.socialLinks).toEqual({
      instagram: 'https://www.instagram.com/onb.cafe', facebook: 'https://facebook.com/onbcafe', tiktok: 'https://www.tiktok.com/@onbcafe',
      x: 'https://x.com/onbcafe', snapchat: 'https://www.snapchat.com/add/onbcafe', whatsapp: 'https://wa.me/201001234567',
      google_maps: 'https://maps.app.goo.gl/AbCdEf123', website: 'https://onb-cafe.example/',
    });
    expect((await t.http.get(O(free, '/social-links')).set(auth(waiter))).body).toEqual(res.body);
    expect((await t.http.get(O(free, '')).set(auth(free.owner))).body.socialLinks).toEqual(res.body.socialLinks);

    // The public menu shows them, and its ETag changed (a guest's cached copy is revalidated).
    const menu = await t.http.get(`/v1/public/menu/${free.slug}`);
    expect(menu.body.org.socialLinks).toEqual(res.body.socialLinks);
    expect(menu.headers.etag).toBeTruthy();
    expect(menu.headers.etag).not.toBe(etagBefore);

    // PUT replaces the set: a network left out (or sent empty / null) is removed.
    const replaced = await put(free, free.owner, { instagram: 'https://instagram.com/onb.cafe', facebook: '', x: null });
    expect(replaced.body.socialLinks).toEqual({ instagram: 'https://instagram.com/onb.cafe' });
    const [audit] = await sql(`select action, metadata from audit_logs where org_id = $1 and entity_type = 'organization' order by id desc limit 1`, [free.orgId]);
    expect(audit).toMatchObject({ action: 'organization.updated', metadata: { fields: ['socialLinks'], networks: ['instagram'] } });
  });

  it('refuses anything but an https link on the network\'s own hosts', async () => {
    const bad: Array<[string, unknown]> = [
      ['website', 'javascript:alert(1)'],
      ['website', 'JavaScript:alert(document.cookie)'],
      ['website', 'data:text/html,<script>alert(1)</script>'],
      ['website', 'http://onb-cafe.example'],
      ['instagram', 'http://instagram.com/onb'],
      ['website', 'https://user:pass@onb-cafe.example'],
      ['website', 'https://localhost/menu'],
      ['website', 'https://127.0.0.1/'],
      ['website', 'https://onb cafe.example'],
      ['instagram', 'https://facebook.com/onb'],
      ['instagram', 'https://instagram.com.evil.example/onb'],
      ['x', 'https://evil-x.com/onb'],
      ['google_maps', 'https://www.google.com/search?q=onb'],
      ['whatsapp', 'https://wa.me.evil.example/2010'],
      ['facebook', 42],
      ['website', `https://onb.example/${'a'.repeat(400)}`],
    ];
    for (const [network, value] of bad) {
      const res = await put(free, free.owner, { [network]: value });
      expect(res.status, `${network}: ${String(value)}`).toBe(400);
      expect(res.body.error.code).toBe('validation_failed');
    }
    // Unknown networks are refused rather than ignored.
    const unknown = await put(free, free.owner, { myspace: 'https://myspace.com/onb' });
    expect(unknown.status).toBe(400);
    // Nothing above was stored.
    expect((await t.http.get(O(free, '/social-links')).set(auth(free.owner))).body.socialLinks).toEqual({ instagram: 'https://instagram.com/onb.cafe' });
  });

  it('needs org:manage to change, membership to read, and never reaches another restaurant', async () => {
    const body = { website: 'https://evil.example' };
    expect((await put(free, waiter, body)).status).toBe(403);
    expect((await put(paid, manager, body)).status).toBe(403);
    expect((await put(paid, driver, body)).status).toBe(403);
    expect((await put(paid, host, body)).status).toBe(403);
    expect((await put(free, other.owner, body)).status).toBe(404);
    expect((await t.http.put(O(free, '/social-links')).send(body)).status).toBe(401);
    expect((await t.http.get(O(free, '/social-links')).set(auth(other.owner))).status).toBe(404);
    expect((await t.http.get(O(free, '/social-links'))).status).toBe(401);
    // Writing its own links leaves the other restaurant's untouched.
    expect((await put(other, other.owner, body)).status).toBe(200);
    expect((await t.http.get(O(free, '/social-links')).set(auth(free.owner))).body.socialLinks).toEqual({ instagram: 'https://instagram.com/onb.cafe' });
    expect((await t.http.get(`/v1/public/menu/${other.slug}`)).body.org.socialLinks).toEqual({ website: 'https://evil.example/' });
  });

  it('are on the published website payload too', async () => {
    const site = await createTenant(t, { planId: 'pro' });
    await put(site, site.owner, { instagram: 'https://instagram.com/site' }).expect(200);
    const pub = await t.http.post(O(site, '/studio/website/publish')).set(auth(site.owner)).send({ key: key('onb-pub') });
    expect(pub.status).toBeLessThan(300);
    const res = await t.http.get(`/v1/public/sites/${site.slug}`);
    expect(res.status).toBe(200);
    expect(res.body.org.socialLinks).toEqual({ instagram: 'https://instagram.com/site' });
  });
});

describe('view-only menu QR', () => {
  it('points at /m/<slug> with no token, as SVG and PNG, on the Free plan', async () => {
    const res = await t.http.get(O(free, '/menu-qr')).set(auth(free.owner));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ kind: 'menu', url: `http://app.test/m/${free.slug}`, branchCode: null });
    expect(res.body.svg).toContain('<svg');
    expect(res.body.png).toMatch(/^data:image\/png;base64,[A-Za-z0-9+/]+=*$/);
    const png = Buffer.from(res.body.png.split(',')[1], 'base64');
    expect(png.subarray(1, 4).toString('latin1')).toBe('PNG');
    // Never an ordering QR: no table or venue route, no table/venue token.
    expect(JSON.stringify(res.body)).not.toMatch(/\/t\/|\/v\//);
    // (Venue tokens are derived from a stored nonce and only ever appear under /v/, excluded above.)
    const tables = await sql(`select qr_token as v from dining_tables where org_id = $1`, [free.orgId]);
    expect(tables.length).toBeGreaterThan(0);
    for (const r of tables) expect(JSON.stringify(res.body)).not.toContain(r.v);

    const [{ code }] = await sql(`select code from branches where id = $1`, [free.branchId]);
    const branch = await t.http.get(O(free, `/menu-qr?branch=${code}`)).set(auth(waiter));
    expect(branch.status).toBe(200);
    expect(branch.body).toMatchObject({ kind: 'menu', url: `http://app.test/m/${free.slug}?branch=${code}`, branchCode: code });
    expect((await t.http.get(O(free, '/menu-qr?branch=no-such-branch')).set(auth(free.owner))).status).toBe(404);
    expect((await t.http.get(O(free, '/menu-qr?branch=Bad%20Code')).set(auth(free.owner))).status).toBe(400);
  });

  it('the menu it opens is the public menu: browsable, no ordering session', async () => {
    const menu = await t.http.get(`/v1/public/menu/${free.slug}`);
    expect(menu.status).toBe(200);
    expect(menu.body.categories.length).toBeGreaterThan(0);
    expect(menu.body.categories[0].products[0]).toHaveProperty('priceMinor');
    expect(menu.body.categories[0].products[0]).toHaveProperty('available');
    expect(JSON.stringify(menu.body)).not.toMatch(/qr_?token|sessionToken|visitToken/i);
  });

  it('needs menu:read in the same restaurant', async () => {
    expect((await t.http.get(O(paid, '/menu-qr')).set(auth(driver))).status).toBe(403);
    expect((await t.http.get(O(paid, '/menu-qr')).set(auth(host))).status).toBe(403);
    expect((await t.http.get(O(paid, '/menu-qr')).set(auth(paid.owner))).status).toBe(200);
    expect((await t.http.get(O(free, '/menu-qr')).set(auth(other.owner))).status).toBe(404);
    expect((await t.http.get(O(free, '/menu-qr'))).status).toBe(401);
    // Another restaurant's branch code is not found through this restaurant.
    const [{ code }] = await sql(`select code from branches where id = $1`, [other.branchId]);
    await sql(`update branches set code = $2 where id = $1`, [other.branchId, `${code}-x`]);
    expect((await t.http.get(O(free, `/menu-qr?branch=${code}-x`)).set(auth(free.owner))).status).toBe(404);
  });

  it('ordering QRs stay behind their existing permission (floor:write), separate from the menu QR', async () => {
    // A waiter can show the menu QR but cannot issue table (ordering) QRs.
    expect((await t.http.get(O(free, '/menu-qr')).set(auth(waiter))).status).toBe(200);
    expect((await t.http.get(O(free, `/floor/${free.branchId}/qr`)).set(auth(waiter))).status).toBe(403);
    expect((await t.http.get(O(free, `/floor/${free.branchId}/qr`)).set(auth(other.owner))).status).toBe(404);
  });

  // KNOWN GAP (reported, not fixed here): plan §6.2 says a Free restaurant can never create an ordering QR, but no
  // existing gate does that. The floor and venue QR routes need only `floor:*` permissions; ordering is part of the
  // `core` module, which the seeded free plan includes ("Digital QR menu and table ordering for one branch"). Closing
  // it means changing plan contents (the §7 matrix, not approved), so this test pins today's behaviour: when the gate
  // lands, flip these to 402 module_disabled.
  it('known gap: the Free owner can still open the ordering QR routes (no plan gate exists yet)', async () => {
    expect((await t.http.get(O(free, `/floor/${free.branchId}/qr`)).set(auth(free.owner))).status).toBe(200);
    expect((await t.http.get(O(free, `/floor/${free.branchId}/venue-qr`)).set(auth(free.owner))).status).toBe(200);
    const [{ modules }] = await sql(`select array_agg(module::text order by module) as modules from plan_modules where plan_id = 'free'`);
    expect(modules).toEqual(['core']);
  });
});

describe('web address availability and reserved words', () => {
  const check = (user: TestUser | null, slug: string) => {
    const req = t.http.get(`/v1/orgs/slug-availability?slug=${encodeURIComponent(slug)}`);
    return user ? req.set(auth(user)) : req;
  };

  it('answers available, taken, reserved or invalid', async () => {
    const person = await signup(t, 'onb-slug');
    const fresh = unique('onb').toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 40);
    expect((await check(person, fresh)).body).toEqual({ slug: fresh, available: true, reason: null });
    expect((await check(person, free.slug)).body).toEqual({ slug: free.slug, available: false, reason: 'taken' });
    expect((await check(person, free.slug.toUpperCase())).body).toEqual({ slug: free.slug, available: false, reason: 'taken' });
    for (const word of ['admin', 'api', 'www', 'menu', 'dashboard', 'resuto', 'support']) {
      expect((await check(person, word)).body, word).toEqual({ slug: word, available: false, reason: 'reserved' });
    }
    for (const bad of ['ab', '-abc', 'abc-', 'a_b_c', 'café', 'x'.repeat(49)]) {
      expect((await check(person, bad)).body, bad).toMatchObject({ available: false, reason: 'invalid' });
    }
    expect((await check(person, '')).status).toBe(400);
  });

  it('needs a signed-in person', async () => {
    expect((await check(null, 'some-name')).status).toBe(401);
    expect((await t.http.get('/v1/orgs/slug-availability?slug=x').set({ Authorization: 'Bearer not-a-token' })).status).toBe(401);
  });

  it('signup refuses a reserved address', async () => {
    const owner = await signup(t, 'onb-reserved');
    const res = await t.http.post('/v1/orgs').set(auth(owner)).send({
      name: 'Reserved', slug: 'dashboard', country: 'EG', planId: 'free', branch: { name: 'Main' },
    });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('slug_reserved');
    expect(await sql(`select 1 from organizations where slug = 'dashboard'`)).toHaveLength(0);
  });
});
