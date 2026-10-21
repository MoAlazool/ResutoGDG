import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SecretBox } from '../src/common/crypto/secret-box';
import { DbService } from '../src/common/db/db.service';
import { ProviderHttp } from '../src/modules/integrations/provider-http';
import { scriptedFetch } from './growth-helpers';
import { addMember, auth, bootTestApp, createTenant, seedMenu, sql, type SeededMenu, type TestApp, type TestTenant } from './helpers';

let t: TestApp;
let tenant: TestTenant;
let menu: SeededMenu;
let http: ProviderHttp;
const realFetch = globalThis.fetch;

beforeAll(async () => {
  t = await bootTestApp();
  tenant = await createTenant(t);
  menu = await seedMenu(tenant);
  http = t.app.get(ProviderHttp);
});
afterAll(async () => { http.fetch = realFetch; await t.close(); });

const api = (path: string) => `/v1/o/${tenant.orgId}/integrations${path}`;
const FOODICS_TOKEN = 'fd-secret-token-ABCDEFGH-1234';

describe('provider catalogue', () => {
  it('lists every adapter category with honest readiness', async () => {
    const res = await t.http.get(api('/catalog')).set(auth(tenant.owner));
    expect(res.status).toBe(200);
    const byId = Object.fromEntries(res.body.items.map((p: any) => [p.id, p]));
    for (const id of ['whatsapp_cloud', 'meta_ads', 'tiktok_ads', 'snapchat_ads', 'foodics', 'odoo']) {
      expect(byId[id]).toMatchObject({ readiness: 'implemented_unverified', sandboxOnly: false });
      expect(byId[id].activation.length).toBeGreaterThan(0);
    }
    for (const id of ['messaging_sandbox', 'ads_sandbox', 'pos_sandbox']) expect(byId[id]).toMatchObject({ readiness: 'simulated', sandboxOnly: true });
    expect(byId.meta_ads.oauthConfigured).toBe(false);
    expect(byId.odoo.fields.config.map((f: any) => f.key)).toEqual(['url', 'database', 'currency']);
    expect(res.body.items.map((p: any) => p.category)).toEqual(expect.arrayContaining(['ads', 'messaging', 'pos']));
  });

  it('requires integrations:manage', async () => {
    const manager = await addMember(t, tenant, 'manager');
    expect((await t.http.get(api('/catalog')).set(auth(manager))).status).toBe(403);
    expect((await t.http.get(api('/connections')).set(auth(manager))).status).toBe(403);
  });
});

