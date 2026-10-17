import { describe, expect, it } from 'vitest';
import { hmacHex } from '../core';
import { messagingSandboxAdapter } from './sandbox';
import { scriptedFetch } from './testing/scripted-fetch';
import {
  buildButtonsMessage, buildCtaUrlMessage, buildListMessage, buildLocationRequestMessage, buildTemplateMessage, buildTextMessage,
  parseWhatsAppWebhook, renderTemplateBody, verifyWebhookSubscription, verifyWhatsAppSignature, whatsappCloudAdapter, whatsappEventKey,
} from './whatsapp-cloud';

describe('X-Hub-Signature-256 verification', () => {
  // Vectors computed independently with: printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$SECRET"
  const body = '{"object":"whatsapp_business_account","entry":[]}';
  const vector = 'sha256=c84a394cc475525991e78ff16e430b02e47f953877d2af0ade26956ce6f384dc';

  it('accepts the exact HMAC-SHA256 of the raw body', () => {
    expect(verifyWhatsAppSignature(Buffer.from(body), vector, 'test-app-secret')).toBe(true);
    expect(verifyWhatsAppSignature(body, [vector], 'test-app-secret')).toBe(true);
  });

  it('matches the RFC-style public HMAC vector', () => {
    expect(hmacHex('sha256', 'key', 'The quick brown fox jumps over the lazy dog')).toBe('f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8');
  });

  it('rejects tampered bodies, wrong secrets, missing or malformed headers', () => {
    expect(verifyWhatsAppSignature(Buffer.from(body.replace('[]', '[{}]')), vector, 'test-app-secret')).toBe(false);
    expect(verifyWhatsAppSignature(Buffer.from(body), vector, 'other-secret')).toBe(false);
    expect(verifyWhatsAppSignature(Buffer.from(body), undefined, 'test-app-secret')).toBe(false);
    expect(verifyWhatsAppSignature(Buffer.from(body), vector.replace('sha256=', 'sha1='), 'test-app-secret')).toBe(false);
    expect(verifyWhatsAppSignature(Buffer.from(body), vector, undefined)).toBe(false);
    // Re-serialised JSON (different whitespace) must not verify: the raw body is what is signed.
    expect(verifyWhatsAppSignature(Buffer.from(JSON.stringify(JSON.parse(body), null, 1)), vector, 'test-app-secret')).toBe(false);
  });

  it('answers the subscription handshake only with the right verify token', () => {
    const q = { 'hub.mode': 'subscribe', 'hub.verify_token': 'vt-123', 'hub.challenge': '1158201444' };
    expect(verifyWebhookSubscription(q, 'vt-123')).toBe('1158201444');
    expect(verifyWebhookSubscription({ ...q, 'hub.verify_token': 'nope' }, 'vt-123')).toBeNull();
    expect(verifyWebhookSubscription({ ...q, 'hub.mode': 'unsubscribe' }, 'vt-123')).toBeNull();
    expect(verifyWebhookSubscription(q, undefined)).toBeNull();
  });
});

// Shapes follow Meta's documented webhook examples (messages / statuses components).
export const inboundFixture = {
  object: 'whatsapp_business_account',
  entry: [{
    id: '102290129340398',
    changes: [{
      field: 'messages',
      value: {
        messaging_product: 'whatsapp',
        metadata: { display_phone_number: '15550783881', phone_number_id: '106540352242922' },
        contacts: [{ profile: { name: 'Mona Adel' }, wa_id: '201001234567' }],
        messages: [
          { from: '201001234567', id: 'wamid.TEXT1', timestamp: '1750000000', type: 'text', text: { body: 'order' } },
          { from: '201001234567', id: 'wamid.BTN1', timestamp: '1750000001', type: 'interactive', interactive: { type: 'button_reply', button_reply: { id: 'ful:pickup', title: 'Pickup' } } },
          { from: '201001234567', id: 'wamid.LIST1', timestamp: '1750000002', type: 'interactive', interactive: { type: 'list_reply', list_reply: { id: 'branch:abc', title: 'Zamalek', description: '' } } },
          { from: '201001234567', id: 'wamid.LOC1', timestamp: '1750000003', type: 'location', location: { latitude: 30.0626, longitude: 31.2197, name: 'Home', address: '26 July St' } },
          { from: '201001234567', id: 'wamid.TPL1', timestamp: '1750000004', type: 'button', button: { payload: 'order.start', text: 'Order again' } },
        ],
      },
    }],
  }],
};

