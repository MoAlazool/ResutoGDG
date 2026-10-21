// INT-26 / FT-24: ZATCA Phase-2 and ETA e-receipt building blocks. Vectors: ETA's published serialization example
// (byte for byte); DER encodings from X.690; everything else is checked by re-deriving or verifying with the key.
// When the openssl / xmllint binaries exist (developer machines, not required in CI) the same artefacts are also
// checked by them. Nothing is sent to ZATCA or the ETA (scripted fetch).
import { execFileSync } from 'node:child_process';
import { createHash, createPublicKey, generateKeyPairSync, sign, verify, X509Certificate, type KeyObject } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { alg, bitString, certificateParts, children, ctx, int, oid, printable, read, seq, setOf, time, utf8 } from './der';
import {
  buildEtaCadesBes, buildZatcaCsr, certificateFromBinarySecurityToken, encodeZatcaQrPhase2, etaBatchDigest, etaCadesMessageDigest, EtaReceiptClient,
  FatooraClient, generateZatcaKeyPair, serializeEtaJsonText, signZatcaInvoice, stripZatcaSignature, validateZatcaCsrInput, zatcaCanonicalBody,
  type FiscalDocumentModel,
} from './index';

const has = (bin: string) => { try { execFileSync(bin, ['--version'], { stdio: 'ignore' }); return true; } catch { return false; } };
const OPENSSL = has('openssl');
const XMLLINT = (() => { try { execFileSync('xmllint', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; } })();

/** Self-signed test certificate (test helper only: X.509 v3 TBSCertificate signed with the key). */
function selfSigned(privateKey: KeyObject, cn: string): string {
  const spki = createPublicKey(privateKey).export({ type: 'spki', format: 'der' });
  const ec = privateKey.asymmetricKeyType === 'ec';
  const sigAlg = ec ? alg('1.2.840.10045.4.3.2') : alg('1.2.840.113549.1.1.11', Buffer.from([0x05, 0x00]));
  const name = seq(setOf(seq(oid('2.5.4.6'), printable('SA'))), setOf(seq(oid('2.5.4.3'), utf8(cn))));
  const tbs = seq(ctx(0, int(2)), int(BigInt('0x0123456789abcdef')), sigAlg, name, seq(time(new Date('2026-01-01T00:00:00Z')), time(new Date('2030-01-01T00:00:00Z'))), name, spki);
  const der = seq(tbs, sigAlg, bitString(sign('sha256', tbs, privateKey)));
  return `-----BEGIN CERTIFICATE-----\n${der.toString('base64').replace(/.{1,64}/g, '$&\n')}-----END CERTIFICATE-----\n`;
}

const doc: FiscalDocumentModel = {
  kind: 'simplified_invoice', number: 'SINV-000001', uuid: '6f4d20e0-6bfe-4a80-9389-7dabe6620f12', counterValue: 1,
  issuedAt: '2026-10-17T12:30:00.000Z', currency: 'SAR', previousHash: null,
  seller: { name: 'Resuto "Café" & Grill', vatNumber: '310122393500003', country: 'SA', address: { street: 'King Fahd Rd', buildingNumber: '1234', district: 'Olaya', city: 'Riyadh', postalCode: '12345' } },
  buyer: {}, paymentMethod: 'cash',
  lines: [{ code: 'p1', name: 'Burger <large>', quantity: 2, netMinor: 20000, discountMinor: 0, vatMinor: 3000, grossMinor: 23000, vatRateBp: 1500 }],
  totals: { netMinor: 20000, vatMinor: 3000, grossMinor: 23000, discountMinor: 0 },
} as FiscalDocumentModel;

describe('DER', () => {
  it('encodes OIDs, integers and lengths per X.690', () => {
    expect(oid('1.2.840.113549').toString('hex')).toBe('06062a864886f70d');
    expect(oid('2.5.4.3').toString('hex')).toBe('0603550403');
    expect(int(0).toString('hex')).toBe('020100');
    expect(int(128).toString('hex')).toBe('02020080');
    expect(int(Buffer.from([0, 0, 1])).toString('hex')).toBe('020101');
    const long = seq(Buffer.alloc(200, 1));
    expect(long.subarray(0, 3).toString('hex')).toBe('3081c8');
    expect(read(long).length).toBe(200);
    expect(time(new Date('2026-10-21T10:00:00Z')).toString('latin1').slice(2)).toBe('261021100000Z');
    // SET OF is sorted by encoding.
    expect(setOf(int(5), int(1)).toString('hex')).toBe('3106020101020105');
  });
});

describe('ZATCA onboarding: CSR', () => {
  const input = { commonName: 'EGS1-886431145', organizationUnit: 'Riyadh Branch', organizationName: 'Resuto Café', egsSerial: '1-Resuto|2-2.0|3-ed22f1d8',
    vatNumber: '310122393500003', invoiceType: '1100', location: 'RRRD2929', industry: 'Food and beverage' };

  it('validates the inputs the standard constrains', () => {
    expect(validateZatcaCsrInput(input)).toEqual([]);
    expect(validateZatcaCsrInput({ ...input, vatNumber: '123', egsSerial: 'abc', invoiceType: '0000' })).toHaveLength(3);
    expect(validateZatcaCsrInput({ ...input, vatNumber: '310122393510003', organizationUnit: 'Branch' })).toEqual(['VAT group: organizationUnit must be the 10-digit TIN of the member']);
  });

  it('builds a secp256k1 PKCS#10 request with the manual\'s subject, SAN and template extension, signed by the key', () => {
    const keys = generateZatcaKeyPair();
    expect(keys.privateKeyPem).toContain('BEGIN PRIVATE KEY');
    const csr = buildZatcaCsr(input, keys.privateKeyPem);
    expect(Buffer.from(csr.csrBase64, 'base64').toString()).toBe(csr.pem);
    const [info, sigAlg, sig] = children(read(csr.der));
    expect(sigAlg!.raw.toString('hex')).toBe(alg('1.2.840.10045.4.3.2').toString('hex'));
    expect(verify('sha256', info!.raw, createPublicKey(keys.publicKeyPem), sig!.content.subarray(1))).toBe(true);
    const hex = csr.der.toString('hex');
    for (const s of ['ZATCA-Code-Signing', '1-Resuto|2-2.0|3-ed22f1d8', '310122393500003', 'RRRD2929', 'Food and beverage', 'Riyadh Branch']) {
      expect(hex).toContain(Buffer.from(s).toString('hex'));
    }
    expect(hex).toContain(oid('1.3.6.1.4.1.311.20.2').toString('hex'));
    expect(hex).toContain(oid('1.3.132.0.10').toString('hex')); // secp256k1
    expect(() => buildZatcaCsr({ ...input, vatNumber: '1' }, keys.privateKeyPem)).toThrow(/vatNumber/);
    if (OPENSSL) {
      const dir = mkdtempSync(join(tmpdir(), 'zatca-'));
      writeFileSync(join(dir, 'r.csr'), csr.pem);
      expect(execFileSync('openssl', ['req', '-in', join(dir, 'r.csr'), '-noout', '-verify'], { stdio: ['ignore', 'pipe', 'pipe'] }).toString() + 'ok').toContain('ok');
    }
  });

  it('reads the certificate out of a binarySecurityToken (Base64 of the Base64 DER)', () => {
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'secp256k1' });
    const pem = selfSigned(privateKey, 'EGS1');
    const b64Der = new X509Certificate(pem).raw.toString('base64');
    const token = Buffer.from(b64Der).toString('base64');
    expect(new X509Certificate(certificateFromBinarySecurityToken(token)).raw.equals(new X509Certificate(pem).raw)).toBe(true);
    expect(new X509Certificate(certificateFromBinarySecurityToken(b64Der)).subject).toContain('EGS1');
    expect(() => certificateFromBinarySecurityToken('bm90IGEgY2VydA==')).toThrow(/not a certificate/);
  });
});

