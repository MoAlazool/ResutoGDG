import { Injectable, Logger } from '@nestjs/common';
import {
  buildCustomAudienceDryRun, buildServerEvent, ProviderError, trackingSink, TRACKING_PROVIDERS, type CodPurchasePolicy, type TrackingProvider,
} from '@resuto/integrations';
import { createHash, randomUUID } from 'node:crypto';
import type { TenantContext } from '../../common/auth/context';
import { DbService, type Tx } from '../../common/db/db.service';
import { DomainError, conflict, notFound } from '../../common/errors/domain-error';
import { OnDomainEvent, Scheduled, type OutboxEvent } from '../../common/events/events';
import { AuditService } from '../../common/platform/audit.service';
import { IntegrationConnectionsService, redactedError } from '../integrations/connections.service';

/**
 * Bumped when the wording of the guest prompt changes: older consents are asked again. 2026-10-2 (INT-23): the prompt
 * names every connected ad platform (Meta, TikTok, Snapchat), so consents given for Meta alone are asked again.
 */
export const TRACKING_CONSENT_VERSION = '2026-10-2';
const FULFILLED = new Set(['served', 'picked_up', 'delivered']);
const ONLINE_EXCLUDED_PROVIDERS = new Set(['manual', 'simulated']);
const CONTEXT_RETENTION_DAYS = 8;

/** Deterministic Purchase event id shared by the server and the browser Pixel (dedup). Never the order's public ref itself. */
export const purchaseEventId = (publicRef: string) => `p.${createHash('sha256').update(`purchase:${publicRef}`).digest('hex').slice(0, 40)}`;

/** Which match keys an event carries (never their values): Meta/Snap user_data, TikTok user. */
export function matchKeysOf(event: Record<string, unknown>): string[] {
  const u = (event.user_data ?? event.user ?? {}) as Record<string, unknown>;
  return Object.keys(u).sort();
}

export type PurchaseDecision =
  | { send: true; basis: 'prepaid' | 'cash_on_completion'; eventTime: Date }
  | { send: false; reason: 'cancelled' | 'not_paid_yet' | 'not_completed_yet' | 'cod_policy_never' | 'test_payment' };

interface OrderFacts { status: string; payment_status: string; fulfilled_at: Date | null; placed_at: Date }
interface PaymentFacts { provider: string; method: string; status: string; is_test: boolean; captured_at: Date | null }

/**
 * Purchase policy (INT-20). Prepaid: a captured online payment (not manual cash, not the simulator, not a test
 * payment) counts when it is captured. Cash on delivery / pay at pickup: counts when the order is completed (served,
 * picked up or delivered), unless the restaurant chose "never". Test or simulated payments never reach Meta.
 */
export function decidePurchase(order: OrderFacts, payments: PaymentFacts[], policy: CodPurchasePolicy): PurchaseDecision {
  if (order.status === 'cancelled') return { send: false, reason: 'cancelled' };
  const captured = payments.filter((p) => ['succeeded', 'partially_refunded', 'refunded'].includes(p.status));
  if (captured.some((p) => p.is_test || p.provider === 'simulated' || p.method === 'test')) return { send: false, reason: 'test_payment' };
  const online = captured.find((p) => !ONLINE_EXCLUDED_PROVIDERS.has(p.provider));
  if (online) return { send: true, basis: 'prepaid', eventTime: online.captured_at ?? new Date() };
  if (policy === 'never') return { send: false, reason: 'cod_policy_never' };
  if (!FULFILLED.has(order.status)) return { send: false, reason: order.payment_status === 'paid' ? 'not_completed_yet' : 'not_paid_yet' };
  return { send: true, basis: 'cash_on_completion', eventTime: order.fulfilled_at ?? new Date() };
}

interface TrackingConnection { id: string; provider: TrackingProvider; environment: 'sandbox' | 'live'; status: string; config: Record<string, unknown> }

/** Website keys of each sink in the public config (the browser loads the matching Pixel). */
const PUBLIC_KEY: Record<TrackingProvider, 'meta' | 'tiktok' | 'snap'> = { meta_capi: 'meta', tiktok_events: 'tiktok', snap_capi: 'snap' };
type SendResult = Record<string, unknown>;

