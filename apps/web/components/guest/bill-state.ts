// What the table bill shows (VP-18). Only amounts the server has recorded count: an empty table — no orders, only
// cancelled ones, or nothing priced yet — has nothing to pay and is never shown as "fully paid".

export interface BillStateInput {
  orders: Array<{ status: string }>;
  totals: { totalMinor: number; dueMinor: number };
  pendingCheckout?: { url?: string | null } | null;
}

export type BillStage = 'empty' | 'pending' | 'due' | 'settled';

export function billStage(bill: BillStateInput): BillStage {
  const ordered = bill.orders.some((o) => o.status !== 'cancelled');
  if (!ordered || bill.totals.totalMinor <= 0) return 'empty';
  if (bill.totals.dueMinor <= 0) return 'settled';
  return bill.pendingCheckout?.url ? 'pending' : 'due';
}
