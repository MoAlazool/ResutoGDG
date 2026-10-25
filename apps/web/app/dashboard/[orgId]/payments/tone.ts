import type { Tone } from '@resuto/ui';

/** Badge tone for payment, refund, link and reconciliation statuses. */
export const statusTone = (s: string): Tone =>
  s === 'succeeded' || s === 'paid' || s === 'matched' ? 'ok' : s === 'pending' || s === 'processing' || s === 'open' || s === 'manual_required' ? 'warn'
    : s === 'failed' || s === 'amount_mismatch' || s === 'status_mismatch' ? 'danger' : s.includes('refund') ? 'pay' : 'neutral';

/**
 * Message for the result of a one-click provider refund from an alert (PAY-08). Only a refund the provider confirmed
 * (succeeded) or accepted (pending) is reported as sent; anything else is a failure — never a fake success.
 */
export const alertRefundMessageKey = (status: string | null | undefined): { key: string; tone: 'ok' | 'warn' | 'danger' } =>
  status === 'succeeded' ? { key: 'pay.alert.refundSent', tone: 'ok' }
    : status === 'pending' ? { key: 'pay.alert.refundPending', tone: 'warn' }
      : { key: 'pay.alert.refundFailed', tone: 'danger' };

/**
 * Timeline tone of a refund (21-MONEY). An outcome the provider has not confirmed is a warning whatever its stored
 * status, so an unconfirmed refund never looks done; pending and manual refunds stay warnings until they complete.
 */
export const refundTone = (r: { status: string; outcomeUncertain?: boolean }): 'ok' | 'warn' | 'danger' | 'neutral' =>
  r.outcomeUncertain ? 'warn' : r.status === 'succeeded' ? 'ok' : r.status === 'failed' ? 'danger'
    : r.status === 'pending' || r.status === 'manual_required' ? 'warn' : 'neutral';
