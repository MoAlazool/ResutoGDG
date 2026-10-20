// Stripe Checkout Sessions adapter. Owner: Agent D1.
//
// Official docs (checked 2026-10-20):
// - API versioning / Stripe-Version header: https://docs.stripe.com/upgrades
// - Create a Checkout Session (expires_at 30 min–24 h, allowed_payment_method_types): https://docs.stripe.com/api/checkout/sessions/create
// - payment_method_types removed from Checkout Sessions in 2026-09-30.endive:
//   https://docs.stripe.com/changelog/endive/2026-09-30/remove-payment-method-types-checkout-sessions
// - Expire a Checkout Session: https://docs.stripe.com/api/checkout/sessions/expire
// - Verify webhook signatures manually: https://docs.stripe.com/webhooks#verify-manually
// - Event object (livemode): https://docs.stripe.com/api/events/object
// - Refunds (create, retrieve, list by payment_intent): https://docs.stripe.com/api/refunds
// - Retrieve account: https://docs.stripe.com/api/accounts/retrieve
// - API keys (sk_test_/sk_live_, rk_ restricted keys): https://docs.stripe.com/keys
// - Availability: https://stripe.com/global (Egypt and Saudi Arabia are not listed as supported business locations).
import { hmacHex, providerRequest, ProviderError, type AdapterContext, type ProviderDescriptor } from '../core';
import { isHexDigest, hexDigestEquals } from './signature';
import {
  header, prefixEnvironment, rawText, redactProviderPayload, rejected, safeJson,
  type PaymentAdapter, type PaymentEvent, type ProviderTransaction, type RefundStatusResult,
} from './types';

export const STRIPE_API = 'https://api.stripe.com';
/** Pinned so responses do not change with the merchant's dashboard default version (INT-19). */
export const STRIPE_API_VERSION = '2026-09-30.endive';
export const STRIPE_TOLERANCE_SECONDS = 300;
const MIN_EXPIRY = 30 * 60;
const MAX_EXPIRY = 24 * 60 * 60;

const KEY_TEST = /^(sk|rk)_test_/;
const KEY_LIVE = /^(sk|rk)_live_/;

export const stripeDescriptor: ProviderDescriptor = {
  id: 'stripe',
  name: 'Stripe',
  category: 'payments',
  // Stripe does not list Egypt or Saudi Arabia as supported business locations (https://stripe.com/global).
  countries: [],
  authType: 'api_key',
  readiness: 'implemented_unverified',
  docsUrl: 'https://docs.stripe.com/payments/checkout',
  activation: [
    'Stripe onboards only businesses in its supported countries (stripe.com/global); Egypt and Saudi Arabia are not listed. Use it only with a Stripe account of an entity in a supported country.',
    'Developers → API keys: copy the secret key (sk_test_… for a TEST connection, sk_live_… for a LIVE one).',
    'Developers → Webhooks → Add endpoint: the webhook URL shown on the connection, with the events listed there.',
    'Copy the endpoint signing secret (whsec_…) into the connection.',
    'Settings → Payment methods: enable cards. Run one test payment end to end before creating the live connection.',
  ],
  capabilities: ['checkout', 'webhooks', 'status_query', 'refunds', 'transaction_listing'],
};

export const stripeCredentialEnvironment = (credentials: Record<string, string>) => prefixEnvironment(credentials.secretKey, KEY_TEST, KEY_LIVE);

const auth = (ctx: AdapterContext) => {
  const key = ctx.credentials.secretKey;
  if (!key) throw new ProviderError('stripe', 'secretKey is not configured', false);
  const env = stripeCredentialEnvironment(ctx.credentials);
  if (!env) throw new ProviderError('stripe', 'Unrecognised Stripe key: expected sk_test_/rk_test_ or sk_live_/rk_live_', false);
  if (env !== ctx.environment) {
    throw new ProviderError('stripe', ctx.environment === 'live' ? 'Live connections need a live key (sk_live_…)' : 'Test connections need a test key (sk_test_…)', false);
  }
  return { Authorization: `Bearer ${key}`, 'Stripe-Version': STRIPE_API_VERSION };
};

/** Parses `t=…,v1=…,v1=…,v0=…`. */
export function parseStripeSignature(value: string) {
  const out: { t: number | null; v1: string[] } = { t: null, v1: [] };
  for (const part of value.split(',')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim(), v = part.slice(i + 1).trim();
    if (k === 't' && /^[0-9]{1,12}$/.test(v)) out.t = Number(v);
    if (k === 'v1' && v) out.v1.push(v);
  }
  return out;
}

