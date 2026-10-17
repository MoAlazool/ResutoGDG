import { Injectable } from '@nestjs/common';
import type { FiscalDocumentView, FiscalKind, FiscalLine } from '@resuto/contracts';
import {
  buildEtaReceipt, buildZatcaInvoiceXml, EtaSandboxStubClient, etaReceiptQrUrl, fiscalCanonicalJson, fiscalSha256Hex, ZATCA_GENESIS_PIH,
  zatcaInvoiceHash, zatcaQrForDocument, ZatcaSandboxStubClient, type EtaClient, type FiscalDocumentModel, type ZatcaClient,
} from '@resuto/integrations';
import { randomUUID } from 'node:crypto';
import type { TenantContext } from '../../common/auth/context';
import { DbService, type Tx } from '../../common/db/db.service';
import { DomainError, conflict, invalid, notFound } from '../../common/errors/domain-error';
import { AuditService } from '../../common/platform/audit.service';
import { OutboxService } from '../../common/platform/outbox.service';
import { creditLines, fiscalLinesForOrder } from './fiscal-lines';
import { TaxProfileService } from './tax-profile.service';

type Authority = 'zatca' | 'eta';
const SALE_KINDS = ['simplified_invoice', 'standard_invoice', 'receipt'];
const PREFIX: Record<Authority, Partial<Record<FiscalKind, string>>> = {
  zatca: { simplified_invoice: 'SINV', standard_invoice: 'INV', credit_note: 'CN', debit_note: 'DN' },
  eta: { receipt: 'R', credit_note: 'RR' },
};
const TITLES: Record<FiscalKind, { en: string; ar: string }> = {
  simplified_invoice: { en: 'Simplified Tax Invoice', ar: 'فاتورة ضريبية مبسطة' },
  standard_invoice: { en: 'Tax Invoice', ar: 'فاتورة ضريبية' },
  receipt: { en: 'Electronic Receipt', ar: 'إيصال إلكتروني' },
  credit_note: { en: 'Credit Note', ar: 'إشعار دائن' },
  debit_note: { en: 'Debit Note', ar: 'إشعار مدين' },
};

interface IssueInput {
  authority: Authority;
  environment: string | null;
  kind: FiscalKind;
  branchId: string;
  orderId: string;
  paymentId?: string | null;
  currency: string;
  lines: FiscalLine[];
  seller: Record<string, any>;
  buyer: Record<string, any>;
  meta: Record<string, any>;
  referencesDocumentId?: string | null;
}

export type IssueResult = { id: string; created: boolean } | { skipped: string };

/**
 * Fiscal documents (simplified tax invoices for ZATCA, e-receipts for ETA,
 * credit notes for refunds). Each document gets the next value of its
 * per-branch series counter (row lock), Resuto's SHA-256 chain over a
 * canonical JSON of its stored content (previous_hash → document_hash), the
 * authority chain (ZATCA PIH / ETA previousUUID), and a QR payload. Documents
 * are immutable (DB trigger); only `status` changes. Submissions go to clearly
 * labelled sandbox stubs — nothing is sent to ZATCA or the ETA.
 */
