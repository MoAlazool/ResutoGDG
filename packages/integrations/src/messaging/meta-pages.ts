// Facebook Messenger and Instagram Direct through the Messenger Platform with a Page access token (INT-21 / FT-05).
// Docs (checked 2026-10-20; version pin in ../meta/graph.ts):
//   Send API (POST /<PAGE_ID>/messages; messaging_type RESPONSE / UPDATE inside the 24-hour standard messaging window,
//   MESSAGE_TAG with tag HUMAN_AGENT for a person replying within 7 days; response { recipient_id, message_id }):
//     https://developers.facebook.com/docs/messenger-platform/send-messages
//   Quick replies (up to 13, title up to 20 characters): https://developers.facebook.com/docs/messenger-platform/send-messages/quick-replies
//   Button template (web_url):  https://developers.facebook.com/docs/messenger-platform/send-messages/template/button
//   Instagram Messaging via the Page (POST /<PAGE_ID>/messages with the Page token, recipient = IGSID, text at most
//   1,000 bytes, permission instagram_manage_messages): https://developers.facebook.com/docs/messenger-platform/instagram/features/send-message
//   Webhooks (object "page" / "instagram", entry[].messaging[], X-Hub-Signature-256 with the app secret):
//     https://developers.facebook.com/docs/messenger-platform/webhooks
//   Page subscription: POST /<PAGE_ID>/subscribed_apps?subscribed_fields=messages,messaging_postbacks
//     https://developers.facebook.com/docs/graph-api/reference/page/subscribed_apps
// Readiness: implemented_unverified (no Page or Instagram account available). Acceptance checks: ../acceptance/meta.ts.
import { ProviderError, type AdapterContext, type ProviderDescriptor } from '../core';
import { graphRequest, MetaApiError, metaAuth } from '../meta/graph';

export const metaPagesDescriptor: ProviderDescriptor = {
  id: 'meta_pages',
  name: 'Facebook Messenger & Instagram Direct',
  category: 'messaging',
  countries: ['EG', 'SA'],
  authType: 'api_key',
  readiness: 'implemented_unverified',
  docsUrl: 'https://developers.facebook.com/docs/messenger-platform',
  capabilities: ['page_ownership_proof', 'instagram_account_proof', 'webhook_subscription', 'signed_webhooks', 'standard_window_24h', 'human_agent_tag',
    'quick_replies', 'url_button', 'handoff'],
  activation: [
    'Resuto\'s Meta app needs the Messenger and Instagram products, Advanced Access to pages_messaging, pages_manage_metadata, instagram_basic and instagram_manage_messages (App Review), and the human_agent feature for staff replies after 24 hours.',
    'Set META_APP_SECRET and META_WEBHOOK_VERIFY_TOKEN on the API server and register https://<api-host>/v1/webhooks/meta for the "page" (messages, messaging_postbacks) and "instagram" (messages, messaging_postbacks) webhook objects.',
    'In Meta Business Suite, give a system user of the restaurant\'s business access to the Facebook Page (and the linked Instagram professional account), generate a Page access token and paste it here with the Page id (and the Instagram account id for Instagram).',
    'Then add the Messenger or Instagram channel in Inbox > Channels: Resuto proves the token belongs to that Page (and that the Instagram account is linked to it) and subscribes the Page to messages before the channel receives anything.',
  ],
};

export type PageChannelKind = 'messenger' | 'instagram';

/** Logical outbound content (same shape as Connect's OutboundContent). */
export type PageOutbound =
  | { type: 'text'; body: string }
  | { type: 'buttons'; body: string; buttons: Array<{ id: string; title: string }>; header?: string | null }
  | { type: 'list'; body: string; buttonText: string; sections: Array<{ title?: string; rows: Array<{ id: string; title: string; description?: string | null }> }> }
  | { type: 'cta_url'; body: string; displayText: string; url: string }
  | { type: 'location_request'; body: string }
  | { type: 'template'; templateName: string; language: string; params: string[]; body: string };

export const QUICK_REPLY_MAX = 13;
const QUICK_REPLY_TITLE = 20;
const TEXT_MAX: Record<PageChannelKind, number> = { messenger: 2000, instagram: 1000 };

/** Trims to a byte budget (Instagram counts UTF-8 bytes) without splitting a character. */
function clip(text: string, kind: PageChannelKind): string {
  const max = TEXT_MAX[kind];
  if (kind === 'messenger') return text.length > max ? `${text.slice(0, max - 1)}…` : text;
  const enc = new TextEncoder();
  if (enc.encode(text).length <= max) return text;
  let out = '';
  for (const ch of text) { if (enc.encode(`${out}${ch}…`).length > max) break; out += ch; }
  return `${out}…`;
}

