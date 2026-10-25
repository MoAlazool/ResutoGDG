// Paymob (Egypt / KSA) adapter: Intention API + Unified Checkout, HMAC-SHA512
// transaction callbacks, refunds, transaction inquiry. Owner: Agent D1.
//
// Official docs (checked 2026-10-20):
// - HMAC (transaction processed callback): https://developers.paymob.com/paymob-docs/developers/webhook-callbacks-and-hmac/hmac/hmac-transaction-callback
// - Create intention: https://developers.paymob.com/paymob-docs/developers/intention-apis/create-intention
// - Unified checkout redirect: https://developers.paymob.com/paymob-docs/developers/checkout-experiences/unified-checkout-redirection
// - Credentials (keys are mode-specific; the API key is shared by test and live): https://developers.paymob.com/paymob-docs/need-help/setup-guides/getting-integration-credentials
// - Transaction callbacks (refunded_amount_cents, is_voided…): https://developers.paymob.com/paymob-docs/manage-callback/transaction-callbacks
// - Refund / void / inquiry (regional reference): https://docs.paymob.com/docs/refund-transaction, https://docs.paymob.com/docs/void-transaction,
//   https://docs.oman.paymob.com/docs/retrieve-a-transaction
//
// Security notes:
// - Only the 20 documented fields are covered by the HMAC. `merchant_order_id`,
//   `special_reference`, `is_live`, `refunded_amount_cents` and `data.message`
//   are NOT signed: they never select the payment (PAY-01) and refund amounts are
//   re-read through the authenticated inquiry before they are applied.
// - Integration ids are mode-specific; the signed `integration_id` must be one of
//   the connection's configured ids, which binds the event to the connection's
//   environment. With no ids configured verification fails closed (PAY-02).
import { createHash } from 'node:crypto';
import { hmacHex, providerRequest, ProviderError, type AdapterContext, type ProviderDescriptor } from '../core';
import { hexDigestEquals } from './signature';
import {
  prefixEnvironment, redactProviderPayload, rejected, safeJson,
  type PaymentAdapter, type PaymentEvent, type RefundStatusResult, type WebhookInput,
} from './types';

export const PAYMOB_BASES = ['https://accept.paymob.com', 'https://ksa.paymob.com', 'https://uae.paymob.com', 'https://oman.paymob.com'] as const;

/** The 20 documented fields of the transaction-processed callback, in HMAC order (lexicographic). */
export const PAYMOB_HMAC_FIELDS = [
  'amount_cents', 'created_at', 'currency', 'error_occured', 'has_parent_transaction', 'id', 'integration_id', 'is_3d_secure',
  'is_auth', 'is_capture', 'is_refunded', 'is_standalone_payment', 'is_voided', 'order.id', 'owner', 'pending',
  'source_data.pan', 'source_data.sub_type', 'source_data.type', 'success',
] as const;

/** Paymob shows live keys with a `sk_live`/`pk_live` segment (regional prefix first, e.g. egy_sk_live_…); test keys `sk_test`/`pk_test`. */
const SECRET_TEST = /(^|_)sk_test_/;
const SECRET_LIVE = /(^|_)sk_live_/;
const PUBLIC_TEST = /(^|_)pk_test_/;
const PUBLIC_LIVE = /(^|_)pk_live_/;

export const paymobDescriptor: ProviderDescriptor = {
  id: 'paymob',
  name: 'Paymob',
  category: 'payments',
  countries: ['EG', 'SA'],
  authType: 'api_key',
  connectMethod: 'api_key',
  readiness: 'implemented_unverified',
  docsUrl: 'https://developers.paymob.com/paymob-docs/developers/intention-apis/create-intention',
  activation: [
    'Use the restaurant\'s own Paymob merchant account (Resuto never holds funds). Create the connection in TEST mode first.',
    'Dashboard → Settings → Account info: copy the Secret key, Public key, HMAC secret and API key (the API key enables status checks, refund checks and transaction listing).',
    'Dashboard → Developers → Payment integrations: copy the online card integration id and (optional) the mobile wallet integration id. Integration ids are different in test and live mode.',
    'Set the Transaction processed callback of each integration to the webhook URL shown on the connection (Resuto also sends it with every checkout). Wallet integrations need it set in the dashboard.',
    'KSA, UAE or Oman accounts: choose the matching region.',
    'Run one test-mode card payment end to end, then request live activation from Paymob and create a separate LIVE connection with the live keys and live integration ids.',
  ],
  capabilities: ['checkout', 'webhooks', 'status_query', 'refunds', 'transaction_listing'],
};

