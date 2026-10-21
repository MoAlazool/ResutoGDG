import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TenantContext } from '../src/common/auth/context';
import { SecretBox } from '../src/common/crypto/secret-box';
import { DbService } from '../src/common/db/db.service';
import { OrdersKernelService } from '../src/modules/kernel/orders-kernel.service';
import { PaymentLedgerService } from '../src/modules/kernel/payment-ledger.service';
import { addMember, auth, bootTestApp, createTenant, seedMenu, sql, type SeededMenu, type TestApp, type TestTenant, type TestUser } from './helpers';

// Controlled dataset (EG, VAT 14 % inclusive, pickup → no service charge):
//   A  2 × Fries   9000, VAT 1105, cost 2700 — cash 9000, then 3000 refunded (refund VAT 368)
//   B  2 × Soda    5000, VAT  614, cost 1500 — card 5000 with a 150 provider fee
//   C  1 × Soda    2500 — cancelled (excluded)
//   D  1 × Fries   4500 − 10 % promo = 4050, VAT 497, cost 1350 — unpaid
//   E  1 × Fries   4500 in August (VAT 553, cost 1350) — previous month for the margin trend
// Expenses (September): rent 100000; utilities 20000 incl. 2800 VAT; ingredients (cogs) 5000 incl. 700 VAT; payment fees 1000.
// Expenses (August): utilities 10000.
let t: TestApp;
let db: DbService;
let tenant: TestTenant;
let menu: SeededMenu;
let ctx: TenantContext;
let accountant: TestUser;
let waiter: TestUser;
const P = { from: '2026-09-01', to: '2026-09-30' };
const q = new URLSearchParams(P).toString();

beforeAll(async () => {
  t = await bootTestApp();
  db = t.app.get(DbService);
  const orders = t.app.get(OrdersKernelService);
  const ledger = t.app.get(PaymentLedgerService);
  tenant = await createTenant(t, { country: 'EG' });
  menu = await seedMenu(tenant);
  ctx = new TenantContext(tenant.orgId, 'owner', null, tenant.owner.userId, 'user', tenant.owner.userId);
  accountant = await addMember(t, tenant, 'accountant');
  waiter = await addMember(t, tenant, 'waiter');
  await sql(`insert into promotions(org_id, code, name, kind, value) values ($1, 'TEN', 'Ten', 'percent', 1000)`, [tenant.orgId]);
  const place = (productId: string, quantity: number, promotionCode?: string) => db.scoped(ctx, (tx) => orders.place(tx, ctx, {
    branchId: tenant.branchId, channel: 'staff', fulfillment: 'pickup', lines: [{ productId, quantity }], promotionCode }));
  const a = await place(menu.products.fries, 2);
  const b = await place(menu.products.soda, 2);
  const c = await place(menu.products.soda, 1);
  const d = await place(menu.products.fries, 1, 'TEN');
  const e = await place(menu.products.fries, 1);
  await db.scoped(ctx, (tx) => orders.transition(tx, ctx, c.id, 'cancelled', { reason: 'test' }));
  const cash = await db.scoped(ctx, (tx) => ledger.recordSucceeded(tx, ctx, { branchId: tenant.branchId, orderId: a.id, method: 'cash', provider: 'manual', amountMinor: 9000, currency: 'EGP' }));
  await db.scoped(ctx, (tx) => ledger.recordSucceeded(tx, ctx, { branchId: tenant.branchId, orderId: b.id, method: 'card', provider: 'paymob', amountMinor: 5000, currency: 'EGP', feeMinor: 150, providerPaymentId: `fin-${tenant.orgId}` }));
  await db.scoped(ctx, (tx) => ledger.applyRefund(tx, ctx, cash.id, 3000));
  await sql(`update orders set business_date = '2026-09-10', placed_at = '2026-09-10T12:00:00+02' where id = any($1::uuid[])`, [[a.id, b.id, c.id, d.id]]);
  await sql(`update orders set business_date = '2026-08-20', placed_at = '2026-08-20T12:00:00+02' where id = $1`, [e.id]);
  await sql(`update payments set captured_at = '2026-09-10T12:30:00+02', created_at = '2026-09-10T12:30:00+02' where org_id = $1`, [tenant.orgId]);
  const cat = async (name: string) => (await sql(`select id from expense_categories where org_id = $1 and name = $2`, [tenant.orgId, name]))[0].id;
  const exp = (category: string, amount: number, tax: number, on: string) => sql(
    `insert into expenses(org_id, category_id, amount_minor, tax_minor, currency, incurred_on) values ($1, $2, $3, $4, 'EGP', $5)`, [tenant.orgId, category, amount, tax, on]);
  await exp(await cat('Rent'), 100000, 0, '2026-09-01');
  await exp(await cat('Utilities'), 20000, 2800, '2026-09-15');
  await exp(await cat('Ingredients'), 5000, 700, '2026-09-05');
  await exp(await cat('Payment fees'), 1000, 0, '2026-09-30');
  await exp(await cat('Utilities'), 10000, 0, '2026-08-15');
});
afterAll(async () => { await t.close(); });

