// REM-A04 (INT-05 / INT-06 / FT-26 remainder): the accounting adapters had no health check, so an accounting connection
// created through the setup form stayed "pending" forever (and could not push) and showed no account identity.
// Failure semantics are the payment adapters' (ca387f5): retryable = provider unreachable, anything else is definite.
// Scripted HTTP only: nothing here calls a provider.
import { describe, expect, it } from 'vitest';
import type { AdapterContext } from '../core';
import { withEgressResolver } from '../net';
import { odooAccountingAdapter, qoyodAdapter, wafeqAdapter } from './index';

type Reply = { status?: number; body: unknown };
function routedFetch(route: (url: string, init: RequestInit) => Reply) {
  const calls: Array<{ url: string; method: string; headers: Record<string, string>; body: any }> = [];
  const fn = withEgressResolver((async (url: string, init: RequestInit = {}) => {
    const headers: Record<string, string> = {};
    new Headers(init.headers as HeadersInit).forEach((v, k) => { headers[k] = v; });
    calls.push({ url: String(url), method: init.method ?? 'GET', headers, body: init.body ? JSON.parse(String(init.body)) : null });
    const r = route(String(url), init);
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200 });
  }) as unknown as typeof fetch, async () => [{ address: '93.184.215.14', family: 4 }]);
  return { fn, calls };
}
const base = (fetch: typeof globalThis.fetch, credentials: Record<string, string>, config: Record<string, unknown> = {}): AdapterContext =>
  ({ environment: 'live', credentials, config, fetch });
const accounts = { cash: 'A-CASH', card_clearing: 'A-CARD', sales: 'A-SALES', vat_output: 'A-VAT', receivables: 'A-AR', delivery_income: 'A-DEL' };

describe('Wafeq health check', () => {
  it('reads GET /v1/organization/ with the Api-Key and reports the organisation, base currency and country', async () => {
    const f = routedFetch(() => ({ body: { id: 'org_9f2', name: { en: 'Olive Room LLC', ar: 'غرفة الزيتون' },
      financial_settings: { base_currency: 'sar', country: 'sa', tax_registration_number: '300000000000003' } } }));
    const res = await wafeqAdapter.healthCheck(base(f.fn, { apiKey: 'wk' }, { accounts }));
    expect(f.calls.map((c) => `${c.method} ${c.url}`)).toEqual(['GET https://api.wafeq.com/v1/organization/']);
    expect(f.calls[0]!.headers.authorization).toBe('Api-Key wk');
    expect(res).toEqual({ ok: true, account: { id: 'org_9f2', name: 'Olive Room LLC', country: 'SA', currency: 'SAR' },
      details: { baseCurrency: 'SAR', accountsMapped: 6 } });
    expect(res.environment).toBeUndefined();
  });

  it('401 is a definite failure, 503 and network errors are transient, a missing key fails before any request', async () => {
    const denied = await wafeqAdapter.healthCheck(base(routedFetch(() => ({ status: 401, body: { detail: 'Invalid key' } })).fn, { apiKey: 'bad' })).catch((e) => e);
    expect(denied).toMatchObject({ retryable: false, status: 401 });
    const down = await wafeqAdapter.healthCheck(base(routedFetch(() => ({ status: 503, body: {} })).fn, { apiKey: 'wk' })).catch((e) => e);
    expect(down).toMatchObject({ retryable: true, status: 503 });
    const offline = await wafeqAdapter.healthCheck(base((async () => { throw new TypeError('fetch failed'); }) as unknown as typeof fetch, { apiKey: 'wk' })).catch((e) => e);
    expect(offline).toMatchObject({ retryable: true });
    const none = routedFetch(() => ({ body: {} }));
    await expect(wafeqAdapter.healthCheck(base(none.fn, {}))).rejects.toMatchObject({ retryable: false });
    expect(none.calls).toHaveLength(0);
    // A 200 without an organisation is not proof the key works.
    await expect(wafeqAdapter.healthCheck(base(routedFetch(() => ({ body: { detail: 'ok' } })).fn, { apiKey: 'wk' }))).rejects.toMatchObject({ retryable: false });
  });
});

