import { Injectable, Logger } from '@nestjs/common';
import {
  buildZatcaCsr, certificateFromBinarySecurityToken, EtaReceiptClient, FatooraClient, generateZatcaKeyPair, ProviderError, signZatcaInvoice,
  ZATCA_GENESIS_PIH, type FiscalDocumentModel, type ZatcaEnvironment,
} from '@resuto/integrations';
import { randomUUID } from 'node:crypto';
import { TenantContext } from '../../common/auth/context';
import { SecretBox } from '../../common/crypto/secret-box';
import { DbService, type Tx } from '../../common/db/db.service';
import { DomainError, conflict, invalid, notFound } from '../../common/errors/domain-error';
import { Scheduled } from '../../common/events/events';
import { AuditService } from '../../common/platform/audit.service';
import { IntegrationConnectionsService, redactedError } from '../integrations/connections.service';
import { ProviderHttp } from '../integrations/provider-http';
import { FiscalService } from './fiscal.service';

const REPORTING_KINDS = ['simplified_invoice', 'credit_note', 'debit_note'];
const aad = (orgId: string, id: string, what: string) => `zatca-egs:${orgId}:${id}:${what}`;
/** A PEM pasted into a single-line field (spaces instead of newlines) back to PEM. */
export function normalisePem(s: string): string {
  const m = /-----BEGIN ([A-Z ]+)-----([\s\S]*?)-----END \1-----/.exec(s.trim());
  if (!m) return s.trim();
  const body = m[2]!.replace(/\s+/g, '');
  return `-----BEGIN ${m[1]}-----\n${body.replace(/.{1,64}/g, '$&\n')}-----END ${m[1]}-----\n`;
}

export interface EgsInput { environment: ZatcaEnvironment; commonName: string; organizationUnit: string; egsSerial: string; invoiceType: string; location: string; industry: string }

/**
 * ZATCA Phase-2 onboarding and reporting/clearance, ETA e-receipt submission and status polling (INT-26 / FT-24).
 *
 * IMPLEMENTATION INCOMPLETE — NOT CERTIFIED (see packages/integrations/src/tax/zatca-phase2.ts and eta-ereceipt.ts).
 * Real calls happen only when the restaurant onboarded an EGS unit (ZATCA) or connected its ETA POS; otherwise the
 * existing labelled sandbox stub stays the only "submission". Every call runs outside a transaction and is recorded
 * in government_submissions with its true outcome (mode sandbox_api / production_api).
 */
@Injectable()
export class FiscalAuthorityService {
  private readonly logger = new Logger('FiscalAuthority');

  constructor(
    private readonly db: DbService,
    private readonly box: SecretBox,
    private readonly fiscal: FiscalService,
    private readonly connections: IntegrationConnectionsService,
    private readonly http: ProviderHttp,
    private readonly audit: AuditService,
  ) {}

  // ---------------------------------------------------------------------------
  // ZATCA onboarding
  // ---------------------------------------------------------------------------
  private view(r: any) {
    return {
      id: r.id, environment: r.environment, status: r.status, commonName: r.common_name, egsSerial: r.egs_serial, invoiceType: r.invoice_type,
      csrPem: r.csr_pem, complianceRequestId: r.compliance_request_id, complianceChecks: r.compliance_checks ?? [],
      hasComplianceCsid: !!r.compliance_csid_sealed, hasProductionCsid: !!r.production_csid_sealed, certificatePem: r.certificate_pem ?? null,
      lastError: r.last_error, createdAt: new Date(r.created_at).toISOString(), updatedAt: new Date(r.updated_at).toISOString(),
      notice: 'Implementation incomplete — not certified: not yet validated with the ZATCA SDK or sandbox.',
    };
  }

  listEgs(ctx: TenantContext) {
    return this.db.scoped(ctx, async (tx) => ({ items: (await tx.query('select * from zatca_egs_units where org_id = $1 order by created_at desc', [ctx.orgId])).map((r) => this.view(r)) }));
  }

