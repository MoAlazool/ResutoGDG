// Operations contracts restored from the original Resuto workspace (ws5): service model, guided setup checklist,
// the active-visits list, the 86 (sold out) request and the kitchen board lanes.
import { z } from 'zod';
import { isoDateTime, optionalText, uuid } from './common';

// ---------------------------------------------------------------------------
// Service model (legacy settings "Service model" cards; FT-07 counter / single venue QR)
// ---------------------------------------------------------------------------
/**
 * How a branch serves guests:
 * - tables: floor plan with a QR code per table; reservations optional.
 * - counter: one QR code for the whole venue (takeaway, cloud kitchen); each scan starts that guest's own pickup
 *   order. No floor plan, no reservations.
 * - online: no on-site ordering; pickup and delivery through the website only.
 */
export const SERVICE_MODES = ['tables', 'counter', 'online'] as const;
export type ServiceMode = (typeof SERVICE_MODES)[number];
export const serviceModeRequest = z.object({
  mode: z.enum(SERVICE_MODES),
  /** Table service only: accept table reservations. */
  acceptsReservations: z.boolean().optional(),
});
export type ServiceModeRequest = z.infer<typeof serviceModeRequest>;

/**
 * The single venue QR of a branch. Counter branches (FT-07): `/v/<token>`, where each guest orders on their own (the
 * counter visit opens with their first order); the token is the branch's venue credential (stored hashed, rotatable). Other branches: the public
 * ordering page, which carries no secret.
 */
export interface VenueQr {
  branchId: string; url: string; svg: string;
  kind: 'counter' | 'order';
  /** When the counter code was last issued or rotated (null for the ordering page). */
  rotatedAt: string | null;
}

// ---------------------------------------------------------------------------
// Guided setup (legacy /manager/setup, 8 steps). Completion is derived from data on the server, never self-asserted.
// ---------------------------------------------------------------------------
export const SETUP_STEPS = ['welcome', 'profile', 'branch', 'mode', 'menu', 'floor', 'payments', 'launch'] as const;
export type SetupStep = (typeof SETUP_STEPS)[number];
export interface SetupCheck {
  step: SetupStep;
  done: boolean;
  /** Required before launch (welcome and launch itself are not). */
  required: boolean;
  /** Short machine-readable evidence, e.g. { products: 12 } or { missing: ['legalName'] }. */
  detail: Record<string, unknown>;
}
export interface SetupChecklist {
  orgId: string;
  status: string;
  launched: boolean;
  launchedAt: string | null;
  /** Every required step is done (the launch button is enabled). */
  ready: boolean;
  serviceMode: ServiceMode;
  branchId: string | null;
  steps: SetupCheck[];
}

// ---------------------------------------------------------------------------
// Active visits (legacy "Active visits" tab)
// ---------------------------------------------------------------------------
export const visitListQuery = z.object({ branchId: uuid.optional(), status: z.enum(['open']).default('open') });
export interface VisitSummary {
  id: string; branchId: string; tableId: string | null; tableLabel: string | null; partySize: number | null;
  /** `counter`: a venue-QR counter visit (FT-07, no table); `ticket` is the number the guest quotes at the till. */
  kind: 'table' | 'counter';
  ticket: string | null;
  openedAt: string; openedVia: string; reservationId: string | null; guestName: string | null;
  orderCount: number; openOrders: number; totalMinor: number; paidMinor: number; creditMinor: number; dueMinor: number;
  /** A payment is in flight or a split is open: guests cannot add orders ("Billing locked"). */
  billingLocked: boolean;
  requests: string[];
  currency: string;
}

// ---------------------------------------------------------------------------
// Temporarily sold out (86). FT-02 / DF-01
// ---------------------------------------------------------------------------
/**
 * Display policy for unavailable dishes on guest menus (QR, website ordering, WhatsApp): a dish that is sold out (86)
 * or out of tracked stock is listed with `available: false` and shown as "Sold out"; it is never hidden. Only a dish
 * that the branch does not offer at all is left out of that branch's menu. Ordering refuses both.
 */
export const SOLD_OUT_DISPLAY = 'list_as_sold_out' as const;

/** POST /o/:orgId/menu/products/:id/availability. `until` restores the dish automatically ('end_of_day' = the branch's next local midnight). */
export const soldOutRequest = z.object({
  branchId: uuid,
  available: z.boolean(),
  until: z.union([z.literal('end_of_day'), isoDateTime]).nullable().optional(),
  reason: optionalText(200),
});
export type SoldOutRequest = z.infer<typeof soldOutRequest>;

// ---------------------------------------------------------------------------
// Kitchen board lanes (legacy KDS: New orders, Preparing, Ready to serve, On the way, Completed)
// ---------------------------------------------------------------------------
export const KITCHEN_LANES = ['new', 'preparing', 'ready', 'out', 'done'] as const;
export type KitchenLane = (typeof KITCHEN_LANES)[number];

/** Lane of a ticket on the board (shared by the KDS and the orders board so both agree). */
export function kitchenLaneOf(t: { status: string; fulfillment: string; handedOff?: boolean; lines?: Array<{ kitchenStatus: string }> }): KitchenLane {
  if (t.status === 'served' || t.status === 'picked_up' || t.status === 'delivered') return 'done';
  if (t.status === 'ready' && t.fulfillment === 'delivery' && t.handedOff) return 'out';
  if (t.status === 'ready') return (t.lines ?? []).some((l) => l.kitchenStatus === 'queued' || l.kitchenStatus === 'preparing') ? 'preparing' : 'ready';
  if (t.status === 'preparing') return 'preparing';
  return 'new';
}

/**
 * The bumps that move a ticket forward to `lane`, in order (legacy pathTo: forward-only, multi-step allowed).
 * null when the lane is not ahead of the ticket. Each bump is a server transition validated by the order state
 * machine (with the ticket's version), so a client cannot skip or reverse a status.
 */
export function kitchenPathTo(t: { status: string; fulfillment: string; handedOff?: boolean; lines?: Array<{ kitchenStatus: string }> }, lane: KitchenLane): string[] | null {
  const order: KitchenLane[] = ['new', 'preparing', 'ready', 'out', 'done'];
  const from = kitchenLaneOf(t);
  if (order.indexOf(lane) <= order.indexOf(from)) return null;
  if (lane === 'out' && t.fulfillment !== 'delivery') return null;
  const steps: string[] = [];
  let at = from;
  while (at !== lane) {
    if (at === 'new') { steps.push('preparing'); at = 'preparing'; continue; }
    if (at === 'preparing') { steps.push('ready'); at = 'ready'; continue; }
    if (at === 'ready') {
      if (t.fulfillment === 'delivery') { steps.push('delivered'); at = 'out'; continue; } // hand-off: stays ready, "On the way"
      steps.push(t.fulfillment === 'pickup' ? 'picked_up' : 'served'); at = 'done'; continue;
    }
    if (at === 'out') { steps.push('delivered'); at = 'done'; continue; } // confirmation once the bag reached the guest
    return null;
  }
  return steps;
}
