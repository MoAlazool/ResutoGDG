// INT-25: accounting adapters checked against the providers' current documentation (sources in ./index.ts).
// The earlier version of this file asserted Wafeq journal lines with `debit` / `credit` strings and Odoo over the
// deprecated /jsonrpc; Wafeq's manual-journal schema has one signed `amount` per line (+ `amount_to_bcy`, `currency`)
// and Odoo Accounting now uses JSON-2 like Odoo POS, so those expectations changed with the requests.
import { describe, expect, it } from 'vitest';
import type { AdapterContext } from '../core';
import { withEgressResolver } from '../net';
import { assertBalanced, accountingMinorToDecimal, odooAccountingAdapter, qoyodAdapter, referenceUuid, wafeqAdapter, type JournalEntry, type SalesInvoice } from './index';

type Reply = { status?: number; body: unknown };
function routedFetch(route: (url: string, init: RequestInit) => Reply) {
  const calls: Array<{ url: string; method: string; headers: Record<string, string>; body: any }> = [];
  // Tests run without DNS: the Odoo (tenant URL) adapter resolves hosts through this public address.
  const fn = withEgressResolver((async (url: string, init: RequestInit = {}) => {
    const headers: Record<string, string> = {};
    new Headers(init.headers as HeadersInit).forEach((v, k) => { headers[k] = v; });
    calls.push({ url: String(url), method: init.method ?? 'GET', headers, body: init.body ? JSON.parse(String(init.body)) : null });
    const r = route(String(url), init);
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200 });
  }) as unknown as typeof fetch, async () => [{ address: '93.184.215.14', family: 4 }]);
  return { fn, calls };
}
const accounts = { cash: 'A-CASH', card_clearing: 'A-CARD', sales: 'A-SALES', vat_output: 'A-VAT', receivables: 'A-AR', delivery_income: 'A-DEL' };
const entry: JournalEntry = {
  reference: 'RSJ-olive-2026-10-01', date: '2026-10-01', currency: 'SAR', memo: 'Daily sales',
  lines: [
    { role: 'cash', description: 'Cash collected', debitMinor: 11500, creditMinor: 0 },
    { role: 'card_clearing', description: 'Card collected', debitMinor: 5750, creditMinor: 0 },
    { role: 'sales', description: 'Sales ex VAT', debitMinor: 0, creditMinor: 15000 },
    { role: 'vat_output', description: 'VAT 15%', debitMinor: 0, creditMinor: 2250 },
  ],
};
const invoice: SalesInvoice = {
  reference: 'RSI-olive-2026-10-01', date: '2026-10-01', currency: 'SAR', customerName: 'Walk-in customers', taxInclusive: false,
  summaryPeriod: { start: '2026-10-01', end: '2026-10-01' },
  lines: [{ description: 'Food & beverage sales', quantity: 1, unitPriceMinor: 15000, taxRateBp: 1500, role: 'sales' },
    { description: 'Delivery fees', quantity: 1, unitPriceMinor: 870, taxRateBp: 1500, role: 'delivery_income' }],
};

describe('accounting basics', () => {
  it('formats minor units without floating point and rejects unbalanced journals', () => {
    expect(accountingMinorToDecimal(1)).toBe('0.01');
    expect(accountingMinorToDecimal(123456)).toBe('1234.56');
    expect(accountingMinorToDecimal(-5)).toBe('-0.05');
    expect(() => assertBalanced({ ...entry, lines: entry.lines.slice(1) })).toThrow(/not balanced/);
    expect(() => assertBalanced({ ...entry, lines: [...entry.lines, { role: 'cash', description: 'x', debitMinor: 1, creditMinor: 1 }] })).toThrow();
  });

  it('derives a stable UUID v4-shaped idempotency key from a reference', () => {
    const k = referenceUuid('journal:RSJ-olive-2026-10-01');
    expect(k).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(referenceUuid('journal:RSJ-olive-2026-10-01')).toBe(k);
    expect(referenceUuid('journal:RSJ-olive-2026-10-02')).not.toBe(k);
  });
});

