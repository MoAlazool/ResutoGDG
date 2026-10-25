import { Inject, Injectable } from '@nestjs/common';
import { can, ROLE_PERMISSIONS, type ChannelRoutingMode, type ConnectSandboxInbound, type InboxConversationFilters, type InboxStaffReply, type Role } from '@resuto/contracts';
import { renderTemplateBody } from '@resuto/integrations';
import { randomUUID } from 'node:crypto';
import { TenantContext } from '../../common/auth/context';
import { DbService, type Tx } from '../../common/db/db.service';
import { DomainError, conflict, invalid, notFound } from '../../common/errors/domain-error';
import { AuditService } from '../../common/platform/audit.service';
import { branchScope, cursorAt as cursorAtSql, keyset, pageOf } from '../../common/http/pagination';
import { IdempotencyService } from '../../common/platform/idempotency.service';
import { OutboxService } from '../../common/platform/outbox.service';
import { ENV, type Env } from '../../config/env';
import { OrdersKernelService } from '../kernel/orders-kernel.service';
import { hasArabic, textCommand } from './bot-copy';
import { HandoffService } from './handoff.service';
import { NOTE_SELECT, noteView, tagsByConversation } from './inbox.service';
import { assertConnectSandbox } from './sandbox-gate';
import { HUMAN_AGENT_WINDOW_MS, MessagingService, windowState, type ConversationRow } from './messaging.service';
import { OrderingService, type InboundMessage } from './ordering.service';

export interface InboundEnvelope extends InboundMessage {
  /** wa_id style digits (no +). */
  from: string;
  contactName: string | null;
  providerMessageId: string;
  raw: Record<string, unknown>;
}

const KIND: Record<InboundMessage['type'], string> = {
  text: 'text', button_reply: 'button_reply', list_reply: 'list_reply', button: 'button_reply', location: 'location', image: 'image', other: 'text',
};
const iso = (v: Date | string | null | undefined) => (v ? new Date(v).toISOString() : null);

/**
 * The contact's phone number for display, or null on Messenger / Instagram, whose page-scoped ids (PSID / IGSID) are
 * not phone numbers (INT-21).
 */
export const phoneContact = (transport: string, externalContact: string): string | null =>
  transport === 'meta_page' ? null : `+${externalContact.replace(/^\+/, '')}`;

/** Roles that can reply in the inbox (connect:reply): the people a routed conversation may go to. */
const REPLY_ROLES = (Object.keys(ROLE_PERMISSIONS) as Role[]).filter((r) => ROLE_PERMISSIONS[r].includes('connect:reply'));

/**
 * Assigns a new conversation by the channel's routing (21-INT, plan §6.9 step 5). Candidates are active members whose
 * role can reply and who can see the conversation's branch (branch-scoped RLS). 'round_robin' picks the candidate who
 * was assigned a conversation least recently (never assigned first, ties by user id); 'by_branch' does the same among
 * members assigned to that branch specifically, falling back to all-branch members when the branch has none.
 */
export async function assignByRouting(tx: Tx, orgId: string, conversationId: string, branchId: string | null, mode: ChannelRoutingMode) {
  if (mode === 'manual') return null;
  const pick = (branchOnly: boolean) => tx.maybeOne<{ user_id: string }>(
    `select m.user_id from memberships m
      where m.org_id = $1 and m.status = 'active' and m.role::text = any($2::text[])
        and ($3::uuid is null or m.branch_ids is null or $3 = any(m.branch_ids))
        and (not $4 or ($3::uuid is not null and m.branch_ids is not null and $3 = any(m.branch_ids)))
      order by (select max(c.created_at) from conversations c where c.org_id = $1 and c.assigned_to = m.user_id) asc nulls first, m.user_id
      limit 1`, [orgId, REPLY_ROLES, branchId, branchOnly]);
  const chosen = (mode === 'by_branch' && branchId ? await pick(true) : null) ?? await pick(false);
  if (!chosen) return null;
  await tx.query(`update conversations set assigned_to = $2 where id = $1 and assigned_to is null`, [conversationId, chosen.user_id]);
  return chosen.user_id;
}

