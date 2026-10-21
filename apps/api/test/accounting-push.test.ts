// INT-25: accounting push completion. Summary-invoice posting (revenue once: RSI invoice + RSR receipts), per-reference
// idempotency (a second push of the same period never creates provider documents again), provider-side look-up, the
// daily automatic push, and Odoo Accounting over JSON-2 with the Odoo POS settings model. Provider calls are scripted.
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { TenantContext } from '../src/common/auth/context';
import { SecretBox } from '../src/common/crypto/secret-box';
import { DbService } from '../src/common/db/db.service';
import { AccountingService } from '../src/modules/finance/accounting.service';
import { ProviderHttp } from '../src/modules/integrations/provider-http';
import { OrdersKernelService } from '../src/modules/kernel/orders-kernel.service';
import { PaymentLedgerService } from '../src/modules/kernel/payment-ledger.service';
import { scriptedFetch, type RecordedRequest } from './growth-helpers';
import { addMember, auth, bootTestApp, createTenant, seedMenu, sql, type TestApp, type TestTenant, type TestUser } from './helpers';

let t: TestApp;
let http: ProviderHttp;
let original: typeof fetch;
beforeAll(async () => { t = await bootTestApp(); http = t.app.get(ProviderHttp); original = http.fetch; });
afterEach(() => { http.fetch = original; });
afterAll(async () => { await t.close(); });

const DAY = '2026-09-10';
const ACCOUNTS = { cash: 'A-CASH', card_clearing: 'A-CARD', receivables: 'A-AR', sales: 'A-SALES', vat_output: 'A-VAT', refunds: 'A-REF', delivery_income: 'A-DEL',
  payment_fees: 'A-FEE', cogs: 'A-COGS', inventory: 'A-INV' };

/** EG restaurant (VAT 14 % inclusive): one cash order (2 × Fries 9000) and one card order (2 × Soda 5000, fee 150) on DAY. */
async function restaurant(provider: 'wafeq' | 'odoo_accounting', config: Record<string, unknown>, credentials: Record<string, string>) {
  const tenant = await createTenant(t, { country: 'EG' });
  const menu = await seedMenu(tenant);
  const ctx = new TenantContext(tenant.orgId, 'owner', null, tenant.owner.userId, 'user', tenant.owner.userId);
  const db = t.app.get(DbService);
  const orders = t.app.get(OrdersKernelService);
  const ledger = t.app.get(PaymentLedgerService);
  const place = (productId: string) => db.scoped(ctx, (tx) => orders.place(tx, ctx, { branchId: tenant.branchId, channel: 'staff', fulfillment: 'pickup', lines: [{ productId, quantity: 2 }] }));
  const a = await place(menu.products.fries);
  const b = await place(menu.products.soda);
  await db.scoped(ctx, (tx) => ledger.recordSucceeded(tx, ctx, { branchId: tenant.branchId, orderId: a.id, method: 'cash', provider: 'manual', amountMinor: 9000, currency: 'EGP' }));
  await db.scoped(ctx, (tx) => ledger.recordSucceeded(tx, ctx, { branchId: tenant.branchId, orderId: b.id, method: 'card', provider: 'paymob', amountMinor: 5000, currency: 'EGP',
    feeMinor: 150, providerPaymentId: `acc-${tenant.orgId}` }));
  await sql(`update orders set business_date = $2, placed_at = $3 where org_id = $1`, [tenant.orgId, DAY, `${DAY}T12:00:00+02`]);
  await sql(`update payments set captured_at = $2, created_at = $2 where org_id = $1`, [tenant.orgId, `${DAY}T12:30:00+02`]);
  await sql(`insert into tax_profiles(org_id, country, regime, vat_rate_bp) values ($1, 'EG', 'none', 1400) on conflict (org_id) do update set vat_rate_bp = 1400`, [tenant.orgId]);
  const accountant = await addMember(t, tenant, 'accountant');
  const box = t.app.get(SecretBox);
  const [conn] = await sql(
    `insert into integration_connections(org_id, provider, category, auth_type, environment, status, credentials_encrypted, config)
     values ($1, $2, 'accounting', 'api_key', 'live', 'connected', $3, $4) returning id`,
    [tenant.orgId, provider, box.sealJson(credentials, `${tenant.orgId}:${provider}`), { accounts: ACCOUNTS, ...config }]);
  return { tenant, accountant, connectionId: conn.id as string };
}
const push = (tenant: TestTenant, user: TestUser, connectionId: string, key: string) =>
  t.http.post(`/v1/o/${tenant.orgId}/finance/accounting/push`).set(auth(user)).send({ connectionId, from: DAY, to: DAY, key });
