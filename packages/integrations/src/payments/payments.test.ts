import { describe, expect, it } from 'vitest';
import type { AdapterContext } from '../core';
import { moyasarAdapter } from './moyasar';
import { PAYMOB_HMAC_FIELDS, paymobAdapter, paymobHmac, paymobHmacPayload } from './paymob';
import { signSimulated, simulatedAdapter, type SimulatedStore } from './simulated';
import { parseStripeSignature, signStripe, stripeAdapter } from './stripe';

// ---------------------------------------------------------------------------
// Fixtures and fixed vectors (computed independently with `openssl dgst -hmac`)
// ---------------------------------------------------------------------------
const STRIPE_SECRET = 'whsec_test_secret';
const STRIPE_VECTOR_BODY = '{"id":"evt_1","type":"checkout.session.completed"}';
const STRIPE_VECTOR_SIG = 'a13d4b1f9003bc2fb6c06224e878b6056185eaa50d40e1e7dc05517f8af41d7b';

const PAYMOB_SECRET = 'PAYMOB_HMAC_TEST';
const paymobObj = () => ({
  id: 123456788, pending: false, amount_cents: 10000, success: true, is_auth: false, is_capture: true, is_standalone_payment: false,
  is_voided: false, is_refunded: false, is_3d_secure: true, integration_id: 4520, has_parent_transaction: false, owner: 1234,
  error_occured: false, currency: 'EGP', created_at: '2023-06-13T13:49:23.570621',
  order: { id: 98765432, merchant_order_id: 'pay_ref_1' },
  source_data: { pan: '512345xxxxxx2346', sub_type: 'MasterCard', type: 'card' },
  data: { message: 'Approved' },
});
const PAYMOB_VECTOR = '87c5cc966415f25720f83447f62fb802c4138d805b531240e73655133c1fc57de7da231f3da43b22b83f414fe91b584e4f69326da6c8337135add7af255b2249';

type Call = { url: string; init: RequestInit };
function fakeFetch(responses: Array<{ status?: number; body: unknown }>) {
  const calls: Call[] = [];
  const fn = (async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), init });
    const r = responses.shift() ?? { status: 500, body: { error: 'no fixture' } };
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  return { fn, calls };
}
const ctx = (fetch: typeof globalThis.fetch, credentials: Record<string, string>, config: Record<string, unknown> = {}, environment: 'sandbox' | 'live' = 'sandbox'): AdapterContext =>
  ({ environment, credentials, config, fetch });

const checkoutReq = {
  reference: 'pay_ref_1', amountMinor: 10000, currency: 'EGP' as const, method: 'card' as const, description: 'Table 4 bill',
  returnUrl: 'https://app.test/pay/tok?return=1', cancelUrl: 'https://app.test/pay/tok', notificationUrl: 'https://api.test/v1/webhooks/payments/x?c=conn',
  expiresInSeconds: 1800,
};

