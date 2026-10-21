// INT-26 / FT-24: ZATCA Phase-2 onboarding and reporting, ETA e-receipt submission and status polling, end to end
// through the API with the authorities scripted (nothing reaches ZATCA or the ETA). Both remain labelled
// "implementation incomplete — not certified": these tests prove the wiring, sealing, chaining and recording, not
// acceptance by the authorities.
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, X509Certificate, type KeyObject } from 'node:crypto';
import { der } from '@resuto/integrations';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { TenantContext } from '../src/common/auth/context';
import { SecretBox } from '../src/common/crypto/secret-box';
import { DbService } from '../src/common/db/db.service';
import { EventDispatcher } from '../src/common/events/dispatcher.service';
import { FiscalAuthorityService } from '../src/modules/compliance/fiscal-authority.service';
import { ProviderHttp } from '../src/modules/integrations/provider-http';
import { OrdersKernelService } from '../src/modules/kernel/orders-kernel.service';
import { PaymentLedgerService } from '../src/modules/kernel/payment-ledger.service';
import { scriptedFetch, type RecordedRequest } from './growth-helpers';
import { auth, bootTestApp, createTenant, seedMenu, sql, type SeededMenu, type TestApp, type TestTenant } from './helpers';

let t: TestApp;
let http: ProviderHttp;
let original: typeof fetch;
beforeAll(async () => { t = await bootTestApp(); http = t.app.get(ProviderHttp); original = http.fetch; await sql(`update outbox_events set published_at = now() where published_at is null`); });
afterEach(() => { http.fetch = original; });
afterAll(async () => { await t.close(); });

const C = (tt: TestTenant, p: string) => `/v1/o/${tt.orgId}/compliance${p}`;
function selfSigned(privateKey: KeyObject, cn: string): string {
  const { seq, setOf, oid, printable, utf8, ctx, int, alg, time, bitString } = der;
  const spki = createPublicKey(privateKey).export({ type: 'spki', format: 'der' });
  const sigAlg = privateKey.asymmetricKeyType === 'ec' ? alg('1.2.840.10045.4.3.2') : alg('1.2.840.113549.1.1.11', Buffer.from([0x05, 0x00]));
  const name = seq(setOf(seq(oid('2.5.4.6'), printable('SA'))), setOf(seq(oid('2.5.4.3'), utf8(cn))));
  const tbs = seq(ctx(0, int(2)), int(42), sigAlg, name, seq(time(new Date('2026-01-01T00:00:00Z')), time(new Date('2030-01-01T00:00:00Z'))), name, spki);
  return seq(tbs, sigAlg, bitString(sign('sha256', tbs, privateKey))).toString('base64');
}
async function paidOrder(tt: TestTenant, m: SeededMenu, branchId = tt.branchId) {
  const ctx = new TenantContext(tt.orgId, 'owner', null, tt.owner.userId, 'user', tt.owner.userId);
  const db = t.app.get(DbService);
  const o = await db.scoped(ctx, (tx) => t.app.get(OrdersKernelService).place(tx, ctx, { branchId, channel: 'staff', fulfillment: 'pickup', lines: [{ productId: m.products.fries, quantity: 2 }] }));
  const currency = (await sql(`select currency from organizations where id = $1`, [tt.orgId]))[0].currency;
  await db.scoped(ctx, (tx) => t.app.get(PaymentLedgerService).recordSucceeded(tx, ctx, { branchId, orderId: o.id, method: 'cash', provider: 'manual', amountMinor: o.totalMinor, currency }));
  await t.app.get(EventDispatcher).drain();
  return (await sql(`select * from fiscal_documents where order_id = $1`, [o.id]))[0];
}
const route = (c: RecordedRequest) => `${c.method} ${c.url}`;

