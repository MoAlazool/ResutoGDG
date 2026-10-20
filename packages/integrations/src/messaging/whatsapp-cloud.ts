// WhatsApp Business Platform — Cloud API adapter (Meta Graph API).
//
// Written against Meta's official documentation (checked 2026-10-20):
//   - Webhooks + X-Hub-Signature-256: https://developers.facebook.com/docs/graph-api/webhooks/getting-started
//   - Webhook payloads (messages, statuses): https://developers.facebook.com/docs/whatsapp/cloud-api/webhooks/components
//   - Send messages: https://developers.facebook.com/docs/whatsapp/cloud-api/reference/messages
//   - Interactive messages (buttons, lists, CTA URL, location request):
//     https://developers.facebook.com/docs/whatsapp/cloud-api/messages/interactive-reply-buttons-messages (and siblings)
//   - Message templates: https://developers.facebook.com/docs/whatsapp/business-management-api/message-templates
//   - Phone numbers of a WABA (GET /<WABA_ID>/phone_numbers, GET /<PHONE_NUMBER_ID>):
//     https://developers.facebook.com/documentation/business-messaging/whatsapp/business-phone-numbers/phone-numbers
//   - Embedded Signup v4 + Tech Provider onboarding (code -> business token, POST /<WABA_ID>/subscribed_apps,
//     POST /<PHONE_NUMBER_ID>/register): https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/overview,
//     https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/onboarding-customers-as-a-tech-provider,
//     https://developers.facebook.com/documentation/business-messaging/whatsapp/solution-providers/manage-webhooks
//
// Onboarding model (audit INT-13, docs/INTEGRATION_READINESS.md "WhatsApp onboarding model"): Resuto is a Meta
// Tech Provider and restaurants connect through Embedded Signup with Resuto's platform app, so every webhook is signed
// with the platform app secret. A restaurant may instead connect a Meta app it owns: its connection then carries that
// app's secret and receives webhooks on its own callback URL (/v1/webhooks/whatsapp/c/<connection id>), verified with
// that secret. A phone number is only ever attached to a channel after the connection's token proved, through the
// Graph API, that the number belongs to the WABA (audit INT-03).
//
// Readiness: implemented_unverified. No Meta credentials exist for this codebase; it is tested with constructed
// fixtures and HMAC vectors only. Acceptance checks: packages/integrations/src/acceptance/meta.ts.
import { ProviderError, type AdapterContext, type ProviderDescriptor } from '../core';
import { graphList, graphRequest, MetaApiError, META_GRAPH_VERSION, verifyMetaSignature, verifyMetaSubscription } from '../meta/graph';
import { metaExchangeCode, type MetaApp } from '../meta/oauth';

/** Kept for existing imports; the single pinned version lives in ../meta/graph.ts (INT-12). */
export const WHATSAPP_GRAPH_VERSION = META_GRAPH_VERSION;

export const whatsappCloudDescriptor: ProviderDescriptor = {
  id: 'whatsapp_cloud',
  name: 'WhatsApp Business (Cloud API)',
  category: 'messaging',
  countries: ['EG', 'SA'],
  authType: 'api_key',
  readiness: 'implemented_unverified',
  docsUrl: 'https://developers.facebook.com/docs/whatsapp/cloud-api',
  capabilities: ['embedded_signup', 'phone_ownership_check', 'inbound_messages', 'interactive_buttons', 'interactive_lists', 'cta_url', 'location_request',
    'templates', 'status_callbacks', 'template_submission', 'webhook_subscription'],
  activation: [
    'Recommended: in Inbox > Channels choose "Connect WhatsApp with Meta" and finish Meta\'s Embedded Signup with the restaurant\'s business portfolio and phone number. Resuto verifies the number, subscribes to its webhooks and registers it.',
    'The restaurant adds a payment method to its WhatsApp account in WhatsApp Manager before business-initiated messages can be sent.',
    'Alternative (a Meta app the restaurant owns): create a System User token with whatsapp_business_messaging and whatsapp_business_management, then connect "WhatsApp Business (Cloud API)" in Integrations with the token, phone number id, WABA id and the app secret.',
    'For an own app, set the callback URL shown on the connection (https://<api-host>/v1/webhooks/whatsapp/c/<connection id>) and its verify token in the app\'s WhatsApp > Configuration, and subscribe to "messages" and "message_template_status_update".',
    'Submit utility templates (e.g. order_update) for approval; messages outside the 24-hour window can only use approved templates.',
  ],
};

