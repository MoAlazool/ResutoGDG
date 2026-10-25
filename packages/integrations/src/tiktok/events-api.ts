// TikTok Pixel + Events API 2.0 (INT-23): a second sink of the INT-20 ad-measurement pipeline. Server Purchase events
// for the restaurant's own TikTok Pixel, deduplicated with the browser Pixel through the shared event_id.
//
// Sources (checked 2026-10-21). TikTok's developer portal (business-api.tiktok.com/portal/docs) renders only with
// JavaScript, so the request shape below is taken from TikTok's own open-source server-side GTM template for the Events
// API, which calls the same endpoint:
//   https://github.com/tiktok/gtm-template-eapi (template.tpl: getBody() / send())
//     POST https://business-api.tiktok.com/open_api/v1.3/event/track/   header Access-Token
//     body { event_source: "web", event_source_id: <pixel code>, test_event_code?, data: [{ event, event_time (unix s),
//            event_id, page { url, referrer }, user { email, phone, external_id (SHA-256), ttp, ttclid, ip, user_agent },
//            properties { contents[{content_id, quantity, price}], currency, value } }] }
//     GA4 "purchase" maps to TikTok's standard event "CompletePayment".
//   Pixel base code (ttq, analytics.tiktok.com/i18n/pixel/events.js) and ttq.track(event, params, { event_id }):
//     https://github.com/tiktok/gtm-template-pixel (template.tpl) and the base code shown in TikTok Events Manager.
//   Phone hashing: E.164 with the leading "+" before SHA-256 (as documented for TikTok's web Events API by Adobe's
//     TikTok extension: https://experienceleague.adobe.com/docs/experience-platform/tags/extensions/server/tiktok/overview.html).
//     Not yet confirmed against a TikTok account: listed under "unverified" in docs/INTEGRATION_READINESS.md.
// Readiness: implemented_unverified. Nothing is sent without the restaurant's own Events API token.
import { createHash } from 'node:crypto';
import { ProviderError, type AdapterContext, type HealthCheckResult, type ProviderDescriptor } from '../core';
import { hashEmail, hashExternalId, minorToValue } from '../ads/meta-capi';

export const TIKTOK_EVENTS_URL = 'https://business-api.tiktok.com/open_api/v1.3/event/track/';
export const TIKTOK_PIXEL_SCRIPT = 'https://analytics.tiktok.com/i18n/pixel/events.js';
/** Pixel codes are upper-case alphanumeric ids shown in Events Manager (e.g. "C4ABCDEF1234567890AB"). */
export const TIKTOK_PIXEL_CODE = /^[A-Z0-9]{10,40}$/;
/** Test event codes come from Events Manager > the pixel > Test events (format not documented publicly: kept loose). */
export const TIKTOK_TEST_EVENT_CODE = /^[A-Za-z0-9_-]{4,40}$/;
export const TIKTOK_PURCHASE_EVENT = 'CompletePayment';
/** TikTok, like Meta, attributes server events up to 7 days old; older ones are not sent. */
export const TIKTOK_MAX_AGE_SECONDS = 7 * 24 * 3600;

export const tiktokEventsDescriptor: ProviderDescriptor = {
  id: 'tiktok_events',
  name: 'TikTok Pixel & Events API',
  category: 'ads',
  countries: ['EG', 'SA'],
  authType: 'api_key',
  connectMethod: 'api_key',
  readiness: 'implemented_unverified',
  docsUrl: 'https://ads.tiktok.com/help/article/events-api',
  capabilities: ['browser_pixel_consented', 'server_purchase', 'event_id_dedup', 'hashed_user_data', 'test_event_code', 'outbox_retry'],
  activation: [
    'TikTok Ads Manager > Tools > Events > Web events: create (or pick) the Pixel for the restaurant website and copy its Pixel code.',
    'In the Pixel settings, generate an Events API access token. Paste it here; Resuto stores it sealed and never shows it again.',
    'Copy the Test event code (Events Manager > the Pixel > Test events). Test connections need it; the health check also uses it on live connections, so test events never count as real conversions.',
    'Use "Send test event" and check it appears under Test events, then reconnect the same connection as Live. Guests see the same consent prompt as for Meta; nothing is sent for guests who decline, demo restaurants, or test payments.',
  ],
};

