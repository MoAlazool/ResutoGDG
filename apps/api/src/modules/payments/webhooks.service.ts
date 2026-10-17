import { Inject, Injectable, Logger } from '@nestjs/common';
import { paymentAdapter, safeJson, type PaymentAdapter, type PaymentEvent, type WebhookInput } from '@resuto/integrations';
import { ENV, type Env } from '../../config/env';
import { sha256 } from '../../common/crypto/hash';
import { DbService, type Tx } from '../../common/db/db.service';
import { DomainError } from '../../common/errors/domain-error';
import { Scheduled } from '../../common/events/events';
import { AuditService } from '../../common/platform/audit.service';
import { OutboxService } from '../../common/platform/outbox.service';
import { WebhookInboxService } from '../../common/platform/webhook-inbox.service';
import { PaymentLedgerService } from '../kernel/payment-ledger.service';
import { PaymentProvidersService } from './providers.service';
import { isUuid, webhookCtx } from './util';

export type ApplyOutcome =
  | 'applied' | 'already_settled' | 'ignored' | 'failed_recorded' | 'expired_recorded'
  | 'amount_mismatch' | 'overpayment_conflict' | 'late_success' | 'unmatched';

interface Target { orgId: string; connectionId: string | null; credentials: Record<string, string>; config: Record<string, unknown> }

export const inboxProvider = (provider: string) => `payments:${provider}`;

/**
 * Provider webhooks: verify the signature on the raw body → persist in the
 * inbox (dedupe) → resolve the attempt → apply through the kernel ledger in the
 * tenant's context. Mismatched amounts are recorded and alerted, never applied.
 * The same `applyEvent` serves server-side status queries (return/polling).
 */
