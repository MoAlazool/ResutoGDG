// Payment provider adapter contract (ResutoPay). Owner: Agent D1.
//
// Resuto never holds merchant funds: every adapter talks to the restaurant's own
// provider account using credentials from its integration connection. Adapters
// are pure HTTP/crypto code: no database access, no ledger writes. The API calls
// them and applies results through the kernel PaymentLedgerService.
//
// Trust model (PAY-01, PAY-02, PAY-04):
// - A webhook only counts once its signature is verified with the secret of the
//   connection it names. Fields outside the signature are never used to choose
//   which payment is settled; they may only be cross-checked.
// - Events whose authenticator is weak (Moyasar's static secret_token) or whose
//   amounts are not covered by the signature (Paymob refunds) carry
//   `needsConfirmation`: the API applies them only after `confirmEvent()` has
//   re-read the object from the provider with the merchant's own key.
// - `livemode` is provider evidence of the environment (signed or authenticated);
//   the API rejects events whose environment differs from the connection's.
import type { AdapterContext, HealthCheckResult, ProviderDescriptor, VerifiedWebhook } from '../core';

export interface CheckoutRequest {
  /** Resuto payment attempt id (pending payment row); echoed back by the provider. */
  reference: string;
  amountMinor: number;
  currency: 'EGP' | 'SAR' | 'USD';
  method: 'card' | 'wallet';
  description: string;
  /** Where the provider sends the customer afterwards (Resuto hosted page; never trusted as proof). */
  returnUrl: string;
  cancelUrl: string;
  /** Provider → Resuto webhook URL for this connection. */
  notificationUrl: string;
  /** Unsigned "something changed" callback (Moyasar invoice callback_url): only triggers a server-side status query. */
  nudgeUrl?: string;
  customer?: { name?: string | null; email?: string | null; phone?: string | null };
  items?: Array<{ name: string; amountMinor: number; quantity: number }>;
  expiresInSeconds: number;
}

export interface CheckoutResult {
  /** Provider object the customer pays (Stripe Checkout Session, Paymob intention order, Moyasar invoice). */
  providerSessionId: string;
  redirectUrl: string;
  raw?: Record<string, unknown>;
}

export type PaymentEventKind =
  | 'payment_succeeded'
  | 'payment_failed'
  | 'payment_expired'
  /** Funds are held but not captured (auth-only). Never settles a bill; staff must capture or void at the provider. */
  | 'payment_authorized'
  /** The provider reports a cumulative refunded amount (`refundedMinor`) on a captured payment. */
  | 'payment_refunded'
  /** The provider voided (reversed) the payment in full. */
  | 'payment_voided'
  | 'dispute_opened'
  | 'dispute_closed'
  | 'ignored';

/** Fixed failure codes; provider text is never shown to guests (PAY-20). */
export type PaymentFailureCode = 'declined' | 'expired' | 'cancelled' | 'async_payment_failed' | 'provider_unavailable';

/** Normalised provider evidence. Only produced from verified webhooks or authenticated server-side queries. */
export interface PaymentEvent {
  kind: PaymentEventKind;
  providerSessionId?: string | null;
  providerPaymentId?: string | null;
  /** Resuto reference (payment attempt id) — set only when the provider SIGNS or AUTHENTICATES it. */
  reference?: string | null;
  /** An unsigned echo of the Resuto reference (Paymob merchant_order_id). Cross-check only: must equal the matched attempt. */
  claimedReference?: string | null;
  amountMinor?: number;
  currency?: string;
  feeMinor?: number | null;
  failureReason?: PaymentFailureCode | string | null;
  /** Provider evidence of the environment: true live, false test, null when the evidence is absent or unsigned. */
  livemode?: boolean | null;
  /** Cumulative amount refunded on the provider payment (refund/void events). */
  refundedMinor?: number | null;
  /**
   * Set only from an AUTHENTICATED read of the provider object (fetch / inquiry, never a signed hint): the transaction
   * was captured for this amount before it was refunded. A refund observed while Resuto's attempt is still open then
   * settles the capture first and the refund after it, instead of waiting for a success event that a re-read can no
   * longer produce (Moyasar reports any refunded payment, partial or full, as status "refunded").
   */
  capturedMinor?: number | null;
  providerRefundId?: string | null;
  disputeId?: string | null;
  disputeStatus?: string | null;
  /** Apply only after `confirmEvent()` re-read the object with the merchant's key. */
  needsConfirmation?: boolean;
  /** Unverified provider text for staff diagnostics only. */
  providerMessage?: string | null;
  /** Provider account name seen on the event (Moyasar account_name), for connection diagnostics. */
  accountName?: string | null;
  raw?: Record<string, unknown>;
}

