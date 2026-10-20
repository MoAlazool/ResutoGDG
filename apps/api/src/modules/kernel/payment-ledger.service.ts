import { Injectable } from '@nestjs/common';
import { derivePaymentStatus } from '@resuto/contracts';
import type { TenantContext } from '../../common/auth/context';
import type { Tx } from '../../common/db/db.service';
import { DomainError, conflict, invalid, notFound } from '../../common/errors/domain-error';
import { OutboxService } from '../../common/platform/outbox.service';
import { OrdersKernelService } from './orders-kernel.service';

export type PaymentMethod = 'cash' | 'card' | 'wallet' | 'instapay' | 'cod' | 'deposit_credit' | 'bank_transfer' | 'test';

export interface PaymentTarget {
  orderId?: string | null;
  visitId?: string | null;
  reservationId?: string | null;
  shareId?: string | null;
  checkoutSessionId?: string | null;
}

export interface PaymentInput extends PaymentTarget {
  branchId: string;
  method: PaymentMethod;
  provider: string;            // 'manual' for cash/COD, 'simulated' for sandbox, else provider id
  amountMinor: number;
  currency: string;
  providerPaymentId?: string | null;
  connectionId?: string | null;
  idempotencyKey?: string | null;
  isTest?: boolean;
  driverId?: string | null;
  feeMinor?: number | null;
  raw?: Record<string, unknown>;
}

export interface PaymentRow {
  id: string;
  status: string;
  amount_minor: number;
  order_id: string | null;
  visit_id: string | null;
  reservation_id: string | null;
  share_id: string | null;
  checkout_session_id: string | null;
  currency: string;
}

/**
 * Lead-owned payment ledger. The only code that changes orders.paid_minor /
 * refunded_minor / payment_status. Provider adapters (ResutoPay) call
 * createPending() then confirm() from VERIFIED webhooks; cash/COD collection
 * calls recordSucceeded(). Every application is allocated per order in
 * payment_allocations, so table bills and refunds stay auditable.
 */
@Injectable()
export class PaymentLedgerService {
  constructor(private readonly outbox: OutboxService, private readonly orders: OrdersKernelService) {}

  async outstanding(tx: Tx, target: { orderId?: string | null; visitId?: string | null }) {
    const orders = await this.targetOrders(tx, target, false);
    const credit = target.visitId
      ? await tx.one<{ c: number }>('select (credit_minor - credit_used_minor)::bigint as c from visits where id = $1', [target.visitId]).then((r) => Number(r.c))
      : 0;
    const due = orders.reduce((a, o) => a + this.due(o), 0);
    return { orders: orders.map((o) => ({ id: o.id, dueMinor: this.due(o), totalMinor: o.total_minor })), dueMinor: due, availableCreditMinor: credit };
  }

  /** Records an already-settled payment (cash, COD collected, verified manual transfer, sandbox). */
  async recordSucceeded(tx: Tx, ctx: TenantContext, input: PaymentInput): Promise<PaymentRow> {
    const existing = await this.byIdempotency(tx, ctx.orgId, input.idempotencyKey);
    if (existing) return existing;
    if (input.provider === 'manual') await this.assertManualCollection(tx, ctx.orgId, input);
    await this.assertApplicable(tx, input, input.amountMinor);
    if (input.method === 'deposit_credit') await this.consumeVisitCredit(tx, input.visitId ?? null, input.amountMinor);
    const p = await this.insert(tx, ctx, input, 'succeeded');
    await this.apply(tx, ctx, p);
    return p;
  }

  /** Creates a pending attempt for a provider checkout; confirm() settles it later. */
  async createPending(tx: Tx, ctx: TenantContext, input: PaymentInput): Promise<PaymentRow> {
    const existing = await this.byIdempotency(tx, ctx.orgId, input.idempotencyKey);
    if (existing) return existing;
    await this.assertApplicable(tx, input, input.amountMinor);
    return this.insert(tx, ctx, input, 'pending');
  }

