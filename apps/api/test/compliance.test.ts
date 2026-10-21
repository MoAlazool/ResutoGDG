import { decodeZatcaQr } from '@resuto/integrations';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TenantContext } from '../src/common/auth/context';
import { DbService } from '../src/common/db/db.service';
import { EventDispatcher } from '../src/common/events/dispatcher.service';
import { FiscalService } from '../src/modules/compliance/fiscal.service';
import { OrdersKernelService } from '../src/modules/kernel/orders-kernel.service';
import { PaymentLedgerService } from '../src/modules/kernel/payment-ledger.service';
import { addMember, auth, bootTestApp, createTenant, seedMenu, sql, type SeededMenu, type TestApp, type TestTenant, type TestUser } from './helpers';

let t: TestApp;
let db: DbService;
let orders: OrdersKernelService;
let ledger: PaymentLedgerService;
let fiscal: FiscalService;
let dispatcher: EventDispatcher;
let sa: TestTenant;
let eg: TestTenant;
let saMenu: SeededMenu;
let egMenu: SeededMenu;
let accountant: TestUser;
let waiter: TestUser;

const SA_PROFILE = {
  vatNumber: '310122393500003', registeredName: 'Resuto Riyadh LLC',
  registeredAddress: { street: 'King Fahd Rd', buildingNumber: '1234', district: 'Olaya', city: 'Riyadh', postalCode: '12345' },
  zatcaEnvironment: 'sandbox', zatcaEgsSerial: '1-Resuto|2-Web|3-0001',
};
const EG_PROFILE = {
  vatNumber: '123456789', registeredName: 'Resuto Cairo SAE',
  registeredAddress: { governate: 'Cairo', regionCity: 'Nasr City', street: 'Abbas El Akkad', buildingNumber: '10' },
  etaActivityCode: '5610', etaBranchCode: '0', etaPosSerial: 'POS-001', etaEnvironment: 'preprod',
};

const ctxOf = (tt: TestTenant) => new TenantContext(tt.orgId, 'owner', null, tt.owner.userId, 'user', tt.owner.userId);
const C = (tt: TestTenant, path: string) => `/v1/o/${tt.orgId}/compliance${path}`;

async function paidOrder(tt: TestTenant, m: SeededMenu, opts: { discount?: boolean } = {}) {
  const ctx = ctxOf(tt);
  if (opts.discount) await sql(`insert into promotions(org_id, code, name, kind, value) values ($1, 'TEN', 'Ten', 'percent', 1000) on conflict do nothing`, [tt.orgId]);
  const o = await db.scoped(ctx, (tx) => orders.place(tx, ctx, {
    branchId: tt.branchId, channel: 'staff', fulfillment: 'delivery', customer: { name: 'Noura', phone: '+966500000001' },
    deliveryAddress: { line1: 'Olaya St' }, promotionCode: opts.discount ? 'TEN' : null,
    lines: [{ productId: m.products.fries, quantity: 3 }, { productId: m.products.soda, quantity: 1 }],
  }));
  const currency = (await sql(`select currency from organizations where id = $1`, [tt.orgId]))[0].currency;
  const payment = await db.scoped(ctx, (tx) => ledger.recordSucceeded(tx, ctx, {
    branchId: tt.branchId, orderId: o.id, method: 'cash', provider: 'manual', amountMinor: o.totalMinor, currency,
  }));
  return { order: o, paymentId: payment.id };
}

beforeAll(async () => {
  t = await bootTestApp();
  db = t.app.get(DbService);
  orders = t.app.get(OrdersKernelService);
  ledger = t.app.get(PaymentLedgerService);
  fiscal = t.app.get(FiscalService);
  dispatcher = t.app.get(EventDispatcher);
  sa = await createTenant(t, { country: 'SA', name: 'Riyadh Grill' });
  eg = await createTenant(t, { country: 'EG', name: 'Cairo Kitchen' });
  saMenu = await seedMenu(sa);
  egMenu = await seedMenu(eg);
  accountant = await addMember(t, sa, 'accountant');
  waiter = await addMember(t, sa, 'waiter');
  await sql(`update outbox_events set published_at = now() where published_at is null`);
});
afterAll(async () => { await t.close(); });

