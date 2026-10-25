// Inbox workspace and Customer 360 (21-INBOX, plan §6.5): internal notes, conversation tags, saved replies and the
// Customer 360 read model. Routes: apps/api/src/modules/connect/inbox.controller.ts and
// apps/api/src/modules/customers/customers.controller.ts (GET customers/:id/360).
import { z } from 'zod';
import { idempotencyKey, uuid } from './common';
import { fullListQuery } from './api';

export const inboxContractsVersion = 1 as const;

// ---------------------------------------------------------------------------
// Internal notes (messages.kind = 'note', direction 'internal'): staff-only, never sent to the customer
// ---------------------------------------------------------------------------
export const INTERNAL_NOTE_MAX = 4000;
export const internalNoteInput = z.object({
  body: z.string().trim().min(1).max(INTERNAL_NOTE_MAX),
  key: idempotencyKey,
}).strict();
export type InternalNoteInput = z.infer<typeof internalNoteInput>;

export interface InternalNote {
  id: string;
  conversationId: string;
  body: string;
  authorId: string | null;
  authorName: string | null;
  createdAt: string;
}

export const internalNoteListQuery = fullListQuery;

// ---------------------------------------------------------------------------
// Conversation tags
// ---------------------------------------------------------------------------
export const CONVERSATION_TAG_COLORS = ['neutral', 'red', 'amber', 'green', 'teal', 'blue', 'purple', 'pink'] as const;
export type ConversationTagColor = (typeof CONVERSATION_TAG_COLORS)[number];
/** Per restaurant, and per conversation. */
export const CONVERSATION_TAG_LIMITS = { perOrg: 100, perConversation: 10 } as const;

