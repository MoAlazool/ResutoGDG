// accounting provider adapters. Owner: Agent D1. Export adapters and their ProviderDescriptor here.
//
// Resuto pushes deterministic, balanced journal entries (daily sales summaries)
// and sales invoices to the restaurant's own accounting system. Account ids are
// mapped per connection in config.accounts (role → provider account id/code).
import { createHash } from 'node:crypto';
import { providerRequest, ProviderError, type AdapterContext, type HealthCheckResult, type HttpOptions, type ProviderDescriptor } from '../core';
import { guardedProviderCall } from '../net';

export const ACCOUNT_ROLES = ['cash', 'card_clearing', 'wallet_clearing', 'bank', 'receivables', 'sales', 'delivery_income', 'discounts', 'vat_output', 'payment_fees', 'refunds',
  // FT-23: expense, purchase and COGS journals.
  'vat_input', 'accounts_payable', 'inventory', 'cogs', 'expenses_labor', 'expenses_rent', 'expenses_utilities', 'expenses_marketing', 'expenses_delivery',
  'expenses_maintenance', 'expenses_other'] as const;
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
/**
 * A sales invoice. Resuto pushes one DAILY SUMMARY invoice per business day (walk-in customer, one line per income
 * role) when the connection posts sales as invoices (config.salesPosting = "summary_invoice"); amounts are net of VAT
 * (tax exclusive) and the provider applies its configured VAT rate.
 */
export interface SalesInvoice {
  reference: string;
  date: string;
  currency: string;
  customerName: string;
  lines: Array<{ description: string; quantity: number; unitPriceMinor: number; taxRateBp: number; role?: AccountRole }>;
  taxInclusive: boolean;
  /** Summary invoice covering a period (Wafeq is_summary); null for a single-sale invoice. */
  summaryPeriod?: { start: string; end: string } | null;
}
/** externalId of the provider document; `existing` when the document was already there (found by its Resuto reference). */
export interface PushResult { externalId: string; existing?: boolean; raw?: Record<string, unknown> }

export interface AccountingAdapter {
  readonly descriptor: ProviderDescriptor;
  readonly requiredCredentials: readonly string[];
  /** Creates the journal unless one with the same Resuto reference already exists at the provider. */
  pushJournalEntry(ctx: AdapterContext, entry: JournalEntry): Promise<PushResult>;
  /** Creates the invoice unless one with the same Resuto reference already exists at the provider. */
  pushInvoice(ctx: AdapterContext, invoice: SalesInvoice): Promise<PushResult>;
  /**
   * One cheap authenticated read proving the credentials work, with the provider account they belong to (shown so the
   * owner can confirm it is their organisation). Same failure semantics as the payment adapters: a ProviderError with
   * retryable=true (429, 5xx, network) is "provider unreachable" and changes nothing; anything else (401/403, a missing
   * setting) is a definite failure. Accounting systems have no test/live split, so no environment is reported.
   */
  healthCheck(ctx: AdapterContext): Promise<HealthCheckResult>;
}

/** How many Resuto account roles the connection has mapped (Finance → Accounting); reported, never required here. */
const mappedRoles = (ctx: AdapterContext) => {
  const a = ctx.config.accounts as Record<string, unknown> | undefined;
  return a ? ACCOUNT_ROLES.filter((r) => a[r] !== undefined && a[r] !== null && a[r] !== '').length : 0;
};
const text = (v: unknown, max = 120): string | null => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : typeof v === 'number' ? String(v) : null);

/**
 * A stable UUID (version-4 layout) derived from a Resuto reference, for providers whose idempotency header must be a
 * UUID v4 (Wafeq). The same reference always gives the same key, so a retry after a lost response is replayed.
 */
