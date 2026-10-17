import * as providers from '@resuto/integrations';
import type { ProviderDescriptor } from '@resuto/integrations';
import type { ProviderCatalogEntry } from '@resuto/contracts';

/**
 * Provider catalogue: every descriptor exported by @resuto/integrations through a
 * `<category>Adapters` array (messaging, ads, pos, payments, accounting, tax, maps…),
 * whichever agent owns the category. Items may be adapters ({ descriptor, … }) or
 * bare descriptors.
 */
export interface CatalogAdapter {
  descriptor: ProviderDescriptor;
  healthCheck?: (ctx: providers.AdapterContext) => Promise<{ ok: boolean; details?: Record<string, unknown> }>;
  [key: string]: unknown;
}

const isDescriptor = (d: any): d is ProviderDescriptor =>
  !!d && typeof d === 'object' && typeof d.id === 'string' && typeof d.category === 'string' && typeof d.readiness === 'string' && Array.isArray(d.activation);

let cache: Map<string, CatalogAdapter> | null = null;

function load(): Map<string, CatalogAdapter> {
  if (cache) return cache;
  const map = new Map<string, CatalogAdapter>();
  for (const [name, value] of Object.entries(providers)) {
    if (!name.endsWith('Adapters') || !Array.isArray(value)) continue;
    for (const item of value as unknown[]) {
      const d = (item as any)?.descriptor ?? item;
      if (!isDescriptor(d) || map.has(d.id)) continue;
      map.set(d.id, (item as any)?.descriptor ? (item as CatalogAdapter) : { descriptor: d });
    }
  }
  return (cache = map);
}

export function catalogEntries(): ProviderCatalogEntry[] {
  return [...load().values()].map(({ descriptor: d }) => ({
    id: d.id, name: d.name, category: d.category, countries: d.countries, authType: d.authType, readiness: d.readiness,
    activation: d.activation, docsUrl: d.docsUrl ?? null, capabilities: d.capabilities, sandboxOnly: d.readiness === 'simulated',
  })).sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name));
}

export function adapterFor(provider: string): CatalogAdapter | null {
  return load().get(provider) ?? null;
}

export interface FieldSpec { key: string; label: string; secret: boolean; required: boolean; hint?: string }

/**
 * Connection form fields for the providers this module integrates. Providers
 * owned by other agents fall back to a single API key; their modules may read
 * the sealed credentials themselves (tenant mode, aad "<orgId>:<provider>").
 */
export const CONNECTION_FIELDS: Record<string, { credentials: FieldSpec[]; config: FieldSpec[] }> = {
  whatsapp_cloud: {
    credentials: [{ key: 'accessToken', label: 'System user access token', secret: true, required: true }],
    config: [
      { key: 'phoneNumberId', label: 'Phone number id', secret: false, required: true },
      { key: 'wabaId', label: 'WhatsApp Business Account id', secret: false, required: true },
    ],
  },
  foodics: { credentials: [{ key: 'accessToken', label: 'Foodics access token', secret: true, required: true }], config: [] },
  odoo: {
    credentials: [{ key: 'apiKey', label: 'Odoo API key', secret: true, required: true }],
    config: [
      { key: 'url', label: 'Odoo URL (https://…)', secret: false, required: true },
      { key: 'database', label: 'Database name', secret: false, required: false },
      { key: 'currency', label: 'Company currency (EGP/SAR)', secret: false, required: false, hint: 'Prices import only when this matches your restaurant currency.' },
    ],
  },
  meta_ads: { credentials: [{ key: 'accessToken', label: 'Access token', secret: true, required: true }], config: [{ key: 'adAccountId', label: 'Ad account id (act_…)', secret: false, required: true }] },
  tiktok_ads: { credentials: [{ key: 'accessToken', label: 'Access token', secret: true, required: true }], config: [{ key: 'advertiserId', label: 'Advertiser id', secret: false, required: true }] },
  snapchat_ads: {
    credentials: [{ key: 'accessToken', label: 'Access token', secret: true, required: true }, { key: 'refreshToken', label: 'Refresh token', secret: true, required: false }],
    config: [{ key: 'adAccountId', label: 'Ad account id', secret: false, required: true }],
  },
};

export const fieldsFor = (provider: string) =>
  CONNECTION_FIELDS[provider] ?? { credentials: [{ key: 'apiKey', label: 'API key', secret: true, required: false }], config: [] };

/** "accessToken …4f2a" — enough to recognise a credential, never enough to use it. */
export function credentialsHint(credentials: Record<string, string>): string | null {
  const entries = Object.entries(credentials).filter(([, v]) => typeof v === 'string' && v.length > 0);
  if (!entries.length) return null;
  return entries.map(([k, v]) => `${k} ${v.length >= 12 ? `…${v.slice(-4)}` : '••••'}`).join(', ').slice(0, 200);
}