/** Signature header for a payload (local tooling only; tests sign with node:crypto directly). */
export const signStripe = (secret: string, rawBody: string, timestamp: number) =>
  `t=${timestamp},v1=${hmacHex('sha256', secret, `${timestamp}.${rawBody}`)}`;

const piOf = (v: any): string | null => (typeof v === 'string' ? v : v?.id ?? null);

function sessionEvent(type: string, s: any, livemode: boolean | null): PaymentEvent {
  const base = {
    providerSessionId: s?.id ?? null,
    providerPaymentId: piOf(s?.payment_intent),
    reference: s?.client_reference_id ?? s?.metadata?.resuto_payment_id ?? null,
    amountMinor: Number(s?.amount_total),
    currency: String(s?.currency ?? '').toUpperCase(),
    feeMinor: null,
    livemode,
  };
  if ((type === 'checkout.session.completed' && s?.payment_status === 'paid') || type === 'checkout.session.async_payment_succeeded') {
    return { kind: 'payment_succeeded', ...base };
  }
  if (type === 'checkout.session.async_payment_failed') return { kind: 'payment_failed', ...base, failureReason: 'async_payment_failed' };
  if (type === 'checkout.session.expired') return { kind: 'payment_expired', ...base, failureReason: 'expired' };
  return { kind: 'ignored', ...base };
}

/** Maps a verified event (signed body) to provider evidence. */
function eventFrom(e: any): PaymentEvent {
  const type = String(e?.type ?? '');
  const o = e?.data?.object;
  const livemode = typeof e?.livemode === 'boolean' ? e.livemode : null;
  if (type.startsWith('checkout.session.')) return sessionEvent(type, o, livemode);
  if (type === 'charge.refunded') {
    return { kind: 'payment_refunded', providerPaymentId: piOf(o?.payment_intent) ?? o?.id ?? null, refundedMinor: Number(o?.amount_refunded ?? 0),
      amountMinor: Number(o?.amount), currency: String(o?.currency ?? '').toUpperCase(), livemode };
  }
  if (type === 'refund.updated' || type === 'refund.created' || type === 'charge.refund.updated') {
    // A refund object: its cumulative effect is read from the payment intent before applying.
    return { kind: 'payment_refunded', providerPaymentId: piOf(o?.payment_intent), providerRefundId: o?.id ?? null, refundedMinor: null,
      currency: String(o?.currency ?? '').toUpperCase(), livemode, needsConfirmation: true };
  }
  if (type === 'charge.dispute.created' || type === 'charge.dispute.closed') {
    return { kind: type.endsWith('created') ? 'dispute_opened' : 'dispute_closed', providerPaymentId: piOf(o?.payment_intent), disputeId: o?.id ?? null,
      disputeStatus: o?.status ?? null, amountMinor: Number(o?.amount), currency: String(o?.currency ?? '').toUpperCase(), livemode };
  }
  return { kind: 'ignored', livemode };
}

const form = (fields: Record<string, string | number | undefined>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(fields)) if (v !== undefined) p.append(k, String(v));
  return p;
};

const field = (key: string, label: string, opts: Partial<import('./types').SetupField> = {}) =>
  ({ key, label, labelKey: `intg.field.stripe.${key}`, secret: true, required: true, kind: 'secret' as const, ...opts });

