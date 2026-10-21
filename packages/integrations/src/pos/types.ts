import type { AdapterContext, ProviderDescriptor } from '../core';

/**
 * One menu-import row in the shape agreed in MODULE_CONTRACTS.md §8 (B1's
 * POST /v1/o/:orgId/menu/import/preview|commit). POS adapters only produce rows;
 * they never write menu tables.
 */
export interface MenuImportRow {
  externalId?: string;
  name: string;
  nameAr?: string;
  category: string;
  description?: string;
  priceMinor: number;
  station?: string;
  allergens?: string[];
  available?: boolean;
}

export interface MenuPage {
  rows: MenuImportRow[];
  /** Opaque provider cursor for the next page; null when the catalogue is exhausted. */
  nextCursor: string | null;
  warnings: string[];
}

export interface PosAdapter {
  descriptor: ProviderDescriptor;
  /** Fetches one page of the provider's sellable products. `currency` is the restaurant's currency. */
  fetchMenuPage(ctx: AdapterContext, input: { cursor: string | null; currency: string }): Promise<MenuPage>;
  healthCheck(ctx: AdapterContext): Promise<{ ok: boolean; details: Record<string, unknown>; account?: { id?: string | null; name?: string | null; country?: string | null } | null }>;
  /** Revokes the stored token at the provider when the connection is disconnected (optional). */
  revokeAccess?(ctx: AdapterContext): Promise<{ attempted: boolean; revoked: boolean; note: string }>;
}

/** Imported rows start unavailable so staff review them before guests can order (legacy behaviour). */
export const IMPORT_DEFAULT_STATION = 'Kitchen';

export function majorToMinor(value: unknown): number | null {
  const n = typeof value === 'string' ? Number(value) : (value as number);
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 100);
}

export const cleanText = (v: unknown, max: number): string | undefined => {
  if (typeof v !== 'string') return undefined;
  const s = v.replace(/<[^>]*>/g, '').trim();
  return s ? s.slice(0, max) : undefined;
};
