// Native POS device API (21-POSAPI): device pairing and auth, delta sync, the per-branch event feed, idempotent order
// and payment submission, kitchen routing and print jobs. The iPad app (feature/ipad-pos) consumes these contracts;
// docs/api/IPAD_COMPATIBILITY.md lists every route and event with its status. Additive changes only on /v1.
import { z } from 'zod';
import { listQuery } from './api';
import { isoDateTime, optionalText, phoneE164, uuid } from './common';
import { COLLECT_METHODS, FULFILLMENTS, cartLine, kitchenBumpRequest, kitchenLineRequest, orderTransitionRequest } from './orders';

/** Version of the POS contract described in docs/api/IPAD_COMPATIBILITY.md (bumped on every additive change). */
export const POS_CONTRACT_VERSION = '0.1.0' as const;

/** Device credentials are `rpos_<43 url-safe chars>` (256 bits); only their sha256 is stored. */
export const POS_DEVICE_TOKEN_PREFIX = 'rpos_' as const;

/** Roles a device can act as. A device never acts as a manager, owner or any role that manages the restaurant. */
export const POS_ACTING_ROLES = ['waiter', 'cashier', 'kitchen'] as const;
export type PosActingRole = (typeof POS_ACTING_ROLES)[number];

/** Pairing codes: 10 characters of Crockford base32 (no I, L, O, U), shown as XXXXX-XXXXX. */
export const POS_PAIRING_CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ' as const;
export const POS_PAIRING_CODE_LENGTH = 10;

/** Event kinds of the per-branch feed (GET /v1/pos/events). New kinds may be added; clients ignore unknown ones. */
export const POS_EVENT_KINDS = [
  'order.created', 'order.updated', 'ticket.status_changed',
  'payment.captured', 'payment.refunded',
  'menu.changed', 'availability.changed',
  'table.changed',
  'print_job.created',
] as const;
export type PosEventKind = (typeof POS_EVENT_KINDS)[number];

/** Events per feed page. */
export const POS_EVENTS_PAGE = 200;
/** Longest long-poll wait (seconds). */
export const POS_EVENTS_MAX_WAIT_SECONDS = 25;
/** Events are kept this long; an older cursor answers 409 resync_required. */
export const POS_EVENTS_RETENTION_DAYS = 7;

export const PRINT_JOB_KINDS = ['kitchen_ticket', 'receipt'] as const;
export const PRINT_JOB_STATUSES = ['pending', 'claimed', 'printed', 'failed'] as const;
/** A claim not completed within this long may be claimed by another device. */
export const PRINT_JOB_CLAIM_SECONDS = 60;

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------
/** Staff (devices:manage): a one-time pairing code for a device of one branch. */
export const createPosPairingRequest = z.object({
  branchId: uuid,
  actingRole: z.enum(POS_ACTING_ROLES),
  /** Label shown in the device list ("Bar iPad"). */
  name: z.string().trim().min(1).max(60),
  /** How long the code can be used (minutes). */
  expiresInMinutes: z.number().int().min(1).max(60).default(10),
  /** The paired device's credential expires after this many days. */
  deviceTtlDays: z.number().int().min(1).max(730).default(365),
});
export type CreatePosPairingRequest = z.infer<typeof createPosPairingRequest>;

/** Device (public): exchanges a pairing code for its credential. The code is case-insensitive; dashes and spaces are ignored. */
export const posPairRequest = z.object({
  code: z.string().trim().min(10).max(20),
  platform: z.enum(['ipados', 'ios', 'other']).default('ipados'),
  appVersion: optionalText(40),
  model: optionalText(60),
});
export type PosPairRequest = z.infer<typeof posPairRequest>;

export const posDeviceListQuery = listQuery.extend({
  status: z.enum(['active', 'revoked']).optional(),
  branchId: uuid.optional(),
});
export const posRevokeRequest = z.object({ reason: optionalText(200) });

/** Feed read: events after `after` (exclusive). `epoch` (from a previous page) detects a reset feed. */
export const posEventsQuery = z.object({
  after: z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0),
  epoch: uuid.optional(),
  /** Long-poll: wait up to this many seconds for the first event when there is none. 0 = answer at once. */
  wait: z.coerce.number().int().min(0).max(POS_EVENTS_MAX_WAIT_SECONDS).default(0),
});
export type PosEventsQuery = z.infer<typeof posEventsQuery>;

/** Snapshot sync (menu, floor): `since` is the cursor of the copy the device holds. */
export const posSnapshotQuery = z.object({ since: z.string().min(1).max(200).optional() });
/** Order sync: no cursor = every open order; a cursor = the orders changed since. */
export const posOrdersSyncQuery = z.object({ cursor: z.string().min(1).max(200).optional() });

export const posOrderLine = cartLine.extend({
  /** What the device showed for this line: (unit price + modifier deltas) × quantity. A different server value is a conflict. */
  expectedLineTotalMinor: z.number().int().min(0).max(1e13).optional(),
});

