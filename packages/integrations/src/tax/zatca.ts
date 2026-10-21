// ZATCA (Saudi Arabia, FATOORA) e-invoicing structures.
//
// Phase 1 (generation): the simplified tax invoice QR code is a Base64 string
// of TLV records — Tag (1 byte) | Length (1 byte, UTF-8 byte count) | Value —
// with tags 1 seller name, 2 VAT registration number, 3 invoice timestamp
// (ISO-8601), 4 invoice total with VAT, 5 VAT total ("E-Invoicing Detailed
// Technical Guideline", ZATCA). Implemented exactly and covered by unit tests
// against the published example vector.
//
// Phase 2 (integration): UBL 2.1 XML, invoice hash, ECDSA (secp256k1) XAdES
// signature with a CSID, and the reporting/clearance APIs. This file builds the
// XML payload and a hash; signing and submission are interfaces only.
// Readiness: implemented_unverified — not validated with the ZATCA SDK or
// sandbox, no CSID, no network calls. Resuto is not a ZATCA-certified solution.
import type { ProviderDescriptor } from '../core';
import { checkFiscalTotals, formatFiscalMinor, fiscalSha256Base64, fiscalSha256Hex, type FiscalDocumentModel } from './model';

export interface ZatcaQrFields {
  sellerName: string;
  vatNumber: string;
  /** ISO-8601, e.g. 2022-04-25T15:30:00Z */
  timestamp: string;
  /** Decimal string, e.g. "1000.00" */
  totalWithVat: string;
  vatTotal: string;
}

/** Phase-1 TLV QR payload (Base64). Throws if a value exceeds 255 UTF-8 bytes. */
export function encodeZatcaQr(fields: ZatcaQrFields): string {
  const values = [fields.sellerName, fields.vatNumber, fields.timestamp, fields.totalWithVat, fields.vatTotal];
  const chunks = values.map((v, i) => {
    const bytes = Buffer.from(v, 'utf8');
    if (bytes.length === 0) throw new RangeError(`ZATCA QR tag ${i + 1} is empty`);
    if (bytes.length > 255) throw new RangeError(`ZATCA QR tag ${i + 1} exceeds 255 bytes`);
    return Buffer.concat([Buffer.from([i + 1, bytes.length]), bytes]);
  });
  return Buffer.concat(chunks).toString('base64');
}

/** Decodes a TLV QR payload into tag → UTF-8 value. */
export function decodeZatcaQr(base64: string): Record<number, string> {
  const buf = Buffer.from(base64, 'base64');
  const out: Record<number, string> = {};
  let i = 0;
  while (i < buf.length) {
    const tag = buf[i]!;
    const len = buf[i + 1];
    if (len === undefined || i + 2 + len > buf.length) throw new RangeError('truncated TLV');
    out[tag] = buf.subarray(i + 2, i + 2 + len).toString('utf8');
    i += 2 + len;
  }
  return out;
}

/** ZATCA timestamps: ISO-8601 UTC without milliseconds. */
export const zatcaTimestamp = (d: Date | string) => new Date(d).toISOString().replace(/\.\d{3}Z$/, 'Z');

export function zatcaQrForDocument(doc: FiscalDocumentModel): string {
  return encodeZatcaQr({
    sellerName: doc.seller.name,
    vatNumber: doc.seller.vatNumber,
    timestamp: zatcaTimestamp(doc.issuedAt),
    totalWithVat: formatFiscalMinor(doc.totals.grossMinor),
    vatTotal: formatFiscalMinor(doc.totals.vatMinor),
  });
}

/** PIH of the first invoice of an EGS unit: Base64(SHA-256("0")) per the ZATCA guideline. */
export const ZATCA_GENESIS_PIH = Buffer.from(fiscalSha256Hex('0')).toString('base64');

// Escaping exactly as Canonical XML (C14N 1.0/1.1 §2.3) writes it, so the builder output IS its own canonical form and
// the invoice hash can be taken over it directly: text → &amp; &lt; &gt; &#xD;; attribute values → &amp; &lt; &quot;
// &#x9; &#xA; &#xD;. (Before INT-26 text quotes were written as &quot;, which C14N writes as ", so the hash of a
// document with a quote in a name differed from ZATCA's.) https://www.w3.org/TR/xml-c14n11/#ProcessingModel
export const c14nText = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\r/g, '&#xD;');
export const c14nAttr = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;').replace(/\t/g, '&#x9;').replace(/\n/g, '&#xA;').replace(/\r/g, '&#xD;');
const esc = c14nText;
const el = (name: string, value: string | number, attrs = '') => `<${name}${attrs}>${esc(String(value))}</${name}>`;
const amt = (name: string, minor: number, currency: string) => el(name, formatFiscalMinor(minor), ` currencyID="${c14nAttr(currency)}"`);
const pct = (bp: number) => formatFiscalMinor(bp, 2); // 1500 bp → "15.00"

