import 'reflect-metadata';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { StudioAiService } from '../src/modules/studio/ai/studio-ai.service';
import { addMember, auth, bootTestApp, createTenant, seedMenu, sql, type SeededMenu, type TestApp, type TestTenant } from './helpers';

// FT-16: approved copy can be used (menu description, website section draft, campaign draft) with honest
// template-vs-model labels. Before this, review only flipped a status and the dashboard offered clipboard copy.

let t: TestApp;
let a: TestTenant;
let menu: SeededMenu;
beforeAll(async () => {
  delete process.env.GEMINI_API_KEY;
  t = await bootTestApp();
  a = await createTenant(t, { name: 'Copy Kitchen' });
  menu = await seedMenu(a);
});
afterAll(async () => { await t?.close(); });
afterEach(() => { vi.restoreAllMocks(); });

const base = (x: TestTenant) => `/v1/o/${x.orgId}/studio/creative`;
const generate = (x: TestTenant, body: Record<string, unknown>) => t.http.post(base(x)).set(auth(x.owner)).send({ variants: 1, ...body });
const approve = (x: TestTenant, id: string) => t.http.patch(`${base(x)}/${id}`).set(auth(x.owner)).send({ status: 'approved' });
const apply = (x: TestTenant, id: string, body: Record<string, unknown>, as = x.owner) => t.http.post(`${base(x)}/${id}/apply`).set(auth(as)).send(body);

describe('creative authorship labels', () => {
  it('labels template copy as template (no AI), and model copy with the restaurant key as model', async () => {
    const tpl = await generate(a, { kind: 'caption', locale: 'en', brief: 'Weekend brunch is back' });
    expect(tpl.body.authorship).toEqual({ mode: 'template', provider: 'template_rules', model: null, keySource: null, fallbackCode: 'not_configured' });
    const before = await t.http.get(`/v1/o/${a.orgId}/studio-ai/capabilities`).set(auth(a.owner));
    expect(before.body.copyGeneration).toEqual({ mode: 'template', keySource: null, model: null });

    const calls: Array<{ url: string; key: string | null }> = [];
    const fakeFetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, key: new Headers(init.headers).get('x-goog-api-key') });
      const text = JSON.stringify({ variants: [{ text: 'Brunch returns this weekend at Copy Kitchen.', hashtags: ['#CopyKitchen'] }] });
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as unknown as typeof fetch;
    vi.spyOn(t.app.get(StudioAiService), 'byok').mockResolvedValue({ connectionId: 'c1', apiKey: 'restaurant-test-key', model: 'gemini-test', environment: 'live', fetch: fakeFetch });
    const model = await generate(a, { kind: 'caption', locale: 'en', brief: 'Weekend brunch is back' });
    expect(model.status).toBe(201);
    const caps = await t.http.get(`/v1/o/${a.orgId}/studio-ai/capabilities`).set(auth(a.owner));
    expect(caps.body.copyGeneration).toEqual({ mode: 'model', keySource: 'restaurant', model: 'gemini-test' });
    expect(model.body).toMatchObject({ provider: 'gemini', isFallback: false, model: 'gemini-test',
      authorship: { mode: 'model', provider: 'gemini', model: 'gemini-test', keySource: 'restaurant', fallbackCode: null } });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.key).toBe('restaurant-test-key');
    expect(calls[0]!.url).toContain('/models/gemini-test:generateContent');
    expect(JSON.stringify(model.body)).not.toContain('restaurant-test-key');

    // A failing model call falls back to the template, labelled as such, without echoing the provider response.
    const failing = (async () => new Response('{"error":"secret detail"}', { status: 500 })) as unknown as typeof fetch;
    vi.spyOn(t.app.get(StudioAiService), 'byok').mockResolvedValue({ connectionId: 'c1', apiKey: 'restaurant-test-key', model: 'gemini-test', environment: 'live', fetch: failing });
    const fb = await generate(a, { kind: 'caption', locale: 'en', brief: 'Weekend brunch is back' });
    expect(fb.body.authorship).toMatchObject({ mode: 'template', fallbackCode: 'model_failed', keySource: null });
    expect(fb.body.output.fallbackReason).toBe('The model request failed (HTTP 500)');
    expect(JSON.stringify(fb.body)).not.toContain('secret detail');
  });
});

