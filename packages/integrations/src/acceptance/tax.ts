// ZATCA and ETA acceptance checks (INT-26 / FT-24). Both run only against the authorities' test environments:
// ZATCA's developer-portal sandbox (sample OTP from the portal's API page) and ETA preprod with the taxpayer's POS
// registration. They exist so the first real run is one command; until then readiness stays "implemented, not
// verified" and both integrations are labelled "implementation incomplete / not certified".
import { readFileSync } from 'node:fs';
import { buildEtaReceipt, buildZatcaCsr, certificateFromBinarySecurityToken, EtaReceiptClient, FatooraClient, generateZatcaKeyPair, signZatcaInvoice } from '../tax';
import type { FiscalDocumentModel } from '../tax';
import { expectThat, registerChecks, type AcceptanceCheck } from './index';
import { runKey } from './payments-common';

const zatcaSample = (vat: string): FiscalDocumentModel => ({
  kind: 'simplified_invoice', number: `SINV-ACC-${Date.now()}`, uuid: crypto.randomUUID(), counterValue: 1, issuedAt: new Date().toISOString(), currency: 'SAR', previousHash: null,
  seller: { name: 'Resuto acceptance', vatNumber: vat, country: 'SA', address: { street: 'King Fahd Rd', buildingNumber: '1234', district: 'Olaya', city: 'Riyadh', postalCode: '12345' } },
  buyer: {}, paymentMethod: 'cash',
  lines: [{ code: 'acc', name: 'Acceptance item', quantity: 1, netMinor: 1000, discountMinor: 0, vatMinor: 150, grossMinor: 1150, vatRateBp: 1500 }],
  totals: { netMinor: 1000, vatMinor: 150, grossMinor: 1150, discountMinor: 0 },
} as FiscalDocumentModel);

const etaCreds = (env: Record<string, string>) => ({
  clientId: env.ETA_CLIENT_ID!, clientSecret: env.ETA_CLIENT_SECRET!, posSerial: env.ETA_POS_SERIAL!, posOsVersion: env.ETA_POS_OS_VERSION!,
  posModelFramework: env.ETA_POS_MODEL_FRAMEWORK!, presharedKey: env.ETA_PRESHARED_KEY!,
});
const ETA_POS = ['ETA_CLIENT_ID', 'ETA_CLIENT_SECRET', 'ETA_POS_SERIAL', 'ETA_POS_OS_VERSION', 'ETA_POS_MODEL_FRAMEWORK', 'ETA_PRESHARED_KEY'];

