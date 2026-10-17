import { describe, expect, it } from 'vitest';
import { scriptedFetch } from '../messaging/testing/scripted-fetch';
import { foodicsAdapter, mapFoodicsProduct } from './foodics';
import { odooAdapter, ODOO_PAGE_SIZE } from './odoo';
import { posSandboxAdapter } from './sandbox';

const ctx = (fetch: typeof globalThis.fetch, credentials: Record<string, string>, config: Record<string, unknown> = {}, environment: 'live' | 'sandbox' = 'live') =>
  ({ environment, credentials, config, fetch });

describe('Foodics v5 menu import', () => {
  const page1 = {
    data: [
      { id: '8d82ea19-0001', sku: 'sk-1', name: 'Koshary', name_localized: 'كشري', description: '<p>Classic</p>', price: 85.5, is_active: true, category: { id: 'c1', name: 'Mains', name_localized: 'رئيسي' } },
      { id: '8d82ea19-0002', name: 'Tea', price: 20, category: null },
      { id: '8d82ea19-0003', name: '', price: 10 },
      { id: '8d82ea19-0004', name: 'Old dish', price: 10, deleted_at: '2026-01-01 00:00:00' },
    ],
    links: { first: '…?page=1', last: '…?page=2', prev: null, next: '…?page=2' },
    meta: { current_page: 1, last_page: 2, per_page: 50, total: 5 },
  };

  it('maps products to §8 menu-import rows (unavailable until reviewed)', async () => {
    const f = scriptedFetch([{ body: page1 }]);
    const res = await foodicsAdapter.fetchMenuPage(ctx(f.fetch, { accessToken: 'fd-token' }), { cursor: null, currency: 'EGP' });
    expect(f.calls[0]!.url).toBe('https://api.foodics.com/v5/products?include=category&page=1');
    expect(f.calls[0]!.headers.authorization).toBe('Bearer fd-token');
    expect(res.rows).toEqual([
      { externalId: '8d82ea19-0001', name: 'Koshary', nameAr: 'كشري', category: 'Mains', description: 'Classic', priceMinor: 8550, station: 'Kitchen', allergens: [], available: false },
      { externalId: '8d82ea19-0002', name: 'Tea', nameAr: undefined, category: 'Mains', description: undefined, priceMinor: 2000, station: 'Kitchen', allergens: [], available: false },
    ]);
    expect(res.nextCursor).toBe('2');
    expect(res.warnings).toHaveLength(1);
    expect(mapFoodicsProduct({ id: 'x', name: 'Bad price', price: 'abc' })).toBeNull();
  });

  it('uses the sandbox host for sandbox connections and stops at the last page', async () => {
    const f = scriptedFetch([{ body: { data: [], links: { next: null }, meta: { current_page: 2, last_page: 2 } } }]);
    const res = await foodicsAdapter.fetchMenuPage(ctx(f.fetch, { accessToken: 't' }, {}, 'sandbox'), { cursor: '2', currency: 'SAR' });
    expect(f.calls[0]!.url).toBe('https://api-sandbox.foodics.com/v5/products?include=category&page=2');
    expect(res.nextCursor).toBeNull();
  });

  it('rejects malformed responses and missing credentials', async () => {
    await expect(foodicsAdapter.fetchMenuPage(ctx(scriptedFetch([{ body: { data: 'nope' } }]).fetch, { accessToken: 't' }), { cursor: null, currency: 'EGP' })).rejects.toThrow(/invalid provider response/);
    await expect(foodicsAdapter.fetchMenuPage(ctx(scriptedFetch([{ body: {} }]).fetch, {}), { cursor: null, currency: 'EGP' })).rejects.toThrow(/missing access token/);
  });

  it('retries 429 with Retry-After and then succeeds', async () => {
    const f = scriptedFetch([{ status: 429, body: { message: 'Too Many Attempts.' }, headers: { 'retry-after': '0' } }, { body: { data: [], meta: { current_page: 1, last_page: 1 } } }]);
    const res = await foodicsAdapter.fetchMenuPage(ctx(f.fetch, { accessToken: 't' }), { cursor: null, currency: 'EGP' });
    expect(f.calls).toHaveLength(2);
    expect(res.rows).toEqual([]);
  });
});

