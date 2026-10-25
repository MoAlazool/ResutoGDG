import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { DNS_RESOLVER, DOMAIN_PROVIDER, ManualDomainProvider, VercelDomainProvider, type DomainProvider } from '../src/modules/studio/domain-provider';
import { addMember, auth, createTenant, seedMenu, sql, type TestApp, type TestTenant } from './helpers';
import { TenantContext } from '../src/common/auth/context';
import { DbService } from '../src/common/db/db.service';
import { AuditService } from '../src/common/platform/audit.service';
import { ENV } from '../src/config/env';
import { PlanLimitsService } from '../src/modules/billing/plan-limits.service';
import { MenuService } from '../src/modules/menu/menu.service';
import { StudioAiService } from '../src/modules/studio/ai/studio-ai.service';
import { CreativeService } from '../src/modules/studio/creative.service';
import { StudioService } from '../src/modules/studio/studio.service';

// --- Injected test doubles (provider tokens, not a mocked database) ---------------
const txtRecords = new Map<string, string[][]>();
const stubResolver = async (name: string) => {
  const r = txtRecords.get(name);
  if (!r) throw Object.assign(new Error(`queryTxt ENOTFOUND ${name}`), { code: 'ENOTFOUND' });
  return r;
};
/** Records calls; reports "active" only after the test flips confirmation on (as a host would after routing works). */
class RecordingProvider implements DomainProvider {
  readonly id = 'vercel' as const;
  readonly readiness = 'implemented_unverified' as const;
  confirmed = new Set<string>();
  attached: string[] = [];
  async attach(hostname: string) {
    this.attached.push(hostname);
    return { routingRecords: [{ type: 'CNAME' as const, name: hostname, value: 'cname.vercel-dns.com', purpose: 'routing' as const }], instructions: ['Create the CNAME'], details: { mode: 'test' } };
  }
  async status(hostname: string) {
    const active = this.confirmed.has(hostname);
    return { active, sslIssued: active, instructions: active ? [] : ['Waiting for DNS'], details: { mode: 'test' } };
  }
  async detach() {}
}
const provider = new RecordingProvider();

let t: TestApp;
beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(DNS_RESOLVER).useValue(stubResolver)
    .overrideProvider(DOMAIN_PROVIDER).useValue(provider)
    .compile();
  const app = moduleRef.createNestApplication({ rawBody: true, logger: ['error'] });
  app.setGlobalPrefix('v1');
  await app.init();
  t = { app, http: request(app.getHttpServer()), close: () => app.close() };
});
afterAll(async () => { await t.close(); });

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const base = (x: TestTenant) => `/v1/o/${x.orgId}/studio`;
const host = (s: string) => `${s.replace(/[^a-z0-9]/g, '')}.example-restaurant.com`;

