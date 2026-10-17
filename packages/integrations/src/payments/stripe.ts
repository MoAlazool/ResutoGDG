// Stripe Checkout Sessions adapter. Owner: Agent D1.
// Docs: https://docs.stripe.com/api/checkout/sessions, https://docs.stripe.com/webhooks#verify-manually,
// https://docs.stripe.com/api/refunds, https://docs.stripe.com/api/charges/list
import { constantTimeEqual, hmacHex, providerRequest, ProviderError, type AdapterContext, type ProviderDescriptor } from '../core';
import { header, rawText, rejected, safeJson, type PaymentAdapter, type PaymentEvent, type ProviderTransaction } from './types';

export const STRIPE_API = 'https://api.stripe.com';
export const STRIPE_TOLERANCE_SECONDS = 300;

export const stripeDescriptor: ProviderDescriptor = {
  id: 'stripe',
  name: 'Stripe',
  category: 'payments',
  countries: ['EG', 'SA'],
  authType: 'api_key',
  readiness: 'implemented_unverified',
  docsUrl: 'https://docs.stripe.com/payments/checkout',
  activation: [
    'Create or use the restaurant\'s own Stripe account (Resuto never holds funds).',
    'Developers → API keys: copy the secret key (sk_test_… for sandbox, sk_live_… for live) into the connection as "secretKey".',
    'Developers → Webhooks → Add endpoint: <API_ORIGIN>/v1/webhooks/payments/stripe?c=<connectionId>, events checkout.session.completed, checkout.session.async_payment_succeeded, checkout.session.async_payment_failed, checkout.session.expired.',
    'Copy the endpoint signing secret (whsec_…) into the connection as "webhookSecret".',
    'Confirm the account can present the restaurant currency (EGP/SAR) and run one sandbox payment end to end before switching the connection to live.',
  ],
  capabilities: ['checkout', 'webhooks', 'status_query', 'refunds', 'transaction_listing'],
};

const auth = (ctx: AdapterContext) => {
  const key = ctx.credentials.secretKey;
  if (!key) throw new ProviderError('stripe', 'secretKey is not configured', false);
  if (ctx.environment === 'sandbox' && !key.startsWith('sk_test_') && !key.startsWith('rk_test_')) {
    throw new ProviderError('stripe', 'Sandbox connections must use a test key (sk_test_…)', false);
  }
  return { Authorization: `Bearer ${key}` };
};

/** Parses `t=…,v1=…,v1=…,v0=…`. */
export function parseStripeSignature(value: string) {
  const out: { t: number | null; v1: string[] } = { t: null, v1: [] };
  for (const part of value.split(',')) {
    const [k, v] = part.split('=');
    if (k === 't') out.t = Number(v);
    if (k === 'v1' && v) out.v1.push(v);
  }
  return out;
}

/** Signature header for a payload (used by tests and local tooling). */
export const signStripe = (secret: string, rawBody: string, timestamp: number) =>
  `t=${timestamp},v1=${hmacHex('sha256', secret, `${timestamp}.${rawBody}`)}`;

function sessionEvent(type: string, s: any): PaymentEvent {
  const base = {
    providerSessionId: s?.id ?? null,
    providerPaymentId: typeof s?.payment_intent === 'string' ? s.payment_intent : s?.payment_intent?.id ?? null,
    reference: s?.client_reference_id ?? s?.metadata?.resuto_payment_id ?? null,
    amountMinor: Number(s?.amount_total),
    currency: String(s?.currency ?? '').toUpperCase(),
    feeMinor: null,
  };
  if ((type === 'checkout.session.completed' && s?.payment_status === 'paid') || type === 'checkout.session.async_payment_succeeded') {
    return { kind: 'payment_succeeded', ...base };
  }
  if (type === 'checkout.session.async_payment_failed') return { kind: 'payment_failed', ...base, failureReason: 'async_payment_failed' };
  if (type === 'checkout.session.expired') return { kind: 'payment_expired', ...base };
  return { kind: 'ignored', ...base };
}

const form = (fields: Record<string, string | number | undefined>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(fields)) if (v !== undefined) p.append(k, String(v));
  return p;
};