/** Letters (any script), digits, spaces and simple punctuation; no control characters or markup. */
const tagName = z.string().trim().min(1).max(40).regex(/^[\p{L}\p{N}\p{M} _\-./&+#]+$/u, 'letters, digits, spaces and - _ . / & + #');
export const conversationTagInput = z.object({
  name: tagName,
  color: z.enum(CONVERSATION_TAG_COLORS).default('neutral'),
}).strict();
export type ConversationTagInput = z.infer<typeof conversationTagInput>;
export const conversationTagUpdate = z.object({
  name: tagName.optional(),
  color: z.enum(CONVERSATION_TAG_COLORS).optional(),
}).strict().refine((v) => v.name !== undefined || v.color !== undefined, { message: 'nothing to update' });
export type ConversationTagUpdate = z.infer<typeof conversationTagUpdate>;

export interface ConversationTag {
  id: string;
  name: string;
  color: ConversationTagColor;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Saved replies (composer "/" trigger)
// ---------------------------------------------------------------------------
export const SAVED_REPLY_LIMIT_PER_ORG = 500;
const shortcut = z.string().trim().toLowerCase().regex(/^[a-z0-9][a-z0-9_-]{0,31}$/, 'lowercase letters, digits, _ and - (up to 32)');
const replyBody = z.string().trim().min(1).max(4096);

export const savedReplyInput = z.object({
  title: z.string().trim().min(1).max(80),
  shortcut: shortcut.nullable().optional(),
  bodyEn: replyBody.nullable().optional(),
  bodyAr: replyBody.nullable().optional(),
  /** null or absent: every branch. Branch-scoped staff may only create replies for their branches. */
  branchId: uuid.nullable().optional(),
}).strict().refine((v) => !!v.bodyEn || !!v.bodyAr, { message: 'Write the reply in English, Arabic or both', path: ['bodyEn'] });
export type SavedReplyInput = z.infer<typeof savedReplyInput>;

export const savedReplyUpdate = z.object({
  title: z.string().trim().min(1).max(80).optional(),
  shortcut: shortcut.nullable().optional(),
  bodyEn: replyBody.nullable().optional(),
  bodyAr: replyBody.nullable().optional(),
  branchId: uuid.nullable().optional(),
}).strict().refine((v) => Object.keys(v).length > 0, { message: 'nothing to update' });
export type SavedReplyUpdate = z.infer<typeof savedReplyUpdate>;

export const savedReplyListQuery = fullListQuery.extend({
  /** Title, shortcut or body contains this text. */
  q: z.string().trim().max(80).optional(),
  /** Exact shortcut (the "/" trigger), without the slash. */
  shortcut: shortcut.optional(),
  /** Organization-wide replies plus this branch's. */
  branchId: uuid.optional(),
});
export type SavedReplyListQuery = z.infer<typeof savedReplyListQuery>;

export interface SavedReply {
  id: string;
  title: string;
  shortcut: string | null;
  bodyEn: string | null;
  bodyAr: string | null;
  branchId: string | null;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Customer 360 (GET /v1/o/:orgId/customers/:id/360, customers:read)
// ---------------------------------------------------------------------------
/** Bounds of every list in the 360 (the payload never grows with the customer's history). */
export const CUSTOMER_360_LIMITS = {
  identities: 20, topItems: 5, consentHistory: 20, recentOrders: 10, reservations: 10, conversations: 10, conversationNotes: 10,
  cadenceOrders: 50,
} as const;

/**
 * Paths (dot notation, `[]` for every element) of fields whose text was written by the customer or arrived from a
 * channel the customer controls (a WhatsApp profile name, a message, an e-mail address). Clients render them as
 * plain text, never as markup or links, and never feed them to an AI prompt as instructions.
 */
export const CUSTOMER_360_UNTRUSTED_FIELDS = [
  'customer.displayName', 'customer.email', 'identities[].value', 'reservations[].guestName', 'conversations[].contactName',
  'conversations[].lastMessage.body', 'topItems[].name',
] as const;

/**
 * How the first touch was established. Only `tracked_link_click`, `attribution_event` and `order_attribution` are
 * recorded marketing attribution; `first_order_channel` and `first_conversation_channel` are inferred from where
 * the customer first appeared (inferred = true). null when nothing is recorded.
 */
export const ACQUISITION_BASES = ['tracked_link_click', 'attribution_event', 'order_attribution', 'first_order_channel', 'first_conversation_channel'] as const;
export type AcquisitionBasis = (typeof ACQUISITION_BASES)[number];

export type Customer360Section = 'included' | 'no_permission' | 'not_entitled';

export interface Customer360 {
  customer: {
    id: string; displayName: string | null; phone: string | null; email: string | null; locale: string; tags: string[];
    firstSeenAt: string | null; lastSeenAt: string | null; anonymisedAt: string | null; createdAt: string;
  };
  identities: Array<{ id: string; kind: string; value: string; verifiedAt: string | null }>;
  /**
   * From the customer_stats read model (all branches) or customer_branch_stats (branch-scoped staff: their branches
   * only). Counted orders are confirmed and not cancelled; spend is net of refunds.
   */
  stats: {
    source: 'customer_stats' | 'customer_branch_stats';
    orderCount: number; spendMinor: number; averageOrderMinor: number; currency: string;
    firstOrderAt: string | null; lastOrderAt: string | null;
    /** Visit cadence from the last counted orders (up to CUSTOMER_360_LIMITS.cadenceOrders): null below two orders. */
    cadence: { basis: 'counted_orders'; ordersLast30Days: number; ordersLast90Days: number; daysSinceLastOrder: number | null;
      medianDaysBetweenOrders: number | null; sampleSize: number };
  };
  topItems: Array<{ productId: string | null; name: string; nameAr: string | null; quantity: number; orderCount: number }>;
  /**
   * Marketing consent is recorded once per customer (customer_consent_events, purpose 'marketing'), not per channel:
   * `perChannel` is false and each channel entry repeats that decision (`scope: 'customer'`). The service window is the
   * channel's own 24-hour customer-service window (messaging channels only, from the latest conversation).
   */
  consent: {
    perChannel: false;
    marketing: { granted: boolean; source: string | null; at: string | null };
    channels: Array<{ channel: string; scope: 'customer'; granted: boolean; source: string | null; at: string | null;
      serviceWindow: { open: boolean; closesAt: string | null } | null;
      /**
       * 21-CRM: what contact the channel allows. Messaging the restaurant (a WhatsApp chat, a Messenger or Instagram
       * message) never grants marketing consent: without an explicit opt-in the contact is for service replies only.
       */
      contactBasis: 'marketing_consent' | 'service_replies_only' }>;
    history: Array<{ id: string; purpose: string; granted: boolean; source: string; actor: string | null; occurredAt: string }>;
  };
  acquisition: {
    firstTouch: null | {
      basis: AcquisitionBasis; inferred: boolean; occurredAt: string | null; channel: string | null;
      utm: { source: string | null; medium: string | null; campaign: string | null; content: string | null; term: string | null };
      campaignId: string | null; campaignName: string | null; orderId: string | null;
      /** 21-CRM: the tracked link of a tracked_link_click touch (null for clicks recorded before links were stored). */
      linkId: string | null;
      /** 21-CRM: true when read from the customer's stored first touch (customers.first_touch, set once). */
      stored: boolean;
    };
  };
  recentOrders: Array<{ id: string; number: string; branchId: string; channel: string; fulfillment: string; status: string;
    paymentStatus: string; totalMinor: number; placedAt: string }>;
  reservations: Array<{ id: string; code: string; branchId: string; startsAt: string; partySize: number; status: string; guestName: string | null }>;
  loyalty: null | { programActive: boolean; balance: number; lifetimeEarned: number };
  conversations: null | Array<{ id: string; channelId: string; channelKind: string; channelName: string; status: string; branchId: string | null;
    contactName: string | null; assignedTo: string | null; unreadCount: number; lastMessageAt: string | null;
    lastMessage: { body: string | null; direction: string; kind: string } | null; window: { open: boolean; closesAt: string | null };
    tags: ConversationTag[] }>;
  tags: { customer: string[]; conversation: ConversationTag[] };
  notes: { profile: string | null; conversation: InternalNote[] | null };
  /** Why a section is empty: the caller's role lacks the permission, or the plan lacks the module. */
  sections: { conversations: Customer360Section; loyalty: Customer360Section };
  untrustedFields: readonly string[];
  generatedAt: string;
}