describe('website editor', () => {
  let tenant: TestTenant;
  beforeEach(async () => { tenant = await createTenant(t); });

  it('returns the seeded draft and updates template, theme and SEO', async () => {
    const res = await t.http.get(`${base(tenant)}/website`).set(auth(tenant.owner));
    expect(res.status).toBe(200);
    expect(res.body.website).toMatchObject({ template: 'olive', status: 'draft', publishedRevision: 0, hasUnpublishedChanges: true });
    expect(res.body.sections.map((s: any) => s.kind)).toEqual(['hero', 'menu_highlights', 'reservations', 'ordering', 'location']);
    expect(res.body.publicPath).toBe(`/r/${tenant.slug}`);

    const upd = await t.http.patch(`${base(tenant)}/website`).set(auth(tenant.owner)).send({
      template: 'smash', theme: { primaryColor: '#b51218', accentColor: '#ffd52f' },
      seo: { title: { en: 'Smash & Co', ar: 'سماش' }, description: { en: 'Burgers', ar: 'برجر' } },
    });
    expect(upd.status).toBe(200);
    expect(upd.body.website).toMatchObject({ template: 'smash', theme: { primaryColor: '#b51218' }, seo: { title: { ar: 'سماش' } } });
    expect(upd.body.website.draftRevision).toBeGreaterThan(res.body.website.draftRevision);
    const audit = await sql(`select action from audit_logs where org_id = $1 and action = 'website.updated'`, [tenant.orgId]);
    expect(audit).toHaveLength(1);
  });

  it('validates input', async () => {
    const bad = await t.http.patch(`${base(tenant)}/website`).set(auth(tenant.owner)).send({ template: 'neon', theme: { primaryColor: 'red' } });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('validation_failed');
    const unknownMedia = await t.http.patch(`${base(tenant)}/website`).set(auth(tenant.owner)).send({ theme: { logoMediaId: '00000000-0000-4000-8000-000000000000' } });
    expect(unknownMedia.status).toBe(422);
    expect(unknownMedia.body.error.code).toBe('unknown_media');
    const badSection = await t.http.post(`${base(tenant)}/website/sections`).set(auth(tenant.owner)).send({ kind: 'popup', content: {} });
    expect(badSection.status).toBe(400);
  });

  it('creates, edits, hides, reorders and deletes sections', async () => {
    const created = await t.http.post(`${base(tenant)}/website/sections`).set(auth(tenant.owner)).send({
      kind: 'about', content: { headline: { en: 'Our story', ar: 'قصتنا' }, body: { en: 'Since 1998.', ar: 'منذ 1998.' } },
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ kind: 'about', sortOrder: 5, isVisible: true });
    const edited = await t.http.patch(`${base(tenant)}/website/sections/${created.body.id}`).set(auth(tenant.owner)).send({ isVisible: false });
    expect(edited.body.isVisible).toBe(false);
    expect(edited.body.content.headline.ar).toBe('قصتنا');

    const site = (await t.http.get(`${base(tenant)}/website`).set(auth(tenant.owner))).body;
    const ids = site.sections.map((s: any) => s.id).reverse();
    const reordered = await t.http.post(`${base(tenant)}/website/sections/reorder`).set(auth(tenant.owner)).send({ ids });
    expect(reordered.status).toBe(200);
    expect(reordered.body.sections.map((s: any) => s.id)).toEqual(ids);
    const mismatch = await t.http.post(`${base(tenant)}/website/sections/reorder`).set(auth(tenant.owner)).send({ ids: ids.slice(1) });
    expect(mismatch.status).toBe(422);

    expect((await t.http.delete(`${base(tenant)}/website/sections/${created.body.id}`).set(auth(tenant.owner))).status).toBe(200);
    expect((await t.http.delete(`${base(tenant)}/website/sections/${created.body.id}`).set(auth(tenant.owner))).status).toBe(404);
  });
});

