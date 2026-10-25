// Moyasar (Saudi Arabia) adapter: hosted invoices, webhooks, refunds. Owner: Agent D1.
//
// Official docs (checked 2026-10-20):
// - Webhook reference (fields id, type, created_at, secret_token, account_name, live, data; events incl. the
//   documented spelling "payment_faild"): https://docs.moyasar.com/api/other/webhooks/webhook-reference
// - Available webhooks (API spells "payment_failed"): https://docs.moyasar.com/api/other/webhooks/available-webhooks
// - Fetch payment: https://docs.moyasar.com/api/payments/02-fetch-payment
// - Create invoice (amount ≥ 100; callback_url gets an unsigned POST "when the invoice is paid"):
//   https://docs.moyasar.com/api/invoices/01-create-invoice
// - Cancel invoice (PUT /invoices/:id/cancel): https://docs.moyasar.com/api/invoices/06-cancel-invoice
// - Payment operations (capture, void, refund; check GET /payments/:id after a failed refund):
//   https://docs.moyasar.com/docs/guides/payment-operations/index.md
// - API keys (sk_test_/sk_live_): https://docs.moyasar.com/docs/api/authentication.md
//
// Security (PAY-04): Moyasar authenticates webhooks only with the static
// secret_token in the body — no signature, no timestamp. The token is checked
// (constant time), then the payment is FETCHED with the merchant's secret key
// and only that server answer is applied. The token is never stored.
import { providerRequest, ProviderError, type AdapterContext, type ProviderDescriptor } from '../core';
import { secretEquals } from './signature';
import {
  prefixEnvironment, redactProviderPayload, rejected, safeJson,
  type PaymentAdapter, type PaymentEvent, type ProviderTransaction, type RefundStatusResult, type SetupField,
} from './types';

export const MOYASAR_API = 'https://api.moyasar.com/v1';
/** Smallest invoice amount (minor units) per the create-invoice reference. */
export const MOYASAR_MIN_AMOUNT = 100;

/** Event names as Moyasar documents them (the reference spells the failure event "payment_faild"; the API "payment_failed"). */
export const MOYASAR_EVENTS = {
  paid: ['payment_paid'],
  failed: ['payment_failed', 'payment_faild'],
  captured: ['payment_captured'],
  authorized: ['payment_authorized'],
  refunded: ['payment_refunded'],
  voided: ['payment_voided'],
  // Documented on available-webhooks; they never change a Resuto payment but are confirmed like the rest.
  other: ['payment_verified', 'payment_abandoned'],
} as const;
const KNOWN_EVENTS = new Set<string>(Object.values(MOYASAR_EVENTS).flat());

export const moyasarDescriptor: ProviderDescriptor = {
  id: 'moyasar',
  name: 'Moyasar',
  category: 'payments',
  countries: ['SA'],
  authType: 'api_key',
  connectMethod: 'api_key',
  readiness: 'implemented_unverified',
  docsUrl: 'https://docs.moyasar.com',
  activation: [
    'Use the restaurant\'s own Moyasar account (Resuto never holds funds). Create the connection in TEST mode first.',
    'Dashboard → Settings → API keys: copy the secret key (sk_test_… for a TEST connection, sk_live_… for a LIVE one).',
    'Dashboard → Settings → Webhooks: add the webhook URL shown on the connection (HTTP method POST) for the events listed there, choose a secret token and enter the same token here.',
    'Enable the methods (mada, Visa/Mastercard, Apple Pay, STC Pay) on the account; run one test payment end to end before creating the live connection.',
  ],
  capabilities: ['checkout', 'webhooks', 'status_query', 'refunds', 'transaction_listing'],
};

export const moyasarCredentialEnvironment = (credentials: Record<string, string>) => prefixEnvironment(credentials.secretKey, /^sk_test_/, /^sk_live_/);

const auth = (ctx: AdapterContext) => {
  const key = ctx.credentials.secretKey;
  if (!key) throw new ProviderError('moyasar', 'secretKey is not configured', false);
  const env = moyasarCredentialEnvironment(ctx.credentials);
  if (!env) throw new ProviderError('moyasar', 'Unrecognised Moyasar key: expected sk_test_… or sk_live_…', false);
  if (env !== ctx.environment) {
    throw new ProviderError('moyasar', ctx.environment === 'live' ? 'Live connections need a live key (sk_live_…)' : 'Test connections need a test key (sk_test_…)', false);
  }
  return { Authorization: `Basic ${Buffer.from(`${key}:`).toString('base64')}` };
};

