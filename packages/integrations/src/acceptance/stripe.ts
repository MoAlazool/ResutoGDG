// Stripe acceptance checks against Stripe test mode (sk_test_ keys). Docs: https://docs.stripe.com/testing,
// https://docs.stripe.com/webhooks#verify-manually, https://docs.stripe.com/api/checkout/sessions, https://docs.stripe.com/api/refunds.
import { stripeAdapter, parseStripeSignature } from '../payments/stripe';
import { expectThat, registerChecks, type AcceptanceCheck, type AcceptanceContext } from './index';
import { assertHealthy, official, paymentContext, readCaptured, runKey, testCheckout } from './payments-common';

const KEY = 'STRIPE_TEST_SECRET_KEY';
const WHSEC = 'STRIPE_TEST_WEBHOOK_SECRET';
const ctxOf = (ctx: AcceptanceContext) => paymentContext(ctx, { secretKey: ctx.env[KEY]!, webhookSecret: ctx.env[WHSEC] ?? 'whsec_unused' });

export const stripeChecks: AcceptanceCheck[] = [
  {
    id: 'stripe.account', provider: 'stripe', capability: 'health_check', modes: official, requires: [KEY, WHSEC], effect: 'read', docsUrl: 'https://docs.stripe.com/api/accounts/retrieve',
    async run(ctx) { await assertHealthy(stripeAdapter, ctxOf(ctx), ctx); },
  },
  {
    id: 'stripe.checkout', provider: 'stripe', capability: 'checkout', modes: official, requires: [KEY], effect: 'write_test', docsUrl: 'https://docs.stripe.com/api/checkout/sessions/create',
    async run(ctx) {
      const actx = ctxOf(ctx);
      const r = await stripeAdapter.createCheckout(actx, testCheckout(runKey('acc-stripe'), ctx.env.STRIPE_TEST_CURRENCY ?? 'USD', 100));
      ctx.evidence('checkout session created', { sessionIdPrefix: r.providerSessionId.slice(0, 8), host: new URL(r.redirectUrl).host });
      expectThat(r.providerSessionId.startsWith('cs_test_'), 'a test-mode session id (cs_test_…) was expected');
      const st = await stripeAdapter.retrieveStatus(actx, { providerSessionId: r.providerSessionId, reference: 'acceptance' });
      ctx.evidence('status of the open session', { kind: st.kind });
      expectThat(st.kind === 'ignored', 'an unpaid session must not read as paid');
      // cancel_checkout: the open session is expired at Stripe so it cannot be paid later.
      const cancelled = await stripeAdapter.cancelCheckout!(actx, { providerSessionId: r.providerSessionId });
      ctx.evidence('session expired', { result: cancelled });
      expectThat(cancelled === 'cancelled', 'the open session should be expirable');
    },
  },
  {
    id: 'stripe.webhook_signature', provider: 'stripe', capability: 'webhooks', modes: official, requires: [WHSEC, 'STRIPE_TEST_EVENT_FILE', 'STRIPE_TEST_EVENT_SIGNATURE'], effect: 'read',
    prerequisites: ['Capture one test event exactly as delivered: raw body to the file named by STRIPE_TEST_EVENT_FILE and its Stripe-Signature header to STRIPE_TEST_EVENT_SIGNATURE (e.g. a checkout.session.completed after paying with card 4242 4242 4242 4242).'],
    docsUrl: 'https://docs.stripe.com/webhooks#verify-manually',
    async run(ctx) {
      const raw = readCaptured(ctx.env.STRIPE_TEST_EVENT_FILE!);
      const sig = ctx.env.STRIPE_TEST_EVENT_SIGNATURE!;
      // A captured event is older than the 300 s tolerance; verify the signature at its own timestamp (the tolerance is unit-tested).
      const at = parseStripeSignature(sig).t ?? undefined;
      const v = stripeAdapter.verifyWebhook({ webhookSecret: ctx.env[WHSEC]! }, { rawBody: raw, headers: { 'stripe-signature': sig }, query: {}, nowSeconds: at });
      ctx.evidence('verification', { valid: v.valid, reason: v.reason ?? null, kind: v.event?.kind ?? null, livemode: v.event?.livemode ?? null });
      expectThat(v.valid, `Stripe's own test event did not verify: ${v.reason}`);
      expectThat(v.event?.livemode === false, 'a test-mode event (livemode false) was expected');
      const tampered = stripeAdapter.verifyWebhook({ webhookSecret: ctx.env[WHSEC]! }, { rawBody: `${raw} `, headers: { 'stripe-signature': sig }, query: {}, nowSeconds: at });
      expectThat(!tampered.valid, 'a modified body must not verify');
    },
  },
  {
    id: 'stripe.status_query', provider: 'stripe', capability: 'status_query', modes: official, requires: [KEY, 'STRIPE_TEST_PAID_SESSION_ID'], effect: 'read',
    prerequisites: ['Pay one test Checkout Session with card 4242 4242 4242 4242 and put its id (cs_test_…) in STRIPE_TEST_PAID_SESSION_ID.'],
    docsUrl: 'https://docs.stripe.com/api/checkout/sessions/retrieve',
    async run(ctx) {
      const st = await stripeAdapter.retrieveStatus(ctxOf(ctx), { providerSessionId: ctx.env.STRIPE_TEST_PAID_SESSION_ID!, reference: 'acceptance' });
      ctx.evidence('status', { kind: st.kind, livemode: st.livemode ?? null, currency: st.currency ?? null, hasPaymentIntent: !!st.providerPaymentId });
      expectThat(st.kind === 'payment_succeeded' && st.livemode === false, 'the paid test session should read as payment_succeeded in test mode');
    },
  },
  {
    id: 'stripe.refund', provider: 'stripe', capability: 'refunds', modes: official, requires: [KEY, 'STRIPE_TEST_REFUND_PAYMENT_INTENT'], effect: 'write_test',
    prerequisites: ['A succeeded TEST payment intent (pi_…) with at least 1.00 left to refund, in STRIPE_TEST_REFUND_PAYMENT_INTENT.'],
    docsUrl: 'https://docs.stripe.com/api/refunds/create',
    async run(ctx) {
      const actx = ctxOf(ctx);
      const req = { providerPaymentId: ctx.env.STRIPE_TEST_REFUND_PAYMENT_INTENT!, amountMinor: 100, currency: ctx.env.STRIPE_TEST_CURRENCY ?? 'USD', reason: 'Resuto acceptance check', idempotencyKey: runKey('acc-refund') };
      const r = await stripeAdapter.refund(actx, req);
      ctx.evidence('refund', { status: r.status, refundIdPrefix: r.providerRefundId?.slice(0, 3) ?? null });
      expectThat(r.status === 'succeeded' || r.status === 'pending', `refund ${r.status}: ${r.failureReason ?? ''}`);
      // Same key again: Stripe must replay the same refund, not create a second one (PAY-05).
      const again = await stripeAdapter.refund(actx, req);
      expectThat(again.providerRefundId === r.providerRefundId, 'a retry with the same idempotency key created a second refund');
      const st = await stripeAdapter.refundStatus(actx, { ...req, providerRefundId: null });
      ctx.evidence('refund status by key', { status: st.status });
      expectThat(st.status === 'succeeded' || st.status === 'pending', `refund inquiry by key returned ${st.status}`);
    },
  },
];

registerChecks(...stripeChecks);
