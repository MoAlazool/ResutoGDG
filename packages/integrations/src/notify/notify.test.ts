// INT-28: notification channel adapters. Signature checks use the providers' own published examples; request shapes
// are asserted against a scripted fetch (nothing reaches Resend or Twilio).
import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { AdapterContext } from '../core';
import { isE164, isEmailAddress, notificationAdapterFor, resendAdapter, twilioSignature, twilioSmsAdapter, verifyResendWebhook, verifyTwilioStatusCallback } from './index';

type Call = { url: string; init: RequestInit };
function scripted(responses: Array<{ status?: number; body: unknown }>) {
  const calls: Call[] = [];
  const fetch = (async (url: string, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    const r = responses.shift();
    if (!r) throw new Error('unexpected request');
    return new Response(typeof r.body === 'string' ? r.body : JSON.stringify(r.body), { status: r.status ?? 200 });
  }) as unknown as typeof globalThis.fetch;
  return { calls, fetch };
}
const ctx = (fetch: typeof globalThis.fetch, credentials: Record<string, string>, config: Record<string, unknown>): AdapterContext =>
  ({ environment: 'live', credentials, config, fetch }) as AdapterContext;

describe('Svix / Resend webhook verification', () => {
  // Svix's documented example (https://docs.svix.com/receiving/verifying-payloads/how-manual).
  const secret = 'whsec_plJ3nmyCDGBKInavdOK15jsl';
  const rawBody = '{"event_type":"ping","data":{"success":true}}';
  const headers = { 'svix-id': 'msg_loFOjxBNrRLzqYUf', 'svix-timestamp': '1731705121', 'svix-signature': 'v1,rAvfW3dJ/X/qxhsaXPOyyCGmRKsaKWcsNccKXlIktD0=' };

  it('accepts the published example signature and ignores unknown event types', () => {
    const r = verifyResendWebhook({ secret, headers, rawBody, nowSeconds: 1731705121 });
    expect(r).toEqual({ valid: true, eventKey: 'resend:msg_loFOjxBNrRLzqYUf', update: null });
  });

  it('fails closed: no secret, tampered body, wrong signature, stale timestamp, missing headers', () => {
    expect(verifyResendWebhook({ secret: undefined, headers, rawBody, nowSeconds: 1731705121 })).toEqual({ valid: false, reason: 'not_configured' });
    expect(verifyResendWebhook({ secret, headers, rawBody: rawBody.replace('true', 'false'), nowSeconds: 1731705121 })).toEqual({ valid: false, reason: 'bad_signature' });
    expect(verifyResendWebhook({ secret, headers: { ...headers, 'svix-signature': 'v1,AAAA' }, rawBody, nowSeconds: 1731705121 })).toEqual({ valid: false, reason: 'bad_signature' });
    expect(verifyResendWebhook({ secret, headers, rawBody, nowSeconds: 1731705121 + 301 })).toEqual({ valid: false, reason: 'stale' });
    expect(verifyResendWebhook({ secret, headers: { 'svix-id': 'x' }, rawBody, nowSeconds: 1731705121 })).toEqual({ valid: false, reason: 'missing_headers' });
  });

  it('maps a signed email.delivered / email.bounced event to a status update (several signatures in the header)', () => {
    const ts = '1760000000';
    const sign = (body: string) => createHmac('sha256', Buffer.from(secret.slice(6), 'base64')).update(`msg_1.${ts}.${body}`).digest('base64');
    for (const [type, status] of [['email.delivered', 'delivered'], ['email.bounced', 'bounced'], ['email.complained', 'complained']] as const) {
      const body = JSON.stringify({ type, created_at: '2026-10-21T10:00:00.000Z', data: { email_id: 'e5b0b1c2-0000-4000-8000-000000000001', to: ['a@b.example'] } });
      const r = verifyResendWebhook({ secret, headers: { 'svix-id': 'msg_1', 'svix-timestamp': ts, 'svix-signature': `v1,old= v1,${sign(body)}` }, rawBody: body, nowSeconds: 1760000000 });
      expect(r).toEqual({ valid: true, eventKey: 'resend:msg_1', update: { providerMessageId: 'e5b0b1c2-0000-4000-8000-000000000001', status, at: '2026-10-21T10:00:00.000Z' } });
    }
  });
});

