import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ProviderHttp } from '../src/modules/integrations/provider-http';
import { MenuExtractionService } from '../src/modules/studio/menu-extraction/menu-extraction.service';
import { addMember, auth, bootTestApp, createTenant, sql, type TestApp, type TestTenant } from './helpers';

// FT-08 / VS-26: menu extraction jobs. Text/CSV are read by Resuto's own parser (no model); photos/PDFs only with the
// restaurant's own Gemini key (BYOK). The model is a scripted fake behind ProviderHttp (the single outbound entry point).

let t: TestApp;
let http: ProviderHttp;
let original: typeof fetch;
const calls: Array<{ url: string; body: any; key: string | null }> = [];
let script: (url: string, body: any) => Response = () => new Response('{}', { status: 500 });

beforeAll(async () => {
  t = await bootTestApp();
  http = t.app.get(ProviderHttp);
  original = http.fetch;
  http.fetch = (async (input: any, init: any) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ url, body, key: (init?.headers as any)?.['x-goog-api-key'] ?? null });
    return script(url, body);
  }) as typeof fetch;
});
afterAll(async () => { http.fetch = original; await t.close(); });

const api = (x: TestTenant, p: string) => `/v1/o/${x.orgId}${p}`;
const MENU = ['Starters / المقبلات', 'Hummus - حمص ........ 85', 'Chickpeas, tahini and olive oil', 'Falafel (6 pcs)  EGP 60', '+ Extra tahini 10',
  '', 'Drinks', 'Fresh juice  Small 25 / Large 35'].join('\n');
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'Content-Type': 'application/json' } });
const gemini = (payload: unknown) => json({ candidates: [{ content: { parts: [{ text: JSON.stringify(payload) }] }, finishReason: 'STOP' }] });

async function connectGemini(x: TestTenant) {
  script = (url) => (url.includes('/models?pageSize=1') ? json({ models: [{ name: 'models/gemini-2.5-flash' }] }) : json({}, 404));
  const created = await t.http.post(api(x, '/integrations/connections')).set(auth(x.owner))
    .send({ provider: 'gemini_byok', environment: 'live', credentials: { apiKey: 'AIza-test-restaurant-key-0001' } });
  expect(created.status).toBe(201);
  const health = await t.http.post(api(x, `/integrations/connections/${created.body.id}/health`)).set(auth(x.owner)).send({});
  expect(health.status).toBe(201);
  expect(health.body.status).toBe('connected');
  return created.body.id as string;
}

