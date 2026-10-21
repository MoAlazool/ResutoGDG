// ETA e-receipt (Egypt) submission: POS authentication, batch serialization + CAdES-BES issuer signature, batched
// submission with MaximumSizeExceeded / DuplicateSubmission handling, and submission status polling.
//
// IMPLEMENTATION INCOMPLETE — NOT CERTIFIED. Built from the ETA SDK pages (sources below); checked locally (the
// serializer reproduces ETA's published serialization example byte for byte; the CMS structure matches ETA's parsed
// CAdES-BES sample and verifies with OpenSSL against the serialized content). No ETA preprod call has been made.
// ETA states that issuer signatures are not validated yet ("The function to perform signature validation will not be
// deployed at this point"); the batch-level serialization root ({ receipts }) follows the batch-signature page and is
// therefore unconfirmed by a validator.
//
// Sources (fetched 2026-10-21):
//   POST {id}/connect/token, client_credentials + headers posserial, pososversion, posmodelframework, presharedkey:
//     https://sdk.invoicing.eta.gov.eg/ereceiptapi/01-authenticate-pos/
//   POST {api}/api/v1/receiptsubmissions { receipts, signatures: [{ signatureType: "I", value }] } → 202
//     { submissionUUID, acceptedDocuments, rejectedDocuments }; 400 BadStructure / MaximumSizeExceeded, 403
//     IncorrectSubmitter, 422 DuplicateSubmission + Retry-After: https://sdk.invoicing.eta.gov.eg/ereceiptapi/02-submit-receipt/
//   GET {api}/api/v1/receiptsubmissions/{submissionUuid}/details?PageNo&PageSize → status InProgress | Valid | Invalid:
//     https://sdk.invoicing.eta.gov.eg/ereceiptapi/06-get-receipt-submission/
//   Serialization: https://sdk.invoicing.eta.gov.eg/document-serialization-approach/
//   Signing: https://sdk.invoicing.eta.gov.eg/receipt-batch-signature-creation/ (+ /files/parsed-cades-bes.txt)
//   Hosts (preprod / production): https://sdk.invoicing.eta.gov.eg/faq/
//   Rate limiting (429 / 503): https://sdk.invoicing.eta.gov.eg/apigovernance/
import { createHash, createPrivateKey, sign as cryptoSign, X509Certificate } from 'node:crypto';
import { ProviderError } from '../core';
import { alg, certificateParts, ctx, int, octet, oid, seq, setOf, time } from './der';

// ---------------------------------------------------------------------------
// Serialization (number literals preserved exactly as written in the JSON text)
// ---------------------------------------------------------------------------
type Raw = { k: 'scalar'; text: string } | { k: 'array'; items: Raw[] } | { k: 'object'; entries: Array<[string, Raw]> };

