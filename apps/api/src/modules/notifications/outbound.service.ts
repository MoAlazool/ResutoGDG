import { createHmac } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  constantTimeEqual, isE164, isEmailAddress, notificationAdapterFor, ProviderError, verifyResendWebhook, verifyTwilioStatusCallback, type DeliveryStatus, type StatusUpdate,
} from '@resuto/integrations';
import { TenantContext } from '../../common/auth/context';
import { purposeKeys, type KeyPurpose } from '../../common/crypto/keys';
import { SecretBox } from '../../common/crypto/secret-box';
import { DbService, type Tx } from '../../common/db/db.service';
import { Scheduled } from '../../common/events/events';
import { AuditService } from '../../common/platform/audit.service';
import { ENV, type Env } from '../../config/env';
import { IntegrationConnectionsService, redactedError } from '../integrations/connections.service';
import { maskEmail } from './email.provider';

export type OutboundChannel = 'email' | 'sms';
export type OutboundPurpose = 'marketing' | 'transactional' | 'staff';
export const CHANNEL_PROVIDER: Record<OutboundChannel, 'resend' | 'twilio_sms'> = { email: 'resend', sms: 'twilio_sms' };

/** Retry schedule after a retryable provider failure (attempt n waits BACKOFF_SECONDS[n-1]); then the message fails. */
export const BACKOFF_SECONDS = [60, 300, 1800, 7200] as const;
export const MAX_ATTEMPTS = BACKOFF_SECONDS.length + 1;
const LEASE_SECONDS = 120;
/** Statuses only move forward; failure states are terminal (a complaint after delivery still wins). */
const STATUS_RANK: Record<string, number> = {
  queued: 0, deferred: 0, sending: 1, unknown: 2, accepted: 2, sent: 3, delivered: 4, failed: 5, bounced: 5, complained: 5, undelivered: 5,
};
const UNSUBSCRIBE_PURPOSE = 'channel-unsubscribe' as KeyPurpose;

export interface OutboundConnection { id: string; provider: 'resend' | 'twilio_sms'; environment: 'sandbox' | 'live' }
export interface EnqueueOutbound {
  channel: OutboundChannel;
  purpose: OutboundPurpose;
  connection: OutboundConnection;
  to: string;
  customerId?: string | null;
  campaignId?: string | null;
  notificationId?: string | null;
  subject?: string | null;
  text: string;
  html?: string | null;
  idempotencyKey: string;
}
export type EnqueueResult = { id: string; status: 'queued' | 'deferred'; created: boolean } | { skipped: 'unsubscribed' | 'invalid_address' };

const b64u = (b: Buffer) => b.toString('base64url');
const uuidToB64 = (id: string) => b64u(Buffer.from(id.replace(/-/g, ''), 'hex'));
const b64ToUuid = (s: string) => {
  const h = Buffer.from(s, 'base64url').toString('hex');
  return h.length === 32 ? `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}` : null;
};
export const normaliseAddress = (channel: OutboundChannel, to: string) => (channel === 'email' ? to.trim().toLowerCase() : to.trim());
export const maskPhone = (p: string) => (p.length > 6 ? `${p.slice(0, 4)}••••${p.slice(-2)}` : '••••');

/**
 * Email and SMS through the restaurant's own provider (INT-28 / FT-27).
 *
 * - enqueue() runs in the caller's transaction: it validates the address, drops marketing to opted-out addresses,
 *   defers marketing that falls in the organisation's quiet hours, seals the address and writes one queue row
 *   (idempotent on the caller's key).
 * - send() runs after commit (and every 30 s as a job): it leases due rows, calls the provider outside any
 *   transaction, and records accepted / retry with backoff / failed. A row whose sender died mid-call is re-sent only
 *   when the provider de-duplicates (Resend Idempotency-Key, 24 h); SMS has no such key, so it becomes 'unknown'
 *   instead of risking a second text.
 * - Signed provider webhooks move statuses forward (delivered, bounced, complained → unsubscribed, undelivered) and
 *   update the linked campaign delivery / staff notification delivery.
 * No connection → callers record "not configured"; nothing is ever reported sent before the provider accepted it.
 */
@Injectable()
export class OutboundChannelsService {
  private readonly logger = new Logger('Outbound');