describe('menu extraction from text and CSV (no model)', () => {
  let tenant: TestTenant;
  beforeEach(async () => { tenant = await createTenant(t); calls.length = 0; });

  it('reports capabilities honestly: text/CSV always, photos/PDFs only with the restaurant key', async () => {
    const cap = await t.http.get(api(tenant, '/studio-ai/capabilities')).set(auth(tenant.owner));
    expect(cap.status).toBe(200);
    expect(cap.body).toMatchObject({ byok: { provider: 'gemini_byok', configured: false }, menuExtraction: { text: true, csv: true, image: false, pdf: false, floorPlan: false },
      photoEnhancement: { generative: false } });
  });

  it('parses text into a versioned draft, validates edits, and commits only approved rows through the menu import', async () => {
    const created = await t.http.post(api(tenant, '/menu-import/jobs/text')).set(auth(tenant.owner)).send({ kind: 'text', text: MENU, name: 'board.txt' });
    expect(created.status).toBe(201);
    const job = created.body;
    expect(job).toMatchObject({ status: 'review', mode: 'heuristic_text', provider: 'resuto_parser', model: null, version: 1 });
    expect(job.rows.map((r: any) => [r.name, r.nameAr, r.category, r.priceMinor])).toEqual([
      ['Hummus', 'حمص', 'Starters', 8500], ['Falafel (6 pcs)', null, 'Starters', 6000], ['Fresh juice', null, 'Drinks', 2500]]);
    expect(calls).toHaveLength(0); // no model involved
    // Nothing on the menu yet.
    expect(await sql('select 1 from products where org_id = $1', [tenant.orgId])).toHaveLength(0);

    // Reviewer approves two rows, rejects one, and fixes the Arabic name of the juice.
    const rows = job.rows.map((r: any) => (r.name === 'Falafel (6 pcs)' ? { ...r, status: 'rejected' } : { ...r, status: 'approved', available: r.name === 'Hummus' }));
    rows[2].nameAr = 'عصير طازج';
    const saved = await t.http.patch(api(tenant, `/menu-import/jobs/${job.id}`)).set(auth(tenant.owner)).send({ version: 1, rows });
    expect(saved.status).toBe(200);
    expect(saved.body.version).toBe(2);
    expect(saved.body.summary).toMatchObject({ approved: 2, rejected: 1, errors: 0 });
    // A second editor working on the old version is refused instead of overwriting.
    const stale = await t.http.patch(api(tenant, `/menu-import/jobs/${job.id}`)).set(auth(tenant.owner)).send({ version: 1, rows });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('extraction_stale');
    // Committing a version the reviewer did not see is refused too.
    expect((await t.http.post(api(tenant, `/menu-import/jobs/${job.id}/commit`)).set(auth(tenant.owner)).send({ version: 1, key: 'commit-key-0001' })).status).toBe(409);

    const commit = await t.http.post(api(tenant, `/menu-import/jobs/${job.id}/commit`)).set(auth(tenant.owner)).send({ version: 2, key: 'commit-key-0001' });
    expect(commit.status).toBe(201);
    expect(commit.body).toMatchObject({ status: 'committed', commitResult: { created: 2, updated: 0, modifierGroupsCreated: 1 } });
    const products = await sql<any>(`select p.id, p.name, p.name_ar, p.price_minor, c.name as category from products p join menu_categories c on c.id = p.category_id
      where p.org_id = $1 order by p.name`, [tenant.orgId]);
    expect(products.map((p) => [p.name, p.name_ar, Number(p.price_minor), p.category])).toEqual([
      ['Fresh juice', 'عصير طازج', 2500, 'Drinks'], ['Hummus', 'حمص', 8500, 'Starters']]);
    // Unticked "available to order" -> unavailable at every branch until someone switches it on.
    const juice = products.find((p) => p.name === 'Fresh juice');
    expect(await sql(`select is_available from product_branch_settings where product_id = $1`, [juice.id])).toEqual([{ is_available: false }]);
    expect(await sql(`select 1 from product_branch_settings where product_id = $1 and not is_available`, [products.find((p) => p.name === 'Hummus').id])).toHaveLength(0);
    // Sizes became a required single-choice group with price deltas.
    const groups = await sql<any>(`select g.name, g.name_ar, g.min_select, g.max_select, array_agg(o.name || ':' || o.price_delta_minor order by o.sort_order) as options
      from product_modifier_groups pg join modifier_groups g on g.id = pg.group_id join modifier_options o on o.group_id = g.id
      where pg.product_id = $1 group by g.id`, [juice.id]);
    expect(groups).toEqual([{ name: 'Size', name_ar: 'الحجم', min_select: 1, max_select: 1, options: ['Small:0', 'Large:1000'] }]);

    // A retried commit replays: no second import, no duplicate groups.
    const again = await t.http.post(api(tenant, `/menu-import/jobs/${job.id}/commit`)).set(auth(tenant.owner)).send({ version: 2, key: 'commit-key-0001' });
    expect(again.status).toBe(201);
    expect(again.body.status).toBe('committed');
    expect(await sql('select 1 from products where org_id = $1', [tenant.orgId])).toHaveLength(2);
    expect(await sql('select 1 from modifier_groups where org_id = $1', [tenant.orgId])).toHaveLength(1);
    const audit = await sql<any>(`select action, metadata from audit_logs where org_id = $1 and action like 'menu_extraction.%' order by created_at`, [tenant.orgId]);
    expect(audit.map((a) => a.action)).toEqual(['menu_extraction.created', 'menu_extraction.edited', 'menu_extraction.committed']);
    expect(audit[2].metadata).toMatchObject({ source: 'text', created: 2 });
    expect(await sql(`select 1 from audit_logs where org_id = $1 and action = 'menu.imported' and metadata->>'source' = 'text'`, [tenant.orgId])).toHaveLength(1);
  });

  it('runs one commit at a time: concurrent commits never duplicate sizes/add-ons, and a crashed commit is resumed', async () => {
    const text = 'Drinks\nFresh juice  Small 25 / Large 35\nTea Small 10 / Large 15\nCoffee Small 20 / Large 30';
    const job = (await t.http.post(api(tenant, '/menu-import/jobs/text')).set(auth(tenant.owner)).send({ kind: 'text', text })).body;
    expect(job.rows.map((r: any) => r.modifiers.length)).toEqual([1, 1, 1]);
    const rows = job.rows.map((r: any) => ({ ...r, status: 'approved' }));
    const v = (await t.http.patch(api(tenant, `/menu-import/jobs/${job.id}`)).set(auth(tenant.owner)).send({ version: job.version, rows })).body.version;
    const results = await Promise.all([0, 1, 2, 3].map(() =>
      t.http.post(api(tenant, `/menu-import/jobs/${job.id}/commit`)).set(auth(tenant.owner)).send({ version: v, key: 'commit-race-0001' })));
    // One commit did the work; the others were told it is in progress (or replayed the finished result).
    for (const r of results) {
      expect([201, 409]).toContain(r.status);
      if (r.status === 409) expect(r.body.error.code).toBe('extraction_commit_in_progress');
      else expect(r.body.status).toBe('committed');
    }
    expect(results.some((r) => r.status === 201)).toBe(true);
    expect(await sql('select 1 from products where org_id = $1', [tenant.orgId])).toHaveLength(3);
    expect(await sql('select 1 from modifier_groups where org_id = $1', [tenant.orgId])).toHaveLength(3);
    expect(await sql('select 1 from product_modifier_groups pg join products p on p.id = pg.product_id where p.org_id = $1', [tenant.orgId])).toHaveLength(3);
    expect(await sql(`select 1 from audit_logs where org_id = $1 and action = 'menu_extraction.committed'`, [tenant.orgId])).toHaveLength(1);
    const final = (await t.http.get(api(tenant, `/menu-import/jobs/${job.id}`)).set(auth(tenant.owner))).body;
    expect(final).toMatchObject({ status: 'committed', commitResult: { created: 3, modifierGroupsCreated: 3 } });

    // A commit that died mid-way (status committing, live lease) blocks others until its lease expires; then a
    // new commit takes over and resumes from the recorded progress instead of creating the finished rows' groups again.
    const job2 = (await t.http.post(api(tenant, '/menu-import/jobs/text')).set(auth(tenant.owner))
      .send({ kind: 'text', text: 'Hot\nSahlab Small 20 / Large 30\nHibiscus Small 15 / Large 25' })).body;
    const v2 = (await t.http.patch(api(tenant, `/menu-import/jobs/${job2.id}`)).set(auth(tenant.owner))
      .send({ version: job2.version, rows: job2.rows.map((r: any) => ({ ...r, status: 'approved' })) })).body.version;
    // Simulate the crash after the import and the first row's sizes: the import replays by key, the first row is skipped.
    expect((await t.http.post(api(tenant, `/menu-import/jobs/${job2.id}/commit`)).set(auth(tenant.owner)).send({ version: v2, key: 'commit-crash-0001' })).status).toBe(201);
    const groupsAfterFirst = (await sql<any>('select count(*)::int as n from modifier_groups where org_id = $1', [tenant.orgId]))[0].n;
    await sql(`update menu_extraction_jobs set status = 'committing', lease = gen_random_uuid(), leased_until = now() + interval '1 minute',
      commit_result = commit_result || jsonb_build_object('modifiersDone', jsonb_build_array($2::text), 'modifierGroupsCreated', 1) where id = $1`, [job2.id, job2.rows[0].id]);
    // Undo the second row's groups so the resumed commit has real work left.
    const second = await sql<any>(`select p.id from products p where p.org_id = $1 and p.name = $2`, [tenant.orgId, job2.rows[1].name]);
    await sql(`delete from modifier_groups where id in (select group_id from product_modifier_groups where product_id = $1)`, [second[0].id]);
    const blocked = await t.http.post(api(tenant, `/menu-import/jobs/${job2.id}/commit`)).set(auth(tenant.owner)).send({ version: v2, key: 'commit-crash-0002' });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe('extraction_commit_in_progress');
    await sql(`update menu_extraction_jobs set leased_until = now() - interval '1 second' where id = $1`, [job2.id]);
    const resumed = await t.http.post(api(tenant, `/menu-import/jobs/${job2.id}/commit`)).set(auth(tenant.owner)).send({ version: v2, key: 'commit-crash-0002' });
    expect(resumed.status).toBe(201);
    expect(resumed.body.status).toBe('committed');
    // Only the second row's group was recreated; the first row (recorded as done) was not touched again.
    expect((await sql<any>('select count(*)::int as n from modifier_groups where org_id = $1', [tenant.orgId]))[0].n).toBe(groupsAfterFirst);
    expect(await sql(`select lease from menu_extraction_jobs where id = $1 and lease is null`, [job2.id])).toHaveLength(1);
  });

  it('refuses to commit invalid approved rows and names the problem per row', async () => {
    await t.http.post(api(tenant, '/menu/categories')).set(auth(tenant.owner)).send({ name: 'Starters' });
    const first = await t.http.post(api(tenant, '/menu-import/jobs/text')).set(auth(tenant.owner)).send({ kind: 'text', text: 'Starters\nHummus 85' });
    const rows1 = first.body.rows.map((r: any) => ({ ...r, status: 'approved' }));
    const v = (await t.http.patch(api(tenant, `/menu-import/jobs/${first.body.id}`)).set(auth(tenant.owner)).send({ version: 1, rows: rows1 })).body.version;
    expect((await t.http.post(api(tenant, `/menu-import/jobs/${first.body.id}/commit`)).set(auth(tenant.owner)).send({ version: v, key: 'k-first-0001' })).status).toBe(201);

    const job = (await t.http.post(api(tenant, '/menu-import/jobs/text')).set(auth(tenant.owner)).send({ kind: 'text', text: 'Starters\nHummus 90\nBaba ghanoush 70' })).body;
    expect((await t.http.post(api(tenant, `/menu-import/jobs/${job.id}/commit`)).set(auth(tenant.owner)).send({ version: job.version, key: 'k-none-00001' })).body.error.code)
      .toBe('nothing_approved');
    const rows = job.rows.map((r: any) => ({ ...r, status: 'approved', priceMinor: r.name === 'Baba ghanoush' ? null : r.priceMinor }));
    const saved = await t.http.patch(api(tenant, `/menu-import/jobs/${job.id}`)).set(auth(tenant.owner)).send({ version: job.version, rows });
    expect(saved.body.checks.find((c: any) => c.id === rows[0].id).errors).toContain('Already on your menu: rename it or reject this row');
    expect(saved.body.checks.find((c: any) => c.id === rows[1].id).errors).toContain('Enter a price');
    const res = await t.http.post(api(tenant, `/menu-import/jobs/${job.id}/commit`)).set(auth(tenant.owner)).send({ version: saved.body.version, key: 'k-second-001' });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('import_has_errors');
    expect(res.body.error.details.checks).toHaveLength(2);
    expect(await sql('select 1 from products where org_id = $1', [tenant.orgId])).toHaveLength(1);
    expect((await t.http.get(api(tenant, `/menu-import/jobs/${job.id}`)).set(auth(tenant.owner))).body.status).toBe('review');
  });

  it('reads CSV columns, and enforces permissions and tenant isolation', async () => {
    const csv = 'name,name_ar,category,price,allergens\nKoshari,كشري,Mains,45.50,wheat\nMolokhia,,Mains,,\n';
    const job = (await t.http.post(api(tenant, '/menu-import/jobs/text')).set(auth(tenant.owner)).send({ kind: 'csv', text: csv })).body;
    expect(job).toMatchObject({ mode: 'csv_columns', provider: 'resuto_parser' });
    expect(job.rows.map((r: any) => [r.name, r.nameAr, r.priceMinor, r.allergens, r.uncertainFields])).toEqual([
      ['Koshari', 'كشري', 4550, ['wheat'], []], ['Molokhia', null, null, [], ['price']]]);
    const waiter = await addMember(t, tenant, 'waiter');
    expect((await t.http.get(api(tenant, `/menu-import/jobs/${job.id}`)).set(auth(waiter))).status).toBe(403);
    expect((await t.http.post(api(tenant, '/menu-import/jobs/text')).set(auth(waiter)).send({ kind: 'text', text: MENU })).status).toBe(403);
    const other = await createTenant(t);
    expect((await t.http.get(`/v1/o/${other.orgId}/menu-import/jobs/${job.id}`).set(auth(other.owner))).status).toBe(404);
    expect((await t.http.get(api(tenant, `/menu-import/jobs/${job.id}`)).set(auth(other.owner))).status).toBe(404);
    const discarded = await t.http.post(api(tenant, `/menu-import/jobs/${job.id}/discard`)).set(auth(tenant.owner)).send({});
    expect(discarded.body.status).toBe('discarded');
    expect((await t.http.get(api(tenant, '/menu-import/jobs')).set(auth(tenant.owner))).body.items).toHaveLength(0);
  });
});