/**
 * Ad measurement (INT-20 Meta Pixel + Conversions API; INT-23 TikTok Pixel + Events API, Snap Pixel + Conversions API):
 * the restaurant's Pixel ids for its website (browser events only after the guest consents), the consented order
 * context, and server-side Purchase events with the same event id as the browser, one per connected platform, sent from
 * outbox events and retried by the outbox. Nothing is sent for demo restaurants, guests without consent, or test and
 * simulated payments. Each platform deduplicates its own browser/server pair; a platform that is not connected gets
 * nothing. (Table names keep their INT-20 "meta_" prefix; rows carry the provider.)
 */
@Injectable()
export class MetaTrackingService {
  private readonly logger = new Logger('MetaTracking');

  constructor(private readonly db: DbService, private readonly connections: IntegrationConnectionsService, private readonly audit: AuditService) {}

  // ---------------------------------------------------------------------------
  // Public (guest website)
  // ---------------------------------------------------------------------------
  private async orgBySlug(slug: string) {
    if (!/^[a-z0-9](?:[a-z0-9-]{1,46}[a-z0-9])$/.test(slug)) throw notFound('Restaurant');
    const org = await this.db.withPlatform((tx) => tx.maybeOne<{ id: string; country: string; demo: boolean }>(
      `select id, country, coalesce((onboarding->>'demo')::boolean, false) as demo from organizations where slug = $1 and status in ('active', 'onboarding')`, [slug]));
    if (!org) throw notFound('Restaurant');
    return org;
  }

  /**
   * The tenant's active tracking connections, one per platform (none, switched off, revoked, unhealthy, or a demo
   * restaurant: not listed).
   */
  private async activeConnections(tx: Tx, orgId: string): Promise<TrackingConnection[]> {
    return tx.query<TrackingConnection>(
      `select distinct on (ic.provider) ic.id, ic.provider, ic.environment, ic.status, ic.config
         from integration_connections ic join organizations o on o.id = ic.org_id
        where ic.org_id = $1 and ic.provider = any($2::text[]) and ic.enabled and ic.status = 'connected'
          and coalesce((o.onboarding->>'demo')::boolean, false) = false
        order by ic.provider, ic.branch_id nulls first`, [orgId, TRACKING_PROVIDERS]);
  }

  /**
   * What the website needs to load the Pixels (no secrets). `meta` is null when the restaurant does not measure with
   * Meta; `tiktok` / `snap` appear only when those platforms are connected with the browser Pixel on.
   */
  async publicConfig(slug: string) {
    const org = await this.orgBySlug(slug);
    if (org.demo) return { meta: null, consentVersion: TRACKING_CONSENT_VERSION };
    const conns = await this.db.withTenant(org.id, (tx) => this.activeConnections(tx, org.id), 'tracking:public');
    const out: Record<string, unknown> = { meta: null };
    for (const c of conns) {
      const id = c.config.browserPixel === 'off' ? null : trackingSink(c.provider).browserPixelId(c.config);
      if (id) out[PUBLIC_KEY[c.provider]] = { pixelId: id, testMode: c.environment !== 'live' };
    }
    return { ...out, consentVersion: TRACKING_CONSENT_VERSION };
  }

