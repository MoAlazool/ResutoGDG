import * as providers from '@resuto/integrations';
import type { ProviderDescriptor } from '@resuto/integrations';
import { marketplaceCategory, permissionGaps, type ConnectionPermissions, type ConnectMethod, type ProviderCatalogEntry } from '@resuto/contracts';

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

/**
 * A descriptor's connect method (21-INT). Every catalogue descriptor declares one (packages/integrations
 * marketplace.test.ts); the fallback only covers descriptors added later without it, and never offers OAuth.
 */
export const connectMethodOf = (d: ProviderDescriptor): ConnectMethod => d.connectMethod ?? (d.readiness === 'simulated' ? 'platform_managed' : 'api_key');

export function catalogEntries(): ProviderCatalogEntry[] {
  return [...load().values()].map(({ descriptor: d }) => ({
    id: d.id, name: d.name, category: d.category, countries: d.countries, authType: d.authType, readiness: d.readiness,
    activation: d.activation, docsUrl: d.docsUrl ?? null, capabilities: d.capabilities, sandboxOnly: d.readiness === 'simulated',
    connectMethod: connectMethodOf(d), marketplaceCategory: marketplaceCategory(d.category),
    requiredScopes: d.requiredScopes ?? {}, reviewRequirements: d.reviewRequirements ?? [],
  })).sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name));
}

/** Config key holding the chosen ad account / advertiser (or, for Messenger / Instagram, the Facebook Page) per provider. */
export const ACCOUNT_CONFIG_KEY: Record<string, string> = {
  meta_ads: 'adAccountId', tiktok_ads: 'advertiserId', snapchat_ads: 'adAccountId', meta_pages: 'pageId',
  // INT-24: a Foodics token belongs to one business; its reference is confirmed by the owner and routes menu webhooks.
  foodics: 'businessReference',
};

/** Meta connections whose granted permissions Resuto can read back with GET /me/permissions (a user or system user token). */
export function permissionsCheckable(provider: string, config: Record<string, unknown>): boolean {
  if (provider === 'meta_ads' || provider === 'whatsapp_cloud') return true;
  // A pasted Page token has no person behind it; the Login user token (OAuth) does.
  return provider === 'meta_pages' && config.tokenSource === 'platform_app';
}

/**
 * Granted scopes (integration_connections.scopes, read back from the provider) against the scopes each capability
 * needs. Snapchat, TikTok and RFC 6749 providers report them in the token response; Meta through /me/permissions.
 */
export function connectionPermissions(provider: string, scopes: string[] | null | undefined, config: Record<string, unknown> = {}): ConnectionPermissions {
  const d = adapterFor(provider)?.descriptor;
  const checkable = permissionsCheckable(provider, config);
  const gaps = permissionGaps(d?.requiredScopes, scopes ?? []);
  return { ...gaps, checkable, source: checkable ? 'permissions_api' : gaps.checked ? 'token_response' : null };
}

export function adapterFor(provider: string): CatalogAdapter | null {
  return load().get(provider) ?? null;
}

export interface FieldSpec {
  key: string; label: string; secret: boolean; required: boolean; hint?: string;
  /** i18n key of the label (web dictionary), with `label` as the English fallback. */
  labelKey?: string; hintKey?: string; kind?: 'text' | 'secret' | 'number' | 'select'; pattern?: string; options?: string[]; placeholder?: string;
}