export const statusFixture = {
  object: 'whatsapp_business_account',
  entry: [{
    id: '102290129340398',
    changes: [{
      field: 'messages',
      value: {
        messaging_product: 'whatsapp',
        metadata: { display_phone_number: '15550783881', phone_number_id: '106540352242922' },
        statuses: [
          { id: 'wamid.OUT1', status: 'delivered', timestamp: '1750000100', recipient_id: '201001234567' },
          { id: 'wamid.OUT2', status: 'failed', timestamp: '1750000101', recipient_id: '201001234567', errors: [{ code: 131047, title: 'Re-engagement message' }] },
          { id: 'wamid.OUT3', status: 'deleted', timestamp: '1750000102' },
        ],
      },
    }],
  }, {
    id: '102290129340398',
    changes: [{ field: 'message_template_status_update', value: { event: 'APPROVED', message_template_id: 594425479261596, message_template_name: 'order_update', message_template_language: 'en', reason: 'NONE' } }],
  }],
};

describe('webhook parsing', () => {
  it('normalises text, button, list, location and template-button messages', () => {
    const events = parseWhatsAppWebhook(inboundFixture);
    expect(events).toHaveLength(5);
    expect(events[0]).toMatchObject({ kind: 'message', phoneNumberId: '106540352242922', wabaId: '102290129340398', from: '201001234567', contactName: 'Mona Adel', messageId: 'wamid.TEXT1', type: 'text', text: 'order' });
    expect(events[1]).toMatchObject({ type: 'button_reply', replyId: 'ful:pickup', text: 'Pickup' });
    expect(events[2]).toMatchObject({ type: 'list_reply', replyId: 'branch:abc' });
    expect(events[3]).toMatchObject({ type: 'location', location: { latitude: 30.0626, longitude: 31.2197, name: 'Home', address: '26 July St' } });
    expect(events[4]).toMatchObject({ type: 'button', replyId: 'order.start' });
    expect(events.map(whatsappEventKey)).toEqual(['msg:wamid.TEXT1', 'msg:wamid.BTN1', 'msg:wamid.LIST1', 'msg:wamid.LOC1', 'msg:wamid.TPL1']);
  });

  it('normalises status callbacks and template review updates, ignoring unknown statuses', () => {
    const events = parseWhatsAppWebhook(statusFixture);
    expect(events).toEqual([
      { kind: 'status', phoneNumberId: '106540352242922', wabaId: '102290129340398', messageId: 'wamid.OUT1', status: 'delivered', recipientId: '201001234567', timestamp: '1750000100', error: null },
      { kind: 'status', phoneNumberId: '106540352242922', wabaId: '102290129340398', messageId: 'wamid.OUT2', status: 'failed', recipientId: '201001234567', timestamp: '1750000101', error: '131047 Re-engagement message' },
      { kind: 'template_status', wabaId: '102290129340398', templateId: '594425479261596', templateName: 'order_update', language: 'en', event: 'APPROVED', reason: 'NONE' },
    ]);
    expect(whatsappEventKey(events[0]!)).toBe('status:wamid.OUT1:delivered');
  });

  it('ignores payloads that are not WhatsApp business account webhooks', () => {
    expect(parseWhatsAppWebhook({ object: 'page', entry: [] })).toEqual([]);
    expect(parseWhatsAppWebhook(null)).toEqual([]);
    expect(parseWhatsAppWebhook({ object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages', value: {} }] }] })).toEqual([]);
  });
});

describe('send payloads', () => {
  it('builds documented message objects', () => {
    expect(buildTextMessage('+201001234567', 'Hi')).toEqual({ messaging_product: 'whatsapp', recipient_type: 'individual', to: '201001234567', type: 'text', text: { body: 'Hi', preview_url: false } });
    const btn = buildButtonsMessage('201001234567', 'How would you like your order?', [{ id: 'ful:pickup', title: 'Pickup' }, { id: 'ful:delivery', title: 'Delivery to my address now' }]);
    expect(btn.interactive.type).toBe('button');
    expect(btn.interactive.action.buttons[1]).toEqual({ type: 'reply', reply: { id: 'ful:delivery', title: 'Delivery to my addr…' } });
    expect(() => buildButtonsMessage('1', 'x', [1, 2, 3, 4].map((i) => ({ id: String(i), title: 'x' })))).toThrow();
    const list = buildListMessage('201001234567', 'Choose a branch', 'Branches', [{ title: 'Cairo', rows: [{ id: 'branch:1', title: 'Zamalek', description: '26 July St' }] }]);
    expect(list.interactive).toMatchObject({ type: 'list', action: { button: 'Branches', sections: [{ title: 'Cairo', rows: [{ id: 'branch:1', title: 'Zamalek', description: '26 July St' }] }] } });
    expect(() => buildListMessage('1', 'x', 'y', [{ title: 'a', rows: Array.from({ length: 11 }, (_, i) => ({ id: String(i), title: 't' })) }])).toThrow();
    expect(buildCtaUrlMessage('201001234567', 'Pick your items', 'Open menu', 'https://app.test/o/tok').interactive)
      .toEqual({ type: 'cta_url', body: { text: 'Pick your items' }, action: { name: 'cta_url', parameters: { display_text: 'Open menu', url: 'https://app.test/o/tok' } } });
    expect(buildLocationRequestMessage('201001234567', 'Share your location').interactive).toMatchObject({ type: 'location_request_message', action: { name: 'send_location' } });
    expect(buildTemplateMessage('201001234567', 'order_update', 'ar', ['1042', 'ready']).template)
      .toEqual({ name: 'order_update', language: { code: 'ar' }, components: [{ type: 'body', parameters: [{ type: 'text', text: '1042' }, { type: 'text', text: 'ready' }] }] });
    expect(renderTemplateBody('Order {{1}} is {{2}}', ['#12', 'ready'])).toBe('Order #12 is ready');
  });

  it('posts to /{phone-number-id}/messages with the bearer token and reads the wamid', async () => {
    const f = scriptedFetch([{ body: { messaging_product: 'whatsapp', contacts: [{ input: '201001234567', wa_id: '201001234567' }], messages: [{ id: 'wamid.SENT1' }] } }]);
    const ctx = { environment: 'live' as const, credentials: { accessToken: 'EAAG-token' }, config: { phoneNumberId: '106540352242922' }, fetch: f.fetch };
    const res = await whatsappCloudAdapter.send(ctx, buildTextMessage('201001234567', 'Hi'));
    expect(res).toEqual({ messageId: 'wamid.SENT1' });
    expect(f.calls[0]).toMatchObject({ url: 'https://graph.facebook.com/v23.0/106540352242922/messages', method: 'POST' });
    expect(f.calls[0]!.headers.authorization).toBe('Bearer EAAG-token');
    expect(JSON.parse(f.calls[0]!.body!)).toMatchObject({ to: '201001234567', type: 'text' });
  });

  it('surfaces provider errors as retryable only for 429/5xx', async () => {
    const ctx = (status: number) => ({ environment: 'live' as const, credentials: { accessToken: 't' }, config: { phoneNumberId: '1' },
      fetch: scriptedFetch([{ status, body: { error: { message: 'x', code: 131056 } } }]).fetch });
    await expect(whatsappCloudAdapter.send(ctx(429), buildTextMessage('1', 'x'))).rejects.toMatchObject({ retryable: true, status: 429 });
    await expect(whatsappCloudAdapter.send(ctx(400), buildTextMessage('1', 'x'))).rejects.toMatchObject({ retryable: false, status: 400 });
  });

  it('submits templates to /{waba-id}/message_templates', async () => {
    const f = scriptedFetch([{ body: { id: '594425479261596', status: 'PENDING', category: 'UTILITY' } }]);
    const ctx = { environment: 'live' as const, credentials: { accessToken: 't' }, config: { phoneNumberId: '1', wabaId: '102290129340398' }, fetch: f.fetch };
    const res = await whatsappCloudAdapter.submitTemplate(ctx, { name: 'order_update', language: 'en', category: 'utility', body: 'Order {{1}} is {{2}}', examples: ['#12', 'ready'] });
    expect(res).toEqual({ templateId: '594425479261596', status: 'PENDING' });
    expect(f.calls[0]!.url).toBe('https://graph.facebook.com/v23.0/102290129340398/message_templates');
    expect(JSON.parse(f.calls[0]!.body!)).toEqual({ name: 'order_update', language: 'en', category: 'UTILITY',
      components: [{ type: 'BODY', text: 'Order {{1}} is {{2}}', example: { body_text: [['#12', 'ready']] } }] });
  });

  it('sandbox transport never calls the network', async () => {
    const res = await messagingSandboxAdapter.send(buildTextMessage('1', 'x'));
    expect(res.sandbox).toBe(true);
    expect(res.messageId).toMatch(/^sandbox\./);
    expect(messagingSandboxAdapter.descriptor.readiness).toBe('simulated');
    expect(whatsappCloudAdapter.descriptor.readiness).toBe('implemented_unverified');
  });
});