export interface WhatsAppCredentials {
  accessToken: string;
}
export interface WhatsAppConfig {
  phoneNumberId: string;
  wabaId?: string;
}

// ---------------------------------------------------------------------------
// Webhook signature + parsing
// ---------------------------------------------------------------------------

/** X-Hub-Signature-256 over the raw body with the app secret (shared Meta scheme, ../meta/graph.ts). Run before parsing. */
export const verifyWhatsAppSignature = verifyMetaSignature;

/** Answers Meta's GET verification handshake; returns the challenge or null. */
export const verifyWebhookSubscription = verifyMetaSubscription;

export type WhatsAppInbound =
  | {
      kind: 'message';
      phoneNumberId: string;
      wabaId: string | null;
      from: string;
      contactName: string | null;
      messageId: string;
      timestamp: string;
      type: 'text' | 'button_reply' | 'list_reply' | 'location' | 'button' | 'image' | 'other';
      text: string | null;
      replyId: string | null;
      location: { latitude: number; longitude: number; name: string | null; address: string | null } | null;
      raw: Record<string, unknown>;
    }
  | {
      kind: 'status';
      phoneNumberId: string;
      wabaId: string | null;
      messageId: string;
      status: 'sent' | 'delivered' | 'read' | 'failed';
      recipientId: string | null;
      timestamp: string;
      error: string | null;
    }
  | {
      kind: 'template_status';
      wabaId: string | null;
      templateId: string;
      templateName: string | null;
      language: string | null;
      event: string;
      reason: string | null;
    };

const str = (v: unknown): string | null => (typeof v === 'string' && v.length ? v : null);

/**
 * Normalises a verified webhook payload (object "whatsapp_business_account")
 * into message, status and template-status events. Unknown shapes are ignored.
 */
export function parseWhatsAppWebhook(payload: unknown): WhatsAppInbound[] {
  const out: WhatsAppInbound[] = [];
  const body = payload as { object?: string; entry?: unknown[] };
  if (!body || body.object !== 'whatsapp_business_account' || !Array.isArray(body.entry)) return out;
  for (const entry of body.entry as Array<{ id?: string; changes?: unknown[] }>) {
    const wabaId = str(entry?.id);
    for (const change of (entry?.changes ?? []) as Array<{ field?: string; value?: any }>) {
      const v = change?.value ?? {};
      if (change?.field === 'message_template_status_update') {
        const templateId = v.message_template_id != null ? String(v.message_template_id) : null;
        if (templateId) {
          out.push({ kind: 'template_status', wabaId, templateId, templateName: str(v.message_template_name), language: str(v.message_template_language),
            event: String(v.event ?? 'UNKNOWN'), reason: str(v.reason) });
        }
        continue;
      }
      if (change?.field !== 'messages') continue;
      const phoneNumberId = str(v.metadata?.phone_number_id);
      if (!phoneNumberId) continue;
      const contacts: Array<{ wa_id?: string; profile?: { name?: string } }> = Array.isArray(v.contacts) ? v.contacts : [];
      for (const m of (Array.isArray(v.messages) ? v.messages : []) as any[]) {
        const from = str(m?.from);
        const id = str(m?.id);
        if (!from || !id) continue;
        const contact = contacts.find((c) => c.wa_id === from) ?? contacts[0];
        let type: Extract<WhatsAppInbound, { kind: 'message' }>['type'] = 'other';
        let text: string | null = null;
        let replyId: string | null = null;
        let location: Extract<WhatsAppInbound, { kind: 'message' }>['location'] = null;
        if (m.type === 'text') { type = 'text'; text = str(m.text?.body); }
        else if (m.type === 'interactive' && m.interactive?.type === 'button_reply') {
          type = 'button_reply'; replyId = str(m.interactive.button_reply?.id); text = str(m.interactive.button_reply?.title);
        } else if (m.type === 'interactive' && m.interactive?.type === 'list_reply') {
          type = 'list_reply'; replyId = str(m.interactive.list_reply?.id); text = str(m.interactive.list_reply?.title);
        } else if (m.type === 'button') {
          // Quick-reply button on a template message.
          type = 'button'; replyId = str(m.button?.payload); text = str(m.button?.text);
        } else if (m.type === 'location') {
          const lat = Number(m.location?.latitude), lng = Number(m.location?.longitude);
          if (Number.isFinite(lat) && Number.isFinite(lng)) {
            type = 'location';
            location = { latitude: lat, longitude: lng, name: str(m.location?.name), address: str(m.location?.address) };
          }
        } else if (m.type === 'image') { type = 'image'; text = str(m.image?.caption); }
        out.push({ kind: 'message', phoneNumberId, wabaId, from, contactName: str(contact?.profile?.name), messageId: id,
          timestamp: String(m.timestamp ?? ''), type, text, replyId, location, raw: m });
      }
      for (const s of (Array.isArray(v.statuses) ? v.statuses : []) as any[]) {
        const id = str(s?.id);
        if (!id || !['sent', 'delivered', 'read', 'failed'].includes(s?.status)) continue;
        const err = Array.isArray(s.errors) && s.errors[0] ? `${s.errors[0].code ?? ''} ${s.errors[0].title ?? s.errors[0].message ?? ''}`.trim() : null;
        out.push({ kind: 'status', phoneNumberId, wabaId, messageId: id, status: s.status, recipientId: str(s.recipient_id),
          timestamp: String(s.timestamp ?? ''), error: err });
      }
    }
  }
  return out;
}