describe('Odoo JSON-2 menu import', () => {
  const rows = [
    { id: 41, name: 'Shawarma plate', list_price: 120.0, categ_id: [7, 'All / Saleable / Grill'], description_sale: 'With garlic sauce', active: true },
    { id: 42, name: 'Water', list_price: 10, categ_id: false, description_sale: false, active: true },
    { id: 43, name: 'Archived', list_price: 5, active: false },
  ];

  it('calls product.template/search_read with bearer key and database header', async () => {
    const f = scriptedFetch([{ body: rows }]);
    const res = await odooAdapter.fetchMenuPage(ctx(f.fetch, { apiKey: 'odoo-key' }, { url: 'https://erp.example.com', database: 'prod', currency: 'EGP' }), { cursor: null, currency: 'EGP' });
    expect(f.calls[0]).toMatchObject({ url: 'https://erp.example.com/json/2/product.template/search_read', method: 'POST' });
    expect(f.calls[0]!.headers.authorization).toBe('bearer odoo-key');
    expect(f.calls[0]!.headers['x-odoo-database']).toBe('prod');
    expect(JSON.parse(f.calls[0]!.body!)).toEqual({ domain: [['sale_ok', '=', true]], fields: ['id', 'name', 'list_price', 'categ_id', 'description_sale', 'active'], limit: ODOO_PAGE_SIZE, offset: 0, order: 'id asc' });
    expect(res.rows).toEqual([
      { externalId: '41', name: 'Shawarma plate', category: 'Grill', description: 'With garlic sauce', priceMinor: 12000, station: 'Kitchen', allergens: [], available: false },
      { externalId: '42', name: 'Water', category: 'Mains', description: undefined, priceMinor: 1000, station: 'Kitchen', allergens: [], available: false },
    ]);
    expect(res.nextCursor).toBeNull();
    expect(res.warnings).toEqual([]);
  });

  it('does not trust prices unless the company currency matches (legacy rule)', async () => {
    const f = scriptedFetch([{ body: rows }]);
    const res = await odooAdapter.fetchMenuPage(ctx(f.fetch, { apiKey: 'k' }, { url: 'https://erp.example.com', currency: 'USD' }), { cursor: null, currency: 'EGP' });
    expect(res.rows.every((r) => r.priceMinor === 0)).toBe(true);
    expect(res.warnings[0]).toMatch(/Prices were not imported/);
  });

  it('pages by offset and refuses non-HTTPS URLs', async () => {
    const full = Array.from({ length: ODOO_PAGE_SIZE }, (_, i) => ({ id: i + 1, name: `P${i}`, list_price: 1, active: true }));
    const res = await odooAdapter.fetchMenuPage(ctx(scriptedFetch([{ body: full }]).fetch, { apiKey: 'k' }, { url: 'https://erp.example.com', currency: 'EGP' }), { cursor: '200', currency: 'EGP' });
    expect(res.nextCursor).toBe(String(200 + ODOO_PAGE_SIZE));
    await expect(odooAdapter.fetchMenuPage(ctx(scriptedFetch([{ body: [] }]).fetch, { apiKey: 'k' }, { url: 'http://erp.example.com' }), { cursor: null, currency: 'EGP' })).rejects.toThrow(/HTTPS/);
  });
});

describe('POS sandbox', () => {
  it('returns labelled sample rows only', async () => {
    const res = await posSandboxAdapter.fetchMenuPage(ctx(undefined as any, {}), { cursor: null, currency: 'EGP' });
    expect(res.rows.length).toBeGreaterThan(0);
    expect(res.rows.every((r) => r.name.startsWith('[Sandbox]'))).toBe(true);
  });
});