  constructor(
    private readonly db: DbService,
    private readonly box: SecretBox,
    private readonly connections: IntegrationConnectionsService,
    private readonly audit: AuditService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  // ---------------------------------------------------------------------------
  // Connections and policy
  // ---------------------------------------------------------------------------
  /** The connection a channel sends through: enabled, health-checked ('connected'), live preferred. */
  async activeConnection(tx: Tx, orgId: string, channel: OutboundChannel): Promise<OutboundConnection | null> {
    const r = await tx.maybeOne<{ id: string; environment: 'sandbox' | 'live' }>(
      `select id, environment from integration_connections
        where org_id = $1 and provider = $2 and enabled and status = 'connected'
        order by (environment = 'live') desc, updated_at desc limit 1`, [orgId, CHANNEL_PROVIDER[channel]]);
    return r ? { id: r.id, provider: CHANNEL_PROVIDER[channel], environment: r.environment } : null;
  }

  addressHash(channel: OutboundChannel, to: string): string {
    return createHmac('sha256', purposeKeys(this.env, UNSUBSCRIBE_PURPOSE).active).update(`${channel}:${normaliseAddress(channel, to)}`).digest('hex');
  }

  // ---------------------------------------------------------------------------
  // Enqueue (caller's transaction)
  // ---------------------------------------------------------------------------
  async enqueue(tx: Tx, orgId: string, input: EnqueueOutbound): Promise<EnqueueResult> {
    const to = normaliseAddress(input.channel, input.to);
    if (input.channel === 'email' ? !isEmailAddress(to) : !isE164(to)) return { skipped: 'invalid_address' };
    const hash = this.addressHash(input.channel, to);
    if (input.purpose === 'marketing') {
      const out = await tx.maybeOne(`select 1 from channel_unsubscribes where org_id = $1 and channel = $2 and address_hash = $3`, [orgId, input.channel, hash]);
      if (out) return { skipped: 'unsubscribed' };
    }
    const due = input.purpose === 'marketing' ? await this.quietHoursEnd(tx, orgId) : null;
    const id = (await tx.one<{ id: string }>('select gen_random_uuid() as id')).id;
    const row = await tx.maybeOne<{ id: string; status: 'queued' | 'deferred' }>(
      `insert into outbound_messages(id, org_id, channel, purpose, provider, connection_id, sandbox, customer_id, campaign_id, notification_id,
          recipient_sealed, recipient_hint, address_hash, subject, body_text, body_html, status, next_attempt_at, defer_reason, idempotency_key)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, coalesce($18::timestamptz, now()), $19, $20)
       on conflict (org_id, idempotency_key) do nothing returning id, status`,
      [id, orgId, input.channel, input.purpose, input.connection.provider, input.connection.id, input.connection.environment === 'sandbox',
        input.customerId ?? null, input.campaignId ?? null, input.notificationId ?? null,
        this.box.seal(to, `outbound:${orgId}:${id}`), input.channel === 'email' ? maskEmail(to) : maskPhone(to), hash,
        input.subject?.slice(0, 250) ?? null, input.text.slice(0, 5000), input.html ?? null,
        due ? 'deferred' : 'queued', due, due ? 'quiet_hours' : null, input.idempotencyKey]);
    if (row) return { id: row.id, status: row.status, created: true };
    const existing = await tx.one<{ id: string; status: string }>(`select id, status from outbound_messages where org_id = $1 and idempotency_key = $2`, [orgId, input.idempotencyKey]);
    return { id: existing.id, status: existing.status === 'deferred' ? 'deferred' : 'queued', created: false };
  }

  /**
   * When now falls inside the organisation's quiet hours (its time zone; default 22:00–09:00 until the owner changes
   * it), the end of that window; otherwise null.
   */
  private async quietHoursEnd(tx: Tx, orgId: string): Promise<string | null> {
    const r = await tx.one<{ until: Date | null }>(
      `with p as (
         select o.timezone as tz,
                case when mp.org_id is null then time '22:00' else mp.quiet_hours_start end as qs,
                case when mp.org_id is null then time '09:00' else mp.quiet_hours_end end as qe
           from organizations o left join messaging_policies mp on mp.org_id = o.id where o.id = $1),
       l as (select tz, qs, qe, (now() at time zone tz)::time as lt, date_trunc('day', now() at time zone tz) as d from p)
       select case
                when qs is null or qs = qe then null
                when (qs < qe and lt >= qs and lt < qe) or (qs > qe and (lt >= qs or lt < qe))
                  then (d + (case when lt >= qe then interval '1 day' else interval '0' end) + qe) at time zone tz
                else null end as until
         from l`, [orgId]);
    return r.until ? new Date(r.until).toISOString() : null;
  }

  async policy(orgId: string) {
    return this.db.withTenant(orgId, async (tx) => {
      const r = await tx.maybeOne<{ quiet_hours_start: string | null; quiet_hours_end: string | null }>(
        `select to_char(quiet_hours_start, 'HH24:MI') as quiet_hours_start, to_char(quiet_hours_end, 'HH24:MI') as quiet_hours_end from messaging_policies where org_id = $1`, [orgId]);
      const tz = (await tx.one<{ timezone: string }>('select timezone from organizations where id = $1', [orgId])).timezone;
      return r ? { quietHoursStart: r.quiet_hours_start, quietHoursEnd: r.quiet_hours_end, timezone: tz, isDefault: false }
        : { quietHoursStart: '22:00', quietHoursEnd: '09:00', timezone: tz, isDefault: true };
    }, 'system:outbound');
  }

  async setPolicy(tx: Tx, orgId: string, p: { quietHoursStart: string | null; quietHoursEnd: string | null }) {
    await tx.query(
      `insert into messaging_policies(org_id, quiet_hours_start, quiet_hours_end) values ($1, $2::time, $3::time)
       on conflict (org_id) do update set quiet_hours_start = excluded.quiet_hours_start, quiet_hours_end = excluded.quiet_hours_end`,
      [orgId, p.quietHoursStart, p.quietHoursEnd]);
  }

  // ---------------------------------------------------------------------------
  // Unsubscribe (link in every marketing message, RFC 8058 one-click for email)
  // ---------------------------------------------------------------------------
  /** Compact token for one queue row: base64url(uuid) + "." + 128-bit HMAC (short enough for an SMS). */
  unsubscribeToken(outboundId: string): string {
    const id = uuidToB64(outboundId);
    return `${id}.${b64u(createHmac('sha256', purposeKeys(this.env, UNSUBSCRIBE_PURPOSE).active).update(`unsub:${id}`).digest().subarray(0, 16))}`;
  }

  private verifyToken(token: string): string | null {
    const m = /^([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{22})$/.exec(token);
    if (!m) return null;
    const ok = purposeKeys(this.env, UNSUBSCRIBE_PURPOSE).all.some((k) =>
      constantTimeEqual(m[2]!, b64u(createHmac('sha256', k).update(`unsub:${m[1]}`).digest().subarray(0, 16))));
    return ok ? b64ToUuid(m[1]!) : null;
  }

  /** Web page link (shown in the message body). */
  unsubscribePageUrl(outboundId: string) { return this.pageForToken(this.unsubscribeToken(outboundId)); }
  pageForToken(token: string) { return `${this.env.APP_ORIGIN.replace(/\/$/, '')}/unsubscribe?t=${encodeURIComponent(token.slice(0, 64))}`; }
  /** List-Unsubscribe target: accepts the RFC 8058 one-click POST. */
  unsubscribeApiUrl(outboundId: string) { return `${this.env.API_ORIGIN.replace(/\/$/, '')}/v1/public/unsubscribe/${this.unsubscribeToken(outboundId)}`; }

  private async tokenRow(token: string) {
    const id = this.verifyToken(token);
    if (!id) return null;
    return this.db.withPlatform((tx) => tx.maybeOne<{ id: string; org_id: string; channel: OutboundChannel; address_hash: string; customer_id: string | null; org_name: string }>(
      `select m.id, m.org_id, m.channel, m.address_hash, m.customer_id, o.name as org_name
         from outbound_messages m join organizations o on o.id = m.org_id where m.id = $1`, [id]), 'public:unsubscribe');
  }

  async unsubscribeStatus(token: string) {
    const r = await this.tokenRow(token);
    if (!r) return null;
    const out = await this.db.withTenant(r.org_id, (tx) => tx.maybeOne(`select 1 from channel_unsubscribes where org_id = $1 and channel = $2 and address_hash = $3`,
      [r.org_id, r.channel, r.address_hash]), 'public:unsubscribe');
    return { channel: r.channel, restaurant: r.org_name, unsubscribed: !!out };
  }

  async unsubscribe(token: string, source: 'link' | 'one_click') {
    const r = await this.tokenRow(token);
    if (!r) return null;
    await this.db.withTenant(r.org_id, (tx) => this.recordUnsubscribe(tx, r.org_id, r.channel, r.address_hash, r.customer_id, source), 'public:unsubscribe');
    return { channel: r.channel, restaurant: r.org_name, unsubscribed: true };
  }

  private async recordUnsubscribe(tx: Tx, orgId: string, channel: OutboundChannel, hash: string, customerId: string | null, source: string) {
    const ins = await tx.query(
      `insert into channel_unsubscribes(org_id, channel, address_hash, customer_id, source) values ($1, $2, $3, $4, $5)
       on conflict (org_id, channel, address_hash) do nothing returning id`, [orgId, channel, hash, customerId, source]);
    if (ins.length) {
      // Marketing still waiting in the queue for this address is not sent.
      await tx.query(
        `update outbound_messages set status = 'failed', last_error = 'unsubscribed', lease_until = null
          where org_id = $1 and channel = $2 and address_hash = $3 and purpose = 'marketing' and status in ('queued', 'deferred')`, [orgId, channel, hash]);
      await this.audit.record(tx, TenantContext.system(orgId, `unsubscribe:${source}`),
        { action: 'marketing.channel_unsubscribed', entityType: 'customer', entityId: customerId, metadata: { channel, source } });
    }
  }

  // ---------------------------------------------------------------------------
  // Sender (after commit, and the job)
  // ---------------------------------------------------------------------------
  /**
   * Sends due queue rows. `ids` limits the run to rows the caller just enqueued (send right after commit);
   * without it the job takes up to `limit` due rows across tenants.
   */
  @Scheduled('notify.outbound-send', 30, { timeoutMs: 120_000 })
  async send(scope: { orgId?: string; ids?: string[]; limit?: number } = {}) {
    await this.recoverStale();
    const claimed = await this.db.withPlatform((tx) => tx.query<any>(
      `update outbound_messages o set status = 'sending', attempts = o.attempts + 1, lease_until = now() + make_interval(secs => $4)
        where o.id in (
          select id from outbound_messages
           where status in ('queued', 'deferred') and next_attempt_at <= now()
             and ($1::uuid is null or org_id = $1) and ($2::uuid[] is null or id = any($2::uuid[]))
           order by next_attempt_at limit $3 for update skip locked)
        returning o.*`, [scope.orgId ?? null, scope.ids ?? null, scope.limit ?? 50, LEASE_SECONDS]), 'system:outbound');
    const results: Record<string, number> = {};
    for (const row of claimed) {
      const status = await this.deliver(row);
      results[status] = (results[status] ?? 0) + 1;
    }
    return { claimed: claimed.length, ...results };
  }

  /** Rows whose sender died mid-call: e-mail is retried (provider idempotency), SMS is marked 'unknown' (no duplicates). */
  private async recoverStale() {
    await this.db.withPlatform(async (tx) => {
      await tx.query(`update outbound_messages set status = 'queued', lease_until = null, next_attempt_at = now()
                        where status = 'sending' and lease_until < now() and provider = 'resend' and attempts < $1`, [MAX_ATTEMPTS]);
      const lost = await tx.query<any>(
        `update outbound_messages set status = 'unknown', lease_until = null, last_error = 'outcome_unknown_after_interruption', status_at = now()
          where status = 'sending' and lease_until < now() returning *`);
      for (const r of lost) await this.syncLinked(tx, r);
    }, 'system:outbound');
  }

  private async deliver(row: any): Promise<string> {
    const adapter = notificationAdapterFor(row.provider);
    let outcome: { status: DeliveryStatus | 'deferred'; providerMessageId?: string; error?: string; retryInSeconds?: number };
    try {
      if (!adapter) throw new ProviderError(row.provider, 'no adapter', false);
      if (!row.connection_id) throw new ProviderError(row.provider, 'connection_removed', false);
      const conn = await this.connections.load(row.org_id, { id: row.connection_id });
      if (!conn.enabled || conn.status === 'revoked') throw new ProviderError(row.provider, 'connection_disabled', false);
      let to = this.box.open(row.recipient_sealed, `outbound:${row.org_id}:${row.id}`);
      // A test (sandbox) Resend connection only ever writes to Resend's documented test inbox.
      if (row.sandbox && row.provider === 'resend') to = `delivered+${row.id.slice(0, 8)}@resend.dev`;
      const marketing = row.purpose === 'marketing';
      const locale = row.customer_id ? (await this.db.withTenant(row.org_id, (tx) => tx.maybeOne<{ locale: string }>(
        'select locale from customers where id = $1', [row.customer_id]), 'system:outbound'))?.locale ?? 'en' : 'en';
      const page = marketing ? this.unsubscribePageUrl(row.id) : null;
      const footer = page ? (row.channel === 'sms' ? (locale === 'ar' ? `\nلإيقاف الرسائل: ${page}` : `\nOpt out: ${page}`)
        : (locale === 'ar' ? `\n\nلإلغاء الاشتراك: ${page}` : `\n\nUnsubscribe: ${page}`)) : '';
      const html = row.body_html && page
        ? `${row.body_html}<p style="font-size:12px;color:#666"><a href="${page}">${locale === 'ar' ? 'إلغاء الاشتراك' : 'Unsubscribe'}</a></p>` : row.body_html;
      const res = await adapter.send(conn.adapter, {
        to, subject: row.subject ?? undefined, text: `${row.body_text}${footer}`, html, idempotencyKey: `resuto-outbound-${row.id}`,
        unsubscribeUrl: marketing && row.channel === 'email' ? this.unsubscribeApiUrl(row.id) : null,
        statusCallbackUrl: row.provider === 'twilio_sms' ? `${this.env.API_ORIGIN.replace(/\/$/, '')}/v1/webhooks/twilio/status/${row.connection_id}` : null,
        tags: row.campaign_id ? { campaign: row.campaign_id } : undefined,
      });
      outcome = { status: res.status === 'queued' ? 'accepted' : res.status, providerMessageId: res.providerMessageId };
    } catch (e) {
      const d = redactedError(e);
      const retryable = e instanceof ProviderError ? e.retryable : false;
      if (retryable && row.attempts < MAX_ATTEMPTS) {
        const after = e instanceof ProviderError && e.retryAfterMs ? Math.ceil(e.retryAfterMs / 1000) : BACKOFF_SECONDS[row.attempts - 1]!;
        outcome = { status: 'deferred', error: d.message, retryInSeconds: after };
      } else {
        outcome = { status: 'failed', error: d.message };
      }
      this.logger.warn(`outbound ${row.id} (${row.provider}) attempt ${row.attempts}: ${d.message}`);
    }
    await this.db.withTenant(row.org_id, async (tx) => {
      const updated = await tx.maybeOne<any>(
        `update outbound_messages set status = $2, provider_message_id = coalesce($3, provider_message_id), last_error = $4, lease_until = null,
            next_attempt_at = case when $2 = 'deferred' then now() + make_interval(secs => $5) else next_attempt_at end,
            defer_reason = case when $2 = 'deferred' then 'retry' else defer_reason end,
            accepted_at = case when $3::text is not null then now() else accepted_at end, status_at = now()
          where id = $1 and status = 'sending' returning *`,
        [row.id, outcome.status, outcome.providerMessageId ?? null, outcome.error?.slice(0, 300) ?? null, outcome.retryInSeconds ?? 0]);
      if (updated) await this.syncLinked(tx, updated);
    }, 'system:outbound');
    return outcome.status;
  }

  // ---------------------------------------------------------------------------
  // Provider status webhooks
  // ---------------------------------------------------------------------------
  private async webhookConnection(connectionId: string, provider: 'resend' | 'twilio_sms') {
    if (!/^[0-9a-f-]{36}$/i.test(connectionId)) return null;
    const r = await this.db.withPlatform((tx) => tx.maybeOne<{ org_id: string }>(
      `select org_id from integration_connections where id = $1 and provider = $2 and status <> 'revoked'`, [connectionId, provider]), 'webhook:outbound');
    if (!r) return null;
    return this.connections.load(r.org_id, { id: connectionId });
  }

  async resendWebhook(connectionId: string, rawBody: Buffer | undefined, headers: Record<string, string | string[] | undefined>) {
    const conn = await this.webhookConnection(connectionId, 'resend');
    if (!conn) return { status: 404, body: { ok: false, error: 'unknown_connection' } };
    const v = verifyResendWebhook({ secret: conn.adapter.credentials.webhookSecret, headers, rawBody: rawBody?.toString('utf8') ?? '' });
    if (!v.valid) return { status: v.reason === 'not_configured' ? 404 : 401, body: { ok: false, error: v.reason } };
    if (!v.update) return { status: 200, body: { ok: true, ignored: true } };
    return { status: 200, body: { ok: true, ...(await this.applyStatus(conn.orgId, 'resend', v.update)) } };
  }

  async twilioWebhook(connectionId: string, params: Record<string, string>, signature: string | undefined) {
    const conn = await this.webhookConnection(connectionId, 'twilio_sms');
    if (!conn) return { status: 404, body: { ok: false, error: 'unknown_connection' } };
    const url = `${this.env.API_ORIGIN.replace(/\/$/, '')}/v1/webhooks/twilio/status/${connectionId}`;
    const v = verifyTwilioStatusCallback({ authToken: conn.adapter.credentials.authToken, url, params, signature });
    if (!v.valid) return { status: v.reason === 'not_configured' ? 404 : 401, body: { ok: false, error: v.reason } };
    if (!v.update) return { status: 200, body: { ok: true, ignored: true } };
    return { status: 200, body: { ok: true, ...(await this.applyStatus(conn.orgId, 'twilio_sms', v.update)) } };
  }

  /** Applies a verified status (forward only). A complaint unsubscribes the address from that channel. */
  async applyStatus(orgId: string, provider: string, u: StatusUpdate) {
    return this.db.withTenant(orgId, async (tx) => {
      const row = await tx.maybeOne<any>(`select * from outbound_messages where org_id = $1 and provider = $2 and provider_message_id = $3 for update`,
        [orgId, provider, u.providerMessageId]);
      if (!row) return { applied: false, reason: 'unknown_message' };
      if ((STATUS_RANK[u.status] ?? 0) <= (STATUS_RANK[row.status] ?? 0)) return { applied: false, reason: 'not_newer' };
      const updated = await tx.one<any>(
        `update outbound_messages set status = $2, status_at = now(), delivered_at = case when $2 = 'delivered' then now() else delivered_at end,
            last_error = case when $3::text is not null then $3 else last_error end where id = $1 returning *`,
        [row.id, u.status, u.errorCode ? `provider_error_${String(u.errorCode).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40)}` : null]);
      if (u.status === 'complained') await this.recordUnsubscribe(tx, orgId, row.channel, row.address_hash, row.customer_id, 'provider_complaint');
      await this.syncLinked(tx, updated);
      return { applied: true, status: u.status };
    }, `webhook:${provider}`);
  }

  // ---------------------------------------------------------------------------
  // Linked records
  // ---------------------------------------------------------------------------
  private async syncLinked(tx: Tx, row: any) {
    if (row.campaign_id) {
      const s = row.status;
      const mapped = s === 'delivered' ? 'delivered' : ['accepted', 'sent'].includes(s) ? 'sent'
        : ['failed', 'bounced', 'complained', 'undelivered', 'unknown'].includes(s) ? 'failed' : 'queued';
      await tx.query(
        `update campaign_deliveries set status = $2, sent_at = case when $2 in ('sent', 'delivered') then coalesce(sent_at, now()) else sent_at end,
            error = case when $2 = 'failed' then $3 else null end
          where outbound_id = $1 and status <> 'skipped_unsubscribed'`, [row.id, mapped, s === 'failed' ? (row.last_error ?? 'failed') : s]);
    }
    if (row.notification_id) {
      const agg = await tx.one<{ pending: number; ok: number; delivered: number; total: number; ids: string | null; err: string | null }>(
        `select count(*) filter (where status in ('queued', 'deferred', 'sending'))::int as pending,
                count(*) filter (where status in ('accepted', 'sent', 'delivered'))::int as ok,
                count(*) filter (where status = 'delivered')::int as delivered, count(*)::int as total,
                string_agg(provider_message_id, ',') as ids, max(last_error) as err
           from outbound_messages where notification_id = $1`, [row.notification_id]);
      const status = agg.pending ? 'queued' : agg.delivered === agg.total ? 'delivered' : agg.ok ? 'sent' : 'failed';
      await tx.query(
        `update notification_deliveries set status = $2, provider_message_id = $3, error = $4, attempted_at = now()
          where notification_id = $1 and channel = 'email'`, [row.notification_id, status, agg.ids, status === 'failed' ? agg.err : null]);
    }
  }
}