/**
 * Order submission. `clientOrderId` is generated on the device when the order is first taken and never changes
 * (an offline queue replays it as is): a second submit with the same id returns the original response.
 */
export const posOrderSubmit = z.object({
  clientOrderId: uuid,
  fulfillment: z.enum(FULFILLMENTS),
  tableId: uuid.optional().nullable(),
  visitId: uuid.optional().nullable(),
  /** Party size when the order opens the table's visit. */
  guests: z.number().int().min(1).max(100).optional(),
  lines: z.array(posOrderLine).min(1).max(60),
  /** The order total the device showed. */
  expectedTotalMinor: z.number().int().min(0).max(1e13).optional(),
  /**
   * Prices are server-authoritative. `reject` (default): a stale price is a 409 pos_price_changed carrying the current
   * values and nothing is created. `accept`: the order is placed at current prices and the answer lists what changed.
   */
  repricing: z.enum(['reject', 'accept']).default('reject'),
  customer: z.object({ name: optionalText(100), phone: phoneE164.optional().nullable() }).optional().nullable(),
  notes: optionalText(500),
  /** When the order was taken on the device (offline queues): informational, stored in the order's attribution. */
  takenAt: isoDateTime.optional(),
});
export type PosOrderSubmit = z.infer<typeof posOrderSubmit>;

/** Server pricing of a cart without placing it (what the device shows before submitting). */
export const posQuoteRequest = z.object({
  fulfillment: z.enum(FULFILLMENTS),
  lines: z.array(cartLine).min(1).max(60),
});
export type PosQuoteRequest = z.infer<typeof posQuoteRequest>;

/** Status changes from a device always carry the version the device saw (optimistic concurrency). */
export const posTransitionRequest = orderTransitionRequest.extend({ version: z.number().int().min(0) });
export const posKitchenBumpRequest = kitchenBumpRequest.extend({ version: z.number().int().min(0) });
export const posKitchenLineRequest = kitchenLineRequest;
export const posKitchenQuery = z.object({ station: z.string().trim().min(1).max(40).optional(), since: z.string().max(24).optional() });

/** Payment recorded on the device (cash, card terminal, InstaPay). `clientPaymentId` makes a retry return the first result. */
export const posPaymentRequest = z.object({
  clientPaymentId: uuid,
  method: z.enum(COLLECT_METHODS).default('cash'),
  /** Defaults to everything still due. */
  amountMinor: z.number().int().positive().max(1e13).optional(),
  reference: optionalText(120),
});
export type PosPaymentRequest = z.infer<typeof posPaymentRequest>;

/** A receipt print job for an order; `clientRequestId` makes a retry return the same job. */
export const posReceiptRequest = z.object({ clientRequestId: uuid });

export const posPrintJobsQuery = listQuery.extend({
  status: z.enum(PRINT_JOB_STATUSES).optional(),
  kind: z.enum(PRINT_JOB_KINDS).optional(),
  station: z.string().trim().min(1).max(40).optional(),
});
export const posPrintJobComplete = z.object({ status: z.enum(['printed', 'failed']), error: optionalText(300) });

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------
export interface PosDeviceSummary {
  id: string; branchId: string; name: string; actingRole: PosActingRole; tokenPrefix: string; status: 'active' | 'revoked';
  expired: boolean; platform: string | null; appVersion: string | null; model: string | null;
  pairedAt: string; expiresAt: string | null; lastSeenAt: string | null; revokedAt: string | null; revokeReason: string | null;
}
export interface PosPairingCreated {
  id: string; branchId: string; actingRole: PosActingRole; name: string;
  /** Shown once: the device types or scans it. */
  code: string; expiresAt: string;
}
export interface PosDevicePaired {
  /** Shown once: the device stores it in the keychain and sends it as `Authorization: Bearer rpos_...`. */
  token: string;
  device: PosDeviceSummary;
  orgId: string;
  contractVersion: string;
}
export interface PosFeedPosition { epoch: string; head: number; oldest: number }
export interface PosSession {
  device: PosDeviceSummary;
  org: { id: string; name: string; nameAr: string | null; currency: string; country: string; timezone: string };
  branch: { id: string; code: string; name: string; nameAr: string | null; timezone: string; serviceMode: string;
    acceptsDineIn: boolean; acceptsPickup: boolean; acceptsDelivery: boolean };
  permissions: string[];
  feed: PosFeedPosition;
  serverTime: string;
  contractVersion: string;
}