const quickReplies = (items: Array<{ id: string; title: string }>) =>
  items.slice(0, QUICK_REPLY_MAX).map((b) => ({ content_type: 'text', title: [...b.title].slice(0, QUICK_REPLY_TITLE).join(''), payload: b.id.slice(0, 1000) }));

export interface PageSendPolicy {
  /** The customer wrote within the last 24 hours (standard messaging window). */
  windowOpen: boolean;
  /** A person (not the bot) is replying, within 7 days of the customer's last message: HUMAN_AGENT tag. */
  humanAgent: boolean;
}

/**
 * Send API body for a logical message. Capabilities differ from WhatsApp: buttons and lists become quick replies (at
 * most 13), a URL becomes a button template on Messenger and a link in the text on Instagram, a location request
 * becomes a plain question (the address is typed), and WhatsApp templates do not exist (outside the window only a
 * person may reply, with the HUMAN_AGENT tag).
 */
export function buildPageMessage(kind: PageChannelKind, recipientId: string, c: PageOutbound, policy: PageSendPolicy): Record<string, unknown> {
  if (c.type === 'template') throw new ProviderError('meta_pages', 'message templates are a WhatsApp feature; Messenger and Instagram use the 24-hour window', false);
  let envelope: Record<string, unknown>;
  if (policy.windowOpen) envelope = { messaging_type: 'RESPONSE' };
  else if (policy.humanAgent) envelope = { messaging_type: 'MESSAGE_TAG', tag: 'HUMAN_AGENT' };
  else throw new ProviderError('meta_pages', 'outside the 24-hour window only a person can reply (HUMAN_AGENT, 7 days)', false);
  let message: Record<string, unknown>;
  switch (c.type) {
    case 'text': case 'location_request':
      message = { text: clip(c.body, kind) };
      break;
    case 'buttons':
      message = { text: clip(c.header ? `${c.header}\n${c.body}` : c.body, kind), quick_replies: quickReplies(c.buttons) };
      break;
    case 'list':
      message = { text: clip(c.body, kind), quick_replies: quickReplies(c.sections.flatMap((s) => s.rows)) };
      break;
    case 'cta_url':
      message = kind === 'messenger'
        ? { attachment: { type: 'template', payload: { template_type: 'button', text: clip(c.body, kind).slice(0, 640),
          buttons: [{ type: 'web_url', url: c.url, title: [...c.displayText].slice(0, 20).join('') }] } } }
        : { text: clip(`${c.body}\n${c.url}`, kind) };
      break;
  }
  return { recipient: { id: recipientId }, ...envelope, message };
}

export interface PageInbound {
  kind: 'message';
  channelKind: PageChannelKind;
  /** entry[].id: the Page id (Messenger) or the Instagram professional account id (Instagram). */
  accountId: string;
  from: string;
  messageId: string;
  type: 'text' | 'button_reply' | 'other';
  text: string | null;
  replyId: string | null;
  timestamp: number | null;
  raw: unknown;
}

/** Parses a verified page / instagram webhook. Echoes of the Page's own messages, reads and deliveries are dropped. */
export function parseMetaPagesWebhook(payload: unknown): PageInbound[] {
  const p = payload as { object?: string; entry?: Array<{ id?: string; messaging?: any[] }> };
  const channelKind: PageChannelKind | null = p?.object === 'page' ? 'messenger' : p?.object === 'instagram' ? 'instagram' : null;
  if (!channelKind || !Array.isArray(p.entry)) return [];
  const out: PageInbound[] = [];
  for (const e of p.entry) {
    const accountId = typeof e?.id === 'string' ? e.id : null;
    if (!accountId || !Array.isArray(e.messaging)) continue;
    for (const m of e.messaging) {
      const from = m?.sender?.id;
      if (typeof from !== 'string' || from === accountId) continue;
      const ts = typeof m.timestamp === 'number' ? m.timestamp : null;
      if (m.message && !m.message.is_echo && typeof m.message.mid === 'string') {
        const qr = typeof m.message.quick_reply?.payload === 'string' ? m.message.quick_reply.payload : null;
        const text = typeof m.message.text === 'string' ? m.message.text : null;
        out.push({ kind: 'message', channelKind, accountId, from, messageId: m.message.mid, type: qr ? 'button_reply' : text ? 'text' : 'other', text, replyId: qr, timestamp: ts, raw: m });
      } else if (m.postback && typeof m.postback.payload === 'string') {
        const mid = typeof m.postback.mid === 'string' ? m.postback.mid : `postback.${accountId}.${from}.${ts ?? 0}`;
        out.push({ kind: 'message', channelKind, accountId, from, messageId: mid, type: 'button_reply', text: typeof m.postback.title === 'string' ? m.postback.title : null,
          replyId: m.postback.payload, timestamp: ts, raw: m });
      }
    }
  }
  return out;
}

