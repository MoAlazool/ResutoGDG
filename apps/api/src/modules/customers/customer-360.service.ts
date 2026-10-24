import { Injectable } from '@nestjs/common';
import {
  CUSTOMER_360_LIMITS as L, CUSTOMER_360_UNTRUSTED_FIELDS,
  type AcquisitionBasis, type Customer360, type Customer360Section, type ConversationTag,
} from '@resuto/contracts';
import type { TenantContext } from '../../common/auth/context';
import type { Tx } from '../../common/db/db.service';
import { EntitlementsService } from '../../common/entitlements/entitlements.service';
import { branchScope, int, iso } from '../analytics/scope';
import { NOTE_SELECT, noteView, tagView, tagsByConversation } from '../connect/inbox.service';
import { windowState } from '../connect/messaging.service';
import { CustomersService } from './customers.service';

/** Orders that count towards customer value (as in customers.service.ts and the customer_stats read model). */
const COUNTED = `o.status not in ('cancelled', 'awaiting_payment')`;
/** Favourite items are counted over the customer's latest counted orders (bounded work for very frequent guests). */
const TOP_ITEMS_ORDER_WINDOW = 500;
const DAY_MS = 86_400_000;
/** Identity kinds that name a way to reach the customer (pos/web ids are internal references). */
const CONTACT_KINDS = new Set(['phone', 'whatsapp', 'email', 'instagram', 'facebook']);
const MESSAGING = new Set(['whatsapp', 'messenger', 'instagram']);
/** Attribution counts as recorded only with a UTM value or a campaign (validated campaign ids, never free text). */
const UTM_KEYS = `array['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term']`;

const utmOf = (u: Record<string, unknown> | null | undefined) => {
  const s = (k: string) => (typeof u?.[k] === 'string' && (u[k] as string).length ? (u[k] as string).slice(0, 100) : null);
  return { source: s('utm_source'), medium: s('utm_medium'), campaign: s('utm_campaign'), content: s('utm_content'), term: s('utm_term') };
};

/**
 * Customer 360 (21-INBOX, plan §6.5): one bounded read of everything the inbox side panel shows about a customer.
 * Every query runs in the caller's RLS session; branch-scoped staff see the customer only when the profile is
 * visible to them, and orders, reservations, stats and conversations only for their branches. Conversation data
 * (threads, notes, tags, service windows) needs connect:read and the Connect module; loyalty needs the Marketing
 * module. `sections` says which parts were left out and why. Nothing is estimated: a value with no source is null.
 */
@Injectable()
export class Customer360Service {
  constructor(private readonly customers: CustomersService, private readonly entitlements: EntitlementsService) {}

