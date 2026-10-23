// REM-A11: guest pages read the API from the web server, so every guest shared the web server's rate-limit bucket.
// The web server now forwards the guest address with an HMAC (CLIENT_IP_FORWARD_SECRET); the API uses it as req.ip
// only when the signature is valid, current, the request is server-to-server (no Origin), and the route is a public
// guest read (GET/HEAD /v1/public/*). Spoofed or unsigned headers are ignored, so a client cannot pick its own bucket.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FORWARD_WINDOW_SECONDS, forwardableRoute, forwardedClientIp, forwardSignature } from '../src/common/http/client-forwarding';
import { bootTestApp, createTenant, type TestApp, type TestTenant } from './helpers';

const SECRET = 'forward-secret-for-tests-0123456789abcdef0123';
const NOW = Date.UTC(2026, 9, 23, 12, 0, 0);

describe('forwardedClientIp (verification)', () => {
  const h = (ip: string, sig: string, extra: Record<string, string> = {}) => ({ 'x-resuto-client-ip': ip, 'x-resuto-forward-sig': sig, ...extra });

  it('accepts a valid signature for the current or previous window', () => {
    expect(forwardedClientIp(h('203.0.113.7', forwardSignature(SECRET, '203.0.113.7', NOW)), SECRET, NOW)).toBe('203.0.113.7');
    const earlier = NOW - FORWARD_WINDOW_SECONDS * 1000;
    expect(forwardedClientIp(h('203.0.113.7', forwardSignature(SECRET, '203.0.113.7', earlier)), SECRET, NOW)).toBe('203.0.113.7');
    expect(forwardedClientIp(h('2001:db8::7', forwardSignature(SECRET, '2001:db8::7', NOW)), SECRET, NOW)).toBe('2001:db8::7');
  });

  it('ignores spoofed, stale, foreign, browser-originated or unconfigured forwarding', () => {
    const sig = forwardSignature(SECRET, '203.0.113.7', NOW);
    expect(forwardedClientIp(h('203.0.113.7', sig), undefined, NOW)).toBeNull();                       // API has no secret
    expect(forwardedClientIp(h('198.51.100.1', sig), SECRET, NOW)).toBeNull();                         // signature of another address
    expect(forwardedClientIp(h('203.0.113.7', forwardSignature('another-secret-another-secret-12345', '203.0.113.7', NOW)), SECRET, NOW)).toBeNull();
    expect(forwardedClientIp(h('203.0.113.7', 'w=1,v1=deadbeef'), SECRET, NOW)).toBeNull();            // malformed
    expect(forwardedClientIp(h('203.0.113.7', forwardSignature(SECRET, '203.0.113.7', NOW - 2 * FORWARD_WINDOW_SECONDS * 1000)), SECRET, NOW)).toBeNull(); // stale
    expect(forwardedClientIp(h('203.0.113.7', sig, { origin: 'https://evil.example' }), SECRET, NOW)).toBeNull(); // a browser request
    expect(forwardedClientIp(h('not-an-ip', forwardSignature(SECRET, 'not-an-ip', NOW)), SECRET, NOW)).toBeNull();
    expect(forwardedClientIp({ 'x-resuto-client-ip': '203.0.113.7' }, SECRET, NOW)).toBeNull();      // unsigned
  });
});

describe('forwardableRoute', () => {
  it('covers the public guest reads only', () => {
    expect(forwardableRoute('GET', '/v1/public/tables/abc')).toBe(true);
    expect(forwardableRoute('HEAD', '/v1/public/menu/x')).toBe(true);
    expect(forwardableRoute('POST', '/v1/public/reservations/x/holds')).toBe(false);
    expect(forwardableRoute('GET', '/v1/orgs')).toBe(false);
    expect(forwardableRoute('GET', '/v1/publicity')).toBe(false);
  });
});

describe('forwarded guest addresses get their own rate-limit buckets', () => {
  let t: TestApp;
  let tenant: TestTenant;
  const saved = process.env.CLIENT_IP_FORWARD_SECRET;

  beforeAll(async () => {
    process.env.CLIENT_IP_FORWARD_SECRET = SECRET;
    try { t = await bootTestApp(); } finally {
      if (saved === undefined) delete process.env.CLIENT_IP_FORWARD_SECRET; else process.env.CLIENT_IP_FORWARD_SECRET = saved;
    }
    tenant = await createTenant(t);
  });
  afterAll(async () => { await t?.close(); });

  const as = (ip: string) => ({ 'X-Resuto-Client-IP': ip, 'X-Resuto-Forward-Sig': forwardSignature(SECRET, ip) });
  // web-order:read:<ip> allows 120 reads a minute; an unknown restaurant answers 404 while the budget lasts.
  const read = (headers: Record<string, string>) => t.http.get('/v1/public/order/no-such-restaurant-rem-a11').set(headers);
  const reads = async (headers: Record<string, string>, n: number) => {
    const out: number[] = [];
    for (let i = 0; i < n; i++) out.push((await read(headers)).status);
    return out;
  };

  it('one guest exhausting its budget does not refuse another guest behind the same web server', async () => {
    const first = await reads(as('203.0.113.10'), 121);
    expect(first.slice(0, 120).every((s) => s === 404)).toBe(true);
    expect(first[120]).toBe(429);
    // Same web server (same socket address), another guest: its own bucket.
    expect((await read(as('203.0.113.11'))).status).toBe(404);
  });

  it('a spoofed address without a valid signature counts against the caller\'s real address', async () => {
    // The real (socket) address has not been used yet in this window: 120 unsigned "spoofed" reads spend it.
    const spoofed: number[] = [];
    for (let i = 0; i < 121; i++) spoofed.push((await read({ 'X-Resuto-Client-IP': `198.51.100.${(i % 250) + 1}`, 'X-Resuto-Forward-Sig': 'w=1,v1=00' })).status);
    expect(spoofed.slice(0, 120).every((s) => s === 404)).toBe(true);
    expect(spoofed[120]).toBe(429);
    // A signed address from a browser (Origin present) is not trusted either.
    expect((await read({ ...as('203.0.113.12'), Origin: 'http://app.test' })).status).toBe(429);
    // A properly forwarded guest is still served.
    expect((await read(as('203.0.113.12'))).status).toBe(404);
  });

  it('a signed address is ignored outside the public guest reads (writes keep the connecting address)', async () => {
    // reservations:hold:<ip> is a guard of 20 per minute. Signed holds "from" 21 different guests all count against
    // the one connecting address, so the 21st is refused.
    let n = 0;
    const statuses: number[] = [];
    for (let i = 0; i < 21; i++) {
      statuses.push((await t.http.post(`/v1/public/reservations/${tenant.slug}/holds`).set(as(`203.0.113.${100 + i}`)).send({
        branchId: '00000000-0000-4000-8000-000000000000', partySize: 2, guestName: 'Guest', guestPhone: `+2010${String(55500000 + ++n).padStart(8, '0')}`,
        date: '2030-01-10', time: '19:00', key: `fwd-${Date.now()}-${n}`,
      })).status);
    }
    expect(statuses.slice(0, 20).every((s) => s === 404)).toBe(true);
    expect(statuses[20]).toBe(429);
  });
});