export interface WebhookInput {
  rawBody: Buffer | string;
  headers: Record<string, string | string[] | undefined>;
  query: Record<string, string | undefined>;
  /** Unix seconds; injectable for tests. */
  nowSeconds?: number;
}

/** Lookup hints read from an UNVERIFIED payload, only to pick the secret that verifies it. */
export interface WebhookLookup {
  providerSessionId?: string | null;
  providerPaymentId?: string | null;
  reference?: string | null;
}

export interface RefundRequest {
  providerPaymentId: string;
  providerSessionId?: string | null;
  amountMinor: number;
  currency: string;
  reason: string;
  /** Stable per intended refund: retries of the same refund reuse it (PAY-05). */
  idempotencyKey: string;
  /** Refunds the ledger already applied on this payment (for cumulative-total providers). */
  ledgerRefundedMinor?: number;
}
export interface RefundResult {
  /** `unknown`: the outcome could not be determined (network/timeout/5xx); the refund stays pending and is resolved by inquiry. */
  status: 'succeeded' | 'pending' | 'failed' | 'unknown';
  providerRefundId: string | null;
  failureReason?: string | null;
  raw?: Record<string, unknown>;
}

/** Answer of a refund inquiry (PAY-05/PAY-12). `not_found`: the provider has no trace of it, so it is safe to send again. */
export interface RefundStatusResult {
  status: 'succeeded' | 'pending' | 'failed' | 'not_found' | 'unknown';
  providerRefundId?: string | null;
  /** Cumulative refunded on the provider payment, when the provider reports it. */
  providerRefundedMinor?: number | null;
  failureReason?: string | null;
}

export interface ProviderTransaction {
  providerPaymentId: string;
  providerSessionId?: string | null;
  reference?: string | null;
  amountMinor: number;
  currency: string;
  status: 'succeeded' | 'failed' | 'pending' | 'refunded' | 'partially_refunded';
  feeMinor: number | null;
  refundedMinor: number;
  createdAt: string;
}

/** A connection form field. Labels are i18n keys in the web dictionary (`intg.field.<provider>.<key>`), with an English fallback. */
export interface SetupField {
  key: string;
  label: string;
  labelKey: string;
  secret: boolean;
  required: boolean;
  kind: 'text' | 'secret' | 'number' | 'select';
  /** Regular expression (source) the value must match, checked by the API and the form. */
  pattern?: string;
  options?: string[];
  placeholder?: string;
  hintKey?: string;
}

/**
 * Per-capability implementation facts (INT-16). The six-state readiness shown
 * in the catalog is computed from these plus recorded acceptance results.
 */
export interface CapabilityFact {
  implemented: boolean;
  /** Short English note shown in docs and diagnostics. */
  note?: string;
  /** Documented provider restriction that blocks the capability (with a source URL). */
  blockedBy?: string;
}

export interface ProviderSetup {
  credentials: SetupField[];
  config: SetupField[];
  /** Events the merchant must subscribe the webhook endpoint to (empty when the URL is sent per checkout). */
  webhookEvents: string[];
  /** The merchant registers the webhook URL in the provider dashboard (false: Resuto sends it per checkout). */
  webhookRegisteredByMerchant: boolean;
  /** Countries whose businesses the provider documents it cannot onboard. */
  restrictedCountries?: Array<{ country: 'EG' | 'SA'; reason: string; source: string }>;
  capabilities: Record<string, CapabilityFact>;
  docs: Record<string, string>;
}