const base = (ctx: Pick<AdapterContext, 'config'>) => {
  const b = String(ctx.config.baseUrl ?? 'https://accept.paymob.com').replace(/\/$/, '');
  if (!(PAYMOB_BASES as readonly string[]).includes(b)) throw new ProviderError('paymob', 'Invalid Paymob region (baseUrl)', false);
  return b;
};

/** Fails closed unless both keys show the connection's environment. */
function assertKeys(ctx: AdapterContext) {
  const env = paymobCredentialEnvironment(ctx.credentials);
  if (!env) throw new ProviderError('paymob', 'Unrecognised Paymob key format: expected matching …sk_test_/…pk_test_ or …sk_live_/…pk_live_ keys', false);
  if (env !== ctx.environment) throw new ProviderError('paymob', `This ${ctx.environment === 'live' ? 'live' : 'test'} connection has ${env === 'live' ? 'live' : 'test'} keys`, false);
}

const secretAuth = (ctx: AdapterContext) => {
  if (!ctx.credentials.secretKey) throw new ProviderError('paymob', 'secretKey is not configured', false);
  assertKeys(ctx);
  return { Authorization: `Token ${ctx.credentials.secretKey}` };
};

export function paymobCredentialEnvironment(credentials: Record<string, string>): 'sandbox' | 'live' | null {
  const s = prefixEnvironment(credentials.secretKey, SECRET_TEST, SECRET_LIVE);
  const p = credentials.publicKey ? prefixEnvironment(credentials.publicKey, PUBLIC_TEST, PUBLIC_LIVE) : s;
  return s && s === p ? s : null;
}

/** Concatenation of the 20 callback fields, exactly as Paymob computes it. */
export function paymobHmacPayload(obj: any): string {
  return PAYMOB_HMAC_FIELDS.map((path) => path.split('.').reduce((v: any, k) => v?.[k], obj)).map((v) => String(v)).join('');
}
export const paymobHmac = (secret: string, obj: any) => hmacHex('sha512', secret, paymobHmacPayload(obj));

/**
 * Dedupe key of a verified callback, built from SIGNED content only (the 20 HMAC fields): copies of one signed
 * transaction that differ in unsigned fields (data.message, is_live, …) are the same event and are processed once.
 * Refund-type callbacks are re-read through the authenticated inquiry before anything is applied, so the unsigned
 * cumulative refunded_amount_cents is kept in their key: a second partial refund is confirmed again (idempotent per
 * cumulative total) instead of being dropped as a duplicate.
 */
export function paymobEventKey(obj: any, needsConfirmation: boolean): string {
  const signed = createHash('sha256').update(paymobHmacPayload(obj)).digest('hex').slice(0, 32);
  return `txn:${obj.id}:${signed}${needsConfirmation ? `:refunded=${obj.refunded_amount_cents ?? ''}` : ''}`;
}

function integrationIds(config: Record<string, unknown>) {
  return [config.integrationIdCard, config.integrationIdWallet].filter((v) => v !== undefined && v !== null && v !== '').map(String);
}

const idOf = (v: unknown) => (v === undefined || v === null || v === '' ? null : String(v));

/**
 * Event from a transaction object. `signed` objects come from a verified callback
 * (only the HMAC fields are trusted); otherwise the object is an authenticated
 * inquiry response and every field is the provider's own answer.
 */
