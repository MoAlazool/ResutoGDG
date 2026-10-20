import { Injectable, Logger } from '@nestjs/common';
import {
  buildButtonsMessage, buildCtaUrlMessage, buildListMessage, buildLocationRequestMessage, buildTemplateMessage, buildTextMessage,
  messagingSandboxAdapter, ProviderError, renderTemplateBody, whatsappCloudAdapter, type ListSection, type ReplyButton,
} from '@resuto/integrations';
import type { TenantContext } from '../../common/auth/context';
import { DbService, type Tx } from '../../common/db/db.service';
import { DomainError } from '../../common/errors/domain-error';
import { Scheduled } from '../../common/events/events';
import type { MessagingPort } from '../kernel/ports';
import { IntegrationConnectionsService } from '../integrations/connections.service';

export type OutboundContent =
  | { type: 'text'; body: string }
  | { type: 'buttons'; body: string; buttons: ReplyButton[]; header?: string | null }
  | { type: 'list'; body: string; buttonText: string; sections: ListSection[] }
  | { type: 'cta_url'; body: string; displayText: string; url: string }
  | { type: 'location_request'; body: string }
  | { type: 'template'; templateName: string; language: string; params: string[]; body: string };

export interface ConversationRow {
  id: string;
  org_id: string;
  channel_id: string;
  customer_id: string | null;
  external_contact: string;
  contact_name: string | null;
  status: string;
  last_inbound_at: Date | null;
  locale: 'en' | 'ar';
  transport: 'sandbox' | 'meta_cloud';
  connection_id: string | null;
  phone_number_id: string | null;
  waba_id: string | null;
  ordering_enabled: boolean;
  channel_status: string;
  branch_id: string | null;
  channel_branch_id: string | null;
}

export const WINDOW_MS = 24 * 3600 * 1000;
const MAX_ATTEMPTS = 6;
const backoffSeconds = (attempt: number) => Math.min(30 * 2 ** (attempt - 1), 3600);
const TRANSACTIONAL = /^(order|delivery|reservation|payment|ordering|bot|staff|handoff|system)/;
/** Sender fairness (PCL-12): messages per organization per run; transactional (priority 0) before marketing (1). */
export const SENDER_PER_ORG = 25;
/**
 * Lease on a claimed message. The claim writes it into next_attempt_at, and the preparation step renews it (compare
 * and set on the claimed value) immediately before the provider call, so the send (15 s adapter timeout, no retries
 * inside the adapter) always runs inside a lease that is at least this long, however long the run took to reach it.
 */
const LEASE = `interval '2 minutes'`;
/** Attempts to record a send the provider accepted before giving up (a failed record is never treated as a failed send). */
const RECORD_ATTEMPTS = 3;

/**
 * Next attempt delay in ms (PCL-12): the provider's Retry-After when it sent one, else exponential backoff; both get
 * jitter (+-20 %, never below Retry-After) so retries of many messages do not arrive in lockstep.
 */
export function retryDelayMs(attempt: number, retryAfterMs?: number, random = Math.random) {
  if (retryAfterMs && retryAfterMs > 0) return Math.round(Math.min(retryAfterMs, 3600_000) * (1 + 0.2 * random()));
  return Math.round(backoffSeconds(attempt) * 1000 * (0.8 + 0.4 * random()));
}

/** 0 = transactional (default, including staff replies), 1 = marketing (campaigns and other consented outreach). */
const priorityOf = (reason?: string) => (reason && !TRANSACTIONAL.test(reason) ? 1 : 0);

type Prepared =
  | { kind: 'skip' }
  | { kind: 'fail'; lease: string; attempt: number; error: string; retryable: boolean; connectionId?: string; detail?: string }
  | { kind: 'defer'; lease: string; until: Date }
  | { kind: 'send'; lease: string; attempt: number; conv: ConversationRow; conn: Awaited<ReturnType<IntegrationConnectionsService['loadInTx']>>; content: OutboundContent };

export function windowState(lastInboundAt: Date | string | null | undefined) {
  const last = lastInboundAt ? new Date(lastInboundAt).getTime() : 0;
  const closesAt = last ? new Date(last + WINDOW_MS) : null;
  return { open: !!closesAt && closesAt.getTime() > Date.now(), closesAt: closesAt?.toISOString() ?? null };
}

/** Templates usable on a channel: approved ones everywhere; "sandbox" ones only on sandbox channels. */
const usableStatuses = (transport: string) => (transport === 'sandbox' ? ['approved', 'sandbox'] : ['approved']);

