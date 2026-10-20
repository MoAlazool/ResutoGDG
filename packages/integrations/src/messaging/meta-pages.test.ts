import { describe, expect, it } from 'vitest';
import { buildPageMessage, metaPagesAdapter, metaPagesEventKey, parseMetaPagesWebhook } from './meta-pages';
import { scriptedFetch } from './testing/scripted-fetch';

const ctx = (fetch: typeof globalThis.fetch, config: Record<string, unknown> = { pageId: '1111111111' }) =>
  ({ environment: 'live' as const, credentials: { accessToken: 'EAAPage-token-123' }, config, fetch });
const open = { windowOpen: true, humanAgent: false };

describe('Send API bodies (capabilities differ from WhatsApp)', () => {
  it('replies inside the window as RESPONSE; buttons and list rows become at most 13 quick replies with 20-character titles', () => {
    const b = buildPageMessage('messenger', 'PSID1', { type: 'buttons', body: 'Pickup or delivery?', buttons: [{ id: 'f:pickup', title: 'Pickup at the branch please' }, { id: 'f:delivery', title: 'Delivery' }] }, open);
    expect(b).toEqual({ recipient: { id: 'PSID1' }, messaging_type: 'RESPONSE', message: { text: 'Pickup or delivery?',
      quick_replies: [{ content_type: 'text', title: 'Pickup at the branch', payload: 'f:pickup' }, { content_type: 'text', title: 'Delivery', payload: 'f:delivery' }] } });
    const rows = Array.from({ length: 20 }, (_, i) => ({ id: `b:${i}`, title: `Branch ${i}` }));
    const l = buildPageMessage('instagram', 'IGSID', { type: 'list', body: 'Choose a branch', buttonText: 'Branches', sections: [{ rows }] }, open) as any;
    expect(l.message.quick_replies).toHaveLength(13);
  });

  it('a URL is a button template on Messenger and a link in the text on Instagram; a location request is a typed question', () => {
    const m = buildPageMessage('messenger', 'P', { type: 'cta_url', body: 'Open the menu', displayText: 'Menu', url: 'https://app.test/o/tok' }, open) as any;
    expect(m.message.attachment).toEqual({ type: 'template', payload: { template_type: 'button', text: 'Open the menu', buttons: [{ type: 'web_url', url: 'https://app.test/o/tok', title: 'Menu' }] } });
    const i = buildPageMessage('instagram', 'I', { type: 'cta_url', body: 'Open the menu', displayText: 'Menu', url: 'https://app.test/o/tok' }, open) as any;
    expect(i.message).toEqual({ text: 'Open the menu\nhttps://app.test/o/tok' });
    expect((buildPageMessage('instagram', 'I', { type: 'location_request', body: 'Send your address' }, open) as any).message).toEqual({ text: 'Send your address' });
  });

  it('outside 24 hours only a person may reply (HUMAN_AGENT); the bot and WhatsApp templates are refused', () => {
    expect(buildPageMessage('messenger', 'P', { type: 'text', body: 'Sorry for the wait' }, { windowOpen: false, humanAgent: true }))
      .toMatchObject({ messaging_type: 'MESSAGE_TAG', tag: 'HUMAN_AGENT' });
    expect(() => buildPageMessage('messenger', 'P', { type: 'text', body: 'x' }, { windowOpen: false, humanAgent: false })).toThrow(/24-hour/);
    expect(() => buildPageMessage('messenger', 'P', { type: 'template', templateName: 't', language: 'en', params: [], body: 'x' }, open)).toThrow(/WhatsApp feature/);
  });

  it('Instagram text is cut to 1,000 bytes without splitting a character', () => {
    const t = (buildPageMessage('instagram', 'I', { type: 'text', body: 'م'.repeat(800) }, open) as any).message.text as string;
    expect(new TextEncoder().encode(t).length).toBeLessThanOrEqual(1000);
    expect(t.endsWith('…')).toBe(true);
  });
});

