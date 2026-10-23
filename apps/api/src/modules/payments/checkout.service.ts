import { Inject, Injectable, Logger } from '@nestjs/common';
import { type CheckoutMethodOption, type CheckoutView, type StartCheckout, type StartCheckoutResult } from '@resuto/contracts';
import { paymentAdapter } from '@resuto/integrations';
import { ENV, type Env } from '../../config/env';
import type { TenantContext } from '../../common/auth/context';
import { newToken, sha256 } from '../../common/crypto/hash';
import { SecretBox } from '../../common/crypto/secret-box';
import { DbService, type Tx } from '../../common/db/db.service';
import { EntitlementsService } from '../../common/entitlements/entitlements.service';
import { DomainError, conflict, invalid, notFound } from '../../common/errors/domain-error';
import type { OutboxEvent } from '../../common/events/events';
import { OutboxService } from '../../common/platform/outbox.service';
import { PaymentLedgerService, type PaymentMethod } from '../kernel/payment-ledger.service';
import type { CheckoutPort, CheckoutSessionCreated, CheckoutSessionRequest } from '../kernel/ports';
import { PaymentProvidersService } from './providers.service';
import { ReceiptsService } from './receipts.service';
import { SandboxProviderService } from './sandbox.service';
import { guestCtx, gone } from './util';
import { PaymentWebhooksService } from './webhooks.service';

const DEFAULT_MINUTES: Record<string, number> = { order: 30, visit_bill: 30, bill_share: 30, reservation_deposit: 30, payment_link: 24 * 60 };
const ACTIVE = ['pending', 'requires_action', 'authorized'];

interface Target {
  branchId: string; currency: string; dueMinor: number; fulfillment: string | null; description: string;
  orderId: string | null; visitId: string | null; shareId: string | null; reservationId: string | null;
}

/**
 * ResutoPay checkout sessions (CHECKOUT_PORT) and the public hosted checkout.
 * A session is a bearer link (`/pay/<token>`, sha256 stored) for an amount that
 * defaults to what is due. Starting it creates a pending ledger attempt and a
 * provider session; only verified provider evidence settles it.
 */
