// payments provider adapters. Owner: Agent D1. Export adapters and their ProviderDescriptor here.
import { moyasarAdapter } from './moyasar';
import { paymobAdapter } from './paymob';
import { simulatedAdapter } from './simulated';
import { stripeAdapter } from './stripe';
import type { PaymentAdapter } from './types';

export * from './types';
export * from './simulated';
export * from './stripe';
export * from './paymob';
export * from './moyasar';
export * from './signature';

export const paymentsAdapters = [simulatedAdapter, paymobAdapter, stripeAdapter, moyasarAdapter] as const;

/** Null-prototype map: provider ids such as "constructor" or "__proto__" never resolve to an adapter (PAY-18). */
export const PAYMENT_ADAPTERS: Readonly<Record<string, PaymentAdapter>> = Object.freeze(
  Object.assign(Object.create(null) as Record<string, PaymentAdapter>, Object.fromEntries(paymentsAdapters.map((a) => [a.descriptor.id, a]))));

export const paymentAdapter = (provider: string): PaymentAdapter | null =>
  typeof provider === 'string' && Object.hasOwn(PAYMENT_ADAPTERS, provider) ? PAYMENT_ADAPTERS[provider]! : null;