export const taxChecks: AcceptanceCheck[] = [
  {
    id: 'zatca.sandbox_onboarding_and_compliance_check', provider: 'zatca_fatoora', capability: 'csid_and_stamp', modes: ['official_test'],
    requires: ['ZATCA_SANDBOX_OTP', 'ZATCA_SANDBOX_VAT'], effect: 'write_test',
    prerequisites: ['Developer-portal sandbox only (https://sandbox.zatca.gov.sa → API Integration Sandbox): OTP = the sample OTP shown on the Compliance CSID API page; VAT = a 15-digit test VAT starting and ending with 3. The run generates a throwaway key, requests a compliance CSID and sends one stamped simplified invoice to /compliance/invoices. This is the first real validation of the stamp.'],
    docsUrl: 'https://zatca.gov.sa/en/E-Invoicing/Introduction/Guidelines/Documents/DEVELOPER-PORTAL-MANUAL.pdf',
    async run(ctx) {
      const vat = ctx.env.ZATCA_SANDBOX_VAT!;
      const keys = generateZatcaKeyPair();
      const csr = buildZatcaCsr({ commonName: `RESUTO-ACC-${runKey('z')}`, organizationUnit: 'Acceptance', organizationName: 'Resuto acceptance', egsSerial: `1-Resuto|2-acceptance|3-${runKey('egs')}`,
        vatNumber: vat, invoiceType: '0100', location: 'RRRD2929', industry: 'Restaurants' }, keys.privateKeyPem);
      const client = new FatooraClient('sandbox', ctx.adapter.fetch);
      const csid = await client.complianceCsid(ctx.env.ZATCA_SANDBOX_OTP!, csr.csrBase64);
      ctx.evidence('compliance CSID issued', { requestId: csid.requestId, dispositionMessage: csid.dispositionMessage });
      const certificatePem = certificateFromBinarySecurityToken(csid.binarySecurityToken);
      const doc = zatcaSample(vat);
      const signed = signZatcaInvoice({ doc, certificatePem, privateKeyPem: keys.privateKeyPem });
      const r = await client.complianceCheck(csid, { invoiceHash: signed.invoiceHash, uuid: doc.uuid, invoiceXml: signed.signedXml });
      ctx.evidence('compliance check', { outcome: r.outcome, status: r.status, reportingStatus: r.reportingStatus, warnings: r.warnings, errors: r.errors });
      expectThat(r.outcome === 'accepted' || r.outcome === 'accepted_with_warnings', `the stamped invoice was not accepted: ${r.errors.join('; ')}`);
    },
  },
  {
    id: 'eta.preprod_pos_login', provider: 'eta_ereceipt', capability: 'pos_token', modes: ['official_test'],
    requires: ETA_POS, effect: 'read',
    prerequisites: ['ETA preprod: the taxpayer has the B2C tag and the POS is registered (client id/secret and pre-shared key from the ETA portal).'],
    docsUrl: 'https://sdk.invoicing.eta.gov.eg/ereceiptapi/01-authenticate-pos/',
    async run(ctx) {
      const token = await new EtaReceiptClient('preprod', etaCreds(ctx.env), ctx.adapter.fetch).accessToken();
      ctx.evidence('POS access token issued', { tokenLength: token.length });
      expectThat(token.split('.').length === 3, 'the access token is not a JWT');
    },
  },
  {
    id: 'eta.preprod_submit_receipt', provider: 'eta_ereceipt', capability: 'receipt_submission', modes: ['official_test'],
    requires: [...ETA_POS, 'ETA_RIN', 'ETA_ACTIVITY_CODE', 'ETA_BRANCH_CODE', 'ETA_ITEM_CODE', 'ETA_SIGNING_CERT_FILE', 'ETA_SIGNING_KEY_FILE'], effect: 'fiscal',
    prerequisites: ['ETA preprod only. A registered EGS item code, the branch code and activity code of the POS, and the eSeal certificate + private key (PEM files) used for the issuer signature. Submits one receipt and reads the submission status.'],
    docsUrl: 'https://sdk.invoicing.eta.gov.eg/ereceiptapi/02-submit-receipt/',
    async run(ctx) {
      const doc = {
        kind: 'receipt', number: `R-ACC-${Date.now()}`, uuid: crypto.randomUUID(), counterValue: 1, issuedAt: new Date().toISOString(), currency: 'EGP', previousHash: null,
        seller: { name: 'Resuto acceptance', vatNumber: ctx.env.ETA_RIN!, country: 'EG', address: { governate: 'Cairo', regionCity: 'Nasr City', street: 'Street', buildingNumber: '1' },
          branchCode: ctx.env.ETA_BRANCH_CODE!, activityCode: ctx.env.ETA_ACTIVITY_CODE!, posSerial: ctx.env.ETA_POS_SERIAL! },
        buyer: {}, paymentMethod: 'cash',
        lines: [{ code: 'acc', name: 'Acceptance item', quantity: 1, netMinor: 1000, discountMinor: 0, vatMinor: 140, grossMinor: 1140, vatRateBp: 1400 }],
        totals: { netMinor: 1000, vatMinor: 140, grossMinor: 1140, discountMinor: 0 },
      } as FiscalDocumentModel;
      const { receipt, uuid } = buildEtaReceipt(doc, null, { itemCode: () => ctx.env.ETA_ITEM_CODE! });
      const client = new EtaReceiptClient('preprod', etaCreds(ctx.env), ctx.adapter.fetch);
      const r = await client.submit([receipt], { certificatePem: readFileSync(ctx.env.ETA_SIGNING_CERT_FILE!, 'utf8'), privateKeyPem: readFileSync(ctx.env.ETA_SIGNING_KEY_FILE!, 'utf8') });
      ctx.evidence('submission', { submissionUuid: r.submissionUuid, accepted: r.accepted.length, rejected: r.rejected.map((x) => x.error), uuid });
      expectThat(!!r.submissionUuid && r.accepted.some((a) => a.uuid === uuid), 'the receipt was not accepted');
      const s = await client.submission(r.submissionUuid!);
      ctx.evidence('submission status', { status: s.status, receiptsCount: s.receiptsCount, invalid: s.invalidReceiptCount });
    },
  },
];

registerChecks(...taxChecks);
