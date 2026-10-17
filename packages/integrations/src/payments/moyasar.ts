// Moyasar (Saudi Arabia) adapter: hosted invoices, webhook secret token, refunds. Owner: Agent D1.
// Docs: https://docs.moyasar.com/api/invoices/01-create-invoice, https://docs.moyasar.com/guides/dashboard/webhooks,
// https://docs.moyasar.com/api/payments/05-refund-payment, https://docs.moyasar.com/api/payments/02-list-payments
import { constantTimeEqual, providerRequest, ProviderError, type AdapterContext, type ProviderDescriptor } from '../core';
import { rejected, safeJson, type PaymentAdapter, type PaymentEvent, type ProviderTransaction } from './types';

export const MOYASAR_API = 'https://api.moyasar.com/v1';

export const moyasarDescriptor: ProviderDescriptor = {
  id: 'moyasar',
  name: 'Moyasar',
  category: 'payments',
  countries: ['SA'],
  authType: 'api_key',
  readiness: 'implemented_unverified',
  docsUrl: 'https://docs.moyasar.com',
  activation: [
    'Use the restaurant\'s own Moyasar account (Resuto never holds funds).',
    'Dashboard → Settings → API keys: copy the secret key (sk_test_… for sandbox, sk_live_… for live) into the connection as "secretKey".',
    'Dashboard → Settings → Webhooks: add <API_ORIGIN>/v1/webhooks/payments/moyasar?c=<connectionId> for payment_paid and payment_failed, choose a shared secret and store it as "webhookSecret".',
    'Enable the methods (mada, Visa/Mastercard, Apple Pay, STC Pay) on the account; run one test payment end to end before switching to live.',
  ],
  capabilities: ['checkout', 'webhooks', 'status_query', 'refunds', 'transaction_listing'],
};

const auth = (ctx: AdapterContext) => {
  const key = ctx.credentials.secretKey;
  if (!key) throw new ProviderError('moyasar', 'secretKey is not configured', false);
  if (ctx.environment === 'sandbox' && !key.startsWith('sk_test_')) throw new ProviderError('moyasar', 'Sandbox connections must use a test key (sk_test_…)', false);
  return { Authorization: `Basic ${Buffer.from(`${key}:`).toString('base64')}` };
};

function paymentEvent(type: string, p: any): PaymentEvent {
  const ids = {
    providerSessionId: p?.invoice_id ?? null,
    providerPaymentId: p?.id ?? null,
    reference: p?.metadata?.resuto_payment_id ?? null,
    amountMinor: Number(p?.amount),
    currency: String(p?.currency ?? '').toUpperCase(),
    feeMinor: typeof p?.fee === 'number' ? p.fee : null,
  };
  if (type === 'payment_paid' && (p?.status === 'paid' || p?.status === 'captured')) return { kind: 'payment_succeeded', ...ids };
  if (type === 'payment_failed') return { kind: 'payment_failed', ...ids, failureReason: String(p?.source?.message ?? 'declined').slice(0, 200) };
  return { kind: 'ignored', ...ids };
}

export const moyasarAdapter: PaymentAdapter = {
  descriptor: moyasarDescriptor,
  methods: ['card', 'wallet'],
  requiredCredentials: ['secretKey', 'webhookSecret'],

  async createCheckout(ctx, req) {
    const inv = await providerRequest<any>('moyasar', ctx, `${MOYASAR_API}/invoices`, {
      method: 'POST', headers: { ...auth(ctx), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        amount: req.amountMinor,
        currency: req.currency,
        description: req.description.slice(0, 250) || 'Restaurant bill payment',
        callback_url: req.notificationUrl,
        success_url: req.returnUrl,
        back_url: req.cancelUrl,
        expired_at: new Date(Date.now() + req.expiresInSeconds * 1000).toISOString(),
        metadata: { resuto_payment_id: req.reference },
      }),
      retries: 0,
    });
    if (!inv?.id || typeof inv.url !== 'string' || !inv.url.startsWith('https://')) throw new ProviderError('moyasar', 'Invalid invoice response', false);
    return { providerSessionId: inv.id, redirectUrl: inv.url, raw: { status: inv.status } };
  },

  lookup(input) {
    const p = safeJson(input.rawBody)?.data;
    if (!p) return null;
    return { providerSessionId: p.invoice_id ?? null, providerPaymentId: p.id ?? null, reference: p.metadata?.resuto_payment_id ?? null };
  },

  /** Moyasar authenticates webhooks with the shared secret_token in the payload (constant-time compared). */
  verifyWebhook(credentials, input) {
    const secret = credentials.webhookSecret;
    if (!secret) return rejected('webhook secret not configured');
    const body = safeJson(input.rawBody);
    if (!body?.id || !body.type || !body.data) return rejected('malformed payload');
    if (typeof body.secret_token !== 'string' || !constantTimeEqual(body.secret_token, secret)) return rejected('signature mismatch');
    return { valid: true, eventKey: String(body.id), event: paymentEvent(body.type, body.data) };
  },

  parseEvent(payload: any) {
    return paymentEvent(payload?.type, payload?.data);
  },

  async retrieveStatus(ctx, ref) {
    const inv = await providerRequest<any>('moyasar', ctx, `${MOYASAR_API}/invoices/${encodeURIComponent(ref.providerSessionId)}`, { headers: auth(ctx) });
    const paid = (inv.payments ?? []).find((p: any) => p.status === 'paid' || p.status === 'captured');
    if (paid) return paymentEvent('payment_paid', { ...paid, invoice_id: inv.id });
    if (inv.status === 'expired' || inv.status === 'canceled') return { kind: 'payment_expired', providerSessionId: inv.id, amountMinor: inv.amount, currency: String(inv.currency).toUpperCase() };
    return { kind: 'ignored', providerSessionId: inv.id };
  },

  async refund(ctx, req) {
    const p = await providerRequest<any>('moyasar', ctx, `${MOYASAR_API}/payments/${encodeURIComponent(req.providerPaymentId)}/refund`, {
      method: 'POST', headers: { ...auth(ctx), 'Content-Type': 'application/json' }, body: JSON.stringify({ amount: req.amountMinor }), retries: 0,
    });
    if (p?.status === 'refunded' || Number(p?.refunded) > 0) return { status: 'succeeded', providerRefundId: `${p.id}:${p.refunded}` };
    return { status: 'failed', providerRefundId: null, failureReason: String(p?.message ?? p?.status ?? 'refund_failed').slice(0, 200) };
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
          status: p.status === 'refunded' ? (p.refunded >= p.amount ? 'refunded' : 'partially_refunded') : p.status === 'paid' || p.status === 'captured' ? 'succeeded' : p.status === 'failed' ? 'failed' : 'pending',
          feeMinor: typeof p.fee === 'number' ? p.fee : null, refundedMinor: p.refunded ?? 0, createdAt: created.toISOString(),
        });
      }
      const oldest = items.at(-1);
      if (!res.meta?.next_page || !items.length || (oldest && new Date(oldest.created_at) < range.from)) break;
    }
    return out;
  },
};
