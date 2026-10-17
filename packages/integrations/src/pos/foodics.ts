// Foodics API v5 menu import (port of legacy integrations.js FoodicsAdapter).
// Docs: https://developers.foodics.com (Products: GET /v5/products?include=category,
//       pagination via links.next / meta.last_page; Who am I: GET /v5/whoami).
// Readiness: implemented_unverified (no Foodics partner app or merchant token available).
import { providerRequest, ProviderError, type AdapterContext, type ProviderDescriptor } from '../core';
import { cleanText, IMPORT_DEFAULT_STATION, majorToMinor, type MenuImportRow, type PosAdapter } from './types';

export const FOODICS_BASE = { live: 'https://api.foodics.com/v5', sandbox: 'https://api-sandbox.foodics.com/v5' } as const;

export const foodicsDescriptor: ProviderDescriptor = {
  id: 'foodics',
  name: 'Foodics POS',
  category: 'pos',
  countries: ['EG', 'SA'],
  authType: 'oauth',
  readiness: 'implemented_unverified',
  docsUrl: 'https://developers.foodics.com',
  capabilities: ['menu_import'],
  activation: [
    'Register a Foodics partner app (Foodics Developer portal) and pass Foodics app review for the "general.read" / menu scopes.',
    'Each restaurant authorises the app from its Foodics console; paste the resulting access token here (sandbox tokens use api-sandbox.foodics.com).',
    'Menu import only: rows are reviewed in Resuto and imported unavailable; Resuto does not push orders to Foodics.',
  ],
};

function token(ctx: AdapterContext) {
  const t = ctx.credentials.accessToken;
  if (!t) throw new ProviderError('foodics', 'missing access token', false);
  return t;
}

export function mapFoodicsProduct(p: any): MenuImportRow | null {
  if (!p || typeof p !== 'object' || p.deleted_at) return null;
  const name = cleanText(p.name, 120);
  const price = majorToMinor(p.price);
  if (!name || price === null) return null;
  return {
    externalId: String(p.id),
    name,
    nameAr: cleanText(p.name_localized, 120),
    category: cleanText(p.category?.name, 80) ?? 'Mains',
    description: cleanText(p.description, 1000),
    priceMinor: price,
    station: IMPORT_DEFAULT_STATION,
    allergens: [],
    available: false,
  };
}

export const foodicsAdapter: PosAdapter = {
  descriptor: foodicsDescriptor,

  async fetchMenuPage(ctx, input) {
    const page = Math.max(1, Number(input.cursor ?? '1') || 1);
    const url = `${FOODICS_BASE[ctx.environment]}/products?include=category&page=${page}`;
    const res = await providerRequest<{ data?: unknown[]; links?: { next?: string | null }; meta?: { current_page?: number; last_page?: number } }>('foodics', ctx, url, {
      headers: { Authorization: `Bearer ${token(ctx)}` }, timeoutMs: 12_000,
    });
    if (!Array.isArray(res.data)) throw new ProviderError('foodics', 'invalid provider response (data is not an array)', false);
    const warnings: string[] = [];
    const rows: MenuImportRow[] = [];
    for (const p of res.data) {
      if ((p as any)?.deleted_at) continue; // deleted in Foodics: not a data problem
      const row = mapFoodicsProduct(p);
      if (row) rows.push(row);
      else warnings.push(`Skipped a product without a name or valid price (${String((p as any)?.id ?? '?')})`);
    }
    const last = res.meta?.last_page ?? (res.links?.next ? page + 1 : page);
    return { rows, nextCursor: page < last ? String(page + 1) : null, warnings };
  },

  async healthCheck(ctx) {
    const res = await providerRequest<{ data?: { business?: { name?: string; reference?: number | string } } }>('foodics', ctx, `${FOODICS_BASE[ctx.environment]}/whoami`, {
      headers: { Authorization: `Bearer ${token(ctx)}` }, retries: 1,
    });
    return { ok: !!res.data, details: { business: res.data?.business?.name ?? null } };
  },
};
