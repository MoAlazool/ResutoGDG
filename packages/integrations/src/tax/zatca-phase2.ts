// ZATCA Phase 2 (integration): EGS onboarding (key pair, CSR, compliance CSID, production CSID), the cryptographic
// stamp (XAdES enveloped signature in UBLExtensions), the Phase-2 QR and the FATOORA reporting / clearance client.
//
// IMPLEMENTATION INCOMPLETE — NOT CERTIFIED. Built from ZATCA's published documents (sources below) and checked
// only locally (DER parsed by OpenSSL, canonical form compared with libxml2's C14N 1.1, signatures verified with the
// key). It has NOT been validated with the ZATCA SDK (fatoora -validate) or the integration sandbox. Points the
// documents leave open, which the SDK / sandbox must settle before production:
//   - SignatureValue input: computed as ECDSA-SHA256 over the canonical invoice (i.e. a signature of the invoice
//     hash, which is what QR tag 7 is defined as), not over ds:SignedInfo.
//   - SignedProperties digest: SHA-256 of its inclusive C14N 1.1 form in document context.
//   - QR tags 6/7/8/9 carry raw bytes (hash 32 bytes per the standard's TLV note; DER signature; DER SPKI; the CA's
//     certificate signature).
//   - SignaturePolicyIdentifier: the standard requires one but publishes no identifier; it is omitted.
//   - Simulation / production gateway paths: only the developer-portal (sandbox) paths are shown in the manual.
//
// Sources (downloaded 2026-10-21):
//   Developer Portal User Manual §2.3.10 and §5.3 (sandbox APIs, CSR OpenSSL config: certificateTemplateName
//     1.3.6.1.4.1.311.20.2 = PRINTABLESTRING "ZATCA-Code-Signing"; DN C, OU, O, CN; SAN dirName SN, UID, title,
//     registeredAddress, businessCategory; secp256k1 key; headers OTP and Accept-Version: V2; bodies {csr},
//     {invoiceHash, uuid, invoice}, {compliance_request_id}; response {requestID, dispositionMessage,
//     binarySecurityToken, secret, errors}; Basic auth binarySecurityToken:secret):
//     https://zatca.gov.sa/en/E-Invoicing/Introduction/Guidelines/Documents/DEVELOPER-PORTAL-MANUAL.pdf
//   Electronic Invoice Security Features Implementation Standards v1.2 (§2.3.3 XAdES structure and transforms,
//     §3 PIH, §4 QR tags 1–9, §5 Basic authentication):
//     https://zatca.gov.sa/ar/E-Invoicing/SystemsDevelopers/Documents/20230519_ZATCA_Electronic_Invoice_Security_Features_Implementation_Standards_vF.pdf
//   XML Implementation Standard (BR-KSA-28/29/30/60: signature ids and method):
//     https://zatca.gov.sa/ar/E-Invoicing/SystemsDevelopers/Documents/20230519_ZATCA_Electronic_Invoice_XML_Implementation_Standard_%20vF.pdf
//   Gateway host (live sandbox portal configuration): https://gw-fatoora.zatca.gov.sa/e-invoicing/developer-portal
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign as cryptoSign, X509Certificate, type KeyObject } from 'node:crypto';
import { ProviderError } from '../core';
import { alg, bitString, certificateParts, ctx, int, octet, oid, printable, seq, setOf, utf8 } from './der';
import type { FiscalDocumentModel } from './model';
import { buildZatcaInvoiceXml, c14nAttr, c14nText, zatcaTimestamp } from './zatca';
import { formatFiscalMinor } from './model';

// ---------------------------------------------------------------------------
// Keys and CSR
// ---------------------------------------------------------------------------
/** secp256k1 key pair (the curve the ZATCA SDK and the developer portal manual use). PEM PKCS#8 / SPKI. */
export function generateZatcaKeyPair(): { privateKeyPem: string; publicKeyPem: string } {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'secp256k1' });
  return { privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString() };
}

