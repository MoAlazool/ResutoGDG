// Accounting acceptance checks (INT-25). Read-only by default: they prove the key reaches the right organisation and
// that the account mapping Resuto needs exists. Pushing a real journal is a separate, explicit write_test check meant
// for a TEST organisation / staging database only (it creates one balanced 0.01 journal and reports its id).
import { providerRequest } from '../core';
import { wafeqAdapter, type JournalEntry } from '../accounting';
import { expectThat, registerChecks, type AcceptanceCheck } from './index';
import { runKey } from './payments-common';

const testEntry = (ref: string): JournalEntry => ({
  reference: ref, date: new Date().toISOString().slice(0, 10), currency: process.env.ACCOUNTING_TEST_CURRENCY || 'SAR', memo: 'Resuto acceptance check (test organisation only)',
  lines: [{ role: 'cash', description: 'Acceptance check', debitMinor: 1, creditMinor: 0 }, { role: 'sales', description: 'Acceptance check', debitMinor: 0, creditMinor: 1 }],
});

export const accountingChecks: AcceptanceCheck[] = [
  {
    id: 'wafeq.organization', provider: 'wafeq', capability: 'auth', modes: ['official_test', 'live'], requires: ['WAFEQ_API_KEY'], effect: 'read',
    docsUrl: 'https://developer.wafeq.com/reference/authentication',
    async run(ctx) {
      const org = await providerRequest<{ name?: string; currency?: string }>('wafeq', ctx.adapter, 'https://api.wafeq.com/v1/organization/', {
        headers: { Authorization: `Api-Key ${ctx.env.WAFEQ_API_KEY}` }, retries: 1 });
      ctx.evidence('organization read', { name: org.name ?? null, currency: org.currency ?? null });
      const journals = await providerRequest<{ count?: number }>('wafeq', ctx.adapter, 'https://api.wafeq.com/v1/manual-journals/?page_size=1', {
        headers: { Authorization: `Api-Key ${ctx.env.WAFEQ_API_KEY}` }, retries: 1 });
      ctx.evidence('manual journals listable', { count: journals.count ?? null });
      expectThat(typeof journals.count === 'number', 'the manual journals list did not return a count');
    },
  },
  {
    id: 'wafeq.test_journal', provider: 'wafeq', capability: 'journal_entries', modes: ['official_test'],
    requires: ['WAFEQ_API_KEY', 'WAFEQ_TEST_CASH_ACCOUNT', 'WAFEQ_TEST_SALES_ACCOUNT'], effect: 'write_test',
    prerequisites: ['A Wafeq TEST organisation (never the restaurant\'s books). Two account ids for the 0.01 entry; ACCOUNTING_TEST_CURRENCY = that organisation\'s base currency.'],
    docsUrl: 'https://developer.wafeq.com/reference/manual_journals_create',
    async run(ctx) {
      const actx = { ...ctx.adapter, credentials: { apiKey: ctx.env.WAFEQ_API_KEY! }, config: { accounts: { cash: ctx.env.WAFEQ_TEST_CASH_ACCOUNT, sales: ctx.env.WAFEQ_TEST_SALES_ACCOUNT } } };
      const ref = `RSJ-acceptance-${runKey('w').replace(/[^0-9]/g, '')}`;
      const first = await wafeqAdapter.pushJournalEntry(actx, testEntry(ref));
      ctx.evidence('journal created', { externalId: first.externalId });
      const again = await wafeqAdapter.pushJournalEntry(actx, testEntry(ref));
      ctx.evidence('second push of the same reference', { externalId: again.externalId, existing: !!again.existing });
      expectThat(again.existing && again.externalId === first.externalId, 'the second push created another journal');
    },
  },
  {
    id: 'qoyod.accounts', provider: 'qoyod', capability: 'auth', modes: ['official_test', 'live'], requires: ['QOYOD_API_KEY'], effect: 'read',
    docsUrl: 'https://apidoc.qoyod.com',
    async run(ctx) {
      const r = await providerRequest<{ accounts?: unknown[] }>('qoyod', ctx.adapter, 'https://api.qoyod.com/2.0/accounts', { headers: { 'API-KEY': ctx.env.QOYOD_API_KEY! }, retries: 1 });
      ctx.evidence('accounts listed', { accounts: Array.isArray(r.accounts) ? r.accounts.length : null });
      expectThat(Array.isArray(r.accounts), 'no accounts array in the response');
    },
  },
  {
    id: 'odoo_accounting.json2_search', provider: 'odoo_accounting', capability: 'auth', modes: ['official_test', 'live'],
    requires: ['ODOO_URL', 'ODOO_API_KEY'], effect: 'read',
    prerequisites: ['Odoo 19+ with the external API (Custom plan). Optional ODOO_DATABASE. Use a staging database.'],
    docsUrl: 'https://www.odoo.com/documentation/19.0/developer/reference/external_api.html',
    async run(ctx) {
      // A search that matches nothing proves the key, the database header and JSON-2 without reading any data.
      const probe = `RSJ-acceptance-probe-${Date.now()}`;
      const r = await providerRequest<unknown[]>('odoo_accounting', ctx.adapter, `${String(ctx.env.ODOO_URL).replace(/\/$/, '')}/json/2/account.move/search`, {
        method: 'POST', retries: 0,
        headers: { Authorization: `bearer ${ctx.env.ODOO_API_KEY}`, 'Content-Type': 'application/json', ...(process.env.ODOO_DATABASE ? { 'X-Odoo-Database': process.env.ODOO_DATABASE } : {}) },
        body: JSON.stringify({ domain: [['ref', '=', probe]], limit: 1 }),
      });
      ctx.evidence('account.move/search over JSON-2', { results: Array.isArray(r) ? r.length : null });
      expectThat(Array.isArray(r) && r.length === 0, 'unexpected search result');
    },
  },
];

registerChecks(...accountingChecks);