describe('Twilio status callback signature', () => {
  // Twilio's documented example (https://www.twilio.com/docs/usage/webhooks/webhooks-security).
  const url = 'https://mycompany.com/myapp.php?foo=1&bar=2';
  const params = { CallSid: 'CA1234567890ABCDE', Caller: '+12349013030', Digits: '1234', From: '+12349013030', To: '+18005551212' };
  it('reproduces the published signature', () => {
    expect(twilioSignature('12345', url, params)).toBe('0/KCTR6DLpKmkAf8muzZqo1nDgQ=');
  });
  it('verifies and maps MessageStatus; refuses wrong token, URL or missing signature', () => {
    const p = { MessageSid: 'SM0123', MessageStatus: 'undelivered', ErrorCode: '30003', AccountSid: 'AC1' };
    const sig = twilioSignature('tok', 'https://api.example/v1/webhooks/twilio/status/abc', p);
    expect(verifyTwilioStatusCallback({ authToken: 'tok', url: 'https://api.example/v1/webhooks/twilio/status/abc', params: p, signature: sig }))
      .toEqual({ valid: true, update: { providerMessageId: 'SM0123', status: 'undelivered', errorCode: '30003' } });
    expect(verifyTwilioStatusCallback({ authToken: 'other', url: 'https://api.example/v1/webhooks/twilio/status/abc', params: p, signature: sig })).toEqual({ valid: false, reason: 'bad_signature' });
    expect(verifyTwilioStatusCallback({ authToken: 'tok', url: 'https://api.example/v1/webhooks/twilio/status/xyz', params: p, signature: sig })).toEqual({ valid: false, reason: 'bad_signature' });
    expect(verifyTwilioStatusCallback({ authToken: 'tok', url: 'x', params: p, signature: undefined })).toEqual({ valid: false, reason: 'missing_signature' });
    expect(verifyTwilioStatusCallback({ authToken: undefined, url: 'x', params: p, signature: sig })).toEqual({ valid: false, reason: 'not_configured' });
  });
});