function txnEvent(obj: any, signed: boolean): PaymentEvent {
  const ids = {
    providerSessionId: idOf(obj?.order?.id ?? obj?.order_id),
    providerPaymentId: idOf(obj?.id),
    reference: signed ? null : idOf(obj?.order?.merchant_order_id),
    claimedReference: signed ? idOf(obj?.order?.merchant_order_id ?? obj?.special_reference) : null,
    amountMinor: Number(obj?.amount_cents),
    currency: String(obj?.currency ?? '').toUpperCase(),
    feeMinor: null,
    // is_live is outside the HMAC: only an authenticated inquiry answer is evidence.
    livemode: signed ? null : typeof obj?.is_live === 'boolean' ? obj.is_live : null,
    providerMessage: typeof obj?.data?.message === 'string' ? obj.data.message.slice(0, 200) : null,
  };
  const refunded = Number(obj?.refunded_amount_cents);
  if (obj?.is_voided === true) return { kind: 'payment_voided', ...ids, refundedMinor: signed ? null : Number(obj?.amount_cents), needsConfirmation: signed };
  if (obj?.is_refunded === true || (!signed && refunded > 0)) {
    // An inquiry answer for a successful transaction that was refunded proves the capture (review F5); a signed hint never does.
    const capturedMinor = !signed && obj?.success === true && obj?.is_voided !== true ? Number(obj?.amount_cents) : null;
    return { kind: 'payment_refunded', ...ids, refundedMinor: signed || !Number.isFinite(refunded) ? null : refunded, needsConfirmation: signed, capturedMinor };
  }
  // A child transaction that is not a capture (refund/void record of a parent): only the inquiry can say what it did.
  if (obj?.has_parent_transaction === true && obj?.is_capture !== true) {
    return signed ? { kind: 'payment_refunded', ...ids, refundedMinor: null, needsConfirmation: true } : { kind: 'ignored', ...ids };
  }
  if (obj?.success === true && obj?.pending === false) {
    if (obj?.is_auth === true && obj?.is_capture !== true) return { kind: 'payment_authorized', ...ids };
    return { kind: 'payment_succeeded', ...ids };
  }
  if (obj?.success === false && obj?.pending === false) return { kind: 'payment_failed', ...ids, failureReason: 'declined' };
  return { kind: 'ignored', ...ids };
}

async function authToken(ctx: AdapterContext): Promise<{ token: string; profile: any }> {
  if (!ctx.credentials.apiKey) throw new ProviderError('paymob', 'apiKey is not configured (needed for status and refund checks)', false);
  const r = await providerRequest<{ token: string; profile?: any }>('paymob', ctx, `${base(ctx)}/api/auth/tokens`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ api_key: ctx.credentials.apiKey }),
  });
  if (!r?.token) throw new ProviderError('paymob', 'Invalid auth token response', false);
  return { token: r.token, profile: r.profile ?? null };
}

/** Authenticated inquiry by Paymob order id. The API key is shared by test and live, so the answer's is_live is checked. */
async function inquiry(ctx: AdapterContext, orderId: string): Promise<any | null> {
  assertKeys(ctx);
  const { token } = await authToken(ctx);
  const txn = await providerRequest<any>('paymob', ctx, `${base(ctx)}/api/ecommerce/orders/transaction_inquiry`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ order_id: orderId }),
  }).catch((e: ProviderError) => { if (e.status === 404) return null; throw e; });
  if (!txn) return null;
  if (typeof txn.is_live === 'boolean' && txn.is_live !== (ctx.environment === 'live')) {
    throw new ProviderError('paymob', `Inquiry returned a ${txn.is_live ? 'live' : 'test'} transaction for a ${ctx.environment === 'live' ? 'live' : 'test'} connection`, false);
  }
  const known = integrationIds(ctx.config);
  if (txn.integration_id !== undefined && known.length && !known.includes(String(txn.integration_id))) {
    throw new ProviderError('paymob', 'Inquiry returned a transaction of an integration this connection does not use', false);
  }
  return txn;
}

const splitName = (name?: string | null) => {
  const parts = (name ?? '').trim().split(/\s+/).filter(Boolean);
  return { first: parts[0] ?? 'Guest', last: parts.slice(1).join(' ') || 'Guest' };
};

const field = (key: string, label: string, opts: Partial<import('./types').SetupField> = {}) =>
  ({ key, label, labelKey: `intg.field.paymob.${key}`, secret: false, required: true, kind: 'text' as const, ...opts });

