import { Injectable } from '@nestjs/common';
import { formatMoney, type CollectPayment, type CreatePaymentLink, type CreateRefund, type Currency } from '@resuto/contracts';
import { paymentAdapter, PAYMENT_ADAPTERS } from '@resuto/integrations';
import type { TenantContext } from '../../common/auth/context';
import { DbService, type Tx } from '../../common/db/db.service';
import { DomainError, conflict, invalid, notFound } from '../../common/errors/domain-error';
import { AuditService } from '../../common/platform/audit.service';
import { IdempotencyService } from '../../common/platform/idempotency.service';
import { PaymentLedgerService, type PaymentMethod } from '../kernel/payment-ledger.service';
import { BillsService } from './bills.service';
import { CheckoutService } from './checkout.service';
import { PaymentProvidersService } from './providers.service';
import { ReceiptsService } from './receipts.service';
import { RefundsService } from './refunds.service';
import { iso, SETTLED, toPayment, toRefund } from './util';

const MANUAL_REFUND: Record<string, string> = {
  cash: 'Return {amount} in cash to the guest, then mark this refund as completed.',
  cod: 'Return {amount} in cash to the customer (or credit it on their next order), then mark this refund as completed.',
  instapay: 'Send {amount} back by InstaPay to the account that made the original transfer (reference {ref}), then mark this refund as completed.',
  bank_transfer: 'Transfer {amount} back to the original sender account (reference {ref}), then mark this refund as completed.',
  card: 'This card payment was taken on an external terminal. Refund {amount} on the terminal (reference {ref}), then mark this refund as completed.',
  provider: 'Refund {amount} in the {provider} dashboard for transaction {ref}, then mark this refund as completed.',
};