const wafeq = () => scriptedFetch([(req: RecordedRequest) => {
  if (req.method === 'GET') return { body: { count: 0, results: [] } };
  const path = new URL(req.url).pathname;
  return { status: 201, body: { id: path.includes('invoices') ? `inv_${Math.random().toString(36).slice(2, 8)}` : `mj_${Math.random().toString(36).slice(2, 8)}` } };
}]);

describe('Wafeq daily summary invoices (INT-25)', () => {
  it('posts revenue once: an RSI summary invoice (net of VAT) and an RSR receipts journal instead of the RSJ sales journal', async () => {
    const { tenant, accountant, connectionId } = await restaurant('wafeq', { salesPosting: 'summary_invoice', customerContactId: 'ct_walkin', taxRateId: 'tr_vat14' }, { apiKey: 'wk_test' });
    const f = wafeq();
    http.fetch = f.fetch;
    const res = await push(tenant, accountant, connectionId, 'push-inv-0001');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body, JSON.stringify(res.body)).toMatchObject({ provider: 'wafeq', kind: 'invoice', status: 'succeeded', automatic: false });
    const posts = f.calls.filter((c) => c.method === 'POST');
    const inv = posts.find((c) => c.url.endsWith('/invoices/'))!;
    const invBody = JSON.parse(inv.body!);
    expect(invBody).toMatchObject({ contact: 'ct_walkin', currency: 'EGP', invoice_date: DAY, is_summary: true, summary_period_start: DAY, status: 'DRAFT',
      tax_amount_type: 'TAX_EXCLUSIVE', invoice_number: expect.stringMatching(new RegExp(`^RSI-.+-${DAY}$`)) });
    // 14000 gross incl. 1719 VAT → 12281 net on one sales line with the VAT rate.
    expect(invBody.line_items).toEqual([{ account: 'A-SALES', description: 'Food & beverage sales (2 orders)', quantity: 1, unit_amount: 122.81, tax_rate: 'tr_vat14' }]);
    const journals = posts.filter((c) => c.url.endsWith('/manual-journals/')).map((c) => JSON.parse(c.body!));
    expect(journals.map((j) => j.reference.slice(0, 3)).sort()).toEqual(['RSC', 'RSF', 'RSR']);
    const rsr = journals.find((j) => j.reference.startsWith('RSR'))!;
    expect([...rsr.line_items].sort((x: any, y: any) => x.account.localeCompare(y.account))).toEqual([
      { account: 'A-AR', description: 'Daily sales collected', amount: -140, amount_to_bcy: -140, currency: 'EGP', contact: 'ct_walkin' },
      { account: 'A-CARD', description: 'Collected (card_clearing)', amount: 50, amount_to_bcy: 50, currency: 'EGP' },
      { account: 'A-CASH', description: 'Collected (cash)', amount: 90, amount_to_bcy: 90, currency: 'EGP' },
    ]);
    expect(journals.some((j) => j.reference.startsWith('RSJ'))).toBe(false);
    // Every write carried a UUID v4 idempotency key.
    for (const p of posts) expect(p.headers['x-wafeq-idempotency-key']).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    const items = await sql(`select reference, kind from accounting_push_items where connection_id = $1 order by reference`, [connectionId]);
    expect(items.map((i: any) => [i.reference.slice(0, 3), i.kind])).toEqual([['RSC', 'journal'], ['RSF', 'journal'], ['RSI', 'invoice'], ['RSR', 'journal']]);
  });

  it('a second push of the same period (new key) creates nothing at the provider', async () => {
    const { tenant, accountant, connectionId } = await restaurant('wafeq', { salesPosting: 'summary_invoice', customerContactId: 'ct_walkin', taxRateId: 'tr_vat14' }, { apiKey: 'wk_test' });
    http.fetch = wafeq().fetch;
    await push(tenant, accountant, connectionId, 'push-inv-0002');
    const again = wafeq();
    http.fetch = again.fetch;
    const res = await push(tenant, accountant, connectionId, 'push-inv-0003');
    expect(res.body.status).toBe('succeeded');
    expect(res.body.results.every((r: any) => r.skipped === 'already_pushed')).toBe(true);
    expect(again.calls).toHaveLength(0);
  });

  it('journal mode: a document the provider already has (lost response) is found by external_id instead of duplicated', async () => {
    const { tenant, accountant, connectionId } = await restaurant('wafeq', {}, { apiKey: 'wk_test' });
    const f = scriptedFetch([(req: RecordedRequest) => {
      const ext = new URL(req.url).searchParams.get('external_id');
      if (req.method === 'GET') return { body: { results: ext?.startsWith('RSJ') ? [{ id: 'mj_existing', external_id: ext }] : [] } };
      return { status: 201, body: { id: 'mj_new' } };
    }]);
    http.fetch = f.fetch;
    const res = await push(tenant, accountant, connectionId, 'push-jnl-0001');
    expect(res.body).toMatchObject({ kind: 'journal', status: 'succeeded' });
    const rsj = res.body.results.find((r: any) => r.reference.startsWith('RSJ'));
    expect(rsj).toMatchObject({ externalId: 'mj_existing', skipped: 'found_at_provider' });
    expect(f.calls.filter((c) => c.method === 'POST').map((c) => JSON.parse(c.body!).reference.slice(0, 3)).sort()).toEqual(['RSC', 'RSF']);
  });

  it('refuses summary invoices without a VAT rate (nothing sent)', async () => {
    const { tenant, accountant, connectionId } = await restaurant('wafeq', { salesPosting: 'summary_invoice', customerContactId: 'ct', taxRateId: 'tr' }, { apiKey: 'wk_test' });
    await sql(`delete from tax_profiles where org_id = $1`, [tenant.orgId]);
    const f = wafeq();
    http.fetch = f.fetch;
    const res = await push(tenant, accountant, connectionId, 'push-inv-0004');
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('vat_rate_missing');
    expect(f.calls).toHaveLength(0);
  });
});

