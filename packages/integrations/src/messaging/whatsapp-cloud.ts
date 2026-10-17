// WhatsApp Business Platform — Cloud API adapter (Meta Graph API).
//
// Written against Meta's official documentation:
//   - Webhooks + X-Hub-Signature-256: https://developers.facebook.com/docs/graph-api/webhooks/getting-started
//   - Webhook payloads (messages, statuses): https://developers.facebook.com/docs/whatsapp/cloud-api/webhooks/components
//   - Send messages: https://developers.facebook.com/docs/whatsapp/cloud-api/reference/messages
//   - Interactive messages (buttons, lists, CTA URL, location request):
//     https://developers.facebook.com/docs/whatsapp/cloud-api/messages/interactive-reply-buttons-messages (and siblings)
//   - Message templates: https://developers.facebook.com/docs/whatsapp/business-management-api/message-templates
//
// Readiness: implemented_unverified. No Meta credentials exist for this
// codebase; it is tested with constructed fixtures and HMAC vectors only.
import { constantTimeEqual, hmacHex, providerRequest, ProviderError, type AdapterContext, type ProviderDescriptor } from '../core';

export const WHATSAPP_GRAPH_VERSION = 'v23.0';
const GRAPH = 'https://graph.facebook.com';

export const whatsappCloudDescriptor: ProviderDescriptor = {
  id: 'whatsapp_cloud',
  name: 'WhatsApp Business (Cloud API)',
  category: 'messaging',
  countries: ['EG', 'SA'],
  authType: 'api_key',
  readiness: 'implemented_unverified',
  docsUrl: 'https://developers.facebook.com/docs/whatsapp/cloud-api',
  capabilities: ['inbound_messages', 'interactive_buttons', 'interactive_lists', 'cta_url', 'location_request', 'templates', 'status_callbacks', 'template_submission'],
  activation: [
    'Create a Meta Business account and a Meta app with the WhatsApp product (developers.facebook.com).',
    'Complete Meta business verification and register the restaurant phone number on a WhatsApp Business Account (WABA).',
    'Create a System User in Business Settings, assign the app and the WABA, and generate a permanent access token with whatsapp_business_messaging and whatsapp_business_management permissions.',
    'Set WHATSAPP_APP_SECRET (the app secret) and WHATSAPP_VERIFY_TOKEN on the Resuto API server.',
    'In the app\'s WhatsApp > Configuration, set the callback URL to https://<api-host>/v1/webhooks/whatsapp with the same verify token and subscribe to the "messages" and "message_template_status_update" fields.',
    'In Resuto > Integrations, connect "WhatsApp Business (Cloud API)" with the access token, phone number id and WABA id, then add a WhatsApp channel in Inbox > Channels.',
    'Submit utility templates (e.g. order_update) for approval; messages outside the 24-hour window can only use approved templates.',
  ],
};

export interface WhatsAppCredentials {
  accessToken: string;
}
export interface WhatsAppConfig {
  phoneNumberId: string;
  wabaId?: string;
  graphVersion?: string;
}

// ---------------------------------------------------------------------------
// Webhook signature + parsing
// ---------------------------------------------------------------------------

/**
 * Verifies `X-Hub-Signature-256: sha256=<hex>` — HMAC-SHA256 of the exact raw
 * request body keyed with the app secret. Must run before JSON parsing.
 */
export function verifyWhatsAppSignature(rawBody: Buffer | string | undefined | null, header: string | string[] | undefined | null, appSecret: string | undefined | null): boolean {
  if (!rawBody || !appSecret) return false;
  const value = Array.isArray(header) ? header[0] : header;
  if (!value || !value.startsWith('sha256=')) return false;
  const expected = `sha256=${hmacHex('sha256', appSecret, rawBody)}`;
  return constantTimeEqual(expected, value.trim().toLowerCase());
}

/** Answers Meta's GET verification handshake; returns the challenge or null. */
export function verifyWebhookSubscription(query: Record<string, unknown>, verifyToken: string | undefined | null): string | null {
  const mode = query['hub.mode'];
  const token = query['hub.verify_token'];
  const challenge = query['hub.challenge'];
  if (!verifyToken || mode !== 'subscribe' || typeof token !== 'string' || typeof challenge !== 'string') return null;
  return constantTimeEqual(token, verifyToken) ? challenge : null;
}

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

function graphUrl(cfg: WhatsAppConfig, path: string) {
  return `${GRAPH}/${cfg.graphVersion ?? WHATSAPP_GRAPH_VERSION}/${path}`;
}

function creds(ctx: AdapterContext): { token: string; cfg: WhatsAppConfig } {
  const token = ctx.credentials.accessToken;
  const cfg = ctx.config as unknown as WhatsAppConfig;
  if (!token) throw new ProviderError('whatsapp_cloud', 'missing access token', false);
  if (!cfg?.phoneNumberId) throw new ProviderError('whatsapp_cloud', 'missing phone number id', false);
  return { token, cfg };
}

export const whatsappCloudAdapter = {
  descriptor: whatsappCloudDescriptor,

  /** Sends a prepared payload; returns the WhatsApp message id (wamid…). */
  async send(ctx: AdapterContext, payload: Record<string, unknown>, opts: { retries?: number } = {}): Promise<{ messageId: string }> {
    const { token, cfg } = creds(ctx);
    const res = await providerRequest<{ messages?: Array<{ id?: string }> }>('whatsapp_cloud', ctx, graphUrl(cfg, `${encodeURIComponent(cfg.phoneNumberId)}/messages`), {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(payload), retries: opts.retries ?? 0,
    });
    const id = res.messages?.[0]?.id;
    if (!id) throw new ProviderError('whatsapp_cloud', 'response did not include a message id', false);
    return { messageId: id };
  },

  /** Reads the phone number object; proves the token and phone number id work together. */
  async healthCheck(ctx: AdapterContext) {
    const { token, cfg } = creds(ctx);
    const res = await providerRequest<{ id?: string; display_phone_number?: string; verified_name?: string; quality_rating?: string }>('whatsapp_cloud', ctx,
      graphUrl(cfg, `${encodeURIComponent(cfg.phoneNumberId)}?fields=display_phone_number,verified_name,quality_rating`),
      { headers: { Authorization: `Bearer ${token}` }, retries: 1 });
    return { ok: res.id === cfg.phoneNumberId, details: { displayPhoneNumber: res.display_phone_number ?? null, verifiedName: res.verified_name ?? null, qualityRating: res.quality_rating ?? null } };
  },

  /** Submits a template for Meta review (POST /{waba-id}/message_templates). */
  async submitTemplate(ctx: AdapterContext, t: { name: string; language: string; category: 'utility' | 'marketing' | 'authentication'; body: string; examples: string[] }) {
    const token = ctx.credentials.accessToken;
    const cfg = ctx.config as unknown as WhatsAppConfig;
    if (!token || !cfg?.wabaId) throw new ProviderError('whatsapp_cloud', 'missing access token or WABA id', false);
    const component: Record<string, unknown> = { type: 'BODY', text: t.body };
    if (t.examples.length) component.example = { body_text: [t.examples] };
    const res = await providerRequest<{ id?: string; status?: string; category?: string }>('whatsapp_cloud', ctx, graphUrl(cfg, `${encodeURIComponent(cfg.wabaId)}/message_templates`), {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: t.name, language: t.language, category: t.category.toUpperCase(), components: [component] }), retries: 1,
    });
    if (!res.id) throw new ProviderError('whatsapp_cloud', 'template submission returned no id', false);
    return { templateId: res.id, status: (res.status ?? 'PENDING').toUpperCase() };
  },
};