describe('Wafeq', () => {
  const ctx = (fetch: typeof globalThis.fetch, config: Record<string, unknown> = {}): AdapterContext =>
    ({ environment: 'live', credentials: { apiKey: 'wk' }, config: { accounts, ...config }, fetch });

  it('looks the journal up by external_id, then posts signed amounts with the idempotency key', async () => {
    const f = routedFetch((url, init) => (init.method === 'POST' ? { body: { id: 'mj_1' } } : { body: { count: 0, results: [] } }));
    expect(await wafeqAdapter.pushJournalEntry(ctx(f.fn), entry)).toEqual({ externalId: 'mj_1' });
    expect(f.calls[0]).toMatchObject({ method: 'GET', url: 'https://api.wafeq.com/v1/manual-journals/?external_id=RSJ-olive-2026-10-01&page_size=1' });
    const post = f.calls[1]!;
    expect(post.url).toBe('https://api.wafeq.com/v1/manual-journals/');
    expect(post.headers.authorization).toBe('Api-Key wk');
    expect(post.headers['x-wafeq-idempotency-key']).toBe(referenceUuid('journal:RSJ-olive-2026-10-01'));
    expect(post.body).toMatchObject({ date: '2026-10-01', reference: 'RSJ-olive-2026-10-01', external_id: 'RSJ-olive-2026-10-01', notes: 'Daily sales' });
    expect(post.body.line_items).toEqual([
      { account: 'A-CASH', description: 'Cash collected', amount: 115, amount_to_bcy: 115, currency: 'SAR' },
      { account: 'A-CARD', description: 'Card collected', amount: 57.5, amount_to_bcy: 57.5, currency: 'SAR' },
      { account: 'A-SALES', description: 'Sales ex VAT', amount: -150, amount_to_bcy: -150, currency: 'SAR' },
      { account: 'A-VAT', description: 'VAT 15%', amount: -22.5, amount_to_bcy: -22.5, currency: 'SAR' },
    ]);
    expect(post.body.line_items.reduce((s: number, l: any) => s + l.amount, 0)).toBeCloseTo(0, 10);
  });

  it('does not create a second journal when one with the reference exists', async () => {
    const f = routedFetch(() => ({ body: { count: 1, results: [{ id: 'mj_old', external_id: 'RSJ-olive-2026-10-01' }] } }));
    expect(await wafeqAdapter.pushJournalEntry(ctx(f.fn), entry)).toEqual({ externalId: 'mj_old', existing: true });
    expect(f.calls.map((c) => c.method)).toEqual(['GET']);
  });

  it('posts a DRAFT daily summary invoice (is_summary) to the walk-in contact with the VAT tax rate', async () => {
    const f = routedFetch((url, init) => (init.method === 'POST' ? { body: { id: 'inv_1' } } : { body: { results: [] } }));
    expect(await wafeqAdapter.pushInvoice(ctx(f.fn, { customerContactId: 'ct_walkin', taxRateId: 'tr_vat15' }), invoice)).toEqual({ externalId: 'inv_1' });
    const post = f.calls.find((c) => c.method === 'POST')!;
    expect(post.url).toBe('https://api.wafeq.com/v1/invoices/');
    expect(post.body).toEqual({
      contact: 'ct_walkin', currency: 'SAR', invoice_date: '2026-10-01', invoice_due_date: '2026-10-01', invoice_number: 'RSI-olive-2026-10-01',
      reference: 'RSI-olive-2026-10-01', external_id: 'RSI-olive-2026-10-01', tax_amount_type: 'TAX_EXCLUSIVE', status: 'DRAFT',
      is_summary: true, summary_period_start: '2026-10-01', summary_period_end: '2026-10-01',
      line_items: [{ account: 'A-SALES', description: 'Food & beverage sales', quantity: 1, unit_amount: 150, tax_rate: 'tr_vat15' },
        { account: 'A-DEL', description: 'Delivery fees', quantity: 1, unit_amount: 8.7, tax_rate: 'tr_vat15' }],
    });
    await expect(wafeqAdapter.pushInvoice(ctx(f.fn, { taxRateId: 'x' }), invoice)).rejects.toThrow('walk-in customer contact');
  });

  it('refuses to push when an account role is not mapped (before any request)', async () => {
    const f = routedFetch(() => ({ body: {} }));
    await expect(wafeqAdapter.pushJournalEntry({ environment: 'live', credentials: { apiKey: 'k' }, config: { accounts: { cash: 'x' } }, fetch: f.fn }, entry)).rejects.toThrow(/card_clearing/);
    expect(f.calls).toHaveLength(0);
  });
});