const sha256 = (v: string) => createHash('sha256').update(v, 'utf8').digest('hex');

/** Phone: E.164 with the leading "+" ("+20 100 123 4567" → "+201001234567"), then SHA-256. */
export function hashPhoneE164(phone: string | null | undefined): string | null {
  const digits = (phone ?? '').replace(/\D/g, '').replace(/^0+/, '');
  return digits.length >= 7 && digits.length <= 15 ? sha256(`+${digits}`) : null;
}

/** First-party TikTok browser id (_ttp cookie) and click id (ttclid URL parameter): sent raw, never hashed. */
export const TTP_FORMAT = /^[A-Za-z0-9._-]{8,200}$/;
export const TTCLID_FORMAT = /^[A-Za-z0-9._-]{8,500}$/;

export interface TrackingUserInput {
  email?: string | null; phone?: string | null; externalId?: string | null; country?: string | null;
  clientIp?: string | null; userAgent?: string | null;
  fbp?: string | null; fbc?: string | null; ttp?: string | null; ttclid?: string | null; scid?: string | null; scClickId?: string | null;
}
export interface TrackingPurchaseInput {
  eventId: string;
  eventTime: Date;
  eventSourceUrl: string;
  user: TrackingUserInput;
  custom: { currency: string; valueMinor: number; orderId?: string; contents?: Array<{ id: string; quantity: number; itemPriceMinor?: number }> };
}