  /**
   * The guest accepted the prompt and placed a web order: keep what Meta needs to match the server Purchase (browser
   * ids, page URL, user agent and IP as seen by the API). Only for recent web orders of this restaurant.
   */
  async recordOrderContext(slug: string, publicRef: string, input: {
    consentVersion: string; fbp?: string | null; fbc?: string | null; pageUrl?: string | null;
    ttp?: string | null; ttclid?: string | null; scid?: string | null; scClickId?: string | null;
  },
    seen: { ip: string | null; userAgent: string | null }) {
    if (!/^[0-9a-f]{12,64}$/.test(publicRef)) throw notFound('Order');
    if (input.consentVersion !== TRACKING_CONSENT_VERSION) throw conflict('consent_outdated', 'Ask for consent again');
    const org = await this.orgBySlug(slug);
    if (org.demo) return { recorded: false, reason: 'demo_tenant' };
    return this.db.withTenant(org.id, async (tx) => {
      if (!(await this.activeConnections(tx, org.id)).length) return { recorded: false, reason: 'not_configured' };
      const o = await tx.maybeOne<{ id: string }>(
        `select id from orders where public_ref = $1 and channel = 'web' and placed_at > now() - interval '1 hour'`, [publicRef]);
      if (!o) throw notFound('Order');
      const ip = seen.ip?.replace(/^::ffff:/, '') ?? null;
      await tx.query(
        `insert into meta_tracking_contexts(org_id, order_id, consent_version, fbp, fbc, client_ip, client_user_agent, event_source_url, ttp, ttclid, scid, sc_click_id)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) on conflict (order_id) do nothing`,
        [org.id, o.id, input.consentVersion, input.fbp ?? null, input.fbc ?? null, ip && /^[0-9a-fA-F:.]{3,45}$/.test(ip) ? ip : null,
          seen.userAgent?.slice(0, 500) ?? null, input.pageUrl?.slice(0, 1000) ?? null, input.ttp ?? null, input.ttclid ?? null, input.scid ?? null, input.scClickId ?? null]);
      return { recorded: true };
    }, 'tracking:context');
  }

  /**
   * Whether the browser should fire Purchase for this order now (same policy and event id as the server). `pixels`
   * lists which platforms' Pixels fire; it is present only when a platform other than Meta is connected.
   */
  async publicPurchase(slug: string, publicRef: string) {
    if (!/^[0-9a-f]{12,64}$/.test(publicRef)) throw notFound('Order');
    const org = await this.orgBySlug(slug);
    if (org.demo) return { fire: false };
    return this.db.withTenant(org.id, async (tx) => {
      const conns = (await this.activeConnections(tx, org.id)).filter((c) => c.config.browserPixel !== 'off');
      const o = await tx.maybeOne<any>(`select id, status, payment_status, fulfilled_at, placed_at, total_minor, currency from orders where public_ref = $1 and channel = 'web'`, [publicRef]);
      if (!o) throw notFound('Order');
      if (!conns.length) return { fire: false };
      const consented = await tx.maybeOne(`select 1 from meta_tracking_contexts where order_id = $1`, [o.id]);
      if (!consented) return { fire: false };
      const payments = await this.payments(tx, o.id);
      const firing = conns.filter((c) => decidePurchase(o, payments, this.policy(c)).send).map((c) => PUBLIC_KEY[c.provider]);
      if (!firing.length) return { fire: false };
      const base = { fire: true, eventId: purchaseEventId(publicRef), valueMinor: Number(o.total_minor), currency: o.currency };
      return conns.some((c) => c.provider !== 'meta_capi') ? { ...base, pixels: firing.sort() } : base;
    }, 'tracking:public');
  }

  private policy(conn: Pick<TrackingConnection, 'config'>): CodPurchasePolicy {
    return conn.config.codPurchase === 'never' ? 'never' : 'on_completion';
  }

  private payments(tx: Tx, orderId: string) {
    return tx.query<PaymentFacts>(`select provider, method::text as method, status::text as status, is_test, captured_at from payments where order_id = $1`, [orderId]);
  }

  // ---------------------------------------------------------------------------
  // Server events (outbox)
  // ---------------------------------------------------------------------------
  @OnDomainEvent('marketing.meta-capi-purchase', 'order.paid', 'order.status_changed', { timeoutMs: 30_000 })
  async onOrderEvent(e: OutboxEvent) {
    if (!e.orgId) return { skipped: 'no_org' };
    if (e.type === 'order.status_changed' && !FULFILLED.has(String(e.payload?.to ?? ''))) return { skipped: 'not_a_completion' };
    return this.sendPurchase(e.orgId, e.aggregateId);
  }

