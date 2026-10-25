// Snap Pixel + Conversions API v3 (INT-23): a third sink of the INT-20 ad-measurement pipeline. Server PURCHASE events
// for the restaurant's own Snap Pixel, deduplicated with the browser Pixel (Pixel client_dedup_id = CAPI event_id;
// transaction_id = custom_data.order_id as the 30-day fallback pair).
//
// Docs (checked 2026-10-21):
//   Using the API: POST https://tr.snapchat.com/v3/{PIXEL_ID}/events?access_token={TOKEN}; validation: same path + /validate;
//     body { data: [{ event_name, event_time, event_id, action_source: "WEB", event_source_url, user_data, custom_data }] };
//     response { status: "VALID", reason }; em / ph are arrays of SHA-256 strings.
//     https://developers.snap.com/api/marketing-api/Conversions-API/UsingTheAPI
//   Parameters: em = trim + lowercase then SHA-256; ph = country code, no leading zeros, digits only (no "+") then SHA-256;
//     client_ip_address / client_user_agent / sc_click_id (ScCid URL parameter) / sc_cookie1 (_scid cookie) never hashed;
//     event_time epoch (seconds or ms), at most 7 days old; PURCHASE needs value + currency; order_id; num_items is a string;
//     test_event_code (server parameter).  https://developers.snap.com/api/marketing-api/Conversions-API/Parameters
//   Deduplication: https://developers.snap.com/api/marketing-api/Conversions-API/Deduplication
//   Tokens: static Conversions API token from Ads Manager > Business Details (Organization Admin).
//     https://developers.snap.com/api/marketing-api/Conversions-API/GetStarted
// The access token travels in the query string (Snap's documented form), so request URLs are never logged or stored.
// Readiness: implemented_unverified.
import { ProviderError, type AdapterContext, type HealthCheckResult, type ProviderDescriptor } from '../core';
import { hashEmail, hashPhone, minorToValue } from '../ads/meta-capi';
import type { SinkSendResult, TrackingPurchaseInput } from '../tiktok/events-api';

export const SNAP_CAPI_BASE = 'https://tr.snapchat.com/v3';
export const SNAP_PIXEL_SCRIPT = 'https://sc-static.net/scevent.min.js';
/** Snap Pixel ids are UUIDs. */
export const SNAP_PIXEL_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const SNAP_PURCHASE_EVENT = 'PURCHASE';
export const SNAP_MAX_AGE_SECONDS = 7 * 24 * 3600;
/** _scid cookie and ScCid click id: sent raw. */
export const SCID_FORMAT = /^[A-Za-z0-9-]{8,100}$/;
export const SC_CLICK_ID_FORMAT = /^[A-Za-z0-9._-]{8,500}$/;

export const snapCapiDescriptor: ProviderDescriptor = {
  id: 'snap_capi',
  name: 'Snap Pixel & Conversions API',
  category: 'ads',
  countries: ['EG', 'SA'],
  authType: 'api_key',
  connectMethod: 'api_key',
  readiness: 'implemented_unverified',
  docsUrl: 'https://developers.snap.com/api/marketing-api/Conversions-API',
  capabilities: ['browser_pixel_consented', 'server_purchase', 'event_id_dedup', 'hashed_user_data', 'validate_endpoint', 'outbox_retry'],
  activation: [
    'Snapchat Ads Manager > Events Manager: create (or pick) the Snap Pixel for the restaurant website and copy its Pixel id.',
    'Ads Manager > Business Details > Conversions API Tokens > Generate Token (Organization Admin). Paste it here; Resuto stores it sealed.',
    'A TEST connection sends events to Snap\'s /validate endpoint only (checked, not recorded). Use "Send test event", then reconnect the same connection as Live.',
    'Guests see the same consent prompt as for Meta; nothing is sent for guests who decline, demo restaurants, or test payments.',
  ],
};