/** Deduplication key for webhook_inbox. */
export const whatsappEventKey = (e: WhatsAppInbound) =>
  e.kind === 'message' ? `msg:${e.messageId}` : e.kind === 'status' ? `status:${e.messageId}:${e.status}` : `template:${e.templateId}:${e.event}`;

// ---------------------------------------------------------------------------
// Outbound payloads (POST /{phone-number-id}/messages)
// ---------------------------------------------------------------------------

export interface ReplyButton { id: string; title: string }
export interface ListRow { id: string; title: string; description?: string | null }
export interface ListSection { title: string; rows: ListRow[] }

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const base = (to: string) => ({ messaging_product: 'whatsapp', recipient_type: 'individual', to: to.replace(/^\+/, '') });

export function buildTextMessage(to: string, body: string, previewUrl = false) {
  return { ...base(to), type: 'text', text: { body: clip(body, 4096), preview_url: previewUrl } };
}

/** Up to 3 reply buttons; titles ≤ 20 chars, ids ≤ 256 chars, body ≤ 1024 chars. */
export function buildButtonsMessage(to: string, body: string, buttons: ReplyButton[], header?: string | null) {
  if (buttons.length < 1 || buttons.length > 3) throw new ProviderError('whatsapp_cloud', 'reply buttons must be 1–3', false);
  return {
    ...base(to), type: 'interactive',
    interactive: {
      type: 'button',
      ...(header ? { header: { type: 'text', text: clip(header, 60) } } : {}),
      body: { text: clip(body, 1024) },
      action: { buttons: buttons.map((b) => ({ type: 'reply', reply: { id: b.id.slice(0, 256), title: clip(b.title, 20) } })) },
    },
  };
}

/** List message: ≤ 10 rows in total, row titles ≤ 24, descriptions ≤ 72, button label ≤ 20. */
export function buildListMessage(to: string, body: string, buttonText: string, sections: ListSection[]) {
  const total = sections.reduce((a, s) => a + s.rows.length, 0);
  if (total < 1 || total > 10) throw new ProviderError('whatsapp_cloud', 'list messages need 1–10 rows', false);
  return {
    ...base(to), type: 'interactive',
    interactive: {
      type: 'list',
      body: { text: clip(body, 4096) },
      action: {
        button: clip(buttonText, 20),
        sections: sections.map((s) => ({
          title: clip(s.title, 24),
          rows: s.rows.map((r) => ({ id: r.id.slice(0, 200), title: clip(r.title, 24), ...(r.description ? { description: clip(r.description, 72) } : {}) })),
        })),
      },
    },
  };
}

