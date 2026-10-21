// Notification channels (INT-28 / FT-27): one adapter interface for transactional and marketing email, SMS and push.
// Every adapter talks to the RESTAURANT'S OWN provider account (BYOK: Resend, Twilio; Web Push needs no account), is
// credential-gated (no credentials → the API records "not configured" and sends nothing) and returns the provider's
// message id only after the provider accepted the message. Delivery status changes arrive by signed webhook.
//
// Sources (checked 2026-10-21):
//   Resend send email: POST https://api.resend.com/emails, "Authorization: Bearer re_…", { from, to, subject, text,
//     html, headers, tags }, Idempotency-Key header (≤ 256 chars, 24 h) → { id }:
//     https://resend.com/docs/api-reference/emails/send-email
//   Resend webhooks are signed by Svix (svix-id / svix-timestamp / svix-signature, HMAC-SHA256 over
//     "<id>.<timestamp>.<raw body>" with the base64 part of the whsec_ secret, "v1,<base64>" entries):
//     https://resend.com/docs/dashboard/webhooks/verify-webhooks-requests · https://docs.svix.com/receiving/verifying-payloads/how-manual
//     Event types email.sent / delivered / delivery_delayed / bounced / complained / failed / suppressed …, payload
//     { type, created_at, data: { email_id, to[], … } }: https://resend.com/docs/dashboard/webhooks/event-types
//   Twilio Messages: POST https://api.twilio.com/2010-04-01/Accounts/{AccountSid}/Messages.json (form: To, From |
//     MessagingServiceSid, Body ≤ 1600 chars, StatusCallback), HTTP Basic (Account SID + Auth Token, or API key + secret)
//     → { sid, status, error_code }: https://www.twilio.com/docs/messaging/api/message-resource
//   Twilio webhook signature: X-Twilio-Signature = Base64(HMAC-SHA1(auth token, full URL + sorted POST params as
//     key+value)): https://www.twilio.com/docs/usage/webhooks/webhooks-security (matches Twilio's published example).
// Marketing mail carries List-Unsubscribe + List-Unsubscribe-Post (RFC 8058 one-click) and an unsubscribe link.
import { createHmac } from 'node:crypto';
import { constantTimeEqual, ProviderError, type AdapterContext, type HealthCheckResult, type ProviderDescriptor } from '../core';

export type NotificationChannelKind = 'email' | 'sms' | 'push';
export type DeliveryStatus = 'accepted' | 'queued' | 'sent' | 'delivered' | 'failed' | 'bounced' | 'complained' | 'undelivered';

export interface OutboundMessage {
  /** Email address, E.164 phone, or (push) the subscription JSON. */
  to: string;
  subject?: string;
  text: string;
  html?: string | null;
  /** Stable per logical message: retries reuse it (provider-side idempotency where the provider supports it). */
  idempotencyKey: string;
  /** Marketing messages: one-click unsubscribe target (List-Unsubscribe for email; appended to SMS text by the caller). */
  unsubscribeUrl?: string | null;
  /** Provider status callback for this message (Twilio StatusCallback). */
  statusCallbackUrl?: string | null;
  tags?: Record<string, string>;
}

export interface SendResult { providerMessageId: string; status: DeliveryStatus }

export interface NotificationChannelAdapter {
  readonly descriptor: ProviderDescriptor;
  readonly channel: NotificationChannelKind;
  readonly requiredCredentials: readonly string[];
  send(ctx: AdapterContext, msg: OutboundMessage): Promise<SendResult>;
  healthCheck?(ctx: AdapterContext): Promise<HealthCheckResult>;
}

/** A verified status update from a provider webhook. */
export interface StatusUpdate { providerMessageId: string; status: DeliveryStatus; errorCode?: string | null; at?: string | null }

const EMAIL = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/;
const E164 = /^\+[1-9]\d{6,14}$/;
export const isEmailAddress = (v: string) => EMAIL.test(v) && v.length <= 254;
export const isE164 = (v: string) => E164.test(v);

// ---------------------------------------------------------------------------
// Resend (transactional + marketing email)
// ---------------------------------------------------------------------------
export const RESEND_API = 'https://api.resend.com';