describe('Qoyod', () => {
  const ctx = (fetch: typeof globalThis.fetch, config: Record<string, unknown> = {}): AdapterContext =>
    ({ environment: 'live', credentials: { apiKey: 'qk' }, config: { accounts: { ...accounts, cash: '7', sales: '21' }, ...config }, fetch });

  it('searches by the reference prefix (ransack), then posts numeric debit and credit amounts', async () => {
    const f = routedFetch((url, init) => (init.method === 'POST' ? { body: { journal_entry: { id: 77 } } } : { body: { journal_entries: [] } }));
    expect(await qoyodAdapter.pushJournalEntry(ctx(f.fn), entry)).toEqual({ externalId: '77' });
    expect(decodeURIComponent(f.calls[0]!.url)).toBe('https://api.qoyod.com/2.0/journal_entries?q[description_start]=RSJ-olive-2026-10-01');
    expect(f.calls[1]!.headers['api-key']).toBe('qk');
    const je = f.calls[1]!.body.journal_entry;
    expect(je.description).toBe('RSJ-olive-2026-10-01 — Daily sales');
    expect(je.debit_amounts).toEqual([{ account_id: 7, amount: 115, comment: 'Cash collected' }, { account_id: 'A-CARD', amount: 57.5, comment: 'Card collected' }]);
    expect(je.credit_amounts).toEqual([{ account_id: 21, amount: 150, comment: 'Sales ex VAT' }, { account_id: 'A-VAT', amount: 22.5, comment: 'VAT 15%' }]);
  });

  it('skips an existing journal and an existing invoice reference', async () => {
    const f = routedFetch((url) => (url.includes('journal_entries')
      ? { body: { journal_entries: [{ id: 5, description: 'RSJ-olive-2026-10-01 — Daily sales' }] } }
      : { body: { invoices: [{ id: 9, reference: 'RSI-olive-2026-10-01' }] } }));
    expect(await qoyodAdapter.pushJournalEntry(ctx(f.fn), entry)).toEqual({ externalId: '5', existing: true });
    expect(await qoyodAdapter.pushInvoice(ctx(f.fn, { contactId: '2', inventoryId: '1', productId: '3' }), invoice)).toEqual({ externalId: '9', existing: true });
    expect(f.calls.every((c) => c.method === 'GET')).toBe(true);
  });

  it('creates a Draft invoice with the configured contact, inventory and product and a numeric tax_percent', async () => {
    const f = routedFetch((url, init) => (init.method === 'POST' ? { body: { invoice: { id: 31 } } } : { body: { invoices: [] } }));
    await expect(qoyodAdapter.pushInvoice(ctx(f.fn), invoice)).rejects.toThrow('Set contactId');
    expect(await qoyodAdapter.pushInvoice(ctx(f.fn, { contactId: '2', inventoryId: '1', productId: '3' }), invoice)).toEqual({ externalId: '31' });
    const inv = f.calls.find((c) => c.method === 'POST')!.body.invoice;
    expect(inv).toMatchObject({ contact_id: 2, reference: 'RSI-olive-2026-10-01', issue_date: '2026-10-01', due_date: '2026-10-01', status: 'Draft', inventory_id: 1 });
    expect(inv.line_items[0]).toEqual({ product_id: 3, description: 'Food & beverage sales', quantity: 1, unit_price: 150, tax_percent: 15 });
  });
});