  /**
   * Settles a pending payment from a verified provider event. Idempotent:
   * repeated webhooks for an already-succeeded payment are no-ops. The provider's
   * amount and currency must match what Resuto asked for.
   */
  async confirm(tx: Tx, ctx: TenantContext, paymentId: string, evidence: {
    amountMinor: number; currency: string; providerPaymentId?: string | null; feeMinor?: number | null; raw?: Record<string, unknown>;
    /** The environment the verified evidence came from (true = test). A payment is never settled by evidence from the other environment. */
    isTest?: boolean;
  }) {
    const p = await tx.maybeOne<PaymentRow & { provider_payment_id: string | null; is_test: boolean }>('select * from payments where id = $1 for update', [paymentId]);
    if (!p) throw notFound('Payment');
    if (evidence.isTest !== undefined && evidence.isTest !== p.is_test) {
      throw conflict('environment_mismatch', `A ${evidence.isTest ? 'test' : 'live'} provider event cannot settle a ${p.is_test ? 'test' : 'live'} payment`);
    }
    if (p.status === 'succeeded') return { payment: p, applied: false };
    if (p.status !== 'pending' && p.status !== 'requires_action' && p.status !== 'authorized') {
      throw conflict('payment_not_pending', `Payment is ${p.status}`);
    }
    if (evidence.amountMinor !== p.amount_minor || evidence.currency.toUpperCase() !== p.currency) {
      await tx.query(`update payments set status = 'failed', failure_reason = 'amount_or_currency_mismatch', raw = raw || $2 where id = $1`,
        [paymentId, { mismatch: { expected: [p.amount_minor, p.currency], got: [evidence.amountMinor, evidence.currency] } }]);
      throw conflict('payment_mismatch', 'Provider amount or currency does not match the payment request');
    }
    // A table may have been partly paid in cash meanwhile; never over-apply.
    await this.assertApplicable(tx, p as any, p.amount_minor, paymentId);
    const updated = await tx.one<PaymentRow>(
      `update payments set status = 'succeeded', captured_at = now(), provider_payment_id = coalesce($2, provider_payment_id),
          fee_minor = coalesce($3, fee_minor), net_minor = amount_minor - coalesce($3, fee_minor, 0), raw = raw || $4
        where id = $1 returning *`,
      [paymentId, evidence.providerPaymentId ?? null, evidence.feeMinor ?? null, evidence.raw ?? {}]);
    await this.apply(tx, ctx, updated);
    return { payment: updated, applied: true };
  }

  async fail(tx: Tx, paymentId: string, reason: string, status: 'failed' | 'cancelled' | 'expired' = 'failed') {
    await tx.query(`update payments set status = $2, failure_reason = $3 where id = $1 and status in ('pending', 'requires_action', 'authorized')`,
      [paymentId, status, reason.slice(0, 300)]);
  }