export interface ZatcaXmlOptions {
  /** Previous invoice hash (Base64); defaults to the genesis PIH. */
  previousInvoiceHash?: string | null;
  /** Include the QR AdditionalDocumentReference (excluded when hashing). */
  includeQr?: boolean;
  qr?: string;
}

const NS = 'xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2" '
  + 'xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2" '
  + 'xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2" '
  + 'xmlns:ext="urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2"';

/**
 * Builds the UBL 2.1 invoice body (no UBLExtensions/signature: those are added
 * by a ZatcaSigner). Simplified invoices use InvoiceTypeCode name 0200000;
 * credit notes use code 381 with a BillingReference and InstructionNote.
 */
export function buildZatcaInvoiceXml(doc: FiscalDocumentModel, opts: ZatcaXmlOptions = {}): string {
  const cur = doc.currency;
  const issued = new Date(doc.issuedAt);
  const date = issued.toISOString().slice(0, 10);
  const time = issued.toISOString().slice(11, 19);
  const simplified = doc.kind !== 'standard_invoice';
  const typeCode = doc.kind === 'credit_note' ? '381' : doc.kind === 'debit_note' ? '383' : '388';
  const a = doc.seller.address;
  const pih = opts.previousInvoiceHash ?? ZATCA_GENESIS_PIH;
  const rate = doc.lines[0]?.vatRateBp ?? 1500;
  const paymentCode = doc.paymentMethod === 'card' ? '48' : doc.paymentMethod === 'bank_transfer' ? '42' : doc.paymentMethod === 'cash' || doc.paymentMethod === 'cod' ? '10' : '1';

  const parts: string[] = [
    el('cbc:ProfileID', 'reporting:1.0'),
    el('cbc:ID', doc.number),
    el('cbc:UUID', doc.uuid),
    el('cbc:IssueDate', date),
    el('cbc:IssueTime', time),
    el('cbc:InvoiceTypeCode', typeCode, ` name="${simplified ? '0200000' : '0100000'}"`),
    el('cbc:DocumentCurrencyCode', cur),
    el('cbc:TaxCurrencyCode', cur),
  ];
  if (doc.reference) parts.push(`<cac:BillingReference><cac:InvoiceDocumentReference>${el('cbc:ID', doc.reference.number)}</cac:InvoiceDocumentReference></cac:BillingReference>`);
  parts.push(`<cac:AdditionalDocumentReference>${el('cbc:ID', 'ICV')}${el('cbc:UUID', doc.counterValue)}</cac:AdditionalDocumentReference>`);
  parts.push(`<cac:AdditionalDocumentReference>${el('cbc:ID', 'PIH')}<cac:Attachment>${el('cbc:EmbeddedDocumentBinaryObject', pih, ' mimeCode="text/plain"')}</cac:Attachment></cac:AdditionalDocumentReference>`);
  if (opts.includeQr && opts.qr) {
    parts.push(`<cac:AdditionalDocumentReference>${el('cbc:ID', 'QR')}<cac:Attachment>${el('cbc:EmbeddedDocumentBinaryObject', opts.qr, ' mimeCode="text/plain"')}</cac:Attachment></cac:AdditionalDocumentReference>`);
  }
  parts.push(`<cac:AccountingSupplierParty><cac:Party>`
    + (doc.seller.commercialRegistration ? `<cac:PartyIdentification>${el('cbc:ID', doc.seller.commercialRegistration, ' schemeID="CRN"')}</cac:PartyIdentification>` : '')
    + `<cac:PostalAddress>${el('cbc:StreetName', a.street ?? '')}${el('cbc:BuildingNumber', a.buildingNumber ?? '')}`
    + (a.additionalNumber ? el('cbc:PlotIdentification', a.additionalNumber) : '')
    + `${el('cbc:CitySubdivisionName', a.district ?? '')}${el('cbc:CityName', a.city ?? '')}${el('cbc:PostalZone', a.postalCode ?? '')}`
    + `<cac:Country>${el('cbc:IdentificationCode', 'SA')}</cac:Country></cac:PostalAddress>`
    + `<cac:PartyTaxScheme>${el('cbc:CompanyID', doc.seller.vatNumber)}<cac:TaxScheme>${el('cbc:ID', 'VAT')}</cac:TaxScheme></cac:PartyTaxScheme>`
    + `<cac:PartyLegalEntity>${el('cbc:RegistrationName', doc.seller.name)}</cac:PartyLegalEntity>`
    + `</cac:Party></cac:AccountingSupplierParty>`);
  parts.push(`<cac:AccountingCustomerParty><cac:Party>`
    + (doc.buyer.vatNumber ? `<cac:PartyTaxScheme>${el('cbc:CompanyID', doc.buyer.vatNumber)}<cac:TaxScheme>${el('cbc:ID', 'VAT')}</cac:TaxScheme></cac:PartyTaxScheme>` : '')
    + (doc.buyer.name ? `<cac:PartyLegalEntity>${el('cbc:RegistrationName', doc.buyer.name)}</cac:PartyLegalEntity>` : '')
    + `</cac:Party></cac:AccountingCustomerParty>`);
  parts.push(`<cac:PaymentMeans>${el('cbc:PaymentMeansCode', paymentCode)}${doc.reason ? el('cbc:InstructionNote', doc.reason) : ''}</cac:PaymentMeans>`);
  parts.push(`<cac:TaxTotal>${amt('cbc:TaxAmount', doc.totals.vatMinor, cur)}</cac:TaxTotal>`);
  parts.push(`<cac:TaxTotal>${amt('cbc:TaxAmount', doc.totals.vatMinor, cur)}<cac:TaxSubtotal>${amt('cbc:TaxableAmount', doc.totals.netMinor, cur)}`
    + `${amt('cbc:TaxAmount', doc.totals.vatMinor, cur)}<cac:TaxCategory>${el('cbc:ID', 'S')}${el('cbc:Percent', pct(rate))}`
    + `<cac:TaxScheme>${el('cbc:ID', 'VAT')}</cac:TaxScheme></cac:TaxCategory></cac:TaxSubtotal></cac:TaxTotal>`);
  parts.push(`<cac:LegalMonetaryTotal>${amt('cbc:LineExtensionAmount', doc.totals.netMinor, cur)}${amt('cbc:TaxExclusiveAmount', doc.totals.netMinor, cur)}`
    + `${amt('cbc:TaxInclusiveAmount', doc.totals.grossMinor, cur)}${amt('cbc:AllowanceTotalAmount', 0, cur)}${amt('cbc:PrepaidAmount', 0, cur)}`
    + `${amt('cbc:PayableAmount', doc.totals.grossMinor, cur)}</cac:LegalMonetaryTotal>`);
  doc.lines.forEach((l, i) => {
    // Discounts are already folded into the line net; the price is expressed for
    // the whole quantity (BaseQuantity) so price × quantity reconciles exactly.
    parts.push(`<cac:InvoiceLine>${el('cbc:ID', i + 1)}${el('cbc:InvoicedQuantity', l.quantity.toFixed(6), ' unitCode="PCE"')}`
      + `${amt('cbc:LineExtensionAmount', l.netMinor, cur)}<cac:TaxTotal>${amt('cbc:TaxAmount', l.vatMinor, cur)}${amt('cbc:RoundingAmount', l.grossMinor, cur)}</cac:TaxTotal>`
      + `<cac:Item>${el('cbc:Name', l.name)}<cac:ClassifiedTaxCategory>${el('cbc:ID', 'S')}${el('cbc:Percent', pct(l.vatRateBp))}`
      + `<cac:TaxScheme>${el('cbc:ID', 'VAT')}</cac:TaxScheme></cac:ClassifiedTaxCategory></cac:Item>`
      + `<cac:Price>${amt('cbc:PriceAmount', l.netMinor, cur)}${el('cbc:BaseQuantity', l.quantity.toFixed(6), ' unitCode="PCE"')}</cac:Price></cac:InvoiceLine>`);
  });
  return `<?xml version="1.0" encoding="UTF-8"?>\n<Invoice ${NS}>${parts.join('')}</Invoice>`;
}