describe('connections and credentials', () => {
  let connId: string;

  it('seals credentials, returns only a hint, and member sessions cannot read the ciphertext', async () => {
    const res = await t.http.post(api('/connections')).set(auth(tenant.owner)).send({ provider: 'foodics', environment: 'live', credentials: { accessToken: FOODICS_TOKEN } });
    expect(res.status).toBe(201);
    connId = res.body.id;
    expect(JSON.stringify(res.body)).not.toContain(FOODICS_TOKEN);
    expect(res.body).toMatchObject({ provider: 'foodics', category: 'pos', status: 'pending', enabled: true, credentialsHint: 'accessToken …1234', readiness: 'implemented_unverified',
      sourceOfTruth: { menu: 'resuto', orders: 'resuto' } });
    const list = await t.http.get(api('/connections')).set(auth(tenant.owner));
    expect(JSON.stringify(list.body)).not.toContain(FOODICS_TOKEN);
    expect(JSON.stringify(list.body)).not.toContain('credentials_encrypted');

    const [row] = await sql(`select credentials_encrypted from integration_connections where id = $1`, [connId]);
    expect(row.credentials_encrypted).toMatch(/^v1:dev:/);
    expect(row.credentials_encrypted).not.toContain(FOODICS_TOKEN);
    const box = t.app.get(SecretBox);
    expect(box.openJson(row.credentials_encrypted, `${tenant.orgId}:foodics`)).toEqual({ accessToken: FOODICS_TOKEN });
    expect(() => box.openJson(row.credentials_encrypted, `${tenant.orgId}:odoo`)).toThrow(); // bound to org + provider

    const db = t.app.get(DbService);
    await expect(db.withMember({ userId: tenant.owner.userId, orgId: tenant.orgId }, (tx) => tx.query(`select credentials_encrypted from integration_connections where id = $1`, [connId])))
      .rejects.toMatchObject({ code: '42501' });
    const safe = await db.withMember({ userId: tenant.owner.userId, orgId: tenant.orgId }, (tx) => tx.query(`select credentials_hint from integration_connections where id = $1`, [connId]));
    expect(safe[0].credentials_hint).toBe('accessToken …1234');
  });

  it('validates input', async () => {
    expect((await t.http.post(api('/connections')).set(auth(tenant.owner)).send({ provider: 'Bad Provider!' })).status).toBe(400);
    const unknown = await t.http.post(api('/connections')).set(auth(tenant.owner)).send({ provider: 'nope_provider' });
    expect(unknown.body.error.code).toBe('unknown_provider');
    const missing = await t.http.post(api('/connections')).set(auth(tenant.owner)).send({ provider: 'odoo', credentials: { apiKey: 'k' }, config: {} });
    expect(missing.status).toBe(422);
    expect(missing.body.error.details.missing).toEqual(['url']);
    const dup = await t.http.post(api('/connections')).set(auth(tenant.owner)).send({ provider: 'foodics', credentials: { accessToken: 'x'.repeat(20) } });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('connection_exists');
    const orders = await t.http.patch(api(`/connections/${connId}`)).set(auth(tenant.owner)).send({ sourceOfTruth: { orders: 'provider' } });
    expect(orders.status).toBe(400); // orders are always owned by Resuto
  });

  it('runs a health check through the adapter and records health and logs', async () => {
    http.fetch = scriptedFetch([{ body: { data: { business: { name: 'Koshary Hub', reference: 123 } } } }]).fetch;
    const ok = await t.http.post(api(`/connections/${connId}/health`)).set(auth(tenant.owner));
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ status: 'connected', lastError: null, health: { ok: true, details: { business: 'Koshary Hub' } } });
    http.fetch = scriptedFetch([{ status: 401, body: { message: 'Unauthenticated.' } }]).fetch;
    const bad = await t.http.post(api(`/connections/${connId}/health`)).set(auth(tenant.owner));
    expect(bad.body).toMatchObject({ status: 'error', health: { ok: false } });
    expect(bad.body.lastError).toContain('HTTP 401');
    const logs = await t.http.get(api(`/connections/${connId}/logs`)).set(auth(tenant.owner));
    expect(logs.body.items.map((l: any) => l.message)).toEqual(expect.arrayContaining([expect.stringContaining('Health check failed'), 'Health check passed']));
  });

  it('pulls the POS menu with cursors and records conflicts according to source of truth', async () => {
    await sql(`update products set external_ref = 'fd-1', price_minor = 9000 where id = $1`, [menu.products.fries]);
    await sql(`update products set external_ref = 'fd-2' where id = $1`, [menu.products.soda]); // Soda 2500 — unchanged below
    const pages = [
      { data: [{ id: 'fd-1', name: 'Fries', price: 45, category: { name: 'Sides' } }, { id: 'fd-2', name: 'Soda', price: 25 }], meta: { current_page: 1, last_page: 2 } },
      { data: [{ id: 'fd-3', name: 'Koshary', name_localized: 'كشري', price: 85.5, category: { name: 'Mains' } }], meta: { current_page: 2, last_page: 2 } },
    ];
    let f = scriptedFetch(pages.map((body) => ({ body })));
    http.fetch = f.fetch;
    const run = await t.http.post(api(`/connections/${connId}/sync`)).set(auth(tenant.owner)).send({ resource: 'menu', maxPages: 1 });
    expect(run.status).toBe(200);
    expect(run.body.run).toMatchObject({ status: 'partial', stats: { pages: 1, fetched: 2, conflicts: 1, unchanged: 1, importable: 0, nextCursor: '2' } });
    expect(run.body.importSource).toBe('foodics');
    // Resume from the stored cursor.
    f = scriptedFetch([{ body: pages[1] }]);
    http.fetch = f.fetch;
    const resumed = await t.http.post(api(`/connections/${connId}/sync`)).set(auth(tenant.owner)).send({ resource: 'menu' });
    expect(f.calls[0]!.url).toContain('page=2');
    expect(resumed.body.run.status).toBe('succeeded');
    expect(resumed.body.rows).toEqual([{ externalId: 'fd-3', name: 'Koshary', nameAr: 'كشري', category: 'Mains', priceMinor: 8550, station: 'Kitchen', allergens: [], available: false, action: 'create' }]);

    const conflicts = await t.http.get(api('/conflicts?status=pending')).set(auth(tenant.owner));
    expect(conflicts.body.items).toHaveLength(1);
    expect(conflicts.body.items[0]).toMatchObject({ externalId: 'fd-1', local: { name: 'Fries', priceMinor: 9000 }, external: { priceMinor: 4500 } });
    const resolved = await t.http.post(api(`/conflicts/${conflicts.body.items[0].id}/resolve`)).set(auth(tenant.owner)).send({ resolution: 'kept_external' });
    expect(resolved.body.importRow).toMatchObject({ externalId: 'fd-1', priceMinor: 4500, action: 'update' });
    expect((await t.http.post(api(`/conflicts/${conflicts.body.items[0].id}/resolve`)).set(auth(tenant.owner)).send({ resolution: 'ignored' })).status).toBe(409);
    // This module never writes menu tables: the product is unchanged until B1's import applies the row.
    expect((await sql(`select price_minor from products where id = $1`, [menu.products.fries]))[0].price_minor).toBe(9000);

    // Provider as menu of record: differing rows are offered as updates, no new conflict.
    await t.http.patch(api(`/connections/${connId}`)).set(auth(tenant.owner)).send({ sourceOfTruth: { menu: 'provider' } }).expect(200);
    http.fetch = scriptedFetch([{ body: { ...pages[0], meta: { current_page: 1, last_page: 1 } } }]).fetch;
    const prov = await t.http.post(api(`/connections/${connId}/sync`)).set(auth(tenant.owner)).send({ resource: 'menu', cursor: null });
    expect(prov.body.rows).toEqual([expect.objectContaining({ externalId: 'fd-1', priceMinor: 4500, action: 'update' })]);
    expect((await t.http.get(api('/conflicts?status=pending')).set(auth(tenant.owner))).body.items).toHaveLength(0);

    const runs = await t.http.get(api(`/connections/${connId}/sync-runs`)).set(auth(tenant.owner));
    expect(runs.body.items.length).toBe(3);
    expect(runs.body.items[0].stats.rows).toBeUndefined();
    const detail = await t.http.get(api(`/sync-runs/${runs.body.items[0].id}`)).set(auth(tenant.owner));
    expect(detail.body.rows).toHaveLength(1);
  });

  it('backs off after a provider 429 and counts retry attempts', async () => {
    http.fetch = scriptedFetch([{ status: 429, body: { message: 'Too Many Attempts.' }, headers: { 'retry-after': '120' } }]).fetch;
    const res = await t.http.post(api(`/connections/${connId}/sync`)).set(auth(tenant.owner)).send({ resource: 'menu', cursor: null });
    expect(res.body.run).toMatchObject({ status: 'failed', attempt: 1 });
    expect(res.body.retryable).toBe(true);
    const again = await t.http.post(api(`/connections/${connId}/sync`)).set(auth(tenant.owner)).send({ resource: 'menu' });
    expect(again.status).toBe(429);
    expect(again.body.error.code).toBe('provider_rate_limited');
    await sql(`update integration_connections set rate_limit = '{}'::jsonb where id = $1`, [connId]);
    http.fetch = scriptedFetch([{ status: 500, body: 'oops' }]).fetch;
    const second = await t.http.post(api(`/connections/${connId}/sync`)).set(auth(tenant.owner)).send({ resource: 'menu' });
    expect(second.body.run).toMatchObject({ status: 'failed', attempt: 2 });
  }, 20_000);

  it('enables, disables, revokes (destroying credentials) and deletes', async () => {
    const off = await t.http.post(api(`/connections/${connId}/disable`)).set(auth(tenant.owner));
    expect(off.body.enabled).toBe(false);
    const blocked = await t.http.post(api(`/connections/${connId}/sync`)).set(auth(tenant.owner)).send({ resource: 'menu' });
    expect(blocked.body.error.code).toBe('connection_disabled');
    expect((await t.http.post(api(`/connections/${connId}/enable`)).set(auth(tenant.owner))).body.enabled).toBe(true);
    expect((await t.http.delete(api(`/connections/${connId}`)).set(auth(tenant.owner))).body.error.code).toBe('revoke_first');
    const revoked = await t.http.post(api(`/connections/${connId}/revoke`)).set(auth(tenant.owner));
    expect(revoked.body).toMatchObject({ status: 'revoked', enabled: false, credentialsHint: null });
    expect((await sql(`select credentials_encrypted from integration_connections where id = $1`, [connId]))[0].credentials_encrypted).toBeNull();
    const [audit] = await sql(`select action from audit_logs where entity_id = $1 and action = 'integration.revoked'`, [connId]);
    expect(audit).toBeTruthy();
    expect((await t.http.delete(api(`/connections/${connId}`)).set(auth(tenant.owner))).body.deleted).toBe(true);
  });

  it('sandbox POS returns labelled sample rows without credentials', async () => {
    const c = await t.http.post(api('/connections')).set(auth(tenant.owner)).send({ provider: 'pos_sandbox', environment: 'live' });
    expect(c.body).toMatchObject({ status: 'sandbox', environment: 'sandbox', readiness: 'simulated' });
    const run = await t.http.post(api(`/connections/${c.body.id}/sync`)).set(auth(tenant.owner)).send({ resource: 'menu' });
    expect(run.body.run.stats.sandbox).toBe(true);
    expect(run.body.rows.every((r: any) => r.name.startsWith('[Sandbox]'))).toBe(true);
  });

  it('hides other tenants\' connections (404) and refuses OAuth without platform app credentials', async () => {
    const other = await createTenant(t);
    const mine = await t.http.post(api('/connections')).set(auth(tenant.owner)).send({ provider: 'odoo', credentials: { apiKey: 'odoo-key-123456789' }, config: { url: 'https://erp.example.com', currency: 'EGP' } });
    expect((await t.http.get(`/v1/o/${other.orgId}/integrations/connections/${mine.body.id}`).set(auth(other.owner))).status).toBe(404);
    expect((await t.http.get(api(`/connections/${mine.body.id}`)).set(auth(other.owner))).status).toBe(404);
    const oauth = await t.http.post(api('/oauth/meta_ads/start')).set(auth(tenant.owner)).send({ browserBinding: 'a'.repeat(64) });
    expect(oauth.status).toBe(503);
    expect(oauth.body.error).toMatchObject({ code: 'provider_app_not_configured' });
    expect(oauth.body.error.details.activation.length).toBeGreaterThan(0);
    const cb = await t.http.get('/v1/public/integrations/oauth/meta_ads/callback?code=x&state=forged-state-value');
    expect(cb.status).toBe(302);
    expect(cb.headers.location).toContain('integration_error=');
  });
});