  /**
   * Decides and (once per platform) sends the order's Purchase to every connected sink. Throws on a retryable provider
   * failure so the outbox retries; sinks that already delivered are skipped on the retry (one row per platform). With a
   * single connected platform the result is that platform's outcome; with several it is `{ sinks: { provider: … } }`.
   */
  async sendPurchase(orgId: string, orderId: string): Promise<SendResult> {
    const prepared = await this.db.withTenant(orgId, async (tx) => {
      const conns = await this.activeConnections(tx, orgId);
      if (!conns.length) return { done: { skipped: 'not_configured' } as SendResult, sends: [], several: false };
      const o = await tx.maybeOne<any>(
        `select o.id, o.public_ref, o.channel::text as channel, o.status::text as status, o.payment_status::text as payment_status, o.fulfilled_at, o.placed_at,
                o.total_minor, o.currency::text as currency, o.customer_id, o.customer_phone, c.email, org.country::text as country
           from orders o join organizations org on org.id = o.org_id left join customers c on c.id = o.customer_id where o.id = $1`, [orderId]);
      if (!o) return { done: { skipped: 'no_order' } as SendResult, sends: [], several: false };
      const eventId = purchaseEventId(o.public_ref);
      // One decision per order at a time (concurrent outbox handlers for order.paid and order.status_changed).
      await tx.query(`select pg_advisory_xact_lock(hashtext('meta-capi:' || $1::text))`, [o.id]);
      const payments = await this.payments(tx, o.id);
      const ctxRow = await tx.maybeOne<any>(`select * from meta_tracking_contexts where order_id = $1`, [o.id]);
      const lines = await tx.query<{ product_id: string | null; quantity: number; unit_price_minor: number }>(
        `select product_id, quantity, unit_price_minor from order_lines where order_id = $1`, [o.id]);
      const results: Partial<Record<TrackingProvider, SendResult>> = {};
      const sends: Array<{ provider: TrackingProvider; rowId: string; connectionId: string; event: Record<string, unknown> }> = [];
      for (const conn of conns) {
        const sink = trackingSink(conn.provider);
        const eventName = sink.purchaseEventName;
        const existing = await tx.maybeOne<{ id: string; status: string; stale: boolean }>(
          `select id, status, updated_at < now() - interval '2 minutes' as stale from meta_capi_events
            where org_id = $1 and provider = $2 and event_name = $3 and event_id = $4`, [orgId, conn.provider, eventName, eventId]);
        // 'pending' = another worker is delivering it right now; it is taken over only when that attempt is stale.
        if (existing && !(existing.status === 'failed' || (existing.status === 'pending' && existing.stale))) { results[conn.provider] = { skipped: `already_${existing.status}` }; continue; }
        const d = decidePurchase(o, payments, this.policy(conn));
        // "Not yet" outcomes record nothing: a later event (payment captured, order completed) decides again.
        if (!d.send && (d.reason === 'not_paid_yet' || d.reason === 'not_completed_yet')) { results[conn.provider] = { skipped: d.reason }; continue; }
        const skip = async (reason: string) => {
          await tx.query(
            `insert into meta_capi_events(org_id, connection_id, order_id, provider, event_name, event_id, source, status, skip_reason, test_mode)
             values ($1, $2, $3, $4, $5, $6, 'order', 'skipped', $7, $8)
             on conflict (org_id, provider, event_name, event_id) do update set status = 'skipped', skip_reason = excluded.skip_reason`,
            [orgId, conn.id, o.id, conn.provider, eventName, eventId, reason, conn.environment !== 'live']);
          results[conn.provider] = { skipped: reason };
        };
        if (!d.send) { await skip(d.reason); continue; }
        if (o.channel !== 'web' || !ctxRow) { await skip('no_consent'); continue; }
        const built = sink.buildPurchase({
          eventId, eventTime: new Date(d.eventTime), eventSourceUrl: ctxRow.event_source_url ?? '',
          user: { email: o.email, phone: o.customer_phone, externalId: o.customer_id, country: o.country, clientIp: ctxRow.client_ip,
            userAgent: ctxRow.client_user_agent, fbp: ctxRow.fbp, fbc: ctxRow.fbc, ttp: ctxRow.ttp, ttclid: ctxRow.ttclid, scid: ctxRow.scid, scClickId: ctxRow.sc_click_id },
          custom: { currency: o.currency, valueMinor: Number(o.total_minor), orderId: eventId,
            contents: lines.filter((l) => l.product_id).map((l) => ({ id: l.product_id!, quantity: l.quantity, itemPriceMinor: Number(l.unit_price_minor) })) },
        });
        if ('error' in built) { await skip(built.error); continue; }
        const summary = { basis: d.basis, valueMinor: Number(o.total_minor), currency: o.currency, matchKeys: matchKeysOf(built.event) };
        const row = await tx.one<{ id: string }>(
          `insert into meta_capi_events(org_id, connection_id, order_id, provider, event_name, event_id, source, status, test_mode, summary)
           values ($1, $2, $3, $4, $5, $6, 'order', 'pending', $7, $8)
           on conflict (org_id, provider, event_name, event_id) do update set status = 'pending', connection_id = excluded.connection_id, summary = excluded.summary, updated_at = now()
           returning id`, [orgId, conn.id, o.id, conn.provider, eventName, eventId, conn.environment !== 'live', summary]);
        sends.push({ provider: conn.provider, rowId: row.id, connectionId: conn.id, event: built.event });
      }
      return { done: null, results, sends, several: conns.length > 1 };
    }, 'marketing.meta-capi');
    if (prepared.done) return prepared.done;
    const results = { ...prepared.results } as Record<string, SendResult>;
    let retry: Error | null = null;
    for (const s of prepared.sends) {
      try {
        results[s.provider] = await this.deliver(orgId, s.provider, s.rowId, s.connectionId, s.event);
      } catch (e) {
        retry ??= e as Error;
        results[s.provider] = { failed: (e as Error).message, retrying: true };
      }
    }
    // Every sink was attempted (and recorded) before the retry is requested; delivered ones are skipped next time.
    if (retry) throw retry;
    return prepared.several ? { sinks: results } : Object.values(results)[0]!;
  }

