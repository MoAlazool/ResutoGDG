import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { AdapterContext } from '../core';
import { PAYMENT_ADAPTERS, paymentAdapter } from './index';
import { moyasarAdapter, MOYASAR_EVENTS } from './moyasar';
import { PAYMOB_HMAC_FIELDS, paymobAdapter, paymobCredentialEnvironment, paymobHmac, paymobHmacPayload } from './paymob';
import { hexDigestEquals, secretEquals } from './signature';
import { signSimulated, simulatedAdapter, type SimulatedStore } from './simulated';
import { parseStripeSignature, STRIPE_API_VERSION, stripeAdapter } from './stripe';
import { redactProviderPayload } from './types';

// ---------------------------------------------------------------------------
// Fixed vectors. None of these are produced by the code under test: each was
// computed with the openssl CLI (command next to it) or copied from the
// provider's published documentation.
// ---------------------------------------------------------------------------

// Paymob's official sample transaction (developers.paymob.com/paymob-docs/developers/webhook-callbacks-and-hmac/hmac/hmac-transaction-callback,
// fetched 2026-10-20) and the concatenated string the page publishes for it.
const PAYMOB_DOCS_SAMPLE = {
  id: 192036465, pending: false, amount_cents: 100000, success: true, is_auth: false, is_capture: false, is_standalone_payment: true,
  is_voided: false, is_refunded: false, is_3d_secure: true, integration_id: 4097558, has_parent_transaction: false,
  order: { id: 217503754, merchant_order_id: null }, created_at: '2024-06-13T11:33:44.592345', currency: 'EGP',
  source_data: { pan: '2346', type: 'card', sub_type: 'MasterCard' }, api_source: 'IFRAME', error_occured: false, is_live: false, owner: 302852,
};
const PAYMOB_DOCS_CONCAT = '1000002024-06-13T11:33:44.592345EGPfalsefalse1920364654097558truefalsefalsefalsetruefalse217503754302852false2346MasterCardcardtrue';
// printf '%s' "$PAYMOB_DOCS_CONCAT" | openssl dgst -sha512 -hmac 'PAYMOB_DOCS_SAMPLE_SECRET'
const PAYMOB_DOCS_SECRET = 'PAYMOB_DOCS_SAMPLE_SECRET';
const PAYMOB_DOCS_HMAC = '1629f985f9178a11727637681e6d64b039792a202da86a35d32674059466b2a07b2c7e3cf21af0387cff923282c3fb01326343627097f27ac137ed3f8baada0c';

// printf '%s' '1700000000.<STRIPE_VECTOR_BODY>' | openssl dgst -sha256 -hmac 'whsec_test_secret'
const STRIPE_SECRET = 'whsec_test_secret';
const STRIPE_VECTOR_BODY = '{"id":"evt_1","type":"checkout.session.completed","livemode":false,"data":{"object":{"id":"cs_test_1","amount_total":10000,"currency":"egp","payment_status":"paid","payment_intent":"pi_1","client_reference_id":"pay_ref_1"}}}';
const STRIPE_VECTOR_SIG = 'b51e717bd17303b19996512914ec8675261f8724f7b4ff7441b708397180c7f8';

// printf '%s' '100002023-06-13T13:49:23.570621EGPfalsefalse1234567884520truefalsetruefalsefalsefalse987654321234false512345xxxxxx2346MasterCardcardtrue' | openssl dgst -sha512 -hmac 'PAYMOB_HMAC_TEST'
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
const PAYMOB_TEST = { secretKey: 'egy_sk_test_abc', publicKey: 'egy_pk_test_abc', hmacSecret: PAYMOB_SECRET, apiKey: 'api-key' };
const PAYMOB_LIVE = { secretKey: 'egy_sk_live_abc', publicKey: 'egy_pk_live_abc', hmacSecret: PAYMOB_SECRET, apiKey: 'api-key' };

// ---------------------------------------------------------------------------
describe('signature hygiene (PAY-15)', () => {
  it('accepts either hex case, rejects wrong length, non-hex and non-strings before comparing', () => {
    const hex = 'ab'.repeat(32);
    expect(hexDigestEquals(hex, hex.toUpperCase(), 32)).toBe(true);
    expect(hexDigestEquals(hex, hex.slice(2), 32)).toBe(false);
    expect(hexDigestEquals(hex, `${hex}00`, 32)).toBe(false);
    expect(hexDigestEquals(hex, 'zz'.repeat(32), 32)).toBe(false);
    expect(hexDigestEquals(hex, undefined, 32)).toBe(false);
    expect(secretEquals('moy-secret', 'moy-secret')).toBe(true);
    expect(secretEquals('moy-secret', 'moy-secreT')).toBe(false);
    expect(secretEquals('moy-secret', '')).toBe(false);
    expect(secretEquals('moy-secret', 42)).toBe(false);
  });

  it('provider lookup ignores prototype keys (PAY-18)', () => {
    for (const k of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) expect(paymentAdapter(k)).toBeNull();
    expect(paymentAdapter('stripe')).toBe(stripeAdapter);
    expect(Object.keys(PAYMENT_ADAPTERS).sort()).toEqual(['moyasar', 'paymob', 'simulated', 'stripe']);
  });
});

