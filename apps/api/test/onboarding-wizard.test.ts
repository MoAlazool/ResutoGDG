// 21-ONB increment 2 (plan §6.2): the onboarding wizard's backend.
//   - onboarding_progress: the signed-in person's wizard, saved after every step and resumable; personal (RLS on
//     auth.uid()), linked only to a restaurant the person belongs to;
//   - studio_basic inside core: logo, colours, theme presets and publishing the site on Free, with the rest of the
//     Studio still behind the studio module (negative cases below);
//   - social links on the public storefront; xlsx as an import source.
// Every new endpoint has its negative authorization cases here.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addMember, auth, bootTestApp, createTenant, signup, sql, unique, type TestApp, type TestTenant, type TestUser } from './helpers';

let t: TestApp;
let free: TestTenant;
let paid: TestTenant;
let other: TestTenant;
let waiter: TestUser;
let marketing: TestUser;

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const O = (tenant: TestTenant, path: string) => `/v1/o/${tenant.orgId}${path}`;

beforeAll(async () => {
  t = await bootTestApp();
  free = await createTenant(t, { planId: 'free' });
  paid = await createTenant(t, { planId: 'pro' });
  other = await createTenant(t, { planId: 'free' });
  waiter = await addMember(t, free, 'waiter');
  marketing = await addMember(t, paid, 'marketing');
});
afterAll(async () => { await t.close(); });

