// pos provider adapters. Owner: Agent C. Export adapters and their ProviderDescriptor here.
import { foodicsAdapter } from './foodics';
import { odooAdapter } from './odoo';
import { posSandboxAdapter } from './sandbox';
import type { PosAdapter } from './types';

export * from './types';
export * from './foodics';
export * from './odoo';
export * from './sandbox';

export const posAdapters = [foodicsAdapter, odooAdapter, posSandboxAdapter] as const;

export function posAdapterFor(provider: string): PosAdapter | null {
  return (posAdapters as readonly PosAdapter[]).find((a) => a.descriptor.id === provider) ?? null;
}