// ---------------------------------------------------------------------------
describe('stripe', () => {
  const now = 1_700_000_000;
  const event = (type: string, object: Record<string, unknown>, livemode = false) => JSON.stringify({ id: `evt_${type}`, type, livemode, data: { object } });
  const session = { id: 'cs_test_1', amount_total: 10000, currency: 'egp', payment_status: 'paid', payment_intent: 'pi_1', client_reference_id: 'pay_ref_1' };
  const verify = (raw: string, sig: string, at = now, secret = STRIPE_SECRET) =>
    stripeAdapter.verifyWebhook({ webhookSecret: secret }, { rawBody: raw, headers: { 'stripe-signature': sig }, query: {}, nowSeconds: at });

  it('accepts the openssl-computed vector and normalises it (with livemode evidence)', () => {
    const r = verify(STRIPE_VECTOR_BODY, `t=1700000000,v1=${STRIPE_VECTOR_SIG}`);
    expect(r).toMatchObject({ valid: true, eventKey: 'evt_1' });
    expect(r.event).toMatchObject({ kind: 'payment_succeeded', providerSessionId: 'cs_test_1', providerPaymentId: 'pi_1', reference: 'pay_ref_1', amountMinor: 10000, currency: 'EGP', livemode: false });
    expect(verify(STRIPE_VECTOR_BODY, `t=1700000000,v1=${STRIPE_VECTOR_SIG.toUpperCase()}`).valid).toBe(true);
  });

  it('rejects tampered bodies, wrong secrets, stale timestamps, malformed and missing signatures', () => {
    const sig = `t=1700000000,v1=${STRIPE_VECTOR_SIG}`;
    expect(verify(STRIPE_VECTOR_BODY.replace('10000', '1'), sig)).toMatchObject({ valid: false, reason: 'signature mismatch' });
    expect(verify(STRIPE_VECTOR_BODY, sig, now, 'whsec_other').valid).toBe(false);
    expect(verify(STRIPE_VECTOR_BODY, sig, now + 301)).toMatchObject({ valid: false, reason: 'timestamp outside tolerance' });
    expect(verify(STRIPE_VECTOR_BODY, `t=1700000000,v1=${STRIPE_VECTOR_SIG.slice(0, 40)}`)).toMatchObject({ valid: false, reason: 'malformed signature' });
    expect(verify(STRIPE_VECTOR_BODY, '')).toMatchObject({ valid: false, reason: 'missing signature' });
    expect(stripeAdapter.verifyWebhook({}, { rawBody: STRIPE_VECTOR_BODY, headers: { 'stripe-signature': sig }, query: {}, nowSeconds: now })).toMatchObject({ valid: false, reason: 'webhook secret not configured' });
  });

  it('accepts any of several v1 signatures (secret rotation) and parses the header strictly', () => {
    const header = `t=${now},v1=${'0'.repeat(64)},v1=${STRIPE_VECTOR_SIG},v0=abc`;
    expect(parseStripeSignature(header).v1).toHaveLength(2);
    expect(parseStripeSignature('t=12abc,v1=x').t).toBeNull();
    expect(verify(STRIPE_VECTOR_BODY, header).event?.kind).toBe('payment_succeeded');
  });

  it('maps session, refund and dispute events; unpaid completion is not success', () => {
    const k = (type: string, o: any) => stripeAdapter.parseEvent({ id: 'e', type, livemode: true, data: { object: o } });
    expect(k('checkout.session.completed', { ...session, payment_status: 'unpaid' }).kind).toBe('ignored');
    expect(k('checkout.session.async_payment_failed', session)).toMatchObject({ kind: 'payment_failed', failureReason: 'async_payment_failed' });
    expect(k('checkout.session.expired', session)).toMatchObject({ kind: 'payment_expired', livemode: true });
    expect(k('charge.refunded', { id: 'ch_1', payment_intent: 'pi_1', amount: 10000, amount_refunded: 2500, currency: 'egp' }))
      .toMatchObject({ kind: 'payment_refunded', providerPaymentId: 'pi_1', refundedMinor: 2500, needsConfirmation: true });
    expect(k('refund.updated', { id: 're_1', payment_intent: 'pi_1', status: 'succeeded', amount: 2500, currency: 'egp' }))
      .toMatchObject({ kind: 'payment_refunded', providerRefundId: 're_1', needsConfirmation: true });
    expect(k('charge.dispute.created', { id: 'dp_1', payment_intent: 'pi_1', amount: 10000, status: 'needs_response', currency: 'egp' }))
      .toMatchObject({ kind: 'dispute_opened', disputeId: 'dp_1' });
  });

  it('rejects events without livemode (environment evidence is mandatory)', () => {
    const raw = JSON.stringify({ id: 'evt_x', type: 'checkout.session.completed', data: { object: session } });
    const sig = `t=${now},v1=${createHmac('sha256', STRIPE_SECRET).update(`${now}.${raw}`).digest('hex')}`;
    expect(verify(raw, sig)).toMatchObject({ valid: false, reason: 'malformed payload' });
  });

  it('pins the API version, uses allowed_payment_method_types, caps expiry at 24 h and sends a stable refund key', async () => {
    const f = fakeFetch([{ body: { id: 'cs_test_1', url: 'https://checkout.stripe.com/c/pay/cs_test_1', livemode: false } }, { body: { id: 're_1', status: 'succeeded' } }]);
    const c = ctx(f.fn, { secretKey: 'sk_test_123', webhookSecret: 'whsec_1' });
    const before = Math.floor(Date.now() / 1000);
    const result = await stripeAdapter.createCheckout(c, { ...checkoutReq, expiresInSeconds: 7 * 24 * 3600 });
    expect(result).toMatchObject({ providerSessionId: 'cs_test_1', redirectUrl: 'https://checkout.stripe.com/c/pay/cs_test_1' });
    const body = new URLSearchParams(String(f.calls[0]!.init.body));
    const headers = f.calls[0]!.init.headers as any;
    expect(f.calls[0]!.url).toBe('https://api.stripe.com/v1/checkout/sessions');
    expect(headers.Authorization).toBe('Bearer sk_test_123');
    expect(headers['Stripe-Version']).toBe(STRIPE_API_VERSION);
    expect(headers['Idempotency-Key']).toBe('resuto-pay_ref_1');
    expect(body.get('allowed_payment_method_types[0]')).toBe('card');
    expect(body.has('payment_method_types[0]')).toBe(false); // removed in 2026-09-30.endive
    expect(Number(body.get('expires_at')) - before).toBeLessThanOrEqual(24 * 3600);
    expect(body.get('client_reference_id')).toBe('pay_ref_1');
    const refund = await stripeAdapter.refund(c, { providerPaymentId: 'pi_1', amountMinor: 2500, currency: 'EGP', reason: 'cold food', idempotencyKey: 'pay1:r1' });
    expect(refund).toMatchObject({ status: 'succeeded', providerRefundId: 're_1' });
    const rb = new URLSearchParams(String(f.calls[1]!.init.body));
    expect([rb.get('payment_intent'), rb.get('amount'), rb.get('metadata[resuto_refund_key]')]).toEqual(['pi_1', '2500', 'pay1:r1']);
    expect((f.calls[1]!.init.headers as any)['Idempotency-Key']).toBe('resuto-refund-pay1:r1');
  });

  it('separates test and live keys in both directions (PAY-02)', async () => {
    const f = fakeFetch([]);
    await expect(stripeAdapter.createCheckout(ctx(f.fn, { secretKey: 'sk_live_x' }), checkoutReq)).rejects.toThrow(/test key/);
    await expect(stripeAdapter.createCheckout(ctx(f.fn, { secretKey: 'sk_test_x' }, {}, 'live'), checkoutReq)).rejects.toThrow(/live key/);
    await expect(stripeAdapter.createCheckout(ctx(f.fn, { secretKey: 'pk_test_x' }), checkoutReq)).rejects.toThrow(/Unrecognised/);
    expect(f.calls).toHaveLength(0);
    expect(stripeAdapter.credentialEnvironment({ secretKey: 'rk_live_1' })).toBe('live');
    expect(stripeAdapter.credentialEnvironment({ secretKey: 'whsec_1' })).toBeNull();
  });

  it('confirms refund events through the payment intent: cumulative refund and the Resuto payment from its metadata', async () => {
    const f = fakeFetch([{ body: { id: 'pi_1', amount: 10000, currency: 'egp', livemode: false, metadata: { resuto_payment_id: 'pay_ref_1' }, latest_charge: { id: 'ch_1', amount_refunded: 3000 } } }]);
    const c = ctx(f.fn, { secretKey: 'sk_test_1', webhookSecret: 'whsec_1' });
    const ev = stripeAdapter.parseEvent({ id: 'e', type: 'charge.refunded', livemode: false, data: { object: { id: 'ch_1', payment_intent: 'pi_1', amount: 10000, amount_refunded: 9999, currency: 'egp' } } });
    expect(await stripeAdapter.confirmEvent!(c, ev)).toMatchObject({ kind: 'payment_refunded', refundedMinor: 3000, reference: 'pay_ref_1', needsConfirmation: false });
    expect(f.calls[0]!.url).toBe('https://api.stripe.com/v1/payment_intents/pi_1?expand[]=latest_charge');
  });

  it('expires sessions, resolves refunds by key and reports the account', async () => {
    const f = fakeFetch([
      { body: { id: 'cs_1', status: 'expired' } },
      { status: 400, body: { error: { message: 'Only Checkout Sessions with a status in [open] can be expired.' } } },
      { body: { data: [{ id: 're_a', status: 'succeeded', metadata: { resuto_refund_key: 'other' } }, { id: 're_b', status: 'pending', metadata: { resuto_refund_key: 'pay1:r1' } }] } },
      { body: { data: [] } },
      { body: { id: 'acct_1', country: 'AE', default_currency: 'aed', charges_enabled: true, settings: { dashboard: { display_name: 'Olive Room' } } } },
    ]);
    const c = ctx(f.fn, { secretKey: 'sk_test_1', webhookSecret: 'whsec_1' });
    expect(await stripeAdapter.cancelCheckout!(c, { providerSessionId: 'cs_1' })).toBe('cancelled');
    expect(f.calls[0]!.url).toBe('https://api.stripe.com/v1/checkout/sessions/cs_1/expire');
    expect(await stripeAdapter.cancelCheckout!(c, { providerSessionId: 'cs_2' })).toBe('already_completed');
    const req = { providerPaymentId: 'pi_1', amountMinor: 100, currency: 'EGP', reason: 'x', idempotencyKey: 'pay1:r1' };
    expect(await stripeAdapter.refundStatus(c, req)).toMatchObject({ status: 'pending', providerRefundId: 're_b' });
    expect(await stripeAdapter.refundStatus(c, req)).toEqual({ status: 'not_found' });
    expect(await stripeAdapter.healthCheck(c)).toMatchObject({ ok: true, environment: 'sandbox', account: { id: 'acct_1', name: 'Olive Room', country: 'AE', currency: 'AED' } });
  });
});

