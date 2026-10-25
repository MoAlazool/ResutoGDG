// Odoo 19 External JSON-2 API menu import (port of legacy integrations.js OdooAdapter).
// Docs: https://www.odoo.com/documentation/19.0/developer/reference/external_api.html
//   POST {base}/json/2/<model>/<method>, "Authorization: bearer <api key>", optional "X-Odoo-Database".
// Readiness: implemented_unverified (no Odoo instance or API key available).
import { providerRequest, ProviderError, type AdapterContext, type HttpOptions, type ProviderDescriptor } from '../core';
import { guardedProviderCall } from '../net';
import { cleanText, IMPORT_DEFAULT_STATION, majorToMinor, type MenuImportRow, type PosAdapter } from './types';

export const ODOO_PAGE_SIZE = 200;

export const odooDescriptor: ProviderDescriptor = {
  id: 'odoo',
  name: 'Odoo (POS / Sales)',
  category: 'pos',
  countries: ['EG', 'SA'],
  authType: 'api_key',
  connectMethod: 'api_key',
  readiness: 'implemented_unverified',
  docsUrl: 'https://www.odoo.com/documentation/19.0/developer/reference/external_api.html',
  capabilities: ['menu_import'],
  activation: [
    'Use Odoo 19 or later (External JSON-2 API) reachable over HTTPS.',
    'Create an API key for a user with read access to Products (Preferences > Account Security > New API Key).',
    'Enter the Odoo URL, database name (multi-database servers) and the company currency; prices are only imported when that currency matches the restaurant currency.',
    'Menu import only: rows are reviewed in Resuto and imported unavailable; Resuto does not push orders to Odoo.',
  ],
};

function endpoint(ctx: AdapterContext, path: string) {
  const raw = ctx.config.url;
  if (typeof raw !== 'string' || !raw) throw new ProviderError('odoo', 'missing Odoo URL', false);
  let base: URL;
  try { base = new URL(raw); } catch { throw new ProviderError('odoo', 'invalid Odoo URL', false); }
  if (base.protocol !== 'https:') throw new ProviderError('odoo', 'use an HTTPS Odoo URL', false);
  return new URL(path, base).toString();
}

/**
 * The Odoo URL is tenant-supplied: every call goes through the egress guard (public HTTPS hosts only, redirects
 * re-checked, capped body) and errors never carry the server's response body (audit INT-02).
 */
async function odooRequest<T>(ctx: AdapterContext, path: string, opts: HttpOptions): Promise<T> {
  const url = endpoint(ctx, path);
  return guardedProviderCall('odoo', ctx.fetch, url, (fetch) => providerRequest<T>('odoo', { fetch }, url, opts));
}

function headers(ctx: AdapterContext): Record<string, string> {
  const key = ctx.credentials.apiKey;
  if (!key) throw new ProviderError('odoo', 'missing API key', false);
  const h: Record<string, string> = { Authorization: `bearer ${key}`, 'Content-Type': 'application/json' };
  if (typeof ctx.config.database === 'string' && ctx.config.database) h['X-Odoo-Database'] = ctx.config.database;
  return h;
}

/** "All / Saleable / Burgers" → "Burgers". */
const categoryName = (categ: unknown) => {
  if (Array.isArray(categ) && typeof categ[1] === 'string') return cleanText(categ[1].split('/').pop(), 80);
  return undefined;
};

export function mapOdooProduct(p: any, priceTrusted: boolean): MenuImportRow | null {
  if (!p || typeof p !== 'object' || p.active === false) return null;
  const name = cleanText(p.name, 120);
  if (!name) return null;
  const price = priceTrusted ? majorToMinor(p.list_price) : 0;
  return {
    externalId: String(p.id),
    name,
    category: categoryName(p.categ_id) ?? 'Mains',
    description: cleanText(p.description_sale, 1000),
    priceMinor: price ?? 0,
    station: IMPORT_DEFAULT_STATION,
    allergens: [],
    available: false,
  };
}

export const odooAdapter: PosAdapter = {
  descriptor: odooDescriptor,

  async fetchMenuPage(ctx, input) {
    const offset = Math.max(0, Number(input.cursor ?? '0') || 0);
    const res = await odooRequest<unknown>(ctx, '/json/2/product.template/search_read', {
      method: 'POST', headers: headers(ctx), timeoutMs: 12_000,
      body: JSON.stringify({
        domain: [['sale_ok', '=', true]],
        fields: ['id', 'name', 'list_price', 'categ_id', 'description_sale', 'active'],
        limit: ODOO_PAGE_SIZE, offset, order: 'id asc',
      }),
    });
    if (!Array.isArray(res)) throw new ProviderError('odoo', 'invalid provider response (expected an array)', false);
    const companyCurrency = typeof ctx.config.currency === 'string' ? ctx.config.currency.toUpperCase() : null;
    const priceTrusted = companyCurrency === input.currency.toUpperCase();
    const warnings = priceTrusted ? [] : [`Prices were not imported: set the Odoo company currency to ${input.currency} in the connection settings to trust list prices.`];
    const rows = res.map((p) => mapOdooProduct(p, priceTrusted)).filter((r): r is MenuImportRow => !!r);
    return { rows, nextCursor: res.length === ODOO_PAGE_SIZE ? String(offset + ODOO_PAGE_SIZE) : null, warnings };
  },

  async healthCheck(ctx) {
    const res = await odooRequest<Record<string, unknown>>(ctx, '/json/2/res.users/context_get', {
      method: 'POST', headers: headers(ctx), body: JSON.stringify({}), retries: 1,
    });
    // Only well-formed locale/time-zone values are kept (nothing else from the response is echoed back).
    const pick = (v: unknown, re: RegExp) => (typeof v === 'string' && re.test(v) ? v : null);
    return { ok: !!res && typeof res === 'object', details: { lang: pick((res as any)?.lang, /^[a-z]{2,3}(_[A-Za-z]{2,4})?(@\w+)?$/), tz: pick((res as any)?.tz, /^[A-Za-z0-9_+\-/]{1,64}$/) } };
  },
};
