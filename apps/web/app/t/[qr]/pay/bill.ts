'use client';
import type { CheckoutMethodOption, SplitView } from '@resuto/contracts';
import { api } from '@/lib/api';
import { visitHeaders, type GuestVisit } from '@/lib/guest-visit';

export interface BillView {
  visitId: string;
  currency: string;
  org: { name: string; nameAr: string | null };
  table: { label: string };
  orders: Array<{ id: string; number: string; status: string; paymentStatus: string; totalMinor: number; dueMinor: number;
    lines: Array<{ id: string; name: string; nameAr: string | null; quantity: number; unitPriceMinor: number; lineTotalMinor: number }> }>;
  totals: { totalMinor: number; paidMinor: number; creditMinor: number; dueMinor: number };
  split: SplitView | null;
  pendingCheckout: { url: string | null; amountMinor: number; shareId: string | null } | null;
  receipts: Array<{ paymentId: string; amountMinor: number; method: string; share: boolean; at: string | null }>;
  methods: CheckoutMethodOption[];
}

export const loadBill = (v: GuestVisit) => api<BillView>('/public/payments/visit/bill', { headers: visitHeaders(v) });

/** Server default labels ("Guest 3") are shown localized; names typed by guests are shown as typed. */
export const shareLabel = (label: string, t: (k: string, v?: Record<string, string | number>) => string) => {
  const m = /^Guest (\d+)$/.exec(label);
  return m ? t('pay.split.share', { n: m[1]! }) : label;
};
