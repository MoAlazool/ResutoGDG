import { describe, expect, it, vi } from 'vitest';
import { authErrorCode } from '../auth-errors';
import {
  assuranceOf, groupSecret, qrImageSrc, listTotp, normalizeTotpCode, removeTotp, startTotpEnrolment, verifySignInCode, verifyTotp,
  type MfaClient, type MfaFactor,
} from './mfa';
import { fakeJwt } from './test-dom';

const factor = (id: string, status: 'verified' | 'unverified', type = 'totp'): MfaFactor =>
  ({ id, status, factor_type: type, friendly_name: `App ${id}`, created_at: '2026-10-21T10:00:00Z' });

/** A mocked supabase-js auth client: valid codes per factor, every call recorded. */
function mockClient(factors: MfaFactor[], valid: Record<string, string> = {}) {
  const calls: string[] = [];
  const client: MfaClient = {
    auth: {
      mfa: {
        listFactors: vi.fn(async () => { calls.push('list'); return { data: { all: factors, totp: factors.filter((f) => f.status === 'verified') }, error: null }; }),
        enroll: vi.fn(async (p) => {
          calls.push(`enroll:${p.friendlyName}:${p.issuer}`);
          return { data: { id: 'new', type: 'totp', totp: { qr_code: 'data:image/svg+xml;utf-8,<svg/>', secret: 'JBSWY3DPEHPK3PXPJBSWY3DP', uri: 'otpauth://totp/Resuto' } }, error: null };
        }),
        challengeAndVerify: vi.fn(async ({ factorId, code }) => {
          calls.push(`verify:${factorId}:${code}`);
          return valid[factorId] === code ? { data: {}, error: null }
            : { data: null, error: Object.assign(new Error('Invalid TOTP code entered'), { code: 'mfa_verification_failed', status: 422 }) };
        }),
        unenroll: vi.fn(async ({ factorId }) => { calls.push(`unenroll:${factorId}`); return { data: { id: factorId }, error: null }; }),
      },
      refreshSession: vi.fn(async () => { calls.push('refresh'); return { data: { session: null }, error: null }; }),
    },
  };
  return { client, calls };
}

describe('AUTH-02 assurance level from the session', () => {
  it('requires the code step only for an aal1 session of a user with a verified factor', () => {
    const aal1 = fakeJwt({ sub: 'u', aal: 'aal1' }), aal2 = fakeJwt({ sub: 'u', aal: 'aal2' });
    expect(assuranceOf(null)).toEqual({ current: null, next: null, required: false });
    expect(assuranceOf({ access_token: aal1, user: { factors: [] } })).toEqual({ current: 'aal1', next: 'aal1', required: false });
    expect(assuranceOf({ access_token: aal1, user: { factors: [factor('a', 'unverified')] } }).required).toBe(false);
    expect(assuranceOf({ access_token: aal1, user: { factors: [factor('a', 'verified')] } })).toEqual({ current: 'aal1', next: 'aal2', required: true });
    expect(assuranceOf({ access_token: aal2, user: { factors: [factor('a', 'verified')] } })).toEqual({ current: 'aal2', next: 'aal2', required: false });
    // A token without the claim (older issuers) is treated as aal1.
    expect(assuranceOf({ access_token: fakeJwt({ sub: 'u' }), user: { factors: [factor('a', 'verified')] } }).required).toBe(true);
  });
});