// ---------------------------------------------------------------------------
describe('stripe', () => {
  const now = 1_700_000_000;
  const event = (type: string, object: Record<string, unknown>) => JSON.stringify({ id: `evt_${type}`, type, data: { object } });
  const session = { id: 'cs_test_1', amount_total: 10000, currency: 'egp', payment_status: 'paid', payment_intent: 'pi_1', client_reference_id: 'pay_ref_1' };

  it('matches the fixed HMAC-SHA256 vector', () => {
    expect(signStripe(STRIPE_SECRET, STRIPE_VECTOR_BODY, 1_700_000_000)).toBe(`t=1700000000,v1=${STRIPE_VECTOR_SIG}`);
    const r = stripeAdapter.verifyWebhook({ webhookSecret: STRIPE_SECRET }, { rawBody: STRIPE_VECTOR_BODY, headers: { 'stripe-signature': `t=1700000000,v1=${STRIPE_VECTOR_SIG}` }, query: {}, nowSeconds: now });
    expect(r.valid).toBe(true);
  });

  it('verifies a valid completed session and normalises the event', () => {
    const raw = event('checkout.session.completed', session);
    const r = stripeAdapter.verifyWebhook({ webhookSecret: STRIPE_SECRET }, { rawBody: Buffer.from(raw), headers: { 'stripe-signature': signStripe(STRIPE_SECRET, raw, now) }, query: {}, nowSeconds: now + 10 });
    expect(r).toMatchObject({ valid: true, eventKey: 'evt_checkout.session.completed' });
    expect(r.event).toMatchObject({ kind: 'payment_succeeded', providerSessionId: 'cs_test_1', providerPaymentId: 'pi_1', reference: 'pay_ref_1', amountMinor: 10000, currency: 'EGP' });
  });

  it('rejects tampered bodies, wrong secrets and expired timestamps', () => {
    const raw = event('checkout.session.completed', session);
    const sig = signStripe(STRIPE_SECRET, raw, now);
    const tampered = raw.replace('10000', '1');
    expect(stripeAdapter.verifyWebhook({ webhookSecret: STRIPE_SECRET }, { rawBody: tampered, headers: { 'stripe-signature': sig }, query: {}, nowSeconds: now }))
      .toMatchObject({ valid: false, reason: 'signature mismatch' });
    expect(stripeAdapter.verifyWebhook({ webhookSecret: 'whsec_other' }, { rawBody: raw, headers: { 'stripe-signature': sig }, query: {}, nowSeconds: now }).valid).toBe(false);
    expect(stripeAdapter.verifyWebhook({ webhookSecret: STRIPE_SECRET }, { rawBody: raw, headers: { 'stripe-signature': sig }, query: {}, nowSeconds: now + 301 }))
      .toMatchObject({ valid: false, reason: 'timestamp outside tolerance' });
    expect(stripeAdapter.verifyWebhook({ webhookSecret: STRIPE_SECRET }, { rawBody: raw, headers: {}, query: {}, nowSeconds: now }).valid).toBe(false);
  });

  it('accepts any of several v1 signatures (secret rotation)', () => {
    const raw = event('checkout.session.expired', { ...session, payment_status: 'unpaid' });
    const good = signStripe(STRIPE_SECRET, raw, now).split('v1=')[1];
    const header = `t=${now},v1=${'0'.repeat(64)},v1=${good},v0=abc`;
    expect(parseStripeSignature(header).v1).toHaveLength(2);
    const r = stripeAdapter.verifyWebhook({ webhookSecret: STRIPE_SECRET }, { rawBody: raw, headers: { 'stripe-signature': header }, query: {}, nowSeconds: now });
    expect(r.event?.kind).toBe('payment_expired');
  });

  it('does not treat an unpaid completed session (async method pending) as success', () => {
    expect(stripeAdapter.parseEvent({ type: 'checkout.session.completed', data: { object: { ...session, payment_status: 'unpaid' } } }).kind).toBe('ignored');
    expect(stripeAdapter.parseEvent({ type: 'checkout.session.async_payment_failed', data: { object: session } }).kind).toBe('payment_failed');
  });

  it('builds the Checkout Session request and the refund request', async () => {
    const f = fakeFetch([{ body: { id: 'cs_test_1', url: 'https://checkout.stripe.com/c/pay/cs_test_1' } }, { body: { id: 're_1', status: 'succeeded' } }]);
    const c = ctx(f.fn, { secretKey: 'sk_test_123' });
    const result = await stripeAdapter.createCheckout(c, checkoutReq);
    expect(result).toEqual({ providerSessionId: 'cs_test_1', redirectUrl: 'https://checkout.stripe.com/c/pay/cs_test_1', raw: { id: 'cs_test_1', expires_at: undefined } });
    const body = new URLSearchParams(String(f.calls[0]!.init.body));
    expect(f.calls[0]!.url).toBe('https://api.stripe.com/v1/checkout/sessions');
    expect((f.calls[0]!.init.headers as any).Authorization).toBe('Bearer sk_test_123');
    expect((f.calls[0]!.init.headers as any)['Idempotency-Key']).toBe('resuto-pay_ref_1');
    expect(body.get('line_items[0][price_data][unit_amount]')).toBe('10000');
    expect(body.get('line_items[0][price_data][currency]')).toBe('egp');
    expect(body.get('client_reference_id')).toBe('pay_ref_1');
    expect(body.get('success_url')).toBe(checkoutReq.returnUrl);
    const refund = await stripeAdapter.refund(c, { providerPaymentId: 'pi_1', amountMinor: 2500, currency: 'EGP', reason: 'cold food', idempotencyKey: 'rf-1' });
    expect(refund).toMatchObject({ status: 'succeeded', providerRefundId: 're_1' });
    const rb = new URLSearchParams(String(f.calls[1]!.init.body));
    expect([rb.get('payment_intent'), rb.get('amount')]).toEqual(['pi_1', '2500']);
    expect((f.calls[1]!.init.headers as any)['Idempotency-Key']).toBe('resuto-refund-rf-1');
  });

  it('refuses live keys on sandbox connections', async () => {
    const f = fakeFetch([]);
    await expect(stripeAdapter.createCheckout(ctx(f.fn, { secretKey: 'sk_live_x' }), checkoutReq)).rejects.toThrow(/test key/);
    expect(f.calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
describe('paymob', () => {
  it('concatenates the 20 documented fields in order and matches the fixed SHA-512 vector', () => {
    expect(PAYMOB_HMAC_FIELDS).toHaveLength(20);
    expect([...PAYMOB_HMAC_FIELDS]).toEqual([...PAYMOB_HMAC_FIELDS].sort());
    expect(paymobHmacPayload(paymobObj())).toBe('100002023-06-13T13:49:23.570621EGPfalsefalse1234567884520truefalsetruefalsefalsefalse987654321234false512345xxxxxx2346MasterCardcardtrue');
    expect(paymobHmac(PAYMOB_SECRET, paymobObj())).toBe(PAYMOB_VECTOR);
  });

  it('verifies a valid callback and rejects a tampered one', () => {
    const raw = JSON.stringify({ type: 'TRANSACTION', obj: paymobObj() });
    const ok = paymobAdapter.verifyWebhook({ hmacSecret: PAYMOB_SECRET }, { rawBody: raw, headers: {}, query: { hmac: PAYMOB_VECTOR } }, { integrationIdCard: 4520 });
    expect(ok.valid).toBe(true);
    expect(ok.event).toMatchObject({ kind: 'payment_succeeded', providerSessionId: '98765432', providerPaymentId: '123456788', reference: 'pay_ref_1', amountMinor: 10000, currency: 'EGP' });
    const tampered = JSON.stringify({ type: 'TRANSACTION', obj: { ...paymobObj(), amount_cents: 100 } });
    expect(paymobAdapter.verifyWebhook({ hmacSecret: PAYMOB_SECRET }, { rawBody: tampered, headers: {}, query: { hmac: PAYMOB_VECTOR } }).valid).toBe(false);
    expect(paymobAdapter.verifyWebhook({ hmacSecret: PAYMOB_SECRET }, { rawBody: raw, headers: {}, query: {} }).valid).toBe(false);
  });

  it('never settles refunds, voids, auth-only, pending or unknown-integration transactions', () => {
    const cfg = { integrationIdCard: 4520 };
    const kind = (patch: Record<string, unknown>) => paymobAdapter.parseEvent({ obj: { ...paymobObj(), ...patch } }, cfg).kind;
    expect(kind({ is_refunded: true })).toBe('ignored');
    expect(kind({ is_voided: true })).toBe('ignored');
    expect(kind({ is_auth: true })).toBe('ignored');
    expect(kind({ pending: true })).toBe('ignored');
    expect(kind({ integration_id: 999 })).toBe('ignored');
    expect(kind({ success: false })).toBe('payment_failed');
  });

  it('builds the intention request, unified checkout URL and refund request', async () => {
    const f = fakeFetch([{ body: { id: 'pi_test', intention_order_id: 98765432, client_secret: 'egy_csk_test' } }, { body: { id: 555, success: true } }]);
    const c = ctx(f.fn, { secretKey: 'egy_sk_test', publicKey: 'egy_pk_test', hmacSecret: PAYMOB_SECRET }, { integrationIdCard: 4520 });
    const r = await paymobAdapter.createCheckout(c, checkoutReq);
    expect(r.providerSessionId).toBe('98765432');
    expect(r.redirectUrl).toBe('https://accept.paymob.com/unifiedcheckout/?publicKey=egy_pk_test&clientSecret=egy_csk_test');
    const body = JSON.parse(String(f.calls[0]!.init.body));
    expect(f.calls[0]!.url).toBe('https://accept.paymob.com/v1/intention/');
    expect((f.calls[0]!.init.headers as any).Authorization).toBe('Token egy_sk_test');
    expect(body).toMatchObject({ amount: 10000, currency: 'EGP', payment_methods: [4520], special_reference: 'pay_ref_1', expiration: 1800, notification_url: checkoutReq.notificationUrl });
    expect(body.items.reduce((s: number, i: any) => s + i.amount * i.quantity, 0)).toBe(10000);
    const refund = await paymobAdapter.refund(c, { providerPaymentId: '123456788', amountMinor: 4000, currency: 'EGP', reason: 'x', idempotencyKey: 'k' });
    expect(refund).toMatchObject({ status: 'succeeded', providerRefundId: '555' });
    expect(f.calls[1]!.url).toBe('https://accept.paymob.com/api/acceptance/void_refund/refund');
    expect(JSON.parse(String(f.calls[1]!.init.body))).toEqual({ transaction_id: '123456788', amount_cents: 4000 });
  });

  it('rejects unknown regions and missing integration ids', async () => {
    const f = fakeFetch([]);
    await expect(paymobAdapter.createCheckout(ctx(f.fn, { secretKey: 's', publicKey: 'p' }, { integrationIdCard: 1, baseUrl: 'https://evil.example' }), checkoutReq)).rejects.toThrow(/region/);
    await expect(paymobAdapter.createCheckout(ctx(f.fn, { secretKey: 's', publicKey: 'p' }, {}), checkoutReq)).rejects.toThrow(/integration id/);
  });
});

// ---------------------------------------------------------------------------
describe('moyasar', () => {
  const payment = { id: 'pay_m_1', status: 'paid', amount: 5750, fee: 150, currency: 'SAR', invoice_id: 'inv_1', metadata: {} };
  const body = (secret: string, type = 'payment_paid') => JSON.stringify({ id: 'evt_m_1', type, secret_token: secret, live: false, data: payment });

  it('verifies the shared secret token in constant time and normalises the payment', () => {
    const ok = moyasarAdapter.verifyWebhook({ webhookSecret: 'moy-secret' }, { rawBody: body('moy-secret'), headers: {}, query: {} });
    expect(ok).toMatchObject({ valid: true, eventKey: 'evt_m_1' });
    expect(ok.event).toMatchObject({ kind: 'payment_succeeded', providerSessionId: 'inv_1', providerPaymentId: 'pay_m_1', amountMinor: 5750, currency: 'SAR', feeMinor: 150 });
    expect(moyasarAdapter.verifyWebhook({ webhookSecret: 'moy-secret' }, { rawBody: body('wrong'), headers: {}, query: {} }).valid).toBe(false);
    expect(moyasarAdapter.verifyWebhook({ webhookSecret: 'moy-secret' }, { rawBody: '{"id":1}', headers: {}, query: {} }).valid).toBe(false);
    expect(moyasarAdapter.parseEvent(JSON.parse(body('x', 'payment_failed'))).kind).toBe('payment_failed');
    expect(moyasarAdapter.parseEvent(JSON.parse(body('x', 'payment_refunded'))).kind).toBe('ignored');
  });

  it('builds invoice and refund requests with Basic auth', async () => {
    const f = fakeFetch([{ body: { id: 'inv_1', status: 'initiated', url: 'https://checkout.moyasar.com/invoices/inv_1' } }, { body: { id: 'pay_m_1', status: 'refunded', refunded: 1000 } }]);
    const c = ctx(f.fn, { secretKey: 'sk_test_moy', webhookSecret: 'x' });
    const r = await moyasarAdapter.createCheckout(c, { ...checkoutReq, currency: 'SAR' });
    expect(r).toMatchObject({ providerSessionId: 'inv_1', redirectUrl: 'https://checkout.moyasar.com/invoices/inv_1' });
    expect((f.calls[0]!.init.headers as any).Authorization).toBe(`Basic ${Buffer.from('sk_test_moy:').toString('base64')}`);
    expect(JSON.parse(String(f.calls[0]!.init.body))).toMatchObject({ amount: 10000, currency: 'SAR', callback_url: checkoutReq.notificationUrl, success_url: checkoutReq.returnUrl, metadata: { resuto_payment_id: 'pay_ref_1' } });
    const refund = await moyasarAdapter.refund(c, { providerPaymentId: 'pay_m_1', amountMinor: 1000, currency: 'SAR', reason: 'x', idempotencyKey: 'k' });
    expect(refund.status).toBe('succeeded');
    expect(f.calls[1]!.url).toBe('https://api.moyasar.com/v1/payments/pay_m_1/refund');
  });

  it('reads invoice status server-side', async () => {
    const f = fakeFetch([{ body: { id: 'inv_1', status: 'paid', amount: 5750, currency: 'SAR', payments: [payment] } }]);
    const ev = await moyasarAdapter.retrieveStatus(ctx(f.fn, { secretKey: 'sk_test_moy' }), { providerSessionId: 'inv_1', reference: 'r' });
    expect(ev).toMatchObject({ kind: 'payment_succeeded', providerPaymentId: 'pay_m_1', amountMinor: 5750 });
  });
});

// ---------------------------------------------------------------------------
describe('simulated sandbox provider', () => {
  const secret = 'sandbox-secret-1';
  const payload = JSON.stringify({ id: 'evt_sim_1', type: 'payment.succeeded', created: 1_700_000_000, livemode: false,
    data: { session_id: 'sim_cs_1', payment_id: 'sim_pay_1', reference: 'pay_ref_1', amount_minor: 4200, currency: 'EGP', fee_minor: 0 } });

  it('signs and verifies through the same scheme as real providers', () => {
    const sig = signSimulated(secret, payload, 1_700_000_000);
    const ok = simulatedAdapter.verifyWebhook({ webhookSecret: secret }, { rawBody: payload, headers: { 'x-resuto-sandbox-signature': sig }, query: {}, nowSeconds: 1_700_000_100 });
    expect(ok.event).toMatchObject({ kind: 'payment_succeeded', reference: 'pay_ref_1', amountMinor: 4200 });
    expect(simulatedAdapter.verifyWebhook({ webhookSecret: secret }, { rawBody: payload.replace('4200', '4300'), headers: { 'x-resuto-sandbox-signature': sig }, query: {}, nowSeconds: 1_700_000_100 }).valid).toBe(false);
    expect(simulatedAdapter.verifyWebhook({ webhookSecret: secret }, { rawBody: payload, headers: { 'x-resuto-sandbox-signature': sig }, query: {}, nowSeconds: 1_700_000_400 }).reason).toBe('timestamp outside tolerance');
    expect(simulatedAdapter.verifyWebhook({ webhookSecret: 'other' }, { rawBody: payload, headers: { 'x-resuto-sandbox-signature': sig }, query: {}, nowSeconds: 1_700_000_000 }).valid).toBe(false);
  });

  it('opens a provider-side session and redirects to the labelled test page', async () => {
    const opened: unknown[] = [];
    const store: SimulatedStore = { get: async () => null, open: async (x) => { opened.push(x); }, refund: async () => ({ error: 'n/a' }), list: async () => [] };
    const r = await simulatedAdapter.createCheckout({ environment: 'sandbox', credentials: {}, config: { store, sandboxPageUrl: 'https://app.test/pay/tok/sandbox' }, fetch }, checkoutReq);
    expect(r.redirectUrl).toMatch(/^https:\/\/app\.test\/pay\/tok\/sandbox\?session=sim_cs_[0-9a-f]{24}$/);
    expect(opened).toEqual([{ providerSessionId: r.providerSessionId, reference: 'pay_ref_1', amountMinor: 10000, currency: 'EGP' }]);
    await expect(simulatedAdapter.createCheckout({ environment: 'live', credentials: {}, config: { store, sandboxPageUrl: 'x' }, fetch }, checkoutReq)).rejects.toThrow(/sandbox/);
  });
});
