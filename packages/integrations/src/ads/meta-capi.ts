// Meta Pixel + Conversions API (INT-20). Server events for a restaurant's Pixel (dataset), deduplicated with the browser
// Pixel through a shared event_id.
// Docs (checked 2026-10-20; version pin in ../meta/graph.ts):
//   Using the API (POST /{PIXEL_ID}/events, up to 1,000 events, event_time at most 7 days old, test_event_code
//   top-level, test events are NOT dropped):  https://developers.facebook.com/docs/marketing-api/conversions-api/using-the-api
//   Customer information parameters (em/ph/country hashed after normalisation; client_ip_address, client_user_agent,
//   fbc, fbp never hashed; client_user_agent required for website events):
//     https://developers.facebook.com/docs/marketing-api/conversions-api/parameters/customer-information-parameters
//   Deduplication (same event_name + event_id from Pixel `eventID` and the server):
//     https://developers.facebook.com/docs/marketing-api/conversions-api/deduplicate-pixel-and-server-events
//   Pixel base code and eventID:  https://developers.facebook.com/docs/meta-pixel/get-started
// Readiness: implemented_unverified (no Meta Pixel or CAPI token available). Acceptance checks: ../acceptance/meta.ts.
import { createHash } from 'node:crypto';
import { ProviderError, type AdapterContext, type ProviderDescriptor } from '../core';
import { graphRequest, metaAuth } from '../meta/graph';

export const metaCapiDescriptor: ProviderDescriptor = {
  id: 'meta_capi',
  name: 'Meta Pixel & Conversions API',
  category: 'ads',
  countries: ['EG', 'SA'],
  authType: 'api_key',
  connectMethod: 'api_key',
  readiness: 'implemented_unverified',
  docsUrl: 'https://developers.facebook.com/docs/marketing-api/conversions-api',
  capabilities: ['browser_pixel_consented', 'server_purchase', 'event_id_dedup', 'hashed_user_data', 'test_event_code', 'purchase_policy_prepaid_cod',
    'outbox_retry', 'diagnostics'],
  activation: [
    'In Meta Events Manager, create (or pick) the Pixel / dataset for the restaurant website and copy its id.',
    'Events Manager > the dataset > Settings > Conversions API > Generate access token. Paste it here; Resuto stores it sealed and never shows it again.',
    'Create the connection in Test with the Test Events code (Events Manager > Test events, "TEST…"). Use "Send test event" and check that it appears in Test events. Test events are still processed by Meta, so only synthetic data is sent from the test button.',
    'Then switch this same connection to Live (Integrations > the connection > Reconnect > Live); a restaurant has one Meta Pixel connection. Live never sends the Test Events code, so you can keep or clear it. Guests see a consent prompt on the website; nothing is sent for guests who decline, for demo restaurants, or for test or simulated payments.',
    'Purchase policy: prepaid orders count when the payment is captured; cash-on-delivery / pay-at-pickup orders count when completed (or never, if you choose).',
  ],
};

export const META_PIXEL_ID = /^\d{6,20}$/;
export const META_TEST_EVENT_CODE = /^TEST[A-Za-z0-9]{1,30}$/;
export const CAPI_MAX_AGE_SECONDS = 7 * 24 * 3600;

export type MetaStandardEvent = 'PageView' | 'ViewContent' | 'AddToCart' | 'InitiateCheckout' | 'Purchase' | 'Schedule' | 'Lead';
export type CodPurchasePolicy = 'on_completion' | 'never';

const sha256 = (v: string) => createHash('sha256').update(v, 'utf8').digest('hex');

/** Email: trim + lowercase, then SHA-256. Null when it is not an address. */
export function hashEmail(email: string | null | undefined): string | null {
  const v = (email ?? '').trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) ? sha256(v) : null;
}