describe('finance read models on a controlled dataset', () => {
  it('computes the revenue overview exactly', async () => {
    const r = await t.http.get(`/v1/o/${tenant.orgId}/finance/overview?${q}`).set(auth(accountant));
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.totals).toEqual({ orderCount: 3, grossMinor: 18500, discountsMinor: 450, refundsMinor: 3000, netMinor: 15050, vatMinor: 1848, netExVatMinor: 13202, collectedMinor: 11000 });
    expect(r.body.byDay).toEqual([{ date: '2026-09-10', ...r.body.totals }]);
    expect(r.body.byMethod).toEqual([
      { method: 'cash', collectedMinor: 9000, refundedMinor: 3000, count: 1 },
      { method: 'card', collectedMinor: 5000, refundedMinor: 0, count: 1 },
    ]);
    expect(r.body.warnings).toEqual(['1 order(s) in this period are not fully paid; revenue counts them, collected amounts do not.']);
  });

  it('builds the P&L with methodology and coverage', async () => {
    const r = await t.http.get(`/v1/o/${tenant.orgId}/finance/pnl?${q}`).set(auth(accountant));
    expect(r.status).toBe(200);
    // DF-04: the default policy (item-cost COGS, provider-reported fees) counts each cost once. The ingredient purchase
    // (5000 incl. 700 VAT) is an inventory purchase memo, not COGS; the "Payment fees" expense (1000) duplicates the
    // provider's statement and is a memo. (Before DF-04 both were added: COGS 9850 and fees 1150.)
    expect(r.body.lines).toEqual({
      grossSalesMinor: 18500, discountsMinor: 450, refundsMinor: 3000, vatMinor: 1848, netRevenueMinor: 13202,
      cogsFromSalesMinor: 5550, cogsExpensesMinor: 0, cogsMinor: 5550, grossProfitMinor: 7652,
      operatingExpensesMinor: 117200, operatingExpensesByKind: { rent: 100000, utilities: 17200 },
      paymentFeesMinor: 150, operatingProfitMinor: -109698,
      memo: { inventoryPurchasesMinor: 4300, itemCostOfSalesMinor: 0, feeExpensesMinor: 1000, providerReportedFeesMinor: 0 },
    });
    expect(r.body.policy).toMatchObject({ cogsMethod: 'item_cost', feesMethod: 'provider_reports' });
    expect(r.body.grossMarginBp).toBe(5796);
    expect(r.body.operatingMarginBp).toBe(-83092);
    expect(r.body.coverage).toEqual({ linesWithoutCost: 0, salesWithoutCostMinor: 0, unpaidOrders: 1, paymentsWithUnknownFee: 0, testPayments: 0, costedSalesBp: 10000 });
    expect(r.body.isSyntheticData).toBe(false);
    expect(r.body.methodology.length).toBeGreaterThan(4);
    expect(r.body.warnings).toContain('Ingredient purchases recorded as COGS expenses are treated as inventory purchases under the item-cost policy (memo line), not as an expense.');
    expect(r.body.warnings).toContain('"Fees" expenses are shown as a memo under the provider-reports policy, because provider statements already include them.');
    const fees = await t.http.get(`/v1/o/${tenant.orgId}/finance/fees?${q}`).set(auth(accountant));
    expect(fees.body).toMatchObject({ totalFeesMinor: 150, items: [{ provider: 'manual', method: 'cash', feesMinor: 0 }, { provider: 'paymob', method: 'card', feesMinor: 150, volumeMinor: 5000 }] });
  });

  it('derives margin trend and the fastest-growing expense category deterministically', async () => {
    const r = await t.http.get(`/v1/o/${tenant.orgId}/finance/insights?${q}`).set(auth(accountant));
    expect(r.status).toBe(200);
    const months = r.body.marginTrend.months;
    expect(months.map((m: any) => m.month)).toEqual(['2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09']);
    // August: net revenue 4500 − 553 VAT = 3947; COGS 1350 → margin 6580 bp. September: 2539 bp.
    expect(months[4]).toMatchObject({ netRevenueMinor: 3947, grossProfitMinor: 2597, grossMarginBp: 6580 });
    expect(months[5].grossMarginBp).toBe(5796);
    expect(r.body.marginTrend).toMatchObject({ direction: 'declining', deltaBp: -784 });
    // Utilities 10000 (Aug 2–31) → 17200 net: +72 %; rent and ingredients had no base and rank after it.
    expect(r.body.fastestGrowingExpense).toMatchObject({ name: 'Utilities', previousMinor: 10000, currentMinor: 17200, growthBp: 7200 });
    expect(r.body.comparedPeriod).toEqual({ from: '2026-08-02', to: '2026-08-31' });
  });

  it('exports CSV files with a stored checksum and serves them byte for byte', async () => {
    const res = await t.http.post(`/v1/o/${tenant.orgId}/finance/exports`).set(auth(accountant)).send({ kind: 'sales', ...P });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.rowCount).toBe(4); // includes the cancelled order with its status
    expect(res.body.checksum).toBe(createHash('sha256').update(res.body.content).digest('hex'));
    const lines = res.body.content.trim().split('\r\n');
    expect(lines[0]).toBe('business_date,order_number,order_ref,branch,channel,fulfillment,status,payment_status,currency,subtotal,discount,delivery_fee,service_charge,vat,vat_inclusive,total,paid,refunded');
    expect(lines.some((l: string) => l.includes(',cancelled,'))).toBe(true);
    const dl = await t.http.get(`/v1/o/${tenant.orgId}/finance/exports/${res.body.id}/download`).set(auth(accountant)).buffer(true).parse((r, cb) => {
      let data = ''; r.on('data', (c: Buffer) => { data += c.toString(); }); r.on('end', () => cb(null, data));
    });
    expect(dl.status).toBe(200);
    expect(dl.headers['content-type']).toMatch(/text\/csv/);
    expect(dl.headers['x-content-sha256']).toBe(res.body.checksum);
    expect(createHash('sha256').update(dl.body as string).digest('hex')).toBe(res.body.checksum);
    const [row] = await sql(`select kind, row_count, checksum from financial_exports where id = $1`, [res.body.id]);
    expect(row).toEqual({ kind: 'sales', row_count: 4, checksum: res.body.checksum });

    const pnl = await t.http.post(`/v1/o/${tenant.orgId}/finance/exports`).set(auth(accountant)).send({ kind: 'pnl', ...P });
    expect(pnl.body.content).toContain('net_revenue,132.02,EGP');
    expect(pnl.body.content).toContain('operating_profit,-1096.98,EGP');
    expect(pnl.body.content).toContain('memo_inventory_purchases,43.00,EGP');
    expect(pnl.body.content).toContain('policy_cogs_method,item_cost');
    const tax = await t.http.post(`/v1/o/${tenant.orgId}/finance/exports`).set(auth(accountant)).send({ kind: 'tax', ...P });
    expect(tax.body.content).toContain('2026-09-10,output_vat,150.50,18.48');
    expect(tax.body.content).toContain('net_vat_payable,,-16.52');
    for (const kind of ['payments', 'expenses']) {
      const r = await t.http.post(`/v1/o/${tenant.orgId}/finance/exports`).set(auth(accountant)).send({ kind, ...P });
      expect(r.status).toBe(201);
    }
    expect((await t.http.get(`/v1/o/${tenant.orgId}/finance/exports`).set(auth(accountant))).body.items.length).toBe(5);
    expect((await t.http.post(`/v1/o/${tenant.orgId}/finance/exports`).set(auth(accountant)).send({ kind: 'sales', from: '2026-09-30', to: '2026-09-01' })).status).toBe(400);
  });

  it('builds balanced daily journals and records failed pushes honestly', async () => {
    const r = await t.http.get(`/v1/o/${tenant.orgId}/finance/accounting/journal?${q}`).set(auth(accountant));
    expect(r.status).toBe(200);
    // FT-23: sales (RSJ), expenses (RSE), cost of sales (RSC) and payment fees (RSF) journals, every one balanced.
    for (const e of r.body.entries) {
      expect(e.lines.reduce((s: number, l: any) => s + l.debitMinor, 0), e.reference).toBe(e.lines.reduce((s: number, l: any) => s + l.creditMinor, 0));
    }
    const sales = r.body.entries.filter((e: any) => e.reference.startsWith('RSJ-'));
    expect(sales).toHaveLength(1);
    const [entry] = sales;
    const sumD = entry.lines.reduce((s: number, l: any) => s + l.debitMinor, 0), sumC = entry.lines.reduce((s: number, l: any) => s + l.creditMinor, 0);
    expect(sumD).toBe(sumC);
    const byRole = (role: string, side: 'debitMinor' | 'creditMinor') => entry.lines.filter((l: any) => l.role === role).reduce((s: number, l: any) => s + l[side], 0);
    expect([byRole('cash', 'debitMinor'), byRole('card_clearing', 'debitMinor'), byRole('receivables', 'debitMinor')]).toEqual([9000, 5000, 4050]);
    expect([byRole('sales', 'creditMinor'), byRole('vat_output', 'creditMinor')]).toEqual([15834, 2216]);
    expect([byRole('refunds', 'debitMinor'), byRole('cash', 'creditMinor')]).toEqual([3000, 3000]);

    // An unmapped account is refused before anything leaves Resuto; the push is recorded as failed.
    const box = t.app.get(SecretBox);
    const [conn] = await sql(
      `insert into integration_connections(org_id, provider, category, auth_type, environment, status, credentials_encrypted, config)
       values ($1, 'wafeq', 'accounting', 'api_key', 'live', 'connected', $2, '{"accounts":{"cash":"A1"}}') returning id`,
      [tenant.orgId, box.sealJson({ apiKey: 'wk_test' })]);
    const push = await t.http.post(`/v1/o/${tenant.orgId}/finance/accounting/push`).set(auth(accountant)).send({ connectionId: conn.id, ...P, key: 'push-1-abcdef' });
    expect(push.status, JSON.stringify(push.body)).toBe(201);
    expect(push.body).toMatchObject({ provider: 'wafeq', status: 'failed' });
    expect(push.body.error).toMatch(/Map the "[a-z_]+" account/);
    const mapping = await t.http.get(`/v1/o/${tenant.orgId}/finance/accounting/connections/${conn.id}/accounts?${q}`).set(auth(accountant));
    expect(mapping.body.missing).toEqual(expect.arrayContaining(['card_clearing', 'sales', 'expenses_rent', 'cogs', 'inventory', 'payment_fees']));
    expect(mapping.body.missing).not.toContain('cash');
    const again = await t.http.post(`/v1/o/${tenant.orgId}/finance/accounting/push`).set(auth(accountant)).send({ connectionId: conn.id, ...P, key: 'push-1-abcdef' });
    expect(again.body.id).toBe(push.body.id);
  });
});

