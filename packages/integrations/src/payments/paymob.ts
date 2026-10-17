// Paymob (Egypt / KSA) adapter: Intention API + Unified Checkout, HMAC-SHA512
// transaction callbacks, refunds. Owner: Agent D1.
// Docs: https://developers.paymob.com/egypt/checkout-api/create-intention,
// https://developers.paymob.com/egypt/manage-callback/hmac-calculation,
// https://developers.paymob.com/egypt/refund-void
import { constantTimeEqual, hmacHex, providerRequest, ProviderError, type AdapterContext, type ProviderDescriptor } from '../core';
import { rejected, safeJson, type PaymentAdapter, type PaymentEvent, type ProviderTransaction, type WebhookInput } from './types';

export const PAYMOB_BASES = ['https://accept.paymob.com', 'https://ksa.paymob.com', 'https://uae.paymob.com', 'https://oman.paymob.com'] as const;

/** The 20 documented fields of the transaction-processed callback, in HMAC order (lexicographic). */
export const PAYMOB_HMAC_FIELDS = [
  'amount_cents', 'created_at', 'currency', 'error_occured', 'has_parent_transaction', 'id', 'integration_id', 'is_3d_secure',
  'is_auth', 'is_capture', 'is_refunded', 'is_standalone_payment', 'is_voided', 'order.id', 'owner', 'pending',
  'source_data.pan', 'source_data.sub_type', 'source_data.type', 'success',
] as const;

export const paymobDescriptor: ProviderDescriptor = {
  id: 'paymob',
  name: 'Paymob',
  category: 'payments',
  countries: ['EG', 'SA'],
  authType: 'api_key',
  readiness: 'implemented_unverified',
  docsUrl: 'https://developers.paymob.com/egypt/checkout-api',
  activation: [
    'Use the restaurant\'s own Paymob merchant account (Resuto never holds funds); test mode for sandbox connections.',
    'Dashboard → Settings → Account info: copy Secret key → "secretKey", Public key → "publicKey", HMAC secret → "hmacSecret", API key → "apiKey" (optional; enables status queries and transaction listing).',
    'Dashboard → Developers → Payment integrations: copy the online card integration id → config "integrationIdCard" and (optional) mobile wallet integration id → config "integrationIdWallet".',
    'Set the integration\'s Transaction processed callback to <API_ORIGIN>/v1/webhooks/payments/paymob?c=<connectionId> (Resuto also sends it per intention as notification_url).',
    'KSA accounts: set config "baseUrl" to https://ksa.paymob.com.',
    'Run one test-mode card payment end to end, then request live activation from Paymob and switch the connection to live.',
  ],
  capabilities: ['checkout', 'webhooks', 'status_query', 'refunds', 'transaction_listing'],
};

const base = (ctx: AdapterContext) => {
  const b = String(ctx.config.baseUrl ?? 'https://accept.paymob.com').replace(/\/$/, '');
  if (!(PAYMOB_BASES as readonly string[]).includes(b)) throw new ProviderError('paymob', 'Invalid Paymob region (baseUrl)', false);
  return b;
};

const secretAuth = (ctx: AdapterContext) => {
  if (!ctx.credentials.secretKey) throw new ProviderError('paymob', 'secretKey is not configured', false);
  return { Authorization: `Token ${ctx.credentials.secretKey}` };
};

/** Concatenation of the 20 callback fields, exactly as Paymob computes it. */
export function paymobHmacPayload(obj: any): string {
  return PAYMOB_HMAC_FIELDS.map((path) => path.split('.').reduce((v: any, k) => v?.[k], obj)).map((v) => String(v)).join('');
}
export const paymobHmac = (secret: string, obj: any) => hmacHex('sha512', secret, paymobHmacPayload(obj));

function integrationIds(config: Record<string, unknown>) {
  return [config.integrationIdCard, config.integrationIdWallet].filter((v) => v !== undefined && v !== null && v !== '').map(String);
}