  async get(tx: Tx, ctx: TenantContext, id: string): Promise<Customer360> {
    const { row: c, mode } = await this.customers.findVisible(tx, ctx, id);
    const scope = branchScope(ctx);
    const conversationsSection: Customer360Section = !ctx.can('connect:read') ? 'no_permission'
      : (await this.entitlements.isEnabled(ctx.orgId, 'connect')) ? 'included' : 'not_entitled';
    const loyaltySection: Customer360Section = (await this.entitlements.isEnabled(ctx.orgId, 'marketing')) ? 'included' : 'not_entitled';
    const withConversations = conversationsSection === 'included';

    const [identities, currency, topItems, cadenceRows, recentCounts, consentHistory, recentOrders, reservations] = await Promise.all([
      tx.query(`select id, kind, value, verified_at from customer_identities where customer_id = $1 and org_id = $2 order by created_at, id limit ${L.identities}`,
        [id, ctx.orgId]),
      tx.one<{ currency: string }>(`select currency from organizations where id = $1`, [ctx.orgId]),
      tx.query(
        `with recent as (
           select o.id from orders o where o.customer_id = $1 and o.org_id = $2 and ${COUNTED} and ($3::uuid[] is null or o.branch_id = any($3))
            order by o.placed_at desc limit ${TOP_ITEMS_ORDER_WINDOW})
         select (array_agg(l.product_id))[1] as product_id, (array_agg(l.name order by l.created_at desc))[1] as name,
                (array_agg(l.name_ar order by l.created_at desc))[1] as name_ar, sum(l.quantity)::int as quantity, count(distinct l.order_id)::int as order_count
           from order_lines l join recent r on r.id = l.order_id
          group by coalesce(l.product_id::text, 'name:' || l.name)
          order by quantity desc, order_count desc, name limit ${L.topItems}`, [id, ctx.orgId, scope]),
      tx.query<{ placed_at: Date }>(
        `select o.placed_at from orders o where o.customer_id = $1 and o.org_id = $2 and ${COUNTED} and ($3::uuid[] is null or o.branch_id = any($3))
          order by o.placed_at desc limit ${L.cadenceOrders}`, [id, ctx.orgId, scope]),
      tx.one<{ d30: number; d90: number }>(
        `select count(*) filter (where o.placed_at > now() - interval '30 days')::int as d30, count(*) filter (where o.placed_at > now() - interval '90 days')::int as d90
           from orders o where o.customer_id = $1 and o.org_id = $2 and ${COUNTED} and ($3::uuid[] is null or o.branch_id = any($3))
            and o.placed_at > now() - interval '90 days'`, [id, ctx.orgId, scope]),
      tx.query(`select id, purpose, granted, source, actor, occurred_at from customer_consent_events where customer_id = $1 and org_id = $2
                 order by occurred_at desc, id limit ${L.consentHistory}`, [id, ctx.orgId]),
      tx.query(`select id, number, branch_id, channel, fulfillment, status, payment_status, total_minor, placed_at from orders o
                 where o.customer_id = $1 and o.org_id = $2 and ($3::uuid[] is null or o.branch_id = any($3)) order by o.placed_at desc, o.id limit ${L.recentOrders}`,
        [id, ctx.orgId, scope]),
      tx.query(`select id, code, branch_id, starts_at, party_size, status, guest_name from reservations
                 where customer_id = $1 and org_id = $2 and ($3::uuid[] is null or branch_id = any($3)) order by starts_at desc, id limit ${L.reservations}`,
        [id, ctx.orgId, scope]),
    ]);

    // Conversations, their tags and internal notes (connect:read + Connect module only).
    let conversations: Customer360['conversations'] = null;
    let conversationTags: ConversationTag[] = [];
    let notes: Customer360['notes']['conversation'] = null;
    const windows = new Map<string, Date | null>();
    let firstConversation: { created_at: Date; channel_kind: string } | null = null;
    if (withConversations) {
      const convs = await tx.query(
        `select c.id, c.channel_id, c.status, c.branch_id, c.contact_name, c.assigned_to, c.unread_count, c.last_message_at, c.last_inbound_at,
                ch.kind as channel_kind, ch.display_name as channel_name, lm.body as last_body, lm.direction as last_direction, lm.kind as last_kind
           from conversations c join messaging_channels ch on ch.id = c.channel_id
           left join lateral (select body, direction, kind from messages m where m.conversation_id = c.id and m.kind <> 'note'
                               order by m.created_at desc limit 1) lm on true
          where c.customer_id = $1 and c.org_id = $2 and ($3::uuid[] is null or c.branch_id is null or c.branch_id = any($3))
          order by c.last_message_at desc nulls last, c.id limit ${L.conversations}`, [id, ctx.orgId, scope]);
      const tags = await tagsByConversation(tx, convs.map((r) => r.id));
      conversations = convs.map((r) => ({
        id: r.id, channelId: r.channel_id, channelKind: r.channel_kind, channelName: r.channel_name, status: r.status, branchId: r.branch_id,
        contactName: r.contact_name, assignedTo: r.assigned_to, unreadCount: r.unread_count, lastMessageAt: iso(r.last_message_at),
        lastMessage: r.last_kind ? { body: r.last_body, direction: r.last_direction, kind: r.last_kind } : null,
        window: windowState(r.last_inbound_at), tags: tags.get(r.id) ?? [],
      }));
      // Over every conversation of the customer the caller can see (not only the latest ten).
      const [allTags, noteRows, perChannel, first] = await Promise.all([
        tx.query(
          `select distinct on (lower(t.name), t.id) t.id, t.name, t.color, t.created_at
             from conversation_tag_assignments a join conversation_tags t on t.id = a.tag_id join conversations c on c.id = a.conversation_id
            where c.customer_id = $1 and c.org_id = $2 and ($3::uuid[] is null or c.branch_id is null or c.branch_id = any($3))
            order by lower(t.name), t.id limit 20`, [id, ctx.orgId, scope]),
        tx.query(
          `select ${NOTE_SELECT} from messages m join conversations c on c.id = m.conversation_id left join profiles p on p.id = m.sent_by
            where c.customer_id = $1 and c.org_id = $2 and m.kind = 'note' and ($3::uuid[] is null or c.branch_id is null or c.branch_id = any($3))
            order by m.created_at desc, m.id desc limit ${L.conversationNotes}`, [id, ctx.orgId, scope]),
        tx.query<{ kind: string; last_inbound_at: Date | null }>(
          `select ch.kind, max(c.last_inbound_at) as last_inbound_at from conversations c join messaging_channels ch on ch.id = c.channel_id
            where c.customer_id = $1 and c.org_id = $2 and ($3::uuid[] is null or c.branch_id is null or c.branch_id = any($3)) group by ch.kind`,
          [id, ctx.orgId, scope]),
        tx.maybeOne<{ created_at: Date; channel_kind: string }>(
          `select c.created_at, ch.kind as channel_kind from conversations c join messaging_channels ch on ch.id = c.channel_id
            where c.customer_id = $1 and c.org_id = $2 and ($3::uuid[] is null or c.branch_id is null or c.branch_id = any($3))
            order by c.created_at, c.id limit 1`, [id, ctx.orgId, scope]),
      ]);
      conversationTags = allTags.map(tagView);
      notes = noteRows.map(noteView);
      for (const r of perChannel) windows.set(r.kind, r.last_inbound_at);
      firstConversation = first;
    }

    let loyalty: Customer360['loyalty'] = null;
    if (loyaltySection === 'included') {
      const [acct, program] = await Promise.all([
        tx.maybeOne<{ balance: number; lifetime_earned: number }>(`select balance, lifetime_earned from loyalty_accounts where org_id = $1 and customer_id = $2`,
          [ctx.orgId, id]),
        tx.maybeOne<{ is_active: boolean }>(`select is_active from loyalty_programs where org_id = $1`, [ctx.orgId]),
      ]);
      loyalty = { programActive: !!program?.is_active, balance: acct?.balance ?? 0, lifetimeEarned: acct?.lifetime_earned ?? 0 };
    }

    // Consent: one marketing decision per customer, repeated for each channel the customer can be reached on.
    const marketing = { granted: !!c.marketing_consent, source: c.marketing_consent_source ?? null, at: iso(c.marketing_consent_at) };
    const channelNames = new Set<string>();
    for (const i of identities) if (CONTACT_KINDS.has(i.kind)) channelNames.add(i.kind === 'facebook' ? 'messenger' : i.kind);
    for (const k of windows.keys()) channelNames.add(k);
    const channels = [...channelNames].sort().map((channel) => ({
      channel, scope: 'customer' as const, ...marketing,
      serviceWindow: withConversations && MESSAGING.has(channel) ? (windows.has(channel) ? windowState(windows.get(channel)) : { open: false, closesAt: null }) : null,
    }));

    const spend = int(c.spend_minor);
    const orderCount = c.order_count ?? 0;
    const times = cadenceRows.map((r) => new Date(r.placed_at).getTime());
    const gaps = times.slice(1).map((t, i) => (times[i]! - t) / DAY_MS).sort((a, b) => a - b);
    const median = gaps.length ? (gaps.length % 2 ? gaps[(gaps.length - 1) / 2]! : (gaps[gaps.length / 2 - 1]! + gaps[gaps.length / 2]!) / 2) : null;

    return {
      customer: {
        id: c.id, displayName: c.display_name, phone: c.phone_e164, email: c.email, locale: c.locale, tags: c.tags ?? [],
        firstSeenAt: iso(c.first_seen_at), lastSeenAt: iso(c.last_seen_at), anonymisedAt: iso(c.anonymized_at), createdAt: iso(c.created_at)!,
      },
      identities: identities.map((i) => ({ id: i.id, kind: i.kind, value: i.value, verifiedAt: iso(i.verified_at) })),
      stats: {
        source: mode === 'org' ? 'customer_stats' : 'customer_branch_stats',
        orderCount, spendMinor: spend, averageOrderMinor: orderCount ? Math.round(spend / orderCount) : 0, currency: currency.currency,
        firstOrderAt: iso(c.first_order_at), lastOrderAt: iso(c.last_order_at),
        cadence: {
          basis: 'counted_orders', ordersLast30Days: recentCounts.d30, ordersLast90Days: recentCounts.d90,
          daysSinceLastOrder: times.length ? Math.floor((Date.now() - times[0]!) / DAY_MS) : null,
          medianDaysBetweenOrders: median === null ? null : Math.round(median * 10) / 10, sampleSize: times.length,
        },
      },
      topItems: topItems.map((r) => ({ productId: r.product_id, name: r.name, nameAr: r.name_ar, quantity: r.quantity, orderCount: r.order_count })),
      consent: {
        perChannel: false, marketing, channels,
        history: consentHistory.map((e) => ({ id: e.id, purpose: e.purpose, granted: e.granted, source: e.source, actor: e.actor, occurredAt: iso(e.occurred_at)! })),
      },
      acquisition: { firstTouch: await this.firstTouch(tx, ctx, id, scope, firstConversation) },
      recentOrders: recentOrders.map((o) => ({ id: o.id, number: o.number, branchId: o.branch_id, channel: o.channel, fulfillment: o.fulfillment,
        status: o.status, paymentStatus: o.payment_status, totalMinor: int(o.total_minor), placedAt: iso(o.placed_at)! })),
      reservations: reservations.map((r) => ({ id: r.id, code: r.code, branchId: r.branch_id, startsAt: iso(r.starts_at)!, partySize: r.party_size,
        status: r.status, guestName: r.guest_name })),
      loyalty,
      conversations,
      tags: { customer: c.tags ?? [], conversation: conversationTags },
      notes: { profile: c.notes ?? null, conversation: notes },
      sections: { conversations: conversationsSection, loyalty: loyaltySection },
      untrustedFields: CUSTOMER_360_UNTRUSTED_FIELDS,
      generatedAt: new Date().toISOString(),
    };
  }