/**
 * Invoice hash input per the guideline: the invoice without UBLExtensions,
 * cac:Signature and the QR reference, canonicalised (C14N 1.1). Our builder
 * already emits a canonical-form body (explicit end tags, fixed attribute order,
 * no insignificant whitespace), so the hash is SHA-256 over that body without
 * the XML declaration. NOT yet verified against the ZATCA SDK's C14N output.
 */
export function zatcaInvoiceHash(doc: FiscalDocumentModel, previousInvoiceHash?: string | null): string {
  const xml = buildZatcaInvoiceXml(doc, { previousInvoiceHash, includeQr: false });
  return fiscalSha256Base64(xml.replace(/^<\?xml[^>]*\?>\n/, ''));
}

// ---------------------------------------------------------------------------
// Phase-2 interfaces
// ---------------------------------------------------------------------------
export interface ZatcaSigner {
  /** Adds UBLExtensions with the XAdES signature (ECDSA secp256k1 with the CSID private key). */
  sign(xml: string, invoiceHash: string): Promise<{ signedXml: string; signatureValue: string; certificateHash: string }>;
}

export interface ZatcaSubmission {
  uuid: string;
  invoiceHash: string;
  /** Base64 of the (signed) invoice XML. */
  invoiceXmlBase64: string;
}