export const resendDescriptor: ProviderDescriptor = {
  id: 'resend', name: 'Resend (email)', category: 'messaging', countries: ['EG', 'SA'], authType: 'api_key', readiness: 'implemented_unverified',
  docsUrl: 'https://resend.com/docs/api-reference/emails/send-email',
  capabilities: ['email_transactional', 'email_marketing', 'list_unsubscribe', 'delivery_webhook', 'idempotent_send'],
  activation: [
    'Create a Resend account for the restaurant and verify its sending domain (DNS records) in Resend → Domains.',
    'Create an API key with "Sending access" and paste it here, with the From address on that domain (e.g. "Olive Room <hello@olive.example>").',
    'Optional: Resend → Webhooks → add the webhook URL shown on this connection for email.* events and paste its signing secret (whsec_…) to track delivered / bounced / complained.',
    'Marketing email goes only to customers who consented; every message has an unsubscribe link and one-click unsubscribe headers.',
  ],
};

function resendKey(ctx: AdapterContext) {
  const k = ctx.credentials.apiKey;
  if (!k) throw new ProviderError('resend', 'apiKey is not configured', false);
  return k;
}

export const resendAdapter: NotificationChannelAdapter = {
  descriptor: resendDescriptor,
  channel: 'email',
  requiredCredentials: ['apiKey'],
  async send(ctx, msg) {
    const apiKey = resendKey(ctx);
    const from = typeof ctx.config.from === 'string' ? ctx.config.from.trim() : '';
    if (!from) throw new ProviderError('resend', 'Set the From address', false);
    if (!isEmailAddress(msg.to)) throw new ProviderError('resend', 'invalid recipient address', false);
    if (!msg.subject) throw new ProviderError('resend', 'subject required', false);
    const headers: Record<string, string> = {};
    if (msg.unsubscribeUrl) { headers['List-Unsubscribe'] = `<${msg.unsubscribeUrl}>`; headers['List-Unsubscribe-Post'] = 'List-Unsubscribe=One-Click'; }
    const body = {
      from, to: [msg.to], subject: msg.subject.slice(0, 250), text: msg.text, ...(msg.html ? { html: msg.html } : {}),
      ...(Object.keys(headers).length ? { headers } : {}),
      ...(typeof ctx.config.replyTo === 'string' && ctx.config.replyTo ? { reply_to: ctx.config.replyTo } : {}),
      ...(msg.tags ? { tags: Object.entries(msg.tags).map(([name, value]) => ({ name, value })) } : {}),
    };
    let res: Response;
    try {
      res = await ctx.fetch(`${RESEND_API}/emails`, {
        method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'Idempotency-Key': msg.idempotencyKey.slice(0, 256) },
        body: JSON.stringify(body), signal: AbortSignal.timeout(15_000),
      });
    } catch (e) {
      throw new ProviderError('resend', `network error (${(e as Error).name})`, true);
    }
    const text = await res.text();
    if (!res.ok) throw new ProviderError('resend', `HTTP ${res.status}`, res.status === 429 || res.status >= 500, res.status);
    let json: any;
    try { json = JSON.parse(text); } catch { throw new ProviderError('resend', 'non-JSON response', true); }
    if (typeof json?.id !== 'string') throw new ProviderError('resend', 'unexpected response (no id)', false);
    return { providerMessageId: json.id, status: 'accepted' };
  },
  /** Lists sending domains: proves the key works without sending anything (a sending-only key answers 401, reported as such). */
  async healthCheck(ctx) {
    const res = await ctx.fetch(`${RESEND_API}/domains`, { headers: { Authorization: `Bearer ${resendKey(ctx)}` }, signal: AbortSignal.timeout(10_000) });
    await res.text().catch(() => '');
    if (res.status === 401 || res.status === 403) {
      // Resend's sending-only keys cannot list domains; the key may still send. Report honestly instead of guessing.
      return { ok: false, details: { reason: 'key_cannot_list_domains', status: res.status } };
    }
    if (!res.ok) throw new ProviderError('resend', `HTTP ${res.status}`, res.status >= 500, res.status);
    return { ok: true, details: { from: ctx.config.from ?? null } };
  },
};