  /** Generates the EGS key (sealed) and the CSR from the validated tax profile. Replaces an unfinished unit of that environment. */
  createEgs(ctx: TenantContext, input: EgsInput) {
    return this.db.scoped(ctx, async (tx) => {
      const p = await tx.maybeOne<any>('select * from tax_profiles where org_id = $1', [ctx.orgId]);
      if (!p || p.regime !== 'zatca') throw invalid('regime_not_zatca', 'Set the tax regime to ZATCA first');
      if (!p.vat_number || !p.registered_name) throw invalid('tax_profile_incomplete', 'Complete the VAT number and registered name in the tax profile first');
      const active = await tx.maybeOne(`select 1 from zatca_egs_units where org_id = $1 and environment = $2 and status = 'active'`, [ctx.orgId, input.environment]);
      if (active) throw conflict('egs_active', 'An active EGS unit exists for this environment');
      await tx.query(`update zatca_egs_units set status = 'retired' where org_id = $1 and environment = $2 and status <> 'retired'`, [ctx.orgId, input.environment]);
      const keys = generateZatcaKeyPair();
      let csr: ReturnType<typeof buildZatcaCsr>;
      try {
        csr = buildZatcaCsr({ ...input, organizationName: p.registered_name, vatNumber: p.vat_number }, keys.privateKeyPem);
      } catch (e) {
        throw invalid('invalid_egs', (e as Error).message);
      }
      const id = randomUUID();
      const row = await tx.one(
        `insert into zatca_egs_units(id, org_id, environment, common_name, egs_serial, invoice_type, private_key_sealed, csr_pem)
         values ($1, $2, $3, $4, $5, $6, $7, $8) returning *`,
        [id, ctx.orgId, input.environment, input.commonName, input.egsSerial, input.invoiceType, this.box.seal(keys.privateKeyPem, aad(ctx.orgId, id, 'key')), csr.pem]);
      await this.audit.record(tx, ctx, { action: 'compliance.zatca_egs_created', entityType: 'zatca_egs_unit', entityId: id, metadata: { environment: input.environment } });
      return this.view(row);
    });
  }

  private async egs(orgId: string, id: string) {
    const r = await this.db.withTenant(orgId, (tx) => tx.maybeOne<any>('select * from zatca_egs_units where id = $1 and org_id = $2', [id, orgId]), 'system:fiscal');
    if (!r || r.status === 'retired') throw notFound('EGS unit');
    return r;
  }

  private async record(orgId: string, id: string, set: Record<string, unknown>, error: string | null) {
    const keys = Object.keys(set);
    return this.db.withTenant(orgId, (tx) => tx.one(
      `update zatca_egs_units set ${[...keys.map((k, i) => `${k} = $${i + 3}`), `last_error = $${keys.length + 3}`].join(', ')} where id = $1 and org_id = $2 returning *`,
      [id, orgId, ...keys.map((k) => set[k]), error]), 'system:fiscal');
  }

  private failure(e: unknown): never {
    if (e instanceof ProviderError) throw new DomainError('authority_error', redactedError(e).message, e.retryable ? 503 : 502, { retryable: e.retryable });
    throw e;
  }

  /** Step 2: compliance CSID with the OTP from the FATOORA portal (valid one hour). */
  async complianceCsid(ctx: TenantContext, id: string, otp: string) {
    const r = await this.egs(ctx.orgId, id);
    if (r.status !== 'key_generated' && r.status !== 'error') throw conflict('egs_wrong_state', `The EGS unit is ${r.status}`);
    const client = new FatooraClient(r.environment, this.http.fetch);
    try {
      const csid = await client.complianceCsid(otp, Buffer.from(r.csr_pem).toString('base64'));
      const certificatePem = certificateFromBinarySecurityToken(csid.binarySecurityToken);
      const row = await this.record(ctx.orgId, id, {
        status: 'compliance_csid', compliance_request_id: csid.requestId, certificate_pem: certificatePem,
        compliance_csid_sealed: this.box.sealJson({ binarySecurityToken: csid.binarySecurityToken, secret: csid.secret }, aad(ctx.orgId, id, 'compliance')),
      }, null);
      return this.view(row);
    } catch (e) {
      await this.record(ctx.orgId, id, {}, redactedError(e).message);
      this.failure(e);
    }
  }