@Injectable()
export class ConversationsService {
  constructor(
    private readonly db: DbService,
    private readonly messaging: MessagingService,
    private readonly ordering: OrderingService,
    private readonly handoffs: HandoffService,
    private readonly kernel: OrdersKernelService,
    private readonly outbox: OutboxService,
    private readonly audit: AuditService,
    private readonly idempotency: IdempotencyService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  // ---------------------------------------------------------------------------
  // Inbound (verified webhook or sandbox simulator) — idempotent per provider message id
  // ---------------------------------------------------------------------------
  async receiveInTx(tx: Tx, ctx: TenantContext, channelId: string, m: InboundEnvelope) {
    const dup = await tx.maybeOne<{ id: string; conversation_id: string }>(`select id, conversation_id from messages where provider_message_id = $1`, [m.providerMessageId]);
    if (dup) return { conversationId: dup.conversation_id, messageId: dup.id, duplicate: true };
    const channel = await tx.one<{ branch_id: string | null; ordering_enabled: boolean; transport: string; kind: string; routing: string }>(
      `select branch_id, ordering_enabled, transport, kind, routing from messaging_channels where id = $1`, [channelId]);
    const contact = m.from.replace(/^\+/, '');
    // Reply language: Arabic text switches to Arabic; an English start command switches back.
    const lang = hasArabic(m.text) ? 'ar' : m.text && /[a-z]/i.test(m.text) && textCommand(m.text) ? 'en' : null;
    const conv = await tx.one<{ id: string; customer_id: string | null; inserted: boolean }>(
      `insert into conversations(org_id, branch_id, channel_id, external_contact, contact_name, status, last_message_at, last_inbound_at, unread_count, locale)
       values ($1, $2, $3, $4, $5, $6, now(), now(), 1, $7)
       on conflict (channel_id, external_contact) do update set
         contact_name = coalesce(excluded.contact_name, conversations.contact_name), last_message_at = now(), last_inbound_at = now(),
         unread_count = conversations.unread_count + 1,
         status = case when conversations.status = 'closed' then $6 else conversations.status end,
         locale = coalesce($8, conversations.locale)
       returning id, customer_id, (xmax = 0) as inserted`,
      [ctx.orgId, channel.branch_id, channelId, contact, m.contactName, channel.ordering_enabled ? 'bot' : 'open', lang ?? 'en', lang]);
    // 21-INT staff routing: a new conversation on a round-robin / by-branch channel gets an owner right away.
    if (conv.inserted && channel.routing !== 'manual') await assignByRouting(tx, ctx.orgId, conv.id, channel.branch_id, channel.routing as ChannelRoutingMode);
    // Only a WhatsApp id is a phone number; Messenger / Instagram ids (PSID / IGSID) are page-scoped and never a phone.
    if (!conv.customer_id && channel.kind === 'whatsapp' && /^[1-9][0-9]{6,14}$/.test(contact)) {
      const customerId = await this.kernel.resolveCustomer(tx, ctx.orgId, { name: m.contactName, phone: `+${contact}` }, 'whatsapp');
      if (customerId) await tx.query(`update conversations set customer_id = $2 where id = $1`, [conv.id, customerId]);
    }
    const body = m.type === 'location' && m.location ? (m.location.address ?? m.location.name ?? `${m.location.latitude},${m.location.longitude}`) : m.text;
    const msg = await tx.one<{ id: string }>(
      `insert into messages(org_id, conversation_id, direction, kind, body, payload, provider_message_id, status)
       values ($1, $2, 'inbound', $3, $4, $5, $6, 'received') returning id`,
      [ctx.orgId, conv.id, KIND[m.type], body?.slice(0, 4096) ?? null,
        { type: m.type, replyId: m.replyId, location: m.location, ...(m.type === 'other' ? { unsupported: true } : {}), ...(channel.transport === 'sandbox' ? { sandbox: true } : {}) },
        m.providerMessageId]);
    await this.outbox.publish(tx, ctx.orgId, { type: 'message.inbound', aggregateType: 'conversation', aggregateId: conv.id, payload: { messageId: msg.id } });
    const row = (await this.messaging.conversation(tx, conv.id))!;
    await this.ordering.handleInbound(tx, ctx, row, m);
    return { conversationId: conv.id, messageId: msg.id, duplicate: false };
  }

  /** Staff sandbox simulator: only sandbox channels, every message labelled sandbox. */
  async simulate(ctx: TenantContext, input: ConnectSandboxInbound) {
    assertConnectSandbox(this.env);
    const channel = await this.db.scoped(ctx, (tx) => tx.maybeOne<{ id: string; transport: string; branch_id: string | null }>(
      `select id, transport, branch_id from messaging_channels where id = $1 and org_id = $2`, [input.channelId, ctx.orgId]));
    if (!channel) throw notFound('Channel');
    ctx.assertBranch(channel.branch_id);
    if (channel.transport !== 'sandbox') throw conflict('not_sandbox', 'The simulator only works on sandbox channels');
    const envelope: InboundEnvelope = {
      from: input.from.replace(/^\+/, ''), contactName: input.name ?? null, providerMessageId: `sandbox-in.${randomUUID()}`, raw: {},
      type: input.location ? 'location' : input.reply ? 'button_reply' : 'text',
      text: input.text ?? input.reply?.title ?? null, replyId: input.reply?.id ?? null,
      location: input.location ? { latitude: input.location.latitude, longitude: input.location.longitude, name: input.location.name ?? null, address: input.location.address ?? null } : null,
    };
    // Same tenant-mode path as the verified webhook; the bot acts as the system.
    const botCtx = new TenantContext(ctx.orgId, 'admin', null, null, 'system', 'connect.sandbox', 'api');
    const result = await this.db.withTenant(ctx.orgId, async (tx) => {
      const r = await this.receiveInTx(tx, botCtx, channel.id, envelope);
      await this.audit.record(tx, ctx, { action: 'connect.sandbox_inbound', entityType: 'conversation', entityId: r.conversationId, branchId: channel.branch_id,
        metadata: { sandbox: true, type: envelope.type } });
      return r;
    }, `${ctx.actorType}:${ctx.actorId}`);
    return { ...result, sandbox: true, conversation: await this.detail(ctx, result.conversationId) };
  }

  // ---------------------------------------------------------------------------
  // Inbox
  // ---------------------------------------------------------------------------
  list(ctx: TenantContext, f: InboxConversationFilters) {
    // Shared keyset (PS-22): opaque cursor at microsecond precision, branch scope in SQL before the limit. The
    // "iso|uuid" cursors issued before are still accepted (millisecond precision, as they were).
    const legacy = f.cursor && /^\d{4}-\d\d-\d\dT[^|]{1,40}\|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(f.cursor)
      && !Number.isNaN(Date.parse(f.cursor.split('|')[0]!)) ? f.cursor.split('|') : null;
    const k = keyset(legacy ? null : f.cursor);
    const [cursorAt, cursorId] = legacy ?? (k.key ? [String(k.key.at), k.key.id] : [null, null]);
    const lastAt = 'coalesce(c.last_message_at, c.created_at)';
    // 21-INBOX increment 2 (workspace views): the live ordering session (at most one per conversation, unique index
    // ordering_sessions_one_live) and whether the contact is a lead (no counted order in the caller's branch scope).
    const liveSession = `select s.step from ordering_sessions s where s.conversation_id = c.id and s.step not in ('completed', 'cancelled', 'expired')`;
    const lead = `(c.customer_id is null or not exists (select 1 from orders o where o.customer_id = c.customer_id and o.org_id = c.org_id
                     and o.status not in ('cancelled', 'awaiting_payment') and ${branchScope('o.branch_id', 11)}))`;
    return this.db.scoped(ctx, async (tx) => {
      const rows = await tx.query(
        `select ${cursorAtSql(lastAt)} as cursor_at, c.id, c.channel_id, c.customer_id, c.external_contact, c.contact_name, c.status, c.assigned_to, c.last_message_at, c.last_inbound_at,
                c.unread_count, c.branch_id, c.locale, ch.display_name as channel_name, ch.transport, ch.kind as channel_kind, cu.display_name as customer_name,
                lm.body as last_body, lm.direction as last_direction, lm.kind as last_kind,
                exists(select 1 from handoffs h where h.conversation_id = c.id and h.status <> 'resolved') as handoff_open,
                (${liveSession} limit 1) as ordering_step, ${lead} as is_lead
           from conversations c join messaging_channels ch on ch.id = c.channel_id
           left join customers cu on cu.id = c.customer_id
           left join lateral (select body, direction, kind from messages m where m.conversation_id = c.id and m.kind <> 'note' order by m.created_at desc limit 1) lm on true
          where c.org_id = $1
            and ($2::text is null or c.status = $2)
            and ($3::boolean is null or ($3 and c.unread_count > 0) or (not $3 and c.unread_count = 0))
            and ($4::text is null or ($4 = 'me' and c.assigned_to = $5) or ($4 = 'unassigned' and c.assigned_to is null))
            and ($6::uuid is null or c.channel_id = $6)
            and ($7::text is null or c.contact_name ilike '%' || $7 || '%' or c.external_contact like '%' || $7 || '%' or cu.display_name ilike '%' || $7 || '%')
            and ($8::timestamptz is null or (${lastAt}, c.id) < ($8, $9::uuid))
            and ${branchScope('c.branch_id', 11)}
            and ($12::uuid is null or exists (select 1 from conversation_tag_assignments ta where ta.conversation_id = c.id and ta.tag_id = $12))
            and ($13::text is null or ($13 = 'ordering' and exists (${liveSession})) or ($13 = 'leads' and ${lead}))
          order by ${lastAt} desc, c.id desc limit $10`,
        [ctx.orgId, f.status ?? null, f.unread ?? null, f.assigned ?? null, ctx.userId, f.channelId ?? null,
          f.q ? f.q.replace(/[%_\\]/g, '') : null, cursorAt || null, cursorId || null, k.fetch(f.limit), ctx.branchFilter, f.tagId ?? null, f.view ?? null]);
      const tags = await tagsByConversation(tx, rows.slice(0, f.limit).map((r) => r.id));
      return pageOf(rows, f.limit, (r) => ({ at: r.cursor_at, id: r.id }), (r) => ({
        id: r.id, channelId: r.channel_id, channelName: r.channel_name, channelKind: r.channel_kind, sandbox: r.transport === 'sandbox', customerId: r.customer_id,
        contact: phoneContact(r.transport, r.external_contact), name: r.customer_name ?? r.contact_name, status: r.status, assignedTo: r.assigned_to,
        unreadCount: r.unread_count, lastMessageAt: iso(r.last_message_at), lastMessage: r.last_body ? { body: r.last_body, direction: r.last_direction, kind: r.last_kind } : null,
        window: windowState(r.last_inbound_at), handoffOpen: r.handoff_open, locale: r.locale, tags: tags.get(r.id) ?? [],
        branchId: r.branch_id, orderingStep: r.ordering_step ?? null, lead: r.is_lead,
      }));
    });
  }

  private async conv(tx: Tx, ctx: TenantContext, id: string) {
    const c = await tx.maybeOne<any>(`select id, branch_id, status, channel_id from conversations where id = $1 and org_id = $2`, [id, ctx.orgId]);
    if (!c) throw notFound('Conversation');
    ctx.assertBranch(c.branch_id);
    return c;
  }

  detail(ctx: TenantContext, id: string) {
    return this.db.scoped(ctx, async (tx) => {
      await this.conv(tx, ctx, id);
      const c = (await this.messaging.conversation(tx, id))!;
      const extra = await tx.one<any>(`select c.assigned_to, c.unread_count, c.created_at, ch.display_name, cu.display_name as customer_name, cu.marketing_consent, cu.phone_e164
          from conversations c join messaging_channels ch on ch.id = c.channel_id left join customers cu on cu.id = c.customer_id where c.id = $1`, [id]);
      const messages = await tx.query(
        `select * from (select id, direction, kind, body, payload, status, error, attempts, sent_by, is_automated, provider_message_id, created_at
           from messages where conversation_id = $1 and kind <> 'note' order by created_at desc limit 200) x order by created_at`, [id]);
      // Internal notes (21-INBOX) are staff-only and listed apart from the customer thread (latest 50, oldest first).
      const notes = await tx.query(
        `select * from (select ${NOTE_SELECT} from messages m left join profiles p on p.id = m.sent_by
           where m.conversation_id = $1 and m.kind = 'note' order by m.created_at desc, m.id desc limit 50) x order by created_at, id`, [id]);
      const tags = (await tagsByConversation(tx, [id])).get(id) ?? [];
      const handoff = await tx.maybeOne(`select id, reason, status, requested_at, accepted_by, accepted_at from handoffs where conversation_id = $1 and status <> 'resolved'`, [id]);
      return {
        id, status: c.status, channel: { id: c.channel_id, name: extra.display_name, transport: c.transport, kind: c.channel_kind, sandbox: c.transport === 'sandbox' },
        contact: phoneContact(c.transport, c.external_contact), contactName: c.contact_name, locale: c.locale, assignedTo: extra.assigned_to, unreadCount: extra.unread_count,
        customer: c.customer_id ? { id: c.customer_id, name: extra.customer_name, phone: extra.phone_e164, marketingConsent: extra.marketing_consent } : null,
        window: windowState(c.last_inbound_at), botActive: c.status === 'bot' && !handoff,
        // Messenger / Instagram: after 24 hours staff can still reply (HUMAN_AGENT tag) until this time; templates do not exist there.
        humanReplyUntil: c.transport === 'meta_page' && c.last_inbound_at ? new Date(new Date(c.last_inbound_at).getTime() + HUMAN_AGENT_WINDOW_MS).toISOString() : null,
        handoff: handoff ? { id: handoff.id, reason: handoff.reason, status: handoff.status, requestedAt: iso(handoff.requested_at), acceptedBy: handoff.accepted_by } : null,
        orderingSession: await this.ordering.staffSummary(tx, id),
        messages: messages.map((m) => ({
          id: m.id, direction: m.direction, kind: m.kind, body: m.body, status: m.status, error: m.error, attempts: m.attempts, sentBy: m.sent_by,
          automated: m.is_automated, sandbox: !!m.payload?.sandbox, interactive: m.kind === 'interactive' || m.kind === 'template' ? m.payload : null,
          createdAt: iso(m.created_at),
        })),
        notes: notes.map(noteView),
        tags,
      };
    });
  }

  markRead(ctx: TenantContext, id: string) {
    return this.db.scoped(ctx, async (tx) => {
      await this.conv(tx, ctx, id);
      await tx.query(`update conversations set unread_count = 0 where id = $1`, [id]);
      return { id, unreadCount: 0 };
    });
  }

  reply(ctx: TenantContext, id: string, input: InboxStaffReply) {
    return this.db.scoped(ctx, async (tx) => {
      const c0 = await this.conv(tx, ctx, id);
      return this.idempotency.run(tx, ctx.orgId, `connect.reply:${id}`, input.key, input, async () => {
        const conv = (await this.messaging.conversation(tx, id))!;
        let res;
        if (input.templateName && conv.transport === 'meta_page') {
          throw new DomainError('template_not_supported', 'Messenger and Instagram have no message templates: reply within 24 hours, or as a person within 7 days.', 409);
        }
        if (input.templateName) {
          const t = await tx.maybeOne<{ name: string; language: string; body: string; variables: string[] }>(
            `select name, language, body, variables from message_templates where org_id = $1 and name = $2 order by (language = $3) desc limit 1`,
            [ctx.orgId, input.templateName, conv.locale]);
          if (!t) throw notFound('Template');
          const params = t.variables.map((_, i) => input.variables?.[i] ?? '');
          if (params.some((p) => !p)) throw invalid('template_variables', `This template needs ${t.variables.length} value(s)`);
          res = await this.messaging.enqueue(tx, conv, { type: 'template', templateName: t.name, language: t.language, params, body: renderTemplateBody(t.body, params) },
            { automated: false, sentBy: ctx.userId, reason: 'staff' });
        } else {
          res = await this.messaging.enqueue(tx, conv, { type: 'text', body: input.text! }, { automated: false, sentBy: ctx.userId, reason: 'staff' });
        }
        await tx.query(`update conversations set unread_count = 0, status = case when status = 'closed' then 'open' else status end where id = $1`, [id]);
        await this.audit.record(tx, ctx, { action: 'connect.reply', entityType: 'conversation', entityId: id, branchId: c0.branch_id, metadata: { messageId: res.messageId, sandbox: res.sandbox } });
        return { messageId: res.messageId, sandbox: res.sandbox };
      });
    });
  }

  /** Staff takes over: opens (or accepts) a handoff; the bot pauses until it is resolved. */
  takeOver(ctx: TenantContext, id: string, reason: string | null | undefined) {
    return this.db.scoped(ctx, async (tx) => {
      const c = await this.conv(tx, ctx, id);
      if (c.status === 'closed') throw conflict('conversation_closed', 'Reopen the conversation first');
      const h = await this.handoffs.open(tx, ctx, id, reason ?? 'Staff took over', ctx.userId);
      await this.audit.record(tx, ctx, { action: 'connect.handoff', entityType: 'conversation', entityId: id, branchId: c.branch_id, metadata: { handoffId: h.id } });
      return { conversationId: id, handoffId: h.id, status: 'handoff' };
    });
  }

  resolveHandoff(ctx: TenantContext, id: string) {
    return this.db.scoped(ctx, async (tx) => {
      const c = await this.conv(tx, ctx, id);
      await this.handoffs.resolve(tx, id);
      await this.audit.record(tx, ctx, { action: 'connect.handoff_resolved', entityType: 'conversation', entityId: id, branchId: c.branch_id });
      return { conversationId: id, status: (await tx.one(`select status from conversations where id = $1`, [id])).status };
    });
  }

  /** Staff "Resend" on a failed outbound message (FT-12): re-queued under the current window rules, audited. */
  resendMessage(ctx: TenantContext, messageId: string) {
    return this.db.scoped(ctx, async (tx) => {
      const r = await this.messaging.resend(tx, ctx, messageId);
      if (r.resent) {
        const c = await tx.one<{ id: string; branch_id: string | null }>(
          `select c.id, c.branch_id from messages m join conversations c on c.id = m.conversation_id where m.id = $1`, [messageId]);
        await this.audit.record(tx, ctx, { action: 'connect.message_resent', entityType: 'message', entityId: messageId, branchId: c.branch_id,
          metadata: { conversationId: c.id } });
      }
      return r;
    });
  }

  /** People a conversation can be assigned to: active members whose role can reply in the inbox (connect:reply). */
  assignees(ctx: TenantContext) {
    return this.db.scoped(ctx, async (tx) => {
      const rows = await tx.query<{ user_id: string; role: Role; full_name: string | null; email: string | null }>(
        `select m.user_id, m.role, p.full_name, p.email from memberships m left join profiles p on p.id = m.user_id
          where m.org_id = $1 and m.status = 'active' order by coalesce(p.full_name, p.email)`, [ctx.orgId]);
      return { items: rows.filter((r) => can(r.role, 'connect:reply')).map((r) => ({ userId: r.user_id, role: r.role, name: r.full_name ?? r.email ?? r.role })) };
    });
  }

  assign(ctx: TenantContext, id: string, userId: string | null) {
    return this.db.scoped(ctx, async (tx) => {
      const c = await this.conv(tx, ctx, id);
      if (userId) {
        const m = await tx.maybeOne<{ role: Role }>(`select role from memberships where org_id = $1 and user_id = $2 and status = 'active'`, [ctx.orgId, userId]);
        if (!m) throw invalid('not_a_member', 'Assign to an active team member');
        if (!can(m.role, 'connect:reply')) throw invalid('cannot_reply', 'This person\'s role cannot reply to customers');
      }
      await tx.query(`update conversations set assigned_to = $2 where id = $1`, [id, userId]);
      await this.audit.record(tx, ctx, { action: 'connect.assigned', entityType: 'conversation', entityId: id, branchId: c.branch_id, metadata: { userId } });
      return { conversationId: id, assignedTo: userId };
    });
  }

  setClosed(ctx: TenantContext, id: string, closed: boolean) {
    return this.db.scoped(ctx, async (tx) => {
      const c = await this.conv(tx, ctx, id);
      if (closed) {
        await this.handoffs.resolve(tx, id);
        await tx.query(`update conversations set status = 'closed', unread_count = 0 where id = $1`, [id]);
      } else {
        if (c.status !== 'closed') throw new DomainError('not_closed', 'This conversation is open', 409);
        const ch = await tx.one<{ ordering_enabled: boolean }>(`select ordering_enabled from messaging_channels where id = $1`, [c.channel_id]);
        await tx.query(`update conversations set status = $2 where id = $1`, [id, ch.ordering_enabled ? 'bot' : 'open']);
      }
      await this.audit.record(tx, ctx, { action: closed ? 'connect.closed' : 'connect.reopened', entityType: 'conversation', entityId: id, branchId: c.branch_id });
      return { conversationId: id, status: (await tx.one(`select status from conversations where id = $1`, [id])).status };
    });
  }
}