describe('webhooks', () => {
  it('parses Messenger messages, quick replies and postbacks; drops echoes, reads and the Page itself', () => {
    const events = parseMetaPagesWebhook({ object: 'page', entry: [{ id: '1111111111', time: 1, messaging: [
      { sender: { id: '900' }, recipient: { id: '1111111111' }, timestamp: 1700000000000, message: { mid: 'm.1', text: 'Hi' } },
      { sender: { id: '900' }, recipient: { id: '1111111111' }, timestamp: 1700000000001, message: { mid: 'm.2', text: 'Pickup', quick_reply: { payload: 'f:pickup' } } },
      { sender: { id: '900' }, recipient: { id: '1111111111' }, timestamp: 1700000000002, postback: { mid: 'm.3', title: 'Start', payload: 'start' } },
      { sender: { id: '1111111111' }, recipient: { id: '900' }, message: { mid: 'm.4', text: 'echo', is_echo: true } },
      { sender: { id: '900' }, recipient: { id: '1111111111' }, read: { watermark: 1 } },
    ] }] });
    expect(events.map((e) => [e.channelKind, e.accountId, e.from, e.messageId, e.type, e.text, e.replyId])).toEqual([
      ['messenger', '1111111111', '900', 'm.1', 'text', 'Hi', null],
      ['messenger', '1111111111', '900', 'm.2', 'button_reply', 'Pickup', 'f:pickup'],
      ['messenger', '1111111111', '900', 'm.3', 'button_reply', 'Start', 'start'],
    ]);
    expect(metaPagesEventKey(events[0]!)).toBe('messenger:m.1');
  });

  it('Instagram events are keyed by the Instagram account (entry.id); unknown objects are ignored', () => {
    const ev = parseMetaPagesWebhook({ object: 'instagram', entry: [{ id: '1784', messaging: [{ sender: { id: 'IG1' }, recipient: { id: '1784' }, message: { mid: 'ig.1', text: 'مرحبا' } }] }] });
    expect(ev).toMatchObject([{ channelKind: 'instagram', accountId: '1784', from: 'IG1', messageId: 'ig.1', text: 'مرحبا' }]);
    expect(parseMetaPagesWebhook({ object: 'whatsapp_business_account', entry: [] })).toEqual([]);
    expect(parseMetaPagesWebhook(null)).toEqual([]);
  });
});

describe('ownership proof and sending', () => {
  it('the token must be the Page\'s own token, and the Instagram account must be the one linked to the Page', async () => {
    const ok = scriptedFetch([{ body: { id: '1111111111', name: 'Olive Room' } }, { body: { instagram_business_account: { id: '1784', username: 'oliveroom' } } }]);
    expect(await metaPagesAdapter.verifyOwnership(ctx(ok.fetch), { pageId: '1111111111', instagramAccountId: '1784' }))
      .toEqual({ owned: true, page: { id: '1111111111', name: 'Olive Room' }, instagram: { id: '1784', username: 'oliveroom' } });
    expect(new URL(ok.calls[1]!.url).searchParams.get('fields')).toBe('instagram_business_account{id,username}');
    const other = scriptedFetch([{ body: { id: '2222', name: 'Someone else' } }]);
    expect(await metaPagesAdapter.verifyOwnership(ctx(other.fetch), { pageId: '1111111111' })).toEqual({ owned: false, reason: 'token_not_for_page' });
    const notLinked = scriptedFetch([{ body: { id: '1111111111' } }, { body: {} }]);
    expect(await metaPagesAdapter.verifyOwnership(ctx(notLinked.fetch), { pageId: '1111111111', instagramAccountId: '1784' })).toEqual({ owned: false, reason: 'instagram_not_linked' });
    const denied = scriptedFetch([{ status: 400, body: { error: { message: 'Unsupported get request', code: 100 } } }]);
    expect(await metaPagesAdapter.verifyOwnership(ctx(denied.fetch), { pageId: '1111111111' })).toEqual({ owned: false, reason: 'no_access' });
  });

  it('subscribes the Page and sends with the bearer token on the pinned version', async () => {
    const s = scriptedFetch([{ body: { success: true } }, { body: { recipient_id: '900', message_id: 'm.out' } }]);
    expect(await metaPagesAdapter.subscribeApp(ctx(s.fetch), '1111111111')).toBe(true);
    expect(s.calls[0]!.url).toBe('https://graph.facebook.com/v26.0/1111111111/subscribed_apps');
    expect(s.calls[0]!.body).toBe('subscribed_fields=messages%2Cmessaging_postbacks');
    expect(await metaPagesAdapter.send(ctx(s.fetch), '1111111111', { recipient: { id: '900' }, messaging_type: 'RESPONSE', message: { text: 'hi' } })).toEqual({ messageId: 'm.out' });
    expect(s.calls[1]!.headers.authorization).toBe('Bearer EAAPage-token-123');
  });
});