export function buildSnapPurchase(input: TrackingPurchaseInput, now = new Date()): { event: Record<string, unknown> } | { error: string } {
  const age = (now.getTime() - input.eventTime.getTime()) / 1000;
  if (age > SNAP_MAX_AGE_SECONDS) return { error: 'event_too_old' };
  if (age < -300) return { error: 'event_in_future' };
  if (!/^[A-Za-z0-9._:-]{1,100}$/.test(input.eventId)) return { error: 'invalid_event_id' };
  if (!/^https:\/\//.test(input.eventSourceUrl)) return { error: 'event_source_url_required' };
  const u = input.user;
  const user_data: Record<string, unknown> = {};
  const em = hashEmail(u.email); if (em) user_data.em = [em];
  const ph = hashPhone(u.phone); if (ph) user_data.ph = [ph];
  if (u.clientIp && /^[0-9a-fA-F:.]{3,45}$/.test(u.clientIp)) user_data.client_ip_address = u.clientIp;
  if (u.userAgent) user_data.client_user_agent = u.userAgent.slice(0, 500);
  if (u.scClickId && SC_CLICK_ID_FORMAT.test(u.scClickId)) user_data.sc_click_id = u.scClickId;
  if (u.scid && SCID_FORMAT.test(u.scid)) user_data.sc_cookie1 = u.scid;
  if (!user_data.client_user_agent) return { error: 'client_user_agent_required' };
  const c = input.custom;
  const custom_data: Record<string, unknown> = { currency: c.currency, value: minorToValue(c.valueMinor, c.currency) };
  if (c.orderId) custom_data.order_id = c.orderId;
  if (c.contents?.length) {
    custom_data.contents = c.contents.slice(0, 50).map((x) => ({ id: x.id, quantity: x.quantity,
      ...(typeof x.itemPriceMinor === 'number' ? { item_price: minorToValue(x.itemPriceMinor, c.currency) } : {}) }));
    custom_data.num_items = String(c.contents.reduce((s, x) => s + x.quantity, 0));
  }
  return {
    event: {
      event_name: SNAP_PURCHASE_EVENT, event_time: Math.floor(input.eventTime.getTime() / 1000), event_id: input.eventId,
      action_source: 'WEB', event_source_url: input.eventSourceUrl, user_data, custom_data,
    },
  };
}

function pixelIdOf(ctx: AdapterContext): string {
  const id = String(ctx.config.pixelId ?? '');
  if (!SNAP_PIXEL_ID.test(id)) throw new ProviderError('snap_capi', 'missing or invalid pixelId', false);
  return id.toLowerCase();
}

async function post(ctx: AdapterContext, validate: boolean, events: Array<Record<string, unknown>>): Promise<SinkSendResult> {
  const token = ctx.credentials.accessToken;
  if (!token) throw new ProviderError('snap_capi', 'no access token configured', false);
  const testCode = typeof ctx.config.testEventCode === 'string' && ctx.config.testEventCode.trim() && ctx.environment !== 'live' ? ctx.config.testEventCode.trim().slice(0, 60) : null;
  const url = `${SNAP_CAPI_BASE}/${encodeURIComponent(pixelIdOf(ctx))}/events${validate ? '/validate' : ''}?access_token=${encodeURIComponent(token)}`;
  let res: Response;
  try {
    res = await ctx.fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: events, ...(testCode ? { test_event_code: testCode } : {}) }), signal: AbortSignal.timeout(10_000),
    });
  } catch (e) {
    // e.message could contain the URL (and so the token): only the error class is kept.
    throw new ProviderError('snap_capi', `network error (${(e as Error).name})`, true);
  }
  const text = await res.text();
  if (!res.ok) throw new ProviderError('snap_capi', `HTTP ${res.status}`, res.status === 429 || res.status >= 500, res.status);
  let json: any;
  try { json = JSON.parse(text || '{}'); } catch { throw new ProviderError('snap_capi', 'non-JSON response', true); }
  const status = typeof json?.status === 'string' ? json.status.toUpperCase() : '';
  if (status !== 'VALID') throw new ProviderError('snap_capi', `rejected (status ${status.slice(0, 20) || 'unknown'})`, false);
  return { eventsReceived: events.length, traceId: null };
}

export const snapCapiAdapter = {
  descriptor: snapCapiDescriptor,
  purchaseEventName: SNAP_PURCHASE_EVENT,

  /** Live connections record events; test connections only call /validate (nothing is recorded). */
  async sendEvents(ctx: AdapterContext, events: Array<Record<string, unknown>>): Promise<SinkSendResult> {
    if (!events.length || events.length > 2000) throw new ProviderError('snap_capi', 'send between 1 and 2000 events', false);
    return post(ctx, ctx.environment !== 'live', events);
  },

  /** One synthetic PAGE_VIEW to /validate: proves the token and pixel without recording anything. */
  async healthCheck(ctx: AdapterContext): Promise<HealthCheckResult> {
    const id = pixelIdOf(ctx);
    await post(ctx, true, [{ event_name: 'PAGE_VIEW', event_time: Math.floor(Date.now() / 1000), event_id: `health.${Date.now()}`, action_source: 'WEB',
      event_source_url: 'https://resuto.app/snap-health-check', user_data: { client_ip_address: '203.0.113.10', client_user_agent: 'Resuto Snap CAPI health check' } }]);
    return { ok: true, details: { pixelId: id, validated: true } };
  },
};