  /**
   * Step 3: compliance checks — a stamped sample of each document type the unit issues (simplified invoice, credit
   * note, debit note) sent to /compliance/invoices. The unit is "compliance_checked" only when all are accepted.
   */
  async complianceChecks(ctx: TenantContext, id: string) {
    const r = await this.egs(ctx.orgId, id);
    if (r.status !== 'compliance_csid' && r.status !== 'compliance_checked') throw conflict('egs_wrong_state', `The EGS unit is ${r.status}`);
    const p = await this.db.withTenant(ctx.orgId, (tx) => tx.one<any>('select * from tax_profiles where org_id = $1', [ctx.orgId]), 'system:fiscal');
    const auth = this.box.openJson<{ binarySecurityToken: string; secret: string }>(r.compliance_csid_sealed, aad(ctx.orgId, id, 'compliance'));
    const key = this.box.open(r.private_key_sealed, aad(ctx.orgId, id, 'key'));
    const client = new FatooraClient(r.environment, this.http.fetch);
    const results: Array<Record<string, unknown>> = [];
    let pih: string | null = null;
    let counter = 1;
    const invoiceUuid = randomUUID();
    for (const kind of ['simplified_invoice', 'credit_note', 'debit_note'] as const) {
      const doc = sampleDocument(kind, p, counter++, invoiceUuid);
      try {
        const signed = signZatcaInvoice({ doc, previousInvoiceHash: pih, certificatePem: r.certificate_pem, privateKeyPem: key });
        const out = await client.complianceCheck(auth, { invoiceHash: signed.invoiceHash, uuid: doc.uuid, invoiceXml: signed.signedXml });
        results.push({ kind, outcome: out.outcome, reportingStatus: out.reportingStatus, warnings: out.warnings, errors: out.errors, at: new Date().toISOString() });
        pih = signed.invoiceHash;
      } catch (e) {
        results.push({ kind, outcome: 'error', error: redactedError(e).message, at: new Date().toISOString() });
      }
    }
    const passed = results.every((x) => x.outcome === 'accepted' || x.outcome === 'accepted_with_warnings');
    const row = await this.record(ctx.orgId, id, { status: passed ? 'compliance_checked' : 'compliance_csid', compliance_checks: JSON.stringify(results) }, passed ? null : 'compliance_checks_failed');
    return this.view(row);
  }

  /** Step 4: production CSID; the unit becomes active and reporting / clearance start. */
  async productionCsid(ctx: TenantContext, id: string) {
    const r = await this.egs(ctx.orgId, id);
    if (r.status !== 'compliance_checked') throw conflict('egs_wrong_state', 'Pass the compliance checks first');
    const auth = this.box.openJson<{ binarySecurityToken: string; secret: string }>(r.compliance_csid_sealed, aad(ctx.orgId, id, 'compliance'));
    try {
      const csid = await new FatooraClient(r.environment, this.http.fetch).productionCsid({ ...auth, requestId: r.compliance_request_id });
      const certificatePem = certificateFromBinarySecurityToken(csid.binarySecurityToken);
      const row = await this.record(ctx.orgId, id, {
        status: 'active', certificate_pem: certificatePem,
        production_csid_sealed: this.box.sealJson({ binarySecurityToken: csid.binarySecurityToken, secret: csid.secret }, aad(ctx.orgId, id, 'production')),
      }, null);
      await this.db.scoped(ctx, (tx) => this.audit.record(tx, ctx, { action: 'compliance.zatca_egs_activated', entityType: 'zatca_egs_unit', entityId: id, metadata: { environment: r.environment } }));
      return this.view(row);
    } catch (e) {
      await this.record(ctx.orgId, id, {}, redactedError(e).message);
      this.failure(e);
    }
  }