describe('ZATCA Phase-2 (INT-26, implementation incomplete)', () => {
  it('onboards an EGS unit (sealed key, CSR, compliance CSID, checks, production CSID) and reports a stamped invoice whose hash continues the chain', async () => {
    const sa = await createTenant(t, { country: 'SA' });
    const menu = await seedMenu(sa);
    await t.http.put(C(sa, '/tax-profile')).set(auth(sa.owner)).send({
      regime: 'zatca', vatNumber: '310122393500003', registeredName: 'Resuto Riyadh LLC', zatcaEnvironment: 'sandbox', zatcaEgsSerial: '1-Resuto|2-Web|3-0001',
      registeredAddress: { street: 'King Fahd Rd', buildingNumber: '1234', district: 'Olaya', city: 'Riyadh', postalCode: '12345' },
    }).expect(200);
    const created = await t.http.post(C(sa, '/zatca/egs')).set(auth(sa.owner)).send({
      branchId: sa.branchId, environment: 'sandbox', commonName: 'EGS1-RIYADH', organizationUnit: 'Riyadh Branch', egsSerial: '1-Resuto|2-2.0|3-0001', invoiceType: '0100', location: 'RRRD2929', industry: 'Restaurants',
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body).toMatchObject({ status: 'key_generated', hasComplianceCsid: false, notice: expect.stringContaining('not certified') });
    expect(created.body.csrPem).toMatch(/^-----BEGIN CERTIFICATE REQUEST-----/);
    const id = created.body.id;
    const [row] = await sql(`select private_key_sealed from zatca_egs_units where id = $1`, [id]);
    expect(row.private_key_sealed).not.toContain('PRIVATE KEY');
    // The CA would issue a certificate for the EGS key; the test plays the CA with that key.
    const keyPem = t.app.get(SecretBox).open(row.private_key_sealed, `zatca-egs:${sa.orgId}:${id}:key`);
    const token = Buffer.from(selfSigned(createPrivateKey(keyPem), 'EGS1-RIYADH')).toString('base64');

    // Wrong OTP format: refused before any call.
    expect((await t.http.post(C(sa, `/zatca/egs/${id}/compliance-csid`)).set(auth(sa.owner)).send({ otp: '12' })).status).toBe(400);
    let f = scriptedFetch([{ body: { requestID: 1234567890123, dispositionMessage: 'ISSUED', binarySecurityToken: token, secret: 'compliance-secret', errors: null } }]);
    http.fetch = f.fetch;
    const csid = await t.http.post(C(sa, `/zatca/egs/${id}/compliance-csid`)).set(auth(sa.owner)).send({ otp: '123345' });
    expect(csid.status, JSON.stringify(csid.body)).toBe(201);
    expect(csid.body).toMatchObject({ status: 'compliance_csid', complianceRequestId: '1234567890123', hasComplianceCsid: true });
    expect(f.calls.map(route)).toEqual(['POST https://gw-fatoora.zatca.gov.sa/e-invoicing/developer-portal/compliance']);
    expect(f.calls[0]!.headers).toMatchObject({ otp: '123345', 'accept-version': 'V2' });
    expect(Buffer.from(JSON.parse(f.calls[0]!.body!).csr, 'base64').toString()).toBe(created.body.csrPem);
    const [sealed] = await sql(`select compliance_csid_sealed as s from zatca_egs_units where id = $1`, [id]);
    expect(sealed.s).not.toContain('compliance-secret');

    f = scriptedFetch([{ body: { validationResults: { status: 'PASS', warningMessages: [], errorMessages: [] }, reportingStatus: 'REPORTED' } }]);
    http.fetch = f.fetch;
    const checks = await t.http.post(C(sa, `/zatca/egs/${id}/compliance-checks`)).set(auth(sa.owner));
    expect(checks.body.status, JSON.stringify(checks.body)).toBe('compliance_checked');
    expect(checks.body.complianceChecks.map((c: any) => [c.kind, c.outcome])).toEqual([['simplified_invoice', 'accepted'], ['credit_note', 'accepted'], ['debit_note', 'accepted']]);
    expect(f.calls).toHaveLength(3);
    const first = JSON.parse(f.calls[0]!.body!);
    expect(Buffer.from(first.invoice, 'base64').toString()).toContain('<ds:SignatureValue>');
    expect(f.calls[0]!.headers.authorization).toBe(`Basic ${Buffer.from(`${token}:compliance-secret`).toString('base64')}`);
    // The notes' PIH is the hash of the previous sample: the chain is respected.
    expect(Buffer.from(JSON.parse(f.calls[1]!.body!).invoice, 'base64').toString()).toContain(first.invoiceHash);

    f = scriptedFetch([{ body: { requestID: 99, binarySecurityToken: token, secret: 'production-secret' } }]);
    http.fetch = f.fetch;
    const prod = await t.http.post(C(sa, `/zatca/egs/${id}/production-csid`)).set(auth(sa.owner));
    expect(prod.body).toMatchObject({ status: 'active', hasProductionCsid: true });
    expect(JSON.parse(f.calls[0]!.body!)).toEqual({ compliance_request_id: '1234567890123' });

    // An issued invoice (stub submission at issue time) is stamped and reported by the job.
    const doc = await paidOrder(sa, menu);
    expect(doc).toMatchObject({ authority: 'zatca', status: 'issued' });
    f = scriptedFetch([{ body: { validationResults: { status: 'PASS', warningMessages: [], errorMessages: [] }, reportingStatus: 'REPORTED' } }]);
    http.fetch = f.fetch;
    const run = await t.app.get(FiscalAuthorityService).submitZatcaDue({ orgId: sa.orgId });
    expect(run).toMatchObject({ units: 1, sent: 1, accepted: 1 });
    expect(f.calls.map(route)).toEqual(['POST https://gw-fatoora.zatca.gov.sa/e-invoicing/developer-portal/invoices/reporting/single']);
    const sent = JSON.parse(f.calls[0]!.body!);
    expect(sent.uuid).toBe(doc.document_uuid);
    expect(sent.invoiceHash).toBe(doc.authority_ref); // the stamp's invoice hash is the hash the PIH chain already uses
    expect(f.calls[0]!.headers.authorization).toBe(`Basic ${Buffer.from(`${token}:production-secret`).toString('base64')}`);
    const subs = await sql(`select mode, status, external_id from government_submissions where document_id = $1 order by attempt`, [doc.id]);
    expect(subs).toEqual([{ mode: 'sandbox_stub', status: 'submitted', external_id: null }, { mode: 'sandbox_api', status: 'accepted', external_id: doc.authority_ref }]);
    expect((await sql(`select status from fiscal_documents where id = $1`, [doc.id]))[0].status).toBe('reported');
    // Nothing left to send.
    expect(await t.app.get(FiscalAuthorityService).submitZatcaDue({ orgId: sa.orgId })).toMatchObject({ sent: 0 });
  });

  it('a refused compliance CSID is recorded and reported without leaking the OTP', async () => {
    const sa = await createTenant(t, { country: 'SA' });
    await t.http.put(C(sa, '/tax-profile')).set(auth(sa.owner)).send({ regime: 'zatca', vatNumber: '310122393500003', registeredName: 'Resuto', zatcaEnvironment: 'sandbox', zatcaEgsSerial: '1-a|2-b|3-c',
      registeredAddress: { street: 'King Fahd Rd', buildingNumber: '1234', district: 'Olaya', city: 'Riyadh', postalCode: '12345' } }).expect(200);
    const created = await t.http.post(C(sa, '/zatca/egs')).set(auth(sa.owner)).send({ branchId: sa.branchId, environment: 'sandbox', commonName: 'EGS', organizationUnit: 'Main', egsSerial: '1-a|2-b|3-c', invoiceType: '0100', location: 'X', industry: 'Food' });
    http.fetch = scriptedFetch([{ status: 400, body: { errors: ['Invalid-OTP'] } }]).fetch;
    const r = await t.http.post(C(sa, `/zatca/egs/${created.body.id}/compliance-csid`)).set(auth(sa.owner)).send({ otp: '654321' });
    expect(r.status).toBe(502);
    expect(r.body.error.code).toBe('authority_error');
    expect(JSON.stringify(r.body)).not.toContain('654321');
    expect((await t.http.get(C(sa, '/zatca/egs')).set(auth(sa.owner))).body.items[0]).toMatchObject({ status: 'key_generated', lastError: expect.stringContaining('Compliance CSID refused') });
  });
});

async function etaTenant() {
  const eg = await createTenant(t, { country: 'EG' });
  const menu = await seedMenu(eg);
  await t.http.put(C(eg, '/tax-profile')).set(auth(eg.owner)).send({
    vatNumber: '123456789', registeredName: 'Resuto Cairo SAE', etaActivityCode: '5610', etaBranchCode: '0', etaPosSerial: 'POS-001', etaEnvironment: 'preprod',
    registeredAddress: { governate: 'Cairo', regionCity: 'Nasr City', street: 'Abbas El Akkad', buildingNumber: '10' },
  }).expect(200);
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const certPem = `-----BEGIN CERTIFICATE----- ${selfSigned(privateKey, 'Resuto eSeal')} -----END CERTIFICATE-----`;
  const creds = { clientId: 'pos-client', clientSecret: 'pos-secret', presharedKey: 'psk-123', signingKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() };
  const [conn] = await sql(
    `insert into integration_connections(org_id, provider, category, auth_type, environment, status, credentials_encrypted, config)
     values ($1, 'eta_ereceipt', 'tax', 'oauth', 'sandbox', 'connected', $2, $3) returning id`,
    [eg.orgId, t.app.get(SecretBox).sealJson(creds, `${eg.orgId}:eta_ereceipt`), { posSerial: 'POS-001', posOsVersion: 'android-14', posModelFramework: '1', signingCertificatePem: certPem }]);
  return { eg, menu, connId: conn.id as string };
}
const tokenResponse = { body: { access_token: 'a.b.c', token_type: 'Bearer', expires_in: 3600 } };
const receiptUuidsOf = (req: RecordedRequest) => JSON.parse(req.body!).receipts.map((r: any) => r.header.uuid as string);

const ZATCA_PROFILE = {
  regime: 'zatca', vatNumber: '310122393500003', registeredName: 'Resuto Riyadh LLC', zatcaEnvironment: 'sandbox', zatcaEgsSerial: '1-Resuto|2-Web|3-0001',
  registeredAddress: { street: 'King Fahd Rd', buildingNumber: '1234', district: 'Olaya', city: 'Riyadh', postalCode: '12345' },
};
/** Onboards an EGS unit for one branch through the API (authority scripted) and returns its id. */
async function activeEgs(sa: TestTenant, branchId: string, serial: string) {
  const created = await t.http.post(C(sa, '/zatca/egs')).set(auth(sa.owner)).send({
    branchId, environment: 'sandbox', commonName: `EGS-${serial}`, organizationUnit: 'Branch', egsSerial: `1-Resuto|2-2.0|3-${serial}`, invoiceType: '0100', location: 'RRRD2929', industry: 'Restaurants',
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const id = created.body.id as string;
  const [row] = await sql(`select private_key_sealed from zatca_egs_units where id = $1`, [id]);
  const keyPem = t.app.get(SecretBox).open(row.private_key_sealed, `zatca-egs:${sa.orgId}:${id}:key`);
  const token = Buffer.from(selfSigned(createPrivateKey(keyPem), `EGS-${serial}`)).toString('base64');
  http.fetch = scriptedFetch([{ body: { requestID: 1234567890123, binarySecurityToken: token, secret: 'compliance-secret' } }]).fetch;
  await t.http.post(C(sa, `/zatca/egs/${id}/compliance-csid`)).set(auth(sa.owner)).send({ otp: '123345' }).expect(201);
  http.fetch = scriptedFetch([{ body: { validationResults: { status: 'PASS', warningMessages: [], errorMessages: [] }, reportingStatus: 'REPORTED' } }]).fetch;
  await t.http.post(C(sa, `/zatca/egs/${id}/compliance-checks`)).set(auth(sa.owner)).expect(201);
  http.fetch = scriptedFetch([{ body: { requestID: 99, binarySecurityToken: token, secret: 'production-secret' } }]).fetch;
  const prod = await t.http.post(C(sa, `/zatca/egs/${id}/production-csid`)).set(auth(sa.owner));
  expect(prod.body).toMatchObject({ status: 'active', branchId, activatedAt: expect.any(String) });
  return id;
}
const reportOk = () => scriptedFetch([{ body: { validationResults: { status: 'PASS', warningMessages: [], errorMessages: [] }, reportingStatus: 'REPORTED' } }]);

describe('what the ZATCA job may report (INT-26 review)', () => {
  it('never reports documents issued before onboarding or under another environment, and reports each branch\'s chain through that branch\'s own unit', async () => {
    const sa = await createTenant(t, { country: 'SA' });
    const menu = await seedMenu(sa);
    await t.http.put(C(sa, '/tax-profile')).set(auth(sa.owner)).send(ZATCA_PROFILE).expect(200);
    const [east] = await sql(`insert into branches(org_id, code, name) values ($1, 'east', 'East') returning id`, [sa.orgId]);
    await sql(`insert into order_counters(branch_id, org_id) values ($1, $2)`, [east.id, sa.orgId]);
    // Stub-era history: issued before any EGS unit existed.
    const before = await paidOrder(sa, menu);
    const eastBefore = await paidOrder(sa, menu, east.id);
    expect([before.status, eastBefore.status]).toEqual(['issued', 'issued']);

    // An EGS unit per branch: two branches, two units in the same environment.
    const mainUnit = await activeEgs(sa, sa.branchId, '0001');
    // A unit for a branch of another organisation is refused.
    const other = await createTenant(t, { country: 'SA' });
    expect((await t.http.post(C(sa, '/zatca/egs')).set(auth(sa.owner)).send({
      branchId: other.branchId, environment: 'sandbox', commonName: 'X', organizationUnit: 'X', egsSerial: '1-a|2-b|3-c', invoiceType: '0100', location: 'X', industry: 'X',
    })).status).toBe(404);
    const svc = t.app.get(FiscalAuthorityService);
    let f = reportOk();
    http.fetch = f.fetch;
    expect(await svc.submitZatcaDue({ orgId: sa.orgId })).toMatchObject({ units: 1, sent: 0 });
    expect(f.calls).toHaveLength(0);

    // Issued after activation: reported, through the main branch's unit only.
    const after = await paidOrder(sa, menu);
    const eastAfter = await paidOrder(sa, menu, east.id);
    f = reportOk();
    http.fetch = f.fetch;
    expect(await svc.submitZatcaDue({ orgId: sa.orgId })).toMatchObject({ units: 1, sent: 1, accepted: 1 });
    expect(JSON.parse(f.calls[0]!.body!).uuid).toBe(after.document_uuid);

    // The east branch gets its own unit: its post-activation documents go through it, its history does not.
    await activeEgs(sa, east.id, '0002');
    const eastLater = await paidOrder(sa, menu, east.id);
    f = reportOk();
    http.fetch = f.fetch;
    expect(await svc.submitZatcaDue({ orgId: sa.orgId })).toMatchObject({ units: 2, sent: 1 });
    expect(JSON.parse(f.calls[0]!.body!).uuid).toBe(eastLater.document_uuid);
    const units = await sql(`select id, branch_id from zatca_egs_units where org_id = $1 and status = 'active' order by activated_at`, [sa.orgId]);
    expect(units.map((u: any) => u.branch_id)).toEqual([sa.branchId, east.id]);
    expect(units[0].id).toBe(mainUnit);

    // The profile moves to the simulation environment: documents issued now belong to simulation, not to the sandbox
    // units, and are not reported by them.
    await t.http.put(C(sa, '/tax-profile')).set(auth(sa.owner)).send({ ...ZATCA_PROFILE, zatcaEnvironment: 'simulation' }).expect(200);
    const simDoc = await paidOrder(sa, menu);
    expect(simDoc.meta.environment).toBe('simulation');
    await t.http.put(C(sa, '/tax-profile')).set(auth(sa.owner)).send(ZATCA_PROFILE).expect(200);
    f = reportOk();
    http.fetch = f.fetch;
    expect(await svc.submitZatcaDue({ orgId: sa.orgId })).toMatchObject({ sent: 0 });

    // Nothing from before onboarding (or under another environment) was ever sent.
    const sentDocs = await sql(`select document_id from government_submissions where org_id = $1 and mode <> 'sandbox_stub'`, [sa.orgId]);
    expect(sentDocs.map((r: any) => r.document_id).sort()).toEqual([after.id, eastLater.id].sort());
    void eastAfter;
  });
});

describe('what the ETA job may submit (INT-26 review)', () => {
  it('submits only receipts issued since the connection was connected in its environment, under the matching ETA environment', async () => {
    const eg = await createTenant(t, { country: 'EG' });
    const menu = await seedMenu(eg);
    await t.http.put(C(eg, '/tax-profile')).set(auth(eg.owner)).send({
      vatNumber: '123456789', registeredName: 'Resuto Cairo SAE', etaActivityCode: '5610', etaBranchCode: '0', etaPosSerial: 'POS-001', etaEnvironment: 'preprod',
      registeredAddress: { governate: 'Cairo', regionCity: 'Nasr City', street: 'Abbas El Akkad', buildingNumber: '10' },
    }).expect(200);
    const history = await paidOrder(eg, menu); // issued before any ETA connection
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const certPem = `-----BEGIN CERTIFICATE----- ${selfSigned(privateKey, 'Resuto eSeal')} -----END CERTIFICATE-----`;
    const creds = { clientId: 'pos-client', clientSecret: 'pos-secret', presharedKey: 'psk-123', signingKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() };
    const [conn] = await sql(
      `insert into integration_connections(org_id, provider, category, auth_type, environment, status, credentials_encrypted, config)
       values ($1, 'eta_ereceipt', 'tax', 'oauth', 'sandbox', 'pending', $2, $3) returning id, environment_connected_at`,
      [eg.orgId, t.app.get(SecretBox).sealJson(creds, `${eg.orgId}:eta_ereceipt`), { posSerial: 'POS-001', posOsVersion: 'android-14', posModelFramework: '1', signingCertificatePem: certPem }]);
    expect(conn.environment_connected_at).toBeNull();
    const pendingEra = await paidOrder(eg, menu); // connection not connected yet
    await sql(`update integration_connections set status = 'connected' where id = $1`, [conn.id]);
    const live = await paidOrder(eg, menu);
    const svc = t.app.get(FiscalAuthorityService);
    let f = scriptedFetch([tokenResponse, (req) => ({ status: 202, body: { submissionUUID: 'SUBMISSIONEEEEEEEEEEEEEEE5', acceptedDocuments: receiptUuidsOf(req).map((uuid: string) => ({ uuid })) } })]);
    http.fetch = f.fetch;
    expect(await svc.submitEtaDue({ orgId: eg.orgId })).toMatchObject({ accepted: 1 });
    expect(receiptUuidsOf(f.calls[1]!)).toEqual([live.authority_ref]);

    // Switching the connection to live (production) starts over: preprod receipts are never sent to production.
    await sql(`update integration_connections set environment = 'live' where id = $1`, [conn.id]);
    expect((await sql(`select environment_connected_at from integration_connections where id = $1`, [conn.id]))[0].environment_connected_at).not.toBeNull(); // still connected → restarted now
    const preprodLater = await paidOrder(eg, menu);
    f = scriptedFetch([tokenResponse, { status: 202, body: { submissionUUID: 'X', acceptedDocuments: [] } }]);
    http.fetch = f.fetch;
    expect(await svc.submitEtaDue({ orgId: eg.orgId })).toMatchObject({ accepted: 0, batches: 0 });
    expect(f.calls).toHaveLength(0);
    const sent = await sql(`select document_id from government_submissions where org_id = $1 and mode <> 'sandbox_stub'`, [eg.orgId]);
    expect(sent.map((r: any) => r.document_id)).toEqual([live.id]);
    void history; void pendingEra; void preprodLater;
  });
});

describe('ETA batches split by MaximumSizeExceeded (INT-26 review)', () => {
  it('links each receipt to the submission it went in, settles both from their own submission, and keeps accepted results when a later half fails', async () => {
    const { eg, menu } = await etaTenant();
    const d1 = await paidOrder(eg, menu);
    const d2 = await paidOrder(eg, menu);
    const svc = t.app.get(FiscalAuthorityService);
    http.fetch = scriptedFetch([
      tokenResponse,
      { status: 400, body: { error: { code: 'MaximumSizeExceeded' } } },
      (req) => ({ status: 202, body: { submissionUUID: 'SUBMISSIONAAAAAAAAAAAAAAA1', acceptedDocuments: receiptUuidsOf(req).map((uuid: string) => ({ uuid })) } }),
      (req) => ({ status: 202, body: { submissionUUID: 'SUBMISSIONBBBBBBBBBBBBBBB2', acceptedDocuments: receiptUuidsOf(req).map((uuid: string) => ({ uuid })) } }),
    ]).fetch;
    expect(await svc.submitEtaDue({ orgId: eg.orgId })).toMatchObject({ batches: 2, accepted: 2 });
    const ext = async (id: string) => (await sql(`select external_id from government_submissions where document_id = $1 and external_id is not null`, [id]))[0]?.external_id;
    expect(await ext(d1.id)).toBe('SUBMISSIONAAAAAAAAAAAAAAA1');
    expect(await ext(d2.id)).toBe('SUBMISSIONBBBBBBBBBBBBBBB2');

    // The poll reads each submission and settles the receipt listed there: d2 is settled from SUBMISSION…2.
    await sql(`update government_submissions set submitted_at = now() - interval '5 minutes' where org_id = $1`, [eg.orgId]);
    const polled: string[] = [];
    http.fetch = scriptedFetch([(req) => {
      if (req.url.endsWith('/connect/token')) return tokenResponse;
      const id = /receiptsubmissions\/([A-Z0-9]+)\/details/.exec(req.url)![1]!;
      polled.push(id);
      const doc = id.endsWith('1') ? d1 : d2;
      return { body: { status: 'Valid', receiptsCount: 1, invalidReceiptCount: 0, receipts: [{ uuid: doc.authority_ref, receiptNumber: doc.number, status: 'Valid' }] } };
    }]).fetch;
    expect(await svc.pollEta({ orgId: eg.orgId })).toEqual({ submissions: 2, settled: 2 });
    expect(polled.sort()).toEqual(['SUBMISSIONAAAAAAAAAAAAAAA1', 'SUBMISSIONBBBBBBBBBBBBBBB2']);
    expect((await sql(`select status from fiscal_documents where id = any($1::uuid[]) order by counter_value`, [[d1.id, d2.id]])).map((r: any) => r.status)).toEqual(['accepted', 'accepted']);

    // Second round: the first half is accepted, the second half hits an outage. The accepted receipt is recorded;
    // the other is left for the next run (retryable) instead of everything being lost or marked as an error.
    const d3 = await paidOrder(eg, menu);
    const d4 = await paidOrder(eg, menu);
    http.fetch = scriptedFetch([
      tokenResponse,
      { status: 400, body: { error: { code: 'MaximumSizeExceeded' } } },
      (req) => ({ status: 202, body: { submissionUUID: 'SUBMISSIONCCCCCCCCCCCCCCC3', acceptedDocuments: receiptUuidsOf(req).map((uuid: string) => ({ uuid })) } }),
      { status: 503, body: {} },
    ]).fetch;
    expect(await svc.submitEtaDue({ orgId: eg.orgId })).toMatchObject({ batches: 1, accepted: 1, errors: 1 });
    expect(await ext(d3.id)).toBe('SUBMISSIONCCCCCCCCCCCCCCC3');
    expect(await sql(`select 1 from government_submissions where document_id = $1 and mode <> 'sandbox_stub'`, [d4.id])).toHaveLength(0);
    // Next run sends only d4.
    const f = scriptedFetch([tokenResponse, (req) => ({ status: 202, body: { submissionUUID: 'SUBMISSIONDDDDDDDDDDDDDDD4', acceptedDocuments: receiptUuidsOf(req).map((uuid: string) => ({ uuid })) } })]);
    http.fetch = f.fetch;
    await svc.submitEtaDue({ orgId: eg.orgId });
    expect(receiptUuidsOf(f.calls[1]!)).toEqual([d4.authority_ref]);
  });
});

describe('ETA status poll reads every page (ws7b follow-up)', () => {
  it('settles receipts listed on later pages of a submission, not only the first page', async () => {
    const { eg, menu } = await etaTenant();
    const d1 = await paidOrder(eg, menu);
    const d2 = await paidOrder(eg, menu);
    const svc = t.app.get(FiscalAuthorityService);
    http.fetch = scriptedFetch([tokenResponse,
      (req) => ({ status: 202, body: { submissionUUID: 'SUBMISSIONPAGEDPAGEDPAGED1', acceptedDocuments: receiptUuidsOf(req).map((uuid: string) => ({ uuid })) } })]).fetch;
    expect(await svc.submitEtaDue({ orgId: eg.orgId })).toMatchObject({ batches: 1, accepted: 2 });
    await sql(`update government_submissions set submitted_at = now() - interval '5 minutes' where org_id = $1`, [eg.orgId]);
    const pages: string[] = [];
    http.fetch = scriptedFetch([(req) => {
      if (req.url.endsWith('/connect/token')) return tokenResponse;
      const page = new URL(req.url).searchParams.get('PageNo')!;
      pages.push(page);
      const doc = page === '1' ? d1 : d2;
      return { body: { status: 'Valid', receiptsCount: 2, invalidReceiptCount: 0, receipts: page === '3' ? [] : [{ uuid: doc.authority_ref, receiptNumber: doc.number, status: 'Valid' }] } };
    }]).fetch;
    expect(await svc.pollEta({ orgId: eg.orgId })).toEqual({ submissions: 1, settled: 2 });
    expect(pages).toEqual(['1', '2']);
    expect((await sql(`select status from fiscal_documents where id = any($1::uuid[])`, [[d1.id, d2.id]])).map((r: any) => r.status)).toEqual(['accepted', 'accepted']);
  });
});

describe('ETA e-receipt (INT-26, implementation incomplete)', () => {
  it('submits signed receipts of a connected POS after commit and settles them from the submission status', async () => {
    const eg = await createTenant(t, { country: 'EG' });
    const menu = await seedMenu(eg);
    await t.http.put(C(eg, '/tax-profile')).set(auth(eg.owner)).send({
      vatNumber: '123456789', registeredName: 'Resuto Cairo SAE', etaActivityCode: '5610', etaBranchCode: '0', etaPosSerial: 'POS-001', etaEnvironment: 'preprod',
      registeredAddress: { governate: 'Cairo', regionCity: 'Nasr City', street: 'Abbas El Akkad', buildingNumber: '10' },
    }).expect(200);
    const cat = await t.http.get(`/v1/o/${eg.orgId}/integrations/catalog`).set(auth(eg.owner));
    expect(cat.body.items.find((p: any) => p.id === 'eta_ereceipt')).toMatchObject({ category: 'tax', readiness: 'implemented_unverified' });
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const certB64 = selfSigned(privateKey, 'Resuto eSeal');
    const certPem = `-----BEGIN CERTIFICATE----- ${certB64} -----END CERTIFICATE-----`; // pasted on one line, as from a form
    const creds = { clientId: 'pos-client', clientSecret: 'pos-secret', presharedKey: 'psk-123', signingKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString().replace(/\n/g, ' ') };
    const [conn] = await sql(
      `insert into integration_connections(org_id, provider, category, auth_type, environment, status, credentials_encrypted, config)
       values ($1, 'eta_ereceipt', 'tax', 'oauth', 'sandbox', 'connected', $2, $3) returning id`,
      [eg.orgId, t.app.get(SecretBox).sealJson(creds, `${eg.orgId}:eta_ereceipt`), { posSerial: 'POS-001', posOsVersion: 'android-14', posModelFramework: '1', signingCertificatePem: certPem }]);
    expect(new X509Certificate(`-----BEGIN CERTIFICATE-----\n${certB64}\n-----END CERTIFICATE-----`).subject).toContain('Resuto eSeal');

    const doc = await paidOrder(eg, menu);
    expect(doc).toMatchObject({ authority: 'eta', status: 'issued' });
    let f = scriptedFetch([
      { body: { access_token: 'a.b.c', token_type: 'Bearer', expires_in: 3600 } },
      { status: 202, body: { submissionUUID: 'TZRKK8MFZCPSTW9XCYWBMKME10', acceptedDocuments: [{ uuid: doc.authority_ref, longId: 'LONG1', receiptNumber: doc.number }], rejectedDocuments: [] } },
    ]);
    http.fetch = f.fetch;
    const svc = t.app.get(FiscalAuthorityService);
    expect(await svc.submitEtaDue({ orgId: eg.orgId })).toMatchObject({ connections: 1, batches: 1, accepted: 1 });
    expect(f.calls.map(route)).toEqual(['POST https://id.preprod.eta.gov.eg/connect/token', 'POST https://api.preprod.invoicing.eta.gov.eg/api/v1/receiptsubmissions']);
    expect(f.calls[0]!.headers).toMatchObject({ posserial: 'POS-001', pososversion: 'android-14', posmodelframework: '1', presharedkey: 'psk-123' });
    const body = JSON.parse(f.calls[1]!.body!);
    expect(body.receipts[0].header.uuid).toBe(doc.authority_ref);
    expect(body.signatures).toEqual([{ signatureType: 'I', value: expect.stringMatching(/^MII/) }]);
    let subs = await sql(`select mode, status, external_id from government_submissions where document_id = $1 order by attempt`, [doc.id]);
    expect(subs.at(-1)).toEqual({ mode: 'sandbox_api', status: 'submitted', external_id: 'TZRKK8MFZCPSTW9XCYWBMKME10' });
    expect((await sql(`select status from fiscal_documents where id = $1`, [doc.id]))[0].status).toBe('submitted');
    // Not sent twice.
    http.fetch = scriptedFetch([{ status: 500, body: {} }]).fetch;
    expect(await svc.submitEtaDue({ orgId: eg.orgId })).toMatchObject({ batches: 0 });

    await sql(`update government_submissions set submitted_at = now() - interval '5 minutes' where document_id = $1`, [doc.id]);
    f = scriptedFetch([
      { body: { access_token: 'a.b.c', expires_in: 3600 } },
      { body: { status: 'Valid', receiptsCount: 1, invalidReceiptCount: 0, receipts: [{ uuid: doc.authority_ref, receiptNumber: doc.number, status: 'Valid' }] } },
    ]);
    http.fetch = f.fetch;
    expect(await svc.pollEta({ orgId: eg.orgId })).toEqual({ submissions: 1, settled: 1 });
    expect(f.calls[1]!.url).toBe('https://api.preprod.invoicing.eta.gov.eg/api/v1/receiptsubmissions/TZRKK8MFZCPSTW9XCYWBMKME10/details?PageNo=1&PageSize=100');
    subs = await sql(`select status from government_submissions where document_id = $1 and external_id is not null`, [doc.id]);
    expect(subs).toEqual([{ status: 'accepted' }]);
    expect((await sql(`select status from fiscal_documents where id = $1`, [doc.id]))[0].status).toBe('accepted');
    void conn;
  });
});
