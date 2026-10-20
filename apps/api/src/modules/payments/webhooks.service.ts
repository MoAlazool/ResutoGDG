import { Inject, Injectable, Logger } from '@nestjs/common';
import { paymentAdapter, ProviderError, safeJson, type PaymentAdapter, type PaymentEvent, type WebhookInput } from '@resuto/integrations';
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
import { isUuid, SETTLED, webhookCtx } from './util';

export type ApplyOutcome =
  | 'applied' | 'already_settled' | 'ignored' | 'failed_recorded' | 'decline_recorded' | 'expired_recorded' | 'authorized_recorded'
  | 'refund_applied' | 'dispute_recorded' | 'late_success_applied'
  | 'amount_mismatch' | 'overpayment_conflict' | 'late_success' | 'duplicate_capture' | 'reference_mismatch' | 'environment_mismatch' | 'unmatched';

/** Outcomes that leave the event unapplied (inbox status "ignored" with the outcome as the reason). */
const NOT_APPLIED: ReadonlySet<ApplyOutcome> = new Set(['ignored', 'amount_mismatch', 'overpayment_conflict', 'late_success', 'duplicate_capture',
  'reference_mismatch', 'environment_mismatch', 'unmatched']);
const ACTIVE = ['pending', 'requires_action', 'authorized'];
/** Attempts Resuto itself closed while the provider session could still be paid: a late success is applied if still due (PAY-08). */
const CLOSED_BY_RESUTO = ['superseded_by_new_attempt', 'checkout_expired', 'expired_at_provider', 'declined', 'duplicate_active_attempt'];

/** Which merchant connection an event belongs to. Every event is bound to it (PAY-10). */
export interface Binding { connectionId: string | null; environment: 'sandbox' | 'live' }
interface Target extends Binding { orgId: string; credentials: Record<string, string>; config: Record<string, unknown> }

export const inboxProvider = (provider: string) => `payments:${provider}`;

/** Declines kept per attempt in payments.raw.declines (one per provider transaction). */
const MAX_DECLINES = 20;
/**
 * Alert kinds about ONE provider transaction: a redelivery or an unsigned-field variant of the same transaction
 * updates the existing alert (repeats, lastSeenAt) instead of adding another — in particular another refundable one —
 * and never re-opens one staff already resolved (F3).
 */
const ONE_OPEN_ALERT_PER_TRANSACTION: ReadonlySet<string> = new Set(['late_success', 'duplicate_capture', 'overpayment_conflict', 'deposit_not_due',
  'amount_mismatch', 'reference_mismatch', 'unmatched_event', 'environment_mismatch', 'auth_only']);

/** Transient: retried by the provider and the inbox worker (e.g. a refund delivered before its payment's success). */
class RetryLater extends Error {}