describe('onboarding progress (resumable wizard)', () => {
  it('starts after the signup and is saved after every step', async () => {
    const me = await signup(t, 'wizard');
    const start = await t.http.get('/v1/onboarding/progress').set(auth(me));
    expect(start.status).toBe(200);
    expect(start.body).toEqual({ step: 'restaurant', completed: ['account'], orgId: null, draft: {}, completedAt: null, updatedAt: null });

    const draft = { name: 'Olive Room', nameAr: 'غرفة الزيتون', country: 'EG', serviceMode: 'counter' };
    const s1 = await t.http.put('/v1/onboarding/progress').set(auth(me)).send({ step: 'address', completed: ['restaurant'], draft });
    expect(s1.status).toBe(200);
    expect(s1.body).toMatchObject({ step: 'address', completed: ['account', 'restaurant'], orgId: null, draft });
    // Resumable: a fresh read (another device) gets the same state.
    expect((await t.http.get('/v1/onboarding/progress').set(auth(me))).body).toMatchObject({ step: 'address', draft });

    // The address step creates the restaurant, then links it.
    const slug = unique('wiz').toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 40);
    const org = await t.http.post('/v1/orgs').set(auth(me)).send({ name: 'Olive Room', slug, country: 'EG', planId: 'free', branch: { name: 'Main branch' } });
    expect(org.status).toBe(201);
    const s2 = await t.http.put('/v1/onboarding/progress').set(auth(me)).send({ step: 'brand', completed: ['address'], orgId: org.body.id, draft: { ...draft, slug } });
    expect(s2.body).toMatchObject({ step: 'brand', completed: ['account', 'restaurant', 'address'], orgId: org.body.id });

    // Finished steps only grow: a later save without them keeps them.
    const s3 = await t.http.put('/v1/onboarding/progress').set(auth(me)).send({ step: 'menu', completed: ['brand'] });
    expect(s3.body.completed).toEqual(['account', 'restaurant', 'address', 'brand']);
    expect(s3.body.draft).toMatchObject({ slug });
    const done = await t.http.put('/v1/onboarding/progress').set(auth(me))
      .send({ step: 'qr', completed: ['menu', 'details', 'social', 'publish', 'qr'], done: true });
    expect(done.body.completedAt).toEqual(expect.any(String));
    const [row] = await sql('select step, org_id, completed_at from onboarding_progress where user_id = $1', [me.userId]);
    expect(row).toMatchObject({ step: 'qr', org_id: org.body.id });

    // Starting a new wizard (another restaurant) drops the finished steps and the link.
    const restart = await t.http.put('/v1/onboarding/progress').set(auth(me)).send({ step: 'restaurant', restart: true });
    expect(restart.body).toMatchObject({ step: 'restaurant', completed: ['account'], orgId: null, completedAt: null });
  });

  it('refuses restaurant steps without a restaurant, unknown steps and fields, and anonymous callers', async () => {
    const me = await signup(t, 'wizard');
    const noOrg = await t.http.put('/v1/onboarding/progress').set(auth(me)).send({ step: 'menu' });
    expect(noOrg.status).toBe(422);
    expect(noOrg.body.error.code).toBe('onboarding_org_required');
    expect((await t.http.put('/v1/onboarding/progress').set(auth(me)).send({ step: 'address', completed: ['brand'] })).status).toBe(422);
    expect((await t.http.put('/v1/onboarding/progress').set(auth(me)).send({ step: 'address', done: true })).status).toBe(422);
    expect((await t.http.put('/v1/onboarding/progress').set(auth(me)).send({ step: 'ordering' })).status).toBe(400);
    expect((await t.http.put('/v1/onboarding/progress').set(auth(me)).send({ step: 'address', draft: { planId: 'pro' } })).status).toBe(400);
    expect((await t.http.put('/v1/onboarding/progress').set(auth(me)).send({ step: 'address', userId: free.owner.userId })).status).toBe(400);
    expect((await t.http.get('/v1/onboarding/progress')).status).toBe(401);
    expect((await t.http.put('/v1/onboarding/progress').send({ step: 'address' })).status).toBe(401);
  });

  it('links only a restaurant the person belongs to, and each person sees only their own progress', async () => {
    const me = await signup(t, 'wizard');
    // Another restaurant's id is refused (and nothing is written).
    const foreign = await t.http.put('/v1/onboarding/progress').set(auth(me)).send({ step: 'brand', orgId: other.orgId });
    expect(foreign.status).toBe(403);
    expect(await sql('select 1 from onboarding_progress where user_id = $1', [me.userId])).toEqual([]);

    await t.http.put('/v1/onboarding/progress').set(auth(free.owner)).send({ step: 'menu', completed: ['restaurant', 'address', 'brand'], orgId: free.orgId }).expect(200);
    // A colleague in the same restaurant does not see the owner's wizard; they get their own (empty) one.
    const colleague = await t.http.get('/v1/onboarding/progress').set(auth(waiter));
    expect(colleague.body).toMatchObject({ orgId: null, step: 'restaurant', completed: ['account'] });
    // The colleague may link the restaurant they work in to their own progress row, never write the owner's.
    await t.http.put('/v1/onboarding/progress').set(auth(waiter)).send({ step: 'brand', completed: ['address'], orgId: free.orgId }).expect(200);
    const owner = await t.http.get('/v1/onboarding/progress').set(auth(free.owner));
    expect(owner.body).toMatchObject({ step: 'menu', orgId: free.orgId });
  });

  it('a restaurant the person lost access to is not resumed', async () => {
    const tenant = await createTenant(t, { planId: 'free' });
    const helper = await addMember(t, tenant, 'manager');
    await t.http.put('/v1/onboarding/progress').set(auth(helper)).send({ step: 'menu', completed: ['restaurant', 'address', 'brand'], orgId: tenant.orgId }).expect(200);
    await sql(`update memberships set status = 'removed' where org_id = $1 and user_id = $2`, [tenant.orgId, helper.userId]);
    const after = await t.http.get('/v1/onboarding/progress').set(auth(helper));
    expect(after.body).toMatchObject({ orgId: null, step: 'address', completed: ['account', 'restaurant', 'address'] });
    // Writing it back with that restaurant is refused.
    expect((await t.http.put('/v1/onboarding/progress').set(auth(helper)).send({ step: 'brand', orgId: tenant.orgId })).status).toBe(403);
  });

  it('deleting the restaurant sends the wizard back to the address step', async () => {
    const me = await signup(t, 'wizard');
    const slug = unique('wiz').toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 40);
    const org = await t.http.post('/v1/orgs').set(auth(me)).send({ name: 'Gone', slug, country: 'EG', planId: 'free', branch: { name: 'Main' } });
    await t.http.put('/v1/onboarding/progress').set(auth(me)).send({ step: 'social', completed: ['restaurant', 'address', 'brand', 'menu'], orgId: org.body.id }).expect(200);
    await sql(`update onboarding_progress set org_id = null where user_id = $1`, [me.userId]); // what the org's deletion does (on delete set null)
    const [row] = await sql('select step, org_id from onboarding_progress where user_id = $1', [me.userId]);
    expect(row).toEqual({ step: 'address', org_id: null });
  });
});