describe('tax profile validation', () => {
  it('applies the Saudi rules', async () => {
    const initial = await t.http.get(C(sa, '/tax-profile')).set(auth(sa.owner));
    expect(initial.body).toMatchObject({ country: 'SA', regime: 'zatca', vatRateBp: 1500, isValidated: false });
    const bad = await t.http.put(C(sa, '/tax-profile')).set(auth(sa.owner)).send({
      vatNumber: '310122393500004', registeredName: 'X', registeredAddress: { street: 'a', buildingNumber: '12', district: 'd', city: 'c', postalCode: '123' },
      zatcaEnvironment: 'sandbox', zatcaEgsSerial: 'serial-only',
    });
    expect(bad.status).toBe(200);
    expect(bad.body.isValidated).toBe(false);
    const codes = bad.body.validationErrors.map((e: any) => `${e.field}:${e.code}`);
    expect(codes).toEqual(expect.arrayContaining([
      'vatNumber:vat_number_format', 'registeredAddress.buildingNumber:building_number_format',
      'registeredAddress.postalCode:postal_code_format', 'zatcaEgsSerial:egs_serial_format',
    ]));
    const wrongRegime = await t.http.put(C(sa, '/tax-profile')).set(auth(sa.owner)).send({ regime: 'eta' });
    expect(wrongRegime.body.validationErrors[0].code).toBe('regime_country_mismatch');
    const ok = await t.http.put(C(sa, '/tax-profile')).set(auth(accountant)).send({ ...SA_PROFILE, regime: 'zatca' });
    expect(ok.body).toMatchObject({ isValidated: true, vatNumber: '310122393500003' });
    expect(ok.body.validationErrors.filter((e: any) => e.severity === 'error')).toEqual([]);
    expect(ok.body.validatedAt).not.toBeNull();
    const invalidBody = await t.http.put(C(sa, '/tax-profile')).set(auth(sa.owner)).send({ vatRateBp: 20000 });
    expect(invalidBody.status).toBe(400);
  });

  it('applies the Egyptian rules', async () => {
    const bad = await t.http.put(C(eg, '/tax-profile')).set(auth(eg.owner)).send({ vatNumber: '12345', etaActivityCode: '56', etaBranchCode: 'main', etaPosSerial: 'pos 1' });
    const codes = bad.body.validationErrors.map((e: any) => e.code);
    expect(codes).toEqual(expect.arrayContaining(['tax_registration_number_format', 'activity_code_format', 'branch_code_format', 'pos_serial_format', 'required']));
    expect(bad.body.validationErrors.find((e: any) => e.field === 'registeredAddress.governate')).toBeTruthy();
    const ok = await t.http.put(C(eg, '/tax-profile')).set(auth(eg.owner)).send(EG_PROFILE);
    expect(ok.body).toMatchObject({ isValidated: true, regime: 'eta', vatRateBp: 1400 });
  });
});