describe('Resend adapter', () => {
  it('posts the documented body with Idempotency-Key and one-click unsubscribe headers', async () => {
    const f = scripted([{ body: { id: '49a3999c-0ce1-4ea6-ab68-afcd6dc2e794' } }]);
    const r = await resendAdapter.send(ctx(f.fetch, { apiKey: 're_test_key' }, { from: 'Olive <hello@olive.example>', replyTo: 'owner@olive.example' }), {
      to: 'guest@example.com', subject: 'Weekend offer', text: 'Hello', html: '<p>Hello</p>', idempotencyKey: 'outbound:1', unsubscribeUrl: 'https://api.example/u/abc', tags: { campaign: 'c1' },
    });
    expect(r).toEqual({ providerMessageId: '49a3999c-0ce1-4ea6-ab68-afcd6dc2e794', status: 'accepted' });
    expect(f.calls[0]!.url).toBe('https://api.resend.com/emails');
    const h = f.calls[0]!.init.headers as Record<string, string>;
    expect(h.Authorization).toBe('Bearer re_test_key');
    expect(h['Idempotency-Key']).toBe('outbound:1');
    expect(JSON.parse(String(f.calls[0]!.init.body))).toEqual({
      from: 'Olive <hello@olive.example>', to: ['guest@example.com'], subject: 'Weekend offer', text: 'Hello', html: '<p>Hello</p>',
      headers: { 'List-Unsubscribe': '<https://api.example/u/abc>', 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' },
      reply_to: 'owner@olive.example', tags: [{ name: 'campaign', value: 'c1' }],
    });
  });
  it('classifies failures: 429/5xx retryable, 4xx not, missing config never calls out', async () => {
    const f = scripted([{ status: 429, body: {} }, { status: 422, body: { message: 'x' } }]);
    const c = ctx(f.fetch, { apiKey: 're_k' }, { from: 'a@b.example' });
    const msg = { to: 'g@example.com', subject: 's', text: 't', idempotencyKey: 'k' };
    await expect(resendAdapter.send(c, msg)).rejects.toMatchObject({ retryable: true, status: 429 });
    await expect(resendAdapter.send(c, msg)).rejects.toMatchObject({ retryable: false, status: 422 });
    await expect(resendAdapter.send(ctx(f.fetch, {}, { from: 'a@b.example' }), msg)).rejects.toMatchObject({ retryable: false });
    await expect(resendAdapter.send(ctx(f.fetch, { apiKey: 'k' }, {}), msg)).rejects.toMatchObject({ retryable: false });
    await expect(resendAdapter.send(c, { ...msg, to: 'not-an-email' })).rejects.toMatchObject({ retryable: false });
    expect(f.calls).toHaveLength(2);
  });
  it('health check lists domains; a sending-only key is reported, not guessed', async () => {
    const f = scripted([{ body: { data: [] } }, { status: 401, body: {} }]);
    expect(await resendAdapter.healthCheck!(ctx(f.fetch, { apiKey: 'k' }, { from: 'a@b.example' }))).toMatchObject({ ok: true });
    expect(await resendAdapter.healthCheck!(ctx(f.fetch, { apiKey: 'k' }, {}))).toEqual({ ok: false, details: { reason: 'key_cannot_list_domains', status: 401 } });
    expect(f.calls.map((c) => c.url)).toEqual(['https://api.resend.com/domains', 'https://api.resend.com/domains']);
  });
});

describe('Twilio SMS adapter', () => {
  const sid = `AC${'0'.repeat(31)}1`;
  it('posts the documented form with Basic auth (Account SID + token) and StatusCallback', async () => {
    const f = scripted([{ status: 201, body: { sid: 'SM1', status: 'queued' } }]);
    const r = await twilioSmsAdapter.send(ctx(f.fetch, { accountSid: sid, authToken: 'tok' }, { from: 'OLIVE' }),
      { to: '+201001234567', text: 'Hi', idempotencyKey: 'k', statusCallbackUrl: 'https://api.example/cb' });
    expect(r).toEqual({ providerMessageId: 'SM1', status: 'queued' });
    expect(f.calls[0]!.url).toBe(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`);
    expect((f.calls[0]!.init.headers as Record<string, string>).Authorization).toBe(`Basic ${Buffer.from(`${sid}:tok`).toString('base64')}`);
    expect(Object.fromEntries(new URLSearchParams(String(f.calls[0]!.init.body)))).toEqual({ To: '+201001234567', Body: 'Hi', From: 'OLIVE', StatusCallback: 'https://api.example/cb' });
  });
  it('prefers a Messaging Service and API key credentials; rejects non-E.164 and missing sender', async () => {
    const f = scripted([{ status: 201, body: { sid: 'SM2', status: 'accepted' } }]);
    await twilioSmsAdapter.send(ctx(f.fetch, { accountSid: sid, apiKeySid: 'SKabc', apiKeySecret: 'sec' }, { from: 'X', messagingServiceSid: 'MG1' }), { to: '+966501234567', text: 'x', idempotencyKey: 'k' });
    expect(new URLSearchParams(String(f.calls[0]!.init.body)).get('MessagingServiceSid')).toBe('MG1');
    expect(new URLSearchParams(String(f.calls[0]!.init.body)).get('From')).toBeNull();
    expect((f.calls[0]!.init.headers as Record<string, string>).Authorization).toBe(`Basic ${Buffer.from('SKabc:sec').toString('base64')}`);
    await expect(twilioSmsAdapter.send(ctx(f.fetch, { accountSid: sid, authToken: 't' }, { from: 'X' }), { to: '01001234567', text: 'x', idempotencyKey: 'k' })).rejects.toMatchObject({ retryable: false });
    await expect(twilioSmsAdapter.send(ctx(f.fetch, { accountSid: sid, authToken: 't' }, {}), { to: '+201001234567', text: 'x', idempotencyKey: 'k' })).rejects.toMatchObject({ retryable: false });
    await expect(twilioSmsAdapter.send(ctx(f.fetch, { accountSid: 'bad', authToken: 't' }, { from: 'X' }), { to: '+201001234567', text: 'x', idempotencyKey: 'k' })).rejects.toMatchObject({ retryable: false });
    expect(f.calls).toHaveLength(1);
  });
  it('surfaces Twilio error codes without the body and treats 5xx as retryable', async () => {
    const f = scripted([{ status: 400, body: { code: 21610, message: 'blocked' } }, { status: 503, body: 'x' }]);
    const c = ctx(f.fetch, { accountSid: sid, authToken: 't' }, { from: 'X' });
    await expect(twilioSmsAdapter.send(c, { to: '+201001234567', text: 'x', idempotencyKey: 'k' })).rejects.toMatchObject({ retryable: false, message: expect.stringContaining('21610') });
    await expect(twilioSmsAdapter.send(c, { to: '+201001234567', text: 'x', idempotencyKey: 'k' })).rejects.toMatchObject({ retryable: true });
  });
  it('health check reads the account without sending', async () => {
    const f = scripted([{ body: { status: 'active', type: 'Full', friendly_name: 'Olive' } }]);
    expect(await twilioSmsAdapter.healthCheck!(ctx(f.fetch, { accountSid: sid, authToken: 't' }, {}))).toEqual({ ok: true, details: { status: 'active', type: 'Full' }, account: { id: sid, name: 'Olive' } });
    expect(f.calls[0]!.url).toBe(`https://api.twilio.com/2010-04-01/Accounts/${sid}.json`);
  });
});

describe('helpers', () => {
  it('validates addresses and resolves adapters', () => {
    expect(isEmailAddress('a@b.example')).toBe(true);
    expect(isEmailAddress('a b@c.d')).toBe(false);
    expect(isE164('+201001234567')).toBe(true);
    expect(isE164('201001234567')).toBe(false);
    expect(notificationAdapterFor('resend')).toBe(resendAdapter);
    expect(notificationAdapterFor('nope')).toBeNull();
  });
});