describe('publishing and the public website', () => {
  it('serves only published revisions, by slug, without internal fields', async () => {
    const tenant = await createTenant(t, { name: 'Olive Room' });
    const menu = await seedMenu(tenant);
    expect((await t.http.get(`/v1/public/sites/${tenant.slug}`)).status).toBe(404);

    const products = await t.http.get(`${base(tenant)}/products?q=smash`).set(auth(tenant.owner));
    expect(products.body.items).toEqual([expect.objectContaining({ id: menu.products.burger, name: 'Smash burger', priceMinor: 18500 })]);
    expect(products.body.items[0]).not.toHaveProperty('costMinor');
    const site = (await t.http.get(`${base(tenant)}/website`).set(auth(tenant.owner))).body;
    const highlights = site.sections.find((s: any) => s.kind === 'menu_highlights');
    await t.http.patch(`${base(tenant)}/website/sections/${highlights.id}`).set(auth(tenant.owner))
      .send({ content: { headline: { en: 'Favourites' }, productIds: [menu.products.burger, menu.products.fries] } }).expect(200);

    const key = 'publish-key-0001';
    const pub = await t.http.post(`${base(tenant)}/website/publish`).set(auth(tenant.owner)).send({ key });
    expect(pub.status).toBe(200);
    expect(pub.body.revision).toBe(1);
    const retry = await t.http.post(`${base(tenant)}/website/publish`).set(auth(tenant.owner)).send({ key });
    expect(retry.body).toEqual(pub.body);
    const reused = await t.http.post(`${base(tenant)}/website/publish`).set(auth(tenant.owner)).send({ key, note: 'different' });
    expect(reused.status).toBe(409);

    const pubSite = await t.http.get(`/v1/public/sites/${tenant.slug}`);
    expect(pubSite.status).toBe(200);
    expect(pubSite.body).toMatchObject({ slug: tenant.slug, revision: 1, preview: false, template: 'olive', org: { name: 'Olive Room', currency: 'EGP' } });
    expect(pubSite.body.menuHighlights.map((p: any) => p.name)).toEqual(['Smash burger', 'Fries']);
    expect(pubSite.body.menuHighlights[0]).toMatchObject({ priceMinor: 18500, currency: 'EGP' });
    expect(pubSite.body.branches[0]).toMatchObject({ name: 'Main branch', acceptsDelivery: true });
    expect(pubSite.body.links).toEqual({ reserve: `/reserve/${tenant.slug}`, order: `/order/${tenant.slug}`, site: `/r/${tenant.slug}` });
    // The random test slug is expected in the answer and can itself contain "qr" (or "cost"), so it is removed before
    // the text check; everything else in the body is still checked.
    const raw = JSON.stringify(pubSite.body).split(tenant.slug).join('');
    for (const leak of ['cost', 'qr', menu.qrToken, 'internal', 'stock', tenant.owner.email]) expect(raw.toLowerCase()).not.toContain(leak.toLowerCase());

    // Draft edits stay private until the next publish.
    await t.http.patch(`${base(tenant)}/website`).set(auth(tenant.owner)).send({ template: 'minimal' }).expect(200);
    expect((await t.http.get(`/v1/public/sites/${tenant.slug}`)).body.template).toBe('olive');
    const preview = await t.http.get(`${base(tenant)}/website/preview`).set(auth(tenant.owner));
    expect(preview.body).toMatchObject({ template: 'minimal', preview: true });
    const draft = (await t.http.get(`${base(tenant)}/website`).set(auth(tenant.owner))).body;
    expect(draft.website.hasUnpublishedChanges).toBe(true);

    const second = await t.http.post(`${base(tenant)}/website/publish`).set(auth(tenant.owner)).send({ key: 'publish-key-0002', note: 'Minimal look' });
    expect(second.body.revision).toBe(2);
    expect((await t.http.get(`/v1/public/sites/${tenant.slug}`)).body).toMatchObject({ template: 'minimal', revision: 2 });

    const revs = await t.http.get(`${base(tenant)}/website/revisions`).set(auth(tenant.owner));
    expect(revs.body.items.map((r: any) => r.revision)).toEqual([2, 1]);
    expect(revs.body.items[0].note).toBe('Minimal look');
    const restored = await t.http.post(`${base(tenant)}/website/revisions/1/restore`).set(auth(tenant.owner));
    expect(restored.status).toBe(200);
    expect(restored.body.website.template).toBe('olive');
    expect((await t.http.get(`/v1/public/sites/${tenant.slug}`)).body.revision).toBe(2);
    await expect(sql(`update website_revisions set note = 'x' where org_id = $1`, [tenant.orgId])).rejects.toThrow(/immutable/);
  });

  it('returns 404 for unknown slugs and hosts', async () => {
    expect((await t.http.get('/v1/public/sites/no-such-restaurant-xyz')).status).toBe(404);
    expect((await t.http.get('/v1/public/sites/by-host/unknown.example.org')).status).toBe(404);
    expect((await t.http.get('/v1/public/sites/by-host/not a host')).status).toBe(404);
  });
});

