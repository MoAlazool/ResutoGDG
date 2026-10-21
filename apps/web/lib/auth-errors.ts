/**
 * CR-05: auth failures as stable codes so the sign-in, sign-up, reset and account pages can show them in the
 * reader's language. Codes come from the API's dev issuer (ApiRequestError.code), from Supabase Auth (AuthError.code
 * or, on older servers, its English message) or from Resuto itself (AuthFlowError).
 */
export const AUTH_ERROR_CODES = [
  'invalid_credentials', 'current_password_incorrect', 'email_not_confirmed', 'email_taken', 'weak_password', 'same_password', 'rate_limited',
  'reset_unavailable', 'email_change_unavailable', 'link_invalid', 'google_disabled', 'not_signed_in', 'network', 'current_password_required',
  // AUTH-01: Resuto's compensating password checks (lib/auth/password-policy.ts) and Supabase's own weak_password reasons.
  'password_too_short', 'password_too_long', 'password_common', 'password_contains_email', 'password_contains_brand', 'password_breached',
  'weak_password_characters',
  // AUTH-02: TOTP two-step verification (Supabase Auth MFA) and the API's 403 mfa_required.
  'mfa_code_format', 'mfa_code_invalid', 'mfa_code_expired', 'mfa_unavailable', 'mfa_required', 'mfa_too_many', 'mfa_no_factor',
  // AUTH-03: email links and resends.
  'link_expired', 'link_other_browser', 'resend_unavailable',
  // AUTH-02: a signed-in password change that needs a fresh sign-in ("secure password change", session over 24 hours).
  'password_change_sign_in_again',
] as const;
export type AuthErrorCode = (typeof AUTH_ERROR_CODES)[number];

/** An auth failure Resuto raises itself (e.g. reset email unavailable in local development). */
export class AuthFlowError extends Error {
  constructor(readonly code: AuthErrorCode, message?: string) { super(message ?? code); }
}

const SUPABASE_CODES: Record<string, AuthErrorCode> = {
  invalid_credentials: 'invalid_credentials', invalid_grant: 'invalid_credentials', current_password_incorrect: 'current_password_incorrect',
  email_not_confirmed: 'email_not_confirmed',
  user_already_exists: 'email_taken', email_exists: 'email_taken', email_taken: 'email_taken',
  weak_password: 'weak_password', same_password: 'same_password', password_unchanged: 'same_password',
  over_email_send_rate_limit: 'rate_limited', over_request_rate_limit: 'rate_limited', rate_limited: 'rate_limited',
  otp_expired: 'link_expired', flow_state_expired: 'link_expired', flow_state_not_found: 'link_other_browser', bad_code_verifier: 'link_other_browser',
  mfa_verification_failed: 'mfa_code_invalid', mfa_verification_rejected: 'mfa_code_invalid', mfa_challenge_expired: 'mfa_code_expired',
  mfa_totp_enroll_not_enabled: 'mfa_unavailable', mfa_totp_verify_not_enabled: 'mfa_unavailable', insufficient_aal: 'mfa_required',
  mfa_required: 'mfa_required', too_many_enrolled_mfa_factors: 'mfa_too_many', mfa_factor_not_found: 'mfa_no_factor',
  reauthentication_needed: 'password_change_sign_in_again',
};
const MESSAGES: Array<[RegExp, AuthErrorCode]> = [
  [/invalid totp code/i, 'mfa_code_invalid'],
  [/current password is incorrect/i, 'current_password_incorrect'],
  // Supabase Auth counts the 72-character limit in UTF-8 bytes (validation_failed "Password cannot be longer than 72 characters").
  [/password cannot be longer than/i, 'password_too_long'],
  [/invalid login credentials|email or password is incorrect/i, 'invalid_credentials'],
  [/email not confirmed/i, 'email_not_confirmed'],
  [/already (registered|exists)/i, 'email_taken'],
  [/password should be|weak password|at least \d+ characters/i, 'weak_password'],
  [/different from the (old|current)/i, 'same_password'],
  [/rate limit|too many requests/i, 'rate_limited'],
  [/expired|invalid.*(link|token|code)/i, 'link_invalid'],
  [/failed to fetch|network/i, 'network'],
];

/** The localisable code of an auth failure, or null when it is not a known auth failure. */
export function authErrorCode(err: unknown): AuthErrorCode | null {
  if (!err || typeof err !== 'object') return null;
  const e = err as { code?: unknown; status?: unknown; message?: unknown };
  if (err instanceof AuthFlowError) return err.code;
  if (e.code === 'weak_password' || (err as { name?: unknown }).name === 'AuthWeakPasswordError') {
    // Supabase lists why (AuthWeakPasswordError.reasons): 'length', 'characters' (dashboard character rules), 'pwned'.
    const reasons = (err as { reasons?: unknown }).reasons;
    if (Array.isArray(reasons) && reasons.includes('pwned')) return 'password_breached';
    if (Array.isArray(reasons) && reasons.includes('characters')) return 'weak_password_characters';
    return 'weak_password';
  }
  if (typeof e.code === 'string' && SUPABASE_CODES[e.code]) return SUPABASE_CODES[e.code]!;
  if (e.status === 429) return 'rate_limited';
  const msg = typeof e.message === 'string' ? e.message : '';
  for (const [re, code] of MESSAGES) if (re.test(msg)) return code;
  return null;
}

/** The text to show: the localised message for a known code, otherwise the original message (or a generic one). */
export function authErrorText(err: unknown, t: (key: string) => string): string {
  const code = authErrorCode(err);
  if (code) return t(`auth.error.${code}`);
  const msg = (err as { message?: unknown } | null)?.message;
  return typeof msg === 'string' && msg ? msg : t('auth.error.generic');
}
