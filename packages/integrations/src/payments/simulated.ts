// Simulated (sandbox) payment provider. Owner: Agent D1.
//
// No money moves. The "provider" is a Resuto-hosted test page where a tester
// chooses success or failure; the API then emits a webhook SIGNED with the
// tenant's sandbox secret and feeds it through exactly the same verification
// path as real providers (signature over raw body → inbox → ledger.confirm).
// Its transaction ledger lives in the API database and is reached through the
// `store` object the API passes in AdapterContext.config, so reconciliation and
// refunds work against a real provider-side record.
import { randomBytes } from 'node:crypto';
import { constantTimeEqual, hmacHex, type AdapterContext, type ProviderDescriptor } from '../core';
import {
  header, rawText, rejected, safeJson,
  type CheckoutRequest, type PaymentAdapter, type PaymentEvent, type ProviderTransaction, type RefundRequest, type WebhookInput,
} from './types';

export const SIMULATED_SIGNATURE_HEADER = 'x-resuto-sandbox-signature';
export const SIMULATED_TOLERANCE_SECONDS = 300;

export interface SimulatedStore {
  get(providerSessionId: string): Promise<null | { status: 'open' | 'succeeded' | 'failed' | 'expired' | 'refunded' | 'partially_refunded'; providerPaymentId: string | null; reference: string; amountMinor: number; currency: string; feeMinor: number }>;
  open(input: { providerSessionId: string; reference: string; amountMinor: number; currency: string }): Promise<void>;
  refund(input: { providerPaymentId: string; amountMinor: number; idempotencyKey: string }): Promise<{ providerRefundId: string } | { error: string }>;
  list(range: { from: Date; to: Date }): Promise<ProviderTransaction[]>;
}

export interface SimulatedEventBody {
  id: string;
  type: 'payment.succeeded' | 'payment.failed' | 'payment.expired';
  created: number;
  livemode: false;
  data: {
    session_id: string;
    payment_id: string | null;
    reference: string;
    amount_minor: number;
    currency: string;
    fee_minor: number;
    failure_reason?: string | null;
  };
}

export const simulatedDescriptor: ProviderDescriptor = {
  id: 'simulated',
  name: 'Resuto sandbox (simulated)',
  category: 'payments',
  countries: ['EG', 'SA'],
  authType: 'webhook_secret',
  readiness: 'simulated',
  activation: ['Available only when PAYMENT_MODE=sandbox. No provider account and no money involved.'],
  capabilities: ['checkout', 'webhooks', 'status_query', 'refunds', 'transaction_listing'],
};

/** `t=<unix>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>` — same construction as Stripe. */
export function signSimulated(secret: string, rawBody: string, timestamp: number): string {
  return `t=${timestamp},v1=${hmacHex('sha256', secret, `${timestamp}.${rawBody}`)}`;
}

function toEvent(body: SimulatedEventBody): PaymentEvent {
  const d = body.data;
  const kind = body.type === 'payment.succeeded' ? 'payment_succeeded' : body.type === 'payment.failed' ? 'payment_failed' : 'payment_expired';
  return {
    kind, providerSessionId: d.session_id, providerPaymentId: d.payment_id, reference: d.reference,
    amountMinor: d.amount_minor, currency: String(d.currency).toUpperCase(), feeMinor: d.fee_minor ?? 0, failureReason: d.failure_reason ?? null,
  };
}

const store = (ctx: AdapterContext) => {
  const s = ctx.config.store as SimulatedStore | undefined;
  if (!s) throw new Error('simulated provider store is not configured');
  return s;
};

export const simulatedAdapter: PaymentAdapter = {
  descriptor: simulatedDescriptor,
  methods: ['card', 'wallet'],
  requiredCredentials: ['webhookSecret'],

  async createCheckout(ctx: AdapterContext, req: CheckoutRequest) {
    if (ctx.environment !== 'sandbox') throw new Error('The simulated provider only runs in sandbox mode');
    const providerSessionId = `sim_cs_${randomBytes(12).toString('hex')}`;
    await store(ctx).open({ providerSessionId, reference: req.reference, amountMinor: req.amountMinor, currency: req.currency });
    const page = String(ctx.config.sandboxPageUrl ?? '');
    if (!page) throw new Error('sandboxPageUrl is required');
    return { providerSessionId, redirectUrl: `${page}${page.includes('?') ? '&' : '?'}session=${providerSessionId}`, raw: { sandbox: true } };
  },

  lookup(input: WebhookInput) {
    const body = safeJson(input.rawBody) as SimulatedEventBody | null;
    if (!body?.data) return null;
    return { providerSessionId: body.data.session_id ?? null, providerPaymentId: body.data.payment_id ?? null, reference: body.data.reference ?? null };
  },

  verifyWebhook(credentials, input) {
    const secret = credentials.webhookSecret;
    if (!secret) return rejected('sandbox secret not configured');
    const sig = header(input.headers, SIMULATED_SIGNATURE_HEADER) ?? '';
    const parts = Object.fromEntries(sig.split(',').map((p) => p.split('=') as [string, string]).filter((p) => p.length === 2));
    const t = Number(parts.t);
    const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
    if (!Number.isFinite(t) || !parts.v1) return rejected('missing signature');
    if (Math.abs(now - t) > SIMULATED_TOLERANCE_SECONDS) return rejected('timestamp outside tolerance');
    const raw = rawText(input.rawBody);
    if (!constantTimeEqual(hmacHex('sha256', secret, `${t}.${raw}`), parts.v1)) return rejected('signature mismatch');
    const body = safeJson(raw) as SimulatedEventBody | null;
    if (!body?.id || !body.data) return rejected('malformed payload');
    return { valid: true, eventKey: body.id, event: toEvent(body) };
  },

  parseEvent(payload) {
    return toEvent(payload as SimulatedEventBody);
  },

  async retrieveStatus(ctx, ref) {
    const row = await store(ctx).get(ref.providerSessionId);
    if (!row) return { kind: 'ignored', providerSessionId: ref.providerSessionId };
    const kind = row.status === 'succeeded' || row.status === 'refunded' || row.status === 'partially_refunded' ? 'payment_succeeded'
      : row.status === 'failed' ? 'payment_failed' : row.status === 'expired' ? 'payment_expired' : 'ignored';
    return { kind, providerSessionId: ref.providerSessionId, providerPaymentId: row.providerPaymentId, reference: row.reference,
      amountMinor: row.amountMinor, currency: row.currency, feeMinor: row.feeMinor };
  },

  async refund(ctx, req: RefundRequest) {
    const r = await store(ctx).refund({ providerPaymentId: req.providerPaymentId, amountMinor: req.amountMinor, idempotencyKey: req.idempotencyKey });
    return 'error' in r ? { status: 'failed', providerRefundId: null, failureReason: r.error } : { status: 'succeeded', providerRefundId: r.providerRefundId };
  },

  async listTransactions(ctx, range) {
    return store(ctx).list(range);
  },
};
