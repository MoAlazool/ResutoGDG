import { describe, expect, it } from 'vitest';
import {
  buildEtaReceipt, buildZatcaInvoiceXml, checkFiscalTotals, decodeZatcaQr, encodeZatcaQr, etaReceiptQrUrl, etaReceiptUuid,
  EtaSandboxStubClient, fiscalCanonicalJson, formatFiscalMinor, serializeEtaDocument, ZATCA_GENESIS_PIH, zatcaInvoiceHash,
  zatcaQrForDocument, ZatcaSandboxStubClient, type FiscalDocumentModel,
} from './index';

describe('ZATCA Phase-1 TLV QR', () => {
  it('matches the published example vector byte for byte', () => {
    // Example from ZATCA's E-Invoicing Detailed Technical Guideline / SDK samples.
    const qr = encodeZatcaQr({ sellerName: 'Bobs Records', vatNumber: '310122393500003', timestamp: '2022-04-25T15:30:00Z', totalWithVat: '1000.00', vatTotal: '150.00' });
    expect(qr).toBe('AQxCb2JzIFJlY29yZHMCDzMxMDEyMjM5MzUwMDAwMwMUMjAyMi0wNC0yNVQxNTozMDowMFoEBzEwMDAuMDAFBjE1MC4wMA==');
    const bytes = Buffer.from(qr, 'base64');
    // tag 1, length 12, "Bobs Records"
    expect([...bytes.subarray(0, 2)]).toEqual([0x01, 0x0c]);
    expect(bytes.subarray(2, 14).toString()).toBe('Bobs Records');
    // tag 2, length 15
    expect([...bytes.subarray(14, 16)]).toEqual([0x02, 0x0f]);
  });

  it('uses UTF-8 byte lengths for Arabic seller names and round-trips', () => {
    const name = 'مطعم ريزوتو';
    const qr = encodeZatcaQr({ sellerName: name, vatNumber: '300000000000003', timestamp: '2026-10-17T12:00:00Z', totalWithVat: '115.00', vatTotal: '15.00' });
    const bytes = Buffer.from(qr, 'base64');
    expect(bytes[0]).toBe(1);
    expect(bytes[1]).toBe(Buffer.byteLength(name, 'utf8'));
    expect(bytes[1]).not.toBe(name.length);
    expect(decodeZatcaQr(qr)).toEqual({ 1: name, 2: '300000000000003', 3: '2026-10-17T12:00:00Z', 4: '115.00', 5: '15.00' });
  });

  it('rejects empty or oversized values', () => {
    expect(() => encodeZatcaQr({ sellerName: '', vatNumber: '1', timestamp: 't', totalWithVat: '1', vatTotal: '1' })).toThrow(/empty/);
    expect(() => encodeZatcaQr({ sellerName: 'x'.repeat(256), vatNumber: '1', timestamp: 't', totalWithVat: '1', vatTotal: '1' })).toThrow(/255/);
  });

  it('exposes the guideline genesis PIH', () => {
    expect(ZATCA_GENESIS_PIH).toBe('NWZlY2ViNjZmZmM4NmYzOGQ5NTI3ODZjNmQ2OTZjNzljMmRiYzIzOWRkNGU5MWI0NjcyOWQ3M2EyN2ZiNTdlOQ==');
  });
});

const saDoc: FiscalDocumentModel = {
  kind: 'simplified_invoice', number: 'SINV-000001', uuid: '6f4d20e0-6bfe-4a80-9389-7dabe6620f12', counterValue: 1,
  issuedAt: '2026-10-17T12:30:00.000Z', currency: 'SAR', previousHash: null,
  seller: { name: 'Resuto Café & Grill', vatNumber: '310122393500003', country: 'SA', address: { street: 'King Fahd Rd', buildingNumber: '1234', district: 'Olaya', city: 'Riyadh', postalCode: '12345' } },
  buyer: {},
  lines: [
    { code: 'p1', name: 'Burger <large>', quantity: 2, netMinor: 20000, discountMinor: 0, vatMinor: 3000, grossMinor: 23000, vatRateBp: 1500 },
    { code: 'delivery', name: 'Delivery fee', quantity: 1, netMinor: 1000, discountMinor: 0, vatMinor: 150, grossMinor: 1150, vatRateBp: 1500 },
  ],
  totals: { netMinor: 21000, vatMinor: 3150, grossMinor: 24150, discountMinor: 0 },
  paymentMethod: 'cod',
};

