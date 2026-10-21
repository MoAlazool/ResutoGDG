// Egyptian Tax Authority (ETA) e-receipt structures (B2C POS receipts).
//
// Built after the published "e-Receipt" integration guide (receipt v1.2):
// header / documentType / seller / buyer / itemData / totals, with the receipt
// UUID derived as SHA-256 (hex, 64 chars) of the receipt serialised with the
// ETA canonical serialisation while `header.uuid` is an empty string:
//
//   serialize(value)  = "\"" + value + "\""                       (scalars)
//   serialize(object) = for each property in order:
//                         "\"" + NAME.toUpperCase() + "\"" + serialize(prop)
//                       arrays: "\"" + NAME + "\"" then, per element,
//                         "\"" + NAME + "\"" + serialize(element)
//
// `previousUUID` chains each receipt to the previous one of the same POS.
// Readiness: implemented_unverified — no ETA credentials, POS registration or
// preprod call has been made; submission is a sandbox stub with no network.
// Resuto is not an ETA-certified POS solution.
import type { ProviderDescriptor } from '../core';
import { checkFiscalTotals, fiscalMinorToNumber, fiscalSha256Hex, type FiscalDocumentModel } from './model';

export type EtaJson = string | number | boolean | null | EtaJson[] | { [k: string]: EtaJson };

/** ETA canonical serialisation (see header comment). Property order is preserved. */
export function serializeEtaDocument(value: EtaJson, name = ''): string {
  if (value === null || typeof value !== 'object') return `"${value === null ? '' : String(value)}"`;
  if (Array.isArray(value)) {
    const upper = name.toUpperCase();
    return value.map((v) => `"${upper}"${serializeEtaDocument(v, name)}`).join('');
  }
  let out = '';
  for (const [k, v] of Object.entries(value)) {
    out += `"${k.toUpperCase()}"`;
    out += serializeEtaDocument(v, k);
  }
  return out;
}

/** UUID = SHA-256 hex of the serialised receipt with header.uuid = "". */
export function etaReceiptUuid(receipt: { header: { uuid: string } & Record<string, EtaJson> } & Record<string, EtaJson>): string {
  const clone = JSON.parse(JSON.stringify(receipt));
  clone.header.uuid = '';
  return fiscalSha256Hex(serializeEtaDocument(clone));
}

const ETA_PAYMENT: Record<string, string> = { cash: 'C', cod: 'C', card: 'V', wallet: 'O', instapay: 'O', bank_transfer: 'O', other: 'O' };
const n5 = (x: number) => Math.round(x * 100_000) / 100_000;

export interface EtaReceiptOptions {
  /** Item code registered by the taxpayer (EGS/GS1); default "EG-<RIN>-<code>". */
  itemCode?: (line: FiscalDocumentModel['lines'][number]) => string;
}

/** Builds the e-receipt JSON and its UUID. Credit notes become return receipts (type "R"). */
export function buildEtaReceipt(doc: FiscalDocumentModel, previousUuid: string | null, opts: EtaReceiptOptions = {}) {
  const rin = doc.seller.vatNumber;
  const isReturn = doc.kind === 'credit_note';
  const a = doc.seller.address;
  const itemData = doc.lines.map((l) => {
    const totalSale = fiscalMinorToNumber(l.netMinor + l.discountMinor);
    return {
      internalCode: l.code,
      description: l.name,
      itemType: 'EGS',
      itemCode: opts.itemCode ? opts.itemCode(l) : `EG-${rin}-${l.code}`,
      unitType: 'EA',
      quantity: l.quantity,
      unitPrice: n5(totalSale / l.quantity),
      netSale: fiscalMinorToNumber(l.netMinor),
      totalSale,
      total: fiscalMinorToNumber(l.grossMinor),
      commercialDiscountData: l.discountMinor ? [{ amount: fiscalMinorToNumber(l.discountMinor), description: 'Discount' }] : [],
      itemDiscountData: [],
      valueDifference: 0,
      taxableItems: [{ taxType: 'T1', amount: fiscalMinorToNumber(l.vatMinor), subType: 'V009', rate: l.vatRateBp / 100 }],
    };
  });
  const receipt = {
    header: {
      dateTimeIssued: new Date(doc.issuedAt).toISOString().replace(/\.\d{3}Z$/, 'Z'),
      receiptNumber: doc.number,
      uuid: '',
      previousUUID: previousUuid ?? '',
      referenceOldUUID: '',
      ...(isReturn ? { referenceUUID: doc.reference?.uuid ?? '' } : {}),
      currency: doc.currency,
      exchangeRate: 0,
      sOrderNameCode: '',
      orderdeliveryMode: '',
      grossWeight: 0,
      netWeight: 0,
    },
    documentType: { receiptType: isReturn ? 'R' : 'S', typeVersion: '1.2' },
    seller: {
      rin,
      companyTradeName: doc.seller.name,
      branchCode: doc.seller.branchCode ?? '0',
      branchAddress: {
        country: 'EG', governate: a.governate ?? '', regionCity: a.regionCity ?? '', street: a.street ?? '',
        buildingNumber: a.buildingNumber ?? '', postalCode: a.postalCode ?? '', floor: a.floor ?? '', room: a.room ?? '',
        landmark: a.landmark ?? '', additionalInformation: '',
      },
      deviceSerialNumber: doc.seller.posSerial ?? '',
      syndicateLicenseNumber: '',
      activityCode: doc.seller.activityCode ?? '',
    },
    buyer: { type: 'P', id: '', name: doc.buyer.name ?? '', mobileNumber: doc.buyer.phone ?? '', paymentNumber: '' },
    itemData,
    totalSales: fiscalMinorToNumber(doc.lines.reduce((s, l) => s + l.netMinor + l.discountMinor, 0)),
    totalCommercialDiscount: fiscalMinorToNumber(doc.totals.discountMinor),
    totalItemsDiscount: 0,
    extraReceiptDiscountData: [],
    netAmount: fiscalMinorToNumber(doc.totals.netMinor),
    feesAmount: 0,
    totalAmount: fiscalMinorToNumber(doc.totals.grossMinor),
    taxTotals: [{ taxType: 'T1', amount: fiscalMinorToNumber(doc.totals.vatMinor) }],
    paymentMethod: ETA_PAYMENT[doc.paymentMethod ?? 'other'] ?? 'O',
    adjustment: 0,
  };
  const uuid = etaReceiptUuid(receipt as any);
  receipt.header.uuid = uuid;
  return { receipt, uuid };
}