describe('ZATCA cryptographic stamp', () => {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'secp256k1' });
  const keyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const certPem = selfSigned(privateKey, 'EGS1-886431145');
  const signed = signZatcaInvoice({ doc, certificatePem: certPem, privateKeyPem: keyPem, signingTime: new Date('2026-10-17T12:30:05Z') });

  it('the stamp transforms reduce the signed invoice to the canonical body, whose hash is the invoice hash', () => {
    const body = zatcaCanonicalBody(doc);
    expect(stripZatcaSignature(signed.signedXml)).toBe(body);
    expect(signed.invoiceHash).toBe(createHash('sha256').update(body).digest('base64'));
    // Canonical escaping: quotes stay literal in text, < and & are escaped.
    expect(body).toContain('Resuto "Café" &amp; Grill');
    expect(body).toContain('Burger &lt;large&gt;');
    expect(signed.signedXml).toContain(`<ds:DigestValue>${signed.invoiceHash}</ds:DigestValue>`);
    expect(signed.signedXml.indexOf('<ext:UBLExtensions>')).toBe(signed.signedXml.indexOf('<Invoice') + signed.signedXml.slice(signed.signedXml.indexOf('<Invoice')).indexOf('>') + 1);
    expect(signed.signedXml.indexOf('<cac:Signature>')).toBeLessThan(signed.signedXml.indexOf('<cac:AccountingSupplierParty>'));
    expect(signed.signedXml).toContain('<cbc:SignatureMethod>urn:oasis:names:specification:ubl:dsig:enveloped:xades</cbc:SignatureMethod>');
  });

  it('the signature verifies with the certificate key over the canonical invoice', () => {
    const ok = verify('sha256', Buffer.from(zatcaCanonicalBody(doc)), new X509Certificate(certPem).publicKey, Buffer.from(signed.signatureValue, 'base64'));
    expect(ok).toBe(true);
  });

  it('the Phase-2 QR carries tags 1-9 with the hash, signature, public key and the certificate signature', () => {
    const buf = Buffer.from(signed.qr, 'base64');
    const tags: Record<number, Buffer> = {};
    for (let i = 0; i < buf.length;) { tags[buf[i]!] = buf.subarray(i + 2, i + 2 + buf[i + 1]!); i += 2 + buf[i + 1]!; }
    expect(Object.keys(tags).map(Number)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(tags[1]!.toString()).toBe('Resuto "Café" & Grill');
    expect(tags[4]!.toString()).toBe('230.00');
    expect(tags[6]!.toString('base64')).toBe(signed.invoiceHash);
    expect(tags[7]!.toString('base64')).toBe(signed.signatureValue);
    expect(tags[8]!.equals(new X509Certificate(certPem).publicKey.export({ type: 'spki', format: 'der' }))).toBe(true);
    expect(tags[9]!.equals(certificateParts(new X509Certificate(certPem).raw).signatureValue)).toBe(true);
    expect(() => encodeZatcaQrPhase2({ sellerName: 'x'.repeat(256), vatNumber: '1', timestamp: 't', totalWithVat: '1', vatTotal: '1', invoiceHash: Buffer.alloc(32), signature: Buffer.alloc(70), publicKey: Buffer.alloc(88) })).toThrow(/tag 1/);
  });

  it('refuses a key that does not match the certificate', () => {
    const other = generateKeyPairSync('ec', { namedCurve: 'secp256k1' }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    expect(() => signZatcaInvoice({ doc, certificatePem: certPem, privateKeyPem: other })).toThrow(/does not belong/);
  });

  it.runIf(XMLLINT)('libxml2 C14N 1.1 of the builder body is byte-identical (xmllint)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'zatca-'));
    writeFileSync(join(dir, 'b.xml'), zatcaCanonicalBody(doc));
    expect(execFileSync('xmllint', ['--c14n11', join(dir, 'b.xml')]).toString()).toBe(zatcaCanonicalBody(doc));
  });
});