/** Staff payments: list/detail, cash/COD/InstaPay/bank collection, payment links, refunds, receipts, alerts. */
@Injectable()
export class StaffPaymentsService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly idempotency: IdempotencyService,
    private readonly ledger: PaymentLedgerService,
    private readonly checkout: CheckoutService,
    private readonly bills: BillsService,
    private readonly providers: PaymentProvidersService,
    private readonly receipts: ReceiptsService,
    private readonly refunds: RefundsService,
  ) {}

  async list(ctx: TenantContext, q: { status?: string; method?: string; provider?: string; branchId?: string; orderId?: string; from?: string; to?: string; limit: number; cursor?: string }) {
    if (q.branchId) ctx.assertBranch(q.branchId);
    return this.db.scoped(ctx, async (tx) => {
      const cursor = q.cursor ? decodeCursor(q.cursor) : null;
      const rows = await tx.query<any>(
        `select p.*, (select string_agg(distinct o.number, ', ') from payment_allocations a join orders o on o.id = a.order_id where a.payment_id = p.id) as order_numbers
           from payments p
          where p.org_id = $1 and ($2::text is null or p.status::text = $2) and ($3::text is null or p.method::text = $3) and ($4::text is null or p.provider = $4)
            and ($5::uuid is null or p.branch_id = $5) and ($6::uuid is null or p.order_id = $6 or exists (select 1 from payment_allocations a where a.payment_id = p.id and a.order_id = $6))
            and ($7::date is null or p.created_at >= $7::date) and ($8::date is null or p.created_at < $8::date + 1)
            and ($9::timestamptz is null or (p.created_at, p.id) < ($9::timestamptz, $10::uuid))
          order by p.created_at desc, p.id desc limit $11`,
        [ctx.orgId, q.status ?? null, q.method ?? null, q.provider ?? null, q.branchId ?? null, q.orderId ?? null, q.from ?? null, q.to ?? null,
          cursor?.at ?? null, cursor?.id ?? null, q.limit]);
      const items = rows.map((r) => ({ ...toPayment(r), orderNumbers: r.order_numbers }));
      const last = rows[rows.length - 1];
      return { items, nextCursor: rows.length === q.limit && last ? encodeCursor(last.created_at, last.id) : null };
    });
  }

  async detail(ctx: TenantContext, paymentId: string) {
    return this.db.scoped(ctx, async (tx) => {
      const p = await tx.maybeOne<any>('select * from payments where id = $1', [paymentId]);
      if (!p) throw notFound('Payment');
      ctx.assertBranch(p.branch_id);
      const allocations = await tx.query<any>(
        `select a.id, a.order_id, a.amount_minor, a.kind, a.created_at, o.number from payment_allocations a join orders o on o.id = a.order_id
          where a.payment_id = $1 order by a.id`, [paymentId]);
      const refunds = await tx.query<any>('select * from refunds where payment_id = $1 order by created_at', [paymentId]);
      const session = p.checkout_session_id ? await tx.maybeOne<any>(
        `select id, purpose, channel, status, amount_minor, expires_at, created_at from checkout_sessions where id = $1`, [p.checkout_session_id]) : null;
      const pendingRefunds = refunds.filter((r) => ['pending', 'manual_required'].includes(r.status)).reduce((s, r) => s + Number(r.amount_minor), 0);
      const supportsProviderRefund = !!paymentAdapter(p.provider) && (p.provider === 'simulated' || !!p.connection_id);
      return {
        ...toPayment(p),
        allocations: allocations.map((a) => ({ id: a.id, orderId: a.order_id, orderNumber: a.number, amountMinor: Number(a.amount_minor), kind: a.kind, createdAt: iso(a.created_at) })),
        refunds: refunds.map(toRefund),
        checkoutSession: session && { id: session.id, purpose: session.purpose, channel: session.channel, status: session.status, amountMinor: session.amount_minor, createdAt: iso(session.created_at) },
        refundableMinor: SETTLED.includes(p.status) ? Math.max(0, p.amount_minor - p.refunded_minor - pendingRefunds) : 0,
        refundMode: !SETTLED.includes(p.status) ? null : supportsProviderRefund ? 'provider' : 'manual',
        hasReceipt: SETTLED.includes(p.status),
      };
    });
  }

  /** Records money staff physically received or verified (cash, COD, InstaPay, bank transfer, external card terminal). */
  async collect(ctx: TenantContext, body: CollectPayment) {
    return this.db.scoped(ctx, (tx) => this.idempotency.run(tx, ctx.orgId, 'payments.collect', body.key, body, async () => {
      const target = await this.collectTarget(tx, body);
      ctx.assertBranch(target.branchId);
      if (body.method === 'cod' && target.fulfillment !== 'delivery') throw invalid('cod_requires_delivery', 'Cash on delivery applies to delivery orders only');
      if (body.driverId && !(await tx.maybeOne('select 1 from drivers where id = $1', [body.driverId]))) throw notFound('Driver');
      if (target.visitId && !body.shareId) await this.bills.applyCredit(tx, ctx, target.visitId);
      const payment = await this.ledger.recordSucceeded(tx, ctx, {
        branchId: target.branchId, orderId: target.orderId, visitId: target.visitId, shareId: body.shareId ?? null,
        method: body.method as PaymentMethod, provider: 'manual', amountMinor: body.amountMinor, currency: target.currency,
        idempotencyKey: `collect:${body.key}`, driverId: body.driverId ?? null,
        raw: { reference: body.reference ?? null, note: body.note ?? null, collectedBy: ctx.userId },
      });
      await this.audit.record(tx, ctx, { action: 'payment.collected', entityType: 'payment', entityId: payment.id, branchId: target.branchId,
        metadata: { method: body.method, amountMinor: body.amountMinor, reference: body.reference ?? null, orderId: target.orderId, visitId: target.visitId, shareId: body.shareId ?? null } });
      return toPayment(await tx.one('select * from payments where id = $1', [payment.id]));
    }));
  }

  private async collectTarget(tx: Tx, body: CollectPayment) {
    const currency = async () => (await tx.one<any>(`select currency from organizations where id = app.current_org_id()`)).currency as string;
    if (body.shareId) {
      const s = await tx.maybeOne<any>(
        `select s.status, sp.visit_id, sp.order_id, sp.branch_id, sp.currency, sp.status as split_status from bill_shares s join bill_splits sp on sp.id = s.split_id where s.id = $1`, [body.shareId]);
      if (!s || s.status === 'void' || s.split_status === 'cancelled') throw notFound('Bill share');
      return { branchId: s.branch_id, orderId: s.order_id, visitId: s.visit_id, currency: s.currency, fulfillment: 'dine_in' };
    }
    if (body.orderId) {
      const o = await tx.maybeOne<any>('select branch_id, currency, fulfillment, status from orders where id = $1', [body.orderId]);
      if (!o) throw notFound('Order');
      if (o.status === 'cancelled') throw conflict('order_cancelled', 'This order was cancelled');
      return { branchId: o.branch_id, orderId: body.orderId, visitId: null, currency: o.currency, fulfillment: o.fulfillment };
    }
    const v = await tx.maybeOne<any>('select branch_id, status from visits where id = $1', [body.visitId]);
    if (!v) throw notFound('Table bill');
    if (v.status !== 'open') throw conflict('visit_closed', 'This table session has ended');
    if (await tx.maybeOne(`select 1 from bill_splits where visit_id = $1 and status = 'open'`, [body.visitId])) {
      throw conflict('split_active', 'This bill is split; collect against a share');
    }
    return { branchId: v.branch_id, orderId: null, visitId: body.visitId!, currency: await currency(), fulfillment: 'dine_in' };
  }

  // ---------------------------------------------------------------------------
  // Payment links (manual sharing by staff)
  // ---------------------------------------------------------------------------
  async createLink(ctx: TenantContext, body: CreatePaymentLink) {
    // The sealed link is read after commit (tenant context cannot see the uncommitted row).
    const row = await this.db.scoped(ctx, async (tx) => {
      const r = await this.idempotency.run(tx, ctx.orgId, 'payments.link', body.key, body, async () => {
        const created = await this.checkout.createSession(tx, ctx, {
          purpose: 'payment_link', orderId: body.orderId ?? null, visitId: body.orderId ? null : body.visitId ?? null, amountMinor: body.amountMinor,
          allowedMethods: body.allowedMethods as PaymentMethod[] | undefined, channel: 'staff', description: body.description ?? null, expiresInMinutes: body.expiresInMinutes,
        });
        await this.audit.record(tx, ctx, { action: 'payment_link.created', entityType: 'checkout_session', entityId: created.id, metadata: { amountMinor: created.amountMinor } });
        return { sessionId: created.id };
      });
      return this.linkRow(tx, r.sessionId);
    });
    return this.linkView(ctx.orgId, row, await this.sealed(ctx.orgId, [row.id]));
  }

  private linkRow(tx: Tx, id: string) {
    return tx.one<any>(
      `select id, branch_id, purpose, order_id, visit_id, share_id, reservation_id, amount_minor, currency, description, allowed_methods, status, channel,
              expires_at, paid_at, created_at, created_by, is_test from checkout_sessions where id = $1`, [id]);
  }

  /** Sealed link tokens are not selectable by member sessions; read them in tenant context. */
  private async sealed(orgId: string, ids: string[]): Promise<Map<string, string | null>> {
    if (!ids.length) return new Map();
    const rows = await this.db.withTenant(orgId, (t) => t.query<{ id: string; token_sealed: string | null }>(
      'select id, token_sealed from checkout_sessions where id = any($1::uuid[])', [ids]), 'payments:links');
    return new Map(rows.map((r) => [r.id, r.token_sealed]));
  }

  private linkView(orgId: string, s: any, sealed: Map<string, string | null>) {
    const status = ['open', 'processing'].includes(s.status) && new Date(s.expires_at) <= new Date() ? 'expired' : s.status;
    return {
      id: s.id, branchId: s.branch_id, purpose: s.purpose, orderId: s.order_id, visitId: s.visit_id, shareId: s.share_id, reservationId: s.reservation_id,
      amountMinor: s.amount_minor, currency: s.currency, description: s.description, allowedMethods: String(s.allowed_methods).replace(/[{}]/g, '').split(',').filter(Boolean),
      status, channel: s.channel, isTest: s.is_test, expiresAt: iso(s.expires_at), paidAt: iso(s.paid_at), createdAt: iso(s.created_at),
      url: ['open', 'processing'].includes(status) ? this.checkout.linkFor(orgId, sealed.get(s.id) ?? null) : null,
    };
  }

  async listLinks(ctx: TenantContext, q: { status?: string; limit?: number }) {
    return this.db.scoped(ctx, async (tx) => {
      const rows = await tx.query<any>(
        `select id, branch_id, purpose, order_id, visit_id, share_id, reservation_id, amount_minor, currency, description, allowed_methods, status, channel,
                expires_at, paid_at, created_at, created_by, is_test from checkout_sessions
          where org_id = $1 and ($2::text is null or status = $2) order by created_at desc limit $3`, [ctx.orgId, q.status ?? null, Math.min(q.limit ?? 50, 200)]);
      const sealed = await this.sealed(ctx.orgId, rows.filter((r) => ctx.canAccessBranch(r.branch_id)).map((r) => r.id));
      return { items: rows.filter((r) => ctx.canAccessBranch(r.branch_id)).map((r) => this.linkView(ctx.orgId, r, sealed)), nextCursor: null };
    });
  }

  async cancelLink(ctx: TenantContext, id: string) {
    return this.db.scoped(ctx, async (tx) => {
      const s = await tx.maybeOne<any>('select id, branch_id, status from checkout_sessions where id = $1 for update', [id]);
      if (!s) throw notFound('Payment link');
      ctx.assertBranch(s.branch_id);
      if (s.status !== 'open') throw conflict('link_not_open', `This link is ${s.status}`);
      await tx.query(`update checkout_sessions set status = 'cancelled' where id = $1`, [id]);
      await this.audit.record(tx, ctx, { action: 'payment_link.cancelled', entityType: 'checkout_session', entityId: id, branchId: s.branch_id });
      return this.linkView(ctx.orgId, await this.linkRow(tx, id), new Map());
    });
  }

  // ---------------------------------------------------------------------------
  // Refunds
  // ---------------------------------------------------------------------------
  async refund(ctx: TenantContext, paymentId: string, body: CreateRefund) {
    const phase1 = await this.db.scoped(ctx, async (tx) => {
      // Lock the payment first: concurrent requests (same key or not) serialise here, so a same-key retry replays (PS-24).
      const p = await tx.maybeOne<any>('select * from payments where id = $1 for update', [paymentId]);
      const existing = await tx.maybeOne<any>('select * from refunds where org_id = $1 and idempotency_key = $2', [ctx.orgId, body.key]);
      if (existing) {
        if (existing.payment_id !== paymentId || Number(existing.amount_minor) !== body.amountMinor) throw conflict('idempotency_key_reused', 'This request key was already used for different data');
        return { replay: toRefund(existing) };
      }
      if (!p) throw notFound('Payment');
      ctx.assertBranch(p.branch_id);
      if (!['succeeded', 'partially_refunded'].includes(p.status)) throw conflict('not_refundable', 'Only settled payments can be refunded');
      if (p.method === 'deposit_credit') throw conflict('not_refundable', 'Deposit credit is refunded through the original deposit payment');
      const pending = await tx.one<{ s: number; provider_pending: number }>(
        `select coalesce(sum(amount_minor), 0)::bigint as s, count(*) filter (where status = 'pending')::int as provider_pending
           from refunds where payment_id = $1 and status in ('pending', 'manual_required')`, [paymentId]);
      const viaProvider = !!paymentAdapter(p.provider) && (p.provider === 'simulated' || !!p.connection_id) && !!p.provider_payment_id;
      // One provider refund at a time per payment: an unconfirmed one must be resolved before another is sent (PAY-05).
      if (viaProvider && pending.provider_pending > 0) {
        throw conflict('refund_in_progress', 'A refund on this payment is still being confirmed with the provider. Check it before refunding again.');
      }
      const refundable = p.amount_minor - p.refunded_minor - Number(pending.s);
      if (body.amountMinor > refundable) throw new DomainError('refund_exceeds_payment', 'Refund exceeds the amount still refundable', 409, { refundableMinor: Math.max(refundable, 0) });
      const amountText = formatMoney(body.amountMinor, p.currency as Currency);
      const template = viaProvider ? null : MANUAL_REFUND[p.provider === 'manual' ? p.method : 'provider'] ?? MANUAL_REFUND.provider!;
      const instructions = template?.replace('{amount}', amountText).replace('{ref}', String(p.raw?.reference ?? p.provider_payment_id ?? p.id)).replace('{provider}', p.provider) ?? null;
      const providerKey = viaProvider ? await this.refunds.nextProviderKey(tx, paymentId) : null;
      const refund = await tx.one<any>(
        `insert into refunds(org_id, payment_id, amount_minor, reason, status, idempotency_key, created_by, provider, instructions, provider_idempotency_key)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) returning *`,
        [ctx.orgId, paymentId, body.amountMinor, body.reason, viaProvider ? 'pending' : 'manual_required', body.key, ctx.userId, p.provider, instructions, providerKey]);
      await this.audit.record(tx, ctx, { action: 'refund.requested', entityType: 'refund', entityId: refund.id, branchId: p.branch_id,
        metadata: { paymentId, amountMinor: body.amountMinor, reason: body.reason, mode: viaProvider ? 'provider' : 'manual' } });
      return { refund, viaProvider };
    });
    if ('replay' in phase1) return phase1.replay;
    if (!phase1.viaProvider) return toRefund(phase1.refund);
    return this.refunds.execute(ctx.orgId, phase1.refund.id, ctx);
  }

  /** Staff confirm a manual refund (cash handed back, transfer sent); only then is the ledger updated. */
  async completeManualRefund(ctx: TenantContext, refundId: string, note?: string | null) {
    return this.db.scoped(ctx, async (tx) => {
      const r = await tx.maybeOne<any>('select r.*, p.branch_id from refunds r join payments p on p.id = r.payment_id where r.id = $1 for update of r', [refundId]);
      if (!r) throw notFound('Refund');
      ctx.assertBranch(r.branch_id);
      if (r.status === 'succeeded') return toRefund(r);
      if (r.status !== 'manual_required') throw conflict('refund_not_manual', `This refund is ${r.status}`);
      await this.ledger.applyRefund(tx, ctx, r.payment_id, Number(r.amount_minor));
      const done = await tx.one<any>(`update refunds set status = 'succeeded', completed_at = now(), completed_by = $2 where id = $1 returning *`, [refundId, ctx.userId]);
      await this.audit.record(tx, ctx, { action: 'refund.completed_manually', entityType: 'refund', entityId: refundId, branchId: r.branch_id, metadata: { note: note ?? null, amountMinor: r.amount_minor } });
      return toRefund(done);
    });
  }

  async listRefunds(ctx: TenantContext, q: { status?: string; limit?: number }) {
    return this.db.scoped(ctx, async (tx) => {
      const rows = await tx.query<any>(
        `select r.*, p.method, p.currency, p.branch_id from refunds r join payments p on p.id = r.payment_id
          where r.org_id = $1 and ($2::text is null or r.status = $2) order by r.created_at desc limit $3`, [ctx.orgId, q.status ?? null, Math.min(q.limit ?? 50, 200)]);
      return { items: rows.filter((r) => ctx.canAccessBranch(r.branch_id)).map((r) => ({ ...toRefund(r), method: r.method, currency: r.currency })), nextCursor: null };
    });
  }

  async receipt(ctx: TenantContext, paymentId: string) {
    return this.db.scoped(ctx, async (tx) => {
      const p = await tx.maybeOne<any>('select branch_id from payments where id = $1', [paymentId]);
      if (!p) throw notFound('Receipt');
      ctx.assertBranch(p.branch_id);
      return this.receipts.build(tx, paymentId);
    });
  }

  // ---------------------------------------------------------------------------
  async alerts(ctx: TenantContext, status: 'open' | 'resolved' | 'all' = 'open') {
    return this.db.scoped(ctx, async (tx) => {
      const rows = await tx.query<any>(
        `select * from payment_alerts where org_id = $1 and ($2 = 'all' or status = $2) order by created_at desc limit 200`, [ctx.orgId, status]);
      return { items: rows.map((a) => ({ id: a.id, kind: a.kind, branchId: a.branch_id, paymentId: a.payment_id, checkoutSessionId: a.checkout_session_id,
        provider: a.provider, details: a.details, status: a.status, createdAt: iso(a.created_at), resolvedAt: iso(a.resolved_at) })), nextCursor: null };
    });
  }

  async resolveAlert(ctx: TenantContext, id: string) {
    return this.db.scoped(ctx, async (tx) => {
      const a = await tx.maybeOne<any>(`update payment_alerts set status = 'resolved', resolved_at = now(), resolved_by = $2 where id = $1 returning id, branch_id`, [id, ctx.userId]);
      if (!a) throw notFound('Alert');
      await this.audit.record(tx, ctx, { action: 'payment_alert.resolved', entityType: 'payment_alert', entityId: id, branchId: a.branch_id });
      return { id, status: 'resolved' };
    });
  }

  async config(ctx: TenantContext, branchId: string) {
    ctx.assertBranch(branchId);
    return this.db.scoped(ctx, async (tx) => {
      if (!(await tx.maybeOne('select 1 from branches where id = $1', [branchId]))) throw notFound('Branch');
      const connections = await tx.query<any>(
        `select id, provider, branch_id, environment, status, credentials_hint, last_error from integration_connections where org_id = $1 and category = 'payments' order by created_at`, [ctx.orgId]);
      return {
        mode: this.providers.mode,
        methods: { dineIn: await this.checkout.methods(tx, ctx.orgId, branchId, 'visit_bill', 'dine_in'), delivery: await this.checkout.methods(tx, ctx.orgId, branchId, 'order', 'delivery'),
          deposit: await this.checkout.methods(tx, ctx.orgId, branchId, 'reservation_deposit') },
        providers: Object.values(PAYMENT_ADAPTERS).map((a) => ({ ...a.descriptor, methods: a.methods, requiredCredentials: a.requiredCredentials,
          usable: a.descriptor.id === 'simulated' ? this.providers.mode === 'sandbox' : connections.some((c) => c.provider === a.descriptor.id && ['connected', 'sandbox'].includes(c.status) && (c.environment === 'sandbox') === (this.providers.mode === 'sandbox')) })),
        connections: connections.map((c) => ({ id: c.id, provider: c.provider, branchId: c.branch_id, environment: c.environment, status: c.status, credentialsHint: c.credentials_hint, lastError: c.last_error })),
      };
    });
  }
}

const encodeCursor = (at: Date, id: string) => Buffer.from(`${new Date(at).toISOString()}|${id}`).toString('base64url');
function decodeCursor(c: string) {
  const [at, id] = Buffer.from(c, 'base64url').toString().split('|');
  if (!at || !id || Number.isNaN(Date.parse(at))) throw invalid('invalid_cursor', 'Invalid cursor');
  return { at, id };
}