  private async deliver(orgId: string, provider: TrackingProvider, rowId: string, connectionId: string, event: Record<string, unknown>) {
    let result: { eventsReceived: number; traceId: string | null } | null = null;
    let failure: { message: string; retryable: boolean } | null = null;
    try {
      const conn = await this.connections.load(orgId, { id: connectionId });
      result = await trackingSink(provider).send(conn.adapter, [event]);
    } catch (e) {
      const d = redactedError(e);
      failure = { message: d.message, retryable: e instanceof ProviderError ? e.retryable : true };
    }
    const label = provider === 'meta_capi' ? 'Conversions API' : provider === 'tiktok_events' ? 'TikTok Events API' : 'Snap Conversions API';
    await this.db.withTenant(orgId, async (tx) => {
      if (result) {
        await tx.query(`update meta_capi_events set status = 'sent', attempts = attempts + 1, events_received = $2, fbtrace_id = $3, error = null, sent_at = now() where id = $1`,
          [rowId, result.eventsReceived, result.traceId]);
      } else {
        await tx.query(`update meta_capi_events set status = 'failed', attempts = attempts + 1, error = $2 where id = $1`, [rowId, failure!.message.slice(0, 500)]);
        await this.connections.log(tx, orgId, connectionId, 'warn', `${label} event failed: ${failure!.message}`, { rowId, retryable: failure!.retryable });
      }
    }, 'marketing.meta-capi');
    if (failure?.retryable) throw new Error(`${provider === 'meta_capi' ? 'meta capi' : provider} send failed (will retry): ${failure.message}`);
    return result ? { sent: true, eventsReceived: result.eventsReceived } : { failed: failure!.message };
  }

  // ---------------------------------------------------------------------------
  // Dashboard: diagnostics and Test Events
  // ---------------------------------------------------------------------------
  /** Meta diagnostics (INT-20 shape). */
  async diagnostics(ctx: TenantContext) {
    return this.diagnosticsFor(ctx, 'meta_capi');
  }