describe('accounting policy (DF-04) and journals beyond sales (FT-23)', () => {
  const F = (path: string) => `/v1/o/${tenant.orgId}/finance${path}`;

  it('switches COGS and fee sources by policy, never counting either twice, with audit', async () => {
    expect((await t.http.put(F('/policy')).set(auth(waiter)).send({ cogsMethod: 'purchases', feesMethod: 'expenses' })).status).toBe(403);
    expect((await t.http.put(F('/policy')).set(auth(accountant)).send({ cogsMethod: 'fifo', feesMethod: 'expenses' })).status).toBe(400);
    const saved = await t.http.put(F('/policy')).set(auth(accountant)).send({ cogsMethod: 'purchases', feesMethod: 'expenses' });
    expect(saved.status).toBe(200);
    try {
      const r = await t.http.get(F(`/pnl?${q}`)).set(auth(accountant));
      expect(r.body.lines).toMatchObject({
        cogsFromSalesMinor: 0, cogsExpensesMinor: 4300, cogsMinor: 4300, grossProfitMinor: 8902, paymentFeesMinor: 1000, operatingProfitMinor: -109298,
        memo: { inventoryPurchasesMinor: 0, itemCostOfSalesMinor: 5550, feeExpensesMinor: 0, providerReportedFeesMinor: 150 },
      });
      // Journals follow the same policy: purchases debit COGS, no cost-of-sales or provider-fee journals, fee expenses are journaled.
      const j = await t.http.get(F(`/accounting/journal?${q}`)).set(auth(accountant));
      const refs = j.body.entries.map((e: any) => e.reference.slice(0, 3));
      expect(refs).not.toContain('RSC');
      expect(refs).not.toContain('RSF');
      const roles = j.body.entries.flatMap((e: any) => e.lines.map((l: any) => l.role));
      expect(roles).toContain('cogs');
      expect(roles).not.toContain('inventory');
      const [audit] = await sql(`select metadata from audit_logs where org_id = $1 and action = 'finance.policy_saved'`, [tenant.orgId]);
      expect(audit.metadata).toMatchObject({ before: { cogsMethod: 'item_cost' }, after: { cogsMethod: 'purchases', feesMethod: 'expenses' } });
    } finally {
      await t.http.put(F('/policy')).set(auth(accountant)).send({ cogsMethod: 'item_cost', feesMethod: 'provider_reports' });
    }
  });

  it('journals expenses with input VAT and payables, cost of sales and provider fees, all balanced', async () => {
    const j = await t.http.get(F(`/accounting/journal?${q}`)).set(auth(accountant));
    const byRef = (prefix: string, date: string) => j.body.entries.find((e: any) => e.reference.startsWith(prefix) && e.date === date);
    const amount = (e: any, role: string, side: 'debitMinor' | 'creditMinor') => e.lines.filter((l: any) => l.role === role).reduce((s: number, l: any) => s + l[side], 0);
    const utilities = byRef('RSE-', '2026-09-15');
    expect([amount(utilities, 'expenses_utilities', 'debitMinor'), amount(utilities, 'vat_input', 'debitMinor'), amount(utilities, 'accounts_payable', 'creditMinor')]).toEqual([17200, 2800, 20000]);
    const ingredients = byRef('RSE-', '2026-09-05');
    expect(amount(ingredients, 'inventory', 'debitMinor')).toBe(4300); // item-cost policy: purchases go to inventory
    const cogs = byRef('RSC-', '2026-09-10');
    expect([amount(cogs, 'cogs', 'debitMinor'), amount(cogs, 'inventory', 'creditMinor')]).toEqual([5550, 5550]);
    const fees = byRef('RSF-', '2026-09-10');
    expect([amount(fees, 'payment_fees', 'debitMinor'), amount(fees, 'card_clearing', 'creditMinor')]).toEqual([150, 150]);
    // The "Payment fees" expense of 2026-09-30 duplicates the provider statement under this policy: no journal.
    expect(byRef('RSE-', '2026-09-30')).toBeUndefined();
  });

  it('records provider payouts and journals them against the clearing account', async () => {
    expect((await t.http.post(F('/payouts')).set(auth(waiter)).send({ provider: 'paymob', paidOn: '2026-09-12', amountMinor: 4850 })).status).toBe(403);
    expect((await t.http.post(F('/payouts')).set(auth(accountant)).send({ provider: 'paymob', paidOn: '2026-09-12', amountMinor: -1 })).status).toBe(400);
    const p = await t.http.post(F('/payouts')).set(auth(accountant)).send({ provider: 'paymob', paidOn: '2026-09-12', amountMinor: 4850, reference: 'STL-991' });
    expect(p.status).toBe(201);
    expect(p.body).toMatchObject({ provider: 'paymob', clearing: 'card', amountMinor: 4850, feeMinor: 0, currency: 'EGP', reference: 'STL-991' });
    const list = await t.http.get(F(`/payouts?${q}`)).set(auth(accountant));
    expect(list.body.items.map((x: any) => x.id)).toEqual([p.body.id]);
    const j = await t.http.get(F(`/accounting/journal?${q}`)).set(auth(accountant));
    const payout = j.body.entries.find((e: any) => e.reference.startsWith('RSP-'));
    expect(payout.lines).toEqual([
      expect.objectContaining({ role: 'bank', debitMinor: 4850, creditMinor: 0 }),
      expect.objectContaining({ role: 'card_clearing', debitMinor: 0, creditMinor: 4850 }),
    ]);
  });

  it('edits the account mapping per connection with validation and audit', async () => {
    const box = t.app.get(SecretBox);
    const [conn] = await sql(
      `insert into integration_connections(org_id, provider, category, auth_type, environment, status, credentials_encrypted, config)
       values ($1, 'qoyod', 'accounting', 'api_key', 'sandbox', 'connected', $2, '{"other":"kept"}') returning id`,
      [tenant.orgId, box.sealJson({ apiKey: 'qk_test' })]);
    const url = F(`/accounting/connections/${conn.id}/accounts`);
    expect((await t.http.put(url).set(auth(accountant)).send({ accounts: { sales: 'bad<script>' } })).status).toBe(400);
    expect((await t.http.put(url).set(auth(accountant)).send({ accounts: { made_up_role: '4000' } })).status).toBe(400);
    expect((await t.http.put(url).set(auth(waiter)).send({ accounts: { sales: '4000' } })).status).toBe(403);
    const ok = await t.http.put(url).set(auth(accountant)).send({ accounts: { sales: '4000', cash: '1000', vat_output: '2200', delivery_income: '4100' } });
    expect(ok.status).toBe(200);
    const [row] = await sql(`select config from integration_connections where id = $1`, [conn.id]);
    expect(row.config).toEqual({ other: 'kept', accounts: { sales: '4000', cash: '1000', vat_output: '2200', delivery_income: '4100' } });
    const got = await t.http.get(`${url}?${q}`).set(auth(accountant));
    expect(got.body.accounts.sales).toBe('4000');
    expect(got.body.missing).not.toContain('sales');
    expect(got.body.missing).toContain('card_clearing');
    expect((await sql(`select 1 from audit_logs where org_id = $1 and action = 'accounting.mapping_saved' and entity_id = $2`, [tenant.orgId, conn.id]))).toHaveLength(1);
  });

  it('separates delivery income (ex its VAT share) from food sales', async () => {
    const orders = t.app.get(OrdersKernelService);
    const o = await db.scoped(ctx, (tx) => orders.place(tx, ctx, {
      branchId: tenant.branchId, channel: 'staff', fulfillment: 'delivery', lines: [{ productId: menu.products.fries, quantity: 2 }],
      customer: { name: 'D', phone: '+201000000777' }, deliveryAddress: { line1: 'Nile St' } }));
    await sql(`update orders set business_date = '2026-09-20' where id = $1`, [o.id]);
    const j = await t.http.get(F(`/accounting/journal?${q}`)).set(auth(accountant));
    const e = j.body.entries.find((x: any) => x.reference.startsWith('RSJ-') && x.date === '2026-09-20');
    const credit = (role: string) => e.lines.filter((l: any) => l.role === role).reduce((s: number, l: any) => s + l.creditMinor, 0);
    const fee = o.quote.deliveryFeeMinor;
    expect(fee).toBeGreaterThan(0);
    const feeVat = Math.round((o.quote.taxMinor * fee) / o.totalMinor);
    expect(credit('delivery_income')).toBe(fee - feeVat);
    expect(credit('sales') + credit('delivery_income') + credit('vat_output')).toBe(o.totalMinor);
    await db.scoped(ctx, (tx) => orders.transition(tx, ctx, o.id, 'cancelled', { reason: 'test cleanup' }));
  });
});

