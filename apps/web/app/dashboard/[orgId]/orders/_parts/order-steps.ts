// Order status steps staff can take from the order sheet and the list's bulk move (pure, unit tested). The API's
// order state machine validates every transition again with the order's version.

export const ORDER_STATUSES = ['awaiting_payment', 'placed', 'accepted', 'preparing', 'ready', 'served', 'picked_up', 'delivered', 'cancelled'] as const;

/** Next statuses per fulfilment and current status; the first one is the main step. */
export const NEXT: Readonly<Record<string, Readonly<Record<string, readonly string[]>>>> = {
  dine_in: { placed: ['accepted', 'preparing'], accepted: ['preparing'], preparing: ['ready'], ready: ['served'] },
  pickup: { placed: ['accepted', 'preparing'], accepted: ['preparing'], preparing: ['ready'], ready: ['picked_up'] },
  delivery: { placed: ['accepted', 'preparing'], accepted: ['preparing'], preparing: ['ready'], ready: ['delivered'] },
};

export const nextSteps = (o: { fulfillment: string; status: string }): readonly string[] => NEXT[o.fulfillment]?.[o.status] ?? [];
export const mainStep = (o: { fulfillment: string; status: string }): string | null => nextSteps(o)[0] ?? null;

/** Statuses an order can still be cancelled from. */
export const cancellable = (status: string) => !['cancelled', 'served', 'picked_up', 'delivered'].includes(status);

/** The list's "active" filter: every status still being worked. */
export const ACTIVE_STATUSES = 'awaiting_payment,placed,accepted,preparing,ready';

/** Query of GET /orders for the list's filters (status 'active' = ACTIVE_STATUSES, '' = all). */
export function listQuery(f: { branchId?: string; status: string; channel: string; fulfillment: string; date: string; cursor?: string | null }): string {
  const q = new URLSearchParams({ limit: '50' });
  if (f.branchId) q.set('branchId', f.branchId);
  if (f.status === 'active') q.set('status', ACTIVE_STATUSES);
  else if (f.status) q.set('status', f.status);
  if (f.channel) q.set('channel', f.channel);
  if (f.fulfillment) q.set('fulfillment', f.fulfillment);
  if (f.date) q.set('date', f.date);
  if (f.cursor) q.set('cursor', f.cursor);
  return q.toString();
}