describe('applying approved copy', () => {
  it('uses an approved menu description on the item, once per key, through the menu module', async () => {
    const gen = await generate(a, { kind: 'menu_description', locale: 'en', brief: 'Double smashed patties, cheddar and pickles', productId: menu.products.burger });
    const key = 'apply-desc-key-0001';
    const target = { kind: 'product_description', productId: menu.products.burger };

    const early = await apply(a, gen.body.id, { variant: 0, key, target });
    expect(early.status).toBe(409);
    expect(early.body.error.code).toBe('creative_not_approved');
    // 'used' can no longer be set by hand without anything being used.
    const fake = await t.http.patch(`${base(a)}/${gen.body.id}`).set(auth(a.owner)).send({ status: 'used' });
    expect(fake.status).toBe(422);
    expect(fake.body.error.code).toBe('use_apply');

    const ok = await approve(a, gen.body.id);
    expect(ok.body).toMatchObject({ status: 'approved', reviewedBy: a.owner.userId });
    const [before] = await sql<any>(`select version from products where id = $1`, [menu.products.burger]);
    const res = await apply(a, gen.body.id, { variant: 0, key, target });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('used');
    expect(res.body.applications).toHaveLength(1);
    expect(res.body.applications[0]).toMatchObject({ target: 'product_description', targetId: menu.products.burger, variant: 0, key, appliedBy: a.owner.userId });
    const [after] = await sql<any>(`select description, description_ar, version from products where id = $1`, [menu.products.burger]);
    expect(after.description).toBe(gen.body.output.variants[0].text);
    expect(after.description_ar).toBeNull();
    expect(after.version).toBe(before.version + 1);

    // Same key: the recorded result, nothing applied twice. Same key for something else: refused.
    const again = await apply(a, gen.body.id, { variant: 0, key, target });
    expect(again.status).toBe(201);
    expect(again.body.applications).toHaveLength(1);
    expect((await sql<any>(`select version from products where id = $1`, [menu.products.burger]))[0].version).toBe(after.version);
    const reused = await apply(a, gen.body.id, { variant: 0, key, target: { kind: 'product_description', productId: menu.products.fries } });
    expect(reused.status).toBe(409);
    expect(reused.body.error.code).toBe('idempotency_key_reused');

    // A second, different use is recorded too; used copy can no longer be re-reviewed.
    const second = await apply(a, gen.body.id, { variant: 0, key: 'apply-desc-key-0002', target: { kind: 'product_description', productId: menu.products.fries } });
    expect(second.body.applications.map((x: any) => x.targetId)).toEqual([menu.products.burger, menu.products.fries]);
    expect((await t.http.patch(`${base(a)}/${gen.body.id}`).set(auth(a.owner)).send({ status: 'rejected' })).status).toBe(409);

    const audit = (await sql<any>(`select action from audit_logs where org_id = $1 and entity_id = $2 order by id`, [a.orgId, gen.body.id])).map((r) => r.action);
    expect(audit).toEqual(['creative.generated', 'creative.approved', 'creative.applied', 'creative.applied']);
    const menuAudit = await sql<any>(`select metadata from audit_logs where org_id = $1 and action = 'menu.product.updated' and entity_id = $2`, [a.orgId, menu.products.burger]);
    expect(menuAudit.length).toBeGreaterThanOrEqual(1);
  });

  it('writes Arabic copy to the Arabic description only', async () => {
    const gen = await generate(a, { kind: 'menu_description', locale: 'ar', brief: 'بطاطس مقرمشة مع ملح البحر', productId: menu.products.fries });
    await approve(a, gen.body.id);
    const [before] = await sql<any>(`select description from products where id = $1`, [menu.products.fries]);
    const res = await apply(a, gen.body.id, { variant: 0, key: 'apply-desc-ar-0001', target: { kind: 'product_description', productId: menu.products.fries } });
    expect(res.status).toBe(201);
    const [p] = await sql<any>(`select description, description_ar from products where id = $1`, [menu.products.fries]);
    expect(p.description_ar).toBe(gen.body.output.variants[0].text);
    expect(p.description).toBe(before.description);
  });

  it('puts approved website copy into a section draft (live only after Publish)', async () => {
    const site = (await t.http.get(`/v1/o/${a.orgId}/studio/website`).set(auth(a.owner))).body;
    const about = site.sections.find((s: any) => s.kind === 'about') ?? site.sections.find((s: any) => s.kind === 'hero');
    const gen = await generate(a, { kind: 'website_copy', locale: 'en', brief: 'Smashed to order since 2019' });
    await approve(a, gen.body.id);
    const wrong = await apply(a, gen.body.id, { variant: 0, key: 'apply-web-wrong-01', target: { kind: 'product_description', productId: menu.products.burger } });
    expect(wrong.status).toBe(422);
    expect(wrong.body.error.code).toBe('target_not_supported');

    const res = await apply(a, gen.body.id, { variant: 0, key: 'apply-web-key-0001', target: { kind: 'website_section', sectionId: about.id } });
    expect(res.status).toBe(201);
    const after = (await t.http.get(`/v1/o/${a.orgId}/studio/website`).set(auth(a.owner))).body;
    const section = after.sections.find((s: any) => s.id === about.id);
    expect(section.content.headline.en).toBe(gen.body.output.variants[0].title);
    expect(section.content.body.en).toBe(gen.body.output.variants[0].text);
    if (about.content?.body?.ar) expect(section.content.body.ar).toBe(about.content.body.ar);
    expect(after.website.hasUnpublishedChanges).toBe(true);
  });

  it('starts a campaign draft from an approved caption (never sends), with permissions enforced per target', async () => {
    const gen = await generate(a, { kind: 'caption', locale: 'en', brief: 'Two-for-one shakes on Thursdays' });
    await approve(a, gen.body.id);
    const res = await apply(a, gen.body.id, { variant: 0, key: 'apply-camp-key-001', target: { kind: 'campaign_draft', channel: 'organic', name: 'Thursday shakes' } });
    expect(res.status).toBe(201);
    const app = res.body.applications[0];
    const [c] = await sql<any>(`select name, status, source, channel, content from campaigns where id = $1 and org_id = $2`, [app.targetId, a.orgId]);
    expect(c).toMatchObject({ name: 'Thursday shakes', status: 'draft', source: 'ai', channel: 'organic' });
    expect(c.content.text).toContain(gen.body.output.variants[0].text);
    expect(c.content.text).toContain(gen.body.output.variants[0].hashtags[0]);
    const replay = await apply(a, gen.body.id, { variant: 0, key: 'apply-camp-key-001', target: { kind: 'campaign_draft', channel: 'organic', name: 'Thursday shakes' } });
    expect(replay.body.applications).toHaveLength(1);
    expect((await sql(`select 1 from campaigns where org_id = $1 and name = 'Thursday shakes'`, [a.orgId]))).toHaveLength(1);

    // Marketing staff can start campaign drafts but cannot change the menu; waiters cannot use copy at all.
    const marketing = await addMember(t, a, 'marketing');
    const desc = await generate(a, { kind: 'menu_description', locale: 'en', brief: 'Ice cold and fizzy', productId: menu.products.soda });
    await approve(a, desc.body.id);
    expect((await apply(a, desc.body.id, { variant: 0, key: 'apply-mkt-menu-01', target: { kind: 'product_description', productId: menu.products.soda } }, marketing)).status).toBe(403);
    const other = await generate(a, { kind: 'post', locale: 'ar', brief: 'عرض الخميس على المشروبات' });
    await approve(a, other.body.id);
    expect((await apply(a, other.body.id, { variant: 0, key: 'apply-mkt-camp-01', target: { kind: 'campaign_draft', channel: 'whatsapp' } }, marketing)).status).toBe(201);
    const waiter = await addMember(t, a, 'waiter');
    expect((await apply(a, other.body.id, { variant: 0, key: 'apply-waiter-0001', target: { kind: 'campaign_draft', channel: 'organic' } }, waiter)).status).toBe(403);

    // Tenancy and validation.
    const b = await createTenant(t);
    expect((await apply(b, gen.body.id, { variant: 0, key: 'apply-other-org-01', target: { kind: 'campaign_draft', channel: 'organic' } })).status).toBe(404);
    expect((await apply(a, gen.body.id, { variant: 2, key: 'apply-variant-0001', target: { kind: 'campaign_draft', channel: 'organic' } })).status).toBe(422);
    expect((await apply(a, gen.body.id, { variant: 0, key: 'short', target: { kind: 'campaign_draft', channel: 'organic' } })).status).toBe(400);
    expect((await apply(a, gen.body.id, { variant: 0, key: 'apply-badchan-001', target: { kind: 'campaign_draft', channel: 'meta_ads' } })).status).toBe(400);
  });
});

describe('legacy generate-copy endpoint', () => {
  it('still answers but is marked deprecated in favour of Studio creative', async () => {
    const res = await t.http.post(`/v1/o/${a.orgId}/intelligence/generate-copy`).set(auth(a.owner)).send({ kind: 'caption', locale: 'en', productId: menu.products.burger });
    expect(res.status).toBe(201);
    expect(res.headers.deprecation).toBe('true');
    expect(res.body).toMatchObject({ provider: 'template', isFallback: true });
  });
});