export const stripeAdapter: PaymentAdapter = {
  descriptor: stripeDescriptor,
  methods: ['card'],
  requiredCredentials: ['secretKey', 'webhookSecret'],

  async createCheckout(ctx, req) {
    const expires = Math.floor(Date.now() / 1000) + Math.max(req.expiresInSeconds, 1800); // Stripe minimum is 30 minutes
    const body = form({
      mode: 'payment',
      'payment_method_types[0]': 'card',
      client_reference_id: req.reference,
      'metadata[resuto_payment_id]': req.reference,
      'payment_intent_data[metadata][resuto_payment_id]': req.reference,
      'line_items[0][price_data][currency]': req.currency.toLowerCase(),
      'line_items[0][price_data][unit_amount]': req.amountMinor,
      'line_items[0][price_data][product_data][name]': req.description.slice(0, 250) || 'Restaurant bill payment',
      'line_items[0][quantity]': 1,
      success_url: req.returnUrl,
      cancel_url: req.cancelUrl,
      expires_at: expires,
      ...(req.customer?.email ? { customer_email: req.customer.email } : {}),
    });
    const s = await providerRequest<any>('stripe', ctx, `${STRIPE_API}/v1/checkout/sessions`, {
      method: 'POST', headers: { ...auth(ctx), 'Content-Type': 'application/x-www-form-urlencoded' }, body, idempotencyKey: `resuto-${req.reference}`,
    });
    if (!s?.id || typeof s.url !== 'string' || !s.url.startsWith('https://checkout.stripe.com/')) {
      throw new ProviderError('stripe', 'Invalid checkout session response', false);
    }
    return { providerSessionId: s.id, redirectUrl: s.url, raw: { id: s.id, expires_at: s.expires_at } };
  },

  lookup(input) {
    const e = safeJson(input.rawBody);
    const s = e?.data?.object;
    if (!s) return null;
    return { providerSessionId: s.id ?? null, reference: s.client_reference_id ?? s.metadata?.resuto_payment_id ?? null };
  },

  verifyWebhook(credentials, input) {
    const secret = credentials.webhookSecret;
    if (!secret) return rejected('webhook secret not configured');
    const sig = parseStripeSignature(header(input.headers, 'stripe-signature') ?? '');
    const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
    if (sig.t === null || !Number.isFinite(sig.t) || !sig.v1.length) return rejected('missing signature');
    if (Math.abs(now - sig.t) > STRIPE_TOLERANCE_SECONDS) return rejected('timestamp outside tolerance');
    const raw = rawText(input.rawBody);
    const expected = hmacHex('sha256', secret, `${sig.t}.${raw}`);
    if (!sig.v1.some((v) => constantTimeEqual(expected, v))) return rejected('signature mismatch');
    const e = safeJson(raw);
    if (!e?.id || !e.type) return rejected('malformed payload');
    return { valid: true, eventKey: e.id, event: sessionEvent(e.type, e.data?.object) };
  },

  parseEvent(payload: any) {
    return sessionEvent(payload?.type, payload?.data?.object);
  },

  async retrieveStatus(ctx, ref) {
    const s = await providerRequest<any>('stripe', ctx, `${STRIPE_API}/v1/checkout/sessions/${encodeURIComponent(ref.providerSessionId)}`, { headers: auth(ctx) });
    if (s.status === 'complete' && s.payment_status === 'paid') return sessionEvent('checkout.session.completed', s);
    if (s.status === 'expired') return sessionEvent('checkout.session.expired', s);
    return { ...sessionEvent('pending', s), kind: 'ignored' };
  },

  async refund(ctx, req) {
    const r = await providerRequest<any>('stripe', ctx, `${STRIPE_API}/v1/refunds`, {
      method: 'POST', headers: { ...auth(ctx), 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form({ payment_intent: req.providerPaymentId, amount: req.amountMinor, 'metadata[reason]': req.reason.slice(0, 450) }),
      idempotencyKey: `resuto-refund-${req.idempotencyKey}`,
    });
    const status = r.status === 'succeeded' ? 'succeeded' : r.status === 'pending' || r.status === 'requires_action' ? 'pending' : 'failed';
    return { status, providerRefundId: r.id ?? null, failureReason: r.failure_reason ?? (status === 'failed' ? r.status : null), raw: { status: r.status } };
  },

  async listTransactions(ctx, range) {
    const out: ProviderTransaction[] = [];
    let after: string | undefined;
    for (let page = 0; page < 50; page++) {
      const q = new URLSearchParams({ limit: '100', 'created[gte]': String(Math.floor(range.from.getTime() / 1000)), 'created[lte]': String(Math.floor(range.to.getTime() / 1000)) });
      q.append('expand[]', 'data.balance_transaction');
      if (after) q.set('starting_after', after);
      const res = await providerRequest<any>('stripe', ctx, `${STRIPE_API}/v1/charges?${q}`, { headers: auth(ctx) });
      for (const c of res.data ?? []) {
        out.push({
          providerPaymentId: typeof c.payment_intent === 'string' ? c.payment_intent : c.id,
          reference: c.metadata?.resuto_payment_id ?? null,
          amountMinor: c.amount, currency: String(c.currency).toUpperCase(),
          status: c.refunded ? 'refunded' : c.amount_refunded > 0 ? 'partially_refunded' : c.status === 'succeeded' ? 'succeeded' : c.status === 'failed' ? 'failed' : 'pending',
          feeMinor: typeof c.balance_transaction === 'object' && c.balance_transaction ? c.balance_transaction.fee : null,
          refundedMinor: c.amount_refunded ?? 0, createdAt: new Date(c.created * 1000).toISOString(),
        });
      }
      if (!res.has_more || !res.data?.length) break;
      after = res.data[res.data.length - 1].id;
    }
    return out;
  },
};