export function buildTiktokPurchase(input: TrackingPurchaseInput, now = new Date()): { event: Record<string, unknown> } | { error: string } {
  const age = (now.getTime() - input.eventTime.getTime()) / 1000;
  if (age > TIKTOK_MAX_AGE_SECONDS) return { error: 'event_too_old' };
  if (age < -300) return { error: 'event_in_future' };
  if (!/^[A-Za-z0-9._:-]{1,100}$/.test(input.eventId)) return { error: 'invalid_event_id' };
  if (!/^https:\/\//.test(input.eventSourceUrl)) return { error: 'event_source_url_required' };
  const u = input.user;
  const user: Record<string, unknown> = {};
  const em = hashEmail(u.email); if (em) user.email = em;
  const ph = hashPhoneE164(u.phone); if (ph) user.phone = ph;
  const ex = hashExternalId(u.externalId); if (ex) user.external_id = ex;
  if (u.ttp && TTP_FORMAT.test(u.ttp)) user.ttp = u.ttp;
  if (u.ttclid && TTCLID_FORMAT.test(u.ttclid)) user.ttclid = u.ttclid;
  if (u.clientIp && /^[0-9a-fA-F:.]{3,45}$/.test(u.clientIp)) user.ip = u.clientIp;
  if (u.userAgent) user.user_agent = u.userAgent.slice(0, 500);
  if (!user.user_agent) return { error: 'client_user_agent_required' };
  const c = input.custom;
  const properties: Record<string, unknown> = { currency: c.currency, value: minorToValue(c.valueMinor, c.currency), content_type: 'product' };
  if (c.contents?.length) {
    properties.contents = c.contents.slice(0, 50).map((x) => ({ content_id: x.id, quantity: x.quantity,
      ...(typeof x.itemPriceMinor === 'number' ? { price: minorToValue(x.itemPriceMinor, c.currency) } : {}) }));
  }
  return {
    event: {
      event: TIKTOK_PURCHASE_EVENT, event_time: Math.floor(input.eventTime.getTime() / 1000), event_id: input.eventId,
      page: { url: input.eventSourceUrl }, user, properties,
    },
  };
}

function pixelCodeOf(ctx: AdapterContext): string {
  const code = String(ctx.config.pixelCode ?? '');
  if (!TIKTOK_PIXEL_CODE.test(code)) throw new ProviderError('tiktok_events', 'missing or invalid pixelCode', false);
  return code;
}

/** Test connections must carry the test event code and live ones never send it (same rule as Meta's). */
export function tiktokTestCodeFor(ctx: AdapterContext, opts: { forceTest?: boolean } = {}): string | null {
  const code = typeof ctx.config.testEventCode === 'string' ? ctx.config.testEventCode.trim() : '';
  if (ctx.environment === 'live' && !opts.forceTest) return null;
  if (!TIKTOK_TEST_EVENT_CODE.test(code)) throw new ProviderError('tiktok_events', 'a test event needs the Test event code from TikTok Events Manager', false);
  return code;
}

export interface SinkSendResult { eventsReceived: number; traceId: string | null }

/** TikTok answers HTTP 200 with { code, message, request_id }; code 0 is success. Messages are never stored (they can echo input). */
async function post(ctx: AdapterContext, body: Record<string, unknown>): Promise<SinkSendResult> {
  const token = ctx.credentials.accessToken;
  if (!token) throw new ProviderError('tiktok_events', 'no access token configured', false);
  let res: Response;
  try {
    res = await ctx.fetch(TIKTOK_EVENTS_URL, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Access-Token': token }, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000),
    });
  } catch (e) {
    throw new ProviderError('tiktok_events', `network error (${(e as Error).name})`, true);
  }
  const text = await res.text();
  if (!res.ok) throw new ProviderError('tiktok_events', `HTTP ${res.status}`, res.status === 429 || res.status >= 500, res.status);
  let json: any;
  try { json = JSON.parse(text); } catch { throw new ProviderError('tiktok_events', 'non-JSON response', true); }
  const code = Number(json?.code);
  if (!Number.isFinite(code)) throw new ProviderError('tiktok_events', 'unexpected response (no code)', true);
  // Assumption (TikTok "return codes" page is JS-only): 4xxxx = request/permission errors (not retried) except the
  // documented rate limit 40100; 5xxxx = TikTok-side errors (retried).
  if (code !== 0) throw new ProviderError('tiktok_events', `rejected (code ${code})`, code === 40100 || code >= 50000);
  const requestId = typeof json.request_id === 'string' ? json.request_id.slice(0, 100) : null;
  return { eventsReceived: Array.isArray(body.data) ? body.data.length : 0, traceId: requestId };
}

export const tiktokEventsAdapter = {
  descriptor: tiktokEventsDescriptor,
  purchaseEventName: TIKTOK_PURCHASE_EVENT,

  async sendEvents(ctx: AdapterContext, events: Array<Record<string, unknown>>, opts: { forceTest?: boolean } = {}): Promise<SinkSendResult> {
    if (!events.length || events.length > 1000) throw new ProviderError('tiktok_events', 'send between 1 and 1000 events', false);
    const testCode = tiktokTestCodeFor(ctx, opts);
    return post(ctx, { event_source: 'web', event_source_id: pixelCodeOf(ctx), ...(testCode ? { test_event_code: testCode } : {}), data: events });
  },

  /**
   * No read-only endpoint accepts an Events API token, so the check sends ONE synthetic event with the Test event code
   * (on live connections too): it proves the token and pixel code without counting as a conversion.
   */
  async healthCheck(ctx: AdapterContext): Promise<HealthCheckResult> {
    const code = pixelCodeOf(ctx);
    const event = { event: 'ViewContent', event_time: Math.floor(Date.now() / 1000), event_id: `health.${Date.now()}`,
      page: { url: 'https://resuto.app/tiktok-health-check' }, user: { ip: '203.0.113.10', user_agent: 'Resuto TikTok Events API health check' }, properties: {} };
    const r = await this.sendEvents(ctx, [event], { forceTest: true });
    return { ok: true, details: { pixelCode: code, testEvent: true, requestId: r.traceId } };
  },
};