export interface ZatcaCsrInput {
  /** CN: unique name or asset tracking number of the solution unit. */
  commonName: string;
  /** OU: branch name; for VAT groups (11th VAT digit = 1) the member's 10-digit TIN. */
  organizationUnit: string;
  /** O: taxpayer name. */
  organizationName: string;
  /** SN in the SAN: "1-<solution provider>|2-<model or version>|3-<serial>". */
  egsSerial: string;
  /** UID in the SAN: 15-digit VAT number starting and ending with 3. */
  vatNumber: string;
  /** title in the SAN: functionality map TSCZ, e.g. "0100" (simplified only) or "1100". */
  invoiceType: string;
  /** registeredAddress in the SAN: branch location (short national address preferred). */
  location: string;
  /** businessCategory in the SAN: industry. */
  industry: string;
  /** certificateTemplateName; the manual's configuration shows "ZATCA-Code-Signing". */
  templateName?: string;
}

export function validateZatcaCsrInput(i: ZatcaCsrInput): string[] {
  const problems: string[] = [];
  if (!/^3\d{13}3$/.test(i.vatNumber)) problems.push('vatNumber must be 15 digits starting and ending with 3');
  if (!/^1-[^|]+\|2-[^|]+\|3-[^|]+$/.test(i.egsSerial)) problems.push('egsSerial must have the form 1-...|2-...|3-...');
  if (!/^[01]{4}$/.test(i.invoiceType) || i.invoiceType === '0000') problems.push('invoiceType must be 4 digits of 0/1, not all 0');
  if (i.vatNumber[10] === '1' && !/^\d{10}$/.test(i.organizationUnit)) problems.push('VAT group: organizationUnit must be the 10-digit TIN of the member');
  for (const k of ['commonName', 'organizationUnit', 'organizationName', 'location', 'industry'] as const) if (!i[k]?.trim()) problems.push(`${k} is required`);
  return problems;
}

const OID = {
  C: '2.5.4.6', OU: '2.5.4.11', O: '2.5.4.10', CN: '2.5.4.3', SN: '2.5.4.4', UID: '0.9.2342.19200300.100.1.1', title: '2.5.4.12',
  registeredAddress: '2.5.4.26', businessCategory: '2.5.4.15', extensionRequest: '1.2.840.113549.1.9.14', subjectAltName: '2.5.29.17',
  certificateTemplateName: '1.3.6.1.4.1.311.20.2', ecdsaWithSha256: '1.2.840.10045.4.3.2',
};
const rdn = (type: string, value: ReturnType<typeof utf8>) => setOf(seq(oid(type), value));

/**
 * PKCS#10 CSR, signed with the EGS private key (proof of possession), with the subject and extensions of the
 * manual's OpenSSL configuration (§5.3.1). Returns PEM and the value the compliance API takes (Base64 of the PEM).
 */
export function buildZatcaCsr(input: ZatcaCsrInput, privateKeyPem: string): { pem: string; der: Buffer; csrBase64: string } {
  const problems = validateZatcaCsrInput(input);
  if (problems.length) throw new RangeError(`CSR input invalid: ${problems.join('; ')}`);
  const key = createPrivateKey(privateKeyPem);
  const spki = createPublicKey(key).export({ type: 'spki', format: 'der' });
  const subject = seq(rdn(OID.C, printable('SA')), rdn(OID.OU, utf8(input.organizationUnit)), rdn(OID.O, utf8(input.organizationName)), rdn(OID.CN, utf8(input.commonName)));
  const dirName = seq(rdn(OID.SN, utf8(input.egsSerial)), rdn(OID.UID, utf8(input.vatNumber)), rdn(OID.title, utf8(input.invoiceType)),
    rdn(OID.registeredAddress, utf8(input.location)), rdn(OID.businessCategory, utf8(input.industry)));
  const san = seq(ctx(4, dirName)); // GeneralNames: directoryName [4] EXPLICIT Name
  const extensions = seq(
    seq(oid(OID.certificateTemplateName), octet(printable(input.templateName ?? 'ZATCA-Code-Signing'))),
    seq(oid(OID.subjectAltName), octet(san)),
  );
  const attributes = ctx(0, seq(oid(OID.extensionRequest), setOf(extensions)));
  const info = seq(int(0), subject, spki, attributes);
  const signature = cryptoSign('sha256', info, key); // DER ECDSA-Sig-Value
  const der = seq(info, alg(OID.ecdsaWithSha256), bitString(signature));
  const pem = `-----BEGIN CERTIFICATE REQUEST-----\n${der.toString('base64').replace(/.{1,64}/g, '$&\n')}-----END CERTIFICATE REQUEST-----\n`;
  return { pem, der, csrBase64: Buffer.from(pem).toString('base64') };
}