function txnEvent(obj: any, config: Record<string, unknown>): PaymentEvent {
  const ids = {
    providerSessionId: obj?.order?.id !== undefined ? String(obj.order.id) : null,
    providerPaymentId: obj?.id !== undefined ? String(obj.id) : null,
    reference: obj?.order?.merchant_order_id ?? obj?.special_reference ?? null,
    amountMinor: Number(obj?.amount_cents),
    currency: String(obj?.currency ?? '').toUpperCase(),
    feeMinor: null,
  };
  const known = integrationIds(config);
  if (known.length && !known.includes(String(obj?.integration_id))) return { kind: 'ignored', ...ids, failureReason: 'unknown_integration' };
  // Refund/void/auth-only notifications never settle a payment (refunds are applied by Resuto after its own refund call).
  if (obj?.is_refunded || obj?.is_voided || obj?.is_auth || obj?.has_parent_transaction) return { kind: 'ignored', ...ids };
  if (obj?.success === true && obj?.pending === false) return { kind: 'payment_succeeded', ...ids };
  if (obj?.success === false && obj?.pending === false) {
    return { kind: 'payment_failed', ...ids, failureReason: String(obj?.data?.message ?? obj?.txn_response_code ?? 'declined').slice(0, 200) };
  }
  return { kind: 'ignored', ...ids };
}

async function authToken(ctx: AdapterContext): Promise<string | null> {
  if (!ctx.credentials.apiKey) return null;
  const r = await providerRequest<{ token: string }>('paymob', ctx, `${base(ctx)}/api/auth/tokens`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ api_key: ctx.credentials.apiKey }),
  });
  return r.token ?? null;
}

const splitName = (name?: string | null) => {
  const parts = (name ?? '').trim().split(/\s+/).filter(Boolean);
  return { first: parts[0] ?? 'Guest', last: parts.slice(1).join(' ') || 'Guest' };
};