/** Receipt QR content: the ETA receipt share URL (per the e-receipt guide). */
export function etaReceiptQrUrl(env: 'preprod' | 'production', uuid: string, dateTimeIssued: string, totalAmount: number, rin: string): string {
  const base = env === 'production' ? 'https://invoicing.eta.gov.eg' : 'https://preprod.invoicing.eta.gov.eg';
  return `${base}/receipts/search/${uuid}/share/${dateTimeIssued}#Total:${totalAmount},IssuerRIN:${rin}`;
}

export interface EtaSubmissionResult {
  mode: 'sandbox_stub' | 'sandbox_api' | 'production_api';
  status: 'submitted' | 'accepted' | 'rejected' | 'error';
  requestDigest: string;
  response: Record<string, unknown>;
}

/** Receipt submission (POST /api/v1/receiptsubmissions with a POS access token in a live client). */
export interface EtaClient {
  readonly descriptor: ProviderDescriptor;
  submitReceipts(receipts: Array<{ doc: FiscalDocumentModel; receipt: Record<string, unknown>; uuid: string }>): Promise<EtaSubmissionResult>;
}

export const ETA_DESCRIPTOR: ProviderDescriptor = {
  id: 'eta_ereceipt',
  name: 'Egyptian Tax Authority e-Receipt',
  category: 'tax',
  countries: ['EG'],
  authType: 'oauth',
  readiness: 'implemented_unverified',
  docsUrl: 'https://sdk.invoicing.eta.gov.eg/ereceiptapi/',
  activation: [
    'Implementation incomplete and not certified: Resuto builds receipts, signs batches (CAdES-BES) and calls the e-receipt APIs, but no ETA preprod submission has been made yet.',
    'Register the taxpayer for e-receipts (B2C tag) and register each POS in the ETA portal: you receive the POS client id / secret and pre-shared key.',
    'Enter the POS serial, OS version, model framework, client id, secret and pre-shared key, and upload the eSeal (signing) certificate and its private key; all are stored sealed.',
    'Register item codes (EGS) and map products to them; submit to preprod first and check the submission status, then switch to production.',
  ],
  capabilities: ['receipt_builder', 'uuid_derivation', 'receipt_qr_url', 'pos_token_client', 'cades_bes_signature', 'batched_submission', 'status_polling', 'not_certified'],
};

export class EtaSandboxStubClient implements EtaClient {
  readonly descriptor = { ...ETA_DESCRIPTOR, readiness: 'simulated' as const };

  async submitReceipts(receipts: Array<{ doc: FiscalDocumentModel; receipt: Record<string, unknown>; uuid: string }>): Promise<EtaSubmissionResult> {
    const problems: string[] = [];
    for (const r of receipts) {
      problems.push(...checkFiscalTotals(r.doc));
      if (!/^\d{9}$/.test(r.doc.seller.vatNumber)) problems.push('seller RIN is not 9 digits');
      if (etaReceiptUuid(r.receipt as any) !== r.uuid) problems.push('receipt UUID does not match its content');
      if (r.doc.kind === 'credit_note' && !r.doc.reference) problems.push('return receipt without a reference receipt');
    }
    return {
      mode: 'sandbox_stub',
      status: problems.length ? 'rejected' : 'submitted',
      requestDigest: fiscalSha256Hex(receipts.map((r) => r.uuid).join(',')),
      response: {
        stub: true, network: false,
        message: 'Sandbox stub: nothing was sent to the ETA. Only local structural checks ran.',
        localValidation: { passed: problems.length === 0, problems },
        acceptedDocuments: [], rejectedDocuments: [],
      },
    };
  }
}