/**
 * The CSID APIs return binarySecurityToken = Base64 of the Base64 DER certificate (decoding once yields the text a
 * PEM body holds). Accepts that, a bare Base64 DER, or PEM; returns PEM, and throws when it is not a certificate.
 */
export function certificateFromBinarySecurityToken(token: string): string {
  const candidates: string[] = [];
  const trimmed = token.trim();
  if (trimmed.startsWith('-----BEGIN')) candidates.push(trimmed);
  else {
    const once = Buffer.from(trimmed, 'base64').toString('latin1').trim();
    if (/^[A-Za-z0-9+/=\s]+$/.test(once)) candidates.push(once);
    candidates.push(trimmed);
  }
  for (const c of candidates) {
    try {
      const pem = c.startsWith('-----BEGIN') ? c : `-----BEGIN CERTIFICATE-----\n${c.replace(/\s+/g, '').replace(/.{1,64}/g, '$&\n')}-----END CERTIFICATE-----\n`;
      new X509Certificate(pem);
      return pem;
    } catch { /* try next */ }
  }
  throw new ProviderError('zatca_fatoora', 'binarySecurityToken is not a certificate', false);
}

// ---------------------------------------------------------------------------
// Cryptographic stamp (XAdES enveloped signature) and Phase-2 QR
// ---------------------------------------------------------------------------
const NS_DS = 'http://www.w3.org/2000/09/xmldsig#';
const NS_XADES = 'http://uri.etsi.org/01903/v1.3.2#';
const NS_SIG = 'urn:oasis:names:specification:ubl:schema:xsd:CommonSignatureComponents-2';
const NS_SAC = 'urn:oasis:names:specification:ubl:schema:xsd:SignatureAggregateComponents-2';
const NS_SBC = 'urn:oasis:names:specification:ubl:schema:xsd:SignatureBasicComponents-2';
const ROOT_NS: Array<[string, string]> = [
  ['', 'urn:oasis:names:specification:ubl:schema:xsd:Invoice-2'],
  ['cac', 'urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2'],
  ['cbc', 'urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2'],
  ['ext', 'urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2'],
];
const TRANSFORMS = ['not(//ancestor-or-self::ext:UBLExtensions)', 'not(//ancestor-or-self::cac:Signature)', "not(//ancestor-or-self::cac:AdditionalDocumentReference[cbc:ID='QR'])"];
const C14N11 = 'http://www.w3.org/2006/12/xml-c14n11';
const t = (name: string, text: string, attrs = '') => `<${name}${attrs}>${c14nText(text)}</${name}>`;
const nsDecls = (list: Array<[string, string]>) => [...list].sort((a, b) => a[0].localeCompare(b[0]))
  .map(([p, u]) => ` ${p ? `xmlns:${p}` : 'xmlns'}="${c14nAttr(u)}"`).join('');

/** The unsigned body (no XML declaration) that the transforms reduce a signed invoice to: its canonical form. */
export function zatcaCanonicalBody(doc: FiscalDocumentModel, previousInvoiceHash?: string | null): string {
  return buildZatcaInvoiceXml(doc, { previousInvoiceHash, includeQr: false }).replace(/^<\?xml[^>]*\?>\n/, '');
}

export interface ZatcaQrPhase2Input {
  sellerName: string; vatNumber: string; timestamp: string; totalWithVat: string; vatTotal: string;
  invoiceHash: Buffer; signature: Buffer; publicKey: Buffer;
  /** Simplified invoices and their notes: the ZATCA CA's signature of the stamp certificate. */
  certificateSignature?: Buffer | null;
}