  /** Diagnostics of one platform's sink: connection summary, 7-day counts and the last 25 events (no secrets, no identifiers). */
  async diagnosticsFor(ctx: TenantContext, provider: TrackingProvider) {
    return this.db.scoped(ctx, async (tx) => {
      const conn = await tx.maybeOne<any>(
        `select ic.id, ic.environment, ic.status, ic.enabled, ic.config, ic.last_error, coalesce((o.onboarding->>'demo')::boolean, false) as demo
           from integration_connections ic join organizations o on o.id = ic.org_id where ic.org_id = $1 and ic.provider = $2 and ic.status <> 'revoked'
          order by ic.branch_id nulls first limit 1`, [ctx.orgId, provider]);
      const counts = await tx.query<{ status: string; n: number }>(
        `select status, count(*)::int as n from meta_capi_events where org_id = $1 and provider = $2 and created_at > now() - interval '7 days' group by status`, [ctx.orgId, provider]);
      const recent = await tx.query<any>(
        `select id, event_name, event_id, source, status, skip_reason, test_mode, summary, attempts, events_received, fbtrace_id, error, sent_at, created_at
           from meta_capi_events where org_id = $1 and provider = $2 order by created_at desc limit 25`, [ctx.orgId, provider]);
      const consented = await tx.one<{ n: number }>(`select count(*)::int as n from meta_tracking_contexts where org_id = $1 and created_at > now() - interval '7 days'`, [ctx.orgId]);
      const pixelId = conn ? (provider === 'tiktok_events' ? conn.config.pixelCode : conn.config.pixelId) ?? null : null;
      return {
        ...(provider === 'meta_capi' ? {} : { provider }),
        connection: conn ? {
          id: conn.id, environment: conn.environment, testMode: conn.environment !== 'live', status: conn.status, enabled: conn.enabled, pixelId,
          browserPixel: conn.config.browserPixel !== 'off', codPurchase: conn.config.codPurchase === 'never' ? 'never' : 'on_completion',
          hasTestEventCode: typeof conn.config.testEventCode === 'string' && conn.config.testEventCode.length > 0, lastError: conn.last_error ?? null,
        } : null,
        demoTenant: conn?.demo ?? false,
        consentVersion: TRACKING_CONSENT_VERSION,
        last7Days: { ...Object.fromEntries(counts.map((c) => [c.status, c.n])), consentedOrders: consented.n },
        events: recent.map((r) => ({
          id: r.id, eventName: r.event_name, eventId: r.event_id, source: r.source, status: r.status, skipReason: r.skip_reason, testMode: r.test_mode, summary: r.summary,
          attempts: r.attempts, eventsReceived: r.events_received, fbtraceId: r.fbtrace_id, error: r.error,
          sentAt: r.sent_at ? new Date(r.sent_at).toISOString() : null, createdAt: new Date(r.created_at).toISOString(),
        })),
      };
    });
  }

  /**
   * Sends one synthetic Purchase to the platform's test path (test connections only): Meta's Test Events (code),
   * TikTok's Test events (code), Snap's /validate endpoint. It carries no customer data: a fixed documentation IP
   * (TEST-NET-3), the dashboard user's user agent and a synthetic external id.
   */
  async sendTestEvent(ctx: TenantContext, userAgent: string | null, provider: TrackingProvider = 'meta_capi') {
    ctx.require('integrations:manage');
    const name = provider === 'meta_capi' ? 'Meta Pixel & Conversions API' : provider === 'tiktok_events' ? 'TikTok Pixel & Events API' : 'Snap Pixel & Conversions API';
    const conn = await this.db.scoped(ctx, (tx) => tx.maybeOne<{ id: string; environment: string; enabled: boolean; status: string; config: Record<string, unknown> }>(
      `select id, environment, enabled, status, config from integration_connections where org_id = $1 and provider = $2 and status <> 'revoked'
        order by branch_id nulls first limit 1`, [ctx.orgId, provider]));
    if (!conn) throw conflict('not_configured', `Connect ${name} in Integrations first`);
    if (conn.environment === 'live') throw conflict('test_connection_required', 'Test events are sent from a TEST connection. Live connections only send real orders.');
    if (!conn.enabled) throw conflict('connection_unavailable', 'This connection is switched off');
    const sink = trackingSink(provider);
    const eventId = `test.${randomUUID()}`;
    const input = {
      eventId, eventTime: new Date(), eventSourceUrl: 'https://resuto.app/tracking-test-event',
      user: { clientIp: '203.0.113.10', userAgent: userAgent?.slice(0, 300) || 'Resuto tracking test event', externalId: `resuto-test-${ctx.orgId}` },
      custom: { currency: 'EGP', valueMinor: 100 },
    };
    // Meta keeps its INT-20 synthetic event (no order id); the other sinks use their own builder.
    const built = provider === 'meta_capi'
      ? buildServerEvent({ eventName: 'Purchase', eventId, eventTime: input.eventTime, eventSourceUrl: 'https://resuto.app/meta-test-event', user: input.user, custom: input.custom })
      : sink.buildPurchase(input);
    if ('error' in built) throw new DomainError('invalid_event', built.error, 500);
    const row = await this.db.scoped(ctx, async (tx) => {
      const r = await tx.one<{ id: string }>(
        `insert into meta_capi_events(org_id, connection_id, provider, event_name, event_id, source, status, test_mode, summary)
         values ($1, $2, $3, $4, $5, 'test', 'pending', true, $6) returning id`,
        [ctx.orgId, conn.id, provider, sink.purchaseEventName, eventId, { synthetic: true, matchKeys: matchKeysOf(built.event) }]);
      await this.audit.record(tx, ctx, { action: provider === 'meta_capi' ? 'marketing.meta_test_event' : 'marketing.tracking_test_event', entityType: 'integration_connection',
        entityId: conn.id, metadata: { eventId, provider } });
      return r;
    });
    const res = await this.deliver(ctx.orgId, provider, row.id, conn.id, built.event).catch((e) => ({ failed: (e as Error).message }));
    return { eventId, ...res };
  }