describe('ZATCA Phase-2 XML builder', () => {
  it('builds a UBL 2.1 simplified invoice with ICV, PIH, escaped values and reconciled totals', () => {
    const qr = zatcaQrForDocument(saDoc);
    expect(decodeZatcaQr(qr)).toMatchObject({ 3: '2026-10-17T12:30:00Z', 4: '241.50', 5: '31.50' });
    const xml = buildZatcaInvoiceXml(saDoc, { includeQr: true, qr });
    expect(xml).toContain('<cbc:ProfileID>reporting:1.0</cbc:ProfileID>');
    expect(xml).toContain('<cbc:InvoiceTypeCode name="0200000">388</cbc:InvoiceTypeCode>');
    expect(xml).toContain('<cbc:ID>ICV</cbc:ID><cbc:UUID>1</cbc:UUID>');
    expect(xml).toContain(ZATCA_GENESIS_PIH);
    expect(xml).toContain('Burger &lt;large&gt;');
    expect(xml).toContain('Resuto Café &amp; Grill');
    expect(xml).toContain('<cbc:TaxInclusiveAmount currencyID="SAR">241.50</cbc:TaxInclusiveAmount>');
    expect(xml).toContain('<cbc:PaymentMeansCode>10</cbc:PaymentMeansCode>');
    expect(xml).toContain(`<cbc:ID>QR</cbc:ID>`);
  });

  it('hashes the invoice without the QR and changes the hash with the previous hash', () => {
    const h1 = zatcaInvoiceHash(saDoc, null);
    const h2 = zatcaInvoiceHash(saDoc, 'other');
    expect(h1).toMatch(/^[A-Za-z0-9+/]{43}=$/);
    expect(h1).not.toBe(h2);
    expect(zatcaInvoiceHash(saDoc, null)).toBe(h1);
  });

  it('marks credit notes with code 381, billing reference and reason', () => {
    const xml = buildZatcaInvoiceXml({ ...saDoc, kind: 'credit_note', number: 'CN-000002', reference: { number: 'SINV-000001', uuid: saDoc.uuid, issuedAt: saDoc.issuedAt }, reason: 'Refund' });
    expect(xml).toContain('>381</cbc:InvoiceTypeCode>');
    expect(xml).toContain('<cac:BillingReference><cac:InvoiceDocumentReference><cbc:ID>SINV-000001</cbc:ID>');
    expect(xml).toContain('<cbc:InstructionNote>Refund</cbc:InstructionNote>');
  });

  it('sandbox stub never claims acceptance and reports local problems', async () => {
    const stub = new ZatcaSandboxStubClient();
    const ok = await stub.reportSimplified(saDoc, { uuid: saDoc.uuid, invoiceHash: 'h', invoiceXmlBase64: '' });
    expect(ok).toMatchObject({ mode: 'sandbox_stub', status: 'submitted', response: { stub: true, network: false } });
    const bad = await stub.reportSimplified({ ...saDoc, seller: { ...saDoc.seller, vatNumber: '123' } }, { uuid: saDoc.uuid, invoiceHash: 'h', invoiceXmlBase64: '' });
    expect(bad.status).toBe('rejected');
    expect(stub.descriptor.readiness).toBe('simulated');
  });
});