export function referenceUuid(seed: string): string {
  const h = createHash('sha256').update(`resuto-accounting:${seed}`).digest('hex').split('');
  h[12] = '4';
  h[16] = ((parseInt(h[16]!, 16) & 0x3) | 0x8).toString(16);
  const x = h.join('');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20, 32)}`;
}

/** Integer minor units → "123.45" without floating point. */
export function accountingMinorToDecimal(minor: number): string {
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
// Wafeq (KSA/UAE) — docs checked 2026-10-21 (Markdown export of developer.wafeq.com):
//   Auth "Authorization: Api-Key <key>": https://developer.wafeq.com/reference/authentication
//   POST /v1/manual-journals/ { date, reference, external_id, notes, line_items[{ account, amount, amount_to_bcy,
//     currency, description, contact? }] } — one signed amount per line (positive = debit, negative = credit, as in
//     the guide's balanced example): https://developer.wafeq.com/reference/manual_journals_create ·
//     https://developer.wafeq.com/docs/post-journals-and-read-financial-reports
//   POST /v1/invoices/ { contact, currency, invoice_date, invoice_due_date, invoice_number, reference, external_id,
//     tax_amount_type, status DRAFT|SENT|FINALIZED, is_summary + summary_period_start/end, line_items[{ account,
//     description, quantity, unit_amount, tax_rate }] }: https://developer.wafeq.com/reference/invoices_create
//   GET lists filter by external_id (manual journals, invoices) — used to find a document already pushed.
//   X-Wafeq-Idempotency-Key: a UUID v4, replayed for 1 hour: https://developer.wafeq.com/reference/idempotency ·
//     https://developer.wafeq.com/docs/design-a-reliable-integration
//   GET /v1/organization/ (the authentication guide's example call) → { id, name{en,ar}, financial_settings{ base_currency,
//     country, tax_registration_number … } } — the health check and account identity (docs checked 2026-10-23):
//     https://developer.wafeq.com/reference/organization_retrieve
// ---------------------------------------------------------------------------
export const wafeqDescriptor: ProviderDescriptor = {
  id: 'wafeq', name: 'Wafeq', category: 'accounting', countries: ['SA', 'EG'], authType: 'api_key', readiness: 'implemented_unverified',
  docsUrl: 'https://developer.wafeq.com',
  activation: [
    'In Wafeq: Settings → API keys (app.wafeq.com/c/api-keys) → create a key; paste it as the API key.',
    'Finance → Accounting: map Resuto account roles (cash, card_clearing, sales, vat_output, receivables …) to Wafeq account ids. The Wafeq organisation base currency must be the restaurant currency.',
    'To post sales as daily summary invoices instead of a daily sales journal, set "Sales posting" to summary invoices and fill the walk-in customer contact id and the VAT tax rate id. Invoices are created as DRAFT unless you choose otherwise.',
    'Push one day to a test organisation and compare the trial balance before turning on the daily automatic push.',
  ],
  capabilities: ['journal_entries', 'invoices', 'idempotent_push', 'daily_push'],
};
const WAFEQ_API = 'https://api.wafeq.com/v1';
const wafeqHeaders = (ctx: AdapterContext, idempotencySeed?: string): Record<string, string> => {
  if (!ctx.credentials.apiKey) throw new ProviderError('wafeq', 'apiKey is not configured', false);
  return { Authorization: `Api-Key ${ctx.credentials.apiKey}`, 'Content-Type': 'application/json',
    ...(idempotencySeed ? { 'X-Wafeq-Idempotency-Key': referenceUuid(idempotencySeed) } : {}) };
};
/** Amounts as JSON numbers built from exact decimal strings (no float arithmetic on minor units). */
const decimalNumber = (minor: number) => Number(accountingMinorToDecimal(minor));
async function wafeqFind(ctx: AdapterContext, path: 'manual-journals' | 'invoices', externalId: string): Promise<string | null> {
  const r = await providerRequest<{ results?: Array<{ id?: string; external_id?: string }> }>('wafeq', ctx,
    `${WAFEQ_API}/${path}/?${new URLSearchParams({ external_id: externalId, page_size: '1' })}`, { headers: wafeqHeaders(ctx), retries: 1 });
  const hit = (r.results ?? []).find((x) => x.external_id === externalId && x.id);
  return hit?.id ? String(hit.id) : null;
}
export const wafeqAdapter: AccountingAdapter = {
  descriptor: wafeqDescriptor,
  requiredCredentials: ['apiKey'],
  async healthCheck(ctx) {
    const o = await providerRequest<any>('wafeq', ctx, `${WAFEQ_API}/organization/`, { headers: wafeqHeaders(ctx), retries: 1 });
    if (!o || typeof o !== 'object' || !o.id) throw new ProviderError('wafeq', 'unexpected response (no organisation)', false);
    const fs = (o.financial_settings ?? {}) as Record<string, unknown>;
    const currency = text(fs.base_currency, 3)?.toUpperCase() ?? null;
    return {
      ok: true,
      account: { id: String(o.id), name: text(o.name?.en) ?? text(o.name?.ar) ?? text(o.name), country: text(fs.country, 2)?.toUpperCase() ?? null, currency },
      details: { baseCurrency: currency, accountsMapped: mappedRoles(ctx) },
    };
  },
  async pushJournalEntry(ctx, entry) {
    assertBalanced(entry);
    const lines = entry.lines.map((l) => {
      const amount = l.debitMinor > 0 ? decimalNumber(l.debitMinor) : -decimalNumber(l.creditMinor);
      const contact = l.role === 'receivables' && typeof ctx.config.customerContactId === 'string' && ctx.config.customerContactId ? { contact: ctx.config.customerContactId } : {};
      return { account: account(ctx, 'wafeq', l.role), description: l.description, amount, amount_to_bcy: amount, currency: entry.currency, ...contact };
    });
    const found = await wafeqFind(ctx, 'manual-journals', entry.reference);
    if (found) return { externalId: found, existing: true };
    const r = await providerRequest<any>('wafeq', ctx, `${WAFEQ_API}/manual-journals/`, {
      method: 'POST', headers: wafeqHeaders(ctx, `journal:${entry.reference}`), retries: 1,
      body: JSON.stringify({ date: entry.date, reference: entry.reference, external_id: entry.reference, notes: entry.memo, line_items: lines }),
    });
    if (!r?.id) throw new ProviderError('wafeq', 'unexpected response (no id)', false);
    return { externalId: String(r.id) };
  },
  async pushInvoice(ctx, inv) {
    const contact = ctx.config.customerContactId;
    if (typeof contact !== 'string' || !contact) throw new ProviderError('wafeq', 'Set the walk-in customer contact id (customerContactId)', false);
    const taxRate = typeof ctx.config.taxRateId === 'string' && ctx.config.taxRateId ? ctx.config.taxRateId : null;
    if (!taxRate && inv.lines.some((l) => l.taxRateBp > 0)) throw new ProviderError('wafeq', 'Set the VAT tax rate id (taxRateId)', false);
    const lineItems = inv.lines.map((l) => ({ account: account(ctx, 'wafeq', l.role ?? 'sales'), description: l.description, quantity: l.quantity,
      unit_amount: decimalNumber(l.unitPriceMinor), ...(l.taxRateBp > 0 && taxRate ? { tax_rate: taxRate } : {}) }));
    const found = await wafeqFind(ctx, 'invoices', inv.reference);
    if (found) return { externalId: found, existing: true };
    const status = ['DRAFT', 'SENT', 'FINALIZED'].includes(String(ctx.config.invoiceStatus)) ? String(ctx.config.invoiceStatus) : 'DRAFT';
    const r = await providerRequest<any>('wafeq', ctx, `${WAFEQ_API}/invoices/`, {
      method: 'POST', headers: wafeqHeaders(ctx, `invoice:${inv.reference}`), retries: 1,
      body: JSON.stringify({
        contact, currency: inv.currency, invoice_date: inv.date, invoice_due_date: inv.date, invoice_number: inv.reference, reference: inv.reference,
        external_id: inv.reference, tax_amount_type: inv.taxInclusive ? 'TAX_INCLUSIVE' : 'TAX_EXCLUSIVE', status, line_items: lineItems,
        ...(inv.summaryPeriod ? { is_summary: true, summary_period_start: inv.summaryPeriod.start, summary_period_end: inv.summaryPeriod.end } : {}),
      }),
    });
    if (!r?.id) throw new ProviderError('wafeq', 'unexpected response (no id)', false);
    return { externalId: String(r.id) };
  },
};

// ---------------------------------------------------------------------------
// Qoyod (KSA) — Postman documentation published at https://apidoc.qoyod.com (collection "Qoyod API", checked
// 2026-10-21): header API-KEY; base https://api.qoyod.com/2.0 (the overview; request samples show www.qoyod.com/2.0);
//   POST /journal_entries { journal_entry: { description, date, debit_amounts[{ account_id, amount, comment }],
//     credit_amounts[…] } } (no reference field: Resuto puts its reference first in the description);
//   POST /invoices { invoice: { contact_id, reference (unique), issue_date, due_date, status Draft|Approved,
//     inventory_id, line_items[{ product_id, description, quantity, unit_price, tax_percent }] } };
//   index endpoints search with ransack (q[<field>_<predicate>]) — used to find a document already pushed.
//   GET /accounts (chart of accounts, the ids the journal lines reference) — the health check: the published collection
//   has no organisation/profile endpoint, so a Qoyod connection reports no account identity (only the chart size).
// ---------------------------------------------------------------------------
export const qoyodDescriptor: ProviderDescriptor = {
  id: 'qoyod', name: 'Qoyod', category: 'accounting', countries: ['SA'], authType: 'api_key', readiness: 'implemented_unverified',
  docsUrl: 'https://apidoc.qoyod.com',
  activation: [
    'In Qoyod: General settings → API → generate an API key; paste it as the API key.',
    'Finance → Accounting: map Resuto account roles to Qoyod account ids.',
    'For daily summary invoices, set the walk-in customer (contactId), the inventory (inventoryId) and a "restaurant sales" service product (productId). Invoices are created as Draft unless you choose Approved.',
    'Push one day and verify the journal in Qoyod before turning on the daily automatic push.',
  ],
  capabilities: ['journal_entries', 'invoices', 'idempotent_push', 'daily_push'],
};
const QOYOD_API = 'https://api.qoyod.com/2.0';
const qoyodAuth = (ctx: AdapterContext) => {
  if (!ctx.credentials.apiKey) throw new ProviderError('qoyod', 'apiKey is not configured', false);
  return { 'API-KEY': ctx.credentials.apiKey, 'Content-Type': 'application/json' };
};
const qoyodId = (v: string) => (/^\d+$/.test(v) ? Number(v) : v);
export const qoyodAdapter: AccountingAdapter = {
  descriptor: qoyodDescriptor,
  requiredCredentials: ['apiKey'],
  async healthCheck(ctx) {
    const r = await providerRequest<{ accounts?: unknown[] }>('qoyod', ctx, `${QOYOD_API}/accounts`, { headers: qoyodAuth(ctx), retries: 1 });
    if (!r || typeof r !== 'object' || !Array.isArray(r.accounts)) throw new ProviderError('qoyod', 'unexpected response (no chart of accounts)', false);
    return { ok: true, account: null, details: { chartAccounts: r.accounts.length, accountsMapped: mappedRoles(ctx) } };
  },
  async pushJournalEntry(ctx, entry) {
    assertBalanced(entry);
    const side = (pick: (l: JournalLine) => number) => entry.lines.filter((l) => pick(l) > 0)
      .map((l) => ({ account_id: qoyodId(account(ctx, 'qoyod', l.role)), amount: decimalNumber(pick(l)), comment: l.description.slice(0, 200) }));
    const description = `${entry.reference} — ${entry.memo}`;
    const debit = side((l) => l.debitMinor);
    const credit = side((l) => l.creditMinor);
    const list = await providerRequest<{ journal_entries?: Array<{ id?: number; description?: string }> }>('qoyod', ctx,
      `${QOYOD_API}/journal_entries?${new URLSearchParams({ 'q[description_start]': entry.reference })}`, { headers: qoyodAuth(ctx), retries: 1 });
    const hit = (list.journal_entries ?? []).find((j) => typeof j.description === 'string' && j.description.startsWith(`${entry.reference} `));
    if (hit?.id) return { externalId: String(hit.id), existing: true };
    const r = await providerRequest<any>('qoyod', ctx, `${QOYOD_API}/journal_entries`, {
      method: 'POST', headers: qoyodAuth(ctx), retries: 0,
      body: JSON.stringify({ journal_entry: { date: entry.date, description, debit_amounts: debit, credit_amounts: credit } }),
    });
    const id = r?.journal_entry?.id ?? r?.id;
    if (!id) throw new ProviderError('qoyod', 'unexpected response (no id)', false);
    return { externalId: String(id) };
  },
  async pushInvoice(ctx, inv) {
    for (const k of ['contactId', 'inventoryId', 'productId']) {
      if (!ctx.config[k]) throw new ProviderError('qoyod', `Set ${k} in the connection settings`, false);
    }
    const list = await providerRequest<{ invoices?: Array<{ id?: number; reference?: string }> }>('qoyod', ctx,
      `${QOYOD_API}/invoices?${new URLSearchParams({ 'q[reference_eq]': inv.reference })}`, { headers: qoyodAuth(ctx), retries: 1 });
    const hit = (list.invoices ?? []).find((i) => i.reference === inv.reference);
    if (hit?.id) return { externalId: String(hit.id), existing: true };
    const status = ctx.config.invoiceStatus === 'Approved' ? 'Approved' : 'Draft';
    const r = await providerRequest<any>('qoyod', ctx, `${QOYOD_API}/invoices`, {
      method: 'POST', headers: qoyodAuth(ctx), retries: 0,
      body: JSON.stringify({ invoice: {
        contact_id: qoyodId(String(ctx.config.contactId)), reference: inv.reference, description: inv.summaryPeriod ? `Resuto daily sales ${inv.summaryPeriod.start}` : inv.reference,
        issue_date: inv.date, due_date: inv.date, status, inventory_id: qoyodId(String(ctx.config.inventoryId)),
        line_items: inv.lines.map((l) => ({ product_id: qoyodId(String(ctx.config.productId)), description: l.description, quantity: l.quantity,
          unit_price: decimalNumber(l.unitPriceMinor), tax_percent: l.taxRateBp / 100 })),
      } }),
    });
    const id = r?.invoice?.id ?? r?.id;
    if (!id) throw new ProviderError('qoyod', 'unexpected response (no id)', false);
    return { externalId: String(id) };
  },
};

// ---------------------------------------------------------------------------
// Odoo Accounting — External JSON-2 API (Odoo 19+), the same transport and connection model as Odoo POS
// (packages/integrations/src/pos/odoo.ts): url + database in config, API key in credentials.
//   POST {url}/json/2/<model>/<method>, "Authorization: bearer <api key>", optional "X-Odoo-Database", JSON body of
//   named parameters (ids, context, and the method's own: domain/limit for search, vals_list for create); 200 with the
//   JSON return value, 4xx/5xx with { name, message, … }.
//   /xmlrpc and /jsonrpc are scheduled for removal in Odoo 22 (fall 2028) / Odoo Online 21.1 (winter 2027).
//   Odoo 17 / 18 servers have no JSON-2 (404): those connections keep working over the legacy external API
//   (POST {url}/jsonrpc, service "object" execute_kw, uid from config.uid or "common" authenticate with the login),
//   https://www.odoo.com/documentation/18.0/developer/reference/external_api.html — until they upgrade.
//   API keys last at most three months (rotate them). External API access needs a Custom Odoo plan.
//   https://www.odoo.com/documentation/19.0/developer/reference/external_api.html
// Moves are created as drafts (state "draft"); an accountant posts them in Odoo.
// Health check: res.company search_read (name, currency, country code) as the API key's user, plus the configured
// journal (account.journal by id) — a key that cannot read them, or a journal id that does not exist, fails the check.
// ---------------------------------------------------------------------------
export const odooAccountingDescriptor: ProviderDescriptor = {
  id: 'odoo_accounting', name: 'Odoo Accounting', category: 'accounting', countries: ['EG', 'SA'], authType: 'api_key', readiness: 'implemented_unverified',
  docsUrl: 'https://www.odoo.com/documentation/19.0/developer/reference/external_api.html',
  activation: [
    'Use Odoo 19 or later (External JSON-2 API) over HTTPS on a plan that includes the external API. Create an API key for an accounting user (Preferences → Account Security → New API Key; keys last at most three months).',
    'Enter the Odoo URL and database (the same settings as the Odoo POS connection) and paste the API key.',
    'Set the journal id for Resuto summaries, map account roles in Finance → Accounting, and for invoices the walk-in partner id (and optionally the tax id).',
    'Entries are created as drafts. Push one day to a staging database first and compare the general ledger.',
    'Odoo 17 or 18 (no JSON-2): also enter the login of that user (and the database); Resuto then uses the older external API (/jsonrpc), which Odoo removes in Odoo 22 — upgrade before then.',
  ],
  capabilities: ['journal_entries', 'invoices', 'idempotent_push', 'daily_push'],
};
/** Shared Odoo connection settings (POS and Accounting): url/database in config; legacy accounting rows kept them in credentials. */
export function odooSettings(ctx: AdapterContext, provider: string) {
  const url = String(ctx.config.url ?? ctx.credentials.url ?? '').replace(/\/$/, '');
  if (!/^https:\/\//.test(url)) throw new ProviderError(provider, 'Set the Odoo URL (https://…)', false);
  const key = ctx.credentials.apiKey;
  if (!key) throw new ProviderError(provider, 'missing API key', false);
  const database = typeof ctx.config.database === 'string' && ctx.config.database ? ctx.config.database : ctx.credentials.db || null;
  return { url, key, database };
}

/**
 * One JSON-2 call. The URL is tenant-supplied (audit INT-02): the egress guard applies and errors keep only the HTTP
 * status or the Odoo exception name, never the server's text. A 404 (no JSON-2: Odoo 17 / 18) falls back to the legacy
 * /jsonrpc external API when the connection has the login it needs.
 */
async function odooJson2<T>(ctx: AdapterContext, model: string, method: 'search' | 'search_read' | 'create', body: Record<string, unknown>): Promise<T> {
  const { url, key, database } = odooSettings(ctx, 'odoo_accounting');
  const target = `${url}/json/2/${model}/${method}`;
  const headers: Record<string, string> = { Authorization: `bearer ${key}`, 'Content-Type': 'application/json; charset=utf-8', 'User-Agent': 'Resuto' };
  if (database) headers['X-Odoo-Database'] = database;
  const opts: HttpOptions = { method: 'POST', headers, body: JSON.stringify(body), retries: 0 };
  try {
    // guardedProviderCall redacts failures to "HTTP <status>" (the body could come from any server).
    return await guardedProviderCall('odoo_accounting', ctx.fetch, target, (fetch) => providerRequest<T>('odoo_accounting', { fetch }, target, opts));
  } catch (e) {
    if (!(e instanceof ProviderError && e.status === 404)) throw e;
    const login = String(ctx.credentials.login ?? ctx.config.login ?? '');
    if (!login && !ctx.config.uid) {
      throw new ProviderError('odoo_accounting', 'This Odoo server has no JSON-2 API (Odoo 19+). For Odoo 17 / 18, add the login of the API key\'s user', false, 404);
    }
    if (!database) throw new ProviderError('odoo_accounting', 'Set the Odoo database (needed for Odoo 17 / 18)', false);
    const args = method === 'create' ? [body.vals_list] : [body.domain];
    const kwargs = method === 'create' ? {} : { ...(body.limit ? { limit: body.limit } : {}), ...(method === 'search_read' && body.fields ? { fields: body.fields } : {}) };
    const uid = ctx.config.uid ? Number(ctx.config.uid) : await odooLegacyCall(ctx, url, 'common', 'authenticate', [database, login, key, {}]);
    if (!uid) throw new ProviderError('odoo_accounting', 'Odoo authentication failed', false);
    return odooLegacyCall(ctx, url, 'object', 'execute_kw', [database, Number(uid), key, model, method, args, kwargs]) as Promise<T>;
  }
}

/** Legacy external API (Odoo ≤ 18): JSON-RPC over /jsonrpc. Errors keep only the Odoo exception name. */
async function odooLegacyCall(ctx: AdapterContext, url: string, service: 'common' | 'object', method: string, args: unknown[]): Promise<any> {
  const target = `${url}/jsonrpc`;
  const r = await guardedProviderCall('odoo_accounting', ctx.fetch, target, (fetch) => providerRequest<any>('odoo_accounting', { fetch }, target, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': 'Resuto' }, retries: 0,
    body: JSON.stringify({ jsonrpc: '2.0', method: 'call', params: { service, method, args }, id: 1 }),
  }));
  if (r?.error) {
    const name = typeof r.error?.data?.name === 'string' && /^[A-Za-z0-9_.]{1,120}$/.test(r.error.data.name) ? r.error.data.name : null;
    throw new ProviderError('odoo_accounting', name ? `Odoo rejected the request (${name})` : 'Odoo rejected the request', false);
  }
  return r?.result;
}
const odooAmount = (minor: number) => Number(accountingMinorToDecimal(minor));
const firstId = (r: unknown): string => {
  const v = Array.isArray(r) ? r[0] : r;
  if (typeof v !== 'number' && !(typeof v === 'string' && /^\d+$/.test(v))) throw new ProviderError('odoo_accounting', 'unexpected response (no id)', false);
  return String(v);
};
async function odooFindMove(ctx: AdapterContext, reference: string, moveType: string): Promise<string | null> {
  const ids = await odooJson2<unknown[]>(ctx, 'account.move', 'search', { domain: [['ref', '=', reference], ['move_type', '=', moveType]], limit: 1 });
  return Array.isArray(ids) && ids.length ? firstId(ids) : null;
}
const many2oneName = (v: unknown): string | null => (Array.isArray(v) && v.length >= 2 ? text(v[1]) : null);
export const odooAccountingAdapter: AccountingAdapter = {
  descriptor: odooAccountingDescriptor,
  requiredCredentials: ['apiKey'],
  async healthCheck(ctx) {
    const companies = await odooJson2<unknown>(ctx, 'res.company', 'search_read', { domain: [], fields: ['name', 'currency_id', 'country_code'], limit: 1 });
    const c = Array.isArray(companies) ? (companies[0] as Record<string, unknown> | undefined) : undefined;
    if (!c || (typeof c.id !== 'number' && typeof c.id !== 'string')) throw new ProviderError('odoo_accounting', 'unexpected response (no company)', false);
    const currency = many2oneName(c.currency_id)?.toUpperCase().slice(0, 3) ?? null;
    let journalFound: boolean | null = null;
    if (ctx.config.journalId) {
      const ids = await odooJson2<unknown[]>(ctx, 'account.journal', 'search', { domain: [['id', '=', Number(ctx.config.journalId)]], limit: 1 });
      journalFound = Array.isArray(ids) && ids.length > 0;
    }
    return {
      ok: journalFound !== false,
      account: { id: String(c.id), name: text(c.name), country: text(c.country_code, 2)?.toUpperCase() ?? null, currency },
      details: { journalFound, accountsMapped: mappedRoles(ctx) },
    };
  },
  async pushJournalEntry(ctx, entry) {
    assertBalanced(entry);
    const lines = entry.lines.map((l) => [0, 0, { account_id: Number(account(ctx, 'odoo', l.role)), name: l.description, debit: odooAmount(l.debitMinor), credit: odooAmount(l.creditMinor) }]);
    if (!ctx.config.journalId) throw new ProviderError('odoo_accounting', 'Set the journal id (journalId)', false);
    const found = await odooFindMove(ctx, entry.reference, 'entry');
    if (found) return { externalId: found, existing: true };
    const r = await odooJson2<unknown>(ctx, 'account.move', 'create', { vals_list: [{
      move_type: 'entry', date: entry.date, ref: entry.reference, journal_id: Number(ctx.config.journalId), narration: entry.memo, line_ids: lines,
    }] });
    return { externalId: firstId(r) };
  },
  async pushInvoice(ctx, inv) {
    if (!ctx.config.partnerId) throw new ProviderError('odoo_accounting', 'Set the walk-in partner id (partnerId)', false);
    const found = await odooFindMove(ctx, inv.reference, 'out_invoice');
    if (found) return { externalId: found, existing: true };
    const r = await odooJson2<unknown>(ctx, 'account.move', 'create', { vals_list: [{
      move_type: 'out_invoice', partner_id: Number(ctx.config.partnerId), invoice_date: inv.date, ref: inv.reference,
      invoice_line_ids: inv.lines.map((l) => [0, 0, {
        name: l.description, quantity: l.quantity, price_unit: odooAmount(l.unitPriceMinor),
        ...(l.role && (ctx.config.accounts as Record<string, unknown> | undefined)?.[l.role] ? { account_id: Number(account(ctx, 'odoo', l.role)) } : {}),
        ...(ctx.config.taxId && l.taxRateBp > 0 ? { tax_ids: [[6, 0, [Number(ctx.config.taxId)]]] } : { tax_ids: [[6, 0, []]] }),
      }]),
    }] });
    return { externalId: firstId(r) };
  },
};

export const accountingAdapters = [wafeqAdapter, qoyodAdapter, odooAccountingAdapter] as const;
export const ACCOUNTING_ADAPTERS: Readonly<Record<string, AccountingAdapter>> = Object.fromEntries(accountingAdapters.map((a) => [a.descriptor.id, a]));
export const accountingAdapter = (provider: string): AccountingAdapter | null => ACCOUNTING_ADAPTERS[provider] ?? null;
