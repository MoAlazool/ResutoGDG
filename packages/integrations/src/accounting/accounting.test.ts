import { describe, expect, it } from 'vitest';
import type { AdapterContext } from '../core';
import { withEgressResolver } from '../net';
import { assertBalanced, accountingMinorToDecimal, odooAccountingAdapter, qoyodAdapter, wafeqAdapter, type JournalEntry } from './index';

function fakeFetch(responses: unknown[]) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  // Tests run without DNS: the Odoo (tenant URL) adapter resolves hosts through this public address.
  const fn = withEgressResolver((async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify(responses.shift() ?? {}), { status: 200 });
  }) as unknown as typeof fetch, async () => [{ address: '93.184.215.14', family: 4 }]);
  return { fn, calls };
}
const accounts = { cash: 'A-CASH', card_clearing: 'A-CARD', sales: 'A-SALES', vat_output: 'A-VAT', discounts: 'A-DISC' };
const entry: JournalEntry = {
  reference: 'RSJ-2026-10-01', date: '2026-10-01', currency: 'SAR', memo: 'Daily sales',
  lines: [
    { role: 'cash', description: 'Cash collected', debitMinor: 11500, creditMinor: 0 },
    { role: 'card_clearing', description: 'Card collected', debitMinor: 5750, creditMinor: 0 },
    { role: 'sales', description: 'Sales ex VAT', debitMinor: 0, creditMinor: 15000 },
    { role: 'vat_output', description: 'VAT 15%', debitMinor: 0, creditMinor: 2250 },
  ],
};

describe('accounting adapters', () => {
  it('formats minor units without floating point and rejects unbalanced journals', () => {
    expect(accountingMinorToDecimal(1)).toBe('0.01');
    expect(accountingMinorToDecimal(123456)).toBe('1234.56');
    expect(accountingMinorToDecimal(-5)).toBe('-0.05');
    expect(() => assertBalanced({ ...entry, lines: entry.lines.slice(1) })).toThrow(/not balanced/);
    expect(() => assertBalanced({ ...entry, lines: [...entry.lines, { role: 'cash', description: 'x', debitMinor: 1, creditMinor: 1 }] })).toThrow();
  });

  it('pushes a Wafeq manual journal with mapped accounts', async () => {
    const f = fakeFetch([{ id: 'mj_1' }]);
    const ctx: AdapterContext = { environment: 'live', credentials: { apiKey: 'wk' }, config: { accounts }, fetch: f.fn };
    expect(await wafeqAdapter.pushJournalEntry(ctx, entry)).toEqual({ externalId: 'mj_1' });
    expect(f.calls[0]!.url).toBe('https://api.wafeq.com/v1/manual-journals/');
    expect((f.calls[0]!.init.headers as any).Authorization).toBe('Api-Key wk');
    const body = JSON.parse(String(f.calls[0]!.init.body));
    expect(body.line_items[0]).toEqual({ account: 'A-CASH', description: 'Cash collected', debit: '115.00', credit: '0.00' });
    expect(body.reference).toBe('RSJ-2026-10-01');
  });

  it('pushes a Qoyod journal entry split into debit and credit amounts', async () => {
    const f = fakeFetch([{ journal_entry: { id: 77 } }]);
    const ctx: AdapterContext = { environment: 'live', credentials: { apiKey: 'qk' }, config: { accounts }, fetch: f.fn };
    expect(await qoyodAdapter.pushJournalEntry(ctx, entry)).toEqual({ externalId: '77' });
    const body = JSON.parse(String(f.calls[0]!.init.body));
    expect((f.calls[0]!.init.headers as any)['API-KEY']).toBe('qk');
    expect(body.journal_entry.debit_amounts).toHaveLength(2);
    expect(body.journal_entry.credit_amounts).toEqual([{ account_id: 'A-SALES', amount: '150.00' }, { account_id: 'A-VAT', amount: '22.50' }]);
  });

  it('creates an Odoo account.move over JSON-RPC (authenticating first)', async () => {
    const f = fakeFetch([{ result: 7 }, { result: 901 }]);
    const ctx: AdapterContext = { environment: 'live', credentials: { url: 'https://acme.odoo.com', db: 'acme', login: 'acc@acme', apiKey: 'ok' },
      config: { journalId: 3, accounts: { cash: 10, card_clearing: 11, sales: 20, vat_output: 30 } }, fetch: f.fn };
    expect(await odooAccountingAdapter.pushJournalEntry(ctx, entry)).toEqual({ externalId: '901' });
    expect(JSON.parse(String(f.calls[0]!.init.body)).params).toEqual({ service: 'common', method: 'authenticate', args: ['acme', 'acc@acme', 'ok', {}] });
    const create = JSON.parse(String(f.calls[1]!.init.body)).params;
    expect(create.args.slice(0, 5)).toEqual(['acme', 7, 'ok', 'account.move', 'create']);
    expect(create.args[5][0].line_ids[3]).toEqual([0, 0, { account_id: 30, name: 'VAT 15%', debit: 0, credit: 22.5 }]);
  });

  it('refuses to push when an account role is not mapped', async () => {
    const f = fakeFetch([]);
    await expect(wafeqAdapter.pushJournalEntry({ environment: 'live', credentials: { apiKey: 'k' }, config: { accounts: { cash: 'x' } }, fetch: f.fn }, entry)).rejects.toThrow(/card_clearing/);
    expect(f.calls).toHaveLength(0);
  });
});