  // ---------------------------------------------------------------------------
  // ZATCA reporting / clearance (job)
  // ---------------------------------------------------------------------------
  /**
   * Stamps and sends issued ZATCA documents of organisations with an active EGS unit whose environment matches the
   * tax profile: simplified invoices and notes to reporting, standard invoices to clearance, oldest first.
   */
  @Scheduled('compliance.zatca-submit', 300, { timeoutMs: 240_000 })
  async submitZatcaDue(scope: { orgId?: string; limit?: number } = {}) {
    const units = await this.db.withPlatform((tx) => tx.query<any>(
      `select u.* from zatca_egs_units u join tax_profiles p on p.org_id = u.org_id
        where u.status = 'active' and p.regime = 'zatca' and p.zatca_environment = u.environment and ($1::uuid is null or u.org_id = $1)`,
      [scope.orgId ?? null]), 'system:fiscal');
    const totals = { sent: 0, accepted: 0, rejected: 0, errors: 0 };
    for (const u of units) {
      const docs = await this.db.withTenant(u.org_id, (tx) => tx.query<any>(
        `select d.* from fiscal_documents d
          where d.org_id = $1 and d.authority = 'zatca' and d.status in ('issued', 'error')
            and not exists (select 1 from government_submissions g where g.document_id = d.id and g.mode <> 'sandbox_stub' and g.status = 'accepted')
          order by d.issued_at, d.counter_value limit $2`, [u.org_id, scope.limit ?? 50]), 'system:fiscal');
      if (!docs.length) continue;
      const key = this.box.open(u.private_key_sealed, aad(u.org_id, u.id, 'key'));
      const auth = this.box.openJson<{ binarySecurityToken: string; secret: string }>(u.production_csid_sealed, aad(u.org_id, u.id, 'production'));
      const client = new FatooraClient(u.environment, this.http.fetch);
      for (const d of docs) {
        totals.sent++;
        let status: 'accepted' | 'rejected' | 'error' = 'error';
        let response: Record<string, unknown>;
        try {
          const signed = signZatcaInvoice({ doc: this.fiscal.toModel(d), previousInvoiceHash: d.previous_authority_ref ?? ZATCA_GENESIS_PIH, certificatePem: u.certificate_pem, privateKeyPem: key });
          const s = { invoiceHash: signed.invoiceHash, uuid: d.document_uuid, invoiceXml: signed.signedXml };
          const out = REPORTING_KINDS.includes(d.kind) ? await client.report(auth, s) : await client.clear(auth, s);
          status = out.outcome === 'accepted' || out.outcome === 'accepted_with_warnings' ? 'accepted' : 'rejected';
          response = { api: REPORTING_KINDS.includes(d.kind) ? 'reporting' : 'clearance', outcome: out.outcome, httpStatus: out.httpStatus, reportingStatus: out.reportingStatus,
            clearanceStatus: out.clearanceStatus, warnings: out.warnings, errors: out.errors, invoiceHash: signed.invoiceHash, notice: 'implementation incomplete — not certified' };
        } catch (e) {
          response = { error: redactedError(e), notice: 'implementation incomplete — not certified' };
          if (e instanceof ProviderError && e.status === 401) { totals.errors++; await this.recordSubmission(d, u.environment === 'production' ? 'production_api' : 'sandbox_api', u.environment, 'error', response, null); break; }
        }
        if (status === 'accepted') totals.accepted++; else if (status === 'rejected') totals.rejected++; else totals.errors++;
        await this.recordSubmission(d, u.environment === 'production' ? 'production_api' : 'sandbox_api', u.environment, status, response, String(response.invoiceHash ?? '') || null,
          status === 'accepted' ? (REPORTING_KINDS.includes(d.kind) ? 'reported' : 'cleared') : status === 'rejected' ? 'rejected' : null);
      }
    }
    return { units: units.length, ...totals };
  }

