// Order, delivery, reservation and payment lifecycles. Order, payment and
// delivery states are independent; these tables define legal transitions.

export const ORDER_STATUSES = ['awaiting_payment', 'placed', 'accepted', 'preparing', 'ready', 'served', 'picked_up', 'delivered', 'cancelled'] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];
export type Fulfillment = 'dine_in' | 'pickup' | 'delivery';

const ORDER_TRANSITIONS: Record<OrderStatus, readonly OrderStatus[]> = {
  awaiting_payment: ['placed', 'cancelled'],
  placed: ['accepted', 'preparing', 'cancelled'],
  accepted: ['preparing', 'cancelled'],
  preparing: ['ready', 'cancelled'],
  ready: ['served', 'picked_up', 'delivered', 'cancelled'],
  served: [],
  picked_up: [],
  delivered: [],
  cancelled: [],
};

/** The terminal "fulfilled" status for each fulfillment type. */
export const FULFILLED_STATUS: Record<Fulfillment, OrderStatus> = {
  dine_in: 'served',
  pickup: 'picked_up',
  delivery: 'delivered',
};

export function canTransitionOrder(from: OrderStatus, to: OrderStatus, fulfillment: Fulfillment): boolean {
  if (!ORDER_TRANSITIONS[from].includes(to)) return false;
  if (from === 'ready' && to !== 'cancelled') return FULFILLED_STATUS[fulfillment] === to;
  return true;
}

export const isOrderFinal = (s: OrderStatus) => ORDER_TRANSITIONS[s].length === 0;

export const DELIVERY_STATUSES = ['unassigned', 'offered', 'assigned', 'accepted', 'picked_up', 'en_route', 'delivered', 'failed', 'cancelled'] as const;
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];
const DELIVERY_TRANSITIONS: Record<DeliveryStatus, readonly DeliveryStatus[]> = {
  unassigned: ['offered', 'assigned', 'cancelled'],
  offered: ['accepted', 'unassigned', 'cancelled'],
  assigned: ['accepted', 'unassigned', 'cancelled'],
  accepted: ['picked_up', 'unassigned', 'cancelled'],
  picked_up: ['en_route', 'delivered', 'failed'],
  en_route: ['delivered', 'failed'],
  failed: ['unassigned', 'cancelled'],
  delivered: [],
  cancelled: [],
};
export const canTransitionDelivery = (from: DeliveryStatus, to: DeliveryStatus) => DELIVERY_TRANSITIONS[from].includes(to);

export const RESERVATION_STATUSES = ['held', 'pending_deposit', 'confirmed', 'seated', 'completed', 'cancelled', 'no_show', 'expired'] as const;
export type ReservationStatus = (typeof RESERVATION_STATUSES)[number];
const RESERVATION_TRANSITIONS: Record<ReservationStatus, readonly ReservationStatus[]> = {
  held: ['pending_deposit', 'confirmed', 'expired', 'cancelled'],
  pending_deposit: ['confirmed', 'expired', 'cancelled'],
  confirmed: ['seated', 'cancelled', 'no_show'],
  seated: ['completed'],
  completed: [],
  cancelled: [],
  no_show: [],
  expired: [],
};
export const canTransitionReservation = (from: ReservationStatus, to: ReservationStatus) => RESERVATION_TRANSITIONS[from].includes(to);

export const PAYMENT_STATUSES = ['unpaid', 'pending', 'partially_paid', 'paid', 'partially_refunded', 'refunded'] as const;
export type OrderPaymentStatus = (typeof PAYMENT_STATUSES)[number];

/** Derives an order's payment status from settled amounts (never from client input). */
export function derivePaymentStatus(totalMinor: number, paidMinor: number, refundedMinor: number, pending = false): OrderPaymentStatus {
  if (refundedMinor > 0 && refundedMinor >= paidMinor && paidMinor > 0) return 'refunded';
  if (refundedMinor > 0) return 'partially_refunded';
  if (paidMinor >= totalMinor && totalMinor > 0) return 'paid';
  if (paidMinor > 0) return 'partially_paid';
  return pending ? 'pending' : 'unpaid';
}

/** Legacy (ResutoGDG 1.x) order status → 2.0 status, used by the migration tool. */
export const LEGACY_ORDER_STATUS: Record<string, OrderStatus> = {
  received: 'placed',
  pending: 'placed',
  accepted: 'accepted',
  preparing: 'preparing',
  ready: 'ready',
  served: 'served',
  picked_up: 'picked_up',
  delivered: 'delivered',
  cancelled: 'cancelled',
};
