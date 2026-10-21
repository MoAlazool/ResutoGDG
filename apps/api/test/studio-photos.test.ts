import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { loadSharp } from '../src/common/storage/image-enhance';
import { PHOTO_GENERATIVE_PROVIDERS, type PhotoGenerativeProvider } from '../src/modules/studio/photos/generative';
import { StudioPhotosService } from '../src/modules/studio/photos/photos.service';
import { addMember, auth, createTenant, seedMenu, sql, type SeededMenu, type TestApp, type TestTenant } from './helpers';

// FT-04: food-photo enhancement pipeline. Deterministic (sharp) by default; a generative provider exists only when a
// restaurant-owned one is configured (here: a scripted fake for one tenant, to prove the interface and its labelling).

const sharp = loadSharp();
let t: TestApp;
let a: TestTenant;
let menu: SeededMenu;
let genTenant: string | null = null;
const fakeGenerative: PhotoGenerativeProvider = {
  id: 'test_byok_image', label: 'Test image model (restaurant key)',
  async configured(orgId) { return orgId === genTenant; },
  async edit(_orgId, input) { return { bytes: await sharp(input.bytes).jpeg().toBuffer(), mime: 'image/jpeg', model: 'test-image-1', prompt: 'Improve lighting only' }; },
};

async function dishPhoto(w = 1600, h = 1000) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="${w}" height="${h}" fill="rgb(66,50,40)"/>
    <circle cx="${w * 0.6}" cy="${h * 0.5}" r="${h * 0.3}" fill="rgb(160,120,70)"/></svg>`;
  return sharp(Buffer.from(svg)).jpeg({ quality: 90 }).toBuffer();
}

beforeAll(async () => {
  const ref = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(PHOTO_GENERATIVE_PROVIDERS).useValue([fakeGenerative]).compile();
  const app = ref.createNestApplication({ rawBody: true, logger: ['error'] });
  app.setGlobalPrefix('v1');
  await app.init();
  t = { app, http: request(app.getHttpServer()), close: () => app.close() };
  a = await createTenant(t, { name: 'Photo Grill' });
  menu = await seedMenu(a);
});
afterAll(async () => { await t?.close(); });

const base = (x: TestTenant) => `/v1/o/${x.orgId}/studio/photos`;
const upload = async (x: TestTenant, fields: Record<string, string> = {}, bytes?: Buffer, as = x.owner) => {
  let req = t.http.post(base(x)).set(auth(as)).attach('file', bytes ?? await dishPhoto(), { filename: 'dish.jpg', contentType: 'image/jpeg' });
  for (const [k, v] of Object.entries(fields)) req = req.field(k, v);
  return req;
};
const work = () => t.app.get(StudioPhotosService).runDue(5);

describe('food-photo enhancement', () => {
  it('upload -> durable job -> deterministic enhancement -> review, keeping the original', async () => {
    const up = await upload(a, { productId: menu.products.burger, params: JSON.stringify({ aspect: '1:1' }) });
    expect(up.status).toBe(201);
    expect(up.body).toMatchObject({ status: 'queued', mode: 'deterministic', provider: 'resuto_sharp', productId: menu.products.burger, output: null,
      params: { aspect: '1:1', whiteBalance: true } });
    const [orig] = await sql<any>(`select path, byte_size from media_assets where id = $1`, [up.body.original.mediaId]);
    expect(orig.path).toContain('/photo-originals/');

    expect(await work()).toMatchObject({ processed: 1 });
    const job = (await t.http.get(`${base(a)}/${up.body.id}`).set(auth(a.owner))).body;
    expect(job.status).toBe('review');
    expect(job.output).toMatchObject({ width: 1000, height: 1000 });
    expect(job.output.formats.map((f: any) => `${f.format}:${f.width}`)).toEqual(['webp:320', 'webp:640', 'avif:1000']);
    expect(job.output.url).toMatch(/^http:\/\/api\.test\/v1\/media\//);
    expect(job.original.url).toMatch(/^http:\/\/api\.test\/v1\/media\//);
    expect(job.provenance).toMatchObject({ mode: 'deterministic', generative: false, sourceMediaId: up.body.original.mediaId,
      input: { width: 1600, height: 1000 }, output: { width: 1000, height: 1000 } });
    const [out] = await sql<any>(`select source, path from media_assets where id = $1`, [job.output.mediaId]);
    expect(out).toMatchObject({ source: 'studio_enhanced' });
    expect(out.path).toContain('/studio/');
    // The original is untouched and cannot be deleted while the job references it.
    expect(await sql(`select byte_size from media_assets where id = $1`, [up.body.original.mediaId])).toEqual([{ byte_size: orig.byte_size }]);
    const del = await t.http.delete(`/v1/o/${a.orgId}/studio/media/${up.body.original.mediaId}`).set(auth(a.owner));
    expect(del.status).toBe(409);
  });

  it('publishes only after approval, through the menu module, idempotently; rejected results never publish', async () => {
    const up = await upload(a, { productId: menu.products.fries });
    await work();
    const key = 'publish-photo-key-1';
    const early = await t.http.post(`${base(a)}/${up.body.id}/publish`).set(auth(a.owner)).send({ target: 'product', productId: menu.products.fries, key });
    expect(early.status).toBe(409);
    expect(early.body.error.code).toBe('photo_not_approved');
    expect((await sql(`select image_media_id from products where id = $1`, [menu.products.fries]))[0].image_media_id).toBeNull();

    const ok = await t.http.post(`${base(a)}/${up.body.id}/review`).set(auth(a.owner)).send({ decision: 'approve', note: 'Looks right' });
    expect(ok.body).toMatchObject({ status: 'approved', reviewedBy: a.owner.userId, reviewNote: 'Looks right' });
    const pub = await t.http.post(`${base(a)}/${up.body.id}/publish`).set(auth(a.owner)).send({ target: 'product', productId: menu.products.fries, key });
    expect(pub.status).toBe(201);
    expect(pub.body).toMatchObject({ status: 'published', published: { target: 'product', id: menu.products.fries } });
    const [p] = await sql<any>(`select image_media_id from products where id = $1`, [menu.products.fries]);
    expect(p.image_media_id).toBeTruthy();
    expect(p.image_media_id).not.toBe(up.body.original.mediaId);
    const again = await t.http.post(`${base(a)}/${up.body.id}/publish`).set(auth(a.owner)).send({ target: 'product', productId: menu.products.fries, key });
    expect(again.status).toBe(201);
    expect((await sql(`select image_media_id from products where id = $1`, [menu.products.fries]))[0].image_media_id).toBe(p.image_media_id);
    const actions = (await sql<any>(`select action from audit_logs where org_id = $1 and entity_id = $2 order by id`, [a.orgId, up.body.id])).map((r) => r.action);
    expect(actions).toEqual(['studio_photo.uploaded', 'studio_photo.enhanced', 'studio_photo.approved', 'studio_photo.published']);

    const other = await upload(a);
    await work();
    await t.http.post(`${base(a)}/${other.body.id}/review`).set(auth(a.owner)).send({ decision: 'reject' });
    const rej = await t.http.post(`${base(a)}/${other.body.id}/publish`).set(auth(a.owner)).send({ target: 'product', productId: menu.products.soda, key: 'publish-photo-key-2' });
    expect(rej.status).toBe(409);
    expect((await t.http.post(`${base(a)}/${other.body.id}/review`).set(auth(a.owner)).send({ decision: 'approve' })).status).toBe(409);
  });

  it('publishes to a website section draft', async () => {
    const site = (await t.http.get(`/v1/o/${a.orgId}/studio/website`).set(auth(a.owner))).body;
    const hero = site.sections.find((s: any) => s.kind === 'hero');
    const up = await upload(a, { params: JSON.stringify({ aspect: '16:9' }) });
    await work();
    await t.http.post(`${base(a)}/${up.body.id}/review`).set(auth(a.owner)).send({ decision: 'approve' });
    const pub = await t.http.post(`${base(a)}/${up.body.id}/publish`).set(auth(a.owner)).send({ target: 'website_section', sectionId: hero.id, key: 'publish-hero-0001' });
    expect(pub.status).toBe(201);
    const after = (await t.http.get(`/v1/o/${a.orgId}/studio/website`).set(auth(a.owner))).body;
    expect(after.sections.find((s: any) => s.id === hero.id).content.mediaId).toBe(pub.body.output.mediaId);
    expect(after.website.hasUnpublishedChanges).toBe(true);
  });

  it('refuses generative edits unless a restaurant-owned provider is configured, and labels them when it is', async () => {
    const res = await upload(a, { mode: 'generative' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('generative_not_configured');
    const cap = await t.http.get(`/v1/o/${a.orgId}/studio-ai/capabilities`).set(auth(a.owner));
    expect(cap.body.photoEnhancement).toMatchObject({ deterministic: true, generative: false });

    const b = await createTenant(t, { name: 'BYOK Kitchen' });
    genTenant = b.orgId;
    const gen = await upload(b, { mode: 'generative' });
    expect(gen.status).toBe(201);
    expect(gen.body).toMatchObject({ mode: 'generative', provider: 'test_byok_image' });
    await work();
    const job = (await t.http.get(`${base(b)}/${gen.body.id}`).set(auth(b.owner))).body;
    expect(job).toMatchObject({ status: 'review', model: 'test-image-1', provenance: { mode: 'generative', generative: true, model: 'test-image-1', prompt: 'Improve lighting only' } });
    expect(job.provenance.warning).toMatch(/Check that the dish/);
    genTenant = null;
  });

  it('enforces permissions, tenancy and input validation; unreadable photos fail without retries', async () => {
    const waiter = await addMember(t, a, 'waiter');
    expect((await upload(a, {}, undefined, waiter)).status).toBe(403);
    const up = await upload(a);
    await work();
    await t.http.post(`${base(a)}/${up.body.id}/review`).set(auth(a.owner)).send({ decision: 'approve' });
    const marketing = await addMember(t, a, 'marketing');
    const noMenu = await t.http.post(`${base(a)}/${up.body.id}/publish`).set(auth(marketing)).send({ target: 'product', productId: menu.products.soda, key: 'publish-mkt-00001' });
    expect(noMenu.status).toBe(403);
    const other = await createTenant(t);
    expect((await t.http.get(`${base(other)}/${up.body.id}`).set(auth(other.owner))).status).toBe(404);
    expect((await upload(a, { params: JSON.stringify({ aspect: '5:4' }) })).status).toBe(400);
    expect((await upload(a, { productId: '00000000-0000-4000-8000-000000000000' })).status).toBe(422);

    // A JPEG header followed by garbage: accepted by type sniffing, then the worker cannot decode it.
    const broken = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(2048, 7)]);
    const bad = await upload(a, {}, broken);
    expect(bad.status).toBe(201);
    await work();
    const failed = (await t.http.get(`${base(a)}/${bad.body.id}`).set(auth(a.owner))).body;
    expect(failed).toMatchObject({ status: 'failed', attempts: 1, output: null });
    expect(failed.error).toMatch(/could not be read/);
  });
});