export const metaPagesEventKey = (e: PageInbound) => `${e.channelKind}:${e.messageId}`;

export type PageOwnership =
  | { owned: true; page: { id: string; name: string | null }; instagram: { id: string; username: string | null } | null }
  | { owned: false; reason: 'token_not_for_page' | 'instagram_not_linked' | 'no_access' };

export const metaPagesAdapter = {
  descriptor: metaPagesDescriptor,

  /**
   * Proves the token is the Page's own access token (GET /me returns the Page) and, for Instagram, that the Page's
   * linked professional account is the one claimed. Only then may a channel receive that account's messages.
   */
  async verifyOwnership(ctx: AdapterContext, ids: { pageId: string; instagramAccountId?: string | null }): Promise<PageOwnership> {
    const { token, appSecret } = metaAuth('meta_pages', ctx);
    let me: { id?: string; name?: string };
    try { me = await graphRequest('meta_pages', ctx, 'me', { token, appSecret, query: { fields: 'id,name' }, retries: 1 }); }
    catch (e) { if (e instanceof MetaApiError && e.noAccess) return { owned: false, reason: 'no_access' }; throw e; }
    if (me.id !== ids.pageId) return { owned: false, reason: 'token_not_for_page' };
    let instagram: { id: string; username: string | null } | null = null;
    if (ids.instagramAccountId) {
      const r = await graphRequest<{ instagram_business_account?: { id?: string; username?: string } }>('meta_pages', ctx, ids.pageId,
        { token, appSecret, query: { fields: 'instagram_business_account{id,username}' }, retries: 1 });
      if (r.instagram_business_account?.id !== ids.instagramAccountId) return { owned: false, reason: 'instagram_not_linked' };
      instagram = { id: ids.instagramAccountId, username: r.instagram_business_account.username ?? null };
    }
    return { owned: true, page: { id: me.id, name: me.name ?? null }, instagram };
  },

  /** Subscribes Resuto's app to the Page's message webhooks. */
  async subscribeApp(ctx: AdapterContext, pageId: string) {
    const { token, appSecret } = metaAuth('meta_pages', ctx);
    const r = await graphRequest<{ success?: boolean }>('meta_pages', ctx, `${pageId}/subscribed_apps`, {
      method: 'POST', token, appSecret, form: { subscribed_fields: 'messages,messaging_postbacks' }, retries: 1 });
    if (r.success !== true) throw new ProviderError('meta_pages', 'subscription not confirmed', true);
    return true;
  },

  /** POST /<PAGE_ID>/messages (Messenger and Instagram). Throttling and 5xx are retryable; policy errors are not. */
  async send(ctx: AdapterContext, pageId: string, body: Record<string, unknown>): Promise<{ messageId: string }> {
    const { token, appSecret } = metaAuth('meta_pages', ctx);
    const r = await graphRequest<{ message_id?: string; recipient_id?: string }>('meta_pages', ctx, `${pageId}/messages`, { method: 'POST', token, appSecret, json: body });
    if (!r.message_id) throw new ProviderError('meta_pages', 'no message_id in response', true);
    return { messageId: r.message_id };
  },

  async healthCheck(ctx: AdapterContext) {
    const pageId = String(ctx.config.pageId ?? '');
    if (!/^\d{3,30}$/.test(pageId)) throw new ProviderError('meta_pages', 'missing pageId', false);
    const ig = typeof ctx.config.instagramAccountId === 'string' && ctx.config.instagramAccountId ? ctx.config.instagramAccountId : null;
    const own = await metaPagesAdapter.verifyOwnership(ctx, { pageId, instagramAccountId: ig });
    return own.owned
      ? { ok: true, details: { pageId, instagram: own.instagram }, account: { id: own.page.id, name: own.page.name } }
      : { ok: false, details: { pageId, reason: own.reason } };
  },
};
