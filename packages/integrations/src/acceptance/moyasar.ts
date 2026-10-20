// Moyasar acceptance checks against Moyasar test mode (sk_test_ keys). Docs: https://docs.moyasar.com/api/invoices/01-create-invoice,
// https://docs.moyasar.com/api/other/webhooks/webhook-reference, https://docs.moyasar.com/api/payments/02-fetch-payment
import { moyasarAdapter } from '../payments/moyasar';
import { expectThat, registerChecks, type AcceptanceCheck, type AcceptanceContext } from './index';
import { assertHealthy, official, paymentContext, readCaptured, runKey, testCheckout } from './payments-common';

const KEY = 'MOYASAR_TEST_SECRET_KEY';
const TOKEN = 'MOYASAR_TEST_WEBHOOK_SECRET';
const ctxOf = (ctx: AcceptanceContext) => paymentContext(ctx, { secretKey: ctx.env[KEY]!, webhookSecret: ctx.env[TOKEN] ?? 'unused' });

export const moyasarChecks: AcceptanceCheck[] = [
  {
    id: 'moyasar.auth', provider: 'moyasar', capability: 'health_check', modes: official, requires: [KEY, TOKEN], effect: 'read',
    docsUrl: 'https://docs.moyasar.com/docs/api/authentication.md',
    async run(ctx) { await assertHealthy(moyasarAdapter, ctxOf(ctx), ctx); },
  },
  {
    id: 'moyasar.checkout', provider: 'moyasar', capability: 'checkout', modes: official, requires: [KEY], effect: 'write_test',
    docsUrl: 'https://docs.moyasar.com/api/invoices/01-create-invoice',
    async run(ctx) {
      const actx = ctxOf(ctx);
      const r = await moyasarAdapter.createCheckout(actx, { ...testCheckout(runKey('acc-moyasar'), 'SAR', 100), nudgeUrl: 'https://example.com/resuto-acceptance/nudge' });
      ctx.evidence('invoice created', { host: new URL(r.redirectUrl).host });
      const st = await moyasarAdapter.retrieveStatus(actx, { providerSessionId: r.providerSessionId, reference: 'acceptance' });
      expectThat(st.kind === 'ignored', `an unpaid invoice must not read as paid (${st.kind})`);
      const cancelled = await moyasarAdapter.cancelCheckout!(actx, { providerSessionId: r.providerSessionId });
      ctx.evidence('invoice cancelled', { result: cancelled });
      expectThat(cancelled === 'cancelled', 'an unpaid invoice should be cancellable (PUT /invoices/:id/cancel)');
    },
  },
  {
    id: 'moyasar.webhook_signature', provider: 'moyasar', capability: 'webhooks', modes: official, requires: [KEY, TOKEN, 'MOYASAR_TEST_WEBHOOK_FILE'], effect: 'read',
    prerequisites: ['Register the webhook in the Moyasar test dashboard with a secret token, pay one test invoice and save the delivered body to MOYASAR_TEST_WEBHOOK_FILE.'],
    docsUrl: 'https://docs.moyasar.com/api/other/webhooks/webhook-reference',
    async run(ctx) {
      const raw = readCaptured(ctx.env.MOYASAR_TEST_WEBHOOK_FILE!);
      const v = moyasarAdapter.verifyWebhook({ webhookSecret: ctx.env[TOKEN]! }, { rawBody: raw, headers: {}, query: {} });
      ctx.evidence('token check', { valid: v.valid, type: JSON.parse(raw).type ?? null, live: JSON.parse(raw).live ?? null });
      expectThat(v.valid && v.event?.needsConfirmation === true, `the delivery did not authenticate: ${v.reason ?? 'not a payment event'}`);
      const confirmed = await moyasarAdapter.confirmEvent!(ctxOf(ctx), v.event!);
      ctx.evidence('payment fetched with the secret key', { kind: confirmed.kind, currency: confirmed.currency ?? null });
      expectThat(confirmed.kind !== 'ignored', 'the payment named by the webhook could not be fetched');
    },
  },
  {
    id: 'moyasar.status_query', provider: 'moyasar', capability: 'status_query', modes: official, requires: [KEY, 'MOYASAR_TEST_PAID_INVOICE_ID'], effect: 'read',
    prerequisites: ['Pay one test invoice (Moyasar test card) and put its id in MOYASAR_TEST_PAID_INVOICE_ID.'],
    async run(ctx) {
      const st = await moyasarAdapter.retrieveStatus(ctxOf(ctx), { providerSessionId: ctx.env.MOYASAR_TEST_PAID_INVOICE_ID!, reference: 'acceptance' });
      ctx.evidence('invoice status', { kind: st.kind, currency: st.currency ?? null });
      expectThat(st.kind === 'payment_succeeded', `the paid test invoice should read as payment_succeeded, got ${st.kind}`);
    },
  },
  {
    id: 'moyasar.refund', provider: 'moyasar', capability: 'refunds', modes: official, requires: [KEY, 'MOYASAR_TEST_REFUND_PAYMENT_ID'], effect: 'write_test',
    prerequisites: ['A paid TEST payment id with at least 1.00 SAR left to refund, in MOYASAR_TEST_REFUND_PAYMENT_ID.'],
    docsUrl: 'https://docs.moyasar.com/docs/guides/payment-operations/index.md',
    async run(ctx) {
      const actx = ctxOf(ctx);
      const probe = await moyasarAdapter.refundStatus(actx, { providerPaymentId: ctx.env.MOYASAR_TEST_REFUND_PAYMENT_ID!, amountMinor: 0, currency: 'SAR', reason: 'probe', idempotencyKey: 'probe', ledgerRefundedMinor: 0 });
      const req = { providerPaymentId: ctx.env.MOYASAR_TEST_REFUND_PAYMENT_ID!, amountMinor: 100, currency: 'SAR', reason: 'Resuto acceptance check',
        idempotencyKey: runKey('acc-refund'), ledgerRefundedMinor: Number(probe.providerRefundedMinor ?? 0) };
      const r = await moyasarAdapter.refund(actx, req);
      ctx.evidence('refund', { status: r.status });
      expectThat(r.status === 'succeeded', `refund ${r.status}: ${r.failureReason ?? ''}`);
      const st = await moyasarAdapter.refundStatus(actx, req);
      expectThat(st.status === 'succeeded', `GET /payments/:id does not show the refund (${st.status})`);
    },
  },
];

registerChecks(...moyasarChecks);