export const paymobAdapter: PaymentAdapter = {
  descriptor: paymobDescriptor,
  methods: ['card', 'wallet'],
  // The API key is required: without it Resuto can neither confirm a payment on return, nor resolve a refund, nor reconcile (PAY-14).
  requiredCredentials: ['secretKey', 'publicKey', 'hmacSecret', 'apiKey'],
  sessionSurvivesDecline: true,
  setup: {
    credentials: [
      field('secretKey', 'Secret key', { secret: true, kind: 'secret', pattern: '(^|_)sk_(test|live)_[A-Za-z0-9_\\-]+$', placeholder: 'egy_sk_test_…' }),
      field('publicKey', 'Public key', { pattern: '(^|_)pk_(test|live)_[A-Za-z0-9_\\-]+$', placeholder: 'egy_pk_test_…' }),
      field('hmacSecret', 'HMAC secret', { secret: true, kind: 'secret' }),
      field('apiKey', 'API key', { secret: true, kind: 'secret', hintKey: 'intg.hint.paymob.apiKey' }),
    ],
    config: [
      field('integrationIdCard', 'Card integration id', { kind: 'number', pattern: '^[0-9]{1,12}$' }),
      field('integrationIdWallet', 'Mobile wallet integration id', { kind: 'number', pattern: '^[0-9]{1,12}$', required: false, hintKey: 'intg.hint.paymob.wallet' }),
      field('baseUrl', 'Region', { kind: 'select', options: [...PAYMOB_BASES], required: false }),
    ],
    webhookEvents: ['Transaction processed callback'],
    webhookRegisteredByMerchant: false,
    capabilities: {
      checkout: { implemented: true, note: 'Intention API + Unified Checkout redirect.' },
      webhooks: { implemented: true, note: 'HMAC-SHA512 over the 20 documented fields; payment chosen only by the signed order id.' },
      status_query: { implemented: true, note: 'Transaction inquiry by order id (API key token); is_live checked.' },
      refunds: { implemented: true, note: 'Refund endpoint has no idempotency key: uncertain results are resolved by inquiry before any retry.' },
      refund_status: { implemented: true, note: 'refunded_amount_cents from the inquiry.' },
      cancel_checkout: { implemented: false, note: 'No documented intention cancel; Resuto keeps intentions short-lived (30 minutes).' },
      transaction_listing: { implemented: false, note: 'The listing endpoint is not in the public docs; reconcile with the settlement CSV.' },
      health_check: { implemented: true, note: 'API key token + key/integration checks.' },
    },
    docs: {
      hmac: 'https://developers.paymob.com/paymob-docs/developers/webhook-callbacks-and-hmac/hmac/hmac-transaction-callback',
      intention: 'https://developers.paymob.com/paymob-docs/developers/intention-apis/create-intention',
      credentials: 'https://developers.paymob.com/paymob-docs/need-help/setup-guides/getting-integration-credentials',
    },
  },

  credentialEnvironment: paymobCredentialEnvironment,

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
          // Paymob requires billing fields; placeholders are used when the guest gave none (PAY-21: verify acceptance in the sandbox).
          first_name: name.first, last_name: name.last, email: req.customer?.email || 'guest@resuto.invalid',
          phone_number: req.customer?.phone || '+200000000000', apartment: 'NA', floor: 'NA', street: 'NA', building: 'NA',
          city: 'NA', state: 'NA', country: req.currency === 'SAR' ? 'SAU' : 'EGY',
        },
        special_reference: req.reference,
        // Short-lived: an abandoned intention cannot be cancelled through a documented API (PAY-08).
        expiration: Math.min(Math.max(req.expiresInSeconds, 300), 1800),
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
    return { providerSessionId: idOf(obj.order?.id), providerPaymentId: idOf(obj.id), reference: null };
  },

  verifyWebhook(credentials, input, config = {}) {
    const secret = credentials.hmacSecret;
    if (!secret) return rejected('hmac secret not configured');
    const given = input.query.hmac;
    if (!given) return rejected('missing signature');
    if (!/^[0-9a-fA-F]{128}$/.test(given)) return rejected('malformed signature');
    const body = safeJson(input.rawBody);
    const obj = body?.obj;
    if (!obj || typeof obj !== 'object' || !obj.order || !obj.source_data || obj.id === undefined || obj.order.id === undefined) return rejected('malformed payload');
    if (!hexDigestEquals(paymobHmac(secret, obj), given, 64)) return rejected('signature mismatch');
    const known = integrationIds(config);
    // Fail closed: without configured (mode-specific) integration ids the event cannot be bound to this connection's environment.
    if (!known.length) return rejected('integration ids not configured');
    const event = txnEvent(obj, true);
    const eventKey = paymobEventKey(obj, !!event.needsConfirmation);
    if (!known.includes(String(obj.integration_id))) {
      return { valid: true, eventKey, event: { ...event, kind: 'ignored', failureReason: 'unknown_integration' } };
    }
    return { valid: true, eventKey, event };
  },

  parseEvent(payload: any, config = {}) {
    const obj = payload?.obj;
    const known = integrationIds(config);
    if (!known.length || !known.includes(String(obj?.integration_id))) return { ...txnEvent(obj, true), kind: 'ignored', failureReason: 'unknown_integration' };
    return txnEvent(obj, true);
  },

  /** Refund/void/child-transaction callbacks carry unsigned amounts: re-read the order with the merchant's API key. */
  async confirmEvent(ctx, ev) {
    if (!ev.providerSessionId) return { ...ev, kind: 'ignored', needsConfirmation: false };
    const txn = await inquiry(ctx, ev.providerSessionId);
    if (!txn) return { kind: 'ignored', providerSessionId: ev.providerSessionId };
    return { ...txnEvent(txn, false), needsConfirmation: false };
  },

  async retrieveStatus(ctx, ref) {
    const txn = await inquiry(ctx, ref.providerSessionId);
    if (!txn) return { kind: 'ignored', providerSessionId: ref.providerSessionId };
    const ev = txnEvent(txn, false);
    // A decline inside a still-open intention is not final (the payer can retry on the Paymob page).
    return ev.kind === 'payment_failed' ? { ...ev, kind: 'ignored', failureReason: 'declined' } : ev;
  },

  async cancelCheckout() {
    return 'unsupported';
  },

  async refund(ctx, req) {
    const r = await providerRequest<any>('paymob', ctx, `${base(ctx)}/api/acceptance/void_refund/refund`, {
      method: 'POST', headers: { ...secretAuth(ctx), 'Content-Type': 'application/json' },
      body: JSON.stringify({ transaction_id: req.providerPaymentId, amount_cents: req.amountMinor }), retries: 0,
    });
    if (r?.success === true && r?.pending !== true) return { status: 'succeeded', providerRefundId: idOf(r.id) };
    if (r?.pending === true) return { status: 'pending', providerRefundId: idOf(r.id) };
    return { status: 'failed', providerRefundId: null, failureReason: 'refund_declined', raw: { providerMessage: String(r?.data?.message ?? r?.detail ?? '').slice(0, 200) } };
  },

  /** Paymob refunds carry no idempotency key: the cumulative refunded amount on the order decides whether ours happened. */
  async refundStatus(ctx, req): Promise<RefundStatusResult> {
    if (!req.providerSessionId) return { status: 'unknown', failureReason: 'paymob_order_id_missing' };
    const txn = await inquiry(ctx, req.providerSessionId);
    if (!txn) return { status: 'unknown', failureReason: 'transaction_not_found' };
    const refunded = Number(txn.refunded_amount_cents ?? 0);
    const before = req.ledgerRefundedMinor ?? 0;
    if (refunded >= before + req.amountMinor) return { status: 'succeeded', providerRefundedMinor: refunded };
    if (refunded <= before) return { status: 'not_found', providerRefundedMinor: refunded };
    return { status: 'unknown', providerRefundedMinor: refunded, failureReason: 'partial_refund_total_does_not_match' };
  },

  /**
   * Paymob documents no transaction-listing API (only retrieve-by-id and the order inquiry), so Resuto never calls an
   * undocumented endpoint: reconciliation uses the settlement CSV from the Paymob dashboard (INT-19).
   */
  async listTransactions() {
    throw new ProviderError('paymob', 'Paymob has no documented transaction listing API; upload the Paymob settlement CSV instead', false, 501);
  },

  async healthCheck(ctx) {
    assertKeys(ctx);
    base(ctx);
    const ids = integrationIds(ctx.config);
    if (!ctx.config.integrationIdCard) throw new ProviderError('paymob', 'Card integration id is not configured', false);
    if (ids.some((v) => !/^[0-9]{1,12}$/.test(v))) throw new ProviderError('paymob', 'Integration ids must be numbers', false);
    if (!ctx.credentials.hmacSecret) throw new ProviderError('paymob', 'hmacSecret is not configured', false);
    const { profile } = await authToken(ctx);
    return {
      ok: true,
      environment: paymobCredentialEnvironment(ctx.credentials),
      account: profile ? { id: idOf(profile.id), name: profile.company_name ?? profile.user?.username ?? null, country: profile.country ?? null, currency: null } : null,
      details: { integrationIds: ids, region: base(ctx), checks: ['api_key_token', 'key_mode', 'integration_ids'] },
    };
  },

  redactPayload: (body) => redactProviderPayload(body),
};