/** TLV QR with Phase-2 tags 6–9 (Security Features standard §4). Each value ≤ 255 bytes; Base64 ≤ 700 chars. */
export function encodeZatcaQrPhase2(q: ZatcaQrPhase2Input): string {
  const values: Array<[number, Buffer]> = [
    [1, Buffer.from(q.sellerName, 'utf8')], [2, Buffer.from(q.vatNumber, 'utf8')], [3, Buffer.from(q.timestamp, 'utf8')],
    [4, Buffer.from(q.totalWithVat, 'utf8')], [5, Buffer.from(q.vatTotal, 'utf8')], [6, q.invoiceHash], [7, q.signature], [8, q.publicKey],
    ...(q.certificateSignature ? [[9, q.certificateSignature] as [number, Buffer]] : []),
  ];
  const out = Buffer.concat(values.map(([tag, v]) => {
    if (!v.length || v.length > 255) throw new RangeError(`ZATCA QR tag ${tag} must be 1..255 bytes (got ${v.length})`);
    return Buffer.concat([Buffer.from([tag, v.length]), v]);
  })).toString('base64');
  if (out.length > 700) throw new RangeError(`ZATCA QR is ${out.length} characters (max 700)`);
  return out;
}

export interface SignedZatcaInvoice {
  signedXml: string;
  /** Base64 SHA-256 of the canonical invoice (the PIH of the next invoice; sent as invoiceHash). */
  invoiceHash: string;
  signatureValue: string;
  qr: string;
  certificateHash: string;
  signedPropertiesHash: string;
}

/**
 * Stamps one invoice: canonical body → invoice hash → signature → XAdES SignedProperties → UBLExtensions,
 * QR reference and cac:Signature inserted where UBL 2.1 places them. The transforms in SignedInfo strip exactly
 * those three parts again, so the invoice hash of the signed document equals the one computed here.
 */