// ---------------------------------------------------------------------------
describe('paymob', () => {
  it('matches Paymob\'s published sample concatenation and an openssl HMAC of it', () => {
    expect(PAYMOB_HMAC_FIELDS).toHaveLength(20);
    expect([...PAYMOB_HMAC_FIELDS]).toEqual([...PAYMOB_HMAC_FIELDS].sort());
    expect(paymobHmacPayload(PAYMOB_DOCS_SAMPLE)).toBe(PAYMOB_DOCS_CONCAT);
    expect(paymobHmac(PAYMOB_DOCS_SECRET, PAYMOB_DOCS_SAMPLE)).toBe(PAYMOB_DOCS_HMAC);
    const raw = JSON.stringify({ type: 'TRANSACTION', obj: PAYMOB_DOCS_SAMPLE });
    const r = paymobAdapter.verifyWebhook({ hmacSecret: PAYMOB_DOCS_SECRET }, { rawBody: raw, headers: {}, query: { hmac: PAYMOB_DOCS_HMAC.toUpperCase() } }, { integrationIdCard: 4097558 });
    expect(r).toMatchObject({ valid: true, event: { kind: 'payment_succeeded', providerSessionId: '217503754', providerPaymentId: '192036465', reference: null, livemode: null } });
  });

  it('matches the second openssl vector', () => {
    expect(paymobHmacPayload(paymobObj())).toBe('100002023-06-13T13:49:23.570621EGPfalsefalse1234567884520truefalsetruefalsefalsefalse987654321234false512345xxxxxx2346MasterCardcardtrue');
    expect(paymobHmac(PAYMOB_SECRET, paymobObj())).toBe(PAYMOB_VECTOR);
  });

  it('never trusts unsigned fields: merchant_order_id is only a claimed reference, is_live is not evidence (PAY-01)', () => {
    const tampered = { ...paymobObj(), is_live: true, order: { id: 98765432, merchant_order_id: '11111111-2222-3333-4444-555555555555' } };
    const r = paymobAdapter.verifyWebhook({ hmacSecret: PAYMOB_SECRET }, { rawBody: JSON.stringify({ obj: tampered }), headers: {}, query: { hmac: PAYMOB_VECTOR } }, { integrationIdCard: 4520 });
    expect(r.valid).toBe(true); // unsigned fields can change without breaking the HMAC …
    expect(r.event).toMatchObject({ reference: null, claimedReference: '11111111-2222-3333-4444-555555555555', providerSessionId: '98765432', livemode: null }); // … so they never select the payment
  });

  it('fails closed without integration ids and ignores other integrations of the same account (PAY-02)', () => {
    const raw = JSON.stringify({ type: 'TRANSACTION', obj: paymobObj() });
    const v = (config: Record<string, unknown>, hmac = PAYMOB_VECTOR) => paymobAdapter.verifyWebhook({ hmacSecret: PAYMOB_SECRET }, { rawBody: raw, headers: {}, query: { hmac } }, config);
    expect(v({})).toMatchObject({ valid: false, reason: 'integration ids not configured' });
    expect(v({ integrationIdCard: 999 })).toMatchObject({ valid: true, event: { kind: 'ignored', failureReason: 'unknown_integration' } });
    expect(v({ integrationIdCard: 4520 }).event?.kind).toBe('payment_succeeded');
    expect(v({ integrationIdCard: 4520 }, PAYMOB_VECTOR.slice(0, 64))).toMatchObject({ valid: false, reason: 'malformed signature' });
    expect(v({ integrationIdCard: 4520 }, 'f'.repeat(128))).toMatchObject({ valid: false, reason: 'signature mismatch' });
    expect(paymobAdapter.verifyWebhook({ hmacSecret: PAYMOB_SECRET }, { rawBody: '{"obj":{"id":1}}', headers: {}, query: { hmac: PAYMOB_VECTOR } }, { integrationIdCard: 4520 }))
      .toMatchObject({ valid: false, reason: 'malformed payload' });
    expect(paymobAdapter.verifyWebhook({}, { rawBody: raw, headers: {}, query: { hmac: PAYMOB_VECTOR } }, { integrationIdCard: 4520 })).toMatchObject({ valid: false, reason: 'hmac secret not configured' });
  });

  it('classifies lifecycle callbacks; refunds and voids need an authenticated re-read (PAY-11)', () => {
    const cfg = { integrationIdCard: 4520 };
    const ev = (patch: Record<string, unknown>) => paymobAdapter.parseEvent({ obj: { ...paymobObj(), ...patch } }, cfg);
    expect(ev({ is_refunded: true })).toMatchObject({ kind: 'payment_refunded', needsConfirmation: true, refundedMinor: null });
    expect(ev({ is_voided: true })).toMatchObject({ kind: 'payment_voided', needsConfirmation: true });
    expect(ev({ is_auth: true, is_capture: false })).toMatchObject({ kind: 'payment_authorized' });
    expect(ev({ pending: true }).kind).toBe('ignored');
    expect(ev({ integration_id: 999 }).kind).toBe('ignored');
    expect(ev({ success: false, data: { message: 'Do not honour <script>' } })).toMatchObject({ kind: 'payment_failed', failureReason: 'declined', providerMessage: 'Do not honour <script>' });
    expect(ev({ has_parent_transaction: true, is_capture: false })).toMatchObject({ kind: 'payment_refunded', needsConfirmation: true });
  });

  it('includes refunded_amount_cents in the event key so a second partial refund is not deduplicated', () => {
    const verify = (obj: any) => paymobAdapter.verifyWebhook({ hmacSecret: PAYMOB_SECRET }, { rawBody: JSON.stringify({ obj }), headers: {}, query: { hmac: paymobHmac(PAYMOB_SECRET, obj) } }, { integrationIdCard: 4520 });
    const a = verify({ ...paymobObj(), is_refunded: true, refunded_amount_cents: 2000 });
    const b = verify({ ...paymobObj(), is_refunded: true, refunded_amount_cents: 5000 });
    expect(a.eventKey).not.toBe(b.eventKey);
  });

  it('builds the event key from signed fields only: unsigned variants of one transaction share it (review F3)', () => {
    const verify = (obj: any, hmacOf: any = obj) => paymobAdapter.verifyWebhook({ hmacSecret: PAYMOB_SECRET }, { rawBody: JSON.stringify({ obj }), headers: {}, query: { hmac: paymobHmac(PAYMOB_SECRET, hmacOf) } }, { integrationIdCard: 4520 });
    const base = paymobObj();
    const genuine = verify(base);
    expect(genuine.valid).toBe(true);
    // Same hmac, unsigned fields changed (the payer sees the signed fields + hmac on the GET redirect).
    for (const variant of [{ ...base, data: { message: 'Approved 2' } }, { ...base, is_live: true }, { ...base, order: { ...base.order, merchant_order_id: 'x' } }]) {
      const v = verify(variant, base);
      expect(v.valid).toBe(true);
      expect(v.eventKey).toBe(genuine.eventKey);
    }
    // A different signed state of the same transaction is a different event.
    const voided = { ...base, is_voided: true };
    expect(verify(voided).eventKey).not.toBe(genuine.eventKey);
    expect(genuine.eventKey).toMatch(new RegExp(`^txn:${base.id}:[0-9a-f]{32}$`));
  });

  it('derives the environment from the keys and fails closed on mixed or unknown keys', () => {
    expect(paymobCredentialEnvironment(PAYMOB_TEST)).toBe('sandbox');
    expect(paymobCredentialEnvironment(PAYMOB_LIVE)).toBe('live');
    expect(paymobCredentialEnvironment({ ...PAYMOB_TEST, publicKey: 'egy_pk_live_abc' })).toBeNull();
    expect(paymobCredentialEnvironment({ secretKey: 'random', publicKey: 'random' })).toBeNull();
  });

  it('builds the intention request (short expiry), checkout URL and refund request', async () => {
    const f = fakeFetch([{ body: { id: 'pi_test', intention_order_id: 98765432, client_secret: 'egy_csk_test' } }, { body: { id: 555, success: true } }]);
    const c = ctx(f.fn, PAYMOB_TEST, { integrationIdCard: 4520 });
    const r = await paymobAdapter.createCheckout(c, { ...checkoutReq, expiresInSeconds: 86_400 });
    expect(r.providerSessionId).toBe('98765432');
    expect(r.redirectUrl).toBe('https://accept.paymob.com/unifiedcheckout/?publicKey=egy_pk_test_abc&clientSecret=egy_csk_test');
    const body = JSON.parse(String(f.calls[0]!.init.body));
    expect(f.calls[0]!.url).toBe('https://accept.paymob.com/v1/intention/');
    expect((f.calls[0]!.init.headers as any).Authorization).toBe('Token egy_sk_test_abc');
    expect(body).toMatchObject({ amount: 10000, currency: 'EGP', payment_methods: [4520], special_reference: 'pay_ref_1', expiration: 1800, notification_url: checkoutReq.notificationUrl });
    const refund = await paymobAdapter.refund(c, { providerPaymentId: '123456788', amountMinor: 4000, currency: 'EGP', reason: 'x', idempotencyKey: 'k' });
    expect(refund).toMatchObject({ status: 'succeeded', providerRefundId: '555' });
    expect(f.calls[1]!.url).toBe('https://accept.paymob.com/api/acceptance/void_refund/refund');
    expect(JSON.parse(String(f.calls[1]!.init.body))).toEqual({ transaction_id: '123456788', amount_cents: 4000 });
  });

  it('never calls an undocumented transaction-listing endpoint: reconciliation uses the settlement CSV (INT-19)', async () => {
    const f = fakeFetch([]);
    await expect(paymobAdapter.listTransactions(ctx(f.fn, { secretKey: 'egy_sk_test_x', publicKey: 'egy_pk_test_x', apiKey: 'k' }), { from: new Date(0), to: new Date() }))
      .rejects.toThrow(/settlement CSV/);
    expect(f.calls).toHaveLength(0);
    expect(paymobAdapter.setup.capabilities.transaction_listing!.implemented).toBe(false);
  });

  it('refuses live keys on a test connection, unknown regions and missing integration ids', async () => {
    const f = fakeFetch([]);
    await expect(paymobAdapter.createCheckout(ctx(f.fn, PAYMOB_LIVE, { integrationIdCard: 1 }), checkoutReq)).rejects.toThrow(/test connection has live keys/);
    await expect(paymobAdapter.createCheckout(ctx(f.fn, PAYMOB_TEST, { integrationIdCard: 1, baseUrl: 'https://evil.example' }), checkoutReq)).rejects.toThrow(/region/);
    await expect(paymobAdapter.createCheckout(ctx(f.fn, PAYMOB_TEST, {}), checkoutReq)).rejects.toThrow(/integration id/);
    expect(f.calls).toHaveLength(0);
  });

  it('confirms refunds and resolves refund status through the authenticated inquiry, checking is_live', async () => {
    const inquiry = { ...paymobObj(), is_refunded: true, refunded_amount_cents: 4000, is_live: false, order: { id: 98765432, merchant_order_id: 'pay_ref_1' } };
    const f = fakeFetch([
      { body: { token: 't1', profile: { id: 77 } } }, { body: inquiry },
      { body: { token: 't2' } }, { body: inquiry },
      { body: { token: 't3' } }, { body: { ...inquiry, is_live: true } },
    ]);
    const c = ctx(f.fn, PAYMOB_TEST, { integrationIdCard: 4520 });
    const confirmed = await paymobAdapter.confirmEvent!(c, { kind: 'payment_refunded', providerSessionId: '98765432', needsConfirmation: true });
    expect(confirmed).toMatchObject({ kind: 'payment_refunded', refundedMinor: 4000, reference: 'pay_ref_1', livemode: false, needsConfirmation: false });
    expect(f.calls[1]!.url).toBe('https://accept.paymob.com/api/ecommerce/orders/transaction_inquiry');
    expect((f.calls[1]!.init.headers as any).Authorization).toBe('Bearer t1');
    expect(await paymobAdapter.refundStatus(c, { providerPaymentId: '123456788', providerSessionId: '98765432', amountMinor: 4000, currency: 'EGP', reason: 'x', idempotencyKey: 'k', ledgerRefundedMinor: 0 }))
      .toMatchObject({ status: 'succeeded', providerRefundedMinor: 4000 });
    await expect(paymobAdapter.retrieveStatus(c, { providerSessionId: '98765432', reference: 'pay_ref_1' })).rejects.toThrow(/live transaction for a test connection/);
  });
});