describe('FATOORA client (scripted)', () => {
  function gateway(responses: Array<{ status: number; body: unknown }>) {
    const calls: Array<{ url: string; headers: Record<string, string>; body: any }> = [];
    const f = (async (url: string, init: RequestInit) => {
      calls.push({ url, headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) });
      const r = responses.shift()!;
      return new Response(JSON.stringify(r.body), { status: r.status });
    }) as unknown as typeof fetch;
    return { calls, f };
  }

  it('onboards: compliance CSID with OTP, compliance check and production CSID with Basic auth', async () => {
    const g = gateway([
      { status: 200, body: { requestID: 1234567890123, dispositionMessage: 'ISSUED', binarySecurityToken: 'VE9LRU4=', secret: 's3cr3t', errors: null } },
      { status: 200, body: { validationResults: { status: 'PASS', warningMessages: [], errorMessages: [] }, reportingStatus: 'REPORTED' } },
      { status: 200, body: { requestID: 99, binarySecurityToken: 'UFJPRA==', secret: 'p' } },
    ]);
    const c = new FatooraClient('sandbox', g.f);
    const csid = await c.complianceCsid('123345', 'Q1NS');
    expect(csid).toEqual({ requestId: '1234567890123', dispositionMessage: 'ISSUED', binarySecurityToken: 'VE9LRU4=', secret: 's3cr3t' });
    expect(g.calls[0]).toMatchObject({ url: 'https://gw-fatoora.zatca.gov.sa/e-invoicing/developer-portal/compliance', body: { csr: 'Q1NS' } });
    expect(g.calls[0]!.headers).toMatchObject({ OTP: '123345', 'Accept-Version': 'V2' });
    const check = await c.complianceCheck(csid, { invoiceHash: 'h', uuid: 'u', invoiceXml: '<x/>' });
    expect(check).toMatchObject({ outcome: 'accepted', reportingStatus: 'REPORTED', errors: [] });
    expect(g.calls[1]!.url).toBe('https://gw-fatoora.zatca.gov.sa/e-invoicing/developer-portal/compliance/invoices');
    expect(g.calls[1]!.body).toEqual({ invoiceHash: 'h', uuid: 'u', invoice: Buffer.from('<x/>').toString('base64') });
    expect(g.calls[1]!.headers.Authorization).toBe(`Basic ${Buffer.from('VE9LRU4=:s3cr3t').toString('base64')}`);
    await c.productionCsid(csid);
    expect(g.calls[2]).toMatchObject({ url: 'https://gw-fatoora.zatca.gov.sa/e-invoicing/developer-portal/production/csids', body: { compliance_request_id: '1234567890123' } });
  });

  it('maps reporting outcomes (200, 202 warnings, 303 clearance on, 400 rejected) and fails on auth/server errors', async () => {
    const g = gateway([
      { status: 202, body: { validationResults: { warningMessages: [{ code: 'BR-KSA-08', message: 'w' }], errorMessages: [] }, reportingStatus: 'REPORTED' } },
      { status: 303, body: {} },
      { status: 400, body: { validationResults: { errorMessages: [{ code: 'invoiceHash_QRCODE_INVALID', message: 'Invoice xml hash does not match with qr code invoice xml hash' }] }, status: 'ERROR' } },
      { status: 401, body: {} },
      { status: 503, body: {} },
    ]);
    const c = new FatooraClient('sandbox', g.f);
    const auth = { binarySecurityToken: 't', secret: 's' };
    const s = { invoiceHash: 'h', uuid: 'u', invoiceXml: '<x/>' };
    expect(await c.report(auth, s)).toMatchObject({ outcome: 'accepted_with_warnings', warnings: ['BR-KSA-08: w'] });
    expect(await c.report(auth, s)).toMatchObject({ outcome: 'clearance_required' });
    expect(await c.clear(auth, s)).toMatchObject({ outcome: 'rejected', errors: ['invoiceHash_QRCODE_INVALID: Invoice xml hash does not match with qr code invoice xml hash'] });
    await expect(c.report(auth, s)).rejects.toMatchObject({ retryable: false, status: 401 });
    await expect(c.report(auth, s)).rejects.toMatchObject({ retryable: true, status: 503 });
    expect(g.calls.map((x) => x.url.split('/e-invoicing/developer-portal')[1])).toEqual(['/invoices/reporting/single', '/invoices/reporting/single', '/invoices/clearance/single', '/invoices/reporting/single', '/invoices/reporting/single']);
    await expect(c.complianceCsid('12', 'x')).rejects.toThrow(/6 digits/);
  });
});

