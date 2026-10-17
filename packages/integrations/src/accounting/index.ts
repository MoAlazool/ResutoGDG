// accounting provider adapters. Owner: Agent D1. Export adapters and their ProviderDescriptor here.
//
// Resuto pushes deterministic, balanced journal entries (daily sales summaries)
// and sales invoices to the restaurant's own accounting system. Account ids are
// mapped per connection in config.accounts (role → provider account id/code).
import { providerRequest, ProviderError, type AdapterContext, type ProviderDescriptor } from '../core';

export const ACCOUNT_ROLES = ['cash', 'card_clearing', 'wallet_clearing', 'bank', 'receivables', 'sales', 'delivery_income', 'discounts', 'vat_output', 'payment_fees', 'refunds'] as const;
export type AccountRole = (typeof ACCOUNT_ROLES)[number];

export interface JournalLine { role: AccountRole; description: string; debitMinor: number; creditMinor: number }
export interface JournalEntry {
  /** Stable Resuto reference (idempotency at the provider when supported), e.g. "RSJ-<org>-2026-10-01". */
  reference: string;
  date: string; // YYYY-MM-DD
  currency: string;
  memo: string;
  lines: JournalLine[];
}
export interface SalesInvoice {
  reference: string;
  date: string;
  currency: string;
  customerName: string;
  lines: Array<{ description: string; quantity: number; unitPriceMinor: number; taxRateBp: number }>;
  taxInclusive: boolean;
}
export interface PushResult { externalId: string; raw?: Record<string, unknown> }

export interface AccountingAdapter {
  readonly descriptor: ProviderDescriptor;
  readonly requiredCredentials: readonly string[];
  pushJournalEntry(ctx: AdapterContext, entry: JournalEntry): Promise<PushResult>;
  pushInvoice(ctx: AdapterContext, invoice: SalesInvoice): Promise<PushResult>;
}