describe('fiscal documents', () => {
  it('issues a ZATCA simplified invoice on order.paid with a Phase-1 QR and reconciled totals', async () => {
    const { order } = await paidOrder(sa, saMenu, { discount: true });
    await dispatcher.drain();
    const list = await t.http.get(C(sa, `/fiscal-documents?orderId=${order.id}`)).set(auth(accountant));
    expect(list.body.items).toHaveLength(1);
    const doc = list.body.items[0];
    expect(doc).toMatchObject({ kind: 'simplified_invoice', authority: 'zatca', currency: 'SAR', totalMinor: order.totalMinor, taxMinor: order.quote.taxMinor, status: 'issued' });
    expect(doc.subtotalMinor + doc.taxMinor).toBe(doc.totalMinor);
    const lines = doc.lines as any[];
    expect(lines.reduce((s, l) => s + l.grossMinor, 0)).toBe(order.totalMinor);
    expect(lines.reduce((s, l) => s + l.vatMinor, 0)).toBe(order.quote.taxMinor);
    expect(lines.reduce((s, l) => s + l.discountMinor, 0)).toBe(order.quote.discountMinor);
    expect(lines.map((l) => l.kind)).toContain('delivery_fee');
    const qr = decodeZatcaQr(doc.qrPayload);
    expect(qr[1]).toBe('Resuto Riyadh LLC');
    expect(qr[2]).toBe('310122393500003');
    expect(qr[3]).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    expect(qr[4]).toBe((order.totalMinor / 100).toFixed(2));
    expect(qr[5]).toBe((order.quote.taxMinor / 100).toFixed(2));
    expect(doc.lastSubmission).toMatchObject({ mode: 'sandbox_stub', status: 'submitted' });

    const detail = await t.http.get(C(sa, `/fiscal-documents/${doc.id}`)).set(auth(accountant));
    expect(detail.body).toMatchObject({ hashVerified: true, readiness: 'implemented_unverified' });
    const payload = await t.http.get(C(sa, `/fiscal-documents/${doc.id}/payload`)).set(auth(accountant));
    expect(payload.body).toMatchObject({ format: 'xml', matchesIssued: true });
    expect(payload.body.payload).toContain('<cbc:InvoiceTypeCode name="0200000">388</cbc:InvoiceTypeCode>');
    const print = await t.http.get(C(sa, `/fiscal-documents/${doc.id}/print`)).set(auth(accountant));
    expect(print.body).toMatchObject({ title: { en: 'Simplified Tax Invoice', ar: 'فاتورة ضريبية مبسطة' }, qr: { kind: 'zatca_tlv_base64' } });
    const subs = await t.http.get(C(sa, `/fiscal-documents/${doc.id}/submissions`)).set(auth(accountant));
    expect(subs.body.items[0].response).toMatchObject({ stub: true, network: false });
    const again = await t.http.post(C(sa, `/fiscal-documents/${doc.id}/resubmit`)).set(auth(accountant));
    expect(again.body).toMatchObject({ attempt: 2, mode: 'sandbox_stub' });

    // re-delivery of the event and manual issue are idempotent
    await sql(`update outbox_events set published_at = null, available_at = now() where event_type = 'order.paid' and aggregate_id = $1`, [order.id]);
    await sql(`delete from event_handlings where handler = 'compliance.issue_fiscal_document' and event_id in (select id from outbox_events where aggregate_id = $1)`, [order.id]);
    await dispatcher.drain();
    const manual = await t.http.post(C(sa, '/fiscal-documents/issue')).set(auth(accountant)).send({ orderId: order.id });
    expect(manual.body).toMatchObject({ id: doc.id, created: false });
    expect((await sql(`select count(*)::int as n from fiscal_documents where order_id = $1`, [order.id]))[0].n).toBe(1);
  });

  it('issues ETA e-receipts with chained UUIDs and refuses incomplete profiles', async () => {
    const other = await createTenant(t, { country: 'EG' });
    const otherMenu = await seedMenu(other);
    const { order: unissued } = await paidOrder(other, otherMenu);
    await dispatcher.drain();
    expect((await sql(`select count(*)::int as n from fiscal_documents where order_id = $1`, [unissued.id]))[0].n).toBe(0);
    const refused = await t.http.post(C(other, '/fiscal-documents/issue')).set(auth(other.owner)).send({ orderId: unissued.id });
    expect(refused.status).toBe(422);
    expect(refused.body.error.code).toBe('tax_profile_incomplete');
    const summary = await t.http.get(C(other, '/summary')).set(auth(other.owner));
    expect(summary.body.fiscal.paidOrdersWithoutDocument30d).toBe(1);

    const a = await paidOrder(eg, egMenu);
    const b = await paidOrder(eg, egMenu);
    await dispatcher.drain();
    // Event handling order within a batch is not guaranteed, so order the pair by counter.
    const [r1, r2] = await sql(`select * from fiscal_documents where order_id = any($1) order by counter_value`, [[a.order.id, b.order.id]]);
    expect(r1).toMatchObject({ kind: 'receipt', authority: 'eta', number: 'R-000001', counter_value: 1 });
    expect(r2).toMatchObject({ number: 'R-000002', counter_value: 2 });
    expect(r1.authority_ref).toMatch(/^[0-9a-f]{64}$/);
    expect(r1.qr_payload).toBe(`https://preprod.invoicing.eta.gov.eg/receipts/search/${r1.authority_ref}/share/${new Date(r1.issued_at).toISOString().replace('.000Z', 'Z')}#Total:${r1.total_minor / 100},IssuerRIN:123456789`);
    expect(r2.previous_authority_ref).toBe(r1.authority_ref);
    expect(r2.previous_hash).toBe(r1.document_hash);
    const payload = await t.http.get(C(eg, `/fiscal-documents/${r2.id}/payload`)).set(auth(eg.owner));
    expect(payload.body.matchesIssued).toBe(true);
    expect(JSON.parse(payload.body.payload).header.previousUUID).toBe(r1.authority_ref);
  });

  it('keeps counters unique and the hash chain continuous under concurrency', async () => {
    const paid = [];
    for (let i = 0; i < 8; i++) paid.push(await paidOrder(sa, saMenu));
    const ctx = ctxOf(sa);
    const results = await Promise.all(paid.map((p) => db.scoped(ctx, (tx) => fiscal.issueForOrder(tx, ctx, p.order.id))));
    expect(results.every((r) => 'created' in r && r.created)).toBe(true);
    const rows = await sql(`select counter_value, number, previous_hash, document_hash from fiscal_documents where branch_id = $1 order by counter_value`, [sa.branchId]);
    const counters = rows.map((r) => Number(r.counter_value));
    expect(new Set(counters).size).toBe(counters.length);
    expect(counters).toEqual(counters.map((_, i) => i + 1));
    rows.forEach((r, i) => expect(r.previous_hash).toBe(i === 0 ? null : rows[i - 1].document_hash));
    const verify = await t.http.get(C(sa, `/fiscal-documents/verify?branchId=${sa.branchId}`)).set(auth(accountant));
    expect(verify.body.ok).toBe(true);
    expect(verify.body.series[0]).toMatchObject({ count: rows.length, lastCounter: rows.length, firstBreak: null });
    await dispatcher.drain(); // late order.paid events find their documents: no duplicates
    expect((await sql(`select count(*)::int as n from fiscal_documents where branch_id = $1`, [sa.branchId]))[0].n).toBe(rows.length);
  });

  it('makes issued documents immutable except for status', async () => {
    const [doc] = await sql(`select id from fiscal_documents where branch_id = $1 order by counter_value limit 1`, [sa.branchId]);
    await expect(sql(`update fiscal_documents set total_minor = total_minor + 1 where id = $1`, [doc.id])).rejects.toThrow(/immutable/);
    await expect(sql(`update fiscal_documents set seller = '{}' where id = $1`, [doc.id])).rejects.toThrow(/immutable/);
    await expect(sql(`delete from fiscal_documents where id = $1`, [doc.id])).rejects.toThrow(/cannot be deleted/);
    await sql(`update fiscal_documents set status = 'issued' where id = $1`, [doc.id]);
    // tampering detection: verification recomputes content hashes
    const verify = await t.http.get(C(sa, `/fiscal-documents/verify?branchId=${sa.branchId}`)).set(auth(accountant));
    expect(verify.body.ok).toBe(true);
  });

  it('issues credit notes for refunds, never beyond the invoice', async () => {
    const { order, paymentId } = await paidOrder(sa, saMenu);
    await dispatcher.drain();
    const ctx = ctxOf(sa);
    await db.scoped(ctx, (tx) => ledger.applyRefund(tx, ctx, paymentId, 1000));
    await dispatcher.drain();
    let notes = await sql(`select * from fiscal_documents where order_id = $1 and kind = 'credit_note' order by counter_value`, [order.id]);
    const [invoice] = await sql(`select * from fiscal_documents where order_id = $1 and kind = 'simplified_invoice'`, [order.id]);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ total_minor: 1000, references_document_id: invoice.id, payment_id: paymentId, number: expect.stringMatching(/^CN-/) });
    expect(notes[0].tax_minor).toBe(Math.round((invoice.tax_minor * 1000) / invoice.total_minor));
    expect(notes[0].meta.reference.number).toBe(invoice.number);
    // refund the rest: a second note for the remaining amount only
    await db.scoped(ctx, (tx) => ledger.applyRefund(tx, ctx, paymentId, order.totalMinor - 1000));
    await dispatcher.drain();
    await dispatcher.drain();
    notes = await sql(`select total_minor from fiscal_documents where order_id = $1 and kind = 'credit_note'`, [order.id]);
    expect(notes.map((n) => n.total_minor).sort((a, b) => a - b)).toEqual([1000, order.totalMinor - 1000].sort((a, b) => a - b));
    const payload = await t.http.get(C(sa, `/fiscal-documents?kind=credit_note&orderId=${order.id}`)).set(auth(accountant));
    expect(payload.body.items).toHaveLength(2);
    const xml = await t.http.get(C(sa, `/fiscal-documents/${payload.body.items[0].id}/payload`)).set(auth(accountant));
    expect(xml.body.payload).toContain('>381</cbc:InvoiceTypeCode>');
    const verify = await t.http.get(C(sa, `/fiscal-documents/verify?branchId=${sa.branchId}`)).set(auth(accountant));
    expect(verify.body.ok).toBe(true);
  });
});

