import { describe, expect, it } from 'vitest';
import { dictionaries } from './i18n/messages';
import { AUTH_ERROR_CODES, AuthFlowError, authErrorCode, authErrorText } from './auth-errors';

describe('CR-05 auth errors are localised codes', () => {
  it('maps Supabase codes, dev API codes, status 429 and legacy English messages', () => {
    expect(authErrorCode({ code: 'invalid_credentials', message: 'Invalid login credentials' })).toBe('invalid_credentials');
    expect(authErrorCode({ code: 'user_already_exists' })).toBe('email_taken');
    expect(authErrorCode({ code: 'email_taken', status: 409, message: 'An account with this email already exists' })).toBe('email_taken');
    expect(authErrorCode({ status: 429, message: 'x' })).toBe('rate_limited');
    expect(authErrorCode({ message: 'Email not confirmed' })).toBe('email_not_confirmed');
    expect(authErrorCode({ message: 'Email link is invalid or has expired' })).toBe('link_invalid');
    expect(authErrorCode(new AuthFlowError('reset_unavailable'))).toBe('reset_unavailable');
    expect(authErrorCode({ code: 'current_password_incorrect', status: 400 })).toBe('current_password_incorrect');
    expect(authErrorCode({ message: 'Something unrelated' })).toBeNull();
    expect(authErrorCode(null)).toBeNull();
  });

  it('AUTH-01: maps Supabase weak_password reasons (dashboard character rules, paid-plan leaked-password check)', () => {
    expect(authErrorCode({ name: 'AuthWeakPasswordError', code: 'weak_password', reasons: ['characters'] })).toBe('weak_password_characters');
    expect(authErrorCode({ code: 'weak_password', reasons: ['length', 'pwned'] })).toBe('password_breached');
    expect(authErrorCode({ code: 'weak_password', reasons: ['length'] })).toBe('weak_password');
    expect(authErrorCode(new AuthFlowError('password_breached'))).toBe('password_breached');
  });

  it('has an English and an Arabic message for every code and the generic fallback', () => {
    for (const code of [...AUTH_ERROR_CODES, 'generic']) {
      expect(dictionaries.en[`auth.error.${code}`], code).toBeTruthy();
      expect(dictionaries.ar[`auth.error.${code}`], code).toBeTruthy();
    }
    const t = (k: string) => dictionaries.ar[k] ?? k;
    expect(authErrorText({ code: 'invalid_credentials' }, t)).toBe(dictionaries.ar['auth.error.invalid_credentials']);
    expect(authErrorText({ message: 'Server said no' }, t)).toBe('Server said no');
    expect(authErrorText({}, t)).toBe(dictionaries.ar['auth.error.generic']);
  });
});