  /** Reverses allocations latest-order-first and updates payment/order refund state. Provider refund calls happen in ResutoPay. */
  async applyRefund(tx: Tx, ctx: TenantContext, paymentId: string, amountMinor: number) {
    if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) throw invalid('invalid_amount', 'Refund amount must be positive');
    const p = await tx.maybeOne<any>('select * from payments where id = $1 for update', [paymentId]);
    if (!p) throw notFound('Payment');
    if (!['succeeded', 'partially_refunded'].includes(p.status)) throw conflict('not_refundable', 'Only settled payments can be refunded');
    if (p.refunded_minor + amountMinor > p.amount_minor) throw conflict('refund_exceeds_payment', 'Refund exceeds the amount paid');
    const allocations = await tx.query<{ order_id: string; net: number }>(
      `select a.order_id, sum(a.amount_minor)::bigint as net from payment_allocations a join orders o on o.id = a.order_id
        where a.payment_id = $1 group by a.order_id, o.placed_at having sum(a.amount_minor) > 0 order by o.placed_at desc`, [paymentId]);
    let remaining = amountMinor;
    for (const a of allocations) {
      if (remaining === 0) break;
      const take = Math.min(remaining, Number(a.net));
      remaining -= take;
      await tx.query(`insert into payment_allocations(org_id, payment_id, order_id, amount_minor, kind) values ($1, $2, $3, $4, 'refund')`,
        [ctx.orgId, paymentId, a.order_id, -take]);
      const o = await tx.one<any>(`update orders set refunded_minor = refunded_minor + $2 where id = $1 returning total_minor, paid_minor, refunded_minor`, [a.order_id, take]);
      await tx.query(`update orders set payment_status = $2 where id = $1`, [a.order_id, derivePaymentStatus(o.total_minor, o.paid_minor, o.refunded_minor)]);
      await this.orders.event(tx, ctx, a.order_id, 'refund_applied', null, null, { paymentId, amountMinor: take });
    }
    const refunded = p.refunded_minor + amountMinor;
    await tx.query(`update payments set refunded_minor = $2, status = $3 where id = $1`,
      [paymentId, refunded, refunded === p.amount_minor ? 'refunded' : 'partially_refunded']);
    if (p.share_id) await tx.query(`update bill_shares set paid_minor = greatest(paid_minor - $2, 0), status = 'open' where id = $1`, [p.share_id, amountMinor]);
    await this.outbox.publish(tx, ctx.orgId, { type: 'payment.refunded', aggregateType: 'payment', aggregateId: paymentId, payload: { amountMinor } });
  }

  // ---------------------------------------------------------------------------

  /**
   * Reservation-deposit credit is consumed only here, atomically and bounded by
   * the visit's credit, so no caller can apply the same deposit twice.
   */
  private async consumeVisitCredit(tx: Tx, visitId: string | null, amountMinor: number) {
    if (!visitId) throw invalid('credit_requires_visit', 'Deposit credit applies to a table visit');
    const row = await tx.maybeOne(
      `update visits set credit_used_minor = credit_used_minor + $2
        where id = $1 and credit_used_minor + $2 <= credit_minor returning id`, [visitId, amountMinor]);
    if (!row) throw conflict('credit_unavailable', 'Not enough deposit credit left on this visit');
  }

  private due(o: { total_minor: number; paid_minor: number; refunded_minor: number }) {
    return Math.max(0, o.total_minor - (o.paid_minor - o.refunded_minor));
  }

  private async targetOrders(tx: Tx, t: { orderId?: string | null; visitId?: string | null }, lock: boolean) {
    const suffix = lock ? ' for update' : '';
    if (t.orderId) return tx.query<any>(`select id, status, fulfillment, total_minor, paid_minor, refunded_minor, currency from orders where id = $1${suffix}`, [t.orderId]);
    if (t.visitId) {
      return tx.query<any>(
        `select id, status, fulfillment, total_minor, paid_minor, refunded_minor, currency from orders
          where visit_id = $1 and status <> 'cancelled' order by placed_at, id${suffix}`, [t.visitId]);
    }
    return [];
  }

  /**
   * One rule for every staff collection route (PAY-19): transfer and terminal
   * payments need the reference staff verified, cash on delivery only applies to
   * delivery orders, and a transfer reference is recorded once per tenant.
   */
  private async assertManualCollection(tx: Tx, orgId: string, input: PaymentInput) {
    const reference = typeof input.raw?.reference === 'string' ? input.raw.reference.trim() : '';
    if (['instapay', 'bank_transfer', 'card'].includes(input.method) && !reference) {
      throw invalid('reference_required', 'Enter the transfer or terminal reference');
    }
    if (input.method === 'cod') {
      const o = input.orderId ? await tx.maybeOne<{ fulfillment: string }>('select fulfillment from orders where id = $1', [input.orderId]) : null;
      if (!o || o.fulfillment !== 'delivery') throw invalid('cod_requires_delivery', 'Cash on delivery applies to delivery orders only');
    }
    if (['instapay', 'bank_transfer'].includes(input.method)) {
      const dup = await tx.maybeOne<{ id: string }>(
        `select id from payments where org_id = $1 and provider = 'manual' and method = $2 and lower(raw->>'reference') = lower($3)
            and status in ('succeeded', 'partially_refunded', 'refunded') limit 1`, [orgId, input.method, reference]);
      if (dup) throw conflict('duplicate_reference', 'This transfer reference was already recorded for another payment', { paymentId: dup.id });
    }
  }

  private async assertApplicable(tx: Tx, input: PaymentTarget & { amountMinor?: number; currency?: string; amount_minor?: number }, amount: number, excludePaymentId?: string) {
    if (!Number.isSafeInteger(amount) || amount <= 0) throw invalid('invalid_amount', 'Payment amount must be a positive integer');
    const t: PaymentTarget = {
      orderId: (input as any).orderId ?? (input as any).order_id, visitId: (input as any).visitId ?? (input as any).visit_id,
      reservationId: (input as any).reservationId ?? (input as any).reservation_id, shareId: (input as any).shareId ?? (input as any).share_id,
    };
    if (!t.orderId && !t.visitId && !t.reservationId) throw invalid('payment_target_required', 'A payment needs an order, visit or reservation');
    if (t.reservationId && !t.orderId && !t.visitId) {
      // Reservation deposits (PAY-17): only while the reservation still takes one, never above what is still due.
      const r = await tx.maybeOne<{ status: string; deposit_minor: number; deposit_status: string }>(
        'select status, deposit_minor, deposit_status from reservations where id = $1 for update', [t.reservationId]);
      if (!r) throw notFound('Reservation');
      if (!['held', 'pending_deposit', 'confirmed'].includes(r.status) || r.deposit_status !== 'required') {
        throw new DomainError('overpayment', 'This reservation no longer takes a deposit', 409, { dueMinor: 0, reservationStatus: r.status, depositStatus: r.deposit_status });
      }
      const paid = await tx.one<{ s: number }>(
        `select coalesce(sum(amount_minor - refunded_minor), 0)::bigint as s from payments
          where reservation_id = $1 and order_id is null and visit_id is null and status in ('succeeded', 'partially_refunded')
            and ($2::uuid is null or id <> $2)`, [t.reservationId, excludePaymentId ?? null]);
      const due = Number(r.deposit_minor) - Number(paid.s);
      if (amount > due) throw new DomainError('overpayment', 'This amount is more than the deposit still due', 409, { dueMinor: Math.max(due, 0) });
    }
    if (t.orderId || t.visitId) {
      const orders = await this.targetOrders(tx, t, true);
      if (!orders.length && t.orderId) throw notFound('Order');
      // Pending attempts already reserve part of the balance (except the one being confirmed).
      const pending = await tx.one<{ s: number }>(
        `select coalesce(sum(amount_minor), 0)::bigint as s from payments
          where status in ('pending', 'requires_action', 'authorized') and ($1::uuid is null or id <> $1)
            and ((order_id is not null and order_id = $2) or (visit_id is not null and visit_id = $3))`,
        [excludePaymentId ?? null, t.orderId ?? null, t.visitId ?? null]);
      const due = orders.reduce((a, o) => a + this.due(o), 0) - (excludePaymentId ? 0 : Number(pending.s));
      if (amount > due) throw new DomainError('overpayment', 'This amount is more than what is still due', 409, { dueMinor: Math.max(due, 0) });
    }
    if (t.shareId) {
      const share = await tx.maybeOne<{ amount_minor: number; paid_minor: number; status: string }>('select amount_minor, paid_minor, status from bill_shares where id = $1 for update', [t.shareId]);
      if (!share || share.status === 'void') throw notFound('Bill share');
      if (amount > share.amount_minor - share.paid_minor) throw new DomainError('overpayment', 'This amount is more than this share', 409);
    }
  }

  private async byIdempotency(tx: Tx, orgId: string, key?: string | null): Promise<PaymentRow | null> {
    if (!key) return null;
    return tx.maybeOne<PaymentRow>('select * from payments where org_id = $1 and idempotency_key = $2', [orgId, key]);
  }

  private async insert(tx: Tx, ctx: TenantContext, input: PaymentInput, status: 'pending' | 'succeeded'): Promise<PaymentRow> {
    return tx.one<PaymentRow>(
      `insert into payments(org_id, branch_id, order_id, visit_id, reservation_id, share_id, checkout_session_id, method, provider,
          connection_id, provider_payment_id, amount_minor, currency, status, idempotency_key, is_test, received_by, driver_id,
          fee_minor, net_minor, captured_at, raw)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22) returning *`,
      [ctx.orgId, input.branchId, input.orderId ?? null, input.visitId ?? null, input.reservationId ?? null, input.shareId ?? null,
        input.checkoutSessionId ?? null, input.method, input.provider, input.connectionId ?? null, input.providerPaymentId ?? null,
        input.amountMinor, input.currency, status, input.idempotencyKey ?? null, input.isTest ?? false,
        ctx.actorType === 'user' ? ctx.userId : null, input.driverId ?? null, input.feeMinor ?? null,
        input.feeMinor != null ? input.amountMinor - input.feeMinor : null, status === 'succeeded' ? new Date() : null, input.raw ?? {}]);
  }

  /** Applies a succeeded payment to its targets. Caller holds the payment row. */
  private async apply(tx: Tx, ctx: TenantContext, p: PaymentRow) {
    let remaining = p.amount_minor;
    const touched: string[] = [];
    if (p.order_id || p.visit_id) {
      const orders = await this.targetOrders(tx, { orderId: p.order_id, visitId: p.visit_id }, true);
      for (const o of orders) {
        if (remaining === 0) break;
        const take = Math.min(remaining, this.due(o));
        if (take === 0) continue;
        remaining -= take;
        touched.push(o.id);
        await tx.query(`insert into payment_allocations(org_id, payment_id, order_id, amount_minor) values ($1, $2, $3, $4)`, [ctx.orgId, p.id, o.id, take]);
        const paid = o.paid_minor + take;
        const status = derivePaymentStatus(o.total_minor, paid, o.refunded_minor);
        await tx.query(`update orders set paid_minor = $2, payment_status = $3 where id = $1`, [o.id, paid, status]);
        await this.orders.event(tx, ctx, o.id, 'payment_applied', null, null, { paymentId: p.id, amountMinor: take });
        if (status === 'paid') {
          await this.outbox.publish(tx, ctx.orgId, { type: 'order.paid', aggregateType: 'order', aggregateId: o.id, payload: { paymentId: p.id } });
          // Prepaid online orders reach the kitchen only after verified payment.
          if (o.status === 'awaiting_payment') await this.orders.transition(tx, ctx, o.id, 'placed', { reason: 'payment_verified' });
        }
      }
      if (remaining > 0) throw new DomainError('overpayment', 'Payment exceeds the amount due', 409);
    }
    if (p.share_id) {
      await tx.query(`update bill_shares set paid_minor = paid_minor + $2, status = case when paid_minor + $2 >= amount_minor then 'paid' else status end where id = $1`,
        [p.share_id, p.amount_minor]);
      await tx.query(
        `update bill_splits s set status = 'settled' where s.id = (select split_id from bill_shares where id = $1)
            and not exists (select 1 from bill_shares x where x.split_id = s.id and x.status = 'open')`, [p.share_id]);
    }
    if (p.reservation_id && !p.order_id && !p.visit_id) {
      // PAY-17: the deposit is "paid" only once the payments cover it (assertApplicable already refused anything above it).
      await tx.query(
        `update reservations r set deposit_status = 'paid', status = case when r.status = 'pending_deposit' then 'confirmed'::reservation_status else r.status end
          where r.id = $1 and (select coalesce(sum(amount_minor - refunded_minor), 0) from payments
            where reservation_id = r.id and order_id is null and visit_id is null and status in ('succeeded', 'partially_refunded')) >= r.deposit_minor`, [p.reservation_id]);
    }
    if (p.checkout_session_id) {
      await tx.query(`update checkout_sessions set status = 'paid', paid_at = now() where id = $1 and status in ('open', 'processing')`, [p.checkout_session_id]);
    }
    await this.outbox.publish(tx, ctx.orgId, {
      type: 'payment.succeeded', aggregateType: 'payment', aggregateId: p.id,
      payload: { amountMinor: p.amount_minor, orderIds: touched, reservationId: p.reservation_id, shareId: p.share_id },
    });
  }
}