@Injectable()
export class PaymentWebhooksService {
  private readonly logger = new Logger('PaymentWebhooks');

  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly db: DbService,
    private readonly inbox: WebhookInboxService,
    private readonly ledger: PaymentLedgerService,
    private readonly providers: PaymentProvidersService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
  ) {}

  async handle(provider: string, rawBody: Buffer | string | undefined, headers: WebhookInput['headers'], query: Record<string, string | undefined>) {
    const adapter = paymentAdapter(provider);
    if (!adapter || (provider === 'simulated' && this.env.PAYMENT_MODE !== 'sandbox')) throw new DomainError('not_found', 'Unknown payment provider', 404);
    const raw = rawBody ?? Buffer.alloc(0);
    const input: WebhookInput = { rawBody: raw, headers, query };
    const target = await this.resolveTarget(provider, adapter, input).catch(() => null);
    const verified = target ? adapter.verifyWebhook(target.credentials, input, target.config) : { valid: false, eventKey: '', event: null, reason: 'unknown merchant' };
    if (!verified.valid || !verified.event) {
      // Rejected deliveries are kept for forensics under a key that can never shadow a real event id.
      await this.inbox.store({
        provider: inboxProvider(provider), eventKey: `rejected:${sha256(typeof raw === 'string' ? raw : raw.toString('utf8'))}`, signatureValid: false,
        payload: { reason: verified.reason ?? 'invalid', body: safeJson(raw) ?? { text: String(raw).slice(0, 2000) } }, headers, orgId: target?.orgId ?? null,
      });
      throw new DomainError('invalid_signature', 'Invalid webhook signature', 401);
    }
    const rec = await this.inbox.store({
      provider: inboxProvider(provider), eventKey: verified.eventKey, signatureValid: true,
      payload: { connectionId: target!.connectionId, body: safeJson(raw) }, headers, orgId: target!.orgId,
    });
    if (rec.duplicate && (rec.status === 'processed' || rec.status === 'ignored')) return { received: true, duplicate: true };
    const outcome = await this.processInbox(rec.id, provider, target!.orgId, verified.event);
    return { received: true, outcome };
  }

  /** Applies one verified event and records the inbox outcome. Throws (→ provider retry) on unexpected failures. */
  private async processInbox(inboxId: string, provider: string, orgId: string, event: PaymentEvent) {
    try {
      const { outcome } = await this.applyEvent(orgId, provider, event, 'webhook');
      const ignored = ['ignored', 'amount_mismatch', 'overpayment_conflict', 'late_success', 'unmatched'].includes(outcome);
      await this.inbox.markProcessed(inboxId, ignored ? 'ignored' : 'processed', ignored && outcome !== 'ignored' ? outcome : null, orgId);
      return outcome;
    } catch (error) {
      await this.inbox.markProcessed(inboxId, 'failed', (error as Error).message, orgId);
      this.logger.warn(`payment webhook ${inboxId} failed: ${(error as Error).message}`);
      throw new DomainError('webhook_processing_failed', 'Temporarily unable to process this event', 503);
    }
  }

  /** Worker retry for verified inbox rows that failed to process (or were never processed). */
  @Scheduled('payments.webhook_retry', 60)
  async retryPending() {
    let retried = 0, failed = 0;
    for (const provider of ['simulated', 'paymob', 'stripe', 'moyasar']) {
      const adapter = paymentAdapter(provider)!;
      for (const row of await this.inbox.pending(inboxProvider(provider), 50)) {
        if (!row.org_id) continue;
        retried++;
        const config = row.payload?.connectionId ? (await this.providers.credentials(row.org_id, row.payload.connectionId))?.config ?? {} : {};
        try {
          await this.processInbox(row.id, provider, row.org_id, adapter.parseEvent(row.payload?.body, config));
        } catch {
          failed++;
        }
      }
    }
    return { retried, failed };
  }

  /**
   * Resolves the merchant and its verification secret. Hints come from `?c=`
   * (connection id; org id for the sandbox) or ids in the UNVERIFIED payload —
   * used only to choose which secret to verify with.
   */
  private async resolveTarget(provider: string, adapter: PaymentAdapter, input: WebhookInput): Promise<Target | null> {
    const c = input.query.c;
    if (provider === 'simulated') {
      let orgId = isUuid(c) ? c : null;
      if (!orgId) {
        const hint = adapter.lookup(input);
        orgId = hint ? await this.orgForAttempt(provider, hint.providerSessionId ?? null, hint.reference ?? null) : null;
      }
      if (!orgId) return null;
      const ctx = await this.providers.adapterContext(orgId, { provider, connectionId: null });
      return { orgId, connectionId: null, credentials: ctx.credentials, config: {} };
    }
    let connectionId = isUuid(c) ? c : null;
    let orgId: string | null = null;
    if (connectionId) {
      orgId = (await this.db.withPlatform((tx) => tx.maybeOne<{ org_id: string }>(
        `select org_id from integration_connections where id = $1 and provider = $2 and category = 'payments'`, [connectionId, provider])))?.org_id ?? null;
    } else {
      const hint = adapter.lookup(input);
      if (!hint) return null;
      const found = await this.db.withPlatform((tx) => tx.maybeOne<{ org_id: string; connection_id: string | null }>(
        `select p.org_id, p.connection_id from payments p left join payment_attempt_refs r on r.payment_id = p.id
          where p.provider = $1 and ((r.provider_session_id is not null and r.provider_session_id = $2)
             or ($3::text is not null and p.id::text = $3) or (p.provider_payment_id is not null and p.provider_payment_id = $4))
          limit 1`, [provider, hint.providerSessionId ?? null, isUuid(hint.reference) ? hint.reference : null, hint.providerPaymentId ?? null]));
      orgId = found?.org_id ?? null;
      connectionId = found?.connection_id ?? null;
    }
    if (!orgId || !connectionId) return null;
    const creds = await this.providers.credentials(orgId, connectionId);
    if (!creds || creds.provider !== provider) return null;
    return { orgId, connectionId, credentials: creds.credentials, config: creds.config };
  }

  private async orgForAttempt(provider: string, providerSessionId: string | null, reference: string | null) {
    return (await this.db.withPlatform((tx) => tx.maybeOne<{ org_id: string }>(
      `select r.org_id from payment_attempt_refs r where r.provider = $1 and r.provider_session_id = $2
       union all select p.org_id from payments p where $3::text is not null and p.id::text = $3 and p.provider = $1 limit 1`,
      [provider, providerSessionId, isUuid(reference) ? reference : null])))?.org_id ?? null;
  }

  private async findPayment(tx: Tx, provider: string, ev: PaymentEvent) {
    return tx.maybeOne<any>(
      `select p.*, r.provider_session_id as ref_session from payments p left join payment_attempt_refs r on r.payment_id = p.id
        where p.provider = $1 and ((r.provider_session_id is not null and r.provider_session_id = $2)
           or ($3::text is not null and p.id::text = $3) or (p.provider_payment_id is not null and p.provider_payment_id = $4))
        order by p.created_at desc limit 1`,
      [provider, ev.providerSessionId ?? null, isUuid(ev.reference) ? ev.reference : null, ev.providerPaymentId ?? null]);
  }

  /** Applies verified provider evidence (webhook or server-side status query) to the ledger. */
  async applyEvent(orgId: string, provider: string, ev: PaymentEvent, source: 'webhook' | 'status_query'): Promise<{ outcome: ApplyOutcome; paymentId: string | null }> {
    const ctx = webhookCtx(orgId, provider);
    if (ev.kind === 'ignored') return { outcome: 'ignored', paymentId: null };
    let payment: any = null;
    try {
      return await this.db.withTenant(orgId, async (tx) => {
        payment = await this.findPayment(tx, provider, ev);
        if (!payment) {
          await this.alert(tx, orgId, { kind: 'unmatched_event', provider, details: { event: ev, source } });
          return { outcome: 'unmatched' as const, paymentId: null };
        }
        if (ev.kind === 'payment_succeeded') {
          if (payment.status === 'succeeded' || payment.status === 'partially_refunded' || payment.status === 'refunded') return { outcome: 'already_settled' as const, paymentId: payment.id };
          if (!['pending', 'requires_action', 'authorized'].includes(payment.status)) {
            await this.alert(tx, orgId, { kind: 'late_success', provider, paymentId: payment.id, branchId: payment.branch_id, checkoutSessionId: payment.checkout_session_id,
              details: { status: payment.status, amountMinor: ev.amountMinor, currency: ev.currency, providerPaymentId: ev.providerPaymentId, source,
                action: 'The provider captured money for an attempt Resuto had closed. Refund it in the provider dashboard or reconcile manually.' } });
            return { outcome: 'late_success' as const, paymentId: payment.id };
          }
          await this.ledger.confirm(tx, ctx, payment.id, {
            amountMinor: Number(ev.amountMinor), currency: String(ev.currency ?? ''), providerPaymentId: ev.providerPaymentId ?? null,
            feeMinor: ev.feeMinor ?? null, raw: { confirmedBy: source, providerSessionId: ev.providerSessionId ?? null },
          });
          if (payment.checkout_session_id) {
            await this.outbox.publish(tx, orgId, { type: 'checkout.paid', aggregateType: 'checkout_session', aggregateId: payment.checkout_session_id, payload: { paymentId: payment.id } });
          }
          return { outcome: 'applied' as const, paymentId: payment.id };
        }
        if (!['pending', 'requires_action', 'authorized'].includes(payment.status)) return { outcome: 'ignored' as const, paymentId: payment.id };
        const expired = ev.kind === 'payment_expired';
        await this.ledger.fail(tx, payment.id, expired ? 'expired_at_provider' : ev.failureReason ?? 'declined', expired ? 'expired' : 'failed');
        await this.reopenSession(tx, payment.checkout_session_id);
        await this.outbox.publish(tx, orgId, { type: 'payment.failed', aggregateType: 'payment', aggregateId: payment.id, payload: { reason: ev.failureReason ?? ev.kind } });
        return { outcome: expired ? 'expired_recorded' as const : 'failed_recorded' as const, paymentId: payment.id };
      }, `webhook:${provider}`);
    } catch (error) {
      const code = (error as DomainError)?.code;
      if (payment && (code === 'payment_mismatch' || code === 'overpayment')) {
        // The ledger refused and the transaction rolled back: record the refusal durably, alert, never apply.
        const kind = code === 'payment_mismatch' ? 'amount_mismatch' : 'overpayment_conflict';
        await this.db.withTenant(orgId, async (tx) => {
          await this.ledger.fail(tx, payment.id, code === 'payment_mismatch' ? 'amount_or_currency_mismatch' : 'overpayment_conflict');
          await this.reopenSession(tx, payment.checkout_session_id);
          await this.alert(tx, orgId, { kind, provider, paymentId: payment.id, branchId: payment.branch_id, checkoutSessionId: payment.checkout_session_id,
            details: { expected: { amountMinor: payment.amount_minor, currency: payment.currency }, received: { amountMinor: ev.amountMinor, currency: ev.currency },
              providerPaymentId: ev.providerPaymentId ?? null, source,
              action: kind === 'amount_mismatch' ? 'Not applied. Check the provider dashboard for this transaction.' : 'The bill was settled another way meanwhile. Refund this provider payment.' } });
          await this.audit.record(tx, ctx, { action: `payment.${kind}`, entityType: 'payment', entityId: payment.id, branchId: payment.branch_id,
            metadata: { provider, expectedMinor: payment.amount_minor, receivedMinor: ev.amountMinor, currency: ev.currency } });
        }, `webhook:${provider}`);
        return { outcome: kind, paymentId: payment.id };
      }
      throw error;
    }
  }

  private async reopenSession(tx: Tx, sessionId: string | null) {
    if (!sessionId) return;
    await tx.query(`update checkout_sessions set status = case when expires_at <= now() then 'expired' else 'open' end where id = $1 and status = 'processing'`, [sessionId]);
  }

  async alert(tx: Tx, orgId: string, a: { kind: string; provider?: string; paymentId?: string | null; branchId?: string | null; checkoutSessionId?: string | null; details: Record<string, unknown> }) {
    await tx.query(
      `insert into payment_alerts(org_id, branch_id, kind, payment_id, checkout_session_id, provider, details) values ($1, $2, $3, $4, $5, $6, $7)`,
      [orgId, a.branchId ?? null, a.kind, a.paymentId ?? null, a.checkoutSessionId ?? null, a.provider ?? null, JSON.stringify(a.details)]);
  }
}