/** Svix-signed Resend webhook → status update. Fails closed: any missing piece, bad signature or old timestamp is refused. */
export function verifyResendWebhook(input: { secret: string | undefined; headers: Record<string, string | string[] | undefined>; rawBody: string; nowSeconds?: number; toleranceSeconds?: number })
  : { valid: true; update: StatusUpdate | null; eventKey: string } | { valid: false; reason: string } {
  const h = (k: string) => { const v = input.headers[k]; return Array.isArray(v) ? v[0] : v; };
  const id = h('svix-id'); const ts = h('svix-timestamp'); const sig = h('svix-signature');
  if (!input.secret || !/^whsec_[A-Za-z0-9+/=]{8,}$/.test(input.secret)) return { valid: false, reason: 'not_configured' };
  if (!id || !ts || !sig || !/^\d{9,11}$/.test(ts)) return { valid: false, reason: 'missing_headers' };
  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - Number(ts)) > (input.toleranceSeconds ?? 300)) return { valid: false, reason: 'stale' };
  const key = Buffer.from(input.secret.slice('whsec_'.length), 'base64');
  const expected = createHmac('sha256', key).update(`${id}.${ts}.${input.rawBody}`).digest('base64');
  const ok = sig.split(' ').some((part) => { const [v, s] = part.split(','); return v === 'v1' && !!s && constantTimeEqual(s, expected); });
  if (!ok) return { valid: false, reason: 'bad_signature' };
  let body: any;
  try { body = JSON.parse(input.rawBody); } catch { return { valid: false, reason: 'bad_payload' }; }
  const map: Record<string, DeliveryStatus> = {
    'email.sent': 'sent', 'email.delivered': 'delivered', 'email.bounced': 'bounced', 'email.complained': 'complained', 'email.failed': 'failed',
    'email.suppressed': 'failed',
  };
  const status = map[String(body?.type)];
  const emailId = typeof body?.data?.email_id === 'string' ? body.data.email_id : null;
  return { valid: true, eventKey: `resend:${id}`, update: status && emailId ? { providerMessageId: emailId, status, at: typeof body.created_at === 'string' ? body.created_at : null } : null };
}

// ---------------------------------------------------------------------------
// Twilio Programmable Messaging (SMS, KSA/EG sender rules apply)
// ---------------------------------------------------------------------------
export const TWILIO_API = 'https://api.twilio.com/2010-04-01';

export const twilioSmsDescriptor: ProviderDescriptor = {
  id: 'twilio_sms', name: 'Twilio SMS', category: 'messaging', countries: ['EG', 'SA'], authType: 'api_key', readiness: 'implemented_unverified',
  docsUrl: 'https://www.twilio.com/docs/messaging/api/message-resource',
  capabilities: ['sms_transactional', 'sms_marketing', 'delivery_webhook'],
  activation: [
    'Use the restaurant\'s own Twilio account. Saudi Arabia and Egypt require a registered alphanumeric Sender ID (or a Messaging Service with one); register it in the Twilio console before sending.',
    'Paste the Account SID and Auth Token (or an API key SID + secret with the Account SID), and either the From sender or a Messaging Service SID.',
    'Resuto sets the status callback for every message (signed with your Auth Token) so delivered / undelivered is tracked.',
    'Marketing SMS go only to customers who consented, outside quiet hours, with an opt-out link.',
  ],
};

function twilioAuth(ctx: AdapterContext) {
  const sid = ctx.credentials.accountSid;
  if (!sid || !/^AC[0-9a-f]{32}$/i.test(sid)) throw new ProviderError('twilio_sms', 'accountSid (AC…) is not configured', false);
  const user = ctx.credentials.apiKeySid || sid;
  const secret = ctx.credentials.apiKeySid ? ctx.credentials.apiKeySecret : ctx.credentials.authToken;
  if (!secret) throw new ProviderError('twilio_sms', 'authToken (or API key secret) is not configured', false);
  return { sid, header: `Basic ${Buffer.from(`${user}:${secret}`).toString('base64')}` };
}

const TWILIO_STATUS: Record<string, DeliveryStatus> = {
  accepted: 'accepted', scheduled: 'queued', queued: 'queued', sending: 'queued', sent: 'sent', delivered: 'delivered', undelivered: 'undelivered', failed: 'failed', read: 'delivered',
};