describe('ETA e-receipt', () => {
  it('serializes ETA\'s published example document byte for byte (number literals preserved)', () => {
    const raw = readFileSync(join(__dirname, 'fixtures/eta-one-doc.json'), 'utf8');
    const expected = readFileSync(join(__dirname, 'fixtures/eta-one-doc-serialized.txt'), 'utf8');
    expect(serializeEtaJsonText(raw)).toBe(expected);
  });

  it('builds a CAdES-BES whose messageDigest is the batch digest and whose signature verifies (RSA and EC)', () => {
    const { digest, serialized } = etaBatchDigest([{ header: { receiptNumber: 'R-1', totalAmount: 10.5 } }]);
    expect(serialized).toBe('"RECEIPTS""RECEIPTS""HEADER""RECEIPTNUMBER""R-1""TOTALAMOUNT""10.5"');
    for (const kind of ['rsa', 'ec'] as const) {
      const { privateKey } = kind === 'rsa' ? generateKeyPairSync('rsa', { modulusLength: 2048 }) : generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
      const certPem = selfSigned(privateKey, 'Test Sealing');
      const b64 = buildEtaCadesBes({ digest, certificatePem: certPem, privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), signingTime: new Date('2026-10-21T10:00:00Z') });
      expect(etaCadesMessageDigest(b64)!.equals(digest)).toBe(true);
      if (OPENSSL) {
        const dir = mkdtempSync(join(tmpdir(), 'eta-'));
        writeFileSync(join(dir, 's.p7s'), Buffer.from(b64, 'base64'));
        writeFileSync(join(dir, 'c.bin'), serialized);
        const out = execFileSync('openssl', ['cms', '-verify', '-inform', 'DER', '-in', join(dir, 's.p7s'), '-binary', '-content', join(dir, 'c.bin'), '-noverify', '-purpose', 'any', '-out', join(dir, 'o')], { stdio: ['ignore', 'pipe', 'pipe'] });
        expect(out).toBeDefined();
      }
    }
  });

  const creds = { clientId: 'cid', clientSecret: 'csecret', posSerial: 'POS-1', posOsVersion: 'os', posModelFramework: '1', presharedKey: 'psk' };
  const signer = (() => {
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    return { certificatePem: selfSigned(privateKey, 'Seal'), privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() };
  })();
  function eta(script: Array<(url: string, init: RequestInit) => { status: number; body?: unknown; headers?: Record<string, string> }>) {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const f = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      const r = script.shift()!(url, init);
      return new Response(r.body === undefined ? '' : JSON.stringify(r.body), { status: r.status, headers: r.headers });
    }) as unknown as typeof fetch;
    return { calls, f };
  }
  const token = () => ({ status: 200, body: { access_token: 'jwt', token_type: 'Bearer', expires_in: 3600 } });

  it('logs the POS in with client credentials and the POS headers, then submits signed batches', async () => {
    const e = eta([token, (_u, init) => ({ status: 202, body: { submissionUUID: 'TZRKK8MFZCPSTW9XCYWBMKME10', acceptedDocuments: [{ uuid: 'a'.repeat(64), longId: 'L1', receiptNumber: 'R-1' }], rejectedDocuments: [] }, init } as any)]);
    const c = new EtaReceiptClient('preprod', creds, e.f, async () => {});
    const r = await c.submit([{ header: { receiptNumber: 'R-1' } }], signer);
    expect(r).toEqual({ submissionUuid: 'TZRKK8MFZCPSTW9XCYWBMKME10', accepted: [{ uuid: 'a'.repeat(64), longId: 'L1', receiptNumber: 'R-1' }], rejected: [], batches: 1 });
    expect(e.calls[0]!.url).toBe('https://id.preprod.eta.gov.eg/connect/token');
    expect(e.calls[0]!.init.headers).toMatchObject({ posserial: 'POS-1', pososversion: 'os', posmodelframework: '1', presharedkey: 'psk' });
    expect(Object.fromEntries(new URLSearchParams(String(e.calls[0]!.init.body)))).toEqual({ grant_type: 'client_credentials', client_id: 'cid', client_secret: 'csecret' });
    expect(e.calls[1]!.url).toBe('https://api.preprod.invoicing.eta.gov.eg/api/v1/receiptsubmissions');
    const body = JSON.parse(String(e.calls[1]!.init.body));
    expect(body.receipts).toEqual([{ header: { receiptNumber: 'R-1' } }]);
    expect(body.signatures[0].signatureType).toBe('I');
    expect(etaCadesMessageDigest(body.signatures[0].value)!.equals(etaBatchDigest(body.receipts).digest)).toBe(true);
    expect((e.calls[1]!.init.headers as Record<string, string>).Authorization).toBe('Bearer jwt');
  });

  it('splits a batch on MaximumSizeExceeded, waits once on DuplicateSubmission, re-logs in on 401', async () => {
    const waits: number[] = [];
    const e = eta([
      token,
      () => ({ status: 400, body: { error: { code: 'MaximumSizeExceeded', message: 'too big' } } }),
      () => ({ status: 202, body: { submissionUUID: 'SUBMISSION00000000000000001', acceptedDocuments: [{ uuid: 'u1', receiptNumber: 'R-1' }] } }),
      () => ({ status: 422, body: { error: { code: 'DuplicateSubmission' } }, headers: { 'Retry-After': '3' } }),
      () => ({ status: 401 }),
      token,
      () => ({ status: 202, body: { submissionUUID: 'SUBMISSION00000000000000002', acceptedDocuments: [{ uuid: 'u2', receiptNumber: 'R-2' }], rejectedDocuments: [{ uuid: 'u3', receiptNumber: 'R-3', error: { message: 'Issuance date time value is out of the range' } }] } }),
    ]);
    const c = new EtaReceiptClient('production', creds, e.f, async (ms) => { waits.push(ms); });
    const r = await c.submit([{ n: 1 }, { n: 2 }, { n: 3 }], signer);
    expect(r.batches).toBe(2);
    expect(r.accepted.map((a) => a.uuid)).toEqual(['u1', 'u2']);
    expect(r.rejected).toEqual([{ uuid: 'u3', receiptNumber: 'R-3', error: 'Issuance date time value is out of the range' }]);
    expect(waits).toEqual([3000]);
    const posted = e.calls.filter((x) => x.url.endsWith('/receiptsubmissions')).map((x) => JSON.parse(String(x.init.body)).receipts.length);
    expect(posted).toEqual([3, 2, 1, 1, 1]);
    expect(e.calls[0]!.url).toBe('https://id.eta.gov.eg/connect/token');
  });

  it('a single oversized receipt, a refused login and throttling are reported as errors', async () => {
    await expect(new EtaReceiptClient('preprod', creds, eta([token, () => ({ status: 400, body: { error: { code: 'MaximumSizeExceeded' } } })]).f).submit([{ big: true }], signer))
      .rejects.toMatchObject({ retryable: false });
    await expect(new EtaReceiptClient('preprod', creds, eta([() => ({ status: 400, body: { error: 'invalid_presharedkey' } })]).f).accessToken())
      .rejects.toThrow(/invalid_presharedkey/);
    await expect(new EtaReceiptClient('preprod', creds, eta([token, () => ({ status: 429 })]).f).submit([{}], signer)).rejects.toMatchObject({ retryable: true, status: 429 });
  });

  it('reads the submission status', async () => {
    const e = eta([token, () => ({ status: 200, body: { status: 'Invalid', receiptsCount: 2, invalidReceiptCount: 1, receipts: [{ uuid: 'u1', receiptNumber: 'R-1', status: 'Valid' }, { uuid: 'u2', receiptNumber: 'R-2', status: 'Invalid' }] } })]);
    const s = await new EtaReceiptClient('preprod', creds, e.f).submission('TZRKK8MFZCPSTW9XCYWBMKME10');
    expect(s).toEqual({ status: 'Invalid', receiptsCount: 2, invalidReceiptCount: 1, receipts: [{ uuid: 'u1', receiptNumber: 'R-1', status: 'Valid' }, { uuid: 'u2', receiptNumber: 'R-2', status: 'Invalid' }] });
    expect(e.calls[1]!.url).toBe('https://api.preprod.invoicing.eta.gov.eg/api/v1/receiptsubmissions/TZRKK8MFZCPSTW9XCYWBMKME10/details?PageNo=1&PageSize=100');
  });
});