  /**
   * First touch, from recorded attribution when there is any, in this order of evidence:
   *   1. the earliest attribution event of the customer that carries UTM values or a campaign (order placed/paid,
   *      reservation, page view...; campaign messages sent to an existing customer are not acquisition), or a tracked
   *      link click with the same tracking session as one of the customer's orders (clicks carry no customer id);
   *   2. the earliest of the customer's orders with stored attribution (orders older than the event log);
   *   3. inferred, labelled inferred = true: the channel of the first order or of the first conversation.
   * Orders and their events outside a branch-scoped caller's branches are not used.
   */
  private async firstTouch(tx: Tx, ctx: TenantContext, id: string, scope: string[] | null,
    firstConversation: { created_at: Date; channel_kind: string } | null): Promise<Customer360['acquisition']['firstTouch']> {
    const touch = await tx.maybeOne<{ kind: string; occurred_at: Date; utm: Record<string, unknown>; campaign_id: string | null; order_id: string | null;
      campaign_name: string | null; channel: string | null; basis: AcquisitionBasis }>(
      `with own_orders as (
         select o.id, o.attribution, o.campaign_id, o.placed_at, o.channel from orders o
          where o.customer_id = $1 and o.org_id = $2 and ($3::uuid[] is null or o.branch_id = any($3))),
       sessions as (
         select distinct o.attribution->>'session_key' as k from own_orders o where coalesce(o.attribution->>'session_key', '') <> ''
         union
         select distinct e.session_key from attribution_events e where e.customer_id = $1 and e.org_id = $2 and coalesce(e.session_key, '') <> ''
            and (e.order_id is null or e.order_id in (select id from own_orders))),
       candidates as (
         select e.kind, e.occurred_at, e.utm, e.campaign_id, e.order_id, 'attribution_event'::text as basis, e.id as seq
           from attribution_events e
          where e.customer_id = $1 and e.org_id = $2 and e.kind not in ('message_sent', 'message_read')
            and (e.utm ?| ${UTM_KEYS} or e.campaign_id is not null)
            and (e.order_id is null or e.order_id in (select id from own_orders))
         union all
         select e.kind, e.occurred_at, e.utm, e.campaign_id, null, 'tracked_link_click', e.id
           from attribution_events e
          where e.org_id = $2 and e.kind = 'link_click' and e.session_key in (select k from sessions)
         union all
         select 'order_placed', o.placed_at, o.attribution, o.campaign_id, o.id, 'order_attribution', 9223372036854775807 -- an event at the same time wins
           from own_orders o
          where o.attribution ?| ${UTM_KEYS} or o.campaign_id is not null)
       select x.kind, x.occurred_at, x.utm, x.campaign_id, x.order_id, x.basis, cp.name as campaign_name,
              (select o.channel::text from own_orders o where o.id = x.order_id) as channel
         from candidates x left join campaigns cp on cp.id = x.campaign_id and cp.org_id = $2
        order by x.occurred_at, x.seq limit 1`, [id, ctx.orgId, scope]);
    if (touch) {
      return { basis: touch.basis, inferred: false, occurredAt: iso(touch.occurred_at), channel: touch.channel, utm: utmOf(touch.utm),
        campaignId: touch.campaign_id, campaignName: touch.campaign_name, orderId: touch.order_id };
    }
    const firstOrder = await tx.maybeOne<{ id: string; channel: string; placed_at: Date }>(
      `select o.id, o.channel::text as channel, o.placed_at from orders o where o.customer_id = $1 and o.org_id = $2 and ($3::uuid[] is null or o.branch_id = any($3))
        order by o.placed_at, o.id limit 1`, [id, ctx.orgId, scope]);
    const empty = { utm: utmOf(null), campaignId: null, campaignName: null };
    if (firstOrder && (!firstConversation || new Date(firstOrder.placed_at) <= new Date(firstConversation.created_at))) {
      return { basis: 'first_order_channel', inferred: true, occurredAt: iso(firstOrder.placed_at), channel: firstOrder.channel, orderId: firstOrder.id, ...empty };
    }
    if (firstConversation) {
      return { basis: 'first_conversation_channel', inferred: true, occurredAt: iso(firstConversation.created_at), channel: firstConversation.channel_kind,
        orderId: null, ...empty };
    }
    return null;
  }
}