export interface PosEvent {
  /** Monotonic per branch, without gaps: dedupe and resume by it. */
  seq: number;
  kind: PosEventKind;
  entityType: 'order' | 'payment' | 'menu' | 'product' | 'table' | 'print_job';
  entityId: string;
  payload: Record<string, unknown>;
  at: string;
}
export interface PosEventPage {
  epoch: string;
  /** Last sequence number written for the branch. */
  head: number;
  events: PosEvent[];
  /** Send as `after` next time (the last seq returned, or `after` when nothing was new). */
  nextAfter: number;
  hasMore: boolean;
  serverTime: string;
}
/** details of 409 resync_required: drop local state, run every sync with no cursor, then follow the feed from `head`. */
export interface PosResyncDetails {
  reason: 'cursor_expired' | 'cursor_ahead' | 'epoch_mismatch' | 'gap';
  epoch: string; head: number; oldest: number;
}

export interface PosMenuProduct {
  id: string; categoryId: string; name: string; nameAr: string | null; description: string | null; descriptionAr: string | null;
  /** Current price at this branch (branch override applied). */
  priceMinor: number;
  available: boolean; unavailableReason: 'sold_out' | 'out_of_stock' | null;
  /** Tracked unit stock left at the branch; null = not tracked. */
  stockQty: number | null;
  station: string; prepMinutes: number | null; spiceLevel: number; allergens: string[]; dietary: string[];
  imageUrl: string | null;
  modifierGroups: Array<{ id: string; name: string; nameAr: string | null; minSelect: number; maxSelect: number;
    options: Array<{ id: string; name: string; nameAr: string | null; priceDeltaMinor: number; available: boolean }> }>;
}
export interface PosMenuSync {
  cursor: string;
  unchanged: boolean;
  currency?: string;
  categories?: Array<{ id: string; name: string; nameAr: string | null; products: PosMenuProduct[] }>;
  stations?: string[];
}
export interface PosFloorSync {
  cursor: string;
  unchanged: boolean;
  layout?: { revision: number; width: number; height: number; zones: unknown[]; objects: unknown[] };
  tables?: unknown[];
}

export interface PosOrderLine {
  id: string; productId: string | null; name: string; nameAr: string | null; quantity: number; unitPriceMinor: number;
  modifiers: unknown[]; modifiersTotalMinor: number; lineTotalMinor: number; station: string; kitchenStatus: string; notes: string | null;
}
export interface PosOrder {
  id: string; clientOrderId: string | null; number: string; branchId: string; channel: string; fulfillment: string; status: string;
  paymentStatus: string; tableId: string | null; tableLabel: string | null; visitId: string | null; customerName: string | null;
  currency: string; subtotalMinor: number; discountMinor: number; serviceChargeMinor: number; deliveryFeeMinor: number; taxMinor: number;
  taxInclusive: boolean; totalMinor: number; paidMinor: number; refundedMinor: number; dueMinor: number; notes: string | null;
  placedAt: string; updatedAt: string; version: number;
  /** False once the order is finished (fulfilled and settled, or cancelled): drop it from the open list. */
  open: boolean;
  lines: PosOrderLine[];
}
export interface PosOrdersSync {
  cursor: string;
  mode: 'full' | 'delta';
  orders: PosOrder[];
  hasMore: boolean;
  /** Full mode only: more open orders exist than one answer carries (300). */
  truncated?: boolean;
}
export interface PosRepricedLine {
  index: number; productId: string; expectedLineTotalMinor: number | null; currentLineTotalMinor: number;
  currentUnitPriceMinor: number; currentModifiersTotalMinor: number;
}
/** details of 409 pos_price_changed. */
export interface PosPriceConflictDetails {
  currency: string; lines: PosRepricedLine[]; expectedTotalMinor: number | null; currentTotalMinor: number; menuCursor: string;
}
/** details of 409 pos_items_unavailable. */
export interface PosUnavailableDetails {
  items: Array<{ index: number; productId: string; reason: 'not_on_menu' | 'not_offered' | 'sold_out' | 'out_of_stock'; availableQty: number | null }>;
  menuCursor: string;
}
export interface PosQuote {
  currency: string;
  lines: Array<{ index: number; productId: string; unitPriceMinor: number; modifiersTotalMinor: number; lineTotalMinor: number }>;
  subtotalMinor: number; discountMinor: number; serviceChargeMinor: number; deliveryFeeMinor: number; taxMinor: number; taxInclusive: boolean;
  totalMinor: number;
  menuCursor: string;
}
export interface PosOrderSubmitted {
  clientOrderId: string;
  order: PosOrder;
  /** Set when the order was placed at prices different from what the device showed (repricing: accept). */
  repriced: { lines: PosRepricedLine[]; expectedTotalMinor: number | null; totalMinor: number } | null;
}

export interface PosPrintJob {
  id: string; kind: (typeof PRINT_JOB_KINDS)[number]; status: (typeof PRINT_JOB_STATUSES)[number]; orderId: string; station: string | null;
  claimedBy: string | null; claimedAt: string | null; attempts: number; completedAt: string | null; error: string | null; createdAt: string;
  /** Structured content (no printer bytes): the device lays it out for its printer (ESC/POS, ePOS, StarPRNT). */
  document?: Record<string, unknown>;
}