export const stripeAdapter: PaymentAdapter = {
  descriptor: stripeDescriptor,
  methods: ['card'],
  requiredCredentials: ['secretKey', 'webhookSecret'],
  sessionSurvivesDecline: false, // card declines stay on the Stripe page; async_payment_failed is final for the session
  setup: {
    credentials: [
      field('secretKey', 'Secret key', { pattern: '^(sk|rk)_(test|live)_[A-Za-z0-9]+$', placeholder: 'sk_test_…' }),
      field('webhookSecret', 'Webhook signing secret', { pattern: '^whsec_[A-Za-z0-9]+$', placeholder: 'whsec_…' }),
    ],
    config: [],
    webhookEvents: [
      'checkout.session.completed', 'checkout.session.async_payment_succeeded', 'checkout.session.async_payment_failed', 'checkout.session.expired',
      'charge.refunded', 'refund.updated', 'charge.dispute.created', 'charge.dispute.closed',
    ],
    webhookRegisteredByMerchant: true,
    restrictedCountries: [
      { country: 'EG', reason: 'Stripe does not list Egypt as a supported business location.', source: 'https://stripe.com/global' },
      { country: 'SA', reason: 'Stripe does not list Saudi Arabia as a supported business location.', source: 'https://stripe.com/global' },
    ],
    capabilities: {
      checkout: { implemented: true, note: `Checkout Sessions, Stripe-Version ${STRIPE_API_VERSION}.` },
      webhooks: { implemented: true, note: 'v1 HMAC-SHA256 with 300 s tolerance; event.livemode must match the connection.' },
      status_query: { implemented: true },
      refunds: { implemented: true, note: 'Idempotency-Key stable per intended refund.' },
      refund_status: { implemented: true, note: 'Refund retrieve / list by payment_intent.' },
      cancel_checkout: { implemented: true, note: 'POST /v1/checkout/sessions/:id/expire.' },
      transaction_listing: { implemented: true },
      health_check: { implemented: true, note: 'GET /v1/account.' },
    },
    docs: {
      webhooks: 'https://docs.stripe.com/webhooks#verify-manually',
      checkout: 'https://docs.stripe.com/api/checkout/sessions/create',
      availability: 'https://stripe.com/global',
    },
  },

  credentialEnvironment: stripeCredentialEnvironment,

  async createCheckout(ctx, req) {
    const seconds = Math.min(Math.max(req.expiresInSeconds, MIN_EXPIRY), MAX_EXPIRY - 60);
    const body = form({
      mode: 'payment',
      'allowed_payment_method_types[0]': 'card',
      client_reference_id: req.reference,
      'metadata[resuto_payment_id]': req.reference,
      'payment_intent_data[metadata][resuto_payment_id]': req.reference,
      'line_items[0][price_data][currency]': req.currency.toLowerCase(),
      'line_items[0][price_data][unit_amount]': req.amountMinor,
      'line_items[0][price_data][product_data][name]': req.description.slice(0, 250) || 'Restaurant bill payment',
      'line_items[0][quantity]': 1,
      success_url: req.returnUrl,
      cancel_url: req.cancelUrl,
      expires_at: Math.floor(Date.now() / 1000) + seconds,
      ...(req.customer?.email ? { customer_email: req.customer.email } : {}),
    });
    const s = await providerRequest<any>('stripe', ctx, `${STRIPE_API}/v1/checkout/sessions`, {
      method: 'POST', headers: { ...auth(ctx), 'Content-Type': 'application/x-www-form-urlencoded' }, body, idempotencyKey: `resuto-${req.reference}`,
    });
    if (!s?.id || typeof s.url !== 'string' || !s.url.startsWith('https://checkout.stripe.com/')) {
      throw new ProviderError('stripe', 'Invalid checkout session response', false);
    }
    if (typeof s.livemode === 'boolean' && s.livemode !== (ctx.environment === 'live')) throw new ProviderError('stripe', 'Checkout session environment does not match the connection', false);
    return { providerSessionId: s.id, redirectUrl: s.url, raw: { id: s.id, expires_at: s.expires_at } };
  },

  lookup(input) {
    const e = safeJson(input.rawBody);
    const s = e?.data?.object;
    if (!s) return null;
    if (String(e?.type ?? '').startsWith('checkout.session.')) {
      return { providerSessionId: s.id ?? null, reference: s.client_reference_id ?? s.metadata?.resuto_payment_id ?? null };
    }
    return { providerPaymentId: piOf(s.payment_intent) };
  },

  verifyWebhook(credentials, input) {
    const secret = credentials.webhookSecret;
    if (!secret) return rejected('webhook secret not configured');
    const sig = parseStripeSignature(header(input.headers, 'stripe-signature') ?? '');
    const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
    if (sig.t === null || !sig.v1.length) return rejected('missing signature');
    if (!sig.v1.some((v) => isHexDigest(v, 32))) return rejected('malformed signature');
    if (Math.abs(now - sig.t) > STRIPE_TOLERANCE_SECONDS) return rejected('timestamp outside tolerance');
    const raw = rawText(input.rawBody);
    const expected = hmacHex('sha256', secret, `${sig.t}.${raw}`);
    if (!sig.v1.some((v) => hexDigestEquals(expected, v, 32))) return rejected('signature mismatch');
    const e = safeJson(raw);
    if (!e?.id || !e.type || typeof e.livemode !== 'boolean') return rejected('malformed payload');
    return { valid: true, eventKey: e.id, event: eventFrom(e) };
  },

  parseEvent(payload: any) {
    return eventFrom(payload);
  },

  /** Refund objects report one refund; the cumulative refunded amount comes from the payment intent's charge. */
  async confirmEvent(ctx, ev) {
    if (ev.kind !== 'payment_refunded' || !ev.providerPaymentId) return { ...ev, needsConfirmation: false };
    const pi = await providerRequest<any>('stripe', ctx, `${STRIPE_API}/v1/payment_intents/${encodeURIComponent(ev.providerPaymentId)}?expand[]=latest_charge`, { headers: auth(ctx) });
    if (typeof pi?.livemode === 'boolean' && pi.livemode !== (ctx.environment === 'live')) throw new ProviderError('stripe', 'Payment intent environment does not match the connection', false);
    const charge = typeof pi?.latest_charge === 'object' ? pi.latest_charge : null;
    return { ...ev, refundedMinor: Number(charge?.amount_refunded ?? 0), amountMinor: Number(pi?.amount), currency: String(pi?.currency ?? ev.currency ?? '').toUpperCase(),
      livemode: typeof pi?.livemode === 'boolean' ? pi.livemode : ev.livemode, needsConfirmation: false };
  },

  async retrieveStatus(ctx, ref) {
    const s = await providerRequest<any>('stripe', ctx, `${STRIPE_API}/v1/checkout/sessions/${encodeURIComponent(ref.providerSessionId)}`, { headers: auth(ctx) });
    const livemode = typeof s?.livemode === 'boolean' ? s.livemode : null;
    if (s.status === 'complete' && s.payment_status === 'paid') return sessionEvent('checkout.session.completed', s, livemode);
    if (s.status === 'expired') return sessionEvent('checkout.session.expired', s, livemode);
    return { ...sessionEvent('pending', s, livemode), kind: 'ignored' };
  },

  async cancelCheckout(ctx, ref) {
    try {
      await providerRequest<any>('stripe', ctx, `${STRIPE_API}/v1/checkout/sessions/${encodeURIComponent(ref.providerSessionId)}/expire`, {
        method: 'POST', headers: auth(ctx), retries: 1,
      });
      return 'cancelled';
    } catch (e) {
      // Only `open` sessions can be expired: a 400 means it completed (or already expired) — the caller re-checks the status.
      if (e instanceof ProviderError && e.status === 400) return 'already_completed';
      throw e;
    }
  },

  async refund(ctx, req) {
    const r = await providerRequest<any>('stripe', ctx, `${STRIPE_API}/v1/refunds`, {
      method: 'POST', headers: { ...auth(ctx), 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form({ payment_intent: req.providerPaymentId, amount: req.amountMinor, 'metadata[reason]': req.reason.slice(0, 450), 'metadata[resuto_refund_key]': req.idempotencyKey }),
      idempotencyKey: `resuto-refund-${req.idempotencyKey}`,
    });
    const status = r.status === 'succeeded' ? 'succeeded' : r.status === 'pending' || r.status === 'requires_action' ? 'pending' : 'failed';
    return { status, providerRefundId: r.id ?? null, failureReason: r.failure_reason ?? (status === 'failed' ? String(r.status ?? 'failed') : null), raw: { status: r.status } };
  },

  async refundStatus(ctx, req): Promise<RefundStatusResult> {
    const map = (r: any): RefundStatusResult => ({
      status: r.status === 'succeeded' ? 'succeeded' : r.status === 'pending' || r.status === 'requires_action' ? 'pending' : r.status === 'failed' || r.status === 'canceled' ? 'failed' : 'unknown',
      providerRefundId: r.id ?? null, failureReason: r.failure_reason ?? null,
    });
    if (req.providerRefundId) {
      return map(await providerRequest<any>('stripe', ctx, `${STRIPE_API}/v1/refunds/${encodeURIComponent(req.providerRefundId)}`, { headers: auth(ctx) }));
    }
    const list = await providerRequest<any>('stripe', ctx, `${STRIPE_API}/v1/refunds?${new URLSearchParams({ payment_intent: req.providerPaymentId, limit: '100' })}`, { headers: auth(ctx) });
    const mine = (list?.data ?? []).find((r: any) => r?.metadata?.resuto_refund_key === req.idempotencyKey);
    return mine ? map(mine) : { status: 'not_found' };
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

  async healthCheck(ctx) {
    const a = await providerRequest<any>('stripe', ctx, `${STRIPE_API}/v1/account`, { headers: auth(ctx) });
    if (!ctx.credentials.webhookSecret?.startsWith('whsec_')) throw new ProviderError('stripe', 'webhookSecret must be the endpoint signing secret (whsec_…)', false);
    return {
      ok: a?.charges_enabled !== false,
      environment: stripeCredentialEnvironment(ctx.credentials),
      account: { id: a?.id ?? null, name: a?.settings?.dashboard?.display_name ?? a?.business_profile?.name ?? null, country: a?.country ?? null, currency: a?.default_currency ? String(a.default_currency).toUpperCase() : null },
      details: { chargesEnabled: a?.charges_enabled ?? null, apiVersion: STRIPE_API_VERSION },
    };
  },

  redactPayload: (body) => redactProviderPayload(body),
};
