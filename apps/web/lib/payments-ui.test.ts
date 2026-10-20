import { describe, expect, it } from 'vitest';
import { alertRefundMessageKey } from '../app/dashboard/[orgId]/payments/tone';
import { isSafeRedirect } from '../app/pay/[token]/_ui/redirect';
import { integrations } from './i18n/dict/integrations';
import { pay } from './i18n/dict/pay';
import { translate } from './i18n';

describe('payment and integration strings', () => {
  it('every integration setup string exists in English and Arabic', () => {
    expect(Object.keys(integrations.ar).sort()).toEqual(Object.keys(integrations.en).sort());
    for (const [k, v] of Object.entries(integrations.ar)) expect(v, k).not.toBe('');
  });

  it('every pay string exists in both languages, including guest error codes and alert actions', () => {
    expect(Object.keys(pay.ar).sort()).toEqual(Object.keys(pay.en).sort());
    // The API's guest-facing codes (checkout.service GUEST_FAILURE_CODES) and staff alert kinds all have text.
    for (const code of ['declined', 'expired', 'cancelled', 'provider_unavailable', 'under_review']) {
      expect(translate('ar', `pay.failure.${code}`)).not.toBe(`pay.failure.${code}`);
    }
    for (const kind of ['amount_mismatch', 'late_success', 'overpayment_conflict', 'refund_failed', 'unmatched_event', 'environment_mismatch', 'reference_mismatch',
      'duplicate_capture', 'auth_only', 'provider_refund', 'dispute', 'refund_uncertain', 'refund_stuck', 'webhook_retry_exhausted', 'deposit_not_due']) {
      expect(translate('ar', `pay.alert.${kind}`)).not.toBe(`pay.alert.${kind}`);
    }
  });

  it('localizes every field and activation step the payment adapters declare', () => {
    const fields = ['paymob.secretKey', 'paymob.publicKey', 'paymob.hmacSecret', 'paymob.apiKey', 'paymob.integrationIdCard', 'paymob.integrationIdWallet', 'paymob.baseUrl',
      'stripe.secretKey', 'stripe.webhookSecret', 'moyasar.secretKey', 'moyasar.webhookSecret'];
    for (const f of fields) expect(translate('ar', `intg.field.${f}`)).not.toBe(`intg.field.${f}`);
    for (const [p, n] of [['paymob', 6], ['stripe', 5], ['moyasar', 4]] as const) {
      for (let i = 1; i <= n; i++) expect(translate('ar', `intg.activation.${p}.${i}`)).not.toBe(`intg.activation.${p}.${i}`);
    }
    for (const s of ['not_configured', 'implementation_incomplete', 'pending_external_verification', 'official_test_verified', 'live_verified', 'blocked_by_provider']) {
      expect(translate('ar', `intg.readiness.${s}`)).not.toBe(`intg.readiness.${s}`);
    }
  });
});

describe('alert refund result (PAY-08, review F4)', () => {
  it('says "refunded" only for a confirmed refund and reports every other status as a failure, in both languages', () => {
    expect(alertRefundMessageKey('succeeded')).toEqual({ key: 'pay.alert.refundSent', tone: 'ok' });
    expect(alertRefundMessageKey('pending')).toEqual({ key: 'pay.alert.refundPending', tone: 'warn' });
    for (const s of ['failed', 'manual_required', undefined, null, 'weird']) expect(alertRefundMessageKey(s as any)).toEqual({ key: 'pay.alert.refundFailed', tone: 'danger' });
    for (const k of ['pay.alert.refundSent', 'pay.alert.refundPending', 'pay.alert.refundFailed', 'pay.alert.refundError.capture_already_refunded', 'pay.alert.refundError.refund_in_progress']) {
      expect(translate('ar', k)).not.toBe(k);
      expect(translate('en', k)).not.toBe(k);
    }
  });
});

describe('hosted checkout redirects (PAY-21)', () => {
  const here = 'https://app.resuto.test/pay/tok';
  it('follows only this app and the supported providers\' checkout pages', () => {
    expect(isSafeRedirect('https://checkout.stripe.com/c/pay/cs_test_1', here)).toBe(true);
    expect(isSafeRedirect('https://accept.paymob.com/unifiedcheckout/?publicKey=x', here)).toBe(true);
    expect(isSafeRedirect('https://ksa.paymob.com/unifiedcheckout/?publicKey=x', here)).toBe(true);
    expect(isSafeRedirect('https://checkout.moyasar.com/invoices/inv_1', here)).toBe(true);
    expect(isSafeRedirect('/pay/tok/sandbox?session=1', here)).toBe(true);
    expect(isSafeRedirect('https://evil.example/phish', here)).toBe(false);
    expect(isSafeRedirect('http://checkout.stripe.com/c/pay/x', here)).toBe(false);
    expect(isSafeRedirect('https://checkout.stripe.com.evil.example/', here)).toBe(false);
    expect(isSafeRedirect('javascript:alert(1)', here)).toBe(false);
  });
});
