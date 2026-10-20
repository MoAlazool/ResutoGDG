// Shared fixtures for the payment provider tests. Signatures are computed here with node:crypto from each
// provider's DOCUMENTED scheme — never with the adapters' own helpers — so a signer bug cannot hide a verifier bug.
import { createHmac } from 'node:crypto';
import { ProviderHttp } from '../src/modules/integrations/provider-http';
import { auth, sql, type TestApp, type TestTenant } from './helpers';

/** docs.stripe.com/webhooks#verify-manually: v1 = HMAC-SHA256(secret, `${t}.${body}`), hex. */
export const stripeSignature = (secret: string, raw: string, ts = Math.floor(Date.now() / 1000)) =>
  `t=${ts},v1=${createHmac('sha256', secret).update(`${ts}.${raw}`).digest('hex')}`;

/**
 * developers.paymob.com …/hmac-transaction-callback: the 20 documented fields, lexicographic, values concatenated,
 * HMAC-SHA512 with the merchant's HMAC secret, hex. (Paymob's published sample concatenation is asserted in
 * packages/integrations/src/payments/payments.test.ts.)
 */
const PAYMOB_FIELDS = ['amount_cents', 'created_at', 'currency', 'error_occured', 'has_parent_transaction', 'id', 'integration_id', 'is_3d_secure',
  'is_auth', 'is_capture', 'is_refunded', 'is_standalone_payment', 'is_voided', 'order.id', 'owner', 'pending', 'source_data.pan',
  'source_data.sub_type', 'source_data.type', 'success'];
export const paymobSignature = (secret: string, obj: any) => createHmac('sha512', secret)
  .update(PAYMOB_FIELDS.map((f) => String(f.split('.').reduce((v: any, k) => v?.[k], obj))).join('')).digest('hex');

export function paymobTxn(over: Record<string, unknown> & { orderId: number | string; amount: number; integrationId: number }) {
  const { orderId, amount, integrationId, ...rest } = over;
  return {
    id: Math.floor(Math.random() * 1e9), pending: false, amount_cents: amount, success: true, is_auth: false, is_capture: false, is_standalone_payment: true,
    is_voided: false, is_refunded: false, is_3d_secure: true, integration_id: integrationId, has_parent_transaction: false, owner: 302852, error_occured: false,
    currency: 'EGP', created_at: '2026-10-20T10:00:00.000000', order: { id: orderId, merchant_order_id: null },
    source_data: { pan: '2346', sub_type: 'MasterCard', type: 'card' }, data: { message: 'Approved' }, is_live: false, ...rest,
  };
}

export interface ScriptedCall { method: string; url: string; headers: Record<string, string>; body: string | null }
type Handler = (call: ScriptedCall) => { status?: number; body: unknown } | 'network_error' | undefined;

/**
 * Replaces the integrations module's single outbound HTTP entry point with a router of scripted provider responses.
 * Unrouted requests fail the call loudly (500), so nothing silently "succeeds".
 */
export function scriptProviders(t: TestApp) {
  const http = t.app.get(ProviderHttp);
  const calls: ScriptedCall[] = [];
  const routes: Array<{ match: (c: ScriptedCall) => boolean; handler: Handler }> = [];
  http.fetch = (async (input: any, init: any = {}) => {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(init.headers ?? {})) headers[k.toLowerCase()] = String(v);
    const call: ScriptedCall = { method: (init.method ?? 'GET').toUpperCase(), url: String(input), headers, body: init.body === undefined ? null : String(init.body) };
    calls.push(call);
    for (const r of [...routes].reverse()) {
      if (!r.match(call)) continue;
      const out = r.handler(call);
      if (out === undefined) continue;
      if (out === 'network_error') throw new TypeError('socket hang up');
      return new Response(JSON.stringify(out.body), { status: out.status ?? 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({ error: `no scripted response for ${call.method} ${call.url}` }), { status: 500 });
  }) as typeof fetch;
  return {
    calls,
    on(method: string, prefix: string, handler: Handler) {
      routes.push({ match: (c) => c.method === method && c.url.startsWith(prefix), handler });
      return this;
    },
    reset() { calls.length = 0; routes.length = 0; },
  };
}
export type Scripted = ReturnType<typeof scriptProviders>;

/** Health responses each provider documents for a valid key. */
export function scriptHealth(s: Scripted) {
  s.on('GET', 'https://api.stripe.com/v1/account', () => ({ body: { id: 'acct_test_olive', country: 'AE', default_currency: 'aed', charges_enabled: true, settings: { dashboard: { display_name: 'Olive Room' } } } }));
  s.on('POST', 'https://accept.paymob.com/api/auth/tokens', () => ({ body: { token: 'pm-auth-token', profile: { id: 4242, company_name: 'Olive Room EG' } } }));
  s.on('GET', 'https://api.moyasar.com/v1/payments?page=1', () => ({ body: { payments: [], meta: { current_page: 1 } } }));
}

/** Creates a payment connection through the real API path, then runs its health check (INT-18). */
export async function connect(t: TestApp, tenant: TestTenant, provider: string, credentials: Record<string, string>, config: Record<string, unknown> = {},
  environment: 'sandbox' | 'live' = 'sandbox') {
  const created = await t.http.post(`/v1/o/${tenant.orgId}/integrations/connections`).set(auth(tenant.owner)).send({ provider, environment, credentials, config });
  if (created.status !== 201) throw new Error(`connect ${provider}: ${created.status} ${JSON.stringify(created.body)}`);
  const health = await t.http.post(`/v1/o/${tenant.orgId}/integrations/connections/${created.body.id}/health`).set(auth(tenant.owner));
  return { id: created.body.id as string, created: created.body, health: health.body };
}

export const inbox = (provider: string, orgId: string) =>
  sql(`select event_key, status, error, signature_valid, payload from webhook_inbox where provider = $1 and org_id = $2 order by received_at`, [`payments:${provider}`, orgId]);