describe('Qoyod health check', () => {
  it('reads the chart of accounts with the API-KEY header (no identity endpoint is published)', async () => {
    const f = routedFetch(() => ({ body: { accounts: [{ id: 1, name_en: 'Cash' }, { id: 2, name_en: 'Sales' }] } }));
    expect(await qoyodAdapter.healthCheck(base(f.fn, { apiKey: 'qk' }))).toEqual({ ok: true, account: null, details: { chartAccounts: 2, accountsMapped: 0 } });
    expect(f.calls[0]).toMatchObject({ method: 'GET', url: 'https://api.qoyod.com/2.0/accounts', headers: { 'api-key': 'qk' } });
    expect(await qoyodAdapter.healthCheck(base(routedFetch(() => ({ status: 401, body: {} })).fn, { apiKey: 'bad' })).catch((e) => e)).toMatchObject({ retryable: false, status: 401 });
    expect(await qoyodAdapter.healthCheck(base(routedFetch(() => ({ status: 429, body: {} })).fn, { apiKey: 'qk' })).catch((e) => e)).toMatchObject({ retryable: true, status: 429 });
    await expect(qoyodAdapter.healthCheck(base(routedFetch(() => ({ body: { error: 'x' } })).fn, { apiKey: 'qk' }))).rejects.toMatchObject({ retryable: false });
  });
});

describe('Odoo Accounting health check', () => {
  it('reads the company (name, currency, country) and checks the configured journal exists', async () => {
    const f = routedFetch((url) => (url.endsWith('/res.company/search_read')
      ? { body: [{ id: 1, name: 'Acme Foods', currency_id: [148, 'SAR'], country_code: 'SA' }] }
      : { body: [3] }));
    const ctx = base(f.fn, { apiKey: 'odoo-key' }, { url: 'https://acme.odoo.com', database: 'acme', journalId: 3, accounts: { cash: 10 } });
    expect(await odooAccountingAdapter.healthCheck(ctx)).toEqual({ ok: true, account: { id: '1', name: 'Acme Foods', country: 'SA', currency: 'SAR' },
      details: { journalFound: true, accountsMapped: 1 } });
    expect(f.calls.map((c) => c.url)).toEqual(['https://acme.odoo.com/json/2/res.company/search_read', 'https://acme.odoo.com/json/2/account.journal/search']);
    expect(f.calls[0]!.headers).toMatchObject({ authorization: 'bearer odoo-key', 'x-odoo-database': 'acme' });
    expect(f.calls[0]!.body).toEqual({ domain: [], fields: ['name', 'currency_id', 'country_code'], limit: 1 });
    expect(f.calls[1]!.body).toEqual({ domain: [['id', '=', 3]], limit: 1 });
  });

  it('fails a journal id that does not exist; keeps 4xx definite and 5xx transient; never echoes Odoo text', async () => {
    const noJournal = routedFetch((url) => (url.endsWith('/search_read') ? { body: [{ id: 1, name: 'Acme', currency_id: false, country_code: false }] } : { body: [] }));
    expect(await odooAccountingAdapter.healthCheck(base(noJournal.fn, { apiKey: 'k' }, { url: 'https://acme.odoo.com', journalId: 99 })))
      .toMatchObject({ ok: false, account: { id: '1', name: 'Acme', country: null, currency: null }, details: { journalFound: false } });
    const denied = await odooAccountingAdapter.healthCheck(base(routedFetch(() => ({ status: 403, body: { message: 'secret-detail' } })).fn, { apiKey: 'k' },
      { url: 'https://acme.odoo.com' })).catch((e) => e);
    expect(denied).toMatchObject({ retryable: false, status: 403, message: 'odoo_accounting: HTTP 403' });
    const down = await odooAccountingAdapter.healthCheck(base(routedFetch(() => ({ status: 502, body: {} })).fn, { apiKey: 'k' }, { url: 'https://acme.odoo.com' })).catch((e) => e);
    expect(down).toMatchObject({ retryable: true, status: 502 });
    await expect(odooAccountingAdapter.healthCheck(base(routedFetch(() => ({ body: [] })).fn, { apiKey: 'k' }, { url: 'https://acme.odoo.com' })))
      .rejects.toMatchObject({ retryable: false });
  });

  it('Odoo 17 / 18 reads the company over /jsonrpc search_read with fields and limit', async () => {
    const f = routedFetch((url, init) => {
      if (url.includes('/json/2/')) return { status: 404, body: {} };
      const call = JSON.parse(String(init.body)).params;
      if (call.service === 'common') return { body: { jsonrpc: '2.0', id: 1, result: 7 } };
      return { body: { jsonrpc: '2.0', id: 1, result: call.args[4] === 'search_read' ? [{ id: 2, name: 'Legacy Co', currency_id: [74, 'EGP'], country_code: 'EG' }] : [3] } };
    });
    const res = await odooAccountingAdapter.healthCheck(base(f.fn, { apiKey: 'k', login: 'acct@acme.example' }, { url: 'https://acme.odoo.com', database: 'acme', journalId: 3 }));
    expect(res).toMatchObject({ ok: true, account: { id: '2', name: 'Legacy Co', country: 'EG', currency: 'EGP' } });
    expect(f.calls[2]!.body.params.args.slice(3)).toEqual(['res.company', 'search_read', [[]], { limit: 1, fields: ['name', 'currency_id', 'country_code'] }]);
  });
});
