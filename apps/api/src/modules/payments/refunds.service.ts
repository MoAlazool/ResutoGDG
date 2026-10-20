import { Injectable, Logger } from '@nestjs/common';
import { paymentAdapter, ProviderError, type RefundResult, type RefundStatusResult } from '@resuto/integrations';
import { TenantContext } from '../../common/auth/context';
import { DbService, type Tx } from '../../common/db/db.service';
import { conflict, notFound } from '../../common/errors/domain-error';
import { Scheduled } from '../../common/events/events';
import { AuditService } from '../../common/platform/audit.service';
import { PaymentLedgerService } from '../kernel/payment-ledger.service';
import { PaymentProvidersService } from './providers.service';
import { toRefund } from './util';
import { PaymentWebhooksService } from './webhooks.service';

/** A resend of an uncertain refund waits this long, so an original request still in flight at the provider lands first. */
export const REFUND_RESEND_AFTER_MS = 10 * 60_000;
/** Pending provider refunds older than this raise one `refund_stuck` alert. */
export const REFUND_STUCK_AFTER_MS = 24 * 60 * 60_000;

type Outcome = { status: 'succeeded' | 'pending' | 'failed' | 'unknown'; providerRefundId: string | null; failureReason?: string | null };

/**
 * Provider refunds (PAY-05, PAY-12). The ledger changes only after the provider
 * confirms. A result that cannot be known (network error, timeout, 5xx, an
 * unreadable 2xx) keeps the refund PENDING and `outcome_uncertain`: it still
 * counts against what is refundable, blocks further refunds on the payment, and
 * is resolved by asking the provider — never by sending a second refund. A
 * resend happens only when the provider shows no trace of it, and reuses the
 * SAME provider idempotency key.
 */
@Injectable()
export class RefundsService {
  private readonly logger = new Logger('Refunds');

  constructor(
    private readonly db: DbService,
    private readonly ledger: PaymentLedgerService,
    private readonly providers: PaymentProvidersService,
    private readonly webhooks: PaymentWebhooksService,
    private readonly audit: AuditService,
  ) {}

  /** The provider key of one intended refund: payment id + its position among the payment's refunds (stable across retries). */
  async nextProviderKey(tx: Tx, paymentId: string): Promise<string> {
    const { n } = await tx.one<{ n: number }>(`select count(*)::int as n from refunds where payment_id = $1 and source <> 'provider'`, [paymentId]);
    return `${paymentId}:${n + 1}`;
  }

  /** Sends the refund (outside any transaction) and records what the provider said. */
  async execute(orgId: string, refundId: string, actor: TenantContext): Promise<ReturnType<typeof toRefund>> {
    const loaded = await this.db.withTenant(orgId, async (tx) => {
      const r = await tx.one<any>('select * from refunds where id = $1', [refundId]);
      const p = await tx.one<any>('select * from payments where id = $1', [r.payment_id]);
      const ref = await tx.maybeOne<any>('select provider_session_id from payment_attempt_refs where payment_id = $1', [p.id]);
      return { r, p, sessionId: ref?.provider_session_id ?? null };
    }, 'payments:refunds');
    const { r, p } = loaded;
    if (r.status !== 'pending') return toRefund(r);
    const outcome = await this.send(orgId, r, p, loaded.sessionId);
    return this.record(orgId, refundId, outcome, actor, 'request');
  }

  private async send(orgId: string, r: any, p: any, sessionId: string | null): Promise<Outcome> {
    const adapter = paymentAdapter(p.provider);
    if (!adapter) return { status: 'failed', providerRefundId: null, failureReason: 'provider_not_supported' };
    let actx;
    try {
      actx = await this.providers.adapterContext(orgId, { provider: p.provider, connectionId: p.connection_id });
    } catch (error) {
      // Nothing was sent: a definite failure the staff can retry once the connection works.
      return { status: 'failed', providerRefundId: null, failureReason: `connection_unusable: ${(error as Error).message}`.slice(0, 300) };
    }
    await this.db.withTenant(orgId, (tx) => tx.query(`update refunds set attempts = attempts + 1, last_checked_at = now() where id = $1`, [r.id]), 'payments:refunds');
    try {
      const res: RefundResult = await adapter.refund(actx, {
        providerPaymentId: r.provider_payment_id ?? p.provider_payment_id, providerSessionId: sessionId, amountMinor: Number(r.amount_minor),
        currency: p.currency, reason: r.reason, idempotencyKey: r.provider_idempotency_key ?? r.id,
        ledgerRefundedMinor: r.source === 'unapplied_capture' ? 0 : Number(p.refunded_minor),
      });
      return { status: res.status, providerRefundId: res.providerRefundId, failureReason: res.failureReason ?? null };
    } catch (error) {
      // A 4xx refusal is definite; anything else may have reached the provider (PAY-05).
      if (error instanceof ProviderError && !error.retryable && error.status && error.status >= 400 && error.status < 500) {
        return { status: 'failed', providerRefundId: null, failureReason: `provider_refused_${error.status}` };
      }
      this.logger.warn(`refund ${r.id}: outcome unknown (${(error as Error).message.slice(0, 200)})`);
      return { status: 'unknown', providerRefundId: null, failureReason: 'outcome_unknown' };
    }
  }