@Injectable()
export class CheckoutService implements CheckoutPort {
  private readonly logger = new Logger('Checkout');
  private readonly lastRecheck = new Map<string, number>();

  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly db: DbService,
    private readonly box: SecretBox,
    private readonly entitlements: EntitlementsService,
    private readonly ledger: PaymentLedgerService,
    private readonly outbox: OutboxService,
    private readonly providers: PaymentProvidersService,
    private readonly sandbox: SandboxProviderService,
    private readonly webhooks: PaymentWebhooksService,
    private readonly receipts: ReceiptsService,
  ) {}

  // ---------------------------------------------------------------------------
  // CHECKOUT_PORT
  // ---------------------------------------------------------------------------
  async createSession(tx: Tx, ctx: TenantContext, input: CheckoutSessionRequest): Promise<CheckoutSessionCreated> {
    await this.entitlements.assert(ctx.orgId, 'pay');
    const t = await this.resolveTarget(tx, input);
    ctx.assertBranch(t.branchId);
    const amount = input.amountMinor ?? t.dueMinor;
    if (t.dueMinor < 1) throw conflict('nothing_due', 'Nothing is due for this bill');
    if (!Number.isSafeInteger(amount) || amount < 1 || amount > t.dueMinor) {
      throw new DomainError('overpayment', 'This amount is more than what is still due', 409, { dueMinor: t.dueMinor });
    }
    const available = await this.providers.methodsFor(tx, ctx.orgId, t.branchId, { purpose: input.purpose, fulfillment: t.fulfillment });
    const allowed = available.map((m) => m.method).filter((m) => !input.allowedMethods || input.allowedMethods.includes(m as PaymentMethod));
    if (!allowed.length) throw conflict('no_payment_method', 'No payment method is available for this checkout');
    let minutes = Math.min(Math.max(input.expiresInMinutes ?? DEFAULT_MINUTES[input.purpose]!, 5), 7 * 24 * 60);
    if (input.purpose === 'reservation_deposit') {
      const hold = await tx.maybeOne<{ m: number }>(`select extract(epoch from (hold_expires_at - now())) / 60 as m from reservations where id = $1 and hold_expires_at is not null`, [t.reservationId]);
      if (hold) minutes = Math.max(1, Math.min(minutes, Math.floor(Number(hold.m))));
    }
    const token = newToken();
    const row = await tx.one<{ id: string; expires_at: Date }>(
      `insert into checkout_sessions(org_id, branch_id, token_hash, token_sealed, purpose, order_id, visit_id, share_id, reservation_id, amount_minor,
          currency, description, allowed_methods, return_url, channel, customer_id, expires_at, is_test, created_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::payment_method[], $14, $15, $16, now() + make_interval(mins => $17), $18, $19)
       returning id, expires_at`,
      [ctx.orgId, t.branchId, sha256(token), this.box.seal(token, `checkout:${ctx.orgId}`), input.purpose, t.orderId, t.visitId, t.shareId, t.reservationId,
        amount, t.currency, input.description?.slice(0, 200) ?? t.description, allowed, safeReturnUrl(input.returnUrl, this.env.APP_ORIGIN),
        input.channel, input.customerId ?? null, minutes, this.providers.mode === 'sandbox', ctx.actorType === 'user' ? ctx.userId : null]);
    await this.outbox.publish(tx, ctx.orgId, { type: 'checkout.created', aggregateType: 'checkout_session', aggregateId: row.id,
      payload: { purpose: input.purpose, amountMinor: amount, channel: input.channel } });
    return { id: row.id, token, url: this.url(token), amountMinor: amount, currency: t.currency, expiresAt: new Date(row.expires_at).toISOString() };
  }

  url(token: string) {
    return `${this.env.APP_ORIGIN.replace(/\/$/, '')}/pay/${token}`;
  }

  /** Re-derives an existing session's link for someone already authorised to see it. */
  linkFor(orgId: string, sealed: string | null): string | null {
    if (!sealed) return null;
    try {
      return this.url(this.box.open(sealed, `checkout:${orgId}`));
    } catch {
      return null;
    }
  }

  private async resolveTarget(tx: Tx, input: CheckoutSessionRequest): Promise<Target> {
    const orgCurrency = async () => (await tx.one<{ currency: string }>(`select currency from organizations where id = app.current_org_id()`)).currency;
    const orderTarget = async (orderId: string) => {
      const o = await tx.maybeOne<any>('select id, branch_id, currency, status, fulfillment, number, visit_id from orders where id = $1', [orderId]);
      if (!o) throw notFound('Order');
      if (o.status === 'cancelled') throw conflict('order_cancelled', 'This order was cancelled');
      const due = (await this.ledger.outstanding(tx, { orderId })).dueMinor;
      return { branchId: o.branch_id, currency: o.currency, dueMinor: due, fulfillment: o.fulfillment, description: `Order #${o.number}`, orderId, visitId: null, shareId: null, reservationId: null };
    };
    const visitTarget = async (visitId: string) => {
      const v = await tx.maybeOne<any>(
        `select v.id, v.branch_id, v.status, v.kind, t.label,
                (select o.number from orders o where o.visit_id = v.id and o.status <> 'cancelled' order by o.placed_at desc, o.id desc limit 1) as ticket
           from visits v left join dining_tables t on t.id = v.table_id where v.id = $1`, [visitId]);
      if (!v) throw notFound('Table bill');
      if (v.status !== 'open') throw conflict('visit_closed', 'This table session has ended');
      const due = (await this.ledger.outstanding(tx, { visitId })).dueMinor;
      // A counter visit (FT-07) is takeaway with no table: it is described by its ticket number.
      const counter = v.kind === 'counter';
      return { branchId: v.branch_id, currency: await orgCurrency(), dueMinor: due, fulfillment: counter ? 'pickup' : 'dine_in',
        description: counter ? `Counter order #${v.ticket ?? ''}`.trim() : `Table ${v.label} bill`, orderId: null, visitId, shareId: null, reservationId: null };
    };
    switch (input.purpose) {
      case 'order':
        if (!input.orderId) throw invalid('order_required', 'An order is required');
        return orderTarget(input.orderId);
      case 'visit_bill':
        if (!input.visitId) throw invalid('visit_required', 'A table bill is required');
        return visitTarget(input.visitId);
      case 'payment_link':
        if (input.orderId) return orderTarget(input.orderId);
        if (input.visitId) return visitTarget(input.visitId);
        throw invalid('target_required', 'Choose an order or table bill');
      case 'bill_share': {
        if (!input.shareId) throw invalid('share_required', 'A bill share is required');
        const s = await tx.maybeOne<any>(
          `select s.id, s.amount_minor, s.paid_minor, s.status, s.label, sp.status as split_status, sp.visit_id, sp.order_id, sp.branch_id, sp.currency
             from bill_shares s join bill_splits sp on sp.id = s.split_id where s.id = $1`, [input.shareId]);
        if (!s || s.status === 'void' || s.split_status === 'cancelled') throw notFound('Bill share');
        if (s.status === 'paid') throw conflict('share_paid', 'This share is already paid');
        return { branchId: s.branch_id, currency: s.currency, dueMinor: s.amount_minor - s.paid_minor, fulfillment: 'dine_in', description: `Bill share: ${s.label}`,
          orderId: s.order_id, visitId: s.visit_id, shareId: s.id, reservationId: null };
      }
      case 'reservation_deposit': {
        if (!input.reservationId) throw invalid('reservation_required', 'A reservation is required');
        const r = await tx.maybeOne<any>('select id, branch_id, status, deposit_minor, deposit_status, code from reservations where id = $1', [input.reservationId]);
        if (!r) throw notFound('Reservation');
        if (!['held', 'pending_deposit'].includes(r.status) || r.deposit_status !== 'required' || r.deposit_minor < 1) {
          throw conflict('deposit_not_required', 'This reservation does not need a deposit');
        }
        return { branchId: r.branch_id, currency: await orgCurrency(), dueMinor: Number(r.deposit_minor), fulfillment: null, description: `Reservation ${r.code} deposit`,
          orderId: null, visitId: null, shareId: null, reservationId: r.id };
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Public hosted checkout
  // ---------------------------------------------------------------------------
  async locate(token: string): Promise<{ id: string; orgId: string }> {
    if (typeof token !== 'string' || token.length < 16 || token.length > 200) throw notFound('Checkout');
    const row = await this.db.withPlatform((tx) => tx.maybeOne<{ id: string; org_id: string }>('select id, org_id from checkout_sessions where token_hash = $1', [sha256(token)]));
    if (!row) throw notFound('Checkout');
    await this.entitlements.assert(row.org_id, 'pay');
    return { id: row.id, orgId: row.org_id };
  }

  async view(token: string): Promise<CheckoutView> {
    const { id, orgId } = await this.locate(token);
    return this.db.withTenant(orgId, (tx) => this.toView(tx, orgId, id), `checkout:${id}`);
  }

  private async currentAttempt(tx: Tx, sessionId: string, lock = false) {
    return tx.maybeOne<any>(
      `select p.*, r.provider_session_id as ref_session, r.redirect_url from payments p left join payment_attempt_refs r on r.payment_id = p.id
        where p.checkout_session_id = $1 and p.status in ('pending', 'requires_action', 'authorized') order by p.created_at desc limit 1${lock ? ' for update of p' : ''}`, [sessionId]);
  }

  private async toView(tx: Tx, orgId: string, sessionId: string): Promise<CheckoutView> {
    const s = await tx.one<any>('select * from checkout_sessions where id = $1', [sessionId]);
    const org = await tx.one<any>('select name, name_ar, country from organizations where id = $1', [orgId]);
    const branch = await tx.maybeOne<any>('select name, name_ar from branches where id = $1', [s.branch_id]);
    const attempt = await this.currentAttempt(tx, s.id)
      ?? await tx.maybeOne<any>(`select p.*, null as redirect_url from payments p where p.checkout_session_id = $1 order by p.created_at desc limit 1`, [s.id]);
    const available = await this.providers.methodsFor(tx, orgId, s.branch_id, { purpose: s.purpose, fulfillment: s.order_id ? (await tx.one<any>('select fulfillment from orders where id = $1', [s.order_id])).fulfillment : null });
    const allowed = parseArray(s.allowed_methods);
    const status = ['open', 'processing'].includes(s.status) && new Date(s.expires_at) <= new Date() ? 'expired' : s.status;
    return {
      id: s.id, status, purpose: s.purpose, amountMinor: s.amount_minor, currency: s.currency, description: s.description,
      merchant: { name: org.name, nameAr: org.name_ar, branch: branch?.name ?? null, branchAr: branch?.name_ar ?? null, country: org.country },
      items: await this.items(tx, s),
      methods: available.filter((m) => allowed.includes(m.method)),
      expiresAt: new Date(s.expires_at).toISOString(), paidAt: s.paid_at ? new Date(s.paid_at).toISOString() : null,
      attempt: attempt ? {
        id: attempt.id, method: attempt.method, provider: attempt.provider, status: attempt.status, redirectUrl: ACTIVE.includes(attempt.status) ? attempt.redirect_url : null,
        sandbox: attempt.provider === 'simulated' || attempt.is_test, failureReason: guestFailureCode(attempt.failure_reason),
      } : null,
      sandbox: this.providers.mode === 'sandbox',
      returnUrl: s.return_url,
    };
  }

  private async items(tx: Tx, s: any): Promise<CheckoutView['items']> {
    if (s.purpose === 'reservation_deposit') return [{ name: 'Reservation deposit', nameAr: 'عربون الحجز', quantity: 1, totalMinor: s.amount_minor }];
    if (s.share_id) {
      const share = await tx.one<any>('select label, allocation from bill_shares where id = $1', [s.share_id]);
      const alloc: any[] = Array.isArray(share.allocation) ? share.allocation : [];
      if (alloc.length) {
        const merged = new Map<string, { name: string; nameAr: string | null; quantity: number; totalMinor: number }>();
        for (const a of alloc) {
          const m = merged.get(a.name) ?? { name: a.name, nameAr: a.nameAr ?? null, quantity: 0, totalMinor: 0 };
          m.quantity++; m.totalMinor += Number(a.amountMinor); merged.set(a.name, m);
        }
        return [...merged.values()];
      }
      return [{ name: `Share: ${share.label}`, nameAr: `حصة: ${share.label}`, quantity: 1, totalMinor: s.amount_minor }];
    }
    const lines = await tx.query<any>(
      s.order_id
        ? `select name, name_ar, sum(quantity)::int as q, sum(line_total_minor)::bigint as t from order_lines where order_id = $1 group by name, name_ar order by min(created_at)`
        : `select l.name, l.name_ar, sum(l.quantity)::int as q, sum(l.line_total_minor)::bigint as t from order_lines l join orders o on o.id = l.order_id
            where o.visit_id = $1 and o.status <> 'cancelled' group by l.name, l.name_ar order by min(l.created_at)`, [s.order_id ?? s.visit_id]);
    return lines.map((l) => ({ name: l.name, nameAr: l.name_ar, quantity: l.q, totalMinor: Number(l.t) }));
  }

  /** Starts (or resumes) payment with a method. Offline methods never create a payment. */
  async start(token: string, input: StartCheckout): Promise<StartCheckoutResult> {
    const { id, orgId } = await this.locate(token);
    const actor = `checkout:${id}`;
    const gctx = guestCtx(orgId, actor);

    // An earlier attempt with another method (or a stale one) is checked with the provider before it is superseded.
    const prior = await this.db.withTenant(orgId, (tx) => this.currentAttempt(tx, id), actor);
    if (prior) {
      const age = Date.now() - new Date(prior.created_at).getTime();
      if (prior.method === input.method && prior.redirect_url && age < 25 * 60_000) {
        return { kind: 'redirect', redirectUrl: prior.redirect_url, sandbox: prior.provider === 'simulated', paymentId: prior.id };
      }
      if (!prior.redirect_url && age < 2 * 60_000) throw conflict('checkout_in_progress', 'This payment is being prepared. Try again in a moment.');
      // Close the earlier provider session first where the provider supports it (PAY-08), then re-check: a payment that
      // completed meanwhile is applied instead of superseded. Anything that still lands later is resolved by the webhook path.
      if (await this.closeAtProvider(orgId, prior) === 'settled') return { kind: 'paid', sandbox: prior.provider === 'simulated', paymentId: prior.id };
      await this.db.withTenant(orgId, async (tx) => {
        const cur = await tx.one<any>('select status from payments where id = $1 for update', [prior.id]);
        if (ACTIVE.includes(cur.status)) await this.ledger.fail(tx, prior.id, 'superseded_by_new_attempt', 'cancelled');
      }, actor);
    }

    const phase1 = await this.db.withTenant(orgId, async (tx) => {
      const s = await tx.one<any>('select * from checkout_sessions where id = $1 for update', [id]);
      if (s.status === 'paid') return { kind: 'paid' as const };
      if (s.status === 'cancelled') throw gone('checkout_cancelled', 'This payment link was cancelled');
      if (s.status === 'expired' || new Date(s.expires_at) <= new Date()) {
        await tx.query(`update checkout_sessions set status = 'expired' where id = $1 and status in ('open', 'processing')`, [id]);
        return { kind: 'expired' as const };
      }
      const fulfillment = s.order_id ? (await tx.one<any>('select fulfillment from orders where id = $1', [s.order_id])).fulfillment : null;
      const options = await this.providers.methodsFor(tx, orgId, s.branch_id, { purpose: s.purpose, fulfillment });
      const option = options.find((o) => o.method === input.method);
      if (!option || !parseArray(s.allowed_methods).includes(input.method)) throw invalid('method_unavailable', 'This payment method is not available here');
      if (s.purpose === 'visit_bill' && await tx.maybeOne(`select 1 from bill_splits where visit_id = $1 and status = 'open'`, [s.visit_id])) {
        throw conflict('split_active', 'This bill is being split. Use your share link.');
      }
      if (option.kind === 'offline') return { kind: 'offline' as const, option };
      // PAY-09: re-check under the session lock. A concurrent /start that got here first owns the only active attempt
      // (also enforced by payments_one_active_attempt_idx).
      const active = await this.currentAttempt(tx, id, true);
      if (active) {
        if (active.redirect_url && active.method === input.method) return { kind: 'resume' as const, attempt: active };
        throw conflict('checkout_in_progress', 'This payment is being prepared. Try again in a moment.');
      }
      await this.assertStillDue(tx, s);
      const resolved = await this.providers.resolve(tx, orgId, s.branch_id, input.method as 'card' | 'wallet');
      if (!resolved) throw invalid('method_unavailable', 'This payment method is not available here');
      const payment = await this.ledger.createPending(tx, gctx, {
        branchId: s.branch_id, orderId: s.order_id, visitId: s.visit_id, shareId: s.share_id, reservationId: s.reservation_id, checkoutSessionId: s.id,
        method: input.method as PaymentMethod, provider: resolved.provider, connectionId: resolved.connectionId, amountMinor: s.amount_minor, currency: s.currency,
        isTest: resolved.sandbox, raw: { channel: s.channel, payerName: input.payerName ?? null },
      });
      await tx.query(`update checkout_sessions set status = 'processing', provider = $2, connection_id = $3, payer_name = coalesce($4, payer_name) where id = $1`,
        [s.id, resolved.provider, resolved.connectionId, input.payerName ?? null]);
      return { kind: 'create' as const, session: s, payment, resolved };
    }, actor);

    if (phase1.kind === 'paid') return { kind: 'paid', sandbox: this.providers.mode === 'sandbox' };
    if (phase1.kind === 'expired') throw gone('checkout_expired', 'This payment link has expired. Ask for a new one.');
    if (phase1.kind === 'offline') return { kind: 'offline', instructions: phase1.option.instructions ?? undefined, sandbox: false };
    if (phase1.kind === 'resume') return { kind: 'redirect', redirectUrl: phase1.attempt.redirect_url, sandbox: phase1.attempt.provider === 'simulated', paymentId: phase1.attempt.id };

    const { session: s, payment, resolved } = phase1;
    const apiOrigin = this.env.API_ORIGIN.replace(/\/$/, '');
    let created: { providerSessionId: string; redirectUrl: string };
    try {
      const actx = await this.providers.adapterContext(orgId, resolved, { sandboxPageUrl: `${this.url(token)}/sandbox` });
      created = await resolved.adapter.createCheckout(actx, {
        reference: payment.id, amountMinor: s.amount_minor, currency: s.currency, method: input.method as 'card' | 'wallet',
        description: s.description ?? 'Restaurant bill payment', returnUrl: `${this.url(token)}?return=1`, cancelUrl: `${this.url(token)}?cancelled=1`,
        notificationUrl: `${apiOrigin}/v1/webhooks/payments/${resolved.provider}?c=${resolved.connectionId ?? orgId}`,
        // Unsigned "invoice paid" callbacks (Moyasar callback_url) only trigger a server-side status query (PAY-16, INT-09).
        nudgeUrl: `${apiOrigin}/v1/public/pay/${token}/nudge`,
        customer: { name: input.payerName ?? null }, expiresInSeconds: 1800,
      });
    } catch (error) {
      this.logger.warn(`provider checkout failed for ${payment.id}: ${(error as Error).message}`);
      await this.db.withTenant(orgId, async (tx) => {
        // PAY-20: guests only ever see the fixed code; the provider's text is kept for staff in raw.providerError.
        await this.ledger.fail(tx, payment.id, 'provider_unavailable');
        await tx.query(`update payments set raw = raw || $2 where id = $1`, [payment.id, { providerError: (error as Error).message.slice(0, 500) }]);
        await tx.query(`update checkout_sessions set status = 'open' where id = $1 and status = 'processing'`, [s.id]);
      }, actor);
      throw new DomainError('provider_unavailable', 'The payment provider is unavailable. No payment was taken; please try again.', 502);
    }
    await this.db.withTenant(orgId, async (tx) => {
      await tx.query(`insert into payment_attempt_refs(payment_id, org_id, checkout_session_id, provider, provider_session_id, redirect_url) values ($1, $2, $3, $4, $5, $6)`,
        [payment.id, orgId, s.id, resolved.provider, created.providerSessionId, created.redirectUrl]);
      await tx.query(`update checkout_sessions set provider_session_id = $2, provider_url = $3 where id = $1`, [s.id, created.providerSessionId, created.redirectUrl]);
    }, actor);
    return { kind: 'redirect', redirectUrl: created.redirectUrl, sandbox: resolved.sandbox, paymentId: payment.id };
  }

  private async assertStillDue(tx: Tx, s: any) {
    let due: number;
    if (s.share_id) {
      const sh = await tx.one<any>('select amount_minor, paid_minor, status from bill_shares where id = $1', [s.share_id]);
      due = sh.status === 'open' ? sh.amount_minor - sh.paid_minor : 0;
    } else if (s.reservation_id && !s.order_id && !s.visit_id) {
      const r = await tx.one<any>('select status, deposit_status from reservations where id = $1 for update', [s.reservation_id]);
      const busy = await tx.maybeOne(
        `select 1 from payments where reservation_id = $1 and order_id is null and visit_id is null and status in ('pending', 'requires_action', 'authorized', 'succeeded')`, [s.reservation_id]);
      if (busy) throw conflict('checkout_in_progress', 'A deposit payment is already in progress');
      due = ['held', 'pending_deposit'].includes(r.status) && r.deposit_status === 'required' ? s.amount_minor : 0;
    } else {
      due = (await this.ledger.outstanding(tx, { orderId: s.order_id, visitId: s.order_id ? null : s.visit_id })).dueMinor;
    }
    if (due < 1) throw conflict('nothing_due', 'This bill is already settled');
    if (s.amount_minor > due) throw new DomainError('balance_changed', 'The balance changed. Refresh your bill.', 409, { dueMinor: due });
  }

  /**
   * Server-side provider status query for an attempt; applies verified results.
   * Return URLs and polling call this — query parameters are never trusted.
   */
  private async recheckAttempt(orgId: string, attempt: any): Promise<boolean> {
    if (!attempt?.ref_session) return false;
    const key = `${attempt.id}`;
    const last = this.lastRecheck.get(key) ?? 0;
    if (Date.now() - last < 2_000) return false;
    this.lastRecheck.set(key, Date.now());
    if (this.lastRecheck.size > 10_000) this.lastRecheck.clear();
    try {
      const resolved = { provider: attempt.provider, connectionId: attempt.connection_id };
      const adapter = paymentAdapter(attempt.provider);
      if (!adapter) return false;
      const actx = await this.providers.adapterContext(orgId, resolved);
      const ev = await adapter.retrieveStatus(actx, { providerSessionId: attempt.ref_session, reference: attempt.id });
      if (ev.kind === 'ignored') return false;
      // The query was authenticated with this attempt's own connection: the answer is bound to it and its environment (PAY-10).
      await this.webhooks.applyEvent(orgId, attempt.provider, { ...ev, providerSessionId: ev.providerSessionId ?? attempt.ref_session, reference: ev.reference ?? attempt.id },
        'status_query', { connectionId: attempt.connection_id ?? null, environment: actx.environment });
      return true;
    } catch (error) {
      this.logger.warn(`status query failed for ${attempt.id}: ${(error as Error).message}`);
      return false;
    }
  }

  /** Return/polling: re-checks the attempt with the provider, then returns the current view. */
  async refresh(token: string): Promise<CheckoutView> {
    const { id, orgId } = await this.locate(token);
    const attempt = await this.db.withTenant(orgId, (tx) => this.currentAttempt(tx, id), `checkout:${id}`);
    if (attempt) await this.recheckAttempt(orgId, attempt);
    return this.view(token);
  }

  /**
   * Unsigned provider "something changed" callback (Moyasar invoice callback_url): the body is ignored and only the
   * attempt's status is re-read with the merchant's key. It can never settle anything by itself.
   */
  async nudge(token: string): Promise<{ received: true }> {
    const { id, orgId } = await this.locate(token).catch(() => ({ id: null, orgId: null }));
    if (!id || !orgId) return { received: true };
    const attempt = await this.db.withTenant(orgId, (tx) => this.currentAttempt(tx, id), `checkout:${id}`);
    if (attempt) await this.recheckAttempt(orgId, attempt);
    return { received: true };
  }

  /**
   * Makes an attempt's provider session unpayable where the provider supports it (Stripe session expire, Moyasar
   * invoice cancel), then re-reads its status. Returns 'settled' when the payment completed meanwhile (and was applied).
   */
  async closeAtProvider(orgId: string, attempt: any): Promise<'settled' | 'closed' | 'unsupported' | 'error'> {
    let result: 'closed' | 'unsupported' | 'error' = 'unsupported';
    const adapter = paymentAdapter(attempt.provider);
    if (adapter?.cancelCheckout && attempt.ref_session && attempt.provider !== 'simulated') {
      try {
        const actx = await this.providers.adapterContext(orgId, { provider: attempt.provider, connectionId: attempt.connection_id });
        const r = await adapter.cancelCheckout(actx, { providerSessionId: attempt.ref_session });
        result = r === 'cancelled' ? 'closed' : r === 'unsupported' ? 'unsupported' : 'error';
        await this.db.withTenant(orgId, (tx) => tx.query(`update payments set raw = raw || $2 where id = $1`,
          [attempt.id, { providerCancel: { result: r, at: new Date().toISOString() } }]), 'payments:checkout');
      } catch (error) {
        this.logger.warn(`provider cancel failed for ${attempt.id}: ${(error as Error).message}`);
        result = 'error';
      }
    }
    this.lastRecheck.delete(attempt.id);
    if (await this.recheckAttempt(orgId, attempt)) {
      const cur = await this.db.withTenant(orgId, (tx) => tx.one<any>('select status from payments where id = $1', [attempt.id]), 'payments:checkout');
      if (cur.status === 'succeeded') return 'settled';
    }
    return result;
  }

  async receipt(token: string) {
    const { id, orgId } = await this.locate(token);
    return this.db.withTenant(orgId, async (tx) => {
      const p = await tx.maybeOne<{ id: string }>(
        `select id from payments where checkout_session_id = $1 and status in ('succeeded', 'partially_refunded', 'refunded') order by captured_at desc limit 1`, [id]);
      if (!p) throw notFound('Receipt');
      return this.receipts.build(tx, p.id);
    }, `checkout:${id}`);
  }

  // ---------------------------------------------------------------------------
  // Simulated provider test page (sandbox only)
  // ---------------------------------------------------------------------------
  private assertSandbox() {
    if (this.providers.mode !== 'sandbox') throw new DomainError('sandbox_disabled', 'Simulated payments are disabled in live mode', 403);
  }

  async sandboxView(token: string, providerSessionId?: string) {
    this.assertSandbox();
    const { id, orgId } = await this.locate(token);
    return this.db.withTenant(orgId, async (tx) => {
      const view = await this.toView(tx, orgId, id);
      const attempt = await this.currentAttempt(tx, id);
      const txn = attempt?.provider === 'simulated' && attempt.ref_session
        ? await tx.maybeOne<any>('select status, amount_minor, currency, provider_session_id from payment_sandbox_transactions where provider_session_id = $1', [attempt.ref_session])
        : null;
      return {
        sandbox: true as const, label: 'Sandbox — no money moves',
        merchant: view.merchant, amountMinor: view.amountMinor, currency: view.currency, sessionStatus: view.status,
        providerSession: txn && (!providerSessionId || providerSessionId === txn.provider_session_id)
          ? { id: txn.provider_session_id, status: txn.status, amountMinor: txn.amount_minor, currency: txn.currency } : null,
      };
    }, `checkout:${id}`);
  }

  /** Tester's choice → provider-side settlement → signed webhook through the real verification path. */
  async sandboxComplete(token: string, outcome: 'success' | 'failure') {
    this.assertSandbox();
    const { id, orgId } = await this.locate(token);
    const attempt = await this.db.withTenant(orgId, (tx) => this.currentAttempt(tx, id), `checkout:${id}`);
    if (!attempt || attempt.provider !== 'simulated' || !attempt.ref_session) throw conflict('no_sandbox_attempt', 'Start the payment first');
    const hook = await this.sandbox.settle(orgId, attempt.ref_session, outcome);
    if (!hook) throw notFound('Sandbox session');
    await this.webhooks.handle('simulated', Buffer.from(hook.raw), hook.headers, { c: orgId });
    return this.view(token);
  }

  // ---------------------------------------------------------------------------
  // Expiry
  // ---------------------------------------------------------------------------
  /** Runs from PaymentsJobs (payments.expire_checkouts). */
  async expireDue() {
    const orgs = await this.db.withPlatform((tx) => tx.query<{ org_id: string }>(
      `select distinct org_id from checkout_sessions where status in ('open', 'processing') and expires_at <= now()
       union select distinct p.org_id from payments p join checkout_sessions s on s.id = p.checkout_session_id
        where p.status in ('pending', 'requires_action', 'authorized') and s.status in ('expired', 'cancelled') and p.created_at < now() - interval '45 minutes'
       union select distinct s.org_id from checkout_sessions s join reservations r on r.id = s.reservation_id
        where s.status in ('open', 'processing') and r.status in ('cancelled', 'expired', 'no_show') limit 500`));
    let sessions = 0, attempts = 0;
    for (const { org_id: orgId } of orgs) {
      const stale = await this.db.withTenant(orgId, async (tx) => {
        const r = await tx.query(
          `update checkout_sessions s set status = 'expired' where s.status in ('open', 'processing')
              and (s.expires_at <= now() or exists (select 1 from reservations r where r.id = s.reservation_id and r.status in ('cancelled', 'expired', 'no_show')))
           returning id`);
        sessions += r.length;
        return tx.query<any>(
          `select p.*, r.provider_session_id as ref_session from payments p join checkout_sessions s on s.id = p.checkout_session_id
             left join payment_attempt_refs r on r.payment_id = p.id
            where p.status in ('pending', 'requires_action', 'authorized') and s.status in ('expired', 'cancelled')
              and p.created_at < now() - interval '45 minutes' limit 50`);
      }, 'payments:expiry');
      for (const p of stale) {
        if (await this.closeAtProvider(orgId, p) === 'settled') continue;
        await this.db.withTenant(orgId, async (tx) => {
          const cur = await tx.one<any>('select status from payments where id = $1', [p.id]);
          if (!ACTIVE.includes(cur.status)) return;
          await this.ledger.fail(tx, p.id, 'checkout_expired', 'expired');
          if (p.provider === 'simulated' && p.ref_session) {
            await tx.query(`update payment_sandbox_transactions set status = 'expired', completed_at = now() where provider_session_id = $1 and status = 'open'`, [p.ref_session]);
          }
          attempts++;
        }, 'payments:expiry');
      }
    }
    return { sessions, attempts };
  }

  /** Cancelled reservations: their deposit links stop working immediately (PaymentsJobs). */
  async onReservationCancelled(event: OutboxEvent) {
    if (!event.orgId) return;
    await this.db.withTenant(event.orgId, async (tx) => {
      await tx.query(`update checkout_sessions set status = 'expired' where reservation_id = $1 and status in ('open', 'processing')`, [event.aggregateId]);
      const pending = await tx.query<{ id: string }>(
        `select id from payments where reservation_id = $1 and order_id is null and visit_id is null and status in ('pending', 'requires_action', 'authorized')`, [event.aggregateId]);
      for (const p of pending) await this.ledger.fail(tx, p.id, 'reservation_cancelled', 'cancelled');
    }, 'payments:reservations');
  }

  /** Methods for display (used by staff screens). */
  methods(tx: Tx, orgId: string, branchId: string, purpose: string, fulfillment?: string | null): Promise<CheckoutMethodOption[]> {
    return this.providers.methodsFor(tx, orgId, branchId, { purpose, fulfillment });
  }
}

/**
 * The only failure codes a guest ever sees (PAY-20). Provider messages and internal reasons are mapped to these;
 * anything unknown becomes `declined` for a definite failure.
 */
export const GUEST_FAILURE_CODES = ['declined', 'expired', 'cancelled', 'provider_unavailable', 'under_review'] as const;
export function guestFailureCode(reason: string | null | undefined): (typeof GUEST_FAILURE_CODES)[number] | null {
  if (!reason) return null;
  if ((GUEST_FAILURE_CODES as readonly string[]).includes(reason)) return reason as (typeof GUEST_FAILURE_CODES)[number];
  if (reason === 'async_payment_failed') return 'declined';
  if (reason.startsWith('provider_error') || reason === 'provider_unavailable') return 'provider_unavailable';
  if (['expired_at_provider', 'checkout_expired'].includes(reason)) return 'expired';
  if (['superseded_by_new_attempt', 'duplicate_active_attempt', 'reservation_cancelled', 'voided_at_provider'].includes(reason)) return 'cancelled';
  // Captured but not applied (amount mismatch, settled another way): staff were alerted and will refund or apply it.
  if (['amount_or_currency_mismatch', 'overpayment_conflict'].includes(reason)) return 'under_review';
  return 'declined';
}

/** Postgres enum arrays may arrive as "{card,cash}". */
export function parseArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(String);
  if (typeof v === 'string') return v.replace(/^\{|\}$/g, '').split(',').filter(Boolean);
  return [];
}

/** Return URLs may only point back to the Resuto web app. */
function safeReturnUrl(url: string | null | undefined, appOrigin: string): string | null {
  if (!url) return null;
  try {
    const u = new URL(url, appOrigin);
    return u.origin === new URL(appOrigin).origin ? u.toString() : null;
  } catch {
    return null;
  }
}