/**
 * Outbound messaging for Connect (MESSAGING_PORT). Free-form messages are only
 * sent inside WhatsApp's 24-hour customer-service window (since the customer's
 * last inbound message); outside it an approved template is required (a
 * "sandbox" template on sandbox channels). Sandbox channels deliver locally and
 * never reach Meta; Cloud API messages are queued and sent by the sender job
 * with retries and exponential backoff.
 */
@Injectable()
export class MessagingService implements MessagingPort {
  private readonly logger = new Logger('Messaging');

  constructor(private readonly db: DbService, private readonly connections: IntegrationConnectionsService) {}

  async conversation(tx: Tx, id: string): Promise<ConversationRow | null> {
    return tx.maybeOne<ConversationRow>(
      `select c.id, c.org_id, c.channel_id, c.customer_id, c.external_contact, c.contact_name, c.status, c.last_inbound_at, c.locale, c.branch_id,
              ch.transport, ch.connection_id, ch.phone_number_id, ch.waba_id, ch.ordering_enabled, ch.status as channel_status, ch.branch_id as channel_branch_id
         from conversations c join messaging_channels ch on ch.id = c.channel_id where c.id = $1`, [id]);
  }

  /** Inserts an outbound message (queued) after window/template checks. Sandbox channels deliver immediately. */
  async enqueue(tx: Tx, conv: ConversationRow, content: OutboundContent, opts: { automated: boolean; sentBy?: string | null; reason?: string }) {
    if (conv.channel_status === 'disabled') throw new DomainError('channel_disabled', 'This channel is disabled', 409);
    const window = windowState(conv.last_inbound_at);
    if (content.type !== 'template' && !window.open) {
      throw new DomainError('outside_window', 'More than 24 hours since the customer last wrote. Use an approved template.', 409, { closesAt: window.closesAt });
    }
    if (content.type === 'template') {
      const t = await tx.maybeOne<{ id: string }>(`select id from message_templates where org_id = $1 and name = $2 and language = $3 and provider_status = any($4::text[])`,
        [conv.org_id, content.templateName, content.language, usableStatuses(conv.transport)]);
      if (!t) throw new DomainError('template_not_approved', `Template ${content.templateName} (${content.language}) is not approved for this channel`, 409);
    }
    const kind = content.type === 'text' ? 'text' : content.type === 'template' ? 'template' : 'interactive';
    const sandbox = conv.transport === 'sandbox';
    const msg = await tx.one<{ id: string }>(
      `insert into messages(org_id, conversation_id, direction, kind, body, payload, status, next_attempt_at, sent_by, is_automated, priority)
       values ($1, $2, 'outbound', $3, $4, $5, 'queued', now(), $6, $7, $8) returning id`,
      [conv.org_id, conv.id, kind, content.body.slice(0, 4096), { ...content, ...(sandbox ? { sandbox: true } : {}), ...(opts.reason ? { reason: opts.reason } : {}) },
        opts.sentBy ?? null, opts.automated, priorityOf(opts.reason)]);
    if (sandbox) {
      const res = await messagingSandboxAdapter.send(this.providerPayload(conv, content));
      await tx.query(`update messages set status = 'delivered', provider_message_id = $2, attempts = 1, next_attempt_at = null where id = $1`, [msg.id, res.messageId]);
    }
    await tx.query(`update conversations set last_message_at = now() where id = $1`, [conv.id]);
    return { messageId: msg.id, sandbox };
  }