describe('media library', () => {
  it('uploads, lists and deletes only unused images', async () => {
    const tenant = await createTenant(t);
    const up = await t.http.post(`${base(tenant)}/media`).set(auth(tenant.owner)).attach('file', PNG, { filename: 'logo.png', contentType: 'image/png' }).field('alt', 'Logo');
    expect(up.status).toBe(201);
    expect(up.body).toMatchObject({ contentType: 'image/png', alt: 'Logo', inUse: false });
    expect(up.body.url).toContain('/v1/media/');

    const mismatch = await t.http.post(`${base(tenant)}/media`).set(auth(tenant.owner)).attach('file', Buffer.from('not an image at all'), { filename: 'x.png', contentType: 'image/png' });
    expect(mismatch.status).toBe(422);

    await t.http.patch(`${base(tenant)}/website`).set(auth(tenant.owner)).send({ theme: { logoMediaId: up.body.id } }).expect(200);
    const list = await t.http.get(`${base(tenant)}/media`).set(auth(tenant.owner));
    expect(list.body.items).toHaveLength(1);
    expect(list.body.items[0].inUse).toBe(true);
    const blocked = await t.http.delete(`${base(tenant)}/media/${up.body.id}`).set(auth(tenant.owner));
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe('media_in_use');

    await t.http.patch(`${base(tenant)}/website`).set(auth(tenant.owner)).send({ theme: { logoMediaId: null } }).expect(200);
    expect((await t.http.delete(`${base(tenant)}/media/${up.body.id}`).set(auth(tenant.owner))).status).toBe(200);
    expect((await t.http.get(`${base(tenant)}/media`).set(auth(tenant.owner))).body.items).toHaveLength(0);
  });
});

