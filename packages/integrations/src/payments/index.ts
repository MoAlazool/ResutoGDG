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

export const paymentsAdapters = [simulatedAdapter, paymobAdapter, stripeAdapter, moyasarAdapter] as const;

export const PAYMENT_ADAPTERS: Readonly<Record<string, PaymentAdapter>> = Object.fromEntries(paymentsAdapters.map((a) => [a.descriptor.id, a]));

export const paymentAdapter = (provider: string): PaymentAdapter | null => PAYMENT_ADAPTERS[provider] ?? null;