/** Phone: digits only with the country code and no leading zeros ("+20 100 123 4567" → "201001234567"), then SHA-256. */
export function hashPhone(phone: string | null | undefined): string | null {
  const digits = (phone ?? '').replace(/\D/g, '').replace(/^0+/, '');
  return digits.length >= 7 && digits.length <= 15 ? sha256(digits) : null;
}

export const hashCountry = (country: string | null | undefined) => (country && /^[A-Za-z]{2}$/.test(country) ? sha256(country.toLowerCase()) : null);
export const hashExternalId = (id: string | null | undefined) => (id ? sha256(id.trim().toLowerCase()) : null);

/** fbp: fb.{subdomain_index}.{creation_time_ms}.{random}; fbc: fb.{subdomain_index}.{creation_time_ms}.{fbclid}. */
export const FBP_FORMAT = /^fb\.[0-2]\.\d{10,13}\.\d{1,20}$/;
export const FBC_FORMAT = /^fb\.[0-2]\.\d{10,13}\.[A-Za-z0-9_-]{8,}$/;

export interface CapiUserInput {
  email?: string | null;
  phone?: string | null;
  externalId?: string | null;
  country?: string | null;
  clientIp?: string | null;
  userAgent?: string | null;
  fbp?: string | null;
  fbc?: string | null;
}

/** user_data with Meta's normalisation and hashing; identifiers Meta wants raw (ip, ua, fbp, fbc) are validated, not hashed. */
export function buildUserData(u: CapiUserInput): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const em = hashEmail(u.email); if (em) out.em = [em];
  const ph = hashPhone(u.phone); if (ph) out.ph = [ph];
  const ex = hashExternalId(u.externalId); if (ex) out.external_id = [ex];
  const c = hashCountry(u.country); if (c) out.country = [c];
  if (u.clientIp && /^[0-9a-fA-F:.]{3,45}$/.test(u.clientIp)) out.client_ip_address = u.clientIp;
  if (u.userAgent) out.client_user_agent = u.userAgent.slice(0, 500);
  if (u.fbp && FBP_FORMAT.test(u.fbp)) out.fbp = u.fbp;
  if (u.fbc && u.fbc.length <= 600 && FBC_FORMAT.test(u.fbc)) out.fbc = u.fbc;
  return out;
}

/** Order amounts are stored in minor units; Meta's `value` is a decimal amount in the currency (EGP/SAR have 2 decimals). */
export const minorToValue = (minor: number, currency: string) => Number((minor / (currency === 'KWD' || currency === 'BHD' || currency === 'OMR' ? 1000 : 100)).toFixed(3));

export interface CapiEventInput {
  eventName: MetaStandardEvent;
  eventId: string;
  eventTime: Date;
  eventSourceUrl: string;
  user: CapiUserInput;
  custom?: { currency?: string; valueMinor?: number; orderId?: string; contents?: Array<{ id: string; quantity: number; itemPriceMinor?: number }> };
}

