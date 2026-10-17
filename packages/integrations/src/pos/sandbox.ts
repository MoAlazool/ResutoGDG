// POS sandbox: a fixed, clearly labelled sample catalogue so the import flow
// (fetch → preview → B1 import) can be rehearsed without a POS account.
// Every row is prefixed "[Sandbox]" and nothing is fetched from a provider.
import type { ProviderDescriptor } from '../core';
import type { MenuImportRow, PosAdapter } from './types';

export const posSandboxDescriptor: ProviderDescriptor = {
  id: 'pos_sandbox',
  name: 'POS sandbox (sample catalogue)',
  category: 'pos',
  countries: ['EG', 'SA'],
  authType: 'none',
  readiness: 'simulated',
  capabilities: ['menu_import'],
  activation: ['No activation needed. Returns a fixed sample catalogue labelled [Sandbox]; connect Foodics or Odoo for your real menu.'],
};

const SAMPLE: Array<Omit<MenuImportRow, 'priceMinor'> & { price: number }> = [
  { externalId: 'sbx-1', name: '[Sandbox] Classic burger', nameAr: '[تجريبي] برجر كلاسيك', category: 'Sandbox mains', price: 15000 },
  { externalId: 'sbx-2', name: '[Sandbox] Grilled chicken', nameAr: '[تجريبي] دجاج مشوي', category: 'Sandbox mains', price: 17000 },
  { externalId: 'sbx-3', name: '[Sandbox] Lemon mint', nameAr: '[تجريبي] ليمون بالنعناع', category: 'Sandbox drinks', price: 4500 },
];

export const posSandboxAdapter: PosAdapter = {
  descriptor: posSandboxDescriptor,
  async fetchMenuPage() {
    return {
      rows: SAMPLE.map(({ price, ...r }) => ({ ...r, priceMinor: price, station: 'Kitchen', allergens: [], available: false })),
      nextCursor: null,
      warnings: ['Sandbox catalogue: sample rows only, not from a real POS.'],
    };
  },
  async healthCheck() {
    return { ok: true, details: { sandbox: true } };
  },
};
