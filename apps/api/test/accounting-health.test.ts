// REM-A04 (INT-05 / INT-06 / FT-26 remainder). Before: the accounting adapters had no healthCheck, so a Wafeq / Qoyod /
// Odoo connection created through the setup form stayed "pending" with "This provider has no health check yet", the
// scheduled integrations.health job skipped it, and the push refused it ("Finish connecting this accounting system
// first"). Now the real connection path (POST /integrations/connections → /health → scheduled job) verifies it against
// scripted provider HTTP (no network, no credentials), with the payment adapters' transient-vs-definite semantics.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { IntegrationConnectionsService } from '../src/modules/integrations/connections.service';
import { ProviderHttp } from '../src/modules/integrations/provider-http';
import { auth, bootTestApp, createTenant, sql, type TestApp, type TestTenant } from './helpers';
import { scriptProviders, type Scripted } from './payments-fixtures';

let t: TestApp;
let s: Scripted;
let tenant: TestTenant;

beforeAll(async () => {
  t = await bootTestApp();
  s = scriptProviders(t);
  tenant = await createTenant(t, { country: 'SA' });
});
afterAll(async () => { await t.close(); });

const create = async (provider: string, credentials: Record<string, string>, config: Record<string, unknown> = {}) => {
  const res = await t.http.post(`/v1/o/${tenant.orgId}/integrations/connections`).set(auth(tenant.owner)).send({ provider, environment: 'live', credentials, config });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.id as string;
};
const check = (id: string) => t.http.post(`/v1/o/${tenant.orgId}/integrations/connections/${id}/health`).set(auth(tenant.owner));
const clearRateLimit = (id: string) => sql(`update integration_connections set rate_limit = '{}'::jsonb where id = $1`, [id]);

describe('accounting connections are verified like payment connections', () => {
  it('the setup form describes provider-specific fields (not a single API key fallback)', async () => {
    const res = await t.http.get(`/v1/o/${tenant.orgId}/integrations/catalog`).set(auth(tenant.owner));
    expect(res.status).toBe(200);
    const wafeq = res.body.items.find((p: any) => p.id === 'wafeq');
    expect(wafeq.fields.credentials.map((f: any) => f.key)).toEqual(['apiKey']);
    expect(wafeq.fields.credentials[0]).toMatchObject({ secret: true, labelKey: 'intg.field.wafeqApiKey' });
    expect(wafeq.fields.config.map((f: any) => f.key)).toEqual(expect.arrayContaining(['salesPosting', 'autoPush', 'customerContactId', 'taxRateId', 'invoiceStatus']));
    const odoo = res.body.items.find((p: any) => p.id === 'odoo_accounting');
    expect(odoo.fields.config.find((f: any) => f.key === 'journalId')).toMatchObject({ required: true, labelKey: 'intg.field.odooJournalId' });
    expect(res.body.items.find((p: any) => p.id === 'qoyod').fields.credentials[0]).toMatchObject({ key: 'apiKey', labelKey: 'intg.field.qoyodApiKey', secret: true });
  });

  it('Wafeq: an outage keeps "pending", a working key becomes "connected" with the organisation, a revoked key is an error', async () => {
    s.reset();
    let mode: 'down' | 'ok' | 'revoked' = 'down';
    s.on('GET', 'https://api.wafeq.com/v1/organization/', () => mode === 'down' ? { status: 503, body: {} }
      : mode === 'revoked' ? { status: 401, body: { detail: 'Invalid API key' } }
      : { body: { id: 'org_olive', name: { en: 'Olive Room Trading' }, financial_settings: { base_currency: 'SAR', country: 'SA' } } });
    const id = await create('wafeq', { apiKey: 'wk_live_key' }, { salesPosting: 'journal' });

    const down = await check(id);
    expect(down.status, JSON.stringify(down.body)).toBe(200);
    expect(down.body.status).toBe('pending');
    expect(down.body.health).toMatchObject({ ok: false, transient: true });
    expect(down.body.health.note).toBeUndefined();   // before: "This provider has no health check yet"

    mode = 'ok';
    await clearRateLimit(id);
    const ok = await check(id);
    expect(ok.body).toMatchObject({ status: 'connected', health: { ok: true }, account: { id: 'org_olive', name: 'Olive Room Trading', country: 'SA', currency: 'SAR' } });
    expect(JSON.stringify(ok.body)).not.toContain('wk_live_key');

    // The push no longer refuses the connection as "not connected" (it may have nothing to push).
    const push = await t.http.post(`/v1/o/${tenant.orgId}/finance/accounting/push`).set(auth(tenant.owner))
      .send({ connectionId: id, from: '2026-10-01', to: '2026-10-01', key: 'push-health-0001' });
    expect(push.body?.error?.code).not.toBe('not_connected');

    // The scheduled job re-checks accounting connections too: a revoked key is detected without anyone pressing Check.
    mode = 'revoked';
    await sql(`update integration_connections set last_health_check_at = now() - interval '7 hours' where id = $1`, [id]);
    const job = await t.app.get(IntegrationConnectionsService).scheduledHealth(new Date(), { orgId: tenant.orgId });
    expect(job).toMatchObject({ checked: 1, failed: 1 });
    const [row] = await sql(`select status, last_error, health from integration_connections where id = $1`, [id]);
    expect(row.status).toBe('error');
    expect(row.health).toMatchObject({ ok: false, error: { status: 401, retryable: false } });
  });

  it('Qoyod and Odoo Accounting are checked through the same path', async () => {
    s.reset();
    s.on('GET', 'https://api.qoyod.com/2.0/accounts', () => ({ body: { accounts: [{ id: 1 }, { id: 2 }, { id: 3 }] } }));
    const q = await check(await create('qoyod', { apiKey: 'qk_key' }));
    expect(q.body).toMatchObject({ status: 'connected', health: { ok: true, details: { chartAccounts: 3 } }, account: null });

    // Odoo (tenant-chosen URL) goes through the egress guard, which needs DNS; resolve the test host to a public address.
    const http = t.app.get(ProviderHttp);
    Object.assign(http.fetch, { [Symbol.for('resuto.egress.resolver')]: async () => [{ address: '93.184.215.14', family: 4 }] });
    s.on('POST', 'https://books.olive.example/json/2/res.company/search_read', () => ({ body: [{ id: 1, name: 'Olive Room KSA', currency_id: [148, 'SAR'], country_code: 'SA' }] }));
    s.on('POST', 'https://books.olive.example/json/2/account.journal/search', () => ({ body: [] }));
    const o = await check(await create('odoo_accounting', { apiKey: 'odoo_key' }, { url: 'https://books.olive.example', database: 'olive', journalId: '7' }));
    // The company is read, but journal 7 does not exist: not ready, with the reason in the details.
    expect(o.body).toMatchObject({ status: 'error', health: { ok: false, details: { journalFound: false } }, account: { name: 'Olive Room KSA', currency: 'SAR' } });
  });
});
