import { Injectable, Logger } from '@nestjs/common';
import { buildCustomAudienceDryRun, buildServerEvent, metaCapiAdapter, ProviderError, type CodPurchasePolicy } from '@resuto/integrations';
import { createHash, randomUUID } from 'node:crypto';
import type { TenantContext } from '../../common/auth/context';
import { DbService, type Tx } from '../../common/db/db.service';
import { DomainError, conflict, notFound } from '../../common/errors/domain-error';
import { OnDomainEvent, Scheduled, type OutboxEvent } from '../../common/events/events';
import { AuditService } from '../../common/platform/audit.service';
import { IntegrationConnectionsService, redactedError } from '../integrations/connections.service';

/** Bumped when the wording of the guest prompt changes: older consents are asked again. */
export const TRACKING_CONSENT_VERSION = '2026-10-1';
const FULFILLED = new Set(['served', 'picked_up', 'delivered']);
const ONLINE_EXCLUDED_PROVIDERS = new Set(['manual', 'simulated']);
const CONTEXT_RETENTION_DAYS = 8;

/** Deterministic Purchase event id shared by the server and the browser Pixel (dedup). Never the order's public ref itself. */
export const purchaseEventId = (publicRef: string) => `p.${createHash('sha256').update(`purchase:${publicRef}`).digest('hex').slice(0, 40)}`;

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

interface TrackingConnection { id: string; environment: 'sandbox' | 'live'; status: string; config: Record<string, unknown> }