  private async recordSubmission(d: any, mode: 'sandbox_api' | 'production_api', environment: string, status: string, response: Record<string, unknown>, externalId: string | null, docStatus: string | null = null) {
    await this.db.withTenant(d.org_id, async (tx: Tx) => {
      const { attempt } = await tx.one<{ attempt: number }>('select coalesce(max(attempt), 0) + 1 as attempt from government_submissions where document_id = $1', [d.id]);
      await tx.query(
        `insert into government_submissions(org_id, document_id, authority, environment, mode, status, request_digest, response, attempt, external_id)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [d.org_id, d.id, d.authority, environment, mode, status, d.authority_ref, response, attempt, externalId]);
      if (docStatus) await tx.query('update fiscal_documents set status = $2 where id = $1', [d.id, docStatus]);
    }, 'system:fiscal');
  }

  // ---------------------------------------------------------------------------
  // ETA e-receipts (jobs)
  // ---------------------------------------------------------------------------
  /** Sends issued receipts of organisations with a connected ETA POS, one signed batch per organisation and run. */
  @Scheduled('compliance.eta-submit', 120, { timeoutMs: 240_000 })
  async submitEtaDue(scope: { orgId?: string; limit?: number } = {}) {
    const conns = await this.db.withPlatform((tx) => tx.query<{ id: string; org_id: string }>(
      `select id, org_id from integration_connections where provider = 'eta_ereceipt' and enabled and status = 'connected' and ($1::uuid is null or org_id = $1)`,
      [scope.orgId ?? null]), 'system:fiscal');
    const totals = { batches: 0, accepted: 0, rejected: 0, errors: 0 };
    for (const c of conns) {
      const conn = await this.connections.load(c.org_id, { id: c.id });
      const env = conn.environment === 'live' ? 'production' : 'preprod';
      const docs = await this.db.withTenant(c.org_id, (tx) => tx.query<any>(
        `select d.* from fiscal_documents d
          where d.org_id = $1 and d.authority = 'eta' and d.status in ('issued', 'error')
            and not exists (select 1 from government_submissions g where g.document_id = d.id and g.mode <> 'sandbox_stub' and g.status in ('submitted', 'accepted'))
          order by d.issued_at, d.counter_value limit $2`, [c.org_id, scope.limit ?? 100]), 'system:fiscal');
      if (!docs.length) continue;
      const cr = conn.adapter.credentials;
      const cfg = conn.config as Record<string, unknown>;
      const client = new EtaReceiptClient(env, { clientId: cr.clientId ?? '', clientSecret: cr.clientSecret ?? '', presharedKey: cr.presharedKey ?? '',
        posSerial: String(cfg.posSerial ?? ''), posOsVersion: String(cfg.posOsVersion ?? ''), posModelFramework: String(cfg.posModelFramework ?? '') }, this.http.fetch);
      const receipts = docs.map((d) => JSON.parse(this.fiscal.payloadOf(d).payload));
      const mode = env === 'production' ? 'production_api' : 'sandbox_api';
      try {
        const out = await client.submit(receipts, { certificatePem: normalisePem(String(cfg.signingCertificatePem ?? '')), privateKeyPem: normalisePem(cr.signingKeyPem ?? '') });
        totals.batches += out.batches;
        for (const d of docs) {
          // A split batch went in several submissions: each receipt is recorded under the one it actually went in,
          // so pollEta settles it from that submission's details.
          const ok = out.accepted.find((a) => a.uuid === d.authority_ref);
          const bad = out.rejected.find((x) => x.uuid === d.authority_ref || x.receiptNumber === d.number);
          const unsent = !ok && !bad ? out.unsent.find((u) => u.uuids.includes(d.authority_ref)) : undefined;
          if (unsent) {
            // Its sub-batch failed after another one went through: a retryable failure is simply retried next run
            // (nothing recorded); a definitive one is recorded as an error.
            totals.errors++;
            const err = redactedError(unsent.error);
            if (!err.retryable) await this.recordSubmission(d, mode, env, 'error', { error: err, notice: 'implementation incomplete — not certified' }, null);
            continue;
          }
          if (ok) totals.accepted++; else totals.rejected++;
          const submissionUuid = ok?.submissionUuid ?? bad?.submissionUuid ?? null;
          await this.recordSubmission(d, mode, env, ok ? 'submitted' : 'rejected',
            { submissionUuid, longId: ok?.longId ?? null, error: bad?.error ?? (ok ? null : 'not_in_accepted_documents'), notice: 'implementation incomplete — not certified' },
            ok ? submissionUuid : null, ok ? 'submitted' : 'rejected');
        }
      } catch (e) {
        totals.errors++;
        const d = redactedError(e);
        this.logger.warn(`ETA submission for ${c.org_id}: ${d.message}`);
        await this.db.withTenant(c.org_id, (tx) => this.connections.log(tx, c.org_id, c.id, 'error', `ETA receipt submission failed: ${d.message}`, { retryable: d.retryable }), 'system:fiscal');
        if (!d.retryable) for (const doc of docs) await this.recordSubmission(doc, mode, env, 'error', { error: d, notice: 'implementation incomplete — not certified' }, null);
      }
    }
    return { connections: conns.length, ...totals };
  }

  /** Reads back submissions still in progress and settles each receipt as accepted (Valid) or rejected (Invalid). */
  @Scheduled('compliance.eta-poll', 300, { timeoutMs: 120_000 })
  async pollEta(scope: { orgId?: string } = {}) {
    const pending = await this.db.withPlatform((tx) => tx.query<{ org_id: string; external_id: string }>(
      `select distinct g.org_id, g.external_id from government_submissions g
        where g.authority = 'eta' and g.status = 'submitted' and g.external_id is not null and g.mode <> 'sandbox_stub'
          and g.submitted_at < now() - interval '1 minute' and ($1::uuid is null or g.org_id = $1) limit 50`, [scope.orgId ?? null]), 'system:fiscal');
    let settled = 0;
    for (const p of pending) {
      const c = await this.db.withPlatform((tx) => tx.maybeOne<{ id: string }>(
        `select id from integration_connections where org_id = $1 and provider = 'eta_ereceipt' and status <> 'revoked' order by updated_at desc limit 1`, [p.org_id]), 'system:fiscal');
      if (!c) continue;
      const conn = await this.connections.load(p.org_id, { id: c.id });
      const cr = conn.adapter.credentials;
      const cfg = conn.config as Record<string, unknown>;
      const client = new EtaReceiptClient(conn.environment === 'live' ? 'production' : 'preprod', { clientId: cr.clientId ?? '', clientSecret: cr.clientSecret ?? '',
        presharedKey: cr.presharedKey ?? '', posSerial: String(cfg.posSerial ?? ''), posOsVersion: String(cfg.posOsVersion ?? ''), posModelFramework: String(cfg.posModelFramework ?? '') }, this.http.fetch);
      try {
        const s = await client.submission(p.external_id);
        if (s.status === 'InProgress') continue;
        await this.db.withTenant(p.org_id, async (tx) => {
          for (const r of s.receipts) {
            const valid = r.status === 'Valid';
            const doc = await tx.maybeOne<{ id: string }>(`select id from fiscal_documents where org_id = $1 and authority = 'eta' and authority_ref = $2`, [p.org_id, r.uuid]);
            if (!doc) continue;
            await tx.query(`update government_submissions set status = $3, response = response || $4::jsonb where document_id = $1 and external_id = $2 and status = 'submitted'`,
              [doc.id, p.external_id, valid ? 'accepted' : 'rejected', JSON.stringify({ etaStatus: r.status })]);
            await tx.query(`update fiscal_documents set status = $2 where id = $1`, [doc.id, valid ? 'accepted' : 'rejected']);
            settled++;
          }
        }, 'system:fiscal');
      } catch (e) {
        this.logger.warn(`ETA status ${p.external_id}: ${redactedError(e).message}`);
      }
    }
    return { submissions: pending.length, settled };
  }
}

/** Compliance-check samples: the unit's own seller data, a 1.00 + 15 % line, notes referencing the sample invoice. */
function sampleDocument(kind: 'simplified_invoice' | 'credit_note' | 'debit_note', p: any, counter: number, invoiceUuid: string): FiscalDocumentModel {
  const issuedAt = new Date(Math.floor(Date.now() / 1000) * 1000).toISOString();
  return {
    kind, number: `${kind === 'simplified_invoice' ? 'SINV' : kind === 'credit_note' ? 'CN' : 'DN'}-COMPLIANCE-${counter}`,
    uuid: kind === 'simplified_invoice' ? invoiceUuid : randomUUID(), counterValue: counter, issuedAt, currency: 'SAR', previousHash: null,
    seller: { name: p.registered_name, vatNumber: p.vat_number, country: 'SA', address: p.registered_address ?? {}, commercialRegistration: null, branchCode: null, activityCode: null, posSerial: null },
    buyer: { name: null },
    lines: [{ code: 'compliance', name: 'Compliance check item', quantity: 1, netMinor: 100, discountMinor: 0, vatMinor: 15, grossMinor: 115, vatRateBp: 1500 }],
    totals: { netMinor: 100, vatMinor: 15, grossMinor: 115, discountMinor: 0 },
    paymentMethod: 'cash',
    reference: kind === 'simplified_invoice' ? null : { number: 'SINV-COMPLIANCE-1', uuid: invoiceUuid, issuedAt },
    reason: kind === 'simplified_invoice' ? null : 'Compliance check',
  } as FiscalDocumentModel;
}