/** Integer minor units → "123.45" without floating point. */
export function minorToDecimal(minor: number): string {
  if (!Number.isSafeInteger(minor)) throw new RangeError('amount must be an integer');
  const sign = minor < 0 ? '-' : '';
  const abs = Math.abs(minor);
  return `${sign}${Math.trunc(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

/** Rejects unbalanced or malformed entries before anything leaves Resuto. */
export function assertBalanced(entry: JournalEntry) {
  const d = entry.lines.reduce((s, l) => s + l.debitMinor, 0);
  const c = entry.lines.reduce((s, l) => s + l.creditMinor, 0);
  if (!entry.lines.length || d !== c) throw new ProviderError('accounting', `Journal ${entry.reference} is not balanced (${d} ≠ ${c})`, false);
  for (const l of entry.lines) {
    if (!Number.isSafeInteger(l.debitMinor) || !Number.isSafeInteger(l.creditMinor) || l.debitMinor < 0 || l.creditMinor < 0 || (l.debitMinor > 0) === (l.creditMinor > 0)) {
      throw new ProviderError('accounting', `Journal ${entry.reference} has an invalid line`, false);
    }
  }
}

const account = (ctx: AdapterContext, provider: string, role: AccountRole): string => {
  const id = (ctx.config.accounts as Record<string, unknown> | undefined)?.[role];
  if (id === undefined || id === null || id === '') throw new ProviderError(provider, `Map the "${role}" account in the connection settings`, false);
  return String(id);
};

// ---------------------------------------------------------------------------
// Wafeq (KSA/UAE) — https://developer.wafeq.com
// ---------------------------------------------------------------------------
export const wafeqDescriptor: ProviderDescriptor = {
  id: 'wafeq', name: 'Wafeq', category: 'accounting', countries: ['SA', 'EG'], authType: 'api_key', readiness: 'implemented_unverified',
  docsUrl: 'https://developer.wafeq.com',
  activation: [
    'In Wafeq: Settings → API keys → create a key; store it in the connection as "apiKey".',
    'Map Resuto account roles (cash, card_clearing, sales, vat_output, discounts, payment_fees, refunds …) to Wafeq account ids in config.accounts.',
    'For invoices, set config.customerContactId (walk-in customer contact) and config.taxRateId for the VAT rate.',
    'Push one day to a test organisation in Wafeq and compare the trial balance before enabling scheduled pushes.',
  ],
  capabilities: ['journal_entries', 'invoices'],
};
const WAFEQ_API = 'https://api.wafeq.com/v1';
const wafeqAuth = (ctx: AdapterContext) => {
  if (!ctx.credentials.apiKey) throw new ProviderError('wafeq', 'apiKey is not configured', false);
  return { Authorization: `Api-Key ${ctx.credentials.apiKey}`, 'Content-Type': 'application/json' };
};
export const wafeqAdapter: AccountingAdapter = {
  descriptor: wafeqDescriptor,
  requiredCredentials: ['apiKey'],
  async pushJournalEntry(ctx, entry) {
    assertBalanced(entry);
    const r = await providerRequest<any>('wafeq', ctx, `${WAFEQ_API}/manual-journals/`, {
      method: 'POST', headers: wafeqAuth(ctx), retries: 0,
      body: JSON.stringify({
        date: entry.date, reference: entry.reference, notes: entry.memo, currency: entry.currency,
        line_items: entry.lines.map((l) => ({ account: account(ctx, 'wafeq', l.role), description: l.description, debit: minorToDecimal(l.debitMinor), credit: minorToDecimal(l.creditMinor) })),
      }),
    });
    return { externalId: String(r.id) };
  },
  async pushInvoice(ctx, inv) {
    const r = await providerRequest<any>('wafeq', ctx, `${WAFEQ_API}/invoices/`, {
      method: 'POST', headers: wafeqAuth(ctx), retries: 0,
      body: JSON.stringify({
        contact: ctx.config.customerContactId, currency: inv.currency, invoice_date: inv.date, invoice_due_date: inv.date,
        invoice_number: inv.reference, tax_amount_type: inv.taxInclusive ? 'TAX_INCLUSIVE' : 'TAX_EXCLUSIVE',
        line_items: inv.lines.map((l) => ({ account: account(ctx, 'wafeq', 'sales'), description: l.description, quantity: l.quantity, unit_amount: minorToDecimal(l.unitPriceMinor), tax_rate: ctx.config.taxRateId })),
      }),
    });
    return { externalId: String(r.id) };
  },
};

// ---------------------------------------------------------------------------
// Qoyod (KSA) — https://apidoc.qoyod.com
// ---------------------------------------------------------------------------
export const qoyodDescriptor: ProviderDescriptor = {
  id: 'qoyod', name: 'Qoyod', category: 'accounting', countries: ['SA'], authType: 'api_key', readiness: 'implemented_unverified',
  docsUrl: 'https://apidoc.qoyod.com',
  activation: [
    'In Qoyod: General settings → API → generate an API key; store it as "apiKey".',
    'Map Resuto account roles to Qoyod account ids in config.accounts.',
    'For invoices, set config.contactId, config.inventoryId and config.productId (a "restaurant sales" service product).',
    'Push one day and verify the journal in Qoyod before enabling scheduled pushes.',
  ],
  capabilities: ['journal_entries', 'invoices'],
};
const QOYOD_API = 'https://api.qoyod.com/2.0';
const qoyodAuth = (ctx: AdapterContext) => {
  if (!ctx.credentials.apiKey) throw new ProviderError('qoyod', 'apiKey is not configured', false);
  return { 'API-KEY': ctx.credentials.apiKey, 'Content-Type': 'application/json' };
};
export const qoyodAdapter: AccountingAdapter = {
  descriptor: qoyodDescriptor,
  requiredCredentials: ['apiKey'],
  async pushJournalEntry(ctx, entry) {
    assertBalanced(entry);
    const side = (pick: (l: JournalLine) => number) => entry.lines.filter((l) => pick(l) > 0)
      .map((l) => ({ account_id: Number(account(ctx, 'qoyod', l.role)) || account(ctx, 'qoyod', l.role), amount: minorToDecimal(pick(l)) }));
    const r = await providerRequest<any>('qoyod', ctx, `${QOYOD_API}/journal_entries`, {
      method: 'POST', headers: qoyodAuth(ctx), retries: 0,
      body: JSON.stringify({ journal_entry: { date: entry.date, description: `${entry.reference} — ${entry.memo}`, debit_amounts: side((l) => l.debitMinor), credit_amounts: side((l) => l.creditMinor) } }),
    });
    return { externalId: String(r.journal_entry?.id ?? r.id) };
  },
  async pushInvoice(ctx, inv) {
    const r = await providerRequest<any>('qoyod', ctx, `${QOYOD_API}/invoices`, {
      method: 'POST', headers: qoyodAuth(ctx), retries: 0,
      body: JSON.stringify({ invoice: {
        contact_id: ctx.config.contactId, reference: inv.reference, issue_date: inv.date, due_date: inv.date, status: 'Approved',
        inventory_id: ctx.config.inventoryId, tax_inclusive: inv.taxInclusive,
        line_items: inv.lines.map((l) => ({ product_id: ctx.config.productId, description: l.description, quantity: l.quantity, unit_price: minorToDecimal(l.unitPriceMinor), tax_percent: (l.taxRateBp / 100).toFixed(2) })),
      } }),
    });
    return { externalId: String(r.invoice?.id ?? r.id) };
  },
};

// ---------------------------------------------------------------------------
// Odoo (any hosted/on-prem instance) — JSON-RPC external API
// https://www.odoo.com/documentation/17.0/developer/reference/external_api.html
// ---------------------------------------------------------------------------
export const odooDescriptor: ProviderDescriptor = {
  id: 'odoo', name: 'Odoo Accounting', category: 'accounting', countries: ['EG', 'SA'], authType: 'api_key', readiness: 'implemented_unverified',
  docsUrl: 'https://www.odoo.com/documentation/17.0/developer/reference/external_api.html',
  activation: [
    'In Odoo: Preferences → Account security → New API key for an accounting user; store "url" (https://<company>.odoo.com), "db", "login" and "apiKey".',
    'Set config.journalId (a miscellaneous journal for Resuto summaries) and map account roles to Odoo account ids in config.accounts.',
    'For invoices, set config.partnerId (walk-in customer) and optionally config.taxId.',
    'Push one day to a staging database first and compare the general ledger.',
  ],
  capabilities: ['journal_entries', 'invoices'],
};
async function odooCall(ctx: AdapterContext, service: string, method: string, args: unknown[]) {
  const url = String(ctx.credentials.url ?? '').replace(/\/$/, '');
  if (!/^https:\/\//.test(url)) throw new ProviderError('odoo', 'Set the Odoo "url" (https://…)', false);
  const r = await providerRequest<any>('odoo', ctx, `${url}/jsonrpc`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, retries: 0,
    body: JSON.stringify({ jsonrpc: '2.0', method: 'call', params: { service, method, args }, id: Date.now() }),
  });
  if (r.error) throw new ProviderError('odoo', String(r.error.data?.message ?? r.error.message ?? 'rpc error').slice(0, 300), false);
  return r.result;
}
async function odooUid(ctx: AdapterContext): Promise<number> {
  if (ctx.config.uid) return Number(ctx.config.uid);
  const { db, login, apiKey } = ctx.credentials;
  if (!db || !login || !apiKey) throw new ProviderError('odoo', 'db, login and apiKey are required', false);
  const uid = await odooCall(ctx, 'common', 'authenticate', [db, login, apiKey, {}]);
  if (!uid) throw new ProviderError('odoo', 'Authentication failed', false);
  return Number(uid);
}
const odooAmount = (minor: number) => Number(minorToDecimal(minor));
export const odooAdapter: AccountingAdapter = {
  descriptor: odooDescriptor,
  requiredCredentials: ['url', 'db', 'login', 'apiKey'],
  async pushJournalEntry(ctx, entry) {
    assertBalanced(entry);
    const uid = await odooUid(ctx);
    const id = await odooCall(ctx, 'object', 'execute_kw', [ctx.credentials.db, uid, ctx.credentials.apiKey, 'account.move', 'create', [{
      move_type: 'entry', date: entry.date, ref: entry.reference, journal_id: Number(ctx.config.journalId), narration: entry.memo,
      line_ids: entry.lines.map((l) => [0, 0, { account_id: Number(account(ctx, 'odoo', l.role)), name: l.description, debit: odooAmount(l.debitMinor), credit: odooAmount(l.creditMinor) }]),
    }]]);
    return { externalId: String(id) };
  },
  async pushInvoice(ctx, inv) {
    const uid = await odooUid(ctx);
    const id = await odooCall(ctx, 'object', 'execute_kw', [ctx.credentials.db, uid, ctx.credentials.apiKey, 'account.move', 'create', [{
      move_type: 'out_invoice', partner_id: Number(ctx.config.partnerId), invoice_date: inv.date, ref: inv.reference,
      invoice_line_ids: inv.lines.map((l) => [0, 0, { name: l.description, quantity: l.quantity, price_unit: odooAmount(l.unitPriceMinor), ...(ctx.config.taxId ? { tax_ids: [[6, 0, [Number(ctx.config.taxId)]]] } : {}) }]),
    }]]);
    return { externalId: String(id) };
  },
};

export const accountingAdapters = [wafeqAdapter, qoyodAdapter, odooAdapter] as const;
export const ACCOUNTING_ADAPTERS: Readonly<Record<string, AccountingAdapter>> = Object.fromEntries(accountingAdapters.map((a) => [a.descriptor.id, a]));
export const accountingAdapter = (provider: string): AccountingAdapter | null => ACCOUNTING_ADAPTERS[provider] ?? null;
