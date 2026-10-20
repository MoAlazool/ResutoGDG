// Shared helpers for the payment provider acceptance checks (INT-15). These run only against a provider's OFFICIAL
// TEST environment with the owner's own test credentials (scripts/providers/acceptance.mjs); unit tests never call them.
import { readFileSync } from 'node:fs';
import type { AdapterContext } from '../core';
import type { CheckoutRequest, PaymentAdapter } from '../payments/types';
import { expectThat, type AcceptanceCheck, type AcceptanceContext } from './index';

/** Adapter context for a payment adapter, with credential keys mapped from the check's environment variables. */
export function paymentContext(ctx: AcceptanceContext, credentials: Record<string, string>, config: Record<string, unknown> = {}): AdapterContext {
  return { environment: ctx.mode === 'live' ? 'live' : 'sandbox', credentials, config, fetch: ctx.adapter.fetch };
}

/** Reads a captured provider payload named by an env var (a file path), exactly as received (raw bytes matter for signatures). */
export const readCaptured = (path: string) => readFileSync(path, 'utf8');

/** A unique, stable-per-run key for test-mode writes (refund idempotency, references). */
export const runKey = (prefix: string) => `${prefix}-${new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14)}`;

export const testCheckout = (reference: string, currency: string, amountMinor: number): CheckoutRequest => ({
  reference, amountMinor, currency: (['EGP', 'SAR', 'USD'].includes(currency.toUpperCase()) ? currency.toUpperCase() : 'USD') as CheckoutRequest['currency'], method: 'card', description: 'Resuto acceptance check (test mode)',
  returnUrl: 'https://example.com/resuto-acceptance/return', cancelUrl: 'https://example.com/resuto-acceptance/cancel',
  notificationUrl: 'https://example.com/resuto-acceptance/webhook', expiresInSeconds: 1800,
});

/** The health check must pass and the provider evidence must show the test environment. */
export async function assertHealthy(adapter: PaymentAdapter, actx: AdapterContext, ctx: AcceptanceContext) {
  const h = await adapter.healthCheck(actx);
  ctx.evidence('health check', { ok: h.ok, environment: h.environment ?? null, accountId: h.account?.id ?? null, accountCountry: h.account?.country ?? null });
  expectThat(h.ok, 'the provider reported the account as not ready');
  expectThat(h.environment === actx.environment, `credentials are for ${h.environment ?? 'an unknown environment'}, expected ${actx.environment}`);
}

export const official = ['official_test'] as AcceptanceCheck['modes'];