export const paymobAdapter: PaymentAdapter = {
  descriptor: paymobDescriptor,
  methods: ['card', 'wallet'],
  requiredCredentials: ['secretKey', 'publicKey', 'hmacSecret'],

  async createCheckout(ctx, req) {
    const integration = req.method === 'wallet' ? ctx.config.integrationIdWallet : ctx.config.integrationIdCard;
    if (!integration) throw new ProviderError('paymob', `No Paymob integration id configured for ${req.method}`, false);
    if (!ctx.credentials.publicKey) throw new ProviderError('paymob', 'publicKey is not configured', false);
    const name = splitName(req.customer?.name);
    const result = await providerRequest<any>('paymob', ctx, `${base(ctx)}/v1/intention/`, {
      method: 'POST', headers: { ...secretAuth(ctx), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        amount: req.amountMinor,
        currency: req.currency,
        payment_methods: [Number(integration)],
        items: [{ name: req.description.slice(0, 50) || 'Restaurant bill payment', amount: req.amountMinor, quantity: 1 }],
        billing_data: {
          first_name: name.first, last_name: name.last, email: req.customer?.email || 'guest@resuto.invalid',
          phone_number: req.customer?.phone || '+200000000000', apartment: 'NA', floor: 'NA', street: 'NA', building: 'NA',
          city: 'NA', state: 'NA', country: req.currency === 'SAR' ? 'SAU' : 'EGY',
        },
        special_reference: req.reference,
        expiration: req.expiresInSeconds,
        notification_url: req.notificationUrl,
        redirection_url: req.returnUrl,
        extras: { resuto_payment_id: req.reference },
      }),
      retries: 0, // intention creation is not idempotent on Paymob's side; never blindly retry
    });
    if (!result?.client_secret || !result?.intention_order_id) throw new ProviderError('paymob', 'Invalid intention response', false);
    const url = `${base(ctx)}/unifiedcheckout/?${new URLSearchParams({ publicKey: ctx.credentials.publicKey, clientSecret: result.client_secret })}`;
    return { providerSessionId: String(result.intention_order_id), redirectUrl: url, raw: { intentionId: result.id } };
  },

  lookup(input: WebhookInput) {
    const obj = safeJson(input.rawBody)?.obj;
    if (!obj) return null;
    return { providerSessionId: obj.order?.id !== undefined ? String(obj.order.id) : null, providerPaymentId: obj.id !== undefined ? String(obj.id) : null, reference: obj.order?.merchant_order_id ?? null };
  },

  verifyWebhook(credentials, input, config = {}) {
    const secret = credentials.hmacSecret;
    if (!secret) return rejected('hmac secret not configured');
    const body = safeJson(input.rawBody);
    const obj = body?.obj;
    if (!obj || !obj.order || !obj.source_data) return rejected('malformed payload');
    const given = input.query.hmac ?? '';
    if (!given || !constantTimeEqual(paymobHmac(secret, obj), given)) return rejected('signature mismatch');
    const eventKey = `txn:${obj.id}:${obj.success}:${obj.pending}:${obj.is_refunded}:${obj.is_voided}`;
    return { valid: true, eventKey, event: txnEvent(obj, config) };
  },

  parseEvent(payload: any, config = {}) {
    return txnEvent(payload?.obj, config);
  },

  async retrieveStatus(ctx, ref) {
    const token = await authToken(ctx);
    if (!token) return { kind: 'ignored', providerSessionId: ref.providerSessionId, failureReason: 'status_query_requires_api_key' };
    const txn = await providerRequest<any>('paymob', ctx, `${base(ctx)}/api/ecommerce/orders/transaction_inquiry`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ order_id: ref.providerSessionId }),
    }).catch((e: ProviderError) => { if (e.status === 404) return null; throw e; });
    if (!txn) return { kind: 'ignored', providerSessionId: ref.providerSessionId };
    return txnEvent(txn, ctx.config);
  },

  async refund(ctx, req) {
    const r = await providerRequest<any>('paymob', ctx, `${base(ctx)}/api/acceptance/void_refund/refund`, {
      method: 'POST', headers: { ...secretAuth(ctx), 'Content-Type': 'application/json' },
      body: JSON.stringify({ transaction_id: req.providerPaymentId, amount_cents: req.amountMinor }), retries: 0,
    });
    if (r?.success === true) return { status: 'succeeded', providerRefundId: r.id !== undefined ? String(r.id) : null };
    if (r?.pending === true) return { status: 'pending', providerRefundId: r.id !== undefined ? String(r.id) : null };
    return { status: 'failed', providerRefundId: null, failureReason: String(r?.data?.message ?? r?.detail ?? 'refund_declined').slice(0, 200) };
  },

  async listTransactions(ctx, range) {
    const token = await authToken(ctx);
    if (!token) throw new ProviderError('paymob', 'Transaction listing needs the "apiKey" credential; upload the settlement CSV instead', false);
    const out: ProviderTransaction[] = [];
    let url: string | null = `${base(ctx)}/api/acceptance/transactions?page_size=100`;
    for (let page = 0; url && page < 50; page++) {
      const res: any = await providerRequest<any>('paymob', ctx, url, { headers: { Authorization: `Bearer ${token}` } });
      for (const t of res.results ?? []) {
        const created = new Date(t.created_at);
        if (created < range.from || created > range.to) continue;
        if (t.is_refunded || t.is_voided || t.has_parent_transaction) continue;
        out.push({
          providerPaymentId: String(t.id), providerSessionId: t.order?.id !== undefined ? String(t.order.id) : null,
          reference: t.order?.merchant_order_id ?? null, amountMinor: Number(t.amount_cents), currency: String(t.currency).toUpperCase(),
          status: t.success ? (t.refunded_amount_cents >= t.amount_cents ? 'refunded' : t.refunded_amount_cents > 0 ? 'partially_refunded' : 'succeeded') : t.pending ? 'pending' : 'failed',
          feeMinor: null, refundedMinor: Number(t.refunded_amount_cents ?? 0), createdAt: created.toISOString(),
        });
      }
      const oldest = (res.results ?? []).at(-1);
      url = res.next && !(oldest && new Date(oldest.created_at) < range.from) ? res.next : null;
    }
    return out;
  },
};