export interface PaymentAdapter {
  readonly descriptor: ProviderDescriptor;
  /** Methods this provider can collect online. */
  readonly methods: ReadonlyArray<'card' | 'wallet'>;
  /** Credential keys required in the connection (activation checklist). */
  readonly requiredCredentials: readonly string[];
  /** A declined attempt leaves the provider session payable (the payer can retry on the provider page) — PAY-07. */
  readonly sessionSurvivesDecline: boolean;
  readonly setup: ProviderSetup;
  /**
   * Test/live environment implied by the credentials (documented key prefixes);
   * null when the credentials do not show it. Connections fail closed on null
   * or on a mismatch with their environment (PAY-02).
   */
  credentialEnvironment(credentials: Record<string, string>): 'sandbox' | 'live' | null;
  createCheckout(ctx: AdapterContext, req: CheckoutRequest): Promise<CheckoutResult>;
  /** Reads lookup ids from an unverified payload. Never trust these for anything but secret selection. */
  lookup(input: WebhookInput): WebhookLookup | null;
  /** Verifies the signature over the raw body, then parses. */
  verifyWebhook(credentials: Record<string, string>, input: WebhookInput, config?: Record<string, unknown>): VerifiedWebhook<PaymentEvent>;
  /** Re-derives the event from an already-verified stored payload (worker retry). */
  parseEvent(payload: unknown, config?: Record<string, unknown>): PaymentEvent;
  /** Re-reads the object behind an event with the merchant's key; the returned event replaces the webhook's. */
  confirmEvent?(ctx: AdapterContext, event: PaymentEvent): Promise<PaymentEvent>;
  /** Server-side status query for a provider session (used on return / polling). */
  retrieveStatus(ctx: AdapterContext, ref: { providerSessionId: string; reference: string }): Promise<PaymentEvent>;
  /** Makes a superseded or expired provider session unpayable where the provider supports it (PAY-08). */
  cancelCheckout?(ctx: AdapterContext, ref: { providerSessionId: string }): Promise<'cancelled' | 'already_completed' | 'unsupported'>;
  refund(ctx: AdapterContext, req: RefundRequest): Promise<RefundResult>;
  /** Resolves a pending or uncertain refund by asking the provider (PAY-05/PAY-12). */
  refundStatus(ctx: AdapterContext, req: RefundRequest & { providerRefundId?: string | null }): Promise<RefundStatusResult>;
  listTransactions(ctx: AdapterContext, range: { from: Date; to: Date }): Promise<ProviderTransaction[]>;
  /** Cheap authenticated call proving the credentials work, with the account identity (INT-05). */
  healthCheck(ctx: AdapterContext): Promise<HealthCheckResult>;
  /** Removes secrets and minimises personal data before a payload is stored (INT-10, PAY-18). */
  redactPayload(body: unknown): unknown;
}

export const header = (headers: WebhookInput['headers'], name: string): string | undefined => {
  const v = headers[name.toLowerCase()] ?? headers[name];
  return Array.isArray(v) ? v[0] : v;
};

export const rawText = (raw: Buffer | string) => (typeof raw === 'string' ? raw : raw.toString('utf8'));

export function safeJson(raw: Buffer | string): any {
  try {
    return JSON.parse(rawText(raw));
  } catch {
    return null;
  }
}

/** Verified-false result helper. */
export const rejected = (reason: string): VerifiedWebhook<PaymentEvent> => ({ valid: false, eventKey: '', event: null, reason });

/** Keys never persisted from provider payloads: shared secrets, tokens, card data. */
const SECRET_KEYS = /^(secret_token|secret|webhook_secret|client_secret|password|api_key|apikey|authorization|access_token|refresh_token|token|hmac|signature|card_number|number|cvc|cvv|payment_key|payment_token)$/i;
/** Personal data minimised in stored payloads (kept only as a fingerprint of presence). */
const PII_KEYS = /^(email|phone|phone_number|first_name|last_name|name|street|building|floor|apartment|address|address_line1|address_line2|postal_code|ip|customer_email|customer_phone|billing_data|shipping_data|shipping_details|customer_details)$/i;

/**
 * Generic payload minimisation: drops secret-like keys at any depth and replaces
 * personal data with a marker. Adapters add provider-specific rules on top.
 */
export function redactProviderPayload(value: unknown, depth = 0): unknown {
  if (depth > 12) return '[truncated]';
  if (Array.isArray(value)) return value.slice(0, 200).map((v) => redactProviderPayload(v, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_KEYS.test(k)) continue;
      if (PII_KEYS.test(k)) { out[k] = v === null || v === undefined || v === '' ? v : '[redacted]'; continue; }
      out[k] = redactProviderPayload(v, depth + 1);
    }
    return out;
  }
  if (typeof value === 'string' && value.length > 2000) return `${value.slice(0, 2000)}…`;
  return value;
}

/** Cross-adapter helper: environment named by a documented key prefix pattern. */
export function prefixEnvironment(value: string | undefined, test: RegExp, live: RegExp): 'sandbox' | 'live' | null {
  if (!value) return null;
  if (test.test(value)) return 'sandbox';
  if (live.test(value)) return 'live';
  return null;
}