describe('AUTH-02 code input', () => {
  it('accepts Western and Arabic-Indic digits, ignores spaces and dashes, needs exactly 6 digits', () => {
    expect(normalizeTotpCode('123456')).toBe('123456');
    expect(normalizeTotpCode(' 123 456 ')).toBe('123456');
    expect(normalizeTotpCode('123-456')).toBe('123456');
    expect(normalizeTotpCode('١٢٣٤٥٦')).toBe('123456');     // ١٢٣٤٥٦
    expect(normalizeTotpCode('۱۲۳۴۵۶')).toBe('123456');     // Persian digits
    expect(normalizeTotpCode('12345')).toBeNull();
    expect(normalizeTotpCode('1234567')).toBeNull();
    expect(normalizeTotpCode('12a456')).toBeNull();
  });
  it('re-encodes the raw SVG QR code so colours (#) do not cut the data URL (browser proof showed a broken image)', () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><path fill="#000000" d="M0 0h1"/></svg>';
    const src = qrImageSrc(`data:image/svg+xml;utf-8,${svg}`);
    expect(src.startsWith('data:image/svg+xml;charset=utf-8,')).toBe(true);
    expect(src).not.toContain('#');
    expect(decodeURIComponent(src.slice(src.indexOf(',') + 1))).toBe(svg);
    expect(qrImageSrc(svg)).toBe(src);
    expect(qrImageSrc('data:image/png;base64,AAAA')).toBe('data:image/png;base64,AAAA');
    expect(qrImageSrc('data:image/svg+xml;utf-8,%3Csvg%2F%3E')).toBe('data:image/svg+xml;utf-8,%3Csvg%2F%3E');
  });

  it('groups the setup key for typing', () => {
    expect(groupSecret('JBSWY3DPEHPK3PXP')).toBe('JBSW Y3DP EHPK 3PXP');
  });
});

describe('AUTH-02 enrolment, verification and removal with a mocked Supabase client', () => {
  it('lists TOTP factors fresh from Supabase, split by status', async () => {
    const { client } = mockClient([factor('a', 'verified'), factor('b', 'unverified'), factor('p', 'verified', 'phone')]);
    const r = await listTotp(client);
    expect(r.verified.map((f) => f.id)).toEqual(['a']);
    expect(r.unverified.map((f) => f.id)).toEqual(['b']);
  });

  it('removes abandoned unverified factors before enrolling, with Resuto as the issuer', async () => {
    const { client, calls } = mockClient([factor('old', 'unverified'), factor('a', 'verified')]);
    const e = await startTotpEnrolment(client, { friendlyName: 'Authenticator 2026-10-21 10:00' });
    expect(calls).toEqual(['list', 'unenroll:old', 'enroll:Authenticator 2026-10-21 10:00:Resuto']);
    expect(e).toEqual({ factorId: 'new', qrCode: 'data:image/svg+xml;charset=utf-8,%3Csvg%2F%3E', secret: 'JBSWY3DPEHPK3PXPJBSWY3DP', uri: 'otpauth://totp/Resuto' });
  });

  it('refuses a malformed code without calling Supabase, and maps a wrong code to a localized error', async () => {
    const { client, calls } = mockClient([factor('a', 'verified')], { a: '246810' });
    await expect(verifyTotp(client, 'a', '12')).rejects.toMatchObject({ code: 'mfa_code_format' });
    expect(calls).toEqual([]);
    const wrong = await verifyTotp(client, 'a', '111111').catch((e) => e);
    expect(authErrorCode(wrong)).toBe('mfa_code_invalid');
    await expect(verifyTotp(client, 'a', '٢٤٦٨١٠')).resolves.toBeUndefined();
    expect(calls.at(-1)).toBe('verify:a:246810');
  });

  it('removes a verified factor only after a fresh code from it, then refreshes the session', async () => {
    const { client, calls } = mockClient([factor('a', 'verified')], { a: '246810' });
    await expect(removeTotp(client, 'a', '000000')).rejects.toBeTruthy();
    expect(calls).not.toContain('unenroll:a');
    await removeTotp(client, 'a', '246810');
    expect(calls.slice(-3)).toEqual(['verify:a:246810', 'unenroll:a', 'refresh']);
  });

  it('the sign-in code step tries each verified authenticator, and says when none is set up', async () => {
    const { client, calls } = mockClient([factor('a', 'verified'), factor('b', 'verified'), factor('c', 'unverified')], { b: '135790' });
    await verifySignInCode(client, '135790');
    expect(calls.filter((c) => c.startsWith('verify'))).toEqual(['verify:a:135790', 'verify:b:135790']);
    const none = mockClient([factor('c', 'unverified')]);
    await expect(verifySignInCode(none.client, '135790')).rejects.toMatchObject({ code: 'mfa_no_factor' });
    const wrong = await verifySignInCode(client, '999999').catch((e) => e);
    expect(authErrorCode(wrong)).toBe('mfa_code_invalid');
  });
});
