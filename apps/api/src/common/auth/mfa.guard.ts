import { applyDecorators, CanActivate, ExecutionContext, Inject, Injectable, UseGuards } from '@nestjs/common';
import { ENV, type Env } from '../../config/env';
import { DbService } from '../db/db.service';
import { DomainError } from '../errors/domain-error';
import type { ResutoRequest } from './context';

/** Authenticator assurance level of a Supabase access token ('aal1' password/OAuth/link, 'aal2' + a verified factor). */
export function aalOf(claims: Record<string, unknown> | undefined): 'aal1' | 'aal2' {
  return claims?.aal === 'aal2' ? 'aal2' : 'aal1';
}

export const mfaRequired = () =>
  new DomainError('mfa_required', 'Enter the code from your authenticator app to continue', 403, { requiredAal: 'aal2' });

/**
 * AUTH-02: sensitive routes need a second factor from users who enrolled one. Supabase Auth issues `aal: "aal2"` only
 * after a TOTP challenge was verified in this session; a password-only session of the same user is `aal1`. Users
 * WITHOUT a verified factor are not locked out (MFA is opt-in on the Free plan; demo accounts have none).
 *
 * Runs after the global AccessGuard (route guards run after global ones), so the principal, platform role, tenant
 * membership and permission checks have already passed. The factor list is Supabase's own table (auth.mfa_factors),
 * read in the platform context like the other auth-schema reads. A database without that table is accepted as "no
 * factors" only when Supabase Auth is not configured (local dev issuer, which has no MFA); with Supabase configured the
 * table must exist, so a missing one fails closed.
 */
@Injectable()
export class MfaGuard implements CanActivate {
  constructor(private readonly db: DbService, @Inject(ENV) private readonly env: Env) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;
    const principal = context.switchToHttp().getRequest<ResutoRequest>().principal;
    // MCP keys never reach REST routes (AccessGuard); public routes have no principal to step up.
    if (!principal || principal.kind !== 'user') return true;
    if (aalOf(principal.claims) === 'aal2') return true;
    if (await this.hasVerifiedFactor(principal.userId)) throw mfaRequired();
    return true;
  }

  async hasVerifiedFactor(userId: string): Promise<boolean> {
    // app.user_has_verified_mfa: platform mode runs as resuto_platform, which has no rights in the auth schema; the
    // owner-defined function answers only this question (NULL when the factor table does not exist).
    return this.db.withPlatform(async (tx) => {
      const { verified } = await tx.one<{ verified: boolean | null }>(`select app.user_has_verified_mfa($1) as verified`, [userId]);
      if (verified === null) {
        if (this.env.SUPABASE_URL) throw new DomainError('mfa_check_unavailable', 'Two-step verification could not be checked. Please retry shortly.', 503, { retryAfterSeconds: 5 });
        return false;
      }
      return verified;
    });
  }
}

/**
 * The route (or every route of the controller) needs aal2 from a user with a verified factor: platform administration,
 * payment / integration credentials, MCP keys and OAuth grants, and role grants. Answers 403 `mfa_required`, which the
 * web turns into the authenticator-code step.
 */
export const RequireMfa = () => applyDecorators(UseGuards(MfaGuard));