/** Event from a payment object FETCHED with the merchant key (authoritative). */
function paymentEvent(p: any, livemode: boolean | null): PaymentEvent {
  const ids = {
    providerSessionId: p?.invoice_id ?? null,
    providerPaymentId: p?.id ?? null,
    reference: p?.metadata?.resuto_payment_id ?? null,
    amountMinor: Number(p?.amount),
    currency: String(p?.currency ?? '').toUpperCase(),
    feeMinor: typeof p?.fee === 'number' ? p.fee : null,
    livemode,
  };
  switch (p?.status) {
    case 'paid': return { kind: 'payment_succeeded', ...ids };
    // A captured auth settles the captured amount.
    case 'captured': return { kind: 'payment_succeeded', ...ids, amountMinor: Number(p?.captured ?? p?.amount) };
    case 'authorized': return { kind: 'payment_authorized', ...ids };
    case 'failed': return { kind: 'payment_failed', ...ids, failureReason: 'declined', providerMessage: typeof p?.source?.message === 'string' ? p.source.message.slice(0, 200) : null };
    // "refunded" covers partial refunds too: the payment was charged first ("paid" → amount, "captured" → captured).
    case 'refunded': return { kind: 'payment_refunded', ...ids, refundedMinor: Number(p?.refunded ?? 0), capturedMinor: Number(p?.captured) > 0 ? Number(p.captured) : Number(p?.amount) };
    case 'voided': return { kind: 'payment_voided', ...ids, refundedMinor: Number(p?.amount ?? 0) };
    default: return { kind: 'ignored', ...ids };
  }
}

/** Unconfirmed hint from a webhook body (applied only after confirmEvent). */
function hintEvent(body: any): PaymentEvent {
  const d = body?.data ?? {};
  return {
    kind: 'ignored', needsConfirmation: KNOWN_EVENTS.has(String(body?.type)),
    providerPaymentId: typeof d.id === 'string' ? d.id : null, providerSessionId: typeof d.invoice_id === 'string' ? d.invoice_id : null,
    livemode: typeof body?.live === 'boolean' ? body.live : null,
    accountName: typeof body?.account_name === 'string' ? body.account_name.slice(0, 120) : null,
  };
}

/** Moyasar's hosted invoice page. The documented sample is `http://checkout.moyasar.com/invoices/<id>?lang=en`: only that host is accepted, upgraded to https. */
export const MOYASAR_CHECKOUT_HOST = 'checkout.moyasar.com';
function invoicePageUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const u = new URL(value);
    if (u.hostname !== MOYASAR_CHECKOUT_HOST || !['https:', 'http:'].includes(u.protocol)) return null;
    u.protocol = 'https:';
    return u.toString();
  } catch {
    return null;
  }
}

const field = (key: string, label: string, opts: Partial<SetupField> = {}): SetupField =>
  ({ key, label, labelKey: `intg.field.moyasar.${key}`, secret: true, required: true, kind: 'secret', ...opts });