export function signZatcaInvoice(input: { doc: FiscalDocumentModel; previousInvoiceHash?: string | null; certificatePem: string; privateKeyPem: string; signingTime?: Date }): SignedZatcaInvoice {
  const { doc } = input;
  const key: KeyObject = createPrivateKey(input.privateKeyPem);
  const cert = new X509Certificate(input.certificatePem);
  if (!cert.checkPrivateKey(key)) throw new ProviderError('zatca_fatoora', 'the private key does not belong to the stamp certificate', false);
  const certDer = cert.raw;
  const parts = certificateParts(certDer);
  const body = zatcaCanonicalBody(doc, input.previousInvoiceHash);
  const hashBytes = createHash('sha256').update(body, 'utf8').digest();
  const invoiceHash = hashBytes.toString('base64');
  const signature = cryptoSign('sha256', Buffer.from(body, 'utf8'), key);
  const signatureValue = signature.toString('base64');
  const certificateHash = createHash('sha256').update(certDer).digest('base64');
  const signingTime = zatcaTimestamp(input.signingTime ?? new Date()).replace(/Z$/, '');

  // SigningCertificateV2 with the signing certificate's digest (the standard's table 1.6.2.1.1.2). Only the signing
  // certificate is referenced: the CA chain is not part of the CSID response.
  const signedPropertiesInner = `<xades:SignedSignatureProperties>${t('xades:SigningTime', signingTime)}<xades:SigningCertificateV2><xades:Cert><xades:CertDigest>`
    + `<ds:DigestMethod Algorithm="http://www.w3.org/2001/04/xmlenc#sha256"></ds:DigestMethod>${t('ds:DigestValue', certificateHash)}</xades:CertDigest>`
    + `</xades:Cert></xades:SigningCertificateV2></xades:SignedSignatureProperties>`;
  // Inclusive C14N 1.1 of the SignedProperties subtree renders every namespace in scope on its apex element.
  const inScope: Array<[string, string]> = [...ROOT_NS, ['sig', NS_SIG], ['sac', NS_SAC], ['sbc', NS_SBC], ['ds', NS_DS], ['xades', NS_XADES]];
  const signedPropertiesC14n = `<xades:SignedProperties${nsDecls(inScope)} Id="xadesSignedProperties">${signedPropertiesInner}</xades:SignedProperties>`;
  const signedPropertiesHash = createHash('sha256').update(signedPropertiesC14n, 'utf8').digest('base64');

  const transforms = TRANSFORMS.map((x) => `<ds:Transform Algorithm="http://www.w3.org/TR/1999/REC-xpath-19991116">${t('ds:XPath', x)}</ds:Transform>`).join('')
    + `<ds:Transform Algorithm="${C14N11}"></ds:Transform>`;
  const signedInfo = `<ds:SignedInfo><ds:CanonicalizationMethod Algorithm="${C14N11}"></ds:CanonicalizationMethod>`
    + `<ds:SignatureMethod Algorithm="http://www.w3.org/2001/04/xmldsig-more#ecdsa-sha256"></ds:SignatureMethod>`
    + `<ds:Reference Id="invoiceSignedData" URI=""><ds:Transforms>${transforms}</ds:Transforms>`
    + `<ds:DigestMethod Algorithm="http://www.w3.org/2001/04/xmlenc#sha256"></ds:DigestMethod>${t('ds:DigestValue', invoiceHash)}</ds:Reference>`
    + `<ds:Reference Type="http://uri.etsi.org/01903#SignedProperties" URI="#xadesSignedProperties">`
    + `<ds:DigestMethod Algorithm="http://www.w3.org/2001/04/xmlenc#sha256"></ds:DigestMethod>${t('ds:DigestValue', signedPropertiesHash)}</ds:Reference></ds:SignedInfo>`;
  const certB64 = certDer.toString('base64');
  const extension = `<ext:UBLExtensions><ext:UBLExtension>${t('ext:ExtensionURI', 'urn:oasis:names:specification:ubl:dsig:enveloped:xades')}<ext:ExtensionContent>`
    + `<sig:UBLDocumentSignatures${nsDecls([['sig', NS_SIG], ['sac', NS_SAC], ['sbc', NS_SBC]])}><sac:SignatureInformation>`
    + `${t('cbc:ID', 'urn:oasis:names:specification:ubl:signature:1')}${t('sbc:ReferencedSignatureID', 'urn:oasis:names:specification:ubl:signature:Invoice')}`
    + `<ds:Signature xmlns:ds="${NS_DS}" Id="signature">${signedInfo}${t('ds:SignatureValue', signatureValue)}`
    + `<ds:KeyInfo><ds:X509Data>${t('ds:X509Certificate', certB64)}</ds:X509Data></ds:KeyInfo>`
    + `<ds:Object><xades:QualifyingProperties xmlns:xades="${NS_XADES}" Target="signature"><xades:SignedProperties Id="xadesSignedProperties">${signedPropertiesInner}</xades:SignedProperties></xades:QualifyingProperties></ds:Object>`
    + `</ds:Signature></sac:SignatureInformation></sig:UBLDocumentSignatures></ext:ExtensionContent></ext:UBLExtension></ext:UBLExtensions>`;

  const simplified = doc.kind !== 'standard_invoice';
  const qr = encodeZatcaQrPhase2({
    sellerName: doc.seller.name, vatNumber: doc.seller.vatNumber, timestamp: zatcaTimestamp(doc.issuedAt),
    totalWithVat: formatFiscalMinor(doc.totals.grossMinor), vatTotal: formatFiscalMinor(doc.totals.vatMinor),
    invoiceHash: hashBytes, signature, publicKey: createPublicKey(key).export({ type: 'spki', format: 'der' }),
    certificateSignature: simplified ? parts.signatureValue : null,
  });
  const qrRef = `<cac:AdditionalDocumentReference>${t('cbc:ID', 'QR')}<cac:Attachment>${t('cbc:EmbeddedDocumentBinaryObject', qr, ' mimeCode="text/plain"')}</cac:Attachment></cac:AdditionalDocumentReference>`;
  const cacSignature = `<cac:Signature>${t('cbc:ID', 'urn:oasis:names:specification:ubl:signature:Invoice')}${t('cbc:SignatureMethod', 'urn:oasis:names:specification:ubl:dsig:enveloped:xades')}</cac:Signature>`;
  // UBL 2.1 order: UBLExtensions first; Signature after the AdditionalDocumentReferences, before AccountingSupplierParty.
  const open = body.indexOf('>') + 1;
  const supplier = body.indexOf('<cac:AccountingSupplierParty>');
  if (supplier < 0) throw new ProviderError('zatca_fatoora', 'invoice body has no AccountingSupplierParty', false);
  const signedXml = `<?xml version="1.0" encoding="UTF-8"?>\n${body.slice(0, open)}${extension}${body.slice(open, supplier)}${qrRef}${cacSignature}${body.slice(supplier)}`;
  return { signedXml, invoiceHash, signatureValue, qr, certificateHash, signedPropertiesHash };
}