/** Odoo settings shared by Odoo POS and Odoo Accounting (INT-25: one connection model, JSON-2 transport). */
const ODOO_API_KEY: FieldSpec = { key: 'apiKey', label: 'Odoo API key', labelKey: 'intg.field.odooApiKey', secret: true, required: true };
const ODOO_SITE: FieldSpec[] = [
  { key: 'url', label: 'Odoo URL (https://…)', labelKey: 'intg.field.odooUrl', secret: false, required: true, pattern: '^https://[^\\s/]+(/[^\\s]*)?$' },
  { key: 'database', label: 'Database name', labelKey: 'intg.field.odooDatabase', secret: false, required: false, pattern: '^[A-Za-z0-9_.-]{1,63}$' },
];
/** INT-25: how sales are posted and whether the previous day is pushed automatically. */
const ACCOUNTING_POSTING: FieldSpec[] = [
  { key: 'salesPosting', label: 'Sales posting', labelKey: 'intg.field.salesPosting', secret: false, required: false, kind: 'select', options: ['journal', 'summary_invoice'],
    hint: 'Daily sales journal (default), or a daily summary invoice plus a receipts journal. Revenue is recorded once either way.', hintKey: 'intg.field.salesPostingHint' },
  { key: 'autoPush', label: 'Automatic push', labelKey: 'intg.field.autoPush', secret: false, required: false, kind: 'select', options: ['off', 'daily'],
    hint: 'Daily: the previous business day is pushed after 04:00 restaurant time; documents already pushed are skipped.', hintKey: 'intg.field.autoPushHint' },
];

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
    credentials: [ODOO_API_KEY],
    config: [
      ...ODOO_SITE,
      { key: 'currency', label: 'Company currency (EGP/SAR)', secret: false, required: false, hint: 'Prices import only when this matches your restaurant currency.' },
    ],
  },
  // INT-25: accounting connections. Account roles are mapped in Finance > Accounting (config.accounts).
  wafeq: {
    credentials: [{ key: 'apiKey', label: 'Wafeq API key', labelKey: 'intg.field.wafeqApiKey', secret: true, required: true }],
    config: [
      ...ACCOUNTING_POSTING,
      { key: 'customerContactId', label: 'Walk-in customer contact id (summary invoices)', labelKey: 'intg.field.customerContactId', secret: false, required: false, pattern: '^[A-Za-z0-9_-]{1,80}$' },
      { key: 'taxRateId', label: 'VAT tax rate id (summary invoices)', labelKey: 'intg.field.taxRateId', secret: false, required: false, pattern: '^[A-Za-z0-9_-]{1,80}$' },
      { key: 'invoiceStatus', label: 'Invoice status', labelKey: 'intg.field.invoiceStatus', secret: false, required: false, kind: 'select', options: ['DRAFT', 'SENT', 'FINALIZED'] },
    ],
  },
  qoyod: {
    credentials: [{ key: 'apiKey', label: 'Qoyod API key', labelKey: 'intg.field.qoyodApiKey', secret: true, required: true }],
    config: [
      ...ACCOUNTING_POSTING,
      { key: 'contactId', label: 'Walk-in customer id (summary invoices)', labelKey: 'intg.field.qoyodContactId', secret: false, required: false, pattern: '^\\d{1,12}$' },
      { key: 'inventoryId', label: 'Inventory id (summary invoices)', labelKey: 'intg.field.qoyodInventoryId', secret: false, required: false, pattern: '^\\d{1,12}$' },
      { key: 'productId', label: 'Restaurant sales product id (summary invoices)', labelKey: 'intg.field.qoyodProductId', secret: false, required: false, pattern: '^\\d{1,12}$' },
      { key: 'invoiceStatus', label: 'Invoice status', labelKey: 'intg.field.invoiceStatus', secret: false, required: false, kind: 'select', options: ['Draft', 'Approved'] },
    ],
  },
  // One Odoo connection model for POS and Accounting (url + database in settings, API key sealed).
  odoo_accounting: {
    credentials: [ODOO_API_KEY],
    config: [
      ...ODOO_SITE,
      ...ACCOUNTING_POSTING,
      { key: 'journalId', label: 'Journal id for Resuto entries', labelKey: 'intg.field.odooJournalId', secret: false, required: true, pattern: '^\\d{1,9}$' },
      { key: 'partnerId', label: 'Walk-in partner id (summary invoices)', labelKey: 'intg.field.odooPartnerId', secret: false, required: false, pattern: '^\\d{1,9}$' },
      { key: 'taxId', label: 'Sales tax id (summary invoices)', labelKey: 'intg.field.odooTaxId', secret: false, required: false, pattern: '^\\d{1,9}$' },
      // INT-25 review: Odoo 17 / 18 have no JSON-2; with the login the adapter falls back to the legacy /jsonrpc API.
      { key: 'login', label: 'Login of the API key user (Odoo 17 / 18 only)', labelKey: 'intg.field.odooLogin', secret: false, required: false, pattern: '^[^\\s]{1,200}$' },
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
  // INT-29: the restaurant's own Google Cloud key (Routes API); Resuto stops at the daily cap and uses the baseline.
  google_routes: {
    credentials: [{ key: 'apiKey', label: 'Google Maps Platform API key (Routes API)', labelKey: 'intg.field.googleRoutesKey', secret: true, required: true }],
    config: [{ key: 'dailyRequestCap', label: 'Daily request cap', labelKey: 'intg.field.dailyRequestCap', secret: false, required: false, kind: 'number',
      pattern: '^\\d{1,6}$', hint: 'Resuto makes at most this many Routes requests per day (default 300), then uses the offline estimate.', hintKey: 'intg.field.dailyRequestCapHint' }],
  },
  // INT-23: TikTok Pixel + Events API (one per restaurant). The Test event code is also used by the health check on Live.
  tiktok_events: {
    credentials: [{ key: 'accessToken', label: 'Events API access token', labelKey: 'intg.field.tiktokEventsToken', secret: true, required: true }],
    config: [
      { key: 'pixelCode', label: 'Pixel code', labelKey: 'intg.field.tiktokPixelCode', secret: false, required: true, pattern: '^[A-Z0-9]{10,40}$' },
      { key: 'testEventCode', label: 'Test event code', labelKey: 'intg.field.tiktokTestEventCode', secret: false, required: false, pattern: '^[A-Za-z0-9_-]{4,40}$',
        hint: 'Events Manager > the Pixel > Test events. Test connections send it with every event; the health check uses it on Live too, so checks never count as conversions.',
        hintKey: 'intg.field.tiktokTestEventCodeHint' },
      { key: 'codPurchase', label: 'Cash orders count as Purchase', labelKey: 'intg.field.codPurchase', secret: false, required: false, kind: 'select', options: ['on_completion', 'never'] },
      { key: 'browserPixel', label: 'Browser Pixel on the website (with consent)', labelKey: 'intg.field.browserPixel', secret: false, required: false, kind: 'select', options: ['on', 'off'] },
    ],
  },
  // INT-23: Snap Pixel + Conversions API v3. Test connections only call Snap's /validate endpoint.
  snap_capi: {
    credentials: [{ key: 'accessToken', label: 'Conversions API token', labelKey: 'intg.field.snapCapiToken', secret: true, required: true }],
    config: [
      { key: 'pixelId', label: 'Snap Pixel id', labelKey: 'intg.field.snapPixelId', secret: false, required: true,
        pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' },
      { key: 'testEventCode', label: 'Test event code (optional, test connections only)', labelKey: 'intg.field.snapTestEventCode', secret: false, required: false, pattern: '^[A-Za-z0-9_-]{1,60}$' },
      { key: 'codPurchase', label: 'Cash orders count as Purchase', labelKey: 'intg.field.codPurchase', secret: false, required: false, kind: 'select', options: ['on_completion', 'never'] },
      { key: 'browserPixel', label: 'Browser Pixel on the website (with consent)', labelKey: 'intg.field.browserPixel', secret: false, required: false, kind: 'select', options: ['on', 'off'] },
    ],
  },
  // INT-28: the restaurant's own Resend account (transactional + consented marketing email).
  resend: {
    credentials: [
      { key: 'apiKey', label: 'Resend API key', labelKey: 'intg.field.resendApiKey', secret: true, required: true, pattern: '^re_[A-Za-z0-9_]{8,200}$' },
      { key: 'webhookSecret', label: 'Webhook signing secret (whsec_…)', labelKey: 'intg.field.resendWebhookSecret', secret: true, required: false, pattern: '^whsec_[A-Za-z0-9+/=]{8,200}$',
        hint: 'Resend → Webhooks → the endpoint shown below → Signing secret. Without it delivery status stays "accepted".', hintKey: 'intg.field.resendWebhookSecretHint' },
    ],
    config: [
      { key: 'from', label: 'From address', labelKey: 'intg.field.emailFrom', secret: false, required: true, placeholder: 'Olive Room <hello@olive.example>',
        hint: 'An address on a domain verified in Resend.', hintKey: 'intg.field.emailFromHint' },
      { key: 'replyTo', label: 'Reply-to address (optional)', labelKey: 'intg.field.emailReplyTo', secret: false, required: false },
    ],
  },
  // INT-28: the restaurant's own Twilio account (SMS). The Auth Token also verifies status callbacks.
  twilio_sms: {
    credentials: [
      { key: 'accountSid', label: 'Account SID (AC…)', labelKey: 'intg.field.twilioAccountSid', secret: false, required: true, pattern: '^AC[0-9a-fA-F]{32}$' },
      { key: 'authToken', label: 'Auth Token', labelKey: 'intg.field.twilioAuthToken', secret: true, required: true },
      { key: 'apiKeySid', label: 'API key SID (SK…, optional)', labelKey: 'intg.field.twilioApiKeySid', secret: false, required: false, pattern: '^SK[0-9a-fA-F]{32}$' },
      { key: 'apiKeySecret', label: 'API key secret (optional)', labelKey: 'intg.field.twilioApiKeySecret', secret: true, required: false },
    ],
    config: [
      { key: 'messagingServiceSid', label: 'Messaging Service SID (MG…)', labelKey: 'intg.field.twilioMessagingService', secret: false, required: false, pattern: '^MG[0-9a-fA-F]{32}$',
        hint: 'Recommended in Saudi Arabia and Egypt: a Messaging Service with your registered alphanumeric Sender ID. Otherwise set From.', hintKey: 'intg.field.twilioMessagingServiceHint' },
      { key: 'from', label: 'From (registered Sender ID or number)', labelKey: 'intg.field.smsFrom', secret: false, required: false, pattern: '^(\\+[1-9]\\d{6,14}|[A-Za-z0-9 ]{1,11})$' },
    ],
  },
  // INT-26: ETA e-receipt POS (Egypt). Implementation incomplete — not certified.
  eta_ereceipt: {
    credentials: [
      { key: 'clientId', label: 'POS client id', labelKey: 'intg.field.etaClientId', secret: true, required: true },
      { key: 'clientSecret', label: 'POS client secret', labelKey: 'intg.field.etaClientSecret', secret: true, required: true },
      { key: 'presharedKey', label: 'POS pre-shared key', labelKey: 'intg.field.etaPresharedKey', secret: true, required: true },
      { key: 'signingKeyPem', label: 'eSeal private key (PEM)', labelKey: 'intg.field.etaSigningKey', secret: true, required: true,
        hint: 'The private key of the eSeal certificate used for the issuer signature (CAdES-BES). Stored sealed.', hintKey: 'intg.field.etaSigningKeyHint' },
    ],
    config: [
      { key: 'posSerial', label: 'POS serial number', labelKey: 'intg.field.etaPosSerial', secret: false, required: true, pattern: '^.{1,100}$' },
      { key: 'posOsVersion', label: 'POS OS version', labelKey: 'intg.field.etaPosOsVersion', secret: false, required: true, pattern: '^.{1,50}$' },
      { key: 'posModelFramework', label: 'POS model framework', labelKey: 'intg.field.etaPosModelFramework', secret: false, required: true, pattern: '^.{1,10}$' },
      { key: 'signingCertificatePem', label: 'eSeal certificate (PEM)', labelKey: 'intg.field.etaSigningCert', secret: false, required: true },
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
  // INT-28: delivery status. Resend: the merchant adds this endpoint in Resend → Webhooks; Twilio: Resuto sets it on every message.
  if (provider === 'resend') {
    return { url: `${apiOrigin.replace(/\/$/, '')}/v1/webhooks/resend/${connectionId}`, registeredByMerchant: true,
      events: ['email.sent', 'email.delivered', 'email.delivery_delayed', 'email.bounced', 'email.complained', 'email.failed', 'email.suppressed'] };
  }
  if (provider === 'twilio_sms') {
    return { url: `${apiOrigin.replace(/\/$/, '')}/v1/webhooks/twilio/status/${connectionId}`, registeredByMerchant: false, events: ['StatusCallback (MessageStatus)'] };
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
