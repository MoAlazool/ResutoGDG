import { createHash, createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { scriptedFetch } from '../messaging/testing/scripted-fetch';
import { buildCustomAudienceDryRun } from './audiences';
import { buildServerEvent, buildUserData, hashEmail, hashPhone, metaCapiAdapter, minorToValue, testEventCodeFor } from './meta-capi';

const sha = (v: string) => createHash('sha256').update(v).digest('hex');
const ctx = (fetch: typeof globalThis.fetch, environment: 'sandbox' | 'live', config: Record<string, unknown> = {}) =>
  ({ environment, credentials: { accessToken: 'capi-token-123', appSecret: 'app-secret-1' }, config: { pixelId: '1234567890', ...config }, fetch });

describe('Conversions API normalisation (customer information parameters)', () => {
  it('hashes email after trim + lowercase, and phone as digits with country code without leading zeros', () => {
    expect(hashEmail('  John_Smith@Gmail.com ')).toBe(sha('john_smith@gmail.com'));
    expect(hashEmail('not-an-email')).toBeNull();
    expect(hashPhone('+20 100-123-4567')).toBe(sha('201001234567'));
    expect(hashPhone('00966501234567')).toBe(sha('966501234567'));
    expect(hashPhone('12')).toBeNull();
  });

  it('never hashes ip, user agent, fbp or fbc, and drops malformed fbp/fbc', () => {
    const u = buildUserData({ email: 'a@b.co', phone: '+201001234567', country: 'EG', clientIp: '203.0.113.7', userAgent: 'Mozilla/5.0',
      fbp: 'fb.1.1596403881668.1116446470', fbc: 'fb.1.1554763741205.AbCdEfGhIjKlMnOp', externalId: 'cust-1' });
    expect(u).toEqual({ em: [sha('a@b.co')], ph: [sha('201001234567')], country: [sha('eg')], external_id: [sha('cust-1')],
      client_ip_address: '203.0.113.7', client_user_agent: 'Mozilla/5.0', fbp: 'fb.1.1596403881668.1116446470', fbc: 'fb.1.1554763741205.AbCdEfGhIjKlMnOp' });
    expect(buildUserData({ fbp: 'fb.1.x.y', fbc: '<script>', clientIp: '1.2.3.4; drop' })).toEqual({});
  });

  it('converts minor units to the decimal value Meta expects', () => {
    expect(minorToValue(14252, 'EGP')).toBe(142.52);
    expect(minorToValue(5000, 'SAR')).toBe(50);
  });
});

describe('server events', () => {
  const now = new Date('2026-10-20T12:00:00Z');
  const base = { eventName: 'Purchase' as const, eventId: 'purchase.R7K2', eventTime: new Date('2026-10-20T11:59:00Z'), eventSourceUrl: 'https://olive.example/order/olive',
    user: { userAgent: 'Mozilla/5.0', clientIp: '203.0.113.7' }, custom: { currency: 'EGP', valueMinor: 25000, orderId: 'R7K2', contents: [{ id: 'p1', quantity: 2, itemPriceMinor: 12500 }] } };

  it('builds a website Purchase with event_id, value and contents', () => {
    const r = buildServerEvent(base, now);
    expect(r).toEqual({ event: {
      event_name: 'Purchase', event_time: Math.floor(base.eventTime.getTime() / 1000), event_id: 'purchase.R7K2', action_source: 'website',
      event_source_url: 'https://olive.example/order/olive', user_data: { client_ip_address: '203.0.113.7', client_user_agent: 'Mozilla/5.0' },
      custom_data: { currency: 'EGP', value: 250, order_id: 'R7K2', content_type: 'product', contents: [{ id: 'p1', quantity: 2, item_price: 125 }], num_items: 2 },
    } });
  });

  it('refuses what Meta would reject for the whole batch: older than 7 days, future, no user agent, no https source url', () => {
    expect(buildServerEvent({ ...base, eventTime: new Date('2026-10-12T11:00:00Z') }, now)).toEqual({ error: 'event_too_old' });
    expect(buildServerEvent({ ...base, eventTime: new Date('2026-10-20T13:00:00Z') }, now)).toEqual({ error: 'event_in_future' });
    expect(buildServerEvent({ ...base, user: { clientIp: '203.0.113.7' } }, now)).toEqual({ error: 'client_user_agent_required' });
    expect(buildServerEvent({ ...base, eventSourceUrl: 'http://x' }, now)).toEqual({ error: 'event_source_url_required' });
    expect(buildServerEvent({ ...base, eventId: 'bad id' }, now)).toEqual({ error: 'invalid_event_id' });
  });

  it('test connections must carry the Test Events code; live connections never send it', () => {
    const f = scriptedFetch([{ body: {} }]).fetch;
    expect(() => testEventCodeFor(ctx(f, 'sandbox'))).toThrow(/Test Events code/);
    expect(testEventCodeFor(ctx(f, 'sandbox', { testEventCode: 'TEST4242' }))).toBe('TEST4242');
    expect(testEventCodeFor(ctx(f, 'live', { testEventCode: 'TEST4242' }))).toBeNull();
  });

  it('POSTs to /v26.0/{pixel}/events with the bearer token, appsecret_proof and test_event_code', async () => {
    const s = scriptedFetch([{ body: { events_received: 1, messages: [], fbtrace_id: 'Atrace' } }]);
    const ev = (buildServerEvent(base, now) as { event: Record<string, unknown> }).event;
    const res = await metaCapiAdapter.sendEvents(ctx(s.fetch, 'sandbox', { testEventCode: 'TEST4242' }), [ev]);
    expect(res).toEqual({ eventsReceived: 1, fbtraceId: 'Atrace', messages: [] });
    const u = new URL(s.calls[0]!.url);
    expect(u.origin + u.pathname).toBe('https://graph.facebook.com/v26.0/1234567890/events');
    expect(u.searchParams.get('appsecret_proof')).toBe(createHmac('sha256', 'app-secret-1').update('capi-token-123').digest('hex'));
    expect(u.searchParams.get('access_token')).toBeNull();
    expect(s.calls[0]!.headers.authorization).toBe('Bearer capi-token-123');
    expect(JSON.parse(s.calls[0]!.body!)).toEqual({ data: [ev], test_event_code: 'TEST4242' });
    expect(s.calls[0]!.body).not.toContain('capi-token-123');
  });

  it('a live send has no test_event_code; Meta errors are surfaced without the token', async () => {
    const s = scriptedFetch([{ status: 400, body: { error: { message: 'Invalid parameter', code: 100, fbtrace_id: 'X' } } }]);
    await expect(metaCapiAdapter.sendEvents(ctx(s.fetch, 'live', { testEventCode: 'TEST1' }), [{ event_name: 'Purchase' }]))
      .rejects.toThrow(/code 100: Invalid parameter/);
    expect(JSON.parse(s.calls[0]!.body!)).toEqual({ data: [{ event_name: 'Purchase' }] });
  });

  it('health check reads the pixel with the token and fails a test connection without the code', async () => {
    const s = scriptedFetch([{ body: { id: '1234567890', name: 'Olive Room Pixel' } }]);
    expect(await metaCapiAdapter.healthCheck(ctx(s.fetch, 'live'))).toEqual({ ok: true, details: { pixelId: '1234567890', name: 'Olive Room Pixel', testMode: false },
      account: { id: '1234567890', name: 'Olive Room Pixel' } });
    expect(new URL(s.calls[0]!.url).searchParams.get('fields')).toBe('id,name');
    await expect(metaCapiAdapter.healthCheck(ctx(s.fetch, 'sandbox'))).rejects.toThrow(/Test Events code/);
  });
});

describe('custom audience dry run (INT-22)', () => {
  it('keeps only consenting, matchable, de-duplicated members, hashed, in batches of 10,000, and never calls Meta', () => {
    const members = [
      { email: 'A@x.co', phone: '+201001234567', marketingConsent: true },
      { email: 'a@x.co ', phone: '+20 100 123 4567', marketingConsent: true },
      { email: 'b@x.co', marketingConsent: false },
      { phone: null, email: null, marketingConsent: true },
      { email: 'c@x.co', marketingConsent: true, anonymised: true },
    ];
    const r = buildCustomAudienceDryRun({ adAccountId: '111', name: 'Regulars', description: 'CRM segment', members });
    expect(r.counts).toEqual({ segment: 5, withConsent: 3, matchable: 1, excludedNoConsent: 2, excludedNoIdentifier: 1 });
    expect(r.sample).toEqual([[sha('a@x.co'), sha('201001234567')]]);
    expect(r.create).toEqual({ path: 'act_111/customaudiences', body: { name: 'Regulars', subtype: 'CUSTOM', description: 'CRM segment', customer_file_source: 'USER_PROVIDED_ONLY' } });
    expect(JSON.stringify(r)).not.toContain('@x.co');
    const big = buildCustomAudienceDryRun({ adAccountId: 'act_1', name: 'n', description: 'd',
      members: Array.from({ length: 20_001 }, (_, i) => ({ email: `u${i}@x.co`, marketingConsent: true })) });
    expect(big.batches.map((b) => [b.rows, b.session.batch_seq, b.session.last_batch_flag])).toEqual([[10000, 1, false], [10000, 2, false], [1, 3, true]]);
  });
});
