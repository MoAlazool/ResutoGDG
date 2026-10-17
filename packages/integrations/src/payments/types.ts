// Payment provider adapter contract (ResutoPay). Owner: Agent D1.
//
// Resuto never holds merchant funds: every adapter talks to the restaurant's own
// provider account using credentials from its integration connection. Adapters
// are pure HTTP/crypto code: no database access, no ledger writes. The API calls
// them and applies results through the kernel PaymentLedgerService.
import type { AdapterContext, ProviderDescriptor, VerifiedWebhook } from '../core';

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

export type PaymentEventKind = 'payment_succeeded' | 'payment_failed' | 'payment_expired' | 'ignored';

/** Normalised provider evidence. Only produced from verified webhooks or server-side status queries. */
export interface PaymentEvent {
  kind: PaymentEventKind;
  providerSessionId?: string | null;
  providerPaymentId?: string | null;
  /** Resuto reference (payment attempt id) when the provider echoes it. */
  reference?: string | null;
  amountMinor?: number;
  currency?: string;
  feeMinor?: number | null;
  failureReason?: string | null;
  /** Ids an unverified payload claims, used only to find which connection's secret verifies it. */
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
  idempotencyKey: string;
}
export interface RefundResult {
  status: 'succeeded' | 'pending' | 'failed';
  providerRefundId: string | null;
  failureReason?: string | null;
  raw?: Record<string, unknown>;
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

export interface PaymentAdapter {
  readonly descriptor: ProviderDescriptor;
  /** Methods this provider can collect online. */
  readonly methods: ReadonlyArray<'card' | 'wallet'>;
  /** Credential keys required in the connection (activation checklist). */
  readonly requiredCredentials: readonly string[];
  createCheckout(ctx: AdapterContext, req: CheckoutRequest): Promise<CheckoutResult>;
  /** Reads lookup ids from an unverified payload. Never trust these for anything but secret selection. */
  lookup(input: WebhookInput): WebhookLookup | null;
  /** Verifies the signature over the raw body, then parses. */
  verifyWebhook(credentials: Record<string, string>, input: WebhookInput, config?: Record<string, unknown>): VerifiedWebhook<PaymentEvent>;
  /** Re-derives the event from an already-verified stored payload (worker retry). */
  parseEvent(payload: unknown, config?: Record<string, unknown>): PaymentEvent;
  /** Server-side status query for a provider session (used on return / polling). */
  retrieveStatus(ctx: AdapterContext, ref: { providerSessionId: string; reference: string }): Promise<PaymentEvent>;
  refund(ctx: AdapterContext, req: RefundRequest): Promise<RefundResult>;
  listTransactions(ctx: AdapterContext, range: { from: Date; to: Date }): Promise<ProviderTransaction[]>;
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