  /** Applies a provider answer to the refund row (and the ledger on success), idempotently. */
  private async record(orgId: string, refundId: string, outcome: Outcome, actor: TenantContext, via: 'request' | 'inquiry'): Promise<ReturnType<typeof toRefund>> {
    try {
      return await this.db.withTenant(orgId, async (tx) => {
        const r = await tx.one<any>('select * from refunds where id = $1 for update', [refundId]);
        if (r.status !== 'pending') return toRefund(r);
        const p = await tx.one<any>('select id, branch_id, provider, currency from payments where id = $1', [r.payment_id]);
        if (outcome.status === 'succeeded') {
          if (r.source !== 'unapplied_capture') await this.ledger.applyRefund(tx, actor, r.payment_id, Number(r.amount_minor));
          const done = await tx.one<any>(`update refunds set status = 'succeeded', outcome_uncertain = false, provider_refund_id = coalesce($2, provider_refund_id),
              completed_at = now(), last_checked_at = now() where id = $1 returning *`, [refundId, outcome.providerRefundId]);
          await this.audit.record(tx, actor, { action: 'refund.succeeded', entityType: 'refund', entityId: refundId, branchId: p.branch_id,
            metadata: { paymentId: r.payment_id, amountMinor: Number(r.amount_minor), via } });
          return toRefund(done);
        }
        if (outcome.status === 'failed') {
          const done = await tx.one<any>(`update refunds set status = 'failed', outcome_uncertain = false, failure_reason = $2, completed_at = now(), last_checked_at = now()
              where id = $1 returning *`, [refundId, outcome.failureReason ?? 'provider_refused']);
          await this.webhooks.alert(tx, orgId, { kind: 'refund_failed', provider: p.provider, paymentId: p.id, branchId: p.branch_id,
            details: { refundId, reason: outcome.failureReason ?? null, amountMinor: Number(r.amount_minor), currency: p.currency } });
          await this.audit.record(tx, actor, { action: 'refund.failed', entityType: 'refund', entityId: refundId, branchId: p.branch_id, metadata: { reason: outcome.failureReason ?? null, via } });
          return toRefund(done);
        }
        const uncertain = outcome.status === 'unknown';
        const done = await tx.one<any>(`update refunds set provider_refund_id = coalesce($2, provider_refund_id), outcome_uncertain = outcome_uncertain or $3,
            failure_reason = case when $3 then 'outcome_unknown' else failure_reason end, last_checked_at = now() where id = $1 returning *`,
          [refundId, outcome.providerRefundId, uncertain]);
        if (uncertain && !r.outcome_uncertain) {
          await this.webhooks.alert(tx, orgId, { kind: 'refund_uncertain', provider: p.provider, paymentId: p.id, branchId: p.branch_id,
            details: { refundId, amountMinor: Number(r.amount_minor), currency: p.currency,
              action: 'The provider did not confirm this refund. Resuto is checking with the provider and will not send it again unless the provider has no record of it.' } });
        }
        return toRefund(done);
      }, 'payments:refunds');
    } catch (error) {
      // e.g. the provider refunded but the ledger update failed: keep it pending and uncertain so the resolver retries the bookkeeping.
      this.logger.error(`refund ${refundId}: recording "${outcome.status}" failed: ${(error as Error).message}`);
      return this.db.withTenant(orgId, async (tx) => toRefund(await tx.one<any>(
        `update refunds set outcome_uncertain = true, provider_refund_id = coalesce($2, provider_refund_id), last_checked_at = now() where id = $1 returning *`,
        [refundId, outcome.providerRefundId])), 'payments:refunds');
    }
  }