/** Removes the parts the stamp's XPath transforms exclude (for checks: the result must equal the canonical body). */
export function stripZatcaSignature(signedXml: string): string {
  return signedXml.replace(/^<\?xml[^>]*\?>\n/, '')
    .replace(/<ext:UBLExtensions>[\s\S]*?<\/ext:UBLExtensions>/, '')
    .replace(/<cac:Signature>[\s\S]*?<\/cac:Signature>/, '')
    .replace(/<cac:AdditionalDocumentReference><cbc:ID>QR<\/cbc:ID>[\s\S]*?<\/cac:AdditionalDocumentReference>/, '');
}

// ---------------------------------------------------------------------------
// FATOORA gateway client
// ---------------------------------------------------------------------------
export type ZatcaEnvironment = 'sandbox' | 'simulation' | 'production';
/** Developer-portal path is from the manual and the live sandbox configuration; the other two are not verified. */
export const FATOORA_BASE: Record<ZatcaEnvironment, string> = {
  sandbox: 'https://gw-fatoora.zatca.gov.sa/e-invoicing/developer-portal',
  simulation: 'https://gw-fatoora.zatca.gov.sa/e-invoicing/simulation',
  production: 'https://gw-fatoora.zatca.gov.sa/e-invoicing/core',
};

export interface CsidResponse { requestId: string; dispositionMessage: string | null; binarySecurityToken: string; secret: string }
export interface FatooraValidation { status: string | null; reportingStatus: string | null; clearanceStatus: string | null; warnings: string[]; errors: string[]; clearedInvoice: string | null }
export type FatooraOutcome = { outcome: 'accepted' | 'accepted_with_warnings' | 'rejected' | 'clearance_required' } & FatooraValidation & { httpStatus: number };

export class FatooraClient {
  constructor(private readonly env: ZatcaEnvironment, private readonly fetchImpl: typeof fetch, private readonly language: 'en' | 'ar' = 'en') {}