describe('daily automatic push (INT-25)', () => {
  it('pushes the previous business day once for connections set to daily, as the system', async () => {
    const { tenant, connectionId } = await restaurant('wafeq', { autoPush: 'daily' }, { apiKey: 'wk_test' });
    // A timezone where it is already past 04:00 now, so the previous local day is due; orders are moved to that day.
    const [{ tz }] = await sql<{ tz: string }>(`select z as tz from unnest(array['Africa/Cairo', 'Asia/Riyadh', 'Asia/Tokyo', 'America/Los_Angeles', 'Pacific/Kiritimati']) z
      where extract(hour from now() at time zone z) between 4 and 22 limit 1`);
    await sql(`update organizations set timezone = $2 where id = $1`, [tenant.orgId, tz]);
    const [{ y }] = await sql<{ y: string }>(`select ((now() at time zone $1)::date - 1)::text as y`, [tz]);
    await sql(`update orders set business_date = $2 where org_id = $1`, [tenant.orgId, y]);
    const f = wafeq();
    http.fetch = f.fetch;
    const svc = t.app.get(AccountingService);
    const first = await svc.dailyPush();
    const pushes = await sql(`select idempotency_key, status, period_start::text as d from accounting_pushes where connection_id = $1`, [connectionId]);
    {
      expect(first.pushed).toBeGreaterThanOrEqual(1);
      expect(pushes).toEqual([{ idempotency_key: `auto:${connectionId}:${y}:1`, status: 'succeeded', d: y }]);
      const posts = f.calls.filter((c) => c.method === 'POST').length;
      await svc.dailyPush();
      expect(f.calls.filter((c) => c.method === 'POST').length).toBe(posts);
      expect((await sql(`select count(*)::int as n from accounting_pushes where connection_id = $1`, [connectionId]))[0].n).toBe(1);
    }
  });
});

describe('Odoo Accounting over JSON-2 (INT-25)', () => {
  it('uses the shared Odoo settings (url + database in config, key sealed) and creates draft moves after a ref search', async () => {
    const { tenant, accountant, connectionId } = await restaurant('odoo_accounting', { url: 'https://acme.odoo.com', database: 'acme', journalId: '3',
      accounts: { cash: '10', card_clearing: '11', receivables: '12', sales: '20', vat_output: '30', payment_fees: '40', cogs: '50', inventory: '51' } }, { apiKey: 'odoo-key-123' });
    let next = 900;
    const f = scriptedFetch([(req: RecordedRequest) => (req.url.endsWith('/search') ? { body: [] } : { body: [next++] })]);
    // Tests run without DNS: the tenant-URL egress guard resolves acme.odoo.com through this public address (net.ts EGRESS_RESOLVER).
    http.fetch = Object.assign(f.fetch, { [Symbol.for('resuto.egress.resolver')]: async () => [{ address: '93.184.215.14', family: 4 }] });
    const res = await push(tenant, accountant, connectionId, 'push-odoo-0001');
    expect(res.body, JSON.stringify(res.body)).toMatchObject({ provider: 'odoo_accounting', status: 'succeeded' });
    // RSC, RSF and RSJ: each searched by ref, then created.
    expect(f.calls.map((c) => new URL(c.url).pathname)).toEqual(Array(3).fill(['/json/2/account.move/search', '/json/2/account.move/create']).flat());
    expect(f.calls[0]!.headers).toMatchObject({ authorization: 'bearer odoo-key-123', 'x-odoo-database': 'acme' });
    expect(JSON.parse(f.calls[1]!.body!).vals_list[0]).toMatchObject({ move_type: 'entry', journal_id: 3 });
  });
});
