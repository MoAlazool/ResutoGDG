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
  healthCheck?: (ctx: providers.AdapterContext) => Promise<{ ok: boolean; details?: Record<string, unknown> } & Partial<providers.HealthCheckResult>>;
  /** Payment adapters: environment implied by the credentials (documented key prefixes), null when unknown. */
  credentialEnvironment?: (credentials: Record<string, string>) => 'sandbox' | 'live' | null;
  setup?: providers.ProviderSetup;
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

export interface FieldSpec {
  key: string; label: string; secret: boolean; required: boolean; hint?: string;
  /** i18n key of the label (web dictionary), with `label` as the English fallback. */
  labelKey?: string; hintKey?: string; kind?: 'text' | 'secret' | 'number' | 'select'; pattern?: string; options?: string[]; placeholder?: string;
}

/**
 * Connection form fields for the providers this module integrates. Providers
 * owned by other agents fall back to a single API key; their modules may read
 * the sealed credentials themselves (tenant mode, aad "<orgId>:<provider>").
 */
export const CONNECTION_FIELDS: Record<string, { credentials: FieldSpec[]; config: FieldSpec[] }> = {
  whatsapp_cloud: {
    credentials: [
      { key: 'accessToken', label: 'System user access token', secret: true, required: true },
      // INT-13: set only for a Meta app the restaurant owns; its webhooks are verified with this secret.
      { key: 'appSecret', label: 'App secret (only for your own Meta app)', labelKey: 'intg.field.whatsappAppSecret', secret: true, required: false,
        hint: 'Leave empty when the number was connected through Resuto (Embedded Signup).', hintKey: 'intg.field.whatsappAppSecretHint' },
    ],
    config: [
      { key: 'phoneNumberId', label: 'Phone number id', secret: false, required: true, pattern: '^\\d{5,30}$' },
      { key: 'wabaId', label: 'WhatsApp Business Account id', secret: false, required: true, pattern: '^\\d{5,30}$' },
    ],
  },
  // INT-21 / FT-05: Messenger and Instagram Direct through a Page access token (system user of the restaurant's business).
  meta_pages: {
    credentials: [{ key: 'accessToken', label: 'Page access token', labelKey: 'intg.field.pageToken', secret: true, required: true }],
    config: [
      { key: 'pageId', label: 'Facebook Page id', labelKey: 'intg.field.pageId', secret: false, required: true, pattern: '^\\d{3,30}$' },
      { key: 'instagramAccountId', label: 'Instagram professional account id (for Instagram Direct)', labelKey: 'intg.field.instagramAccountId', secret: false,
        required: false, pattern: '^\\d{3,30}$' },
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
  // INT-20: one Pixel / dataset per restaurant. Test connections (environment sandbox) need the Test Events code.
  meta_capi: {
    credentials: [{ key: 'accessToken', label: 'Conversions API access token', labelKey: 'intg.field.capiToken', secret: true, required: true }],
    config: [
      { key: 'pixelId', label: 'Pixel (dataset) id', labelKey: 'intg.field.pixelId', secret: false, required: true, pattern: '^\\d{6,20}$' },
      { key: 'testEventCode', label: 'Test Events code (test connections only)', labelKey: 'intg.field.testEventCode', secret: false, required: false,
        pattern: '^TEST[A-Za-z0-9]{1,30}$', hint: 'Events Manager > Test events. Used only while the connection is in Test; Live never sends it.', hintKey: 'intg.field.testEventCodeHint' },
      { key: 'codPurchase', label: 'Cash orders count as Purchase', labelKey: 'intg.field.codPurchase', secret: false, required: false, kind: 'select',
        options: ['on_completion', 'never'] },
      { key: 'browserPixel', label: 'Browser Pixel on the website (with consent)', labelKey: 'intg.field.browserPixel', secret: false, required: false, kind: 'select',
        options: ['on', 'off'] },
    ],
  },
  tiktok_ads: { credentials: [{ key: 'accessToken', label: 'Access token', secret: true, required: true }], config: [{ key: 'advertiserId', label: 'Advertiser id', secret: false, required: true }] },
  snapchat_ads: {
    credentials: [{ key: 'accessToken', label: 'Access token', secret: true, required: true }, { key: 'refreshToken', label: 'Refresh token', secret: true, required: false }],
    config: [{ key: 'adAccountId', label: 'Ad account id', secret: false, required: true }],
  },
};

/** Payment adapters declare their own connection form (provider-specific credentials, validation patterns, i18n keys) — INT-06. */
function setupFields(provider: string): { credentials: FieldSpec[]; config: FieldSpec[] } | null {
  const setup = adapterFor(provider)?.setup;
  if (!setup || (!setup.credentials.length && !setup.config.length)) return null;
  const map = (f: providers.SetupField): FieldSpec => ({
    key: f.key, label: f.label, labelKey: f.labelKey, secret: f.secret, required: f.required, kind: f.kind,
    ...(f.pattern ? { pattern: f.pattern } : {}), ...(f.options ? { options: f.options } : {}), ...(f.placeholder ? { placeholder: f.placeholder } : {}),
    ...(f.hintKey ? { hintKey: f.hintKey } : {}),
  });
  return { credentials: setup.credentials.map(map), config: setup.config.map(map) };
}

export const fieldsFor = (provider: string) =>
  CONNECTION_FIELDS[provider] ?? setupFields(provider) ?? { credentials: [{ key: 'apiKey', label: 'API key', secret: true, required: false }], config: [] };

/** Where the merchant points the provider's webhooks for one connection, and which events to subscribe (CR-09). */
export function webhookFor(provider: string, connectionId: string, apiOrigin: string, config: Record<string, unknown> = {}) {
  if (provider === 'whatsapp_cloud') {
    // INT-13: only a merchant-owned Meta app registers a callback; platform (Embedded Signup) numbers use Resuto's app.
    if (config.appMode !== 'own_app') return null;
    return {
      url: `${apiOrigin.replace(/\/$/, '')}/v1/webhooks/whatsapp/c/${connectionId}`,
      events: ['messages', 'message_template_status_update'],
      registeredByMerchant: true,
      verifyToken: typeof config.webhookVerifyToken === 'string' ? config.webhookVerifyToken : null,
    };
  }
  const a = adapterFor(provider);
  if (a?.descriptor.category !== 'payments' || a.descriptor.readiness === 'simulated') return null;
  return {
    url: `${apiOrigin.replace(/\/$/, '')}/v1/webhooks/payments/${provider}?c=${connectionId}`,
    events: a.setup?.webhookEvents ?? [],
    registeredByMerchant: a.setup?.webhookRegisteredByMerchant ?? true,
  };
}

/** "accessToken …4f2a" — enough to recognise a credential, never enough to use it. */
export function credentialsHint(credentials: Record<string, string>): string | null {
  const entries = Object.entries(credentials).filter(([, v]) => typeof v === 'string' && v.length > 0);
  if (!entries.length) return null;
  return entries.map(([k, v]) => `${k} ${v.length >= 12 ? `…${v.slice(-4)}` : '••••'}`).join(', ').slice(0, 200);
}