  private async call(path: string, init: { headers: Record<string, string>; body: unknown }) {
    let res: Response;
    try {
      res = await this.fetchImpl(`${FATOORA_BASE[this.env]}${path}`, {
        method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(30_000),
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'Accept-Version': 'V2', 'Accept-Language': this.language, ...init.headers },
        body: JSON.stringify(init.body),
      });
    } catch (e) {
      throw new ProviderError('zatca_fatoora', `network error (${(e as Error).name})`, true);
    }
    const text = await res.text();
    let json: any = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
    return { status: res.status, json };
  }

  private csid(r: { status: number; json: any }, what: string): CsidResponse {
    if (r.status !== 200 || typeof r.json?.binarySecurityToken !== 'string' || typeof r.json?.secret !== 'string') {
      const errs = messages(r.json?.errors ?? r.json?.validationResults?.errorMessages);
      throw new ProviderError('zatca_fatoora', `${what} refused (HTTP ${r.status}${errs.length ? `: ${errs.join('; ').slice(0, 200)}` : ''})`, r.status >= 500 || r.status === 429, r.status);
    }
    return { requestId: String(r.json.requestID ?? ''), dispositionMessage: r.json.dispositionMessage ?? null, binarySecurityToken: r.json.binarySecurityToken, secret: r.json.secret };
  }

  /** POST /compliance with the OTP from the FATOORA portal: compliance CSID for the CSR. */
  async complianceCsid(otp: string, csrBase64: string): Promise<CsidResponse> {
    if (!/^\d{6}$/.test(otp)) throw new ProviderError('zatca_fatoora', 'OTP must be 6 digits', false);
    return this.csid(await this.call('/compliance', { headers: { OTP: otp }, body: { csr: csrBase64 } }), 'Compliance CSID');
  }

  /** POST /production/csids with the compliance request id (after the compliance checks passed). */
  async productionCsid(compliance: { binarySecurityToken: string; secret: string; requestId: string }): Promise<CsidResponse> {
    return this.csid(await this.call('/production/csids', { headers: { Authorization: basic(compliance) }, body: { compliance_request_id: compliance.requestId } }), 'Production CSID');
  }

  /** POST /compliance/invoices: one compliance check with the compliance CSID. */
  async complianceCheck(auth: { binarySecurityToken: string; secret: string }, s: { invoiceHash: string; uuid: string; invoiceXml: string }) {
    return outcome(await this.call('/compliance/invoices', { headers: { Authorization: basic(auth) }, body: { invoiceHash: s.invoiceHash, uuid: s.uuid, invoice: Buffer.from(s.invoiceXml).toString('base64') } }));
  }

  /** POST /invoices/reporting/single (simplified invoices and their notes, within 24 hours). */
  async report(auth: { binarySecurityToken: string; secret: string }, s: { invoiceHash: string; uuid: string; invoiceXml: string }) {
    return outcome(await this.call('/invoices/reporting/single', { headers: { Authorization: basic(auth) }, body: { invoiceHash: s.invoiceHash, uuid: s.uuid, invoice: Buffer.from(s.invoiceXml).toString('base64') } }));
  }

  /** POST /invoices/clearance/single (standard invoices, before sharing with the buyer). */
  async clear(auth: { binarySecurityToken: string; secret: string }, s: { invoiceHash: string; uuid: string; invoiceXml: string }) {
    return outcome(await this.call('/invoices/clearance/single', { headers: { Authorization: basic(auth) }, body: { invoiceHash: s.invoiceHash, uuid: s.uuid, invoice: Buffer.from(s.invoiceXml).toString('base64') } }));
  }
}

const basic = (a: { binarySecurityToken: string; secret: string }) => `Basic ${Buffer.from(`${a.binarySecurityToken}:${a.secret}`).toString('base64')}`;
function messages(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  return list.map((m: any) => (typeof m === 'string' ? m : [m?.code, m?.message].filter(Boolean).join(': '))).filter(Boolean).map((s: string) => s.slice(0, 300));
}

/** Manual FAQ: 200 OK, 202 accepted with warnings, 303 clearance is on (use clearance), 400 invalid, 401 auth, 5xx. */
function outcome(r: { status: number; json: any }): FatooraOutcome {
  const v = r.json?.validationResults ?? {};
  const base: FatooraValidation = {
    status: v.status ?? r.json?.status ?? null, reportingStatus: r.json?.reportingStatus ?? null, clearanceStatus: r.json?.clearanceStatus ?? null,
    warnings: messages(v.warningMessages), errors: messages(v.errorMessages), clearedInvoice: typeof r.json?.clearedInvoice === 'string' ? r.json.clearedInvoice : null,
  };
  if (r.status === 200) return { outcome: 'accepted', httpStatus: 200, ...base };
  if (r.status === 202) return { outcome: 'accepted_with_warnings', httpStatus: 202, ...base };
  if (r.status === 303) return { outcome: 'clearance_required', httpStatus: 303, ...base };
  if (r.status === 400) return { outcome: 'rejected', httpStatus: 400, ...base };
  throw new ProviderError('zatca_fatoora', `HTTP ${r.status}`, r.status >= 500 || r.status === 429, r.status);
}