export const twilioSmsAdapter: NotificationChannelAdapter = {
  descriptor: twilioSmsDescriptor,
  channel: 'sms',
  requiredCredentials: ['accountSid', 'authToken'],
  async send(ctx, msg) {
    const { sid, header } = twilioAuth(ctx);
    if (!isE164(msg.to)) throw new ProviderError('twilio_sms', 'invalid recipient number (E.164 required)', false);
    const form = new URLSearchParams({ To: msg.to, Body: msg.text.slice(0, 1600) });
    const service = typeof ctx.config.messagingServiceSid === 'string' && ctx.config.messagingServiceSid ? ctx.config.messagingServiceSid : null;
    const from = typeof ctx.config.from === 'string' && ctx.config.from ? ctx.config.from : null;
    if (service) form.set('MessagingServiceSid', service); else if (from) form.set('From', from);
    else throw new ProviderError('twilio_sms', 'Set the From sender or a Messaging Service SID', false);
    if (msg.statusCallbackUrl) form.set('StatusCallback', msg.statusCallbackUrl);
    let res: Response;
    try {
      res = await ctx.fetch(`${TWILIO_API}/Accounts/${encodeURIComponent(sid)}/Messages.json`, {
        method: 'POST', headers: { Authorization: header, 'Content-Type': 'application/x-www-form-urlencoded' }, body: form.toString(), signal: AbortSignal.timeout(15_000),
      });
    } catch (e) {
      throw new ProviderError('twilio_sms', `network error (${(e as Error).name})`, true);
    }
    const text = await res.text();
    if (!res.ok) {
      let code: string | null = null;
      try { const j = JSON.parse(text); code = typeof j?.code === 'number' ? String(j.code) : null; } catch { /* ignore */ }
      throw new ProviderError('twilio_sms', `HTTP ${res.status}${code ? ` (Twilio ${code})` : ''}`, res.status === 429 || res.status >= 500, res.status);
    }
    let json: any;
    try { json = JSON.parse(text); } catch { throw new ProviderError('twilio_sms', 'non-JSON response', true); }
    if (typeof json?.sid !== 'string') throw new ProviderError('twilio_sms', 'unexpected response (no sid)', false);
    const status = TWILIO_STATUS[String(json.status)] ?? 'queued';
    if (status === 'failed' || status === 'undelivered') throw new ProviderError('twilio_sms', `rejected (status ${json.status}${json.error_code ? `, ${json.error_code}` : ''})`, false);
    return { providerMessageId: json.sid, status };
  },
  /** GET the account: proves the credentials without sending anything. */
  async healthCheck(ctx) {
    const { sid, header } = twilioAuth(ctx);
    const res = await ctx.fetch(`${TWILIO_API}/Accounts/${encodeURIComponent(sid)}.json`, { headers: { Authorization: header }, signal: AbortSignal.timeout(10_000) });
    const text = await res.text();
    if (!res.ok) throw new ProviderError('twilio_sms', `HTTP ${res.status}`, res.status >= 500, res.status);
    let j: any = {};
    try { j = JSON.parse(text); } catch { /* ignore */ }
    return { ok: j?.status === 'active', details: { status: j?.status ?? null, type: j?.type ?? null }, account: { id: sid, name: j?.friendly_name ?? null } };
  },
};

/** X-Twilio-Signature check (form-encoded status callbacks). `url` must be exactly the URL Twilio called. */
export function twilioSignature(authToken: string, url: string, params: Record<string, string>): string {
  const data = url + Object.keys(params).sort().map((k) => `${k}${params[k]}`).join('');
  return createHmac('sha1', authToken).update(data, 'utf8').digest('base64');
}

export function verifyTwilioStatusCallback(input: { authToken: string | undefined; url: string; params: Record<string, string>; signature: string | undefined })
  : { valid: true; update: StatusUpdate | null } | { valid: false; reason: string } {
  if (!input.authToken) return { valid: false, reason: 'not_configured' };
  if (!input.signature) return { valid: false, reason: 'missing_signature' };
  if (!constantTimeEqual(input.signature, twilioSignature(input.authToken, input.url, input.params))) return { valid: false, reason: 'bad_signature' };
  const sid = input.params.MessageSid ?? input.params.SmsSid;
  const status = TWILIO_STATUS[String(input.params.MessageStatus ?? input.params.SmsStatus)];
  return { valid: true, update: sid && status ? { providerMessageId: sid, status, errorCode: input.params.ErrorCode ?? null } : null };
}

export const notificationAdapters = [resendAdapter, twilioSmsAdapter] as const;
export const notificationAdapterFor = (provider: string): NotificationChannelAdapter | null =>
  (notificationAdapters as readonly NotificationChannelAdapter[]).find((a) => a.descriptor.id === provider) ?? null;