/**
 * Meta Pixel + Conversions API (INT-20): the restaurant's Pixel id for its website (browser events only after the guest
 * consents), the consented order context, and server-side Purchase events with the same event id as the browser, sent
 * from outbox events and retried by the outbox. Nothing is sent for demo restaurants, guests without consent, or test
 * and simulated payments.
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

  /** The tenant's active tracking connection, or null (none, switched off, revoked, unhealthy, or a demo restaurant). */
  private async activeConnection(tx: Tx, orgId: string): Promise<TrackingConnection | null> {
    return tx.maybeOne<TrackingConnection>(
      `select ic.id, ic.environment, ic.status, ic.config from integration_connections ic join organizations o on o.id = ic.org_id
        where ic.org_id = $1 and ic.provider = 'meta_capi' and ic.enabled and ic.status = 'connected'
          and coalesce((o.onboarding->>'demo')::boolean, false) = false
        order by ic.branch_id nulls first limit 1`, [orgId]);
  }

  /** What the website needs to load the Pixel (no secrets). Null when the restaurant does not measure with Meta. */
  async publicConfig(slug: string) {
    const org = await this.orgBySlug(slug);
    if (org.demo) return { meta: null, consentVersion: TRACKING_CONSENT_VERSION };
    const conn = await this.db.withTenant(org.id, (tx) => this.activeConnection(tx, org.id), 'tracking:public');
    if (!conn || conn.config.browserPixel === 'off') return { meta: null, consentVersion: TRACKING_CONSENT_VERSION };
    return { meta: { pixelId: String(conn.config.pixelId), testMode: conn.environment !== 'live' }, consentVersion: TRACKING_CONSENT_VERSION };
  }

  /**
   * The guest accepted the prompt and placed a web order: keep what Meta needs to match the server Purchase (browser
   * ids, page URL, user agent and IP as seen by the API). Only for recent web orders of this restaurant.
   */
  async recordOrderContext(slug: string, publicRef: string, input: { consentVersion: string; fbp?: string | null; fbc?: string | null; pageUrl?: string | null },
    seen: { ip: string | null; userAgent: string | null }) {
    if (!/^[0-9a-f]{12,64}$/.test(publicRef)) throw notFound('Order');
    if (input.consentVersion !== TRACKING_CONSENT_VERSION) throw conflict('consent_outdated', 'Ask for consent again');
    const org = await this.orgBySlug(slug);
    if (org.demo) return { recorded: false, reason: 'demo_tenant' };
    return this.db.withTenant(org.id, async (tx) => {
      const conn = await this.activeConnection(tx, org.id);
      if (!conn) return { recorded: false, reason: 'not_configured' };
      const o = await tx.maybeOne<{ id: string }>(
        `select id from orders where public_ref = $1 and channel = 'web' and placed_at > now() - interval '1 hour'`, [publicRef]);
      if (!o) throw notFound('Order');
      const ip = seen.ip?.replace(/^::ffff:/, '') ?? null;
      await tx.query(
        `insert into meta_tracking_contexts(org_id, order_id, consent_version, fbp, fbc, client_ip, client_user_agent, event_source_url)
         values ($1, $2, $3, $4, $5, $6, $7, $8) on conflict (order_id) do nothing`,
        [org.id, o.id, input.consentVersion, input.fbp ?? null, input.fbc ?? null, ip && /^[0-9a-fA-F:.]{3,45}$/.test(ip) ? ip : null,
          seen.userAgent?.slice(0, 500) ?? null, input.pageUrl?.slice(0, 1000) ?? null]);
      return { recorded: true };
    }, 'tracking:context');
  }

  /** Whether the browser should fire Purchase for this order now (same policy and event id as the server). */
  async publicPurchase(slug: string, publicRef: string) {
    if (!/^[0-9a-f]{12,64}$/.test(publicRef)) throw notFound('Order');
    const org = await this.orgBySlug(slug);
    if (org.demo) return { fire: false };
    return this.db.withTenant(org.id, async (tx) => {
      const conn = await this.activeConnection(tx, org.id);
      const o = await tx.maybeOne<any>(`select id, status, payment_status, fulfilled_at, placed_at, total_minor, currency from orders where public_ref = $1 and channel = 'web'`, [publicRef]);
      if (!o) throw notFound('Order');
      if (!conn || conn.config.browserPixel === 'off') return { fire: false };
      const consented = await tx.maybeOne(`select 1 from meta_tracking_contexts where order_id = $1`, [o.id]);
      if (!consented) return { fire: false };
      const d = decidePurchase(o, await this.payments(tx, o.id), this.policy(conn));
      return d.send ? { fire: true, eventId: purchaseEventId(publicRef), valueMinor: Number(o.total_minor), currency: o.currency } : { fire: false };
    }, 'tracking:public');
  }

  private policy(conn: TrackingConnection): CodPurchasePolicy {
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

  /** Decides and (once) sends the order's Purchase. Throws on a retryable provider failure so the outbox retries it. */
  async sendPurchase(orgId: string, orderId: string): Promise<Record<string, unknown>> {
    const prepared = await this.db.withTenant(orgId, async (tx) => {
      const conn = await this.activeConnection(tx, orgId);
      if (!conn) return { done: { skipped: 'not_configured' } };
      const o = await tx.maybeOne<any>(
        `select o.id, o.public_ref, o.channel::text as channel, o.status::text as status, o.payment_status::text as payment_status, o.fulfilled_at, o.placed_at,
                o.total_minor, o.currency::text as currency, o.customer_id, o.customer_phone, c.email, org.country::text as country
           from orders o join organizations org on org.id = o.org_id left join customers c on c.id = o.customer_id where o.id = $1`, [orderId]);
      if (!o) return { done: { skipped: 'no_order' } };
      const eventId = purchaseEventId(o.public_ref);
      // One decision per order at a time (concurrent outbox handlers for order.paid and order.status_changed).
      await tx.query(`select pg_advisory_xact_lock(hashtext('meta-capi:' || $1::text))`, [o.id]);
      const existing = await tx.maybeOne<{ id: string; status: string; stale: boolean }>(
        `select id, status, updated_at < now() - interval '2 minutes' as stale from meta_capi_events where org_id = $1 and event_name = 'Purchase' and event_id = $2`, [orgId, eventId]);
      // 'pending' = another worker is delivering it right now; it is taken over only when that attempt is stale.
      if (existing && !(existing.status === 'failed' || (existing.status === 'pending' && existing.stale))) return { done: { skipped: `already_${existing.status}` } };
      const d = decidePurchase(o, await this.payments(tx, o.id), this.policy(conn));
      // "Not yet" outcomes record nothing: a later event (payment captured, order completed) decides again.
      if (!d.send && (d.reason === 'not_paid_yet' || d.reason === 'not_completed_yet')) return { done: { skipped: d.reason } };
      const ctxRow = await tx.maybeOne<any>(`select * from meta_tracking_contexts where order_id = $1`, [o.id]);
      const skip = async (reason: string) => {
        await tx.query(
          `insert into meta_capi_events(org_id, connection_id, order_id, event_name, event_id, source, status, skip_reason, test_mode)
           values ($1, $2, $3, 'Purchase', $4, 'order', 'skipped', $5, $6)
           on conflict (org_id, event_name, event_id) do update set status = 'skipped', skip_reason = excluded.skip_reason`,
          [orgId, conn.id, o.id, eventId, reason, conn.environment !== 'live']);
        return { done: { skipped: reason } };
      };
      if (!d.send) return skip(d.reason);
      if (o.channel !== 'web' || !ctxRow) return skip('no_consent');
      const lines = await tx.query<{ product_id: string | null; quantity: number; unit_price_minor: number }>(
        `select product_id, quantity, unit_price_minor from order_lines where order_id = $1`, [o.id]);
      const built = buildServerEvent({
        eventName: 'Purchase', eventId, eventTime: new Date(d.eventTime), eventSourceUrl: ctxRow.event_source_url ?? '',
        user: { email: o.email, phone: o.customer_phone, externalId: o.customer_id, country: o.country, clientIp: ctxRow.client_ip,
          userAgent: ctxRow.client_user_agent, fbp: ctxRow.fbp, fbc: ctxRow.fbc },
        custom: { currency: o.currency, valueMinor: Number(o.total_minor), orderId: eventId,
          contents: lines.filter((l) => l.product_id).map((l) => ({ id: l.product_id!, quantity: l.quantity, itemPriceMinor: Number(l.unit_price_minor) })) },
      });
      if ('error' in built) return skip(built.error);
      const ud = built.event.user_data as Record<string, unknown>;
      const summary = { basis: d.basis, valueMinor: Number(o.total_minor), currency: o.currency, matchKeys: Object.keys(ud).sort() };
      const row = await tx.one<{ id: string }>(
        `insert into meta_capi_events(org_id, connection_id, order_id, event_name, event_id, source, status, test_mode, summary)
         values ($1, $2, $3, 'Purchase', $4, 'order', 'pending', $5, $6)
         on conflict (org_id, event_name, event_id) do update set status = 'pending', connection_id = excluded.connection_id, summary = excluded.summary, updated_at = now()
         returning id`, [orgId, conn.id, o.id, eventId, conn.environment !== 'live', summary]);
      return { send: { rowId: row.id, connectionId: conn.id, event: built.event } };
    }, 'marketing.meta-capi');
    if ('done' in prepared) return prepared.done!;
    return this.deliver(orgId, prepared.send!.rowId, prepared.send!.connectionId, prepared.send!.event);
  }

  private async deliver(orgId: string, rowId: string, connectionId: string, event: Record<string, unknown>) {
    let result: { eventsReceived: number; fbtraceId: string | null } | null = null;
    let failure: { message: string; retryable: boolean } | null = null;
    try {
      const conn = await this.connections.load(orgId, { id: connectionId });
      result = await metaCapiAdapter.sendEvents(conn.adapter, [event]);
    } catch (e) {
      const d = redactedError(e);
      failure = { message: d.message, retryable: e instanceof ProviderError ? e.retryable : true };
    }
    await this.db.withTenant(orgId, async (tx) => {
      if (result) {
        await tx.query(`update meta_capi_events set status = 'sent', attempts = attempts + 1, events_received = $2, fbtrace_id = $3, error = null, sent_at = now() where id = $1`,
          [rowId, result.eventsReceived, result.fbtraceId]);
      } else {
        await tx.query(`update meta_capi_events set status = 'failed', attempts = attempts + 1, error = $2 where id = $1`, [rowId, failure!.message.slice(0, 500)]);
        await this.connections.log(tx, orgId, connectionId, 'warn', `Conversions API event failed: ${failure!.message}`, { rowId, retryable: failure!.retryable });
      }
    }, 'marketing.meta-capi');
    if (failure?.retryable) throw new Error(`meta capi send failed (will retry): ${failure.message}`);
    return result ? { sent: true, eventsReceived: result.eventsReceived } : { failed: failure!.message };
  }

  // ---------------------------------------------------------------------------
  // Dashboard: diagnostics and Test Events
  // ---------------------------------------------------------------------------
  async diagnostics(ctx: TenantContext) {
    return this.db.scoped(ctx, async (tx) => {
      const conn = await tx.maybeOne<any>(
        `select ic.id, ic.environment, ic.status, ic.enabled, ic.config, ic.last_error, coalesce((o.onboarding->>'demo')::boolean, false) as demo
           from integration_connections ic join organizations o on o.id = ic.org_id where ic.org_id = $1 and ic.provider = 'meta_capi' and ic.status <> 'revoked'
          order by ic.branch_id nulls first limit 1`, [ctx.orgId]);
      const counts = await tx.query<{ status: string; n: number }>(
        `select status, count(*)::int as n from meta_capi_events where org_id = $1 and created_at > now() - interval '7 days' group by status`, [ctx.orgId]);
      const recent = await tx.query<any>(
        `select id, event_name, event_id, source, status, skip_reason, test_mode, summary, attempts, events_received, fbtrace_id, error, sent_at, created_at
           from meta_capi_events where org_id = $1 order by created_at desc limit 25`, [ctx.orgId]);
      const consented = await tx.one<{ n: number }>(`select count(*)::int as n from meta_tracking_contexts where org_id = $1 and created_at > now() - interval '7 days'`, [ctx.orgId]);
      return {
        connection: conn ? {
          id: conn.id, environment: conn.environment, testMode: conn.environment !== 'live', status: conn.status, enabled: conn.enabled, pixelId: conn.config.pixelId ?? null,
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
   * Sends one synthetic Purchase to the Test Events tool (test connections only). It carries no customer data: a fixed
   * documentation IP (TEST-NET-3), the dashboard user's user agent and a synthetic external id.
   */
  async sendTestEvent(ctx: TenantContext, userAgent: string | null) {
    ctx.require('integrations:manage');
    const conn = await this.db.scoped(ctx, (tx) => tx.maybeOne<{ id: string; environment: string; enabled: boolean; status: string; config: Record<string, unknown> }>(
      `select id, environment, enabled, status, config from integration_connections where org_id = $1 and provider = 'meta_capi' and status <> 'revoked'
        order by branch_id nulls first limit 1`, [ctx.orgId]));
    if (!conn) throw conflict('not_configured', 'Connect Meta Pixel & Conversions API in Integrations first');
    if (conn.environment === 'live') throw conflict('test_connection_required', 'Test events are sent from a TEST connection with the Test Events code. Live connections only send real orders.');
    if (!conn.enabled) throw conflict('connection_unavailable', 'This connection is switched off');
    const eventId = `test.${randomUUID()}`;
    const built = buildServerEvent({
      eventName: 'Purchase', eventId, eventTime: new Date(), eventSourceUrl: 'https://resuto.app/meta-test-event',
      user: { clientIp: '203.0.113.10', userAgent: userAgent?.slice(0, 300) || 'Resuto Conversions API test', externalId: `resuto-test-${ctx.orgId}` },
      custom: { currency: 'EGP', valueMinor: 100 },
    });
    if ('error' in built) throw new DomainError('invalid_event', built.error, 500);
    const row = await this.db.scoped(ctx, async (tx) => {
      const r = await tx.one<{ id: string }>(
        `insert into meta_capi_events(org_id, connection_id, event_name, event_id, source, status, test_mode, summary)
         values ($1, $2, 'Purchase', $3, 'test', 'pending', true, $4) returning id`, [ctx.orgId, conn.id, eventId, { synthetic: true, matchKeys: ['client_ip_address', 'client_user_agent', 'external_id'] }]);
      await this.audit.record(tx, ctx, { action: 'marketing.meta_test_event', entityType: 'integration_connection', entityId: conn.id, metadata: { eventId } });
      return r;
    });
    const res = await this.deliver(ctx.orgId, row.id, conn.id, built.event).catch((e) => ({ failed: (e as Error).message }));
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
        `select c.email::text as email, c.phone_e164, c.marketing_consent, c.anonymized_at from segment_members m join customers c on c.id = m.customer_id
          where m.segment_id = $1 and m.org_id = $2`, [segmentId, ctx.orgId]);
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