  /**
   * INT-22: what a Meta Custom Audience upload of this segment would contain (hashed, consent-filtered, batched).
   * Dry run only: nothing is sent to Meta (see packages/integrations/src/ads/audiences.ts for why the upload is deferred).
   */
  async audienceDryRun(ctx: TenantContext, segmentId: string) {
    return this.db.scoped(ctx, async (tx) => {
      const seg = await tx.maybeOne<{ id: string; name: string; last_computed_at: Date | null }>(`select id, name, last_computed_at from segments where id = $1 and org_id = $2`, [segmentId, ctx.orgId]);
      if (!seg) throw notFound('Segment');
      const ads = await tx.maybeOne<{ config: Record<string, unknown>; status: string }>(
        `select config, status from integration_connections where org_id = $1 and provider = 'meta_ads' and status <> 'revoked' order by branch_id nulls first limit 1`, [ctx.orgId]);
      const members = await tx.query<{ email: string | null; phone_e164: string | null; marketing_consent: boolean; anonymized_at: Date | null }>(
        // A stable order (oldest customer first), so the sample shown for the same segment is the same on every run.
        `select c.email::text as email, c.phone_e164, c.marketing_consent, c.anonymized_at from segment_members m join customers c on c.id = m.customer_id
          where m.segment_id = $1 and m.org_id = $2 order by c.created_at, c.id`, [segmentId, ctx.orgId]);
      const plan = buildCustomAudienceDryRun({
        adAccountId: typeof ads?.config.adAccountId === 'string' ? ads.config.adAccountId : '<AD_ACCOUNT_ID>',
        name: `Resuto: ${seg.name}`, description: `Resuto CRM segment ${seg.id}`,
        members: members.map((m) => ({ email: m.email, phone: m.phone_e164, marketingConsent: m.marketing_consent, anonymised: !!m.anonymized_at })),
      });
      await this.audit.record(tx, ctx, { action: 'marketing.audience_dry_run', entityType: 'segment', entityId: seg.id, metadata: { counts: plan.counts } });
      return { ...plan, segment: { id: seg.id, name: seg.name, lastComputedAt: seg.last_computed_at ? new Date(seg.last_computed_at).toISOString() : null },
        adAccountConnected: ads?.status === 'connected' && typeof ads.config.adAccountId === 'string' };
    });
  }

  /** IP addresses and user agents are kept only while Meta still accepts the event (7 days) plus a day. */
  @Scheduled('marketing.meta-tracking-retention', 3600)
  async purgeContexts() {
    const r = await this.db.withPlatform((tx) => tx.query(`delete from meta_tracking_contexts where created_at < now() - make_interval(days => $1) returning id`, [CONTEXT_RETENTION_DAYS]));
    return { deleted: r.length };
  }
}
