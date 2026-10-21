/**
 * AUTH-02: TOTP two-step verification through Supabase Auth MFA (available on every plan, including Free).
 *
 * Pure helpers over the few supabase-js calls involved, so the flows are unit-tested with a mocked client
 * (lib/auth/mfa.test.ts) and the session (lib/session.tsx) stays a thin wiring layer:
 * - `assuranceOf(session)` mirrors supabase-js getAuthenticatorAssuranceLevel() without a client call (it is used
 *   inside onAuthStateChange, where calling the client again can deadlock): current level from the token's `aal`
 *   claim, next level aal2 as soon as the user has a verified factor.
 * - enrolment, verification and removal; removal re-verifies a fresh code first.
 */
import { normalizeNumericInput } from '@resuto/contracts';
import { AuthFlowError } from '../auth-errors';

export interface MfaFactor { id: string; friendly_name?: string | null; factor_type: string; status: 'verified' | 'unverified' | string; created_at?: string }
export interface MfaSession { access_token: string; user?: { factors?: MfaFactor[] | null } | null }
type Result<T> = Promise<{ data: T | null; error: unknown }>;

/** The slice of the supabase-js client the MFA flows use. */
export interface MfaClient {
  auth: {
    mfa: {
      listFactors(): Result<{ all: MfaFactor[]; totp: MfaFactor[] }>;
      enroll(p: { factorType: 'totp'; friendlyName?: string; issuer?: string }): Result<{ id: string; type?: string; totp: { qr_code: string; secret: string; uri: string } }>;
      challengeAndVerify(p: { factorId: string; code: string }): Result<unknown>;
      unenroll(p: { factorId: string }): Result<unknown>;
    };
    refreshSession(): Result<{ session: MfaSession | null }>;
  };
}

export type Aal = 'aal1' | 'aal2';
export interface Assurance { current: Aal | null; next: Aal | null; required: boolean }

/** Claims of a JWT without verifying it (the API verifies; the browser only needs the `aal` claim). */
export function jwtClaims(token: string | null | undefined): Record<string, unknown> {
  try {
    const part = (token ?? '').split('.')[1];
    if (!part) return {};
    const b64 = part.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(part.length / 4) * 4, '=');
    return JSON.parse(typeof atob === 'function' ? atob(b64) : Buffer.from(b64, 'base64').toString()) as Record<string, unknown>;
  } catch { return {}; }
}

export function assuranceOf(session: MfaSession | null | undefined): Assurance {
  if (!session?.access_token) return { current: null, next: null, required: false };
  const current: Aal = jwtClaims(session.access_token).aal === 'aal2' ? 'aal2' : 'aal1';
  const verified = (session.user?.factors ?? []).some((f) => f.status === 'verified');
  const next: Aal = verified ? 'aal2' : current;
  return { current, next, required: current === 'aal1' && next === 'aal2' };
}

/** A 6-digit authenticator code from what was typed: Arabic-Indic digits become 0-9, spaces and dashes are ignored. */
export function normalizeTotpCode(input: string): string | null {
  const digits = normalizeNumericInput(input).replace(/[\s -]/g, '');
  return /^\d{6}$/.test(digits) ? digits : null;
}

/**
 * Supabase Auth returns the TOTP QR code as raw SVG markup and supabase-js prefixes it with
 * `data:image/svg+xml;utf-8,` without encoding it, so any `#` in the SVG (colours) ends the data URL and the image
 * does not render. Re-encode the SVG; already-encoded or other image URLs pass through.
 */
export function qrImageSrc(qr: string): string {
  const m = /^data:image\/svg\+xml;(?:utf-?8|charset=utf-?8),(.*)$/is.exec(qr);
  if (!m) return qr.trim().startsWith('<svg') ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(qr.trim())}` : qr;
  const body = m[1]!;
  return body.trim().startsWith('<') ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(body.trim())}` : qr;
}

/** "ABCD EFGH IJKL ..." for typing the secret by hand. */
export const groupSecret = (secret: string) => secret.replace(/\s+/g, '').replace(/(.{4})(?=.)/g, '$1 ');

const fail = (error: unknown): never => { throw error instanceof Error ? error : Object.assign(new Error(String((error as { message?: unknown })?.message ?? 'MFA request failed')), error as object); };

export interface TotpFactors { verified: MfaFactor[]; unverified: MfaFactor[] }

/** The user's TOTP factors, read fresh from Supabase Auth (getUser), not from the possibly stale session. */
export async function listTotp(client: MfaClient): Promise<TotpFactors> {
  const { data, error } = await client.auth.mfa.listFactors();
  if (error) fail(error);
  const totp = (data?.all ?? []).filter((f) => f.factor_type === 'totp');
  return { verified: totp.filter((f) => f.status === 'verified'), unverified: totp.filter((f) => f.status !== 'verified') };
}

export interface TotpEnrolment { factorId: string; qrCode: string; secret: string; uri: string }

/**
 * Starts adding an authenticator app. Leftover unverified factors (an enrolment that was abandoned) are removed first:
 * they are useless and block re-using the same name.
 */
export async function startTotpEnrolment(client: MfaClient, opts: { friendlyName: string; issuer?: string }): Promise<TotpEnrolment> {
  const { unverified } = await listTotp(client);
  for (const f of unverified) await client.auth.mfa.unenroll({ factorId: f.id });
  const { data, error } = await client.auth.mfa.enroll({ factorType: 'totp', friendlyName: opts.friendlyName, issuer: opts.issuer ?? 'Resuto' });
  if (error || !data) fail(error ?? new AuthFlowError('mfa_unavailable'));
  return { factorId: data!.id, qrCode: qrImageSrc(data!.totp.qr_code), secret: data!.totp.secret, uri: data!.totp.uri };
}

/** Checks a code for a factor (challenge + verify). On success Supabase Auth replaces the session with an aal2 one. */
export async function verifyTotp(client: MfaClient, factorId: string, input: string): Promise<void> {
  const code = normalizeTotpCode(input);
  if (!code) throw new AuthFlowError('mfa_code_format');
  const { error } = await client.auth.mfa.challengeAndVerify({ factorId, code });
  if (error) fail(error);
}

/** Cancels an enrolment that was never verified (no code needed: it never protected anything). */
export async function cancelTotpEnrolment(client: MfaClient, factorId: string): Promise<void> {
  const { error } = await client.auth.mfa.unenroll({ factorId });
  if (error) fail(error);
}

/**
 * Removes a verified authenticator: a fresh code from that factor is verified first (so an unattended signed-in
 * browser cannot switch two-step verification off), then the factor is deleted and the session refreshed so it no
 * longer lists it.
 */
export async function removeTotp(client: MfaClient, factorId: string, input: string): Promise<void> {
  await verifyTotp(client, factorId, input);
  const { error } = await client.auth.mfa.unenroll({ factorId });
  if (error) fail(error);
  await client.auth.refreshSession();
}

/** The code step after a password sign-in (or a 403 mfa_required): verifies against the user's first verified TOTP factor. */
export async function verifySignInCode(client: MfaClient, input: string): Promise<void> {
  if (!normalizeTotpCode(input)) throw new AuthFlowError('mfa_code_format');
  const { verified } = await listTotp(client);
  if (!verified.length) throw new AuthFlowError('mfa_no_factor');
  // Several authenticator apps may be enrolled: the code belongs to one of them.
  let first: unknown = null;
  for (const factor of verified) {
    try { await verifyTotp(client, factor.id, input); return; } catch (e) { first ??= e; }
  }
  throw first;
}
