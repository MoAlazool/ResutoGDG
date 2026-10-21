// Which view /orders opens on (gallery PAR-04). Legacy "Orders" was the kanban board, so the board is the default for
// staff who can work it; the list stays one click away. The last choice is remembered per signed-in user (a
// `resuto:u:` key, cleared on sign-out or when another user signs in, lib/user-storage.ts) and an explicit ?view= in
// the URL (a shared link, a reload) always wins.

export type OrdersView = 'list' | 'board';
export const ORDERS_VIEW_KEY = 'resuto:u:orders.view';

const isView = (v: unknown): v is OrdersView => v === 'list' || v === 'board';

/** The view to show when the URL does not name one. */
export function defaultOrdersView(stored: string | null, canBoard: boolean): OrdersView {
  if (!canBoard) return 'list';
  return isView(stored) ? stored : 'board';
}

type KV = Pick<Storage, 'getItem' | 'setItem'>;
const storage = (): KV | null => { try { return typeof localStorage === 'undefined' ? null : localStorage; } catch { return null; } };

export function readOrdersView(s: KV | null = storage()): string | null {
  try { return s?.getItem(ORDERS_VIEW_KEY) ?? null; } catch { return null; }
}

export function rememberOrdersView(v: OrdersView, s: KV | null = storage()): void {
  try { s?.setItem(ORDERS_VIEW_KEY, v); } catch { /* storage blocked: the URL still carries the view */ }
}
