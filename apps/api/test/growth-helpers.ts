// Shared fixtures for the Connect / Marketing / Integrations test files (Agent C).
import { Global, Module, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { newToken, sha256 } from '../src/common/crypto/hash';
import type { TenantContext } from '../src/common/auth/context';
import type { Tx } from '../src/common/db/db.service';
import { CHECKOUT_PORT, type CheckoutPort, type CheckoutSessionRequest } from '../src/modules/kernel/ports';
import { auth, sql, type TestApp, type TestTenant } from './helpers';

export async function sandboxChannel(t: TestApp, tenant: TestTenant, extra: Record<string, unknown> = {}) {
  const res = await t.http.post(`/v1/o/${tenant.orgId}/connect/channels`).set(auth(tenant.owner))
    .send({ transport: 'sandbox', displayName: 'WhatsApp sandbox', ...extra });
  if (res.status !== 201) throw new Error(`channel: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body as { id: string; sandbox: boolean };
}

export async function inbound(t: TestApp, tenant: TestTenant, channelId: string, from: string, msg: { text?: string; reply?: { id: string; title?: string }; location?: any; name?: string }) {
  const res = await t.http.post(`/v1/o/${tenant.orgId}/connect/sandbox/inbound`).set(auth(tenant.owner)).send({ channelId, from, ...msg });
  if (res.status !== 201) throw new Error(`inbound: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body as { conversationId: string; sandbox: true; conversation: any };
}

export async function outbound(conversationId: string) {
  return sql<{ id: string; kind: string; body: string; payload: any; status: string; provider_message_id: string | null }>(
    `select id, kind, body, payload, status, provider_message_id from messages where conversation_id = $1 and direction = 'outbound' order by created_at, id`, [conversationId]);
}

export async function lastOutbound(conversationId: string) {
  const rows = await outbound(conversationId);
  return rows[rows.length - 1]!;
}

/** Drives the bot from "order" to the hosted-page link; returns the page token. */
export async function walkToMenu(t: TestApp, tenant: TestTenant, channelId: string, from: string, fulfillment: 'pickup' | 'delivery' = 'pickup') {
  const a = await inbound(t, tenant, channelId, from, { text: 'order', name: 'Mona' });
  await inbound(t, tenant, channelId, from, { reply: { id: `ful:${fulfillment}` } });
  await inbound(t, tenant, channelId, from, { text: 'Mona Adel' });
  if (fulfillment === 'delivery') await inbound(t, tenant, channelId, from, { text: '26 July St, building 4, floor 2' });
  const link = await lastOutbound(a.conversationId);
  const url: string = link.payload?.url;
  if (!url?.includes('/o/')) throw new Error(`expected a menu link, got ${JSON.stringify(link.payload)}`);
  return { conversationId: a.conversationId, token: url.split('/o/')[1]! };
}

// ---------------------------------------------------------------------------
// A stand-in for ResutoPay's CHECKOUT_PORT (Agent D1). It writes the same
// checkout_sessions row D1 would, so the ordering flow can be exercised end to end.
// ---------------------------------------------------------------------------
export class FakeCheckout implements CheckoutPort {
  calls: CheckoutSessionRequest[] = [];
  async createSession(tx: Tx, ctx: TenantContext, input: CheckoutSessionRequest) {
    this.calls.push(input);
    const o = await tx.one<{ branch_id: string; total_minor: number; currency: string }>(`select branch_id, total_minor, currency from orders where id = $1`, [input.orderId]);
    const token = newToken();
    const row = await tx.one<{ id: string; expires_at: Date }>(
      `insert into checkout_sessions(org_id, branch_id, token_hash, purpose, order_id, amount_minor, currency, channel, expires_at)
       values ($1, $2, $3, 'order', $4, $5, $6, $7, now() + interval '30 minutes') returning id, expires_at`,
      [ctx.orgId, o.branch_id, sha256(token), input.orderId, o.total_minor, o.currency, input.channel]);
    return { id: row.id, token, url: `http://app.test/pay/${token}`, amountMinor: o.total_minor, currency: o.currency, expiresAt: new Date(row.expires_at).toISOString() };
  }
}

export const fakeCheckout = new FakeCheckout();

@Global()
@Module({ providers: [{ provide: CHECKOUT_PORT, useValue: fakeCheckout }], exports: [CHECKOUT_PORT] })
class FakeCheckoutModule {}

/** Boots the full app plus a CHECKOUT_PORT stand-in (same prefix/raw-body config as createApp). */
export async function bootWithCheckout(): Promise<TestApp> {
  const mod = await Test.createTestingModule({ imports: [AppModule, FakeCheckoutModule] }).compile();
  const app: INestApplication = mod.createNestApplication({ rawBody: true, logger: ['error'] });
  app.setGlobalPrefix('v1');
  await app.init();
  return { app, http: request(app.getHttpServer()), close: () => app.close() };
}

// Scripted fetch for provider adapters (mirrors packages/integrations/src/messaging/testing/scripted-fetch.ts).
export interface RecordedRequest { url: string; method: string; headers: Record<string, string>; body: string | null }

export function scriptedFetch(responses: Array<{ status?: number; body: unknown; headers?: Record<string, string> } | ((req: RecordedRequest) => { status?: number; body: unknown; headers?: Record<string, string> })>) {
  const calls: RecordedRequest[] = [];
  let i = 0;
  const fn = (async (input: string | URL, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers as ConstructorParameters<typeof Headers>[0]).forEach((v, k) => { headers[k] = v; });
    const req: RecordedRequest = { url: String(input), method: init?.method ?? 'GET', headers, body: init?.body == null ? null : String(init.body) };
    calls.push(req);
    const next = responses[Math.min(i++, responses.length - 1)];
    if (!next) throw new Error('no scripted response');
    const r = typeof next === 'function' ? next(req) : next;
    return new Response(typeof r.body === 'string' ? r.body : JSON.stringify(r.body), { status: r.status ?? 200, headers: { 'content-type': 'application/json', ...r.headers } });
  }) as unknown as typeof fetch;
  return { fetch: fn, calls };
}