// ---------------------------------------------------------------------------
describe('moyasar', () => {
  // Shape from docs.moyasar.com/api/other/webhooks/webhook-reference
  const payment = { id: 'pay_m_1', status: 'paid', amount: 5750, fee: 150, currency: 'SAR', invoice_id: 'inv_1', refunded: 0, metadata: { resuto_payment_id: 'pay_ref_1' } };
  const body = (secret: string, type = 'payment_paid', extra: Record<string, unknown> = {}) =>
    JSON.stringify({ id: 'evt_m_1', type, created_at: '2026-10-20T10:00:00Z', secret_token: secret, account_name: 'Olive Room', live: false, data: payment, ...extra });
  const verify = (raw: string) => moyasarAdapter.verifyWebhook({ webhookSecret: 'moy-secret' }, { rawBody: raw, headers: {}, query: {} });

  it('treats a correct token as a hint only; the payment must be fetched before it counts (PAY-04)', () => {
    const ok = verify(body('moy-secret'));
    expect(ok).toMatchObject({ valid: true, eventKey: 'evt_m_1:pay_m_1:false' });
    expect(ok.event).toMatchObject({ kind: 'ignored', needsConfirmation: true, providerPaymentId: 'pay_m_1', livemode: false, accountName: 'Olive Room' });
    expect(verify(body('wrong'))).toMatchObject({ valid: false, reason: 'signature mismatch' });
    // The key covers what is fetched and the environment flag, so a variant naming another payment is another event.
    expect(verify(body('moy-secret', 'payment_paid', { data: { ...payment, id: 'pay_other' } })).eventKey).toBe('evt_m_1:pay_other:false');
    expect(verify(body('moy-secret', 'payment_paid', { account_name: 'changed' })).eventKey).toBe('evt_m_1:pay_m_1:false');
    expect(verify(body(''))).toMatchObject({ valid: false });
    expect(verify('{"id":1}')).toMatchObject({ valid: false, reason: 'malformed payload' });
    expect(verify('not json')).toMatchObject({ valid: false, reason: 'malformed payload' });
  });

  it('knows both documented spellings of the failure event and the lifecycle events', () => {
    expect(MOYASAR_EVENTS.failed).toEqual(['payment_failed', 'payment_faild']);
    for (const t of ['payment_faild', 'payment_failed', 'payment_captured', 'payment_refunded', 'payment_voided', 'payment_authorized']) {
      expect(moyasarAdapter.parseEvent(JSON.parse(body('x', t))).needsConfirmation).toBe(true);
    }
    expect(moyasarAdapter.parseEvent(JSON.parse(body('x', 'card_auth_authenticated'))).needsConfirmation).toBe(false);
  });

  it('never keeps the secret token in stored payloads (INT-10)', () => {
    const stored = moyasarAdapter.redactPayload(JSON.parse(body('moy-secret')));
    expect(JSON.stringify(stored)).not.toContain('moy-secret');
    expect(stored).toMatchObject({ id: 'evt_m_1', type: 'payment_paid', data: { id: 'pay_m_1', amount: 5750 } });
  });

  it('confirms by fetching the payment with the secret key and applies only the server answer', async () => {
    const f = fakeFetch([
      { body: { ...payment, amount: 5750, status: 'paid' } },
      { body: { ...payment, status: 'refunded', refunded: 1000 } },
      { body: { ...payment, status: 'authorized' } },
      { body: { ...payment, status: 'captured', captured: 5000 } },
    ]);
    const c = ctx(f.fn, { secretKey: 'sk_test_moy', webhookSecret: 'moy-secret' });
    const hint = moyasarAdapter.parseEvent(JSON.parse(body('x', 'payment_paid', { data: { ...payment, amount: 1 } }))); // body claims amount 1
    const paid = await moyasarAdapter.confirmEvent!(c, hint);
    expect(paid).toMatchObject({ kind: 'payment_succeeded', amountMinor: 5750, reference: 'pay_ref_1', providerSessionId: 'inv_1', livemode: false });
    expect(f.calls[0]!.url).toBe('https://api.moyasar.com/v1/payments/pay_m_1');
    expect((f.calls[0]!.init.headers as any).Authorization).toBe(`Basic ${Buffer.from('sk_test_moy:').toString('base64')}`);
    expect(await moyasarAdapter.confirmEvent!(c, hint)).toMatchObject({ kind: 'payment_refunded', refundedMinor: 1000 });
    expect((await moyasarAdapter.confirmEvent!(c, hint)).kind).toBe('payment_authorized');
    expect(await moyasarAdapter.confirmEvent!(c, hint)).toMatchObject({ kind: 'payment_succeeded', amountMinor: 5000 });
    // A webhook that says live for a test connection is refused before any fetch.
    await expect(moyasarAdapter.confirmEvent!(c, { ...hint, livemode: true })).rejects.toThrow(/live/);
  });

  it('separates test and live keys, enforces the 100 minimum and never sends the webhook URL as callback_url (INT-09)', async () => {
    const f = fakeFetch([{ body: { id: 'inv_1', status: 'initiated', url: 'https://checkout.moyasar.com/invoices/inv_1' } }]);
    await expect(moyasarAdapter.createCheckout(ctx(f.fn, { secretKey: 'sk_test_moy' }, {}, 'live'), { ...checkoutReq, currency: 'SAR' })).rejects.toThrow(/live key/);
    await expect(moyasarAdapter.createCheckout(ctx(f.fn, { secretKey: 'sk_live_moy' }), { ...checkoutReq, currency: 'SAR' })).rejects.toThrow(/test key/);
    await expect(moyasarAdapter.createCheckout(ctx(f.fn, { secretKey: 'sk_test_moy' }), { ...checkoutReq, currency: 'SAR', amountMinor: 99 })).rejects.toThrow(/at least 100/);
    expect(f.calls).toHaveLength(0);
    const c = ctx(f.fn, { secretKey: 'sk_test_moy', webhookSecret: 'x' });
    const r = await moyasarAdapter.createCheckout(c, { ...checkoutReq, currency: 'SAR', nudgeUrl: 'https://api.test/v1/webhooks/payments/moyasar/invoice-paid?c=conn' });
    expect(r).toMatchObject({ providerSessionId: 'inv_1', redirectUrl: 'https://checkout.moyasar.com/invoices/inv_1' });
    const sent = JSON.parse(String(f.calls[0]!.init.body));
    expect(sent.callback_url).toBe('https://api.test/v1/webhooks/payments/moyasar/invoice-paid?c=conn');
    expect(sent.callback_url).not.toBe(checkoutReq.notificationUrl);
    expect(sent).toMatchObject({ amount: 10000, currency: 'SAR', success_url: checkoutReq.returnUrl, metadata: { resuto_payment_id: 'pay_ref_1' } });
  });

  it('accepts only Moyasar\'s hosted invoice page (the documented sample is http://checkout.moyasar.com/…) and upgrades it to https', async () => {
    const c = (url: string) => moyasarAdapter.createCheckout(ctx(fakeFetch([{ body: { id: 'inv_2', status: 'initiated', url } }]).fn, { secretKey: 'sk_test_moy' }),
      { ...checkoutReq, currency: 'SAR' });
    expect((await c('http://checkout.moyasar.com/invoices/inv_2?lang=en')).redirectUrl).toBe('https://checkout.moyasar.com/invoices/inv_2?lang=en');
    await expect(c('https://evil.example/invoices/inv_2')).rejects.toThrow(/Invalid invoice response/);
    await expect(c('javascript:alert(1)')).rejects.toThrow(/Invalid invoice response/);
  });

  it('subscribes only to documented events (available-webhooks) and confirms each of them', () => {
    expect(moyasarAdapter.setup.webhookEvents).toEqual(['payment_paid', 'payment_failed', 'payment_captured', 'payment_authorized', 'payment_refunded', 'payment_voided']);
    expect(MOYASAR_EVENTS.other).toEqual(['payment_verified', 'payment_abandoned']);
    expect(moyasarAdapter.parseEvent(JSON.parse(body('x', 'payment_abandoned'))).needsConfirmation).toBe(true);
    expect(moyasarAdapter.parseEvent(JSON.parse(body('x', 'payment_canceled'))).needsConfirmation).toBe(false); // not a documented event
  });

  it('refunds, resolves refund status from the cumulative refunded amount and cancels invoices', async () => {
    const f = fakeFetch([
      { body: { id: 'pay_m_1', status: 'refunded', refunded: 3000 } },
      { body: { id: 'pay_m_1', status: 'refunded', refunded: 3000 } },
      { body: { id: 'pay_m_1', status: 'refunded', refunded: 2000 } },
      { body: { id: 'inv_1', status: 'canceled' } },
      { status: 400, body: { type: 'invalid_request_error', message: 'Invoice is paid' } },
    ]);
    const c = ctx(f.fn, { secretKey: 'sk_test_moy', webhookSecret: 'x' });
    const req = { providerPaymentId: 'pay_m_1', amountMinor: 1000, currency: 'SAR', reason: 'x', idempotencyKey: 'k', ledgerRefundedMinor: 2000 };
    expect((await moyasarAdapter.refund(c, req)).status).toBe('succeeded');
    expect(f.calls[0]!.url).toBe('https://api.moyasar.com/v1/payments/pay_m_1/refund');
    expect(await moyasarAdapter.refundStatus(c, req)).toMatchObject({ status: 'succeeded', providerRefundedMinor: 3000 });
    expect(await moyasarAdapter.refundStatus(c, req)).toMatchObject({ status: 'not_found', providerRefundedMinor: 2000 });
    expect(await moyasarAdapter.cancelCheckout!(c, { providerSessionId: 'inv_1' })).toBe('cancelled');
    expect([f.calls[3]!.url, f.calls[3]!.init.method]).toEqual(['https://api.moyasar.com/v1/invoices/inv_1/cancel', 'PUT']);
    expect(await moyasarAdapter.cancelCheckout!(c, { providerSessionId: 'inv_2' })).toBe('already_completed');
  });

  it('reads invoice status server-side', async () => {
    const f = fakeFetch([{ body: { id: 'inv_1', status: 'paid', amount: 5750, currency: 'SAR', payments: [payment] } }]);
    const ev = await moyasarAdapter.retrieveStatus(ctx(f.fn, { secretKey: 'sk_test_moy' }), { providerSessionId: 'inv_1', reference: 'r' });
    expect(ev).toMatchObject({ kind: 'payment_succeeded', providerPaymentId: 'pay_m_1', amountMinor: 5750, reference: 'pay_ref_1' });
  });
});