const egDoc: FiscalDocumentModel = {
  ...saDoc, kind: 'receipt', number: 'R-000001', currency: 'EGP',
  seller: { name: 'Resuto Cairo', vatNumber: '123456789', country: 'EG', address: { governate: 'Cairo', regionCity: 'Nasr City', street: 'Abbas El Akkad', buildingNumber: '10' }, branchCode: '0', activityCode: '5610', posSerial: 'POS-001' },
  lines: [{ code: 'p1', name: 'Koshary', quantity: 3, netMinor: 9000, discountMinor: 1000, vatMinor: 1260, grossMinor: 10260, vatRateBp: 1400 }],
  totals: { netMinor: 9000, vatMinor: 1260, grossMinor: 10260, discountMinor: 1000 },
  paymentMethod: 'cash',
};

describe('ETA e-receipt', () => {
  it('serialises with uppercase quoted names and repeated array names', () => {
    expect(serializeEtaDocument({ a: 1, b: { c: 'x' }, items: [{ v: 1 }, { v: 2 }] }))
      .toBe('"A""1""B""C""x""ITEMS""ITEMS""V""1""ITEMS""V""2"');
  });

  it('builds the receipt structure and derives the UUID from its content', () => {
    const { receipt, uuid } = buildEtaReceipt(egDoc, null);
    expect(uuid).toMatch(/^[0-9a-f]{64}$/);
    expect(receipt.header.uuid).toBe(uuid);
    expect(etaReceiptUuid(receipt as any)).toBe(uuid);
    expect(receipt.documentType).toEqual({ receiptType: 'S', typeVersion: '1.2' });
    expect(receipt.seller).toMatchObject({ rin: '123456789', branchCode: '0', deviceSerialNumber: 'POS-001', activityCode: '5610' });
    expect(receipt.itemData[0]).toMatchObject({ quantity: 3, totalSale: 100, netSale: 90, total: 102.6, taxableItems: [{ taxType: 'T1', amount: 12.6, subType: 'V009', rate: 14 }] });
    expect(receipt).toMatchObject({ netAmount: 90, totalAmount: 102.6, totalCommercialDiscount: 10, paymentMethod: 'C' });
    // chaining changes the UUID
    expect(buildEtaReceipt(egDoc, uuid).uuid).not.toBe(uuid);
    expect(etaReceiptQrUrl('preprod', uuid, receipt.header.dateTimeIssued, 102.6, '123456789'))
      .toBe(`https://preprod.invoicing.eta.gov.eg/receipts/search/${uuid}/share/2026-10-17T12:30:00Z#Total:102.6,IssuerRIN:123456789`);
  });

  it('stub detects tampered receipts', async () => {
    const { receipt, uuid } = buildEtaReceipt(egDoc, null);
    const stub = new EtaSandboxStubClient();
    expect((await stub.submitReceipts([{ doc: egDoc, receipt, uuid }])).status).toBe('submitted');
    const tampered = { ...receipt, totalAmount: 1 };
    const res = await stub.submitReceipts([{ doc: egDoc, receipt: tampered, uuid }]);
    expect(res.status).toBe('rejected');
    expect(res.mode).toBe('sandbox_stub');
  });
});

describe('fiscal model helpers', () => {
  it('formats minor units without floating point', () => {
    expect(formatFiscalMinor(24150)).toBe('241.50');
    expect(formatFiscalMinor(5)).toBe('0.05');
    expect(formatFiscalMinor(-1200)).toBe('-12.00');
  });
  it('canonical JSON is key-order independent', () => {
    expect(fiscalCanonicalJson({ b: 1, a: { d: [2, { z: 1, y: 2 }], c: null } })).toBe('{"a":{"c":null,"d":[2,{"y":2,"z":1}]},"b":1}');
  });
  it('detects totals that do not reconcile', () => {
    expect(checkFiscalTotals(saDoc)).toEqual([]);
    expect(checkFiscalTotals({ ...saDoc, totals: { ...saDoc.totals, vatMinor: 1 } }).length).toBeGreaterThan(0);
  });
});
