// S06 — Finance: a day of trading (cash, simulated card through a payment link and a
// web checkout, a provider refund, an unpaid and a cancelled order) → fiscal documents
// under a validated EG tax profile → reconciliation against the simulated provider
// (all matched, then a settlement statement with an extra provider transaction) →
// expenses → P&L checked against numbers computed independently here → CSV export
// with checksum. HTTP only; SQL reads state.
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EventDispatcher } from '../../src/common/events/dispatcher.service';
import { addMember, auth, bootTestApp, createTenant, sql, type TestApp, type TestTenant, type TestUser } from '../helpers';
import { buildMenuViaApi, burgerLine, cairoToday, COSTS, key, payViaSandbox, PRICES, tokenFromUrl, type ApiMenu } from './support';

const EG_PROFILE = {
  vatNumber: '123456789', registeredName: 'Koshary Corner SAE',
  registeredAddress: { governate: 'Cairo', regionCity: 'Downtown', street: 'Talaat Harb', buildingNumber: '12' },
  etaActivityCode: '5610', etaBranchCode: '0', etaPosSerial: 'POS-001', etaEnvironment: 'preprod',
};
const VAT_BP = 1400;
const vatOf = (gross: number) => Math.round((gross * VAT_BP) / (10_000 + VAT_BP)); // VAT inside a VAT-inclusive EG price

let t: TestApp;
let tenant: TestTenant;
let menu: ApiMenu;
let cashier: TestUser;
let accountant: TestUser;
let today: string;
const o: Record<'cash' | 'card' | 'web' | 'unpaid' | 'cancelled', { id: string; totalMinor: number }> = {} as any;
let cardPayment: { id: string; providerPaymentId: string };
let webPayment: { id: string; providerPaymentId: string };
const REFUND = 5000;

const P = () => `from=${today}&to=${today}`;
const staffOrder = async (lines: unknown[]) => {
  const res = await t.http.post(`/v1/o/${tenant.orgId}/orders`).set(auth(cashier)).set('Idempotency-Key', key('fin'))
    .send({ branchId: tenant.branchId, fulfillment: 'pickup', lines, customer: { name: 'Walk-in' } });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return { id: res.body.id as string, totalMinor: res.body.totalMinor as number };
};
const succeededPayment = async (orderId: string) => {
  const detail = await t.http.get(`/v1/o/${tenant.orgId}/orders/${orderId}`).set(auth(tenant.owner));
  const p = detail.body.payments.find((x: any) => x.status === 'succeeded' || x.status === 'partially_refunded');
  const [row] = await sql(`select provider_payment_id from payments where id = $1`, [p.id]);
  return { id: p.id as string, providerPaymentId: row.provider_payment_id as string };
};

beforeAll(async () => {
  t = await bootTestApp();
  tenant = await createTenant(t, { country: 'EG' });
  menu = await buildMenuViaApi(t, tenant);
  cashier = await addMember(t, tenant, 'cashier');
  accountant = await addMember(t, tenant, 'accountant');
  today = await cairoToday();
});
afterAll(async () => { await t.close(); });