describe('expenses', () => {
  it('creates, updates, attaches a receipt and deletes with audit', async () => {
    const cats = await t.http.get(`/v1/o/${tenant.orgId}/finance/expense-categories`).set(auth(accountant));
    const marketing = cats.body.items.find((c: any) => c.kind === 'marketing');
    const created = await t.http.post(`/v1/o/${tenant.orgId}/finance/expenses`).set(auth(accountant))
      .send({ categoryId: marketing.id, amountMinor: 11400, taxMinor: 1400, incurredOn: '2026-10-02', vendor: 'Print shop', description: '=HYPERLINK("x")' });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body).toMatchObject({ amountMinor: 11400, taxMinor: 1400, netMinor: 10000, categoryKind: 'marketing', receiptUrl: null });
    expect((await t.http.post(`/v1/o/${tenant.orgId}/finance/expenses`).set(auth(accountant)).send({ categoryId: marketing.id, amountMinor: 100, taxMinor: 200, incurredOn: '2026-10-02' })).status).toBe(400);
    const upd = await t.http.patch(`/v1/o/${tenant.orgId}/finance/expenses/${created.body.id}`).set(auth(accountant)).send({ amountMinor: 22800, taxMinor: 2800 });
    expect(upd.body.netMinor).toBe(20000);
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);
    const up = await t.http.post(`/v1/o/${tenant.orgId}/finance/expenses/${created.body.id}/receipt`).set(auth(accountant)).attach('file', png, { filename: 'r.png', contentType: 'image/png' });
    expect(up.status, JSON.stringify(up.body)).toBe(201);
    expect(up.body.receiptUrl).toMatch(/^http:\/\/api\.test\/v1\/media\//);
    const fake = await t.http.post(`/v1/o/${tenant.orgId}/finance/expenses/${created.body.id}/receipt`).set(auth(accountant)).attach('file', Buffer.from('not an image'), { filename: 'r.png', contentType: 'image/png' });
    expect(fake.status).toBe(422);
    const csv = await t.http.post(`/v1/o/${tenant.orgId}/finance/exports`).set(auth(accountant)).send({ kind: 'expenses', from: '2026-10-01', to: '2026-10-31' });
    expect(csv.body.content).toContain(`"'=HYPERLINK(""x"")"`); // formula injection neutralised
    const list = await t.http.get(`/v1/o/${tenant.orgId}/finance/expenses?from=2026-10-01&to=2026-10-31`).set(auth(accountant));
    expect(list.body.totals).toEqual({ count: 1, amountMinor: 22800, taxMinor: 2800, netMinor: 20000 });
    expect((await t.http.delete(`/v1/o/${tenant.orgId}/finance/expenses/${created.body.id}`).set(auth(tenant.owner))).status).toBe(200);
    const audit = await sql(`select action from audit_logs where entity_id = $1 order by id`, [created.body.id]);
    expect(audit.map((a) => a.action)).toEqual(['expense.created', 'expense.updated', 'expense.receipt_attached', 'expense.deleted']);
  });

  it('enforces permissions, tenancy and the finance entitlement', async () => {
    const url = `/v1/o/${tenant.orgId}/finance`;
    expect((await t.http.get(`${url}/pnl?${q}`).set(auth(waiter))).status).toBe(403);
    const cats = await t.http.get(`${url}/expense-categories`).set(auth(accountant));
    const exp = await t.http.post(`${url}/expenses`).set(auth(accountant)).send({ categoryId: cats.body.items[0].id, amountMinor: 500, incurredOn: '2026-10-03' });
    const other = await createTenant(t);
    expect((await t.http.get(`${url}/expenses/${exp.body.id}`).set(auth(other.owner))).status).toBe(404);
    expect((await t.http.get(`/v1/o/${other.orgId}/finance/expenses/${exp.body.id}`).set(auth(other.owner))).status).toBe(404);
    expect((await t.http.post(`/v1/o/${other.orgId}/finance/expenses`).set(auth(other.owner)).send({ categoryId: cats.body.items[0].id, amountMinor: 500, incurredOn: '2026-10-03' })).status).toBe(404);
    const free = await createTenant(t, { planId: 'free' });
    const denied = await t.http.get(`/v1/o/${free.orgId}/finance/overview?${q}`).set(auth(free.owner));
    expect(denied.status).toBe(402);
    expect(denied.body.error).toMatchObject({ code: 'module_not_entitled', details: { module: 'finance' } });
    expect((await t.http.get(`${url}/overview?from=2026-01-01&to=2027-06-01`).set(auth(accountant))).status).toBe(400);
  });
});