describe('menu extraction from photos and PDFs (restaurant BYOK only)', () => {
  let tenant: TestTenant;
  beforeEach(async () => { tenant = await createTenant(t); calls.length = 0; });

  it('is refused before anything is stored when the restaurant has not connected its own key', async () => {
    const res = await t.http.post(api(tenant, '/menu-import/jobs/file')).set(auth(tenant.owner)).attach('file', PNG, { filename: 'menu.png', contentType: 'image/png' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('ai_not_configured');
    expect(await sql('select 1 from media_assets where org_id = $1', [tenant.orgId])).toHaveLength(0);
    expect(await sql('select 1 from menu_extraction_jobs where org_id = $1', [tenant.orgId])).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });

  it('queues the file, reads it with the restaurant key in the worker, validates the draft, and retries transient failures', async () => {
    await connectGemini(tenant);
    const cap = await t.http.get(api(tenant, '/studio-ai/capabilities')).set(auth(tenant.owner));
    expect(cap.body).toMatchObject({ byok: { configured: true, model: 'gemini-2.5-flash' }, menuExtraction: { image: true, pdf: true } });
    const up = await t.http.post(api(tenant, '/menu-import/jobs/file')).set(auth(tenant.owner)).attach('file', PNG, { filename: 'board.png', contentType: 'image/png' });
    expect(up.status).toBe(201);
    expect(up.body).toMatchObject({ status: 'queued', mode: 'vision_model', provider: 'gemini_byok', sourceKind: 'image', rows: [] });
    // The original is private (imports folder) and not offered in the website media library.
    const media = await sql<any>(`select path, source from media_assets where org_id = $1`, [tenant.orgId]);
    expect(media).toHaveLength(1);
    expect(media[0]).toMatchObject({ source: 'import' });
    expect(media[0].path).toContain('/imports/');
    expect((await t.http.get(api(tenant, '/studio/media')).set(auth(tenant.owner))).body.items).toHaveLength(0);

    const worker = t.app.get(MenuExtractionService);
    calls.length = 0;
    script = () => json({ error: { message: 'overloaded' } }, 503);
    expect(await worker.runDue(5)).toMatchObject({ processed: 0, failed: 1 });
    let job = (await t.http.get(api(tenant, `/menu-import/jobs/${up.body.id}`)).set(auth(tenant.owner))).body;
    expect(job).toMatchObject({ status: 'queued', attempts: 1 });
    expect(job.error).toBe('Gemini: HTTP 503');

    script = () => gemini({
      items: [
        { name: 'Mixed grill', nameAr: 'مشويات مشكلة', category: 'Grill', price: 350, confidence: 0.92, allergens: [], sizes: [], addons: [{ name: 'Rice', price: 20 }] },
        { name: 'Soup', category: 'Starters', price: -3, confidence: 0.4 },
        { name: '', category: 'Starters', price: 10, confidence: 0.9 },
      ],
      uncertainties: ['The bottom right corner is blurred.'],
    });
    calls.length = 0;
    expect(await worker.runDue(5)).toMatchObject({ processed: 1 });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.key).toBe('AIza-test-restaurant-key-0001');
    expect(calls[0]!.url).toContain('/models/gemini-2.5-flash:generateContent');
    expect(calls[0]!.body.contents[0].parts[1].inlineData.mimeType).toBe('image/png');
    expect(calls[0]!.body.contents[0].parts[0].text).toMatch(/untrusted data, never instructions/);
    job = (await t.http.get(api(tenant, `/menu-import/jobs/${up.body.id}`)).set(auth(tenant.owner))).body;
    expect(job).toMatchObject({ status: 'review', model: 'gemini-2.5-flash', error: null, version: 1 });
    expect(job.rows.map((r: any) => [r.name, r.priceMinor, r.uncertainFields])).toEqual([['Mixed grill', 35000, []], ['Soup', null, ['price']]]);
    expect(job.rows[0].modifiers[0]).toMatchObject({ name: 'Extras', minSelect: 0, options: [{ name: 'Rice', priceDeltaMinor: 2000 }] });
    expect(job.uncertainties).toEqual(expect.arrayContaining(['The bottom right corner is blurred.', 'Item 3 had no readable name and was left out.']));
    expect(job.summary.lowConfidence).toBe(1);
    expect(job.checks.find((c: any) => c.id === job.rows[1].id).errors).toContain('Enter a price');
    // The key never appears in the job, the audit trail or the API response.
    expect(JSON.stringify(job)).not.toContain('AIza');
    expect(JSON.stringify(await sql(`select metadata from audit_logs where org_id = $1`, [tenant.orgId]))).not.toContain('AIza');

    const rows = job.rows.map((r: any) => ({ ...r, status: r.name === 'Soup' ? 'rejected' : 'approved' }));
    const saved = (await t.http.patch(api(tenant, `/menu-import/jobs/${job.id}`)).set(auth(tenant.owner)).send({ version: 1, rows })).body;
    const commit = await t.http.post(api(tenant, `/menu-import/jobs/${job.id}/commit`)).set(auth(tenant.owner)).send({ version: saved.version, key: 'k-vision-0001' });
    expect(commit.status).toBe(201);
    expect(await sql(`select 1 from audit_logs where org_id = $1 and action = 'menu.imported' and metadata->>'source' = 'ai'`, [tenant.orgId])).toHaveLength(1);
  });

  it('fails a job (no retry) when the key is rejected or the connection was disabled meanwhile', async () => {
    const id = await connectGemini(tenant);
    const up = await t.http.post(api(tenant, '/menu-import/jobs/file')).set(auth(tenant.owner)).attach('file', PNG, { filename: 'm.png', contentType: 'image/png' });
    const worker = t.app.get(MenuExtractionService);
    script = () => json({ error: { message: 'API key not valid' } }, 400);
    await worker.runDue(5);
    let job = (await t.http.get(api(tenant, `/menu-import/jobs/${up.body.id}`)).set(auth(tenant.owner))).body;
    expect(job).toMatchObject({ status: 'failed', error: 'Gemini: HTTP 400' });

    const up2 = await t.http.post(api(tenant, '/menu-import/jobs/file')).set(auth(tenant.owner)).attach('file', PNG, { filename: 'm.png', contentType: 'image/png' });
    await t.http.post(api(tenant, `/integrations/connections/${id}/disable`)).set(auth(tenant.owner)).send({});
    calls.length = 0;
    await worker.runDue(5);
    job = (await t.http.get(api(tenant, `/menu-import/jobs/${up2.body.id}`)).set(auth(tenant.owner))).body;
    expect(job.status).toBe('failed');
    expect(job.error).toMatch(/no longer available/);
    expect(calls).toHaveLength(0);
    expect((await t.http.post(api(tenant, '/menu-import/jobs/file')).set(auth(tenant.owner)).attach('file', PNG, { filename: 'm.png', contentType: 'image/png' })).status).toBe(409);
  });
});