describe('custom domains', () => {
  it('verifies ownership by TXT record, provisions at the host and resolves to the same tenant', async () => {
    const tenant = await createTenant(t);
    await t.http.post(`${base(tenant)}/website/publish`).set(auth(tenant.owner)).send({ key: 'domain-publish-01' }).expect(200);
    const hostname = host(tenant.slug);

    const added = await t.http.post(`${base(tenant)}/domains`).set(auth(tenant.owner)).send({ hostname: hostname.toUpperCase() });
    expect(added.status).toBe(201);
    expect(added.body).toMatchObject({ hostname, status: 'pending_verification', verificationRecord: { type: 'TXT', name: `_resuto-verify.${hostname}` } });
    const token = added.body.verificationRecord.value as string;
    expect(token).toMatch(/^resuto-/);
    // Not routable before ownership is proven.
    expect((await t.http.get(`/v1/public/sites/by-host/${hostname}`)).status).toBe(404);

    const missing = await t.http.post(`${base(tenant)}/domains/${added.body.id}/verify`).set(auth(tenant.owner));
    expect(missing.body).toMatchObject({ status: 'pending_verification' });
    expect(missing.body.lastError).toContain('No TXT record');
    txtRecords.set(`_resuto-verify.${hostname}`, [['some-other-value']]);
    const wrong = await t.http.post(`${base(tenant)}/domains/${added.body.id}/verify`).set(auth(tenant.owner));
    expect(wrong.body.status).toBe('pending_verification');

    // TXT values may be split into chunks by DNS servers.
    txtRecords.set(`_resuto-verify.${hostname}`, [['v=spf1 -all'], [token.slice(0, 10), token.slice(10)]]);
    const verified = await t.http.post(`${base(tenant)}/domains/${added.body.id}/verify`).set(auth(tenant.owner));
    expect(verified.status).toBe(200);
    expect(verified.body).toMatchObject({ status: 'provisioning', provider: 'vercel', providerReadiness: 'implemented_unverified', lastError: null });
    expect(verified.body.routingRecords[0]).toMatchObject({ type: 'CNAME', value: 'cname.vercel-dns.com' });
    expect(provider.attached).toContain(hostname);

    const byHost = await t.http.get(`/v1/public/sites/by-host/${hostname}:443`);
    expect(byHost.status).toBe(200);
    expect(byHost.body.slug).toBe(tenant.slug);
    expect(byHost.body.canonicalHost).toBeNull();

    // Never active without the host's confirmation.
    const pending = await t.http.post(`${base(tenant)}/domains/${added.body.id}/refresh`).set(auth(tenant.owner));
    expect(pending.body).toMatchObject({ status: 'provisioning', sslStatus: 'pending' });
    provider.confirmed.add(hostname);
    const active = await t.http.post(`${base(tenant)}/domains/${added.body.id}/refresh`).set(auth(tenant.owner));
    expect(active.body).toMatchObject({ status: 'active', sslStatus: 'issued' });
    expect((await t.http.get(`/v1/public/sites/${tenant.slug}`)).body.canonicalHost).toBe(hostname);

    // A domain belongs to one website only.
    const other = await createTenant(t);
    const dup = await t.http.post(`${base(other)}/domains`).set(auth(other.owner)).send({ hostname });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('domain_taken');

    expect((await t.http.delete(`${base(tenant)}/domains/${added.body.id}`).set(auth(tenant.owner))).status).toBe(200);
    expect((await t.http.get(`/v1/public/sites/by-host/${hostname}`)).status).toBe(404);
  });

  it('rejects reserved and malformed hostnames', async () => {
    const tenant = await createTenant(t);
    expect((await t.http.post(`${base(tenant)}/domains`).set(auth(tenant.owner)).send({ hostname: 'my.resuto.app' })).status).toBe(422);
    expect((await t.http.post(`${base(tenant)}/domains`).set(auth(tenant.owner)).send({ hostname: 'http://bad host' })).status).toBe(400);
  });

  it('manual provider never reports a domain as active', async () => {
    const manual = new ManualDomainProvider('sites.example-host.net', undefined);
    const attach = await manual.attach('www.example.com');
    expect(attach.routingRecords).toEqual([{ type: 'CNAME', name: 'www.example.com', value: 'sites.example-host.net', purpose: 'routing' }]);
    expect((await manual.status('www.example.com')).active).toBe(false);
    expect((await new ManualDomainProvider(undefined, undefined).attach('example.com')).routingRecords).toEqual([]);
  });

  it('Vercel adapter calls the documented endpoints and requires verified + configured', async () => {
    const calls: Array<{ method: string; url: string; body?: string; auth?: string }> = [];
    let misconfigured = true;
    const fakeFetch = (async (url: URL, init: RequestInit) => {
      calls.push({ method: String(init.method), url: String(url), body: init.body as string, auth: (init.headers as any).Authorization });
      const path = new URL(String(url)).pathname;
      const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
      if (init.method === 'POST') return json(200, { name: 'www.example.com', verified: false, verification: [{ type: 'TXT', domain: '_vercel.example.com', value: 'vc-domain-verify=abc', reason: 'pending_domain_verification' }] });
      if (path.startsWith('/v9/projects/')) return json(200, { name: 'www.example.com', verified: true });
      if (path.startsWith('/v6/domains/')) return json(200, { misconfigured });
      return json(404, { error: { code: 'not_found' } });
    }) as unknown as typeof fetch;
    // INT-27: the certificate status is read from the served certificate (scripted probe here), not inferred.
    let certIssued = false;
    const probed: string[] = [];
    const probe = async (hostname: string) => {
      probed.push(hostname);
      return { hostname, issued: certIssued, reason: certIssued ? 'ok' as const : 'untrusted_chain' as const, issuer: certIssued ? "Let's Encrypt / R11" : null,
        validFrom: null, validTo: null, daysLeft: certIssued ? 80 : null, checkedAt: new Date().toISOString() };
    };
    const vercel = new VercelDomainProvider('tok_test', 'prj_123', 'team_9', fakeFetch, probe);
    const attach = await vercel.attach('www.example.com');
    expect(calls[0]).toMatchObject({ method: 'POST', url: 'https://api.vercel.com/v10/projects/prj_123/domains?teamId=team_9', auth: 'Bearer tok_test' });
    expect(JSON.parse(calls[0]!.body!)).toEqual({ name: 'www.example.com' });
    expect(attach.routingRecords).toEqual([
      { type: 'CNAME', name: 'www.example.com', value: 'cname.vercel-dns.com', purpose: 'routing' },
      { type: 'TXT', name: '_vercel.example.com', value: 'vc-domain-verify=abc', purpose: 'ownership' },
    ]);
    expect((await vercel.status('www.example.com')).active).toBe(false);
    expect(probed).toEqual([]); // no certificate can exist before Vercel routes the domain
    misconfigured = false;
    // Verified and configured is no longer enough (it used to set sslIssued = active): HTTPS must actually work.
    const noCert = await vercel.status('www.example.com');
    expect(noCert).toMatchObject({ active: false, sslIssued: false, details: { certificate: { issued: false, reason: 'untrusted_chain' } } });
    certIssued = true;
    expect(await vercel.status('www.example.com')).toMatchObject({ active: true, sslIssued: true, details: { certificate: { issued: true, issuer: "Let's Encrypt / R11" } } });
    expect(calls.map((c) => `${c.method} ${new URL(c.url).pathname}`)).toContain('GET /v6/domains/www.example.com/config');
    expect((await vercel.attach('example.com')).routingRecords[0]).toMatchObject({ type: 'A', value: '76.76.21.21' });
  });

  it('INT-27: a .com.eg / .com.sa apex gets an A record, never a CNAME at the zone apex', async () => {
    // Before: hostname.split('.').length === 2 treated brand.com.eg as a subdomain and returned a CNAME for it.
    const manual = new ManualDomainProvider('sites.example-host.net', '203.0.113.7');
    for (const apex of ['brand.com.eg', 'brand.com.sa']) {
      const a = await manual.attach(apex);
      expect(a.routingRecords).toEqual([{ type: 'A', name: apex, value: '203.0.113.7', purpose: 'routing' }]);
      expect(a.details).toMatchObject({ apex: true, registrableDomain: apex, pslCoverage: 'icann' });
    }
    expect((await manual.attach('www.brand.com.eg')).routingRecords[0]).toMatchObject({ type: 'CNAME', value: 'sites.example-host.net' });
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    const vercel = new VercelDomainProvider('tok', 'prj', undefined, (async () => json(200, { name: 'brand.com.sa', verified: false, verification: [] })) as any,
      async () => { throw new Error('not probed'); });
    const attached = await vercel.attach('brand.com.sa');
    expect(attached.routingRecords[0]).toEqual({ type: 'A', name: 'brand.com.sa', value: '76.76.21.21', purpose: 'routing' });
    expect(attached.instructions[0]).toMatch(/root of its domain, so a CNAME is not allowed/);
  });
});