describe('S06 finance: trading day → fiscal documents → reconciliation → P&L → export', () => {
  it('1. the accountant validates the Egyptian tax profile before trading', async () => {
    const res = await t.http.put(`/v1/o/${tenant.orgId}/compliance/tax-profile`).set(auth(accountant)).send(EG_PROFILE);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ isValidated: true, regime: 'eta', vatRateBp: VAT_BP });
  });

  it('2. trades: cash, card via payment link, card via web checkout, one unpaid and one cancelled order', async () => {
    // Cash at the counter.
    o.cash = await staffOrder([{ productId: menu.fries, quantity: 2 }]);
    const cash = await t.http.post(`/v1/o/${tenant.orgId}/payments/collect`).set(auth(cashier))
      .send({ orderId: o.cash.id, method: 'cash', amountMinor: o.cash.totalMinor, key: key('cash') });
    expect(cash.status, JSON.stringify(cash.body)).toBe(201);
    // Card through a staff payment link paid on the simulated provider.
    o.card = await staffOrder([burgerLine(menu), { productId: menu.soda, quantity: 1 }]);
    const link = await t.http.post(`/v1/o/${tenant.orgId}/payments/links`).set(auth(tenant.owner))
      .send({ orderId: o.card.id, amountMinor: o.card.totalMinor, allowedMethods: ['card'], key: key('link') });
    expect(link.status, JSON.stringify(link.body)).toBe(201);
    await payViaSandbox(t, tokenFromUrl(link.body.url, '/pay/'));
    // Web order paid online (awaiting_payment until the verified webhook).
    const web = await t.http.post(`/v1/public/order/${tenant.slug}/orders`).set('Idempotency-Key', key('web')).send({
      branchId: tenant.branchId, fulfillment: 'pickup', payment: 'online', lines: [{ productId: menu.soda, quantity: 2 }],
      customer: { name: 'Nour', phone: '+201005556667' }, expectedTotalMinor: PRICES.soda * 2,
    });
    expect(web.status, JSON.stringify(web.body)).toBe(201);
    expect(web.body.order.status).toBe('awaiting_payment');
    o.web = { id: web.body.order.id, totalMinor: web.body.order.totalMinor };
    await payViaSandbox(t, tokenFromUrl(web.body.checkout.url, '/pay/'));
    // Unpaid and cancelled.
    o.unpaid = await staffOrder([{ productId: menu.fries, quantity: 1 }]);
    o.cancelled = await staffOrder([{ productId: menu.soda, quantity: 1 }]);
    const cancel = await t.http.post(`/v1/o/${tenant.orgId}/orders/${o.cancelled.id}/cancel`).set(auth(tenant.owner)).send({ reason: 'Customer left', version: 0 });
    expect(cancel.status, JSON.stringify(cancel.body)).toBe(201);

    expect([o.cash, o.card, o.web, o.unpaid].map((x) => x.totalMinor)).toEqual([
      PRICES.fries * 2, PRICES.burger + PRICES.soda, PRICES.soda * 2, PRICES.fries,
    ]);
    const states = await sql(`select id, status, payment_status from orders where org_id = $1`, [tenant.orgId]);
    const s = Object.fromEntries(states.map((r) => [r.id, `${r.status}/${r.payment_status}`]));
    expect([s[o.cash.id], s[o.card.id], s[o.web.id], s[o.unpaid.id], s[o.cancelled.id]])
      .toEqual(['placed/paid', 'placed/paid', 'placed/paid', 'placed/unpaid', 'cancelled/unpaid']);
    cardPayment = await succeededPayment(o.card.id);
    webPayment = await succeededPayment(o.web.id);
  });

  it('3. refunds part of the card payment through the provider', async () => {
    const refund = await t.http.post(`/v1/o/${tenant.orgId}/payments/${cardPayment.id}/refunds`).set(auth(tenant.owner))
      .send({ amountMinor: REFUND, reason: 'Burger was cold', key: key('refund') });
    expect(refund.status, JSON.stringify(refund.body)).toBe(201);
    expect(refund.body).toMatchObject({ status: 'succeeded', amountMinor: REFUND, provider: 'simulated' });
    const detail = await t.http.get(`/v1/o/${tenant.orgId}/payments/${cardPayment.id}`).set(auth(accountant));
    expect(detail.body).toMatchObject({ status: 'partially_refunded', refundableMinor: o.card.totalMinor - REFUND });
  });

  it('4. fiscal documents are issued for paid orders only, with a credit note for the refund', async () => {
    const dispatcher = t.app.get(EventDispatcher);
    await dispatcher.drain();
    await dispatcher.drain();
    const docs = async (orderId: string) => (await t.http.get(`/v1/o/${tenant.orgId}/compliance/fiscal-documents?orderId=${orderId}`).set(auth(accountant))).body.items;
    for (const paid of [o.cash, o.card, o.web]) {
      const items = await docs(paid.id);
      const receipt = items.find((d: any) => d.kind === 'receipt');
      expect(receipt, `fiscal receipt for ${paid.id}`).toMatchObject({ authority: 'eta', currency: 'EGP', totalMinor: paid.totalMinor, taxMinor: vatOf(paid.totalMinor), status: 'issued' });
    }
    expect(await docs(o.unpaid.id)).toEqual([]);
    expect(await docs(o.cancelled.id)).toEqual([]);
    const credit = (await docs(o.card.id)).filter((d: any) => d.kind === 'credit_note');
    expect(credit).toHaveLength(1);
    expect(credit[0].totalMinor).toBe(REFUND);
    const verify = await t.http.get(`/v1/o/${tenant.orgId}/compliance/fiscal-documents/verify?branchId=${tenant.branchId}`).set(auth(accountant));
    expect(verify.body.ok).toBe(true);
  });

  it('5. reconciles against the simulated provider: both card payments match', async () => {
    const from = new Date(Date.now() - 3600_000).toISOString(), to = new Date(Date.now() + 3600_000).toISOString();
    const run = await t.http.post(`/v1/o/${tenant.orgId}/payments/reconciliation/runs`).set(auth(accountant)).send({ provider: 'simulated', from, to, source: 'provider_api' });
    expect(run.status, JSON.stringify(run.body)).toBe(201);
    expect(run.body).toMatchObject({ source: 'sandbox', totals: { items: 2, matched: 2, missingInResuto: 0, missingInProvider: 0, differenceMinor: 0 } });
    expect(run.body.totals.expectedMinor).toBe(o.card.totalMinor + o.web.totalMinor);
  });

  it('6. a settlement statement with an extra provider transaction is flagged, not absorbed', async () => {
    const from = new Date(Date.now() - 3600_000).toISOString(), to = new Date(Date.now() + 3600_000).toISOString();
    const money = (m: number) => (m / 100).toFixed(2);
    const csv = [
      'transaction_id,amount,currency,status,fee,refunded',
      `${cardPayment.providerPaymentId},${money(o.card.totalMinor)},EGP,partially_refunded,0.00,${money(REFUND)}`,
      `${webPayment.providerPaymentId},${money(o.web.totalMinor)},EGP,succeeded,0.00,0.00`,
      'sim_pay_not_ours_0001,77.00,EGP,succeeded,0.00,0.00',
    ].join('\n');
    const run = await t.http.post(`/v1/o/${tenant.orgId}/payments/reconciliation/runs`).set(auth(accountant)).send({ provider: 'simulated', from, to, source: 'statement_upload', csv });
    expect(run.status, JSON.stringify(run.body)).toBe(201);
    expect(run.body.totals).toMatchObject({ items: 3, matched: 2, missingInResuto: 1, amountMismatch: 0, missingInProvider: 0, differenceMinor: 7700 });
    const detail = await t.http.get(`/v1/o/${tenant.orgId}/payments/reconciliation/runs/${run.body.id}`).set(auth(accountant));
    const extra = detail.body.items.find((i: any) => i.status === 'missing_in_resuto');
    expect(extra).toMatchObject({ providerTxnId: 'sim_pay_not_ours_0001', actualMinor: 7700, paymentId: null, resolution: 'open' });
    // Nothing was booked for the unknown transaction.
    expect((await sql(`select count(*)::int as n from payments where provider_payment_id = 'sim_pay_not_ours_0001'`))[0].n).toBe(0);
  });

  it('7. records the day’s expenses', async () => {
    const cats = (await t.http.get(`/v1/o/${tenant.orgId}/finance/expense-categories`).set(auth(accountant))).body.items;
    const byKind = (kind: string) => cats.find((c: any) => c.kind === kind).id;
    const add = async (kind: string, amountMinor: number, taxMinor: number, vendor: string) => {
      const res = await t.http.post(`/v1/o/${tenant.orgId}/finance/expenses`).set(auth(accountant))
        .send({ categoryId: byKind(kind), amountMinor, taxMinor, incurredOn: today, vendor });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      expect(res.body.netMinor).toBe(amountMinor - taxMinor);
    };
    await add('rent', 100000, 0, 'Landlord');
    await add('utilities', 11400, 1400, 'Electricity');
    await add('cogs', 5700, 700, 'Vegetable market');
    await add('fees', 1000, 0, 'POS terminal rental');
    const list = await t.http.get(`/v1/o/${tenant.orgId}/finance/expenses?${P()}`).set(auth(accountant));
    expect(list.body.totals).toEqual({ count: 4, amountMinor: 118100, taxMinor: 2100, netMinor: 116000 });
  });

  it('8. the revenue overview and P&L equal the independently computed figures', async () => {
    // Independent computation from what happened above (VAT-inclusive 14 %, pickup → no service charge).
    const counted = [o.cash, o.card, o.web, o.unpaid]; // cancelled is excluded
    const gross = counted.reduce((s, x) => s + x.totalMinor, 0);
    const refundVat = Math.round((vatOf(o.card.totalMinor) * REFUND) / o.card.totalMinor);
    const vat = counted.reduce((s, x) => s + vatOf(x.totalMinor), 0) - refundVat;
    const net = gross - REFUND;
    const netExVat = net - vat;
    const collected = o.cash.totalMinor + (o.card.totalMinor - REFUND) + o.web.totalMinor;
    const cogsSales = 2 * COSTS.fries + (COSTS.burger + COSTS.soda) + 2 * COSTS.soda + COSTS.fries;
    // DF-04 default policy: COGS = item costs of sales; the ingredient purchase (5700 incl. 700 VAT) is an inventory
    // purchase memo, and the "fees" expense (1000) is a memo next to the provider-reported fees (no double count).
    const purchases = 5700 - 700;
    const grossProfit = netExVat - cogsSales;
    const opex = 100000 + (11400 - 1400);
    const [{ fees: providerFees }] = await sql(`select coalesce(sum(fee_minor), 0)::int as fees from payments where org_id = $1 and status in ('succeeded', 'partially_refunded', 'refunded')`, [tenant.orgId]);
    const paymentFees = providerFees;
    const operatingProfit = grossProfit - opex - paymentFees;

    const ov = await t.http.get(`/v1/o/${tenant.orgId}/finance/overview?${P()}`).set(auth(accountant));
    expect(ov.status, JSON.stringify(ov.body)).toBe(200);
    expect(ov.body.totals).toEqual({ orderCount: 4, grossMinor: gross, discountsMinor: 0, refundsMinor: REFUND, netMinor: net, vatMinor: vat, netExVatMinor: netExVat, collectedMinor: collected });
    expect(ov.body.warnings).toContain('1 order(s) in this period are not fully paid; revenue counts them, collected amounts do not.');

    const pnl = await t.http.get(`/v1/o/${tenant.orgId}/finance/pnl?${P()}`).set(auth(accountant));
    expect(pnl.status).toBe(200);
    expect(pnl.body.lines).toEqual({
      grossSalesMinor: gross, discountsMinor: 0, refundsMinor: REFUND, vatMinor: vat, netRevenueMinor: netExVat,
      cogsFromSalesMinor: cogsSales, cogsExpensesMinor: 0, cogsMinor: cogsSales, grossProfitMinor: grossProfit,
      operatingExpensesMinor: opex, operatingExpensesByKind: { rent: 100000, utilities: 10000 },
      paymentFeesMinor: paymentFees, operatingProfitMinor: operatingProfit,
      memo: { inventoryPurchasesMinor: purchases, itemCostOfSalesMinor: 0, feeExpensesMinor: 1000, providerReportedFeesMinor: 0 },
    });
    expect(pnl.body.grossMarginBp).toBe(Math.round((grossProfit * 10_000) / netExVat));
    expect(pnl.body.coverage).toMatchObject({ linesWithoutCost: 0, unpaidOrders: 1, testPayments: 2 });
  });

  it('9. exports the sales CSV with a stored checksum, served byte for byte', async () => {
    const res = await t.http.post(`/v1/o/${tenant.orgId}/finance/exports`).set(auth(accountant)).send({ kind: 'sales', from: today, to: today });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.rowCount).toBe(5); // the cancelled order is listed with its status
    expect(res.body.checksum).toBe(createHash('sha256').update(res.body.content).digest('hex'));
    const rows = res.body.content.trim().split('\r\n');
    expect(rows[0]).toContain('business_date,order_number');
    expect(rows.filter((l: string) => l.includes(',cancelled,'))).toHaveLength(1);
    const dl = await t.http.get(`/v1/o/${tenant.orgId}/finance/exports/${res.body.id}/download`).set(auth(accountant)).buffer(true)
      .parse((r, cb) => { let data = ''; r.on('data', (c: Buffer) => { data += c.toString(); }); r.on('end', () => cb(null, data)); });
    expect(dl.status).toBe(200);
    expect(dl.headers['x-content-sha256']).toBe(res.body.checksum);
    expect(createHash('sha256').update(dl.body as string).digest('hex')).toBe(res.body.checksum);
    const pnl = await t.http.post(`/v1/o/${tenant.orgId}/finance/exports`).set(auth(accountant)).send({ kind: 'pnl', from: today, to: today });
    expect(pnl.body.checksum).toBe(createHash('sha256').update(pnl.body.content).digest('hex'));
  });
});