/**
 * Provider webhooks: verify the signature on the raw body with the secret of
 * the connection the delivery names → bind the event to that connection and its
 * environment → (for weakly authenticated or unsigned-amount events) re-read
 * the object from the provider with the merchant's key → persist a minimised
 * copy in the inbox (dedupe) → apply through the kernel ledger. Nothing that is
 * not covered by the signature (or the authenticated re-read) chooses which
 * payment is settled. The same `applyEvent` serves server-side status queries.
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
    const text = typeof raw === 'string' ? raw : raw.toString('utf8');
    const input: WebhookInput = { rawBody: raw, headers, query };
    const target = await this.resolveTarget(provider, adapter, input).catch(() => null);
    const verified = target ? adapter.verifyWebhook(target.credentials, input, target.config) : { valid: false, eventKey: '', event: null, reason: 'unknown merchant' };
    if (!verified.valid || !verified.event) {
      // Unauthenticated deliveries keep only a reason, a hash and a short redacted excerpt (PAY-18).
      const body = safeJson(raw);
      await this.inbox.store({
        provider: inboxProvider(provider), eventKey: `rejected:${sha256(text)}`, signatureValid: false,
        payload: { reason: verified.reason ?? 'invalid', sha256: sha256(text), bytes: Buffer.byteLength(text),
          excerpt: body === null ? '[not json]' : JSON.stringify(adapter.redactPayload(body)).slice(0, 512) },
        headers, orgId: target?.orgId ?? null,
      });
      throw new DomainError('invalid_signature', 'Invalid webhook signature', 401);
    }
    const t = target!;
    // Dedupe on SIGNED (or authenticated) content only — the adapter's key — never on the raw body: copies of one
    // signed transaction that differ in unsigned fields are one event (review F3). The unsigned reference echo
    // (Paymob merchant_order_id) is part of the key so a forged variant naming another attempt (→ reference_mismatch)
    // can never pre-empt the genuine delivery; any other variant is processed idempotently (one alert per transaction).
    const claim = isUuid(verified.event.claimedReference) ? verified.event.claimedReference : null;
    const eventKey = claim ? `${verified.eventKey}:ref:${claim}` : verified.eventKey;
    const rec = await this.inbox.store({
      provider: inboxProvider(provider), eventKey, signatureValid: true,
      payload: { connectionId: t.connectionId, environment: t.environment, body: adapter.redactPayload(safeJson(raw)) }, headers, orgId: t.orgId,
    });
    await this.providers.touch(t.orgId, t.connectionId, 'webhook', { accountName: verified.event.accountName });
    if (rec.duplicate && (rec.status === 'processed' || rec.status === 'ignored')) return { received: true, duplicate: true };
    const outcome = await this.processInbox(rec.id, provider, adapter, t, verified.event);
    return { received: true, outcome };
  }

  /** Confirms (when needed) and applies one verified event; records the inbox outcome. Throws (→ provider retry) on transient failures. */
  private async processInbox(inboxId: string, provider: string, adapter: PaymentAdapter, target: Target, event: PaymentEvent): Promise<ApplyOutcome> {
    try {
      let ev = event;
      if (ev.needsConfirmation) {
        if (!adapter.confirmEvent) throw new Error(`${provider} cannot confirm events`);
        ev = await adapter.confirmEvent(await this.providers.adapterContext(target.orgId, { provider, connectionId: target.connectionId }), ev);
      }
      const { outcome } = await this.applyEvent(target.orgId, provider, ev, 'webhook', target);
      await this.inbox.markProcessed(inboxId, NOT_APPLIED.has(outcome) ? 'ignored' : 'processed', NOT_APPLIED.has(outcome) && outcome !== 'ignored' ? outcome : null, target.orgId);
      return outcome;
    } catch (error) {
      if (error instanceof ProviderError && !error.retryable) {
        // The provider refused the re-read for a reason that will not change (wrong environment, missing key): never apply, alert once.
        await this.db.withTenant(target.orgId, (tx) => this.alert(tx, target.orgId, {
          kind: /environment|live|test/i.test(error.message) ? 'environment_mismatch' : 'unmatched_event', provider,
          details: { stage: 'confirmation', reason: error.message.slice(0, 300), providerPaymentId: event.providerPaymentId ?? null, providerSessionId: event.providerSessionId ?? null },
        }), `webhook:${provider}`);
        await this.inbox.markProcessed(inboxId, 'ignored', `confirmation_refused: ${error.message}`.slice(0, 300), target.orgId);
        return 'ignored';
      }
      await this.inbox.markProcessed(inboxId, 'failed', (error as Error).message, target.orgId);
      this.logger.warn(`payment webhook ${inboxId} failed: ${(error as Error).message}`);
      throw new DomainError('webhook_processing_failed', 'Temporarily unable to process this event', 503);
    }
  }

  /** Worker retry for verified inbox rows that failed to process (or were never processed); alerts once retries are exhausted. */
  @Scheduled('payments.webhook_retry', 60)
  async retryPending() {
    let retried = 0, failed = 0, exhausted = 0;
    for (const provider of ['simulated', 'paymob', 'stripe', 'moyasar']) {
      const adapter = paymentAdapter(provider)!;
      for (const row of await this.inbox.pending(inboxProvider(provider), 50)) {
        if (!row.org_id) continue;
        retried++;
        try {
          const target = await this.targetFor(provider, row.org_id, row.payload?.connectionId ?? null);
          if (!target) throw new Error('connection no longer usable');
          await this.processInbox(row.id, provider, adapter, target, adapter.parseEvent(row.payload?.body, target.config));
        } catch (e) {
          failed++;
          if (!(e instanceof DomainError)) await this.inbox.markProcessed(row.id, 'failed', (e as Error).message, row.org_id);
        }
      }
      for (const row of await this.inbox.exhausted(inboxProvider(provider), 50)) {
        exhausted++;
        if (row.org_id) {
          await this.db.withTenant(row.org_id, (tx) => this.alert(tx, row.org_id!, { kind: 'webhook_retry_exhausted', provider,
            details: { inboxId: row.id, attempts: row.attempts, error: row.error?.slice(0, 300) ?? null,
              action: 'This provider event could not be processed after repeated retries. Check the payment in the provider dashboard and reconcile.' } }), 'payments:webhooks');
        }
        await this.inbox.markAlerted(row.id);
      }
    }
    return { retried, failed, exhausted };
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
      return orgId ? this.targetFor(provider, orgId, null) : null;
    }
    let connectionId = isUuid(c) ? c : null;
    let orgId: string | null = null;
    if (connectionId) {
      orgId = (await this.db.withPlatform((tx) => tx.maybeOne<{ org_id: string }>(
        `select org_id from integration_connections where id = $1 and provider = $2 and category = 'payments'`, [connectionId, provider])))?.org_id ?? null;
    } else {
      const hint = adapter.lookup(input);
      if (!hint || (!hint.providerSessionId && !hint.providerPaymentId)) return null;
      const found = await this.db.withPlatform((tx) => tx.query<{ org_id: string; connection_id: string | null }>(
        `select distinct p.org_id, p.connection_id from payments p left join payment_attempt_refs r on r.payment_id = p.id
          where p.provider = $1 and ((r.provider_session_id is not null and r.provider_session_id = $2) or (p.provider_payment_id is not null and p.provider_payment_id = $3))
          limit 2`, [provider, hint.providerSessionId ?? null, hint.providerPaymentId ?? null]));
      if (found.length !== 1) return null; // unknown or ambiguous: the merchant must use the ?c= URL
      orgId = found[0]!.org_id;
      connectionId = found[0]!.connection_id;
    }
    if (!orgId || !connectionId) return null;
    return this.targetFor(provider, orgId, connectionId);
  }

  private async targetFor(provider: string, orgId: string, connectionId: string | null): Promise<Target | null> {
    if (provider === 'simulated') {
      if (this.env.PAYMENT_MODE !== 'sandbox') return null;
      const ctx = await this.providers.adapterContext(orgId, { provider, connectionId: null });
      return { orgId, connectionId: null, environment: 'sandbox', credentials: ctx.credentials, config: {} };
    }
    const creds = await this.providers.credentials(orgId, connectionId);
    if (!creds || creds.provider !== provider || creds.category !== 'payments') return null;
    return { orgId, connectionId: creds.connectionId, environment: creds.environment, credentials: creds.credentials, config: creds.config };
  }

  private async orgForAttempt(provider: string, providerSessionId: string | null, reference: string | null) {
    return (await this.db.withPlatform((tx) => tx.maybeOne<{ org_id: string }>(
      `select r.org_id from payment_attempt_refs r where r.provider = $1 and r.provider_session_id = $2
       union all select p.org_id from payments p where $3::text is not null and p.id::text = $3 and p.provider = $1 limit 1`,
      [provider, providerSessionId, isUuid(reference) ? reference : null])))?.org_id ?? null;
  }

  /**
   * Finds THE payment an event refers to, bound to the event's connection and
   * environment. Every identifier the event carries must agree on one row; an
   * unsigned echo (Paymob merchant_order_id) is a cross-check only (PAY-01).
   */
  private async findPayment(tx: Tx, provider: string, ev: PaymentEvent, binding: Binding):
    Promise<{ payment: any } | { mismatch: 'reference_mismatch' | 'ambiguous' } | null> {
    const reference = isUuid(ev.reference) ? ev.reference : null;
    const rows = await tx.query<any>(
      `select p.*, r.provider_session_id as ref_session from payments p left join payment_attempt_refs r on r.payment_id = p.id
        where p.provider = $1 and p.connection_id is not distinct from $2 and p.is_test = $3
          and ((r.provider_session_id is not null and r.provider_session_id = $4)
            or ($5::text is not null and p.id::text = $5)
            or (p.provider_payment_id is not null and p.provider_payment_id = $6))
        order by p.created_at desc limit 3 for update of p`,
      [provider, binding.connectionId, binding.environment === 'sandbox', ev.providerSessionId ?? null, reference, ev.providerPaymentId ?? null]);
    if (!rows.length) return null;
    if (new Set(rows.map((r) => r.id)).size > 1) return { mismatch: 'ambiguous' };
    const p = rows[0];
    if (ev.providerSessionId && p.ref_session && ev.providerSessionId !== p.ref_session) return { mismatch: 'reference_mismatch' };
    if (reference && reference !== p.id) return { mismatch: 'reference_mismatch' };
    // The unsigned echo may only confirm the match; a Resuto id of ANOTHER attempt means the body was tampered with.
    if (isUuid(ev.claimedReference) && ev.claimedReference !== p.id) return { mismatch: 'reference_mismatch' };
    return { payment: p };
  }

  /**
   * Applies verified provider evidence (webhook or server-side status query) to the ledger.
   * `binding` is the connection (and environment) the evidence was verified with.
   */
  async applyEvent(orgId: string, provider: string, ev: PaymentEvent, source: 'webhook' | 'status_query', binding: Binding): Promise<{ outcome: ApplyOutcome; paymentId: string | null }> {
    const ctx = webhookCtx(orgId, provider);
    if (ev.kind === 'ignored') return { outcome: 'ignored', paymentId: null };
    if (ev.livemode !== null && ev.livemode !== undefined && ev.livemode !== (binding.environment === 'live')) {
      // Signed or authenticated evidence from the other environment never touches a payment (PAY-02, INT-08).
      await this.db.withTenant(orgId, (tx) => this.alert(tx, orgId, { kind: 'environment_mismatch', provider, details: {
        connectionEnvironment: binding.environment, eventLivemode: ev.livemode, kind: ev.kind, providerPaymentId: ev.providerPaymentId ?? null, source,
        action: 'A provider event from the other environment reached this connection. Check that test and live webhooks point at the right connection.' } }), `webhook:${provider}`);
      return { outcome: 'environment_mismatch', paymentId: null };
    }
    let payment: any = null;
    try {
      return await this.db.withTenant(orgId, async (tx) => {
        const found = await this.findPayment(tx, provider, ev, binding);
        if (!found || 'mismatch' in found) {
          const kind = found && 'mismatch' in found && found.mismatch === 'reference_mismatch' ? 'reference_mismatch' : 'unmatched_event';
          await this.alert(tx, orgId, { kind, provider, details: { source, kind: ev.kind, providerSessionId: ev.providerSessionId ?? null, providerPaymentId: ev.providerPaymentId ?? null,
            claimedReference: ev.claimedReference ?? null, amountMinor: ev.amountMinor ?? null, currency: ev.currency ?? null, reason: found && 'mismatch' in found ? found.mismatch : 'no_matching_attempt' } });
          return { outcome: kind === 'reference_mismatch' ? 'reference_mismatch' as const : 'unmatched' as const, paymentId: null };
        }
        payment = found.payment;
        switch (ev.kind) {
          case 'payment_succeeded': return this.applySuccess(tx, orgId, provider, payment, ev, source, binding);
          case 'payment_failed':
          case 'payment_expired': return this.applyFailure(tx, orgId, provider, payment, ev);
          case 'payment_authorized': return this.applyAuthorized(tx, orgId, provider, payment, ev);
          case 'payment_refunded':
          case 'payment_voided': return this.applyRefundObserved(tx, ctx, orgId, provider, payment, ev, source, binding);
          case 'dispute_opened':
          case 'dispute_closed': return this.applyDispute(tx, orgId, provider, payment, ev);
          default: return { outcome: 'ignored' as const, paymentId: payment.id };
        }
      }, `webhook:${provider}`);
    } catch (error) {
      if (error instanceof RetryLater) throw new Error(error.message);
      const code = (error as DomainError)?.code;
      if (payment && (code === 'payment_mismatch' || code === 'overpayment' || code === 'environment_mismatch')) {
        // The ledger refused and the transaction rolled back: record the refusal durably, alert, never apply.
        const kind = code === 'payment_mismatch' ? 'amount_mismatch' : code === 'environment_mismatch' ? 'environment_mismatch' : 'overpayment_conflict';
        const depositOnly = payment.reservation_id && !payment.order_id && !payment.visit_id;
        await this.db.withTenant(orgId, async (tx) => {
          if (kind !== 'environment_mismatch') {
            await this.ledger.fail(tx, payment.id, code === 'payment_mismatch' ? 'amount_or_currency_mismatch' : 'overpayment_conflict');
            await this.reopenSession(tx, payment.checkout_session_id);
          }
          await this.alert(tx, orgId, { kind: kind === 'overpayment_conflict' && depositOnly ? 'deposit_not_due' : kind, provider, paymentId: payment.id, branchId: payment.branch_id,
            checkoutSessionId: payment.checkout_session_id,
            details: { expected: { amountMinor: payment.amount_minor, currency: payment.currency }, received: { amountMinor: ev.amountMinor, currency: ev.currency },
              providerPaymentId: ev.providerPaymentId ?? null, source, refundable: kind !== 'amount_mismatch' && kind !== 'environment_mismatch',
              action: kind === 'amount_mismatch' ? 'Not applied. Check the provider dashboard for this transaction.'
                : kind === 'environment_mismatch' ? 'Not applied: the event came from the other provider environment.'
                  : depositOnly ? 'The reservation no longer takes this deposit. Refund this provider payment.'
                    : 'The bill was settled another way meanwhile. Refund this provider payment.' } });
          await this.audit.record(tx, ctx, { action: `payment.${kind}`, entityType: 'payment', entityId: payment.id, branchId: payment.branch_id,
            metadata: { provider, expectedMinor: payment.amount_minor, receivedMinor: ev.amountMinor, currency: ev.currency } });
        }, `webhook:${provider}`);
        return { outcome: kind, paymentId: payment.id };
      }
      throw error;
    }
  }

  private async applySuccess(tx: Tx, orgId: string, provider: string, payment: any, ev: PaymentEvent, source: string, binding: Binding): Promise<{ outcome: ApplyOutcome; paymentId: string }> {
    const ctx = webhookCtx(orgId, provider);
    if (SETTLED.includes(payment.status)) {
      if (ev.providerPaymentId && payment.provider_payment_id && ev.providerPaymentId !== payment.provider_payment_id) {
        // A second captured transaction on a session Resuto already settled: money taken twice.
        await this.alert(tx, orgId, { kind: 'duplicate_capture', provider, paymentId: payment.id, branchId: payment.branch_id, checkoutSessionId: payment.checkout_session_id,
          details: { settledProviderPaymentId: payment.provider_payment_id, providerPaymentId: ev.providerPaymentId, amountMinor: ev.amountMinor, currency: ev.currency, source, refundable: true,
            action: 'The provider captured a second transaction for this checkout. Refund the duplicate transaction.' } });
        return { outcome: 'duplicate_capture', paymentId: payment.id };
      }
      return { outcome: 'already_settled', paymentId: payment.id };
    }
    let lateApplied = false;
    if (!ACTIVE.includes(payment.status)) {
      // PAY-08: a provider session Resuto closed (superseded, expired, declined) can still be paid. Apply it if the bill is
      // still due and nothing else is in flight for the session; otherwise alert with a refund action for staff.
      const session = payment.checkout_session_id ? await tx.maybeOne<any>('select status from checkout_sessions where id = $1 for update', [payment.checkout_session_id]) : null;
      const other = payment.checkout_session_id ? await tx.maybeOne<any>(
        `select id from payments where checkout_session_id = $1 and id <> $2 and status in ('pending', 'requires_action', 'authorized') limit 1`, [payment.checkout_session_id, payment.id]) : null;
      const reopenable = CLOSED_BY_RESUTO.includes(payment.failure_reason) && session?.status !== 'cancelled' && !other;
      if (!reopenable) {
        await this.alert(tx, orgId, { kind: 'late_success', provider, paymentId: payment.id, branchId: payment.branch_id, checkoutSessionId: payment.checkout_session_id,
          details: { status: payment.status, closedBecause: payment.failure_reason, amountMinor: ev.amountMinor, currency: ev.currency, providerPaymentId: ev.providerPaymentId, source, refundable: true,
            action: 'The provider captured money for an attempt Resuto had closed. Refund it (one click from this alert) or reconcile manually.' } });
        return { outcome: 'late_success', paymentId: payment.id };
      }
      await tx.query(`update payments set status = 'pending', failure_reason = null, raw = raw || $2 where id = $1`,
        [payment.id, { reopened: { by: 'late_success', previousStatus: payment.status, previousReason: payment.failure_reason, at: new Date().toISOString() } }]);
      lateApplied = true;
    } else if (payment.failure_reason === 'declined') {
      // A decline earlier in the same provider checkout no longer describes this attempt (PAY-07).
      await tx.query(`update payments set failure_reason = null where id = $1`, [payment.id]);
    }
    const { applied } = await this.ledger.confirm(tx, ctx, payment.id, {
      amountMinor: Number(ev.amountMinor), currency: String(ev.currency ?? ''), providerPaymentId: ev.providerPaymentId ?? null,
      feeMinor: ev.feeMinor ?? null, raw: { confirmedBy: source, providerSessionId: ev.providerSessionId ?? null }, isTest: binding.environment === 'sandbox',
    });
    if (lateApplied && payment.checkout_session_id) {
      await tx.query(`update checkout_sessions set status = 'paid', paid_at = coalesce(paid_at, now()) where id = $1 and status in ('open', 'processing', 'expired')`, [payment.checkout_session_id]);
    }
    if (applied && payment.checkout_session_id) {
      await this.outbox.publish(tx, orgId, { type: 'checkout.paid', aggregateType: 'checkout_session', aggregateId: payment.checkout_session_id, payload: { paymentId: payment.id } });
    }
    return { outcome: !applied ? 'already_settled' : lateApplied ? 'late_success_applied' : 'applied', paymentId: payment.id };
  }

  private async applyFailure(tx: Tx, orgId: string, provider: string, payment: any, ev: PaymentEvent): Promise<{ outcome: ApplyOutcome; paymentId: string }> {
    if (!ACTIVE.includes(payment.status)) return { outcome: 'ignored', paymentId: payment.id };
    const expired = ev.kind === 'payment_expired';
    const decline = { at: new Date().toISOString(), providerPaymentId: ev.providerPaymentId ?? null, message: ev.providerMessage ?? null };
    if (!expired && paymentAdapter(provider)?.sessionSurvivesDecline) {
      // PAY-07: Paymob intentions and Moyasar invoices accept another try after a decline. Record it, keep the attempt
      // open (so a later success in the same checkout is applied) and let the guest retry or pick another method.
      // One entry per provider transaction, at most MAX_DECLINES (redeliveries and unsigned variants add nothing).
      await tx.query(
        `update payments set failure_reason = 'declined',
            raw = case when jsonb_array_length(coalesce(raw->'declines', '[]'::jsonb)) >= $3
                         or ($4::text is not null and coalesce(raw->'declines', '[]'::jsonb) @> jsonb_build_array(jsonb_build_object('providerPaymentId', $4::text)))
                       then raw else jsonb_set(raw, '{declines}', coalesce(raw->'declines', '[]'::jsonb) || $2::jsonb) end
          where id = $1 and status in ('pending', 'requires_action', 'authorized')`, [payment.id, JSON.stringify([decline]), MAX_DECLINES, decline.providerPaymentId]);
      await this.reopenSession(tx, payment.checkout_session_id);
      return { outcome: 'decline_recorded', paymentId: payment.id };
    }
    await this.ledger.fail(tx, payment.id, expired ? 'expired_at_provider' : 'declined', expired ? 'expired' : 'failed');
    if (!expired) await tx.query(`update payments set raw = raw || $2 where id = $1`, [payment.id, { lastDecline: decline }]);
    await this.reopenSession(tx, payment.checkout_session_id);
    await this.outbox.publish(tx, orgId, { type: 'payment.failed', aggregateType: 'payment', aggregateId: payment.id, payload: { reason: expired ? 'expired' : 'declined' } });
    return { outcome: expired ? 'expired_recorded' : 'failed_recorded', paymentId: payment.id };
  }

  /** Auth-only: funds are held, nothing is settled. Staff capture or void at the provider (PAY-11). */
  private async applyAuthorized(tx: Tx, orgId: string, provider: string, payment: any, ev: PaymentEvent): Promise<{ outcome: ApplyOutcome; paymentId: string }> {
    if (!ACTIVE.includes(payment.status) || payment.status === 'authorized') return { outcome: payment.status === 'authorized' ? 'already_settled' : 'ignored', paymentId: payment.id };
    await tx.query(`update payments set status = 'authorized', raw = raw || $2 where id = $1 and status in ('pending', 'requires_action')`,
      [payment.id, { authorized: { at: new Date().toISOString(), providerPaymentId: ev.providerPaymentId ?? null, amountMinor: ev.amountMinor ?? null } }]);
    await this.alert(tx, orgId, { kind: 'auth_only', provider, paymentId: payment.id, branchId: payment.branch_id, checkoutSessionId: payment.checkout_session_id,
      details: { providerPaymentId: ev.providerPaymentId ?? null, amountMinor: ev.amountMinor ?? null, currency: ev.currency ?? null,
        action: 'The provider only authorised this payment (funds held, not captured). Capture it in the provider dashboard, or void it. Resuto applies it once captured.' } });
    return { outcome: 'authorized_recorded', paymentId: payment.id };
  }

  /**
   * Refunds/voids observed at the provider (PAY-11): the provider's cumulative
   * refunded amount first settles Resuto's own pending refunds; any remainder was
   * started at the provider and is recorded as such. Idempotent per cumulative total.
   */
  private async applyRefundObserved(tx: Tx, ctx: ReturnType<typeof webhookCtx>, orgId: string, provider: string, payment: any, ev: PaymentEvent,
    source: 'webhook' | 'status_query', binding: Binding): Promise<{ outcome: ApplyOutcome; paymentId: string }> {
    if (ev.providerPaymentId && payment.provider_payment_id && ev.providerPaymentId !== payment.provider_payment_id) {
      await this.alert(tx, orgId, { kind: 'unmatched_event', provider, paymentId: payment.id, branchId: payment.branch_id,
        details: { reason: 'refund_for_other_transaction', providerPaymentId: ev.providerPaymentId, settledProviderPaymentId: payment.provider_payment_id } });
      return { outcome: 'unmatched', paymentId: payment.id };
    }
    if (!SETTLED.includes(payment.status)) {
      if (ACTIVE.includes(payment.status)) {
        if (ev.kind === 'payment_voided') {
          await this.ledger.fail(tx, payment.id, 'voided_at_provider', 'cancelled');
          await this.reopenSession(tx, payment.checkout_session_id);
          return { outcome: 'failed_recorded', paymentId: payment.id };
        }
        const captured = Number(ev.capturedMinor);
        if (ev.kind === 'payment_refunded' && !ev.needsConfirmation && Number.isSafeInteger(captured) && captured > 0) {
          // Authenticated evidence that the transaction was captured and then (partly) refunded before Resuto applied the
          // capture — e.g. a Moyasar payment_paid confirmed after a refund: the re-read says "refunded", never "paid" again.
          // Settle the capture first, then the cumulative refund below, in this same transaction (review F5).
          const settled = await this.applySuccess(tx, orgId, provider, payment, { ...ev, kind: 'payment_succeeded', amountMinor: captured }, source, binding);
          if (settled.outcome !== 'applied') return settled;
          payment = await tx.one<any>('select * from payments where id = $1', [payment.id]);
        } else {
          // Delivered before the success it reverses (providers do not guarantee order): retry once the success is applied.
          throw new RetryLater('refund observed before the payment was settled');
        }
      } else {
        return { outcome: 'ignored', paymentId: payment.id };
      }
    }
    const total = Number(ev.refundedMinor);
    if (!Number.isSafeInteger(total) || total < 0) return { outcome: 'ignored', paymentId: payment.id };
    const capped = Math.min(total, Number(payment.amount_minor));
    let diff = capped - Number(payment.refunded_minor);
    if (diff <= 0) return { outcome: 'already_settled', paymentId: payment.id };
    const pending = await tx.query<any>(`select * from refunds where payment_id = $1 and status = 'pending' order by created_at for update`, [payment.id]);
    for (const r of pending) {
      if (Number(r.amount_minor) > diff) continue;
      await this.ledger.applyRefund(tx, ctx, payment.id, Number(r.amount_minor));
      await tx.query(`update refunds set status = 'succeeded', outcome_uncertain = false, completed_at = now(), last_checked_at = now(),
          provider_refund_id = coalesce(provider_refund_id, $2) where id = $1`, [r.id, ev.providerRefundId ?? null]);
      diff -= Number(r.amount_minor);
    }
    if (diff > 0) {
      const inserted = await tx.maybeOne<{ id: string }>(
        `insert into refunds(org_id, payment_id, amount_minor, reason, status, idempotency_key, provider, provider_refund_id, source, completed_at)
         values ($1, $2, $3, $4, 'succeeded', $5, $6, $7, 'provider', now()) on conflict (org_id, idempotency_key) do nothing returning id`,
        [orgId, payment.id, diff, ev.kind === 'payment_voided' ? 'Voided at the provider' : 'Refunded at the provider', `provider-refund:${payment.id}:${capped}`, provider, ev.providerRefundId ?? null]);
      if (inserted) {
        await this.ledger.applyRefund(tx, ctx, payment.id, diff);
        await this.alert(tx, orgId, { kind: 'provider_refund', provider, paymentId: payment.id, branchId: payment.branch_id,
          details: { refundId: inserted.id, amountMinor: diff, providerRefundedMinor: capped, currency: payment.currency,
            action: 'A refund was made directly at the provider. Resuto recorded it against this payment.' } });
        await this.audit.record(tx, ctx, { action: 'refund.observed_at_provider', entityType: 'refund', entityId: inserted.id, branchId: payment.branch_id, metadata: { paymentId: payment.id, amountMinor: diff } });
      }
    }
    return { outcome: 'refund_applied', paymentId: payment.id };
  }

  private async applyDispute(tx: Tx, orgId: string, provider: string, payment: any, ev: PaymentEvent): Promise<{ outcome: ApplyOutcome; paymentId: string }> {
    await tx.query(`update payments set raw = jsonb_set(raw, '{disputes}', coalesce(raw->'disputes', '[]'::jsonb) || $2::jsonb) where id = $1`,
      [payment.id, JSON.stringify([{ id: ev.disputeId ?? null, status: ev.disputeStatus ?? null, kind: ev.kind, amountMinor: ev.amountMinor ?? null, at: new Date().toISOString() }])]);
    await this.alert(tx, orgId, { kind: 'dispute', provider, paymentId: payment.id, branchId: payment.branch_id,
      details: { disputeId: ev.disputeId ?? null, status: ev.disputeStatus ?? null, opened: ev.kind === 'dispute_opened', amountMinor: ev.amountMinor ?? null, currency: ev.currency ?? null,
        action: ev.kind === 'dispute_opened' ? 'The cardholder disputed this payment. Respond in the provider dashboard before the deadline.' : 'The dispute was closed. Check the outcome in the provider dashboard.' } });
    return { outcome: 'dispute_recorded', paymentId: payment.id };
  }

  private async reopenSession(tx: Tx, sessionId: string | null) {
    if (!sessionId) return;
    await tx.query(`update checkout_sessions set status = case when expires_at <= now() then 'expired' else 'open' end where id = $1 and status = 'processing'`, [sessionId]);
  }

  async alert(tx: Tx, orgId: string, a: { kind: string; provider?: string; paymentId?: string | null; branchId?: string | null; checkoutSessionId?: string | null; details: Record<string, unknown> }) {
    const ppid = a.details.providerPaymentId ?? null;
    const psid = a.details.providerSessionId ?? null;
    if (ONE_OPEN_ALERT_PER_TRANSACTION.has(a.kind) && (ppid !== null || psid !== null)) {
      const txn = ppid !== null ? `p:${String(ppid)}` : `s:${String(psid)}`;
      // Serialises concurrent deliveries of the same transaction (some paths run after the payment lock was released).
      await tx.query('select pg_advisory_xact_lock(hashtext($1))', [`payment-alert:${orgId}:${a.kind}:${a.paymentId ?? ''}:${txn}`]);
      const open = await tx.maybeOne<{ id: string }>(
        `select id from payment_alerts where org_id = $1 and kind = $2 and payment_id is not distinct from $3::uuid
            and case when $4::text is not null then details->>'providerPaymentId' = $4::text else details->>'providerSessionId' = $5::text end
          order by (status = 'open') desc, created_at limit 1`, [orgId, a.kind, a.paymentId ?? null, ppid === null ? null : String(ppid), psid === null ? null : String(psid)]);
      if (open) {
        await tx.query(`update payment_alerts set details = details || jsonb_build_object('repeats', coalesce((details->>'repeats')::int, 1) + 1, 'lastSeenAt', now())
            where id = $1`, [open.id]);
        return;
      }
    }
    await tx.query(
      `insert into payment_alerts(org_id, branch_id, kind, payment_id, checkout_session_id, provider, details) values ($1, $2, $3, $4, $5, $6, $7)`,
      [orgId, a.branchId ?? null, a.kind, a.paymentId ?? null, a.checkoutSessionId ?? null, a.provider ?? null, JSON.stringify(a.details)]);
  }
}
