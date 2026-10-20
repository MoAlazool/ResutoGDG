import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { scriptedFetch } from '../messaging/testing/scripted-fetch';
import { metaAdsAdapter } from '../ads/meta-ads';
import { whatsappCloudAdapter } from '../messaging/whatsapp-cloud';
import { appSecretProof, graphRequest, graphUrl, META_GRAPH_VERSION, META_VERSION_SUPPORT, metaVersionWarnings, verifyMetaSignature } from './graph';

describe('INT-12: one pinned Meta Graph / Marketing API version', () => {
  it('is v26.0 everywhere (WhatsApp, Marketing API, OAuth dialog)', async () => {
    expect(META_GRAPH_VERSION).toBe('v26.0');
    expect(new URL(metaAdsAdapter.buildAuthUrl({ clientId: 'a', redirectUri: 'https://x/cb' }, 's')).pathname).toBe('/v26.0/dialog/oauth');
    const f = scriptedFetch([{ body: { messages: [{ id: 'wamid.1' }] } }]);
    await whatsappCloudAdapter.send({ environment: 'live', credentials: { accessToken: 't' }, config: { phoneNumberId: '1' }, fetch: f.fetch }, { to: '1' });
    expect(f.calls[0]!.url.startsWith('https://graph.facebook.com/v26.0/')).toBe(true);
  });

  it('fails 60 days before a pinned version expires (release gate); TBD dates pass until Meta publishes them', () => {
    // The real table: no known end-of-life inside the window today. This assertion is the CI gate.
    expect(metaVersionWarnings(new Date())).toEqual([]);
    const table = { graph: { ...META_VERSION_SUPPORT.graph, availableUntil: '2027-02-23' }, marketing: { ...META_VERSION_SUPPORT.marketing, availableUntil: null } };
    expect(metaVersionWarnings(new Date('2026-12-01T00:00:00Z'), 60, table)).toEqual([]);
    expect(metaVersionWarnings(new Date('2026-12-26T00:00:00Z'), 60, table)[0]).toMatch(/graph API v26\.0 expires in 59 day\(s\) \(2027-02-23\)/);
    expect(metaVersionWarnings(new Date('2027-03-01T00:00:00Z'), 60, table)[0]).toMatch(/expired/);
  });
});

describe('Graph request hygiene', () => {
  it('computes appsecret_proof as hex HMAC-SHA256(token, app secret)', () => {
    expect(appSecretProof('EAAB-token', 'app-secret')).toBe(createHmac('sha256', 'app-secret').update('EAAB-token').digest('hex'));
    expect(appSecretProof('EAAB-token', 'app-secret')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('never follows a non-Graph URL (paging links are checked)', () => {
    expect(() => graphUrl('https://evil.example/v26.0/me')).toThrow(/non-Graph/);
    expect(graphUrl('123/messages', { query: { a: 1, b: undefined } }).toString()).toBe('https://graph.facebook.com/v26.0/123/messages?a=1');
  });

  it('sends the token as a bearer header by default and never in the error text', async () => {
    const f = scriptedFetch([{ status: 400, body: { error: { message: 'Invalid parameter', code: 100, fbtrace_id: 'Ax' } } }]);
    const err = await graphRequest('meta', { fetch: f.fetch }, 'me', { token: 'SECRET-TOKEN-VALUE' }).catch((e) => e);
    expect(f.calls[0]!.headers.authorization).toBe('Bearer SECRET-TOKEN-VALUE');
    expect(f.calls[0]!.url).not.toContain('SECRET-TOKEN-VALUE');
    expect(err.message).toBe('meta: HTTP 400 code 100: Invalid parameter');
    expect(err.message).not.toContain('SECRET-TOKEN-VALUE');
    expect(err).toMatchObject({ code: 100, fbtraceId: 'Ax', retryable: false });
  });

  it('verifies X-Hub-Signature-256 against the raw body', () => {
    const body = '{"object":"page","entry":[]}';
    const sig = `sha256=${createHmac('sha256', 's3cret').update(body).digest('hex')}`;
    expect(verifyMetaSignature(Buffer.from(body), sig, 's3cret')).toBe(true);
    expect(verifyMetaSignature(Buffer.from(body), sig, 'other')).toBe(false);
    expect(verifyMetaSignature(Buffer.from(`${body} `), sig, 's3cret')).toBe(false);
  });
});
