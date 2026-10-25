// Shapes the Inbox reads from the Connect API (apps/api/src/modules/connect/conversations.service.ts).
import type { ConversationTag, InternalNote, SavedReply } from '@resuto/contracts';

export type { ConversationTag, InternalNote, SavedReply };

export interface ServiceWindow { open: boolean; closesAt: string | null }

export interface ConvItem {
  id: string; channelId: string; channelName: string; channelKind?: string; sandbox: boolean; customerId: string | null;
  contact: string | null; name: string | null; status: string; assignedTo: string | null; unreadCount: number;
  lastMessageAt: string | null; lastMessage: { body: string | null; direction: string; kind?: string } | null; window: ServiceWindow;
  handoffOpen: boolean; locale?: string; tags: ConversationTag[];
  /** 21-INBOX increment 2. */
  branchId?: string | null; orderingStep?: string | null; lead?: boolean;
}

export interface Message {
  id: string; direction: 'inbound' | 'outbound'; kind: string; body: string | null; status: string; error: string | null; automated: boolean;
  sandbox: boolean; interactive: any; createdAt: string;
}

export interface OrderingSummary {
  id?: string; step: string; fulfillment: string | null; totalMinor: number | null; currency: string | null; orderId?: string | null;
  orderNumber: string | null; paymentMethod: string | null;
}

export interface Detail {
  id: string; status: string; channel: { id: string; name: string; sandbox: boolean; kind?: string; transport?: string };
  humanReplyUntil?: string | null; contact: string | null; contactName: string | null; locale: string;
  customer: { id: string; name: string | null; phone?: string | null; marketingConsent: boolean } | null; window: ServiceWindow; botActive: boolean;
  handoff: { id: string; reason: string; status: string } | null; assignedTo?: string | null; unreadCount?: number;
  orderingSession: OrderingSummary | null;
  messages: Message[];
  notes?: InternalNote[];
  tags?: ConversationTag[];
}

export interface Template { id: string; name: string; language: string; category: string; body: string; variables: string[]; providerStatus: string; sandbox: boolean }
export interface Channel {
  id: string; kind: string; transport: string; sandbox: boolean; displayName: string; status: string; orderingEnabled: boolean; phoneNumberId: string | null;
  verified: boolean | null; webhookSubscribed: boolean | null; branchId?: string | null;
}
export interface Assignee { userId: string; name: string; role: string }

/** Messenger / Instagram contacts have no phone number (their ids are page-scoped), so they are labelled by network. */
export const guestKey = (kind?: string) => (kind === 'messenger' || kind === 'instagram' ? `connect.inbox.guest.${kind}` : 'connect.inbox.guest.other');

export const statusTone = (s: string) => (s === 'handoff' ? 'warn' : s === 'closed' ? 'neutral' : s === 'bot' ? 'info' : 'ok') as 'warn' | 'neutral' | 'info' | 'ok';

/** The provider logo of a channel kind (a sandbox channel imitates WhatsApp). */
export const providerOf = (kind?: string) => (kind === 'messenger' ? 'messenger' : kind === 'instagram' ? 'instagram' : 'whatsapp') as 'messenger' | 'instagram' | 'whatsapp';