  /** Resolves one pending provider refund by inquiry; resends with the same key only when the provider has no trace of it. */
  async resolve(orgId: string, refundId: string, actor = TenantContext.system(orgId, 'payments:refund-resolver', 'worker')) {
    const { r, p, sessionId } = await this.db.withTenant(orgId, async (tx) => {
      const r = await tx.one<any>('select * from refunds where id = $1', [refundId]);
      const p = await tx.one<any>('select * from payments where id = $1', [r.payment_id]);
      const ref = await tx.maybeOne<any>('select provider_session_id from payment_attempt_refs where payment_id = $1', [p.id]);
      return { r, p, sessionId: ref?.provider_session_id ?? null };
    }, 'payments:refunds');
    if (r.status !== 'pending' || !r.provider || r.provider === 'manual') return toRefund(r);
    const adapter = paymentAdapter(p.provider);
    if (!adapter) return toRefund(r);
    let answer: RefundStatusResult;
    try {
      const actx = await this.providers.adapterContext(orgId, { provider: p.provider, connectionId: p.connection_id });
      answer = await adapter.refundStatus(actx, {
        providerPaymentId: r.provider_payment_id ?? p.provider_payment_id, providerSessionId: sessionId, amountMinor: Number(r.amount_minor), currency: p.currency,
        reason: r.reason, idempotencyKey: r.provider_idempotency_key ?? r.id, providerRefundId: r.provider_refund_id,
        ledgerRefundedMinor: r.source === 'unapplied_capture' ? 0 : Number(p.refunded_minor),
      });
    } catch (error) {
      this.logger.warn(`refund ${refundId}: inquiry failed: ${(error as Error).message.slice(0, 200)}`);
      answer = { status: 'unknown', failureReason: 'inquiry_failed' };
    }
    if (answer.status === 'not_found') {
      const age = Date.now() - new Date(r.created_at).getTime();
      if (r.outcome_uncertain && age >= REFUND_RESEND_AFTER_MS) {
        // The provider has no record of it: sending again with the same key is safe (and a no-op where keys are honoured).
        return this.record(orgId, refundId, await this.send(orgId, r, p, sessionId), actor, 'inquiry');
      }
      answer = { status: 'unknown', failureReason: 'not_yet_visible' };
    }
    // "unknown" from an inquiry changes nothing: the refund stays pending (and keeps blocking further refunds).
    const status: Outcome['status'] = answer.status === 'succeeded' || answer.status === 'failed' ? answer.status : 'pending';
    return this.record(orgId, refundId, { status, providerRefundId: answer.providerRefundId ?? null, failureReason: answer.failureReason ?? null }, actor, 'inquiry');
  }

  /** Staff "check now" on a pending refund. */
  async check(ctx: TenantContext, refundId: string) {
    const r = await this.db.scoped(ctx, (tx) => tx.maybeOne<any>('select r.id, r.status, p.branch_id from refunds r join payments p on p.id = r.payment_id where r.id = $1', [refundId]));
    if (!r) throw notFound('Refund');
    ctx.assertBranch(r.branch_id);
    if (r.status !== 'pending') throw conflict('refund_not_pending', `This refund is ${r.status}`);
    return this.resolve(ctx.orgId, refundId, ctx);
  }

  /** Worker: resolves pending provider refunds (with backoff) and alerts once on refunds pending too long. */
  @Scheduled('payments.refund_status', 120)
  async resolvePending() {
    const due = await this.db.withPlatform((tx) => tx.query<{ id: string; org_id: string; created_at: Date; attempts: number }>(
      `select r.id, r.org_id, r.created_at, r.attempts from refunds r
        where r.status = 'pending' and r.provider is not null and r.provider <> 'manual' and r.created_at < now() - interval '1 minute'
          and (r.last_checked_at is null or r.last_checked_at < now() - least(interval '1 minute' * power(2, least(r.attempts, 8)), interval '6 hours'))
        order by r.last_checked_at nulls first limit 100`));
    let resolved = 0, stuck = 0;
    for (const row of due) {
      const out = await this.resolve(row.org_id, row.id).catch((e) => { this.logger.warn(`resolve ${row.id}: ${(e as Error).message}`); return null; });
      if (out && out.status !== 'pending') resolved++;
      else if (Date.now() - new Date(row.created_at).getTime() > REFUND_STUCK_AFTER_MS) {
        stuck += await this.db.withTenant(row.org_id, async (tx) => {
          const open = await tx.maybeOne(`select 1 from payment_alerts where kind = 'refund_stuck' and status = 'open' and details->>'refundId' = $1`, [row.id]);
          if (open) return 0;
          const r = await tx.one<any>('select r.amount_minor, p.id, p.branch_id, p.provider, p.currency from refunds r join payments p on p.id = r.payment_id where r.id = $1', [row.id]);
          await this.webhooks.alert(tx, row.org_id, { kind: 'refund_stuck', provider: r.provider, paymentId: r.id, branchId: r.branch_id,
            details: { refundId: row.id, amountMinor: Number(r.amount_minor), currency: r.currency, action: 'This refund has been pending at the provider for more than a day. Check it in the provider dashboard.' } });
          return 1;
        }, 'payments:refunds');
      }
    }
    return { checked: due.length, resolved, stuck };
  }