describe('Odoo Accounting (JSON-2, shared settings with Odoo POS)', () => {
  const ctx = (fetch: typeof globalThis.fetch, extra: Partial<AdapterContext> = {}): AdapterContext => ({
    environment: 'live', credentials: { apiKey: 'odoo-key' },
    config: { url: 'https://acme.odoo.com', database: 'acme', journalId: 3, partnerId: 12, taxId: 5, accounts: { cash: 10, card_clearing: 11, sales: 20, vat_output: 30, delivery_income: 21 } },
    fetch, ...extra,
  });

  it('searches account.move by ref, then creates the entry with vals_list; bearer key and X-Odoo-Database headers', async () => {
    const f = routedFetch((url) => (url.endsWith('/search') ? { body: [] } : { body: [901] }));
    expect(await odooAccountingAdapter.pushJournalEntry(ctx(f.fn), entry)).toEqual({ externalId: '901' });
    expect(f.calls.map((c) => `${c.method} ${c.url}`)).toEqual(['POST https://acme.odoo.com/json/2/account.move/search', 'POST https://acme.odoo.com/json/2/account.move/create']);
    expect(f.calls[0]!.headers).toMatchObject({ authorization: 'bearer odoo-key', 'x-odoo-database': 'acme' });
    expect(f.calls[0]!.body).toEqual({ domain: [['ref', '=', 'RSJ-olive-2026-10-01'], ['move_type', '=', 'entry']], limit: 1 });
    const vals = f.calls[1]!.body.vals_list[0];
    expect(vals).toMatchObject({ move_type: 'entry', date: '2026-10-01', ref: 'RSJ-olive-2026-10-01', journal_id: 3 });
    expect(vals.line_ids[3]).toEqual([0, 0, { account_id: 30, name: 'VAT 15%', debit: 0, credit: 22.5 }]);
  });

  it('skips an existing move and creates customer invoices with the income account per line', async () => {
    const existing = routedFetch(() => ({ body: [444] }));
    expect(await odooAccountingAdapter.pushJournalEntry(ctx(existing.fn), entry)).toEqual({ externalId: '444', existing: true });
    const f = routedFetch((url) => (url.endsWith('/search') ? { body: [] } : { body: [77] }));
    expect(await odooAccountingAdapter.pushInvoice(ctx(f.fn), invoice)).toEqual({ externalId: '77' });
    const v = f.calls[1]!.body.vals_list[0];
    expect(v).toMatchObject({ move_type: 'out_invoice', partner_id: 12, invoice_date: '2026-10-01', ref: 'RSI-olive-2026-10-01' });
    expect(v.invoice_line_ids[1]).toEqual([0, 0, { name: 'Delivery fees', quantity: 1, price_unit: 8.7, account_id: 21, tax_ids: [[6, 0, [5]]] }]);
  });

  it('reads legacy settings (url/db in credentials), refuses http URLs and never echoes Odoo error text', async () => {
    const legacy = routedFetch((url) => (url.endsWith('/search') ? { body: [] } : { body: 5 }));
    await odooAccountingAdapter.pushJournalEntry(ctx(legacy.fn, { credentials: { apiKey: 'k', url: 'https://old.odoo.com', db: 'old' }, config: { journalId: 1, accounts: { cash: 1, card_clearing: 2, sales: 3, vat_output: 4 } } }), entry);
    expect(legacy.calls[0]).toMatchObject({ url: 'https://old.odoo.com/json/2/account.move/search', headers: { 'x-odoo-database': 'old' } });
    await expect(odooAccountingAdapter.pushJournalEntry(ctx(legacy.fn, { config: { url: 'http://acme.odoo.com', journalId: 1, accounts } }), entry)).rejects.toThrow('https');
    const denied = routedFetch(() => ({ status: 401, body: { name: 'werkzeug.exceptions.Unauthorized', message: 'Invalid apikey secret-detail', debug: 'Traceback …' } }));
    const err = await odooAccountingAdapter.pushJournalEntry(ctx(denied.fn), entry).catch((e) => e);
    expect(err.message).toBe('odoo_accounting: HTTP 401');
    expect(err.message).not.toContain('secret-detail');
  });
});