/** Parses JSON keeping property order and the literal text of numbers ("10.50" stays "10.50"). */
export function parseEtaJson(text: string): Raw {
  let i = 0;
  const ws = () => { while (i < text.length && /\s/.test(text[i]!)) i++; };
  const str = (): string => {
    const start = i;
    i++;
    while (text[i] !== '"') { if (text[i] === '\\') i++; i++; if (i >= text.length) throw new SyntaxError('unterminated string'); }
    i++;
    return JSON.parse(text.slice(start, i)) as string;
  };
  const value = (): Raw => {
    ws();
    const c = text[i];
    if (c === '{') {
      i++;
      const entries: Array<[string, Raw]> = [];
      ws();
      if (text[i] === '}') { i++; return { k: 'object', entries }; }
      for (;;) {
        ws();
        const key = str();
        ws();
        if (text[i++] !== ':') throw new SyntaxError('expected :');
        entries.push([key, value()]);
        ws();
        if (text[i] === ',') { i++; continue; }
        if (text[i] === '}') { i++; return { k: 'object', entries }; }
        throw new SyntaxError(`unexpected ${text[i]} at ${i}`);
      }
    }
    if (c === '[') {
      i++;
      const items: Raw[] = [];
      ws();
      if (text[i] === ']') { i++; return { k: 'array', items }; }
      for (;;) {
        items.push(value());
        ws();
        if (text[i] === ',') { i++; continue; }
        if (text[i] === ']') { i++; return { k: 'array', items }; }
        throw new SyntaxError(`unexpected ${text[i]} at ${i}`);
      }
    }
    if (c === '"') return { k: 'scalar', text: str() };
    const m = /^(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/.exec(text.slice(i));
    if (!m) throw new SyntaxError(`unexpected token at ${i}`);
    i += m[0].length;
    return { k: 'scalar', text: m[0] === 'null' ? '' : m[0] };
  };
  const out = value();
  ws();
  if (i !== text.length) throw new SyntaxError('trailing data');
  return out;
}

function serializeRaw(v: Raw): string {
  if (v.k === 'scalar') return `"${v.text}"`;
  if (v.k === 'array') return v.items.map(serializeRaw).join('');
  let out = '';
  for (const [name, value] of v.entries) {
    const upper = name.toUpperCase();
    if (value.k === 'array') out += `"${upper}"${value.items.map((item) => `"${upper}"${serializeRaw(item)}`).join('')}`;
    else out += `"${upper}"${serializeRaw(value)}`;
  }
  return out;
}

/** ETA "Document Serialization Approach" (JSON) over the exact JSON text that is sent. */
export const serializeEtaJsonText = (json: string) => serializeRaw(parseEtaJson(json.replace(/^﻿/, '')));

/** SHA-256 of the serialized batch { receipts } (the value the CAdES-BES messageDigest carries). */
export function etaBatchDigest(receipts: unknown[]): { json: string; serialized: string; digest: Buffer } {
  const json = JSON.stringify({ receipts });
  const serialized = serializeEtaJsonText(json);
  return { json, serialized, digest: createHash('sha256').update(serialized, 'utf8').digest() };
}

// ---------------------------------------------------------------------------
// CAdES-BES (CMS SignedData, detached, eContentType id-digestedData), as in ETA's parsed sample
// ---------------------------------------------------------------------------
const OIDS = {
  signedData: '1.2.840.113549.1.7.2', digestedData: '1.2.840.113549.1.7.5', sha256: '2.16.840.1.101.3.4.2.1', contentType: '1.2.840.113549.1.9.3',
  signingTime: '1.2.840.113549.1.9.5', messageDigest: '1.2.840.113549.1.9.4', signingCertificateV2: '1.2.840.113549.1.9.16.2.47',
  rsaEncryption: '1.2.840.113549.1.1.1', ecdsaWithSha256: '1.2.840.10045.4.3.2',
};

/**
 * Builds the issuer signature for a batch: SignedData v3 with the signing certificate, one SignerInfo v1
 * (issuerAndSerialNumber) whose signed attributes are contentType, signingTime, messageDigest (= digest) and
 * signingCertificateV2. Returns Base64 DER. RSA (as in ETA's sample) and EC keys are supported.
 */
export function buildEtaCadesBes(input: { digest: Buffer; certificatePem: string; privateKeyPem: string; signingTime?: Date }): string {
  if (input.digest.length !== 32) throw new RangeError('digest must be SHA-256 (32 bytes)');
  const cert = new X509Certificate(input.certificatePem);
  const key = createPrivateKey(input.privateKeyPem);
  if (!cert.checkPrivateKey(key)) throw new ProviderError('eta_ereceipt', 'the private key does not belong to the signing certificate', false);
  const der = cert.raw;
  const p = certificateParts(der);
  const issuerSerial = seq(seq(ctx(4, p.issuer)), p.serialNumber);
  const attrs = [
    seq(oid(OIDS.contentType), setOf(oid(OIDS.digestedData))),
    seq(oid(OIDS.signingTime), setOf(time(input.signingTime ?? new Date()))),
    seq(oid(OIDS.messageDigest), setOf(octet(input.digest))),
    seq(oid(OIDS.signingCertificateV2), setOf(seq(seq(seq(octet(createHash('sha256').update(der).digest()), issuerSerial))))),
  ];
  const signedAttrsSet = setOf(...attrs); // what is signed: the SET OF encoding (RFC 5652 5.4)
  const rsa = key.asymmetricKeyType === 'rsa';
  const signature = cryptoSign('sha256', signedAttrsSet, key);
  const signerInfo = seq(
    int(1), seq(p.issuer, p.serialNumber), alg(OIDS.sha256),
    Buffer.concat([Buffer.from([0xa0]), signedAttrsSet.subarray(1)]), // [0] IMPLICIT SET OF Attribute
    rsa ? alg(OIDS.rsaEncryption) : alg(OIDS.ecdsaWithSha256), octet(signature),
  );
  const signedData = seq(int(3), setOf(alg(OIDS.sha256)), seq(oid(OIDS.digestedData)), ctx(0, der), setOf(signerInfo));
  return seq(oid(OIDS.signedData), ctx(0, signedData)).toString('base64');
}

/** Reads back the messageDigest of a CAdES-BES produced above (for checks and diagnostics). */
export function etaCadesMessageDigest(b64: string): Buffer | null {
  const hex = Buffer.from(b64, 'base64').toString('hex');
  const marker = `06092a864886f70d010904` + '3122' + '0420'; // messageDigest OID, SET len 34, OCTET STRING len 32
  const at = hex.indexOf(marker);
  if (at < 0) return null;
  const start = (at + marker.length) / 2;
  return Buffer.from(b64, 'base64').subarray(start, start + 32);
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------
export type EtaEnvironment = 'preprod' | 'production';
export const ETA_HOSTS: Record<EtaEnvironment, { identity: string; api: string }> = {
  preprod: { identity: 'https://id.preprod.eta.gov.eg', api: 'https://api.preprod.invoicing.eta.gov.eg' },
  production: { identity: 'https://id.eta.gov.eg', api: 'https://api.invoicing.eta.gov.eg' },
};

export interface EtaPosCredentials { clientId: string; clientSecret: string; posSerial: string; posOsVersion: string; posModelFramework: string; presharedKey: string }
export interface EtaSigner { certificatePem: string; privateKeyPem: string }
export interface EtaBatchResult {
  /** The first submission's UUID (kept for callers that sent one batch); use each entry's own submissionUuid. */
  submissionUuid: string | null;
  /** Every submission UUID ETA returned, in order (more than one when MaximumSizeExceeded split the batch). */
  submissionUuids: string[];
  accepted: Array<{ uuid: string; longId: string | null; receiptNumber: string | null; submissionUuid: string | null }>;
  rejected: Array<{ uuid: string | null; receiptNumber: string | null; error: string; submissionUuid: string | null }>;
  /**
   * Receipts of a sub-batch that failed after another sub-batch had already gone through: not submitted, with the
   * error (retryable or not). The results that ETA did accept are never thrown away because a later half failed.
   */
  unsent: Array<{ uuids: string[]; error: ProviderError }>;
  batches: number;
}

const receiptUuid = (r: unknown): string | null => {
  const u = (r as { header?: { uuid?: unknown } } | null)?.header?.uuid;
  return typeof u === 'string' && u ? u : null;
};

export class EtaReceiptClient {
  private token: { value: string; expiresAt: number } | null = null;

  constructor(private readonly env: EtaEnvironment, private readonly creds: EtaPosCredentials, private readonly fetchImpl: typeof fetch,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))) {}

  /** POS login (client credentials). Tokens are cached until 60 s before expiry. */
  async accessToken(force = false): Promise<string> {
    if (!force && this.token && this.token.expiresAt > Date.now() + 60_000) return this.token.value;
    const body = new URLSearchParams({ grant_type: 'client_credentials', client_id: this.creds.clientId, client_secret: this.creds.clientSecret });
    const res = await this.fetchSafe(`${ETA_HOSTS[this.env].identity}/connect/token`, {
      method: 'POST', body: body.toString(),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', posserial: this.creds.posSerial, pososversion: this.creds.posOsVersion,
        posmodelframework: this.creds.posModelFramework, presharedkey: this.creds.presharedKey },
    });
    const json = await res.json().catch(() => null) as any;
    if (res.status !== 200 || typeof json?.access_token !== 'string') {
      const code = typeof json?.error === 'string' && /^[a-z_]{3,40}$/.test(json.error) ? json.error : null;
      throw new ProviderError('eta_ereceipt', `POS authentication failed (HTTP ${res.status}${code ? `, ${code}` : ''})`, res.status >= 500 || res.status === 429, res.status);
    }
    this.token = { value: json.access_token, expiresAt: Date.now() + (Number(json.expires_in) > 0 ? Number(json.expires_in) * 1000 : 3_600_000) };
    return json.access_token;
  }

  /**
   * Signs and submits receipts. On MaximumSizeExceeded the batch is split in halves (each half signed anew) until it
   * fits; every accepted / rejected entry carries the UUID of the submission it went in. DuplicateSubmission waits for
   * Retry-After once; 429/503 are retryable ProviderErrors. When nothing went through, the error is thrown; once any
   * sub-batch went through, a later failing sub-batch is reported in `unsent` instead, so accepted results survive.
   */
  async submit(receipts: unknown[], signer: EtaSigner): Promise<EtaBatchResult> {
    const out: EtaBatchResult = { submissionUuid: null, submissionUuids: [], accepted: [], rejected: [], unsent: [], batches: 0 };
    const sendSafe = async (batch: unknown[]): Promise<void> => {
      try {
        await send(batch);
      } catch (e) {
        if (!(e instanceof ProviderError)) throw e;
        out.unsent.push({ uuids: batch.map(receiptUuid).filter((u): u is string => !!u), error: e });
      }
    };
    const send = async (batch: unknown[], duplicateRetried = false): Promise<void> => {
      const { json, digest } = etaBatchDigest(batch);
      const value = buildEtaCadesBes({ digest, ...signer });
      const payload = `${json.slice(0, -1)},"signatures":[{"signatureType":"I","value":"${value}"}]}`;
      const res = await this.authorized(`${ETA_HOSTS[this.env].api}/api/v1/receiptsubmissions`, { method: 'POST', body: payload, headers: { 'Content-Type': 'application/json' } });
      const body = await res.json().catch(() => null) as any;
      const code = String(body?.error?.code ?? body?.error ?? '');
      if (res.status === 400 && /MaximumSizeExceeded/i.test(code + JSON.stringify(body ?? ''))) {
        if (batch.length <= 1) throw new ProviderError('eta_ereceipt', 'a single receipt exceeds the maximum submission size', false, 400);
        const mid = Math.ceil(batch.length / 2);
        await sendSafe(batch.slice(0, mid));
        await sendSafe(batch.slice(mid));
        return;
      }
      if (res.status === 422 && /DuplicateSubmission/i.test(code + JSON.stringify(body ?? '')) && !duplicateRetried) {
        const wait = Number(res.headers.get('retry-after'));
        await this.sleep(Math.min(Number.isFinite(wait) && wait > 0 ? wait * 1000 : 5_000, 60_000));
        return send(batch, true);
      }
      if (res.status !== 202 && res.status !== 200) {
        throw new ProviderError('eta_ereceipt', `submission refused (HTTP ${res.status}${code ? `, ${code.slice(0, 60)}` : ''})`, res.status === 429 || res.status >= 500, res.status);
      }
      out.batches++;
      const submissionUuid = typeof body?.submissionUUID === 'string' ? body.submissionUUID : null;
      if (submissionUuid) out.submissionUuids.push(submissionUuid);
      out.submissionUuid = out.submissionUuid ?? submissionUuid;
      for (const d of body?.acceptedDocuments ?? []) out.accepted.push({ uuid: String(d.uuid), longId: d.longId ?? null, receiptNumber: d.receiptNumber ?? null, submissionUuid });
      for (const d of body?.rejectedDocuments ?? []) out.rejected.push({ uuid: d.uuid ?? null, receiptNumber: d.receiptNumber ?? null, error: String(d.error?.message ?? 'rejected').slice(0, 300), submissionUuid });
    };
    await sendSafe(receipts);
    // Nothing went through: the caller's queue handles the error exactly as before (retry or record).
    if (!out.batches && out.unsent.length) throw out.unsent[0]!.error;
    return out;
  }

  /** GET submission details (status InProgress | Valid | Invalid) with the receipts of one page. */
  async submission(submissionUuid: string, page = 1, pageSize = 100) {
    if (!/^[A-Za-z0-9]{10,64}$/.test(submissionUuid)) throw new ProviderError('eta_ereceipt', 'invalid submission id', false);
    const res = await this.authorized(`${ETA_HOSTS[this.env].api}/api/v1/receiptsubmissions/${submissionUuid}/details?PageNo=${page}&PageSize=${pageSize}`, { method: 'GET' });
    const body = await res.json().catch(() => null) as any;
    if (res.status !== 200) throw new ProviderError('eta_ereceipt', `submission lookup failed (HTTP ${res.status})`, res.status === 429 || res.status >= 500, res.status);
    return {
      status: String(body?.status ?? 'InProgress') as 'InProgress' | 'Valid' | 'Invalid',
      receiptsCount: Number(body?.receiptsCount ?? 0), invalidReceiptCount: Number(body?.invalidReceiptCount ?? 0),
      receipts: (body?.receipts ?? []).map((r: any) => ({ uuid: String(r.uuid), receiptNumber: r.receiptNumber ?? null, status: r.status ?? null })),
    };
  }

  private async authorized(url: string, init: RequestInit): Promise<Response> {
    let res = await this.fetchSafe(url, { ...init, headers: { ...(init.headers as Record<string, string>), Authorization: `Bearer ${await this.accessToken()}` } });
    if (res.status === 401) {
      // Token expired early: log in again once.
      res = await this.fetchSafe(url, { ...init, headers: { ...(init.headers as Record<string, string>), Authorization: `Bearer ${await this.accessToken(true)}` } });
    }
    return res;
  }

  private async fetchSafe(url: string, init: RequestInit): Promise<Response> {
    try {
      return await this.fetchImpl(url, { ...init, redirect: 'manual', signal: AbortSignal.timeout(30_000) });
    } catch (e) {
      throw new ProviderError('eta_ereceipt', `network error (${(e as Error).name})`, true);
    }
  }
}