/** One `data[]` entry, or an error string when Meta would reject the whole request (the API refuses the batch then). */
export function buildServerEvent(input: CapiEventInput, now = new Date()): { event: Record<string, unknown> } | { error: string } {
  const age = (now.getTime() - input.eventTime.getTime()) / 1000;
  if (age > CAPI_MAX_AGE_SECONDS) return { error: 'event_too_old' };
  if (age < -300) return { error: 'event_in_future' };
  if (!/^[A-Za-z0-9._:-]{1,100}$/.test(input.eventId)) return { error: 'invalid_event_id' };
  if (!/^https:\/\//.test(input.eventSourceUrl)) return { error: 'event_source_url_required' };
  const user_data = buildUserData(input.user);
  // Website events need the browser's user agent (and Meta matches on ip + ua + fbp/fbc or hashed identifiers).
  if (!user_data.client_user_agent) return { error: 'client_user_agent_required' };
  const custom: Record<string, unknown> = {};
  const c = input.custom;
  if (c?.currency && typeof c.valueMinor === 'number') { custom.currency = c.currency; custom.value = minorToValue(c.valueMinor, c.currency); }
  if (c?.orderId) custom.order_id = c.orderId;
  if (c?.contents?.length) {
    custom.content_type = 'product';
    custom.contents = c.contents.slice(0, 50).map((x) => ({ id: x.id, quantity: x.quantity,
      ...(typeof x.itemPriceMinor === 'number' && c.currency ? { item_price: minorToValue(x.itemPriceMinor, c.currency) } : {}) }));
    custom.num_items = c.contents.reduce((s, x) => s + x.quantity, 0);
  }
  return {
    event: {
      event_name: input.eventName, event_time: Math.floor(input.eventTime.getTime() / 1000), event_id: input.eventId,
      action_source: 'website', event_source_url: input.eventSourceUrl, user_data, ...(Object.keys(custom).length ? { custom_data: custom } : {}),
    },
  };
}

export interface CapiSendResult { eventsReceived: number; fbtraceId: string | null; messages: string[] }

function pixelIdOf(ctx: AdapterContext): string {
  const id = String(ctx.config.pixelId ?? '');
  if (!META_PIXEL_ID.test(id)) throw new ProviderError('meta_capi', 'missing or invalid pixelId', false);
  return id;
}

/**
 * Test mode (connection environment 'sandbox') must carry the Test Events code and live mode must not
 * (Meta: "test_event_code should be used only for testing"). Returns the code to send, or throws.
 */
export function testEventCodeFor(ctx: AdapterContext): string | null {
  const code = typeof ctx.config.testEventCode === 'string' ? ctx.config.testEventCode.trim() : '';
  if (ctx.environment === 'live') return null;
  if (!META_TEST_EVENT_CODE.test(code)) throw new ProviderError('meta_capi', 'a test connection needs the Test Events code (TEST…)', false);
  return code;
}

export const metaCapiAdapter = {
  descriptor: metaCapiDescriptor,

  /** POST /{PIXEL_ID}/events. Resending the same event_id is safe: Meta deduplicates on event_name + event_id. */
  async sendEvents(ctx: AdapterContext, events: Array<Record<string, unknown>>): Promise<CapiSendResult> {
    if (!events.length || events.length > 1000) throw new ProviderError('meta_capi', 'send between 1 and 1000 events', false);
    const { token, appSecret } = metaAuth('meta_capi', ctx);
    const testCode = testEventCodeFor(ctx);
    const res = await graphRequest<{ events_received?: number; messages?: unknown[]; fbtrace_id?: string }>('meta_capi', ctx, `${pixelIdOf(ctx)}/events`, {
      method: 'POST', token, appSecret, json: { data: events, ...(testCode ? { test_event_code: testCode } : {}) }, retries: 1, timeoutMs: 10_000,
    });
    if (typeof res.events_received !== 'number') throw new ProviderError('meta_capi', 'unexpected response (no events_received)', true);
    return { eventsReceived: res.events_received, fbtraceId: res.fbtrace_id ?? null, messages: (res.messages ?? []).map((m) => String(m).slice(0, 200)) };
  },

  /** The token can read the Pixel / dataset it will send to. */
  async healthCheck(ctx: AdapterContext) {
    const { token, appSecret } = metaAuth('meta_capi', ctx);
    const id = pixelIdOf(ctx);
    testEventCodeFor(ctx);
    const res = await graphRequest<{ id?: string; name?: string }>('meta_capi', ctx, id, { token, appSecret, query: { fields: 'id,name' }, retries: 1 });
    const ok = res.id === id;
    return { ok, details: { pixelId: id, name: res.name ?? null, testMode: ctx.environment !== 'live' }, account: ok ? { id, name: res.name ?? null } : undefined };
  },
};

/** Connection forms (Integrations): exported through `trackingAdapters` (ads/index.ts) so the catalogue lists the provider. */