describe('creative generator', () => {
  it('falls back to labelled template copy without a Gemini key and supports review', async () => {
    const tenant = await createTenant(t, { name: 'Olive Room' });
    const menu = await seedMenu(tenant);
    const gen = await t.http.post(`${base(tenant)}/creative`).set(auth(tenant.owner))
      .send({ kind: 'caption', locale: 'ar', brief: 'عرض نهاية الأسبوع على البرجر', productId: menu.products.burger, variants: 2 });
    expect(gen.status).toBe(201);
    expect(gen.body).toMatchObject({ kind: 'caption', locale: 'ar', provider: 'template_rules', isFallback: true, status: 'draft' });
    expect(gen.body.output.fallbackReason).toContain('No language model key');
    expect(gen.body.authorship).toEqual({ mode: 'template', provider: 'template_rules', model: null, keySource: null, fallbackCode: 'not_configured' });
    expect(gen.body.output.variants).toHaveLength(2);
    expect(gen.body.output.variants[0].text).toContain('Smash burger');

    const web = await t.http.post(`${base(tenant)}/creative`).set(auth(tenant.owner)).send({ kind: 'website_copy', locale: 'en', brief: 'Seasonal plates and warm hospitality', variants: 1 });
    expect(web.body.output.variants[0].title).toContain('Olive Room');

    const approved = await t.http.patch(`${base(tenant)}/creative/${gen.body.id}`).set(auth(tenant.owner)).send({ status: 'approved' });
    expect(approved.body.status).toBe('approved');
    const list = await t.http.get(`${base(tenant)}/creative?status=approved`).set(auth(tenant.owner));
    expect(list.body.items.map((c: any) => c.id)).toEqual([gen.body.id]);
    expect((await t.http.post(`${base(tenant)}/creative`).set(auth(tenant.owner)).send({ kind: 'caption', locale: 'en', brief: 'x' })).status).toBe(400);
    expect((await t.http.post(`${base(tenant)}/creative`).set(auth(tenant.owner)).send({ kind: 'caption', locale: 'en', brief: 'Valid brief', productId: '00000000-0000-4000-8000-000000000000' })).status).toBe(422);
  });

  it('FT-10: with a model configured, refuses before calling it once ai_requests_per_month is used, and meters model calls', async () => {
    const tenant = await createTenant(t);
    const ctx = new TenantContext(tenant.orgId, 'owner', null, tenant.owner.userId, 'user', tenant.owner.userId);
    const env = { ...t.app.get(ENV), GEMINI_API_KEY: 'test-key', GEMINI_MODEL: 'gemini-test' };
    const realFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify({ variants: [{ title: 'T', text: 'Fresh bread daily' }] }) }] } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    try {
      // No BYOK connection on this tenant, so generation uses the platform key and counts against the plan (FT-10).
      const svc = new CreativeService(t.app.get(DbService), t.app.get(AuditService), t.app.get(MenuService), t.app.get(StudioService),
        t.app.get(StudioAiService), env as any, t.app.get(PlanLimitsService));
      const capPlan = `ai-cap-${tenant.orgId.slice(0, 8)}`;
      await sql(`insert into plans(id, name, is_public, limits) values ($1, 'AI cap', false, '{"ai_requests_per_month":1}')`, [capPlan]);
      await sql(`update subscriptions set plan_id = $2 where org_id = $1`, [tenant.orgId, capPlan]);
      const input = { kind: 'caption', locale: 'en', brief: 'Weekend bread special', variants: 1, tone: 'warm' } as any;
      const first = await svc.generate(ctx, input);
      expect(first).toMatchObject({ provider: 'gemini', isFallback: false });
      expect(calls).toBe(1);
      const [{ n }] = await sql(`select count(*)::int as n from usage_events where org_id = $1 and metric = 'ai_requests'`, [tenant.orgId]);
      expect(n).toBe(1);
      await expect(svc.generate(ctx, input)).rejects.toMatchObject({ status: 402, code: 'plan_limit_reached', details: { limit: 'ai_requests_per_month' } });
      expect(calls).toBe(1); // refused before the model call
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe('access control', () => {
  it('denies roles without studio permissions and allows marketing to publish', async () => {
    const tenant = await createTenant(t);
    const kitchen = await addMember(t, tenant, 'kitchen');
    expect((await t.http.get(`${base(tenant)}/website`).set(auth(kitchen))).status).toBe(403);
    const host = await addMember(t, tenant, 'host');
    expect((await t.http.post(`${base(tenant)}/website/publish`).set(auth(host)).send({ key: 'host-publish-01' })).status).toBe(403);
    const marketing = await addMember(t, tenant, 'marketing');
    expect((await t.http.post(`${base(tenant)}/website/publish`).set(auth(marketing)).send({ key: 'mkt-publish-001' })).status).toBe(200);
    expect((await t.http.post(`${base(tenant)}/domains`).set(auth(kitchen)).send({ hostname: 'x.example.com' })).status).toBe(403);
  });

  it('hides other tenants behind 404', async () => {
    const a = await createTenant(t);
    const b = await createTenant(t);
    expect((await t.http.get(`${base(b)}/website`).set(auth(a.owner))).status).toBe(404);
    const bSite = (await t.http.get(`${base(b)}/website`).set(auth(b.owner))).body;
    const res = await t.http.patch(`${base(a)}/website/sections/${bSite.sections[0].id}`).set(auth(a.owner)).send({ isVisible: false });
    expect(res.status).toBe(404);
    const bDomain = await t.http.post(`${base(b)}/domains`).set(auth(b.owner)).send({ hostname: host(b.slug) });
    expect((await t.http.post(`${base(a)}/domains/${bDomain.body.id}/verify`).set(auth(a.owner))).status).toBe(404);
  });

  it('requires the studio module (free plan is denied)', async () => {
    const free = await createTenant(t, { planId: 'free' });
    const res = await t.http.get(`${base(free)}/website`).set(auth(free.owner));
    expect(res.status).toBe(402);
    expect(res.body.error.code).toBe('module_not_entitled');
  });
});
