// Staff notification centre (FT-06).
import { z } from 'zod';

export const NOTIFICATION_KINDS = ['licence_expiring', 'stock_low', 'mcp_approval_requested', 'member_invited', 'payment_alert', 'payment_failed'] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

export const notificationsQuery = z.object({
  unread: z.enum(['true', 'false']).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
  cursor: z.string().max(64).optional(),
});

export interface NotificationDelivery {
  channel: 'email' | 'whatsapp';
  status: 'not_configured' | 'sent' | 'failed' | 'skipped';
  recipientHint: string | null;
  attemptedAt: string;
}

export interface StaffNotification {
  id: string;
  kind: NotificationKind;
  severity: 'info' | 'warning' | 'critical';
  /** Rendered by the UI from its dictionary: notifications.<templateKey>.title / .body with `params`. */
  templateKey: string;
  params: Record<string, unknown>;
  branchId: string | null;
  /** Dashboard path relative to /dashboard/<orgId>, e.g. "/inventory". */
  link: string | null;
  createdAt: string;
  readAt: string | null;
  deliveries: NotificationDelivery[];
}

export interface NotificationsPage { items: StaffNotification[]; nextCursor: string | null; unread: number }
