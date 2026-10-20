// Guest experience contracts (QR table, web ordering, booking): read-only table lookup, light visit polling, the
// "Help me choose" menu assistant and cart suggestions, and guest ratings. Additive to orders.ts/reservations.ts.
import { z } from 'zod';
import type { GuestVisitView } from './orders';
import { isoDate, optionalText, uuid } from './common';

// ---------------------------------------------------------------------------
// Table QR lookup (GET /v1/public/tables/:qrToken) — no session side effects
// ---------------------------------------------------------------------------
export interface PublicTableView {
  org: { name: string; nameAr: string | null; slug: string; currency: 'EGP' | 'SAR' };
  branch: { id: string; code: string; name: string; nameAr: string | null };
  table: { label: string };
  /** Whether scanning in can start or join a table session right now (the session call decides for sure). */
  accepting: boolean;
  /** Why not: branch_closed | staff_seating | out_of_service | cleaning. */
  reason: string | null;
}

// ---------------------------------------------------------------------------
// Visit polling (GET /v1/public/visits/current?v=<version>)
// ---------------------------------------------------------------------------
export type GuestVisitOrder = GuestVisitView['orders'][number] & {
  fulfillment: string;
  timeline: Array<{ status: string; at: string | null }>;
};
/** The table view with every order's status timeline, so tracking an order needs no second poll (PCL-18). */
export interface GuestVisitLive extends Omit<GuestVisitView, 'orders'> {
  orders: GuestVisitOrder[];
  /** Content hash; send it back as ?v= and an unchanged visit answers `{ unchanged: true }`. */
  version: string;
  /** Open visit: guests may rate once the bill is settled (see `rated`). */
  rated: boolean;
}
export type GuestVisitPoll = GuestVisitLive | { unchanged: true; version: string };
export const guestVisitPollQuery = z.object({ v: z.string().regex(/^[0-9a-f]{8,64}$/).optional() });

// ---------------------------------------------------------------------------
// "Help me choose" — a deterministic, server-validated recommendation over the live menu (no generative model)
// ---------------------------------------------------------------------------
/** Allergens a guest can ask to avoid (the menu's allergen vocabulary). */
export const ASSISTANT_ALLERGENS = ['milk', 'eggs', 'wheat', 'gluten', 'fish', 'shellfish', 'tree_nuts', 'peanuts', 'sesame', 'soy'] as const;
export const assistantRequest = z.object({
  /** Free text in English or Arabic ("for three under EGP 1,000, not spicy" / "إحنا ٣ وميزانيتنا ١٠٠٠"). */
  text: optionalText(500),
  /** Explicit preferences override what the text says. Budget in minor units for the whole party. */
  budgetMinor: z.number().int().min(100).max(10_000_000).optional().nullable(),
  party: z.number().int().min(1).max(20).optional().nullable(),
  vegetarian: z.boolean().optional(),
  mild: z.boolean().optional(),
  quick: z.boolean().optional(),
  exclude: z.array(z.enum(ASSISTANT_ALLERGENS)).max(ASSISTANT_ALLERGENS.length).optional(),
  /** Web ordering only: the branch code being ordered from. */
  branch: z.string().regex(/^[a-z0-9-]{1,40}$/).optional(),
});
export type AssistantRequest = z.infer<typeof assistantRequest>;

export type AssistantReason = 'main' | 'starter' | 'drink' | 'dessert' | 'popular' | 'vegetarian' | 'mild' | 'quick' | 'value';
export interface AssistantResult {
  /** Always 'rules': menu rules and this restaurant's order history, never a generative model. */
  mode: 'rules';
  /** What was understood (after reading the text), so the guest can see and correct it. */
  understood: { party: number; budgetMinor: number | null; vegetarian: boolean; mild: boolean; quick: boolean; exclude: string[] };
  /** priceMinor includes the cheapest choice of every required option group; `modifiers` are those choices. */
  items: Array<{ productId: string; name: string; nameAr: string | null; imageUrl: string | null; priceMinor: number; quantity: number;
    modifiers: Array<{ groupId: string; optionId: string }>; reasons: AssistantReason[] }>;
  estimatedTotalMinor: number;
  currency: string;
  /** over_budget: even the leanest meal costs more than the budget; no_match: nothing passes the filters. */
  outcome: 'fits' | 'over_budget' | 'no_match';
  /** Always present: allergens are as listed by the restaurant; confirm with staff. */
  allergenNotice: true;
}

export const suggestionsRequest = z.object({
  productIds: z.array(uuid).max(60),
  branch: z.string().regex(/^[a-z0-9-]{1,40}$/).optional(),
});
export interface SuggestionsResult {
  /** pairings: ordered together here before; rules: a drink or dessert to round off the order. */
  mode: 'pairings' | 'rules' | 'none';
  reason: 'together' | 'drink' | 'dessert' | null;
  items: Array<{ productId: string; name: string; nameAr: string | null; imageUrl: string | null; priceMinor: number }>;
}

// ---------------------------------------------------------------------------
// Guest ratings after payment (legacy /api/rating)
// ---------------------------------------------------------------------------
const score = z.number().int().min(1).max(5);
export const guestRatingInput = z.object({
  overall: score,
  food: score.optional().nullable(),
  service: score.optional().nullable(),
  speed: score.optional().nullable(),
  value: score.optional().nullable(),
  comment: optionalText(1000),
});
export type GuestRatingInput = z.infer<typeof guestRatingInput>;
export interface GuestRatingResult { ok: true; duplicate: boolean }

export const ratingsQuery = z.object({ from: isoDate.optional(), to: isoDate.optional(), branchId: uuid.optional() });
export interface RatingsSummary {
  from: string; to: string;
  count: number;
  averages: { overall: number | null; food: number | null; service: number | null; speed: number | null; value: number | null };
  /** Ratings per score 1..5 (index 0 = one star). */
  distribution: [number, number, number, number, number];
  bySource: Array<{ source: string; count: number; average: number | null }>;
  /** Latest comments; no guest identity is stored with a rating. */
  comments: Array<{ at: string; overall: number; comment: string; source: string }>;
}

// ---------------------------------------------------------------------------
// Booking slots in the branch time zone (GET /v1/public/reservations/:slug/slots)
// ---------------------------------------------------------------------------
export const reservationSlotsQuery = z.object({
  branch: z.string().regex(/^[a-z0-9-]{1,40}$/).optional(),
  date: isoDate.optional(),
  partySize: z.coerce.number().int().min(1).max(50).default(2),
  service: z.enum(['lunch', 'dinner']).optional(),
});
export interface ReservationSlotsView {
  branch: { id: string; code: string; name: string; nameAr: string | null };
  /** IANA zone the times are in (branch, else restaurant). */
  timeZone: string;
  /** Today in that zone. */
  today: string;
  date: string;
  service: 'lunch' | 'dinner';
  /** The first date (from today) that still has a sitting, so a guest never lands on an impossible day. */
  firstOpenDate: string;
  slots: Array<{ time: string; free: number; open: boolean }>;
  /** Earlier sittings today that have already passed (hidden, as in the legacy booking page). */
  passed: number;
  durationMin: number;
  depositMinor: number;
  currency: string;
}