export const moyasarAdapter: PaymentAdapter = {
  descriptor: moyasarDescriptor,
  methods: ['card', 'wallet'],
  requiredCredentials: ['secretKey', 'webhookSecret'],
  sessionSurvivesDecline: true, // an invoice accepts another payment attempt after a decline
  setup: {
    credentials: [
      field('secretKey', 'Secret key', { pattern: '^sk_(test|live)_[A-Za-z0-9]+$', placeholder: 'sk_test_…' }),
      field('webhookSecret', 'Webhook secret token', { hintKey: 'intg.hint.moyasar.webhookSecret' }),
    ],
    config: [],
    // As listed on https://docs.moyasar.com/api/other/webhooks/available-webhooks (the failure event is "payment_failed" there).
    webhookEvents: ['payment_paid', 'payment_failed', 'payment_captured', 'payment_authorized', 'payment_refunded', 'payment_voided'],
    webhookRegisteredByMerchant: true,
    capabilities: {
      checkout: { implemented: true, note: 'Hosted invoices (minimum 100 halalas).' },
      webhooks: { implemented: true, note: 'secret_token checked, then the payment is fetched with the secret key; only the fetched payment is applied.' },
      status_query: { implemented: true, note: 'GET /invoices/:id.' },
      refunds: { implemented: true, note: 'No idempotency key: uncertain results are resolved by GET /payments/:id before any retry.' },
      refund_status: { implemented: true },
      cancel_checkout: { implemented: true, note: 'PUT /invoices/:id/cancel.' },
      transaction_listing: { implemented: true },
      health_check: { implemented: true, note: 'GET /payments?page=1 (no account endpoint; the account name is taken from webhooks).' },
    },
    docs: {
      webhooks: 'https://docs.moyasar.com/api/other/webhooks/webhook-reference',
      invoices: 'https://docs.moyasar.com/api/invoices/01-create-invoice',
      payments: 'https://docs.moyasar.com/api/payments/02-fetch-payment',
    },
  },

  credentialEnvironment: moyasarCredentialEnvironment,

  async createCheckout(ctx, req) {
    if (req.amountMinor < MOYASAR_MIN_AMOUNT) throw new ProviderError('moyasar', `Moyasar invoices must be at least ${MOYASAR_MIN_AMOUNT} minor units`, false);
    const inv = await providerRequest<any>('moyasar', ctx, `${MOYASAR_API}/invoices`, {
      method: 'POST', headers: { ...auth(ctx), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        amount: req.amountMinor,
        currency: req.currency,
        description: req.description.slice(0, 250) || 'Restaurant bill payment',
        // callback_url receives an UNSIGNED invoice POST: it is only a nudge to re-check with the API (never the webhook endpoint).
        ...(req.nudgeUrl ? { callback_url: req.nudgeUrl } : {}),
        success_url: req.returnUrl,
        back_url: req.cancelUrl,
        expired_at: new Date(Date.now() + req.expiresInSeconds * 1000).toISOString(),
        metadata: { resuto_payment_id: req.reference },
      }),
      retries: 0,
    });
    const url = invoicePageUrl(inv?.url);
    if (!inv?.id || !url) throw new ProviderError('moyasar', 'Invalid invoice response', false);
    return { providerSessionId: inv.id, redirectUrl: url, raw: { status: inv.status } };
  },

  lookup(input) {
    const p = safeJson(input.rawBody)?.data;
    if (!p) return null;
    return { providerSessionId: p.invoice_id ?? null, providerPaymentId: p.id ?? null, reference: null };
  },

  /** Only proves the sender knows the shared token; the event is a hint until confirmEvent() fetched the payment. */
  verifyWebhook(credentials, input) {
    const secret = credentials.webhookSecret;
    if (!secret) return rejected('webhook secret not configured');
    const body = safeJson(input.rawBody);
    if (!body || typeof body !== 'object' || typeof body.id !== 'string' || typeof body.type !== 'string' || !body.data || typeof body.data !== 'object') {
      return rejected('malformed payload');
    }
    if (!secretEquals(secret, body.secret_token)) return rejected('signature mismatch');
    // The token authenticates the whole body equally; only the event id, the payment that will be FETCHED and the
    // live flag (checked before the fetch) decide what happens, so they are the dedupe key. A variant of a known
    // event that names another payment or environment can never pre-empt the genuine delivery's key.
    return { valid: true, eventKey: `${body.id}:${typeof body.data.id === 'string' ? body.data.id : ''}:${String(body.live ?? '')}`, event: hintEvent(body) };
  },

  parseEvent(payload: any) {
    return hintEvent(payload);
  },

  /** The authoritative read: GET /payments/:id with the merchant's secret key (the key's mode binds the environment). */
  async confirmEvent(ctx, ev) {
    if (!ev.providerPaymentId) return { kind: 'ignored', needsConfirmation: false };
    if (ev.livemode !== null && ev.livemode !== undefined && ev.livemode !== (ctx.environment === 'live')) {
      throw new ProviderError('moyasar', `Webhook says ${ev.livemode ? 'live' : 'test'} but the connection is ${ctx.environment === 'live' ? 'live' : 'test'}`, false);
    }
    const p = await providerRequest<any>('moyasar', ctx, `${MOYASAR_API}/payments/${encodeURIComponent(ev.providerPaymentId)}`, { headers: auth(ctx) })
      .catch((e: ProviderError) => { if (e.status === 404) return null; throw e; });
    if (!p) return { kind: 'ignored', providerPaymentId: ev.providerPaymentId, needsConfirmation: false };
    return { ...paymentEvent(p, ctx.environment === 'live'), accountName: ev.accountName ?? null, needsConfirmation: false };
  },

  async retrieveStatus(ctx, ref) {
    const inv = await providerRequest<any>('moyasar', ctx, `${MOYASAR_API}/invoices/${encodeURIComponent(ref.providerSessionId)}`, { headers: auth(ctx) });
    const live = ctx.environment === 'live';
    const payments: any[] = inv.payments ?? [];
    // A payment refunded (partly or fully) before Resuto saw it settle is still proof of the charge (review F5).
    const settled = payments.find((p) => p.status === 'paid' || p.status === 'captured') ?? payments.find((p) => p.status === 'refunded');
    if (settled) return paymentEvent({ ...settled, invoice_id: inv.id, metadata: settled.metadata ?? inv.metadata }, live);
    const held = payments.find((p) => p.status === 'authorized');
    if (held) return paymentEvent({ ...held, invoice_id: inv.id, metadata: held.metadata ?? inv.metadata }, live);
    if (inv.status === 'expired' || inv.status === 'canceled') {
      return { kind: 'payment_expired', providerSessionId: inv.id, amountMinor: inv.amount, currency: String(inv.currency).toUpperCase(), livemode: live, failureReason: 'expired' };
    }
    return { kind: 'ignored', providerSessionId: inv.id };
  },

  /** PUT /invoices/:id/cancel (documented). Which statuses are cancellable is not documented: any refusal is re-checked by the caller. */
  async cancelCheckout(ctx, ref) {
    try {
      await providerRequest<any>('moyasar', ctx, `${MOYASAR_API}/invoices/${encodeURIComponent(ref.providerSessionId)}/cancel`, { method: 'PUT', headers: auth(ctx), retries: 1 });
      return 'cancelled';
    } catch (e) {
      // A paid (or already final) invoice cannot be cancelled: the caller re-checks its status (sandbox-verify the exact status code, B-3).
      if (e instanceof ProviderError && (e.status === 400 || e.status === 409 || e.status === 422)) return 'already_completed';
      throw e;
    }
  },

  async refund(ctx, req) {
    const p = await providerRequest<any>('moyasar', ctx, `${MOYASAR_API}/payments/${encodeURIComponent(req.providerPaymentId)}/refund`, {
      method: 'POST', headers: { ...auth(ctx), 'Content-Type': 'application/json' }, body: JSON.stringify({ amount: req.amountMinor }), retries: 0,
    });
    const refunded = Number(p?.refunded ?? 0);
    if (refunded >= (req.ledgerRefundedMinor ?? 0) + req.amountMinor) return { status: 'succeeded', providerRefundId: `${p.id}:${refunded}` };
    return { status: 'failed', providerRefundId: null, failureReason: 'refund_not_applied', raw: { providerMessage: String(p?.message ?? p?.status ?? '').slice(0, 200) } };
  },

  async refundStatus(ctx, req): Promise<RefundStatusResult> {
    const p = await providerRequest<any>('moyasar', ctx, `${MOYASAR_API}/payments/${encodeURIComponent(req.providerPaymentId)}`, { headers: auth(ctx) });
    const refunded = Number(p?.refunded ?? 0);
    const before = req.ledgerRefundedMinor ?? 0;
    if (refunded >= before + req.amountMinor) return { status: 'succeeded', providerRefundId: `${p.id}:${refunded}`, providerRefundedMinor: refunded };
    if (refunded <= before) return { status: 'not_found', providerRefundedMinor: refunded };
    return { status: 'unknown', providerRefundedMinor: refunded, failureReason: 'partial_refund_total_does_not_match' };
  },

  async listTransactions(ctx, range) {
    const out: ProviderTransaction[] = [];
    for (let page = 1; page <= 50; page++) {
      const res = await providerRequest<any>('moyasar', ctx, `${MOYASAR_API}/payments?page=${page}`, { headers: auth(ctx) });
      const items: any[] = res.payments ?? [];
      for (const p of items) {
        const created = new Date(p.created_at);
        if (created < range.from || created > range.to) continue;
        out.push({
          providerPaymentId: p.id, providerSessionId: p.invoice_id ?? null, reference: p.metadata?.resuto_payment_id ?? null,
          amountMinor: p.amount, currency: String(p.currency).toUpperCase(),
          status: p.status === 'refunded' ? (p.refunded >= p.amount ? 'refunded' : 'partially_refunded') : p.status === 'voided' ? 'refunded'
            : p.status === 'paid' || p.status === 'captured' ? (p.refunded > 0 ? 'partially_refunded' : 'succeeded') : p.status === 'failed' ? 'failed' : 'pending',
          feeMinor: typeof p.fee === 'number' ? p.fee : null, refundedMinor: p.status === 'voided' ? p.amount : p.refunded ?? 0, createdAt: created.toISOString(),
        });
      }
      const oldest = items.at(-1);
      if (!res.meta?.next_page || !items.length || (oldest && new Date(oldest.created_at) < range.from)) break;
    }
    return out;
  },

  async healthCheck(ctx) {
    await providerRequest<any>('moyasar', ctx, `${MOYASAR_API}/payments?page=1`, { headers: auth(ctx) });
    if (!ctx.credentials.webhookSecret) throw new ProviderError('moyasar', 'webhookSecret is not configured', false);
    return { ok: true, environment: moyasarCredentialEnvironment(ctx.credentials), account: null, details: { checks: ['secret_key', 'key_mode'] } };
  },

  /** Never keeps the shared secret_token (INT-10). */
  redactPayload(body) {
    if (!body || typeof body !== 'object') return body;
    const { secret_token: _drop, ...rest } = body as Record<string, unknown>;
    return redactProviderPayload(rest);
  },
};
