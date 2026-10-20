// Paymob acceptance checks against a Paymob TEST-mode account (…sk_test_/…pk_test_ keys, test integration ids).
// Docs: https://developers.paymob.com/paymob-docs/developers/intention-apis/create-intention,
// https://developers.paymob.com/paymob-docs/developers/webhook-callbacks-and-hmac/hmac/hmac-transaction-callback,
// https://developers.paymob.com/paymob-docs/need-help/setup-guides/getting-integration-credentials
import { paymobAdapter } from '../payments/paymob';
import { expectThat, registerChecks, type AcceptanceCheck, type AcceptanceContext } from './index';
import { assertHealthy, official, paymentContext, readCaptured, runKey, testCheckout } from './payments-common';

const KEYS = ['PAYMOB_TEST_SECRET_KEY', 'PAYMOB_TEST_PUBLIC_KEY', 'PAYMOB_TEST_HMAC_SECRET', 'PAYMOB_TEST_API_KEY', 'PAYMOB_TEST_CARD_INTEGRATION_ID'];
const ctxOf = (ctx: AcceptanceContext) => paymentContext(ctx, {
  secretKey: ctx.env.PAYMOB_TEST_SECRET_KEY!, publicKey: ctx.env.PAYMOB_TEST_PUBLIC_KEY!, hmacSecret: ctx.env.PAYMOB_TEST_HMAC_SECRET!, apiKey: ctx.env.PAYMOB_TEST_API_KEY!,
}, {
  integrationIdCard: ctx.env.PAYMOB_TEST_CARD_INTEGRATION_ID, ...(ctx.env.PAYMOB_TEST_WALLET_INTEGRATION_ID ? { integrationIdWallet: ctx.env.PAYMOB_TEST_WALLET_INTEGRATION_ID } : {}),
  ...(ctx.env.PAYMOB_BASE_URL ? { baseUrl: ctx.env.PAYMOB_BASE_URL } : {}),
});

/** A captured callback: the POST body (file) and the `hmac` query value Paymob sent with it. */
function verifyCaptured(ctx: AcceptanceContext, fileVar: string, hmacVar: string, integration: Record<string, unknown>) {
  const raw = readCaptured(ctx.env[fileVar]!);
  const v = paymobAdapter.verifyWebhook({ hmacSecret: ctx.env.PAYMOB_TEST_HMAC_SECRET! }, { rawBody: raw, headers: {}, query: { hmac: ctx.env[hmacVar]! } }, integration);
  ctx.evidence('verification', { valid: v.valid, reason: v.reason ?? null, kind: v.event?.kind ?? null });
  expectThat(v.valid, `Paymob's own callback did not verify: ${v.reason}`);
  const body = JSON.parse(raw);
  body.obj.amount_cents = Number(body.obj.amount_cents) + 1;
  const tampered = paymobAdapter.verifyWebhook({ hmacSecret: ctx.env.PAYMOB_TEST_HMAC_SECRET! }, { rawBody: JSON.stringify(body), headers: {}, query: { hmac: ctx.env[hmacVar]! } }, integration);
  expectThat(!tampered.valid, 'a callback with a modified signed field must not verify');
  return v;
}

