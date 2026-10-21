import { describe, expect, it } from 'vitest';
import { isOtherBrowserError, linkFlow, parseAuthLink, retryAfterSeconds } from './links';

const CB = 'https://app.test/auth/callback?next=%2Freset-password';

describe('AUTH-03 email links on /auth/callback', () => {
  it('reads Supabase link errors from the fragment (implicit) and the query (PKCE); otp_expired is "expired"', () => {
    expect(parseAuthLink(`${CB}#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired`))
      .toEqual({ kind: 'error', problem: 'link_expired', description: 'Email link is invalid or has expired' });
    expect(parseAuthLink(`${CB}&error=access_denied&error_code=otp_expired`)).toMatchObject({ kind: 'error', problem: 'link_expired' });
    expect(parseAuthLink(`${CB}#error=server_error&error_description=Unable+to+exchange`)).toMatchObject({ kind: 'error', problem: 'link_invalid' });
  });

  it('recognises a PKCE code, implicit tokens, the half-done secure email change, and nothing at all', () => {
    expect(parseAuthLink(`${CB}&code=abc123`)).toEqual({ kind: 'code', code: 'abc123', type: null });
    expect(parseAuthLink(`${CB}#access_token=x&refresh_token=y&type=recovery`)).toEqual({ kind: 'tokens', type: 'recovery' });
    expect(parseAuthLink('https://app.test/auth/callback?next=%2Faccount%2Fsecurity#message=Confirmation+link+accepted.+Please+proceed+to+confirm+link+sent+to+the+other+email'))
      .toMatchObject({ kind: 'message' });
    expect(parseAuthLink(CB)).toEqual({ kind: 'none' });
    expect(parseAuthLink('not a url')).toMatchObject({ kind: 'error', problem: 'link_invalid' });
  });

  it('knows the flow from the validated next path', () => {
    expect(linkFlow('/reset-password')).toBe('reset');
    expect(linkFlow('/account/security')).toBe('email_change');
    expect(linkFlow('/onboarding')).toBe('signup');
    expect(linkFlow('/invite/abc')).toBe('signup');
    expect(linkFlow(null)).toBe('signup');
  });

  it('detects a PKCE link opened in another browser', () => {
    expect(isOtherBrowserError({ name: 'AuthPKCEGrantCodeExchangeError', message: 'Not found' })).toBe(true);
    expect(isOtherBrowserError({ code: 'bad_code_verifier' })).toBe(true);
    expect(isOtherBrowserError({ message: 'invalid flow state, no valid flow state found' })).toBe(true);
    expect(isOtherBrowserError({ message: 'PKCE code verifier not found in storage.' })).toBe(true);
    expect(isOtherBrowserError({ code: 'otp_expired' })).toBe(false);
    expect(isOtherBrowserError(null)).toBe(false);
  });

  it('reads the wait from a too-early resend', () => {
    expect(retryAfterSeconds({ message: 'For security purposes, you can only request this after 42 seconds.' })).toBe(42);
    expect(retryAfterSeconds({ message: 'Email rate limit exceeded' })).toBe(60);
    expect(retryAfterSeconds(null, 30)).toBe(30);
  });
});