describe('licences and reminders', () => {
  it('tracks expiry, sends the closest due reminder once and stores files', async () => {
    const [{ soon, later, past }] = await sql(
      `select ((now() at time zone 'Asia/Riyadh')::date + 5)::text as soon, ((now() at time zone 'Asia/Riyadh')::date + 200)::text as later,
              ((now() at time zone 'Asia/Riyadh')::date - 3)::text as past`);
    const create = (body: object) => t.http.post(C(sa, '/documents')).set(auth(accountant)).send(body);
    const expiring = await create({ kind: 'municipal_license', title: 'Balady licence', referenceNumber: 'BL-1', issuingAuthority: 'Balady', expiresOn: soon });
    expect(expiring.status).toBe(201);
    expect(expiring.body).toMatchObject({ expiryStatus: 'expiring', daysToExpiry: 5, reminderDays: [30, 7, 1] });
    const valid = await create({ kind: 'health_certificate', title: 'Health cert', expiresOn: later, reminderDays: [14, 60, 14] });
    expect(valid.body).toMatchObject({ expiryStatus: 'valid', reminderDays: [60, 14] });
    const expired = await create({ kind: 'civil_defense', title: 'Civil defense', expiresOn: past, branchId: sa.branchId });
    expect(expired.body.expiryStatus).toBe('expired');
    expect(expired.body.reminders).toEqual([]);
    expect((await create({ kind: 'other', title: 'Bad', issuedOn: later, expiresOn: soon })).status).toBe(400);
    expect((await create({ kind: 'nonsense', title: 'Bad' })).status).toBe(400);

    await dispatcher.runDueJobs(Date.now(), true);
    const reminders = await sql(`select days_before, status from compliance_reminders where document_id = $1 order by days_before`, [expiring.body.id]);
    // 'raised' (FT-06): handed to the notification centre; 'sent' only once an email provider delivered it.
    expect(reminders).toEqual([{ days_before: 1, status: 'scheduled' }, { days_before: 7, status: 'raised' }, { days_before: 30, status: 'dismissed' }]);
    const events = await sql(`select payload from outbox_events where event_type = 'compliance.document_expiring' and aggregate_id = $1`, [expiring.body.id]);
    expect(events).toHaveLength(1);
    expect(events[0].payload).toMatchObject({ daysBefore: 7, daysLeft: 5, kind: 'municipal_license' });
    await dispatcher.runDueJobs(Date.now(), true);
    expect(await sql(`select 1 from outbox_events where event_type = 'compliance.document_expiring' and aggregate_id = $1`, [expiring.body.id])).toHaveLength(1);

    // renewal resets reminders
    const renewed = await t.http.patch(C(sa, `/documents/${expiring.body.id}`)).set(auth(accountant)).send({ expiresOn: later });
    expect(renewed.body.expiryStatus).toBe('valid');
    expect(renewed.body.reminders.every((r: any) => r.status === 'scheduled')).toBe(true);

    const pdf = Buffer.from('%PDF-1.4\n%resuto test\n');
    const file = await t.http.post(C(sa, `/documents/${valid.body.id}/file`)).set(auth(accountant)).attach('file', pdf, { filename: 'cert.pdf', contentType: 'application/pdf' });
    expect(file.status).toBe(201);
    expect(file.body.file).toMatchObject({ contentType: 'application/pdf', url: expect.stringContaining('/v1/media/') });

    const summary = await t.http.get(C(sa, '/summary')).set(auth(accountant));
    expect(summary.body.licences.counts).toMatchObject({ expired: 1, valid: 2 });
    expect(summary.body.licences.attention[0]).toMatchObject({ title: 'Civil defense', status: 'expired' });
    const filtered = await t.http.get(C(sa, '/documents?status=expired')).set(auth(accountant));
    expect(filtered.body.items.map((d: any) => d.title)).toEqual(['Civil defense']);
    expect((await t.http.delete(C(sa, `/documents/${expired.body.id}`)).set(auth(accountant))).body.deleted).toBe(true);
  });
});

describe('access control', () => {
  it('denies waiters, other tenants and the free plan', async () => {
    expect((await t.http.get(C(sa, '/summary')).set(auth(waiter))).status).toBe(403);
    expect((await t.http.get(C(sa, '/tax-profile')).set(auth(waiter))).status).toBe(403);
    expect((await t.http.put(C(sa, '/tax-profile')).set(auth(waiter)).send({})).status).toBe(403);
    expect((await t.http.get(C(sa, '/summary')).set(auth(eg.owner))).status).toBe(404);
    const [doc] = await sql(`select id from fiscal_documents where org_id = $1 limit 1`, [sa.orgId]);
    expect((await t.http.get(C(eg, `/fiscal-documents/${doc.id}`)).set(auth(eg.owner))).status).toBe(404);
    const free = await createTenant(t, { country: 'SA', planId: 'free' });
    const denied = await t.http.get(C(free, '/tax-profile')).set(auth(free.owner));
    expect(denied.status).toBe(402);
    const providers = await t.http.get(C(sa, '/integrations')).set(auth(accountant));
    expect(providers.body.tax.map((p: any) => p.readiness)).toEqual(['implemented_unverified', 'implemented_unverified']);
  });
});