// ---------------------------------------------------------------------------
describe('stored payload minimisation (PAY-18)', () => {
  it('drops secrets and replaces personal data at any depth', () => {
    const out = redactProviderPayload({ a: { secret_token: 's', hmac: 'h', email: 'g@x.test', phone_number: '+20100', items: [{ name: 'Fries', amount: 1 }] }, ok: 1, n: null }) as any;
    expect(out).toEqual({ a: { email: '[redacted]', phone_number: '[redacted]', items: [{ name: '[redacted]', amount: 1 }] }, ok: 1, n: null });
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
    expect(ok.event).toMatchObject({ kind: 'payment_succeeded', reference: 'pay_ref_1', amountMinor: 4200, livemode: false });
    expect(simulatedAdapter.verifyWebhook({ webhookSecret: secret }, { rawBody: payload.replace('4200', '4300'), headers: { 'x-resuto-sandbox-signature': sig }, query: {}, nowSeconds: 1_700_000_100 }).valid).toBe(false);
    expect(simulatedAdapter.verifyWebhook({ webhookSecret: secret }, { rawBody: payload, headers: { 'x-resuto-sandbox-signature': sig }, query: {}, nowSeconds: 1_700_000_400 }).reason).toBe('timestamp outside tolerance');
    expect(simulatedAdapter.verifyWebhook({ webhookSecret: 'other' }, { rawBody: payload, headers: { 'x-resuto-sandbox-signature': sig }, query: {}, nowSeconds: 1_700_000_000 }).valid).toBe(false);
    const live = payload.replace('"livemode":false', '"livemode":true');
    expect(simulatedAdapter.verifyWebhook({ webhookSecret: secret }, { rawBody: live, headers: { 'x-resuto-sandbox-signature': signSimulated(secret, live, 1_700_000_000) }, query: {}, nowSeconds: 1_700_000_000 }).valid).toBe(false);
  });

  it('opens a provider-side session and redirects to the labelled test page', async () => {
    const opened: unknown[] = [];
    const store: SimulatedStore = { get: async () => null, open: async (x) => { opened.push(x); }, refund: async () => ({ error: 'n/a' }), refundState: async () => null, list: async () => [] };
    const r = await simulatedAdapter.createCheckout({ environment: 'sandbox', credentials: {}, config: { store, sandboxPageUrl: 'https://app.test/pay/tok/sandbox' }, fetch }, checkoutReq);
    expect(r.redirectUrl).toMatch(/^https:\/\/app\.test\/pay\/tok\/sandbox\?session=sim_cs_[0-9a-f]{24}$/);
    expect(opened).toEqual([{ providerSessionId: r.providerSessionId, reference: 'pay_ref_1', amountMinor: 10000, currency: 'EGP' }]);
    await expect(simulatedAdapter.createCheckout({ environment: 'live', credentials: {}, config: { store, sandboxPageUrl: 'x' }, fetch }, checkoutReq)).rejects.toThrow(/sandbox/);
  });
});