@Injectable()
export class FiscalService {
  readonly zatca: ZatcaClient = new ZatcaSandboxStubClient();
  readonly eta: EtaClient = new EtaSandboxStubClient();

  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly profiles: TaxProfileService,
  ) {}

  // ---------------------------------------------------------------------------
  // Issue
  // ---------------------------------------------------------------------------
  /** Issues the sales document for a fully paid order (idempotent). strict=true throws instead of skipping. */
  async issueForOrder(tx: Tx, ctx: TenantContext, orderId: string, strict = false): Promise<IssueResult> {
    const skip = (code: string, message: string, status = 422, details?: unknown): IssueResult => {
      if (strict) throw new DomainError(code, message, status, details);
      return { skipped: code };
    };
    const order = await tx.maybeOne<any>('select * from orders where id = $1 for update', [orderId]);
    if (!order) throw notFound('Order');
    ctx.assertBranch(order.branch_id);
    const existing = await tx.maybeOne<{ id: string }>(`select id from fiscal_documents where order_id = $1 and kind = any($2)`, [orderId, SALE_KINDS]);
    if (existing) return { id: existing.id, created: false };
    if (order.status === 'cancelled') return skip('order_cancelled', 'Cancelled orders do not get fiscal documents', 409);
    if (order.paid_minor < order.total_minor || order.total_minor <= 0) return skip('order_not_paid', 'Only fully paid orders get a fiscal document', 409);
    const profile = await this.profiles.load(tx, ctx.orgId);
    if (profile.regime === 'none') return skip('regime_none', 'The tax regime is "none": no fiscal documents are issued');
    if (!profile.is_validated) return skip('tax_profile_incomplete', 'Complete and validate the tax profile first', 422, profile.validation_errors);

    const lines = await tx.query<any>(
      `select product_id, name, name_ar, quantity, unit_price_minor, modifiers_total_minor, line_total_minor from order_lines where order_id = $1 order by id`, [orderId]);
    const payment = await tx.maybeOne<{ method: string }>(
      `select p.method from payment_allocations a join payments p on p.id = a.payment_id where a.order_id = $1 and a.kind = 'payment' order by a.id desc limit 1`, [orderId]);
    const org = await tx.one<any>('select commercial_registration from organizations where id = $1', [ctx.orgId]);
    const authority = profile.regime as Authority;
    return this.issue(tx, ctx, {
      authority,
      environment: authority === 'zatca' ? profile.zatca_environment : profile.eta_environment,
      kind: authority === 'zatca' ? 'simplified_invoice' : 'receipt',
      branchId: order.branch_id,
      orderId,
      currency: order.currency,
      lines: fiscalLinesForOrder(order, lines, profile.vat_rate_bp),
      seller: {
        name: profile.registered_name, vatNumber: profile.vat_number, country: profile.country, address: profile.registered_address ?? {},
        commercialRegistration: org.commercial_registration ?? null, branchCode: profile.eta_branch_code ?? null,
        activityCode: profile.eta_activity_code ?? null, posSerial: profile.eta_pos_serial ?? null, egsSerial: profile.zatca_egs_serial ?? null,
      },
      buyer: order.customer_name ? { name: order.customer_name } : {},
      meta: { paymentMethod: this.paymentMeans(payment?.method), vatRateBp: profile.vat_rate_bp, orderNumber: order.number, fulfillment: order.fulfillment },
    });
  }

  /** Credit notes for a refund: one per (order, payment) delta, never more than the invoice total. */
  async creditForRefund(tx: Tx, ctx: TenantContext, paymentId: string): Promise<string[]> {
    const allocations = await tx.query<{ order_id: string; refunded: number }>(
      `select order_id, (-sum(amount_minor))::bigint as refunded from payment_allocations
        where payment_id = $1 and kind = 'refund' group by order_id order by order_id`, [paymentId]);
    const issued: string[] = [];
    for (const a of allocations) {
      await tx.query('select id from orders where id = $1 for update', [a.order_id]);
      const invoice = await tx.maybeOne<any>(`select * from fiscal_documents where order_id = $1 and kind = any($2)`, [a.order_id, SALE_KINDS]);
      if (!invoice) continue;
      const credited = await tx.one<{ for_payment: number; all: number }>(
        `select coalesce(sum(total_minor) filter (where payment_id = $2), 0)::bigint as for_payment, coalesce(sum(total_minor), 0)::bigint as all
           from fiscal_documents where order_id = $1 and kind = 'credit_note'`, [a.order_id, paymentId]);
      const amount = Math.min(Number(a.refunded) - Number(credited.for_payment), invoice.total_minor - Number(credited.all));
      if (amount <= 0) continue;
      const res = await this.issue(tx, ctx, {
        authority: invoice.authority, environment: invoice.meta?.environment ?? invoice.seller?.environment ?? null, kind: 'credit_note',
        branchId: invoice.branch_id, orderId: a.order_id, paymentId, currency: invoice.currency,
        lines: creditLines(invoice, amount, Number(credited.all) === 0),
        seller: invoice.seller, buyer: invoice.buyer,
        meta: {
          ...invoice.meta, reason: 'Refund', refundOfPaymentId: paymentId,
          reference: { number: invoice.number, uuid: invoice.authority === 'eta' ? invoice.authority_ref : invoice.document_uuid, issuedAt: new Date(invoice.issued_at).toISOString() },
        },
        referencesDocumentId: invoice.id,
      });
      if ('id' in res) issued.push(res.id);
    }
    return issued;
  }

  private async issue(tx: Tx, ctx: TenantContext, p: IssueInput): Promise<IssueResult> {
    const branch = await tx.one<{ code: string }>('select code from branches where id = $1', [p.branchId]);
    const series = `${p.authority.toUpperCase()}-${branch.code}`;
    await tx.query(`insert into fiscal_counters(org_id, branch_id, series) values ($1, $2, $3) on conflict (branch_id, series) do nothing`, [ctx.orgId, p.branchId, series]);
    const counter = await tx.one<{ last_value: number; last_hash: string | null; last_authority_ref: string | null }>(
      `select last_value, last_hash, last_authority_ref from fiscal_counters where branch_id = $1 and series = $2 for update`, [p.branchId, series]);
    const value = Number(counter.last_value) + 1;
    const number = `${PREFIX[p.authority][p.kind] ?? 'DOC'}-${String(value).padStart(6, '0')}`;
    const uuid = randomUUID();
    const issuedAt = new Date(Math.floor(Date.now() / 1000) * 1000).toISOString();
    const totals = {
      subtotalMinor: p.lines.reduce((s, l) => s + l.netMinor, 0),
      taxMinor: p.lines.reduce((s, l) => s + l.vatMinor, 0),
      totalMinor: p.lines.reduce((s, l) => s + l.grossMinor, 0),
    };
    const meta = { ...p.meta, environment: p.environment };
    const draft = {
      branch_id: p.branchId, order_id: p.orderId, payment_id: p.paymentId ?? null, kind: p.kind, series, number, counter_value: value,
      document_uuid: uuid, issued_at: issuedAt, currency: p.currency, subtotal_minor: totals.subtotalMinor, tax_minor: totals.taxMinor,
      total_minor: totals.totalMinor, seller: p.seller, buyer: p.buyer, meta, lines: p.lines, references_document_id: p.referencesDocumentId ?? null,
      authority: p.authority, previous_authority_ref: counter.last_authority_ref, previous_hash: counter.last_hash,
    } as Record<string, any>;
    const model = this.toModel(draft);
    if (p.authority === 'zatca') {
      draft.qr_payload = zatcaQrForDocument(model);
      draft.authority_ref = zatcaInvoiceHash(model, counter.last_authority_ref);
    } else {
      const { receipt, uuid: etaUuid } = buildEtaReceipt(model, counter.last_authority_ref);
      draft.authority_ref = etaUuid;
      draft.qr_payload = etaReceiptQrUrl(p.environment === 'production' ? 'production' : 'preprod', etaUuid, receipt.header.dateTimeIssued, receipt.totalAmount, model.seller.vatNumber);
    }
    draft.document_hash = this.hashOf(draft);
    const row = await tx.one<any>(
      `insert into fiscal_documents(org_id, branch_id, order_id, payment_id, kind, series, number, counter_value, document_uuid, previous_hash,
          document_hash, qr_payload, currency, subtotal_minor, tax_minor, total_minor, buyer, lines, issued_at, status, references_document_id,
          authority, authority_ref, previous_authority_ref, seller, meta)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, 'issued', $20, $21, $22, $23, $24, $25)
       returning *`,
      [ctx.orgId, draft.branch_id, draft.order_id, draft.payment_id, draft.kind, series, number, value, uuid, draft.previous_hash,
        draft.document_hash, draft.qr_payload, draft.currency, draft.subtotal_minor, draft.tax_minor, draft.total_minor, JSON.stringify(draft.buyer),
        JSON.stringify(draft.lines), issuedAt, draft.references_document_id, draft.authority, draft.authority_ref, draft.previous_authority_ref,
        JSON.stringify(draft.seller), JSON.stringify(meta)]);
    await tx.query(`update fiscal_counters set last_value = $3, last_hash = $4, last_authority_ref = $5 where branch_id = $1 and series = $2`,
      [p.branchId, series, value, row.document_hash, row.authority_ref]);
    await this.outbox.publish(tx, ctx.orgId, {
      type: 'fiscal_document.issued', aggregateType: 'fiscal_document', aggregateId: row.id,
      payload: { kind: row.kind, number, orderId: p.orderId, branchId: p.branchId, totalMinor: row.total_minor, authority: p.authority },
    });
    await this.submit(tx, ctx, row);
    return { id: row.id, created: true };
  }

  // ---------------------------------------------------------------------------
  // Hashing, model reconstruction, submission
  // ---------------------------------------------------------------------------
  /** SHA-256 hex over a canonical JSON of the document's stored content (key-order independent). */
  hashOf(r: Record<string, any>): string {
    return fiscalSha256Hex(fiscalCanonicalJson({
      branchId: r.branch_id, orderId: r.order_id ?? null, paymentId: r.payment_id ?? null, kind: r.kind, series: r.series, number: r.number,
      counterValue: Number(r.counter_value), uuid: r.document_uuid, issuedAt: new Date(r.issued_at).toISOString(), currency: r.currency,
      subtotalMinor: Number(r.subtotal_minor), taxMinor: Number(r.tax_minor), totalMinor: Number(r.total_minor), seller: r.seller, buyer: r.buyer,
      meta: r.meta, lines: r.lines, qrPayload: r.qr_payload ?? null, referencesDocumentId: r.references_document_id ?? null,
      authority: r.authority, authorityRef: r.authority_ref ?? null, previousAuthorityRef: r.previous_authority_ref ?? null, previousHash: r.previous_hash ?? null,
    }));
  }

  /** Rebuilds the neutral model purely from stored columns (deterministic payloads for resubmission). */
  toModel(r: Record<string, any>): FiscalDocumentModel {
    const lines: FiscalLine[] = r.lines;
    const ref = r.meta?.reference;
    return {
      kind: r.kind, number: r.number, uuid: r.document_uuid, counterValue: Number(r.counter_value), issuedAt: new Date(r.issued_at).toISOString(),
      currency: r.currency, previousHash: r.previous_hash ?? null,
      seller: {
        name: r.seller?.name ?? '', vatNumber: r.seller?.vatNumber ?? '', country: r.seller?.country ?? 'SA', address: r.seller?.address ?? {},
        commercialRegistration: r.seller?.commercialRegistration ?? null, branchCode: r.seller?.branchCode ?? null,
        activityCode: r.seller?.activityCode ?? null, posSerial: r.seller?.posSerial ?? null,
      },
      buyer: { name: r.buyer?.name ?? null },
      lines: lines.map((l, i) => ({ code: l.code ?? `L${i + 1}`, name: l.name, quantity: l.quantity, netMinor: l.netMinor, discountMinor: l.discountMinor,
        vatMinor: l.vatMinor, grossMinor: l.grossMinor, vatRateBp: l.vatRateBp })),
      totals: { netMinor: Number(r.subtotal_minor), vatMinor: Number(r.tax_minor), grossMinor: Number(r.total_minor), discountMinor: lines.reduce((s, l) => s + l.discountMinor, 0) },
      paymentMethod: r.meta?.paymentMethod ?? 'other',
      reference: ref ? { number: ref.number, uuid: ref.uuid, issuedAt: ref.issuedAt } : null,
      reason: r.meta?.reason ?? null,
    };
  }

  /** Builds the authority payload exactly as at issue time. */
  payloadOf(r: any): { format: 'xml' | 'json'; payload: string; authorityRef: string } {
    const model = this.toModel(r);
    if (r.authority === 'zatca') {
      const xml = buildZatcaInvoiceXml(model, { previousInvoiceHash: r.previous_authority_ref ?? ZATCA_GENESIS_PIH, includeQr: true, qr: r.qr_payload });
      return { format: 'xml', payload: xml, authorityRef: zatcaInvoiceHash(model, r.previous_authority_ref) };
    }
    const { receipt, uuid } = buildEtaReceipt(model, r.previous_authority_ref);
    return { format: 'json', payload: JSON.stringify(receipt, null, 2), authorityRef: uuid };
  }

  private async submit(tx: Tx, ctx: TenantContext, r: any) {
    const model = this.toModel(r);
    let result;
    if (r.authority === 'zatca') {
      const { payload } = this.payloadOf(r);
      const submission = { uuid: r.document_uuid, invoiceHash: r.authority_ref, invoiceXmlBase64: Buffer.from(payload).toString('base64') };
      result = r.kind === 'standard_invoice' ? await this.zatca.clearStandard(model, submission) : await this.zatca.reportSimplified(model, submission);
    } else {
      const { receipt, uuid } = buildEtaReceipt(model, r.previous_authority_ref);
      result = await this.eta.submitReceipts([{ doc: model, receipt, uuid }]);
    }
    const { attempt } = await tx.one<{ attempt: number }>('select coalesce(max(attempt), 0) + 1 as attempt from government_submissions where document_id = $1', [r.id]);
    await tx.query(
      `insert into government_submissions(org_id, document_id, authority, environment, mode, status, request_digest, response, attempt)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [ctx.orgId, r.id, r.authority, r.meta?.environment ?? 'sandbox', result.mode, result.status, result.requestDigest, result.response, attempt]);
    // Only local validation ran; "error" means our own structural checks failed (never an authority verdict).
    const status = result.status === 'rejected' ? 'error' : r.status === 'error' ? 'issued' : r.status;
    if (status !== r.status) await tx.query('update fiscal_documents set status = $2 where id = $1', [r.id, status]);
    return { attempt, ...result };
  }

  private paymentMeans(method?: string | null): FiscalDocumentModel['paymentMethod'] {
    if (!method) return 'other';
    return (['cash', 'card', 'cod', 'wallet', 'instapay', 'bank_transfer'] as const).find((m) => m === method) ?? 'other';
  }

  // ---------------------------------------------------------------------------
  // Read models and staff actions
  // ---------------------------------------------------------------------------
  private toView(r: any): FiscalDocumentView {
    return {
      id: r.id, branchId: r.branch_id, orderId: r.order_id, kind: r.kind, series: r.series, number: r.number, counterValue: Number(r.counter_value),
      uuid: r.document_uuid, previousHash: r.previous_hash, documentHash: r.document_hash, qrPayload: r.qr_payload, currency: r.currency,
      subtotalMinor: r.subtotal_minor, taxMinor: r.tax_minor, totalMinor: r.total_minor, buyer: r.buyer, lines: r.lines,
      issuedAt: new Date(r.issued_at).toISOString(), status: r.status, referencesDocumentId: r.references_document_id, authority: r.authority,
      lastSubmission: r.s_mode ? { mode: r.s_mode, status: r.s_status, submittedAt: new Date(r.s_submitted_at).toISOString() } : null,
    };
  }

  private readonly SELECT = `
    select d.*, s.mode as s_mode, s.status as s_status, s.submitted_at as s_submitted_at
      from fiscal_documents d
      left join lateral (select mode, status, submitted_at from government_submissions g where g.document_id = d.id
                          order by g.attempt desc limit 1) s on true`;

  async list(ctx: TenantContext, q: { kind?: string; branchId?: string; orderId?: string; limit: number; cursor?: string }) {
    if (q.branchId) ctx.assertBranch(q.branchId);
    let cursor: { at: string; id: string } | null = null;
    if (q.cursor) {
      const [at, id] = Buffer.from(q.cursor, 'base64url').toString().split('|');
      if (at && id && !Number.isNaN(Date.parse(at)) && /^[0-9a-f-]{36}$/i.test(id)) cursor = { at, id };
    }
    return this.db.scoped(ctx, async (tx) => {
      const rows = await tx.query(
        `${this.SELECT} where d.org_id = $1 and ($2::uuid[] is null or d.branch_id = any($2)) and ($3::text is null or d.kind = $3)
            and ($4::uuid is null or d.order_id = $4) and ($5::timestamptz is null or (d.issued_at, d.id) < ($5, $6::uuid))
          order by d.issued_at desc, d.id desc limit $7`,
        [ctx.orgId, q.branchId ? [q.branchId] : ctx.branchFilter, q.kind ?? null, q.orderId ?? null, cursor?.at ?? null, cursor?.id ?? null, q.limit]);
      const last = rows[rows.length - 1];
      return {
        items: rows.map((r) => this.toView(r)),
        nextCursor: rows.length === q.limit && last ? Buffer.from(`${new Date(last.issued_at).toISOString()}|${last.id}`).toString('base64url') : null,
      };
    });
  }

  private async row(tx: Tx, ctx: TenantContext, id: string) {
    const r = await tx.maybeOne<any>(`${this.SELECT} where d.id = $1`, [id]);
    if (!r) throw notFound('Fiscal document');
    ctx.assertBranch(r.branch_id);
    return r;
  }

  async detail(ctx: TenantContext, id: string) {
    return this.db.scoped(ctx, async (tx) => {
      const r = await this.row(tx, ctx, id);
      const related = await tx.query(
        `select id, kind, number, total_minor, issued_at from fiscal_documents where (references_document_id = $1 or id = $2) and id <> $1 order by issued_at`,
        [r.id, r.references_document_id]);
      return {
        ...this.toView(r), seller: r.seller, meta: r.meta, authorityRef: r.authority_ref, previousAuthorityRef: r.previous_authority_ref,
        hashVerified: this.hashOf(r) === r.document_hash,
        related: related.map((x) => ({ id: x.id, kind: x.kind, number: x.number, totalMinor: x.total_minor, issuedAt: x.issued_at })),
        readiness: 'implemented_unverified' as const,
      };
    });
  }

  async submissions(ctx: TenantContext, id: string) {
    return this.db.scoped(ctx, async (tx) => {
      await this.row(tx, ctx, id);
      const rows = await tx.query('select * from government_submissions where document_id = $1 order by attempt desc', [id]);
      return { items: rows.map((s) => ({ id: s.id, authority: s.authority, environment: s.environment, mode: s.mode, status: s.status,
        requestDigest: s.request_digest, response: s.response, attempt: s.attempt, submittedAt: s.submitted_at })) };
    });
  }

  async payload(ctx: TenantContext, id: string) {
    return this.db.scoped(ctx, async (tx) => {
      const r = await this.row(tx, ctx, id);
      const p = this.payloadOf(r);
      return { authority: r.authority, ...p, matchesIssued: p.authorityRef === r.authority_ref, readiness: 'implemented_unverified',
        note: r.authority === 'zatca'
          ? 'UBL 2.1 body without UBLExtensions/signature. Signing (CSID, ECDSA) is not configured; not validated with the ZATCA SDK.'
          : 'ETA e-receipt v1.2 structure with derived UUID. Not validated against ETA preprod.' };
    });
  }

  async resubmit(ctx: TenantContext, id: string) {
    return this.db.scoped(ctx, async (tx) => {
      const r = await tx.maybeOne<any>('select * from fiscal_documents where id = $1 for update', [id]);
      if (!r) throw notFound('Fiscal document');
      ctx.assertBranch(r.branch_id);
      if (['accepted', 'cleared', 'reported'].includes(r.status)) throw conflict('already_accepted', 'This document was already accepted by the authority');
      const result = await this.submit(tx, ctx, r);
      await this.audit.record(tx, ctx, { action: 'fiscal_document.resubmitted', entityType: 'fiscal_document', entityId: id, branchId: r.branch_id, metadata: { attempt: result.attempt, mode: result.mode } });
      return { attempt: result.attempt, mode: result.mode, status: result.status, response: result.response };
    });
  }

  async issueManually(ctx: TenantContext, orderId: string) {
    return this.db.scoped(ctx, async (tx) => {
      const res = await this.issueForOrder(tx, ctx, orderId, true);
      if (!('id' in res)) throw invalid(res.skipped, 'No document issued');
      if (res.created) await this.audit.record(tx, ctx, { action: 'fiscal_document.issued_manually', entityType: 'fiscal_document', entityId: res.id, metadata: { orderId } });
      return { ...this.toView(await this.row(tx, ctx, res.id)), created: res.created };
    });
  }

  /** Printable invoice / receipt data (bilingual labels, formatted by the client). */
  async printView(ctx: TenantContext, id: string) {
    return this.db.scoped(ctx, async (tx) => {
      const r = await this.row(tx, ctx, id);
      const org = await tx.one<any>('select name, name_ar from organizations where id = $1', [ctx.orgId]);
      const branch = await tx.one<any>('select name, name_ar, address, city, phone from branches where id = $1', [r.branch_id]);
      const ref = r.references_document_id ? await tx.maybeOne<any>('select number, issued_at from fiscal_documents where id = $1', [r.references_document_id]) : null;
      return {
        id: r.id, kind: r.kind, title: TITLES[r.kind as FiscalKind], number: r.number, series: r.series, issuedAt: new Date(r.issued_at).toISOString(),
        uuid: r.document_uuid, authority: r.authority, environment: r.meta?.environment ?? null,
        seller: { name: r.seller?.name, tradeName: org.name, tradeNameAr: org.name_ar, vatNumber: r.seller?.vatNumber, address: r.seller?.address ?? {},
          branch: { name: branch.name, nameAr: branch.name_ar, address: branch.address, city: branch.city, phone: branch.phone } },
        buyer: r.buyer, currency: r.currency, lines: r.lines,
        totals: { subtotalMinor: r.subtotal_minor, taxMinor: r.tax_minor, totalMinor: r.total_minor, vatRateBp: r.meta?.vatRateBp ?? null },
        orderNumber: r.meta?.orderNumber ?? null, paymentMethod: r.meta?.paymentMethod ?? null,
        reference: ref ? { number: ref.number, issuedAt: ref.issued_at } : null, reason: r.meta?.reason ?? null,
        qr: { kind: r.authority === 'zatca' ? 'zatca_tlv_base64' : 'eta_receipt_url', payload: r.qr_payload },
        submission: r.s_mode ? { mode: r.s_mode, status: r.s_status } : null,
        notice: 'Generated by Resuto. Government submission runs in sandbox-stub mode until the restaurant completes onboarding with the tax authority.',
      };
    });
  }

  /** Recomputes every hash and link of a branch's series; reports the first break per series. */
  async verifyChain(ctx: TenantContext, branchId: string) {
    ctx.assertBranch(branchId);
    return this.db.scoped(ctx, async (tx) => {
      const rows = await tx.query<any>('select * from fiscal_documents where branch_id = $1 order by series, counter_value', [branchId]);
      const bySeries = new Map<string, any[]>();
      for (const r of rows) bySeries.set(r.series, [...(bySeries.get(r.series) ?? []), r]);
      const series = [...bySeries.entries()].map(([name, docs]) => {
        let firstBreak: { number: string; reason: string } | null = null;
        docs.forEach((d, i) => {
          if (firstBreak) return;
          const prev = docs[i - 1];
          if (Number(d.counter_value) !== i + 1) firstBreak = { number: d.number, reason: 'counter_gap' };
          else if (this.hashOf(d) !== d.document_hash) firstBreak = { number: d.number, reason: 'content_hash_mismatch' };
          else if ((prev?.document_hash ?? null) !== d.previous_hash) firstBreak = { number: d.number, reason: 'previous_hash_mismatch' };
          else if ((prev?.authority_ref ?? null) !== d.previous_authority_ref) firstBreak = { number: d.number, reason: 'authority_chain_mismatch' };
        });
        return { series: name, count: docs.length, lastCounter: docs.length ? Number(docs[docs.length - 1].counter_value) : 0, ok: !firstBreak, firstBreak };
      });
      return { branchId, ok: series.every((s) => s.ok), series };
    });
  }
}