/** Call-to-action URL button (interactive type "cta_url"). */
export function buildCtaUrlMessage(to: string, body: string, displayText: string, url: string) {
  return {
    ...base(to), type: 'interactive',
    interactive: { type: 'cta_url', body: { text: clip(body, 1024) }, action: { name: 'cta_url', parameters: { display_text: clip(displayText, 20), url } } },
  };
}

/** Asks the customer to share a location pin (interactive type "location_request_message"). */
export function buildLocationRequestMessage(to: string, body: string) {
  return { ...base(to), type: 'interactive', interactive: { type: 'location_request_message', body: { text: clip(body, 1024) }, action: { name: 'send_location' } } };
}

/** Approved template with positional body parameters ({{1}}, {{2}} …). */
export function buildTemplateMessage(to: string, name: string, language: string, bodyParams: string[] = []) {
  return {
    ...base(to), type: 'template',
    template: {
      name, language: { code: language },
      ...(bodyParams.length ? { components: [{ type: 'body', parameters: bodyParams.map((t) => ({ type: 'text', text: t })) }] } : {}),
    },
  };
}

/** Replaces {{1}}…{{n}} with values (used for local rendering and sandbox delivery). */
export function renderTemplateBody(body: string, values: string[]): string {
  return body.replace(/\{\{(\d+)\}\}/g, (_, i: string) => values[Number(i) - 1] ?? '');
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

function creds(ctx: AdapterContext): { token: string; appSecret: string | null; cfg: WhatsAppConfig } {
  const token = ctx.credentials.accessToken;
  const cfg = ctx.config as unknown as WhatsAppConfig;
  if (!token) throw new ProviderError('whatsapp_cloud', 'missing access token', false);
  if (!cfg?.phoneNumberId) throw new ProviderError('whatsapp_cloud', 'missing phone number id', false);
  return { token, appSecret: ctx.credentials.appSecret || null, cfg };
}

const tokenOnly = (ctx: AdapterContext) => {
  const token = ctx.credentials.accessToken;
  if (!token) throw new ProviderError('whatsapp_cloud', 'missing access token', false);
  return { token, appSecret: ctx.credentials.appSecret || null };
};

export interface WhatsAppPhoneNumber { id: string; displayPhoneNumber: string | null; verifiedName: string | null; qualityRating: string | null }

export type PhoneOwnership =
  | { owned: true; phone: WhatsAppPhoneNumber }
  /** not_in_waba: the WABA answered but does not list the number; no_access: the token cannot read the WABA. */
  | { owned: false; reason: 'not_in_waba' | 'no_access'; detail?: string };

const PHONE_FIELDS = 'id,display_phone_number,verified_name,quality_rating';
const toPhone = (p: { id?: string; display_phone_number?: string; verified_name?: string; quality_rating?: string }): WhatsAppPhoneNumber => ({
  id: String(p.id), displayPhoneNumber: p.display_phone_number ?? null, verifiedName: p.verified_name ?? null, qualityRating: p.quality_rating ?? null,
});

export const whatsappCloudAdapter = {
  descriptor: whatsappCloudDescriptor,

  /** Sends a prepared payload; returns the WhatsApp message id (wamid…). */
  async send(ctx: AdapterContext, payload: Record<string, unknown>, opts: { retries?: number } = {}): Promise<{ messageId: string }> {
    const { token, appSecret, cfg } = creds(ctx);
    const res = await graphRequest<{ messages?: Array<{ id?: string }> }>('whatsapp_cloud', ctx, `${encodeURIComponent(cfg.phoneNumberId)}/messages`, {
      method: 'POST', token, appSecret, json: payload, retries: opts.retries ?? 0,
    });
    const id = res.messages?.[0]?.id;
    if (!id) throw new ProviderError('whatsapp_cloud', 'response did not include a message id', false);
    return { messageId: id };
  },

  /**
   * INT-03: proves with the connection's own token that `phoneNumberId` is a number of `wabaId`
   * (GET /<WABA_ID>/phone_numbers, every page). A token that cannot read the WABA, or a WABA that does not list the
   * number, means "not owned". Network errors, throttling and 5xx are thrown: ownership is never assumed.
   */
  async verifyPhoneOwnership(ctx: AdapterContext, ids: { wabaId: string; phoneNumberId: string }): Promise<PhoneOwnership> {
    const { token, appSecret } = tokenOnly(ctx);
    let numbers: Array<{ id?: string; display_phone_number?: string; verified_name?: string; quality_rating?: string }>;
    try {
      numbers = await graphList('whatsapp_cloud', ctx, `${encodeURIComponent(ids.wabaId)}/phone_numbers`,
        { token, appSecret, query: { fields: PHONE_FIELDS, limit: 100 }, retries: 1, maxPages: 20 });
    } catch (e) {
      if (e instanceof MetaApiError && !e.retryable && !e.tokenInvalid && (e.noAccess || e.status === 400 || e.status === 403 || e.status === 404)) {
        return { owned: false, reason: 'no_access', detail: e.code !== null ? `code ${e.code}` : `HTTP ${e.status}` };
      }
      throw e;
    }
    const match = numbers.find((n) => String(n.id) === ids.phoneNumberId);
    return match ? { owned: true, phone: toPhone(match) } : { owned: false, reason: 'not_in_waba' };
  },

  /**
   * Reads the phone number object and, when the WABA is configured, re-proves the number belongs to it, so a health
   * check fails when the number moved or the token lost access to the WABA.
   */
  async healthCheck(ctx: AdapterContext) {
    const { token, appSecret, cfg } = creds(ctx);
    const res = await graphRequest<{ id?: string; display_phone_number?: string; verified_name?: string; quality_rating?: string }>('whatsapp_cloud', ctx,
      encodeURIComponent(cfg.phoneNumberId), { token, appSecret, query: { fields: 'display_phone_number,verified_name,quality_rating' }, retries: 1 });
    const details: Record<string, unknown> = { displayPhoneNumber: res.display_phone_number ?? null, verifiedName: res.verified_name ?? null, qualityRating: res.quality_rating ?? null };
    let ok = res.id === cfg.phoneNumberId;
    if (ok && cfg.wabaId) {
      const own = await whatsappCloudAdapter.verifyPhoneOwnership(ctx, { wabaId: cfg.wabaId, phoneNumberId: cfg.phoneNumberId });
      details.ownership = own.owned ? 'verified' : own.reason;
      ok = own.owned;
    }
    return { ok, details, account: { id: cfg.wabaId ?? null, name: res.verified_name ?? null } };
  },

  /** Submits a template for Meta review (POST /{waba-id}/message_templates). */
  async submitTemplate(ctx: AdapterContext, t: { name: string; language: string; category: 'utility' | 'marketing' | 'authentication'; body: string; examples: string[] }) {
    const token = ctx.credentials.accessToken;
    const cfg = ctx.config as unknown as WhatsAppConfig;
    if (!token || !cfg?.wabaId) throw new ProviderError('whatsapp_cloud', 'missing access token or WABA id', false);
    const component: Record<string, unknown> = { type: 'BODY', text: t.body };
    if (t.examples.length) component.example = { body_text: [t.examples] };
    const res = await graphRequest<{ id?: string; status?: string; category?: string }>('whatsapp_cloud', ctx, `${encodeURIComponent(cfg.wabaId)}/message_templates`, {
      method: 'POST', token, appSecret: ctx.credentials.appSecret || null, retries: 1,
      json: { name: t.name, language: t.language, category: t.category.toUpperCase(), components: [component] },
    });
    if (!res.id) throw new ProviderError('whatsapp_cloud', 'template submission returned no id', false);
    return { templateId: res.id, status: (res.status ?? 'PENDING').toUpperCase() };
  },

  // ---- Embedded Signup / Tech Provider onboarding --------------------------------------------------------------

  /** Embedded Signup: exchanges the 30-second token code for the customer's business token (no redirect_uri). */
  exchangeSignupCode(ctx: Pick<AdapterContext, 'fetch'>, app: MetaApp, code: string) {
    return metaExchangeCode('whatsapp_cloud', ctx, app, code, { withRedirect: false });
  },

  /** POST /<WABA_ID>/subscribed_apps: subscribes the token's app to the WABA's webhooks. */
  async subscribeApp(ctx: AdapterContext, wabaId: string) {
    const { token, appSecret } = tokenOnly(ctx);
    const res = await graphRequest<{ success?: boolean }>('whatsapp_cloud', ctx, `${encodeURIComponent(wabaId)}/subscribed_apps`, { method: 'POST', token, appSecret, retries: 1 });
    if (res.success !== true) throw new ProviderError('whatsapp_cloud', 'webhook subscription was not confirmed', false);
    return { subscribed: true as const };
  },

  /** GET /<WABA_ID>/subscribed_apps: ids of the apps subscribed to the WABA's webhooks. */
  async subscribedApps(ctx: AdapterContext, wabaId: string): Promise<string[]> {
    const { token, appSecret } = tokenOnly(ctx);
    const rows = await graphList<{ whatsapp_business_api_data?: { id?: string }; id?: string }>('whatsapp_cloud', ctx, `${encodeURIComponent(wabaId)}/subscribed_apps`,
      { token, appSecret, retries: 1 });
    return rows.map((r) => String(r.whatsapp_business_api_data?.id ?? r.id ?? '')).filter(Boolean);
  },

  /** DELETE /<WABA_ID>/subscribed_apps: stops this app's webhooks for the WABA (used on disconnect). */
  async unsubscribeApp(ctx: AdapterContext, wabaId: string) {
    const { token, appSecret } = tokenOnly(ctx);
    const res = await graphRequest<{ success?: boolean }>('whatsapp_cloud', ctx, `${encodeURIComponent(wabaId)}/subscribed_apps`, { method: 'DELETE', token, appSecret });
    return res.success === true;
  },

  /**
   * Disconnect: stops webhooks for the WABA (DELETE /<WABA_ID>/subscribed_apps). Meta documents no API that revokes
   * a business token; the business removes the app in Business Settings.
   */
  async revokeAccess(ctx: AdapterContext): Promise<{ attempted: boolean; revoked: boolean; note: string }> {
    const cfg = ctx.config as unknown as WhatsAppConfig;
    if (!cfg?.wabaId || !ctx.credentials.accessToken) return { attempted: false, revoked: false, note: 'Remove the app in Meta Business Settings > Integrations > Connected apps.' };
    try {
      const ok = await whatsappCloudAdapter.unsubscribeApp(ctx, cfg.wabaId);
      return { attempted: true, revoked: ok, note: ok ? 'Webhooks for this WhatsApp account were unsubscribed. Remove the app in Meta Business Settings to revoke its token.'
        : 'Meta did not confirm the webhook unsubscription.' };
    } catch (e) {
      if (e instanceof MetaApiError && (e.tokenInvalid || e.noAccess)) return { attempted: true, revoked: true, note: 'The token no longer has access to this WhatsApp account.' };
      throw e;
    }
  },

  /** POST /<PHONE_NUMBER_ID>/register with a 6-digit two-step verification PIN (required within 14 days of Embedded Signup). */
  async registerPhone(ctx: AdapterContext, phoneNumberId: string, pin: string) {
    if (!/^\d{6}$/.test(pin)) throw new ProviderError('whatsapp_cloud', 'the registration PIN must be 6 digits', false);
    const { token, appSecret } = tokenOnly(ctx);
    const res = await graphRequest<{ success?: boolean }>('whatsapp_cloud', ctx, `${encodeURIComponent(phoneNumberId)}/register`, {
      method: 'POST', token, appSecret, json: { messaging_product: 'whatsapp', pin },
    });
    if (res.success !== true) throw new ProviderError('whatsapp_cloud', 'phone registration was not confirmed', false);
    return { registered: true as const };
  },
};