  /** Meta Cloud API request body for a logical message. */
  providerPayload(conv: { external_contact: string }, c: OutboundContent): Record<string, unknown> {
    const to = conv.external_contact;
    switch (c.type) {
      case 'text': return buildTextMessage(to, c.body, /https?:\/\//.test(c.body));
      case 'buttons': return buildButtonsMessage(to, c.body, c.buttons, c.header);
      case 'list': return buildListMessage(to, c.body, c.buttonText, c.sections);
      case 'cta_url': return buildCtaUrlMessage(to, c.body, c.displayText, c.url);
      case 'location_request': return buildLocationRequestMessage(to, c.body);
      case 'template': return buildTemplateMessage(to, c.templateName, c.language, c.params);
    }
  }

  // ---------------------------------------------------------------------------
  // MESSAGING_PORT
  // ---------------------------------------------------------------------------
  async enqueueToCustomer(tx: Tx, ctx: TenantContext, input: {
    customerId?: string | null; phone?: string | null; templateName?: string | null; text?: string | null;
    variables?: Record<string, string>; orderId?: string | null; reason: string;
  }): Promise<{ messageId: string | null; skipped?: 'no_channel' | 'no_consent' | 'outside_window' }> {
    let convId: string | null = null;
    let customerId = input.customerId ?? null;
    if (input.orderId) {
      const o = await tx.maybeOne<{ conversation_id: string | null; customer_id: string | null }>(`select conversation_id, customer_id from orders where id = $1 and org_id = $2`, [input.orderId, ctx.orgId]);
      convId = o?.conversation_id ?? null;
      customerId ??= o?.customer_id ?? null;
    }
    if (!convId && customerId) {
      convId = (await tx.maybeOne<{ id: string }>(
        `select c.id from conversations c join messaging_channels ch on ch.id = c.channel_id
          where c.org_id = $1 and c.customer_id = $2 and ch.status <> 'disabled' order by c.last_inbound_at desc nulls last limit 1`, [ctx.orgId, customerId]))?.id ?? null;
    }
    if (!convId && input.phone) {
      convId = (await tx.maybeOne<{ id: string }>(
        `select c.id from conversations c join messaging_channels ch on ch.id = c.channel_id
          where c.org_id = $1 and c.external_contact = $2 and ch.status <> 'disabled' order by c.last_inbound_at desc nulls last limit 1`,
        [ctx.orgId, input.phone.replace(/^\+/, '')]))?.id ?? null;
    }
    if (!convId) return { messageId: null, skipped: 'no_channel' };
    const conv = await this.conversation(tx, convId);
    if (!conv || conv.channel_status === 'disabled') return { messageId: null, skipped: 'no_channel' };
    customerId ??= conv.customer_id;

    // Marketing messages need recorded consent; transactional updates (orders, deliveries,
    // reservations) go only to customers who contacted us on this conversation.
    if (!TRANSACTIONAL.test(input.reason)) {
      const c = customerId ? await tx.maybeOne<{ marketing_consent: boolean }>(`select marketing_consent from customers where id = $1`, [customerId]) : null;
      if (!c?.marketing_consent) return { messageId: null, skipped: 'no_consent' };
    }

    const open = windowState(conv.last_inbound_at).open;
    if (open && input.text) {
      const r = await this.enqueue(tx, conv, { type: 'text', body: input.text }, { automated: true, reason: input.reason });
      return { messageId: r.messageId };
    }
    if (input.templateName) {
      const t = await tx.maybeOne<{ name: string; language: string; body: string; variables: string[] }>(
        `select name, language, body, variables from message_templates where org_id = $1 and name = $2 and provider_status = any($3::text[])
          order by (language = $4) desc limit 1`, [ctx.orgId, input.templateName, usableStatuses(conv.transport), conv.locale]);
      if (t) {
        const params = t.variables.map((name, i) => input.variables?.[name] ?? input.variables?.[String(i + 1)] ?? '');
        const r = await this.enqueue(tx, conv, { type: 'template', templateName: t.name, language: t.language, params, body: renderTemplateBody(t.body, params) },
          { automated: true, reason: input.reason });
        return { messageId: r.messageId };
      }
    }
    return { messageId: null, skipped: 'outside_window' };
  }

  // ---------------------------------------------------------------------------
  // Delivery status callbacks (verified webhooks only)
  // ---------------------------------------------------------------------------
  async applyStatus(tx: Tx, providerMessageId: string, status: 'sent' | 'delivered' | 'read' | 'failed', error: string | null) {
    const rank = `case status when 'queued' then 0 when 'sent' then 1 when 'delivered' then 2 when 'read' then 3 else 4 end`;
    const target = { sent: 1, delivered: 2, read: 3, failed: 4 }[status];
    const updated = await tx.maybeOne<{ id: string }>(
      `update messages set status = $2, error = case when $2 = 'failed' then $3 else error end
        where provider_message_id = $1 and direction = 'outbound' and ${rank} < $4 and (status <> 'read' or $2 <> 'failed') returning id`,
      [providerMessageId, status, error, target]);
    if (updated) {
      await tx.query(`update campaign_deliveries set status = $2, error = case when $2 = 'failed' then $3 else error end where message_id = $1 and status not in ('skipped_no_consent')`,
        [updated.id, status, error]);
      if (status === 'read') {
        await tx.query(`insert into attribution_events(org_id, kind, campaign_id, customer_id)
                         select d.org_id, 'message_read', d.campaign_id, d.customer_id from campaign_deliveries d where d.message_id = $1`, [updated.id]);
      }
    }
    return !!updated;
  }

  // ---------------------------------------------------------------------------
  // Sender job: Cloud API messages with retries, backoff with jitter and per-tenant fairness
  // ---------------------------------------------------------------------------
  /**
   * Claims due messages and sends them. The claim (a 2-minute lease written into next_attempt_at) is the source of
   * truth for an in-progress send: every later step only acts while the message still carries that exact lease.
   * Each organization gets at most SENDER_PER_ORG messages per run, transactional before marketing, so a large
   * campaign cannot hold back another tenant's (or its own) order notifications (PCL-12).
   */
  @Scheduled('connect.outbound-sender', 5)
  async runSender(limit = 50, perOrg = SENDER_PER_ORG) {
    const due = await this.claimDue(limit, perOrg);
    let sent = 0, failed = 0, retried = 0;
    for (const m of due) {
      const outcome = await this.sendOne(m.org_id, m.id, m.lease).catch((e) => { this.logger.warn(`send ${m.id}: ${(e as Error).message}`); return 'retry' as const; });
      if (outcome === 'sent') sent++; else if (outcome === 'failed') failed++; else retried++;
    }
    return { due: due.length, sent, failed, retried };
  }

  /** Leases up to `limit` due Cloud API messages, at most `perOrg` per organization, transactional first. */
  async claimDue(limit: number, perOrg = SENDER_PER_ORG) {
    return this.db.withPlatform((tx) => tx.query<{ id: string; org_id: string; lease: string }>(
      `with orgs as (
         select distinct org_id from messages where status = 'queued' and direction = 'outbound' and next_attempt_at <= now()),
       picked as (
         select x.id, x.priority, x.next_attempt_at from orgs o cross join lateral (
           select m2.id, m2.priority, m2.next_attempt_at
             from messages m2 join conversations c on c.id = m2.conversation_id join messaging_channels ch on ch.id = c.channel_id
            where m2.org_id = o.org_id and m2.status = 'queued' and m2.direction = 'outbound' and m2.next_attempt_at <= now()
              and ch.transport = 'meta_cloud'
            order by m2.priority, m2.next_attempt_at limit $2) x)
       update messages m set next_attempt_at = now() + ${LEASE}
        where m.id in (select id from picked order by priority, next_attempt_at limit $1)
          and m.status = 'queued' and m.next_attempt_at <= now()
        returning m.id, m.org_id, m.next_attempt_at::text as lease`, [limit, perOrg]));
  }

  /**
   * One claimed message, in three steps (PCL-11): (1) a short transaction renews the lease and reads the message,
   * conversation and credentials; (2) the provider call runs outside any transaction, holding no database
   * connection; (3) a short transaction records the outcome, only if the message still carries the renewed lease.
   * A credential that is missing or cannot be decrypted fails the message for good (it used to retry every 2
   * minutes forever).
   *
   * The renewal is the fence against double sends: it is a compare-and-set on the value this run claimed. If the
   * claim had already run out and another run re-claimed the message, the value differs and this run skips it; if
   * this run renews first, next_attempt_at moves a full LEASE into the future and no other claim can take the
   * message while the (time-bounded) provider call is in flight.
   */
  private async sendOne(orgId: string, messageId: string, claimed: string): Promise<'sent' | 'failed' | 'retry'> {
    const prep = await this.db.withTenant(orgId, async (tx): Promise<Prepared> => {
      const m = await tx.maybeOne<any>(
        `update messages set next_attempt_at = now() + ${LEASE}
          where id = $1 and status = 'queued' and next_attempt_at = $2::timestamptz
          returning id, conversation_id, payload, attempts, next_attempt_at::text as lease`,
        [messageId, claimed]);
      if (!m) return { kind: 'skip' };
      const lease: string = m.lease;
      const attempt = m.attempts + 1;
      const conv = await this.conversation(tx, m.conversation_id);
      if (!conv?.connection_id || !conv.phone_number_id) return { kind: 'fail', lease, attempt, error: 'channel has no WhatsApp connection', retryable: false };
      let conn: Awaited<ReturnType<IntegrationConnectionsService['loadInTx']>>;
      try {
        conn = await this.connections.loadInTx(tx, conv.connection_id);
      } catch (e) {
        return { kind: 'fail', lease, attempt, error: 'whatsapp_connection_unavailable', retryable: false, connectionId: conv.connection_id, detail: (e as Error).message };
      }
      if (!conn.enabled || conn.status === 'revoked') return { kind: 'fail', lease, attempt, error: 'WhatsApp connection is disabled or revoked', retryable: false };
      const rl = await tx.maybeOne<{ until: Date | null }>(
        `select (rate_limit->>'limitedUntil')::timestamptz as until from integration_connections where id = $1`, [conn.id]);
      if (rl?.until && new Date(rl.until).getTime() > Date.now()) return { kind: 'defer', lease, until: new Date(rl.until) };
      const { sandbox: _s, reason: _r, ...content } = m.payload ?? {};
      return { kind: 'send', lease, attempt, conv, conn, content: content as OutboundContent };
    }, 'connect.sender');

    if (prep.kind === 'skip') return 'sent'; // already handled by another run
    if (prep.kind === 'defer') {
      // The connection is paused after a 429: wait for it without spending an attempt.
      await this.db.withTenant(orgId, (tx) => tx.query(
        `update messages set next_attempt_at = $3 where id = $1 and status = 'queued' and next_attempt_at = $2::timestamptz`,
        [messageId, prep.lease, new Date(prep.until.getTime() + Math.round(Math.random() * 5000))]), 'connect.sender');
      return 'retry';
    }
    const lease = prep.lease;
    if (prep.kind === 'fail') return this.recordFailure(orgId, messageId, lease, prep.attempt, prep.error, prep.retryable, undefined, prep);

    let res: { messageId: string };
    try {
      res = await whatsappCloudAdapter.send({ ...prep.conn.adapter, config: { ...prep.conn.adapter.config, phoneNumberId: prep.conv.phone_number_id } },
        this.providerPayload(prep.conv, prep.content));
    } catch (e) {
      if (e instanceof ProviderError) {
        if (e.status === 429) await this.connections.markRateLimited(orgId, prep.conn.id, e.retryAfterMs).catch(() => undefined);
        return this.recordFailure(orgId, messageId, lease, prep.attempt, e.message, e.retryable, e.retryAfterMs);
      }
      return this.recordFailure(orgId, messageId, lease, prep.attempt, `send failed: ${(e as Error).message}`, true);
    }
    // The provider accepted the message. From here on nothing may classify it as a failed send (that would requeue
    // and send it again): a failing record is retried, and if it still fails the lease is left in place and logged.
    await this.recordSent(orgId, messageId, lease, res.messageId, prep.attempt);
    return 'sent';
  }

  /** Step 3 for an accepted send. Returns whether the row was updated; never throws. */
  async recordSent(orgId: string, messageId: string, lease: string, providerMessageId: string, attempt: number, attempts = RECORD_ATTEMPTS): Promise<boolean> {
    for (let i = 1; i <= attempts; i++) {
      try {
        const recorded = await this.db.withTenant(orgId, async (tx) => {
          const row = await tx.maybeOne(
            `update messages set status = 'sent', provider_message_id = $3, attempts = $4, error = null, next_attempt_at = null
              where id = $1 and status = 'queued' and next_attempt_at = $2::timestamptz returning id`, [messageId, lease, providerMessageId, attempt]);
          if (row) await tx.query(`update campaign_deliveries set status = 'sent', sent_at = now() where message_id = $1`, [messageId]);
          return !!row;
        }, 'connect.sender');
        if (!recorded) this.logger.warn(`message ${messageId} was sent (${providerMessageId}) but its lease had moved on; status not recorded by this run`);
        return recorded;
      } catch (e) {
        if (i === attempts) {
          this.logger.error(`message ${messageId} was sent (${providerMessageId}) but recording it failed ${attempts} times: ${(e as Error).message}. `
            + 'The lease is left in place; the message may be sent again only if the database stays unavailable past it.');
          return false;
        }
        await new Promise((r) => setTimeout(r, 200 * 2 ** (i - 1)));
      }
    }
    return false;
  }

  private async recordFailure(orgId: string, messageId: string, lease: string, attempt: number, error: string, retryable: boolean,
    retryAfterMs?: number, log?: { connectionId?: string; detail?: string }): Promise<'failed' | 'retry'> {
    const final = !retryable || attempt >= MAX_ATTEMPTS;
    await this.db.withTenant(orgId, async (tx) => {
      const row = await tx.maybeOne(
        `update messages set attempts = $3, error = $4, status = $5, next_attempt_at = $6
          where id = $1 and status = 'queued' and next_attempt_at = $2::timestamptz returning id`,
        [messageId, lease, attempt, error.slice(0, 500), final ? 'failed' : 'queued', final ? null : new Date(Date.now() + retryDelayMs(attempt, retryAfterMs))]);
      if (row && final) await tx.query(`update campaign_deliveries set status = 'failed', error = $2 where message_id = $1`, [messageId, error.slice(0, 300)]);
      if (row && log?.connectionId) {
        // Shown in the connection's log in Integrations, so the owner sees why WhatsApp messages stopped.
        await this.connections.log(tx, orgId, log.connectionId, 'error', 'WhatsApp message not sent: the connection credentials are unavailable',
          { messageId, reason: (log.detail ?? '').slice(0, 200) });
      }
    }, 'connect.sender');
    return final ? 'failed' : 'retry';
  }
}
