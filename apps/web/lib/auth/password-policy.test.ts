import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { checkNewPassword, localPasswordIssue, MAX_PASSWORD, pwnedCount, PWNED_RANGE_URL, sha1Hex } from './password-policy';

const sha1 = (s: string) => createHash('sha1').update(s).digest('hex').toUpperCase();
const STRONG = 'Copper-Lantern-Harbor-58';

/** A fake Pwned Passwords range endpoint that records every request it gets. */
function fakeRange(rows: (suffix: string) => string[], init: { status?: number } = {}) {
  const calls: Array<{ url: string; headers: Headers }> = [];
  const fetch = vi.fn(async (url: string | URL | Request, req?: RequestInit) => {
    calls.push({ url: String(url), headers: new Headers(req?.headers) });
    const prefix = String(url).slice(PWNED_RANGE_URL.length);
    return new Response(rows(prefix).join('\r\n'), { status: init.status ?? 200 });
  }) as unknown as typeof globalThis.fetch;
  return { fetch, calls };
}

describe('AUTH-01 local password rules', () => {
  it('enforces the length range Supabase Auth accepts', () => {
    expect(localPasswordIssue('short-pw1')).toBe('password_too_short');
    expect(localPasswordIssue('x'.repeat(10) + 'Aa1!')).toBe(null);
    expect(localPasswordIssue('Ab1!'.repeat(19))).toBe('password_too_long');
    expect(localPasswordIssue('Ab1!'.repeat(18))).toBe(null);
    expect(MAX_PASSWORD).toBe(72);
  });

  it('rejects very common passwords and padded base words', () => {
    for (const p of ['1234567890', 'qwertyuiop', 'Password123', 'P@ssw0rd2026!', 'restaurant2026', 'Welcome12345', 'aaaaaaaaaaaa', 'abababababab']) {
      expect(localPasswordIssue(p), p).toBe('password_common');
    }
    expect(localPasswordIssue(STRONG)).toBe(null);
  });

  it('rejects passwords that contain the email or its local part, and the product name', () => {
    expect(localPasswordIssue('nadia.owner-2026!', { email: 'Nadia.Owner@olive.example' })).toBe('password_contains_email');
    expect(localPasswordIssue('xx-nadia.owner@olive.example', { email: 'nadia.owner@olive.example' })).toBe('password_contains_email');
    // Very short local parts are not matched (too many false positives).
    expect(localPasswordIssue('Copper-ali-Harbor-58', { email: 'ali@x.example' })).toBe(null);
    expect(localPasswordIssue('MyResuto-Kitchen-77')).toBe('password_contains_brand');
    expect(localPasswordIssue('مطبخ-ريسوتو-2077')).toBe('password_contains_brand');
  });
});

describe('AUTH-01 Pwned Passwords k-anonymity lookup', () => {
  it('hashes with SHA-1 like the API expects', async () => {
    expect(await sha1Hex('password')).toBe('5BAA61E4C9B93F3F0682250B6CF8331B7EE68FD8');
  });

  it('sends only the 5-character hash prefix, with padding requested, and matches the suffix locally', async () => {
    const hash = sha1(STRONG);
    const { fetch, calls } = fakeRange(() => [`0000000000000000000000000000000000A:3`, `${hash.slice(5)}:1234`, 'FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF:0']);
    expect(await pwnedCount(STRONG, { fetch })).toBe(1234);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`${PWNED_RANGE_URL}${hash.slice(0, 5)}`);
    expect(calls[0]!.url).not.toContain(hash.slice(5));
    expect(calls[0]!.url).not.toContain(STRONG);
    expect(calls[0]!.headers.get('add-padding')).toBe('true');
  });

  it('treats a padding row (count 0) for the same suffix as not breached', async () => {
    const hash = sha1(STRONG);
    const { fetch } = fakeRange(() => [`${hash.slice(5)}:0`, '0000000000000000000000000000000000A:9']);
    expect(await pwnedCount(STRONG, { fetch })).toBe(0);
  });

  it('returns 0 when the suffix is absent (lowercase suffixes still match)', async () => {
    const hash = sha1(STRONG);
    const { fetch } = fakeRange(() => ['0000000000000000000000000000000000A:9']);
    expect(await pwnedCount(STRONG, { fetch })).toBe(0);
    const lower = fakeRange(() => [`${hash.slice(5).toLowerCase()}:7`]);
    expect(await pwnedCount(STRONG, { fetch: lower.fetch })).toBe(7);
  });

  it('reports unavailable (null) on network failure, HTTP errors, timeouts and unexpected bodies', async () => {
    const reasons: string[] = [];
    const onUnavailable = (r: string) => reasons.push(r);
    const failing = vi.fn(async () => { throw new TypeError('Failed to fetch'); }) as unknown as typeof fetch;
    expect(await pwnedCount(STRONG, { fetch: failing, onUnavailable })).toBe(null);
    expect(await pwnedCount(STRONG, { fetch: fakeRange(() => [], { status: 503 }).fetch, onUnavailable })).toBe(null);
    expect(await pwnedCount(STRONG, { fetch: fakeRange(() => ['<html>blocked</html>']).fetch, onUnavailable })).toBe(null);
    const hanging = vi.fn((_u: unknown, init?: RequestInit) => new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    })) as unknown as typeof fetch;
    expect(await pwnedCount(STRONG, { fetch: hanging, timeoutMs: 20, onUnavailable })).toBe(null);
    expect(reasons).toEqual(['network', 'HTTP 503', 'unexpected response', 'timeout']);
  });
});

describe('AUTH-01 checkNewPassword', () => {
  it('blocks a breached password with the breach count', async () => {
    const hash = sha1(STRONG);
    const { fetch } = fakeRange(() => [`${hash.slice(5)}:42`]);
    expect(await checkNewPassword(STRONG, {}, { fetch })).toEqual({ issue: 'password_breached', breachCheck: 'breached', breachCount: 42 });
  });

  it('accepts a password that is not in the corpus', async () => {
    const { fetch } = fakeRange(() => ['0000000000000000000000000000000000A:9']);
    expect(await checkNewPassword(STRONG, {}, { fetch })).toEqual({ issue: null, breachCheck: 'clear' });
  });

  it('does not call the network when a local rule fails', async () => {
    const { fetch, calls } = fakeRange(() => []);
    expect(await checkNewPassword('Password123', {}, { fetch })).toEqual({ issue: 'password_common', breachCheck: 'skipped' });
    expect(calls).toHaveLength(0);
  });

  it('does not block when the service is unreachable, and logs that the check did not run (never the password)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const failing = vi.fn(async () => { throw new TypeError('Failed to fetch'); }) as unknown as typeof fetch;
    expect(await checkNewPassword(STRONG, {}, { fetch: failing })).toEqual({ issue: null, breachCheck: 'unavailable' });
    expect(warn).toHaveBeenCalledTimes(1);
    const logged = String(warn.mock.calls[0]![0]);
    expect(logged).toContain('unavailable');
    expect(logged).not.toContain(STRONG);
    expect(logged).not.toContain(sha1(STRONG).slice(0, 5));
    warn.mockRestore();
  });
});
