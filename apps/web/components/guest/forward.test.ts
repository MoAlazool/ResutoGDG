// REM-A11: the guest address the web server forwards with its server-side reads, signed for the API.
// The expected signature is computed here independently from the documented scheme (apps/api/src/common/http/
// client-forwarding.ts): HMAC-SHA256(secret, "resuto-client-ip:v1:<10-minute window>:<ip>").
import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { clientAddress, forwardHeaders } from './server';

const SECRET = 'test-forward-secret-0123456789abcdef0123456789';
const NOW = Date.UTC(2026, 9, 23, 12, 34, 56);

describe('guest address forwarding', () => {
  it('signs the address for the current 10-minute window', () => {
    const w = Math.floor(NOW / 1000 / 600);
    const sig = createHmac('sha256', SECRET).update(`resuto-client-ip:v1:${w}:203.0.113.7`).digest('hex');
    expect(forwardHeaders('203.0.113.7', SECRET, NOW)).toEqual({ 'X-Resuto-Client-IP': '203.0.113.7', 'X-Resuto-Forward-Sig': `w=${w},v1=${sig}` });
    // Stable inside a window (the fetch cache key), different in the next one.
    expect(forwardHeaders('203.0.113.7', SECRET, NOW + 1000)).toEqual(forwardHeaders('203.0.113.7', SECRET, NOW));
    expect(forwardHeaders('203.0.113.7', SECRET, NOW + 600_000)['X-Resuto-Forward-Sig']).not.toBe(forwardHeaders('203.0.113.7', SECRET, NOW)['X-Resuto-Forward-Sig']);
    expect(forwardHeaders('2001:db8::1', SECRET, NOW)['X-Resuto-Client-IP']).toBe('2001:db8::1');
  });

  it('sends nothing without the secret or without a valid address', () => {
    expect(forwardHeaders('203.0.113.7', undefined, NOW)).toEqual({});
    expect(forwardHeaders(null, SECRET, NOW)).toEqual({});
    expect(forwardHeaders('not-an-ip', SECRET, NOW)).toEqual({});
    expect(forwardHeaders('203.0.113.7\r\nX-Evil: 1', SECRET, NOW)).toEqual({});
  });

  it('reads the address the edge reported: x-real-ip, else the first x-forwarded-for entry', () => {
    const h = (o: Record<string, string>) => ({ get: (n: string) => o[n] ?? null });
    expect(clientAddress(h({ 'x-real-ip': '198.51.100.4', 'x-forwarded-for': '10.0.0.1' }))).toBe('198.51.100.4');
    expect(clientAddress(h({ 'x-forwarded-for': '198.51.100.9, 10.0.0.1' }))).toBe('198.51.100.9');
    expect(clientAddress(h({}))).toBeNull();
  });
});