  /**
   * A capture Resuto never applied (late success on a closed attempt, a duplicate
   * capture, an overpayment): staff refund it in one click from the alert (PAY-08).
   * The ledger is not touched — that money was never counted.
   *
   * Replay-safe and retryable (review F3/F4): a pending or succeeded refund of the
   * alert is returned as is; after a DEFINITE failure the next click is a new
   * attempt with a new key (`alert:<id>:<n>`). One provider transaction is refunded
   * at most once through this path, whichever alert it is requested from.
   */
  async refundUnappliedCapture(ctx: TenantContext, alertId: string, key: string) {
    const phase1 = await this.db.scoped(ctx, async (tx) => {
      const a = await tx.maybeOne<any>('select * from payment_alerts where id = $1 for update', [alertId]);
      if (!a || !a.payment_id) throw notFound('Alert');
      ctx.assertBranch(a.branch_id);
      const tries = await tx.query<any>(
        `select * from refunds where org_id = $1 and (idempotency_key = $2 or idempotency_key like $2 || ':%') order by created_at desc`, [ctx.orgId, `alert:${alertId}`]);
      const live = tries.find((r) => r.status === 'pending' || r.status === 'succeeded');
      if (live) return { replay: toRefund(live) };
      if (!['late_success', 'duplicate_capture', 'overpayment_conflict', 'deposit_not_due'].includes(a.kind) || a.details?.refundable !== true) {
        throw conflict('alert_not_refundable', 'This alert has no captured payment to refund');
      }
      if (a.status !== 'open') throw conflict('alert_resolved', 'This alert is already resolved');
      const p = await tx.one<any>('select * from payments where id = $1 for update', [a.payment_id]);
      const providerPaymentId = a.details?.providerPaymentId ?? (a.kind === 'duplicate_capture' ? null : p.provider_payment_id);
      if (!providerPaymentId) throw conflict('alert_not_refundable', 'The provider transaction id is unknown; refund it in the provider dashboard');
      // The same captured transaction may be named by several alerts (older duplicates, another kind): refund it once.
      const other = await tx.maybeOne<any>(
        `select id, status from refunds where payment_id = $1 and source = 'unapplied_capture' and provider_payment_id = $2 and status in ('pending', 'succeeded') limit 1`,
        [p.id, String(providerPaymentId)]);
      if (other) {
        throw conflict(other.status === 'pending' ? 'refund_in_progress' : 'capture_already_refunded',
          other.status === 'pending' ? 'A refund of this provider transaction is already in progress' : 'This provider transaction was already refunded', { refundId: other.id });
      }
      // A duplicate capture refunds the SECOND transaction; for the others the payment itself must still be unapplied.
      if (a.kind !== 'duplicate_capture' && ['succeeded', 'partially_refunded', 'refunded'].includes(p.status)) {
        throw conflict('alert_not_refundable', 'This payment was applied meanwhile; refund it from the payment instead');
      }
      const amount = Number(a.details?.amountMinor ?? a.details?.received?.amountMinor ?? p.amount_minor);
      // Attempt n after n-1 definite failures; the first keeps the original key so earlier replays still match.
      const attemptKey = tries.length ? `alert:${alertId}:${tries.length + 1}` : `alert:${alertId}`;
      const refund = await tx.one<any>(
        `insert into refunds(org_id, payment_id, amount_minor, reason, status, idempotency_key, created_by, provider, source, provider_payment_id, provider_idempotency_key)
         values ($1, $2, $3, $4, 'pending', $5, $6, $7, 'unapplied_capture', $8, $9) returning *`,
        [ctx.orgId, p.id, amount, `Unapplied capture (${a.kind})`, attemptKey, ctx.userId, p.provider, String(providerPaymentId), attemptKey]);
      await tx.query(`update payment_alerts set details = details || $2 where id = $1`, [alertId, { refundId: refund.id, refundRequestedBy: ctx.userId, refundKey: key }]);
      await this.audit.record(tx, ctx, { action: 'refund.unapplied_capture_requested', entityType: 'refund', entityId: refund.id, branchId: p.branch_id,
        metadata: { alertId, kind: a.kind, amountMinor: amount, providerPaymentId, attempt: tries.length + 1 } });
      return { refund };
    });
    if ('replay' in phase1) return phase1.replay;
    const out = await this.execute(ctx.orgId, phase1.refund.id, ctx);
    if (out.status === 'succeeded') {
      await this.db.scoped(ctx, (tx) => tx.query(`update payment_alerts set status = 'resolved', resolved_at = now(), resolved_by = $2 where id = $1`, [alertId, ctx.userId]));
    }
    return out;
  }
}