export interface ZatcaSubmissionResult {
  mode: 'sandbox_stub' | 'sandbox_api' | 'production_api';
  status: 'submitted' | 'accepted' | 'rejected' | 'error';
  requestDigest: string;
  response: Record<string, unknown>;
}

/** Reporting (simplified, within 24h) and clearance (standard, before sharing). */
export interface ZatcaClient {
  readonly descriptor: ProviderDescriptor;
  reportSimplified(doc: FiscalDocumentModel, submission: ZatcaSubmission): Promise<ZatcaSubmissionResult>;
  clearStandard(doc: FiscalDocumentModel, submission: ZatcaSubmission): Promise<ZatcaSubmissionResult>;
}

export const ZATCA_DESCRIPTOR: ProviderDescriptor = {
  id: 'zatca_fatoora',
  name: 'ZATCA FATOORA (KSA e-invoicing)',
  category: 'tax',
  countries: ['SA'],
  authType: 'api_key',
  readiness: 'implemented_unverified',
  docsUrl: 'https://zatca.gov.sa/en/E-Invoicing/SystemsDevelopers/Pages/default.aspx',
  activation: [
    'Implementation incomplete and not certified: Resuto builds the CSR, the XAdES stamp, the Phase-2 QR and calls the FATOORA APIs, but has not been validated with the ZATCA SDK or sandbox yet. Do not use it for real invoices before that.',
    'In the FATOORA portal, generate an OTP for the EGS unit (valid 1 hour). In Resuto → Compliance → ZATCA, enter the EGS details (serial 1-…|2-…|3-…, branch, location, industry) and the OTP: Resuto generates a secp256k1 key (sealed), sends the CSR and stores the compliance CSID sealed.',
    'Run the compliance checks (sample simplified invoice, credit and debit notes), then request the production CSID.',
    'Simplified invoices are then stamped and reported within 24 hours; standard invoices are cleared before sharing.',
  ],
  capabilities: ['phase1_qr', 'ubl_xml_builder', 'csr', 'compliance_csid', 'xades_stamp_unverified', 'phase2_qr', 'reporting_client', 'clearance_client', 'not_certified'],
};

/** No network: validates the payload locally and records a clearly labelled stub result. */
export class ZatcaSandboxStubClient implements ZatcaClient {
  readonly descriptor = { ...ZATCA_DESCRIPTOR, readiness: 'simulated' as const };

  async reportSimplified(doc: FiscalDocumentModel, submission: ZatcaSubmission): Promise<ZatcaSubmissionResult> {
    return this.stub('reporting', doc, submission);
  }

  async clearStandard(doc: FiscalDocumentModel, submission: ZatcaSubmission): Promise<ZatcaSubmissionResult> {
    return this.stub('clearance', doc, submission);
  }

  private stub(api: 'reporting' | 'clearance', doc: FiscalDocumentModel, s: ZatcaSubmission): ZatcaSubmissionResult {
    const problems = [...checkFiscalTotals(doc)];
    if (!/^3\d{13}3$/.test(doc.seller.vatNumber)) problems.push('seller VAT number is not a valid KSA VAT number');
    if (!doc.seller.name) problems.push('seller name missing');
    if (doc.kind === 'credit_note' && !doc.reference) problems.push('credit note without a billing reference');
    return {
      mode: 'sandbox_stub',
      status: problems.length ? 'rejected' : 'submitted',
      requestDigest: s.invoiceHash,
      response: {
        stub: true, api, network: false,
        message: 'Sandbox stub: nothing was sent to ZATCA. Only local structural checks ran.',
        localValidation: { passed: problems.length === 0, problems },
        signed: false,
      },
    };
  }
}
