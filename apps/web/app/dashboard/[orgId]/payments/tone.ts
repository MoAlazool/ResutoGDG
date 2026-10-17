import type { Tone } from '@resuto/ui';

/** Badge tone for payment, refund, link and reconciliation statuses. */
export const statusTone = (s: string): Tone =>
  s === 'succeeded' || s === 'paid' || s === 'matched' ? 'ok' : s === 'pending' || s === 'processing' || s === 'open' || s === 'manual_required' ? 'warn'
    : s === 'failed' || s === 'amount_mismatch' || s === 'status_mismatch' ? 'danger' : s.includes('refund') ? 'pay' : 'neutral';