describe('studio_basic on Free: logo, colours, presets, publish', () => {
  it('lists the six presets, each a full website and storefront theme', async () => {
    const res = await t.http.get(O(free, '/brand/presets')).set(auth(free.owner));
    expect(res.status).toBe(200);
    expect(res.body.items.map((p: any) => p.id)).toEqual(['cafe', 'bakery', 'fine_dining', 'qsr', 'cloud_kitchen', 'family']);
    for (const p of res.body.items) {
      expect(Object.keys(p.websiteTheme).sort()).toEqual(['accentColor', 'backgroundColor', 'font', 'primaryColor']);
      expect(Object.keys(p.storefrontTheme).sort()).toEqual(['accentColor', 'inkColor', 'paperColor', 'primaryColor']);
      for (const c of [...Object.values(p.storefrontTheme), p.websiteTheme.primaryColor]) expect(c).toMatch(/^#[0-9a-f]{6}$/i);
      expect(p.name.ar).toBeTruthy();
    }
  });

  it('a Free restaurant applies a preset, sets colours and a logo, and publishes its site', async () => {
    const before = await t.http.get(O(free, '/brand')).set(auth(free.owner));
    expect(before.status).toBe(200);
    expect(before.body).toMatchObject({ scope: 'studio_basic', presetId: null, website: { status: 'draft', publishedRevision: 0 }, links: { site: `/r/${free.slug}`, menu: `/m/${free.slug}` } });

    const preset = await t.http.put(O(free, '/brand')).set(auth(free.owner)).send({ presetId: 'qsr' });
    expect(preset.status).toBe(200);
    expect(preset.body).toMatchObject({ presetId: 'qsr', template: 'smash', theme: { primaryColor: '#b51218', accentColor: '#ffd52f', font: 'manrope' } });
    const colours = await t.http.put(O(free, '/brand')).set(auth(free.owner)).send({ accentColor: '#123456' });
    expect(colours.body).toMatchObject({ presetId: 'qsr', theme: { primaryColor: '#b51218', accentColor: '#123456' } });

    const logo = await t.http.post(O(free, '/brand/logo')).set(auth(free.owner)).attach('file', PNG, { filename: 'logo.png', contentType: 'image/png' });
    expect(logo.status).toBe(201);
    expect(logo.body.theme.logoMediaId).toEqual(expect.any(String));
    expect(logo.body.logoUrl).toEqual(expect.any(String));
    expect(logo.body.website.hasUnpublishedChanges).toBe(true);

    await t.http.put(O(free, '/social-links')).set(auth(free.owner)).send({ instagram: 'https://instagram.com/free_onb' }).expect(200);
    const key = unique('pub');
    const pub = await t.http.post(O(free, '/brand/publish')).set(auth(free.owner)).send({ key });
    expect(pub.status).toBe(200);
    expect(pub.body).toMatchObject({ revision: 1, links: { site: `/r/${free.slug}`, menu: `/m/${free.slug}` } });
    // Idempotent: the same key answers the same revision.
    expect((await t.http.post(O(free, '/brand/publish')).set(auth(free.owner)).send({ key })).body.revision).toBe(1);

    const site = await t.http.get(`/v1/public/sites/${free.slug}`);
    expect(site.status).toBe(200);
    expect(site.body).toMatchObject({ template: 'smash', theme: { primaryColor: '#b51218', accentColor: '#123456' }, org: { socialLinks: { instagram: 'https://instagram.com/free_onb' } } });
    expect(site.body.theme.logoUrl).toEqual(expect.any(String));
    const after = await t.http.get(O(free, '/brand')).set(auth(free.owner));
    expect(after.body.website).toMatchObject({ status: 'published', publishedRevision: 1, hasUnpublishedChanges: false });
    const [audit] = await sql(`select metadata from audit_logs where org_id = $1 and action = 'website.brand_updated' order by id desc limit 1`, [free.orgId]);
    expect(audit.metadata).toMatchObject({ scope: 'studio_basic' });
  });

  it('Free cannot use the full Studio (sections, website editor, media library, publish, storefronts, domains, photos, creative)', async () => {
    const h = auth(free.owner);
    const studio = (p: string) => O(free, `/studio${p}`);
    const attempts: Array<() => any> = [
      () => t.http.get(studio('/website')).set(h),
      () => t.http.patch(studio('/website')).set(h).send({ theme: { primaryColor: '#000000' } }),
      () => t.http.post(studio('/website/sections')).set(h).send({ kind: 'about', content: {} }),
      () => t.http.post(studio('/website/publish')).set(h).send({ key: unique('pub') }),
      () => t.http.get(studio('/website/preview')).set(h),
      // The guard answers before the upload is read: a JSON body (no file) shows the same refusal without a reset socket.
      () => t.http.post(studio('/media')).set(h).send({}),
      () => t.http.put(studio(`/storefronts/${free.branchId}`)).set(h).send({ slug: 'smash', brandName: 'Smash', theme: { primaryColor: '#000000', accentColor: '#ffffff' } }),
      () => t.http.post(studio('/domains')).set(h).send({ hostname: 'www.example.com' }),
      () => t.http.get(studio('/photos')).set(h),
      () => t.http.post(studio('/creative')).set(h).send({ kind: 'caption', locale: 'en', brief: 'A new dish' }),
    ];
    for (const attempt of attempts) {
      const res = await attempt();
      expect(res.status, `${res.req.method} ${res.req.path}`).toBe(402);
      expect(res.body.error).toMatchObject({ code: 'module_not_entitled', details: { module: 'studio' } });
    }
    // The studio_basic routes take only studio_basic fields: everything else the website has is refused.
    for (const body of [{ heroMediaId: null }, { tagline: { en: 'Hi' } }, { template: 'olive' }, { seo: { title: { en: 'x' } } }, { font: 'editorial' },
      { sections: [] }, { theme: { primaryColor: '#000000' } }]) {
      const res = await t.http.put(O(free, '/brand')).set(h).send(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    expect((await t.http.put(O(free, '/brand')).set(h).send({ presetId: 'nightclub' })).body.error.code).toBe('unknown_theme_preset');
  });

  it('refuses people without the Studio permissions, other restaurants and foreign images', async () => {
    // A waiter has no studio permission: no reading, changing or publishing the brand.
    expect((await t.http.get(O(free, '/brand')).set(auth(waiter))).status).toBe(403);
    expect((await t.http.put(O(free, '/brand')).set(auth(waiter)).send({ presetId: 'cafe' })).status).toBe(403);
    // (no file attached: the guard refuses before an upload would be read, which would reset the socket mid-upload)
    expect((await t.http.post(O(free, '/brand/logo')).set(auth(waiter)).send({})).status).toBe(403);
    expect((await t.http.post(O(free, '/brand/publish')).set(auth(waiter)).send({ key: unique('pub') })).status).toBe(403);
    expect((await t.http.get(O(free, '/brand/presets')).set(auth(waiter))).status).toBe(403);
    // Another restaurant's owner reaches nothing here.
    for (const res of await Promise.all([
      t.http.get(O(free, '/brand')).set(auth(other.owner)),
      t.http.put(O(free, '/brand')).set(auth(other.owner)).send({ presetId: 'cafe' }),
      t.http.post(O(free, '/brand/publish')).set(auth(other.owner)).send({ key: unique('pub') }),
    ])) expect([403, 404]).toContain(res.status);
    expect((await t.http.get(O(free, '/brand'))).status).toBe(401);
    // A logo must be an image of this restaurant (not another's, not a private import file).
    const foreign = await t.http.post(O(other, '/brand/logo')).set(auth(other.owner)).attach('file', PNG, { filename: 'l.png', contentType: 'image/png' });
    const foreignId = foreign.body.theme.logoMediaId;
    const res = await t.http.put(O(free, '/brand')).set(auth(free.owner)).send({ logoMediaId: foreignId });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('unknown_media');
    const [imp] = await sql(`insert into media_assets(org_id, path, content_type, byte_size, source) values ($1, $2, 'image/png', 10, 'import') returning id`,
      [free.orgId, `${free.orgId}/imports/${unique('x')}.png`]);
    expect((await t.http.put(O(free, '/brand')).set(auth(free.owner)).send({ logoMediaId: imp.id })).status).toBe(422);
    // Not an image.
    const text = await t.http.post(O(free, '/brand/logo')).set(auth(free.owner)).attach('file', Buffer.from('hello'), { filename: 'a.txt', contentType: 'text/plain' });
    expect(text.status).toBe(422);
  });

  it('studio_basic lives inside core: a restaurant whose core is switched off is refused', async () => {
    const tenant = await createTenant(t, { planId: 'free' });
    await sql(`insert into entitlement_overrides(org_id, module, enabled, reason) values ($1, 'core', false, 'test')`, [tenant.orgId]);
    const res = await t.http.get(O(tenant, '/brand')).set(auth(tenant.owner));
    expect(res.status).toBe(402);
    expect(res.body.error.details).toEqual({ module: 'core' });
  });

  it('with the full Studio the same routes work, report scope studio, and keep the Studio-only theme fields', async () => {
    const h = auth(paid.owner);
    const media = await t.http.post(O(paid, '/studio/media')).set(h).attach('file', PNG, { filename: 'hero.png', contentType: 'image/png' });
    await t.http.patch(O(paid, '/studio/website')).set(h).send({ theme: { heroMediaId: media.body.id, tagline: { en: 'Since 1990' } } }).expect(200);
    const res = await t.http.put(O(paid, '/brand')).set(auth(marketing)).send({ presetId: 'fine_dining' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ scope: 'studio', presetId: 'fine_dining', template: 'minimal', theme: { font: 'editorial' } });
    const site = await t.http.get(O(paid, '/studio/website')).set(h);
    expect(site.body.website.theme).toMatchObject({ heroMediaId: media.body.id, tagline: { en: 'Since 1990' }, primaryColor: '#1f2a2e' });
  });
});

describe('social links on the storefront, xlsx imports', () => {
  it('the public storefront carries the restaurant social links', async () => {
    const h = auth(paid.owner);
    await t.http.put(O(paid, '/social-links')).set(h).send({ tiktok: 'https://www.tiktok.com/@paid_onb' }).expect(200);
    await t.http.put(O(paid, `/studio/storefronts/${paid.branchId}`)).set(h)
      .send({ slug: 'smash', brandName: 'Smash & Co', theme: { primaryColor: '#b51218', accentColor: '#ffd52f' }, isPublished: true }).expect(200);
    await t.http.post(O(paid, '/studio/website/publish')).set(h).send({ key: unique('pub') }).expect(200);
    const res = await t.http.get(`/v1/public/sites/${paid.slug}/storefronts/smash`);
    expect(res.status).toBe(200);
    expect(res.body.org.socialLinks).toEqual({ tiktok: 'https://www.tiktok.com/@paid_onb' });
  });

  it('a spreadsheet converted in the browser imports with source xlsx', async () => {
    const csv = 'name,category,price\r\nFlat white,Coffee,65\r\nCroissant,Bakery,45.5';
    const preview = await t.http.post(O(free, '/menu/import/preview')).set(auth(free.owner)).send({ csv, source: 'xlsx' });
    expect(preview.status).toBe(200);
    expect(preview.body).toMatchObject({ source: 'xlsx', summary: { total: 2, errors: 0, create: 2 } });
    expect(preview.body.rows[1].item.priceMinor).toBe(4550);
  });
});