export const paymobChecks: AcceptanceCheck[] = [
  {
    id: 'paymob.auth', provider: 'paymob', capability: 'health_check', modes: official, requires: KEYS, effect: 'read',
    docsUrl: 'https://developers.paymob.com/paymob-docs/need-help/setup-guides/getting-integration-credentials',
    async run(ctx) { await assertHealthy(paymobAdapter, ctxOf(ctx), ctx); },
  },
  {
    id: 'paymob.checkout', provider: 'paymob', capability: 'checkout', modes: official, requires: KEYS, effect: 'write_test',
    docsUrl: 'https://developers.paymob.com/paymob-docs/developers/intention-apis/create-intention',
    async run(ctx) {
      const r = await paymobAdapter.createCheckout(ctxOf(ctx), testCheckout(runKey('acc-paymob'), ctx.env.PAYMOB_TEST_CURRENCY ?? 'EGP', 1000));
      const u = new URL(r.redirectUrl);
      ctx.evidence('intention created', { orderId: r.providerSessionId, host: u.host, path: u.pathname });
      expectThat(/^\d+$/.test(r.providerSessionId), 'a numeric intention order id was expected');
      expectThat(u.pathname.startsWith('/unifiedcheckout'), 'the Unified Checkout URL was expected');
    },
  },
  {
    id: 'paymob.webhook_signature', provider: 'paymob', capability: 'webhooks', modes: official,
    requires: ['PAYMOB_TEST_HMAC_SECRET', 'PAYMOB_TEST_CARD_INTEGRATION_ID', 'PAYMOB_TEST_CALLBACK_FILE', 'PAYMOB_TEST_CALLBACK_HMAC'], effect: 'read',
    prerequisites: ['Pay one test card transaction and save the transaction processed callback POST body to PAYMOB_TEST_CALLBACK_FILE and its ?hmac= value to PAYMOB_TEST_CALLBACK_HMAC.'],
    docsUrl: 'https://developers.paymob.com/paymob-docs/developers/webhook-callbacks-and-hmac/hmac/hmac-transaction-callback',
    async run(ctx) {
      const v = verifyCaptured(ctx, 'PAYMOB_TEST_CALLBACK_FILE', 'PAYMOB_TEST_CALLBACK_HMAC', { integrationIdCard: ctx.env.PAYMOB_TEST_CARD_INTEGRATION_ID });
      expectThat(v.event?.kind !== 'ignored', 'the callback should belong to the configured card integration');
    },
  },
  {
    // INT-19: wallet callbacks carry null source_data fields; Paymob's HMAC treatment of nulls is verified here.
    id: 'paymob.webhook_signature_wallet', provider: 'paymob', capability: 'webhooks', modes: official,
    requires: ['PAYMOB_TEST_HMAC_SECRET', 'PAYMOB_TEST_WALLET_INTEGRATION_ID', 'PAYMOB_TEST_WALLET_CALLBACK_FILE', 'PAYMOB_TEST_WALLET_CALLBACK_HMAC'], effect: 'read',
    prerequisites: ['Set the wallet integration\'s transaction processed callback in the Paymob dashboard, pay one test wallet transaction and save its callback body and ?hmac= value.'],
    async run(ctx) {
      verifyCaptured(ctx, 'PAYMOB_TEST_WALLET_CALLBACK_FILE', 'PAYMOB_TEST_WALLET_CALLBACK_HMAC',
        { integrationIdCard: ctx.env.PAYMOB_TEST_CARD_INTEGRATION_ID ?? '0', integrationIdWallet: ctx.env.PAYMOB_TEST_WALLET_INTEGRATION_ID });
    },
  },
  {
    id: 'paymob.status_query', provider: 'paymob', capability: 'status_query', modes: official, requires: [...KEYS, 'PAYMOB_TEST_PAID_ORDER_ID'], effect: 'read',
    prerequisites: ['Pay one test transaction and put its Paymob order id in PAYMOB_TEST_PAID_ORDER_ID.'],
    async run(ctx) {
      const st = await paymobAdapter.retrieveStatus(ctxOf(ctx), { providerSessionId: ctx.env.PAYMOB_TEST_PAID_ORDER_ID!, reference: 'acceptance' });
      ctx.evidence('inquiry', { kind: st.kind, livemode: st.livemode ?? null, currency: st.currency ?? null });
      expectThat(st.kind === 'payment_succeeded', `the paid test order should read as payment_succeeded, got ${st.kind}`);
      expectThat(st.livemode !== true, 'the inquiry reported a live transaction');
    },
  },
  {
    id: 'paymob.refund', provider: 'paymob', capability: 'refunds', modes: official, requires: [...KEYS, 'PAYMOB_TEST_REFUND_TRANSACTION_ID', 'PAYMOB_TEST_REFUND_ORDER_ID'], effect: 'write_test',
    prerequisites: ['A settled TEST transaction (id and order id) with at least 1.00 EGP left to refund. Note: same-day transactions may need a void instead (PAY-21).'],
    async run(ctx) {
      const actx = ctxOf(ctx);
      const before = await paymobAdapter.refundStatus(actx, { providerPaymentId: ctx.env.PAYMOB_TEST_REFUND_TRANSACTION_ID!, providerSessionId: ctx.env.PAYMOB_TEST_REFUND_ORDER_ID!,
        amountMinor: 0, currency: 'EGP', reason: 'probe', idempotencyKey: 'probe', ledgerRefundedMinor: 0 });
      const already = Number(before.providerRefundedMinor ?? 0);
      const req = { providerPaymentId: ctx.env.PAYMOB_TEST_REFUND_TRANSACTION_ID!, providerSessionId: ctx.env.PAYMOB_TEST_REFUND_ORDER_ID!, amountMinor: 100, currency: 'EGP',
        reason: 'Resuto acceptance check', idempotencyKey: runKey('acc-refund'), ledgerRefundedMinor: already };
      const r = await paymobAdapter.refund(actx, req);
      ctx.evidence('refund', { status: r.status });
      expectThat(r.status === 'succeeded' || r.status === 'pending', `refund ${r.status}: ${r.failureReason ?? ''}`);
      const st = await paymobAdapter.refundStatus(actx, req);
      ctx.evidence('refund status from the inquiry total', { status: st.status, refundedMinor: st.providerRefundedMinor ?? null });
      expectThat(st.status === 'succeeded', `the inquiry's refunded_amount_cents does not show the refund (${st.status})`);
    },
  },
];

registerChecks(...paymobChecks);
