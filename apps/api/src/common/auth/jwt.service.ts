import { Inject, Injectable } from '@nestjs/common';
import { createRemoteJWKSet, jwtVerify, SignJWT, type JWTPayload } from 'jose';
import { ENV, type Env } from '../../config/env';

/**
 * Verifies Supabase Auth access tokens: asymmetric signing keys via the project's JWKS, or HS256 with the shared
 * secret when there is no project URL (local dev, tests) or AUTH_ALLOW_HS256 is set for a legacy-secret project.
 * Anonymous Supabase sessions (is_anonymous) are refused: every API caller is a real account (audit PS-25).
 */
@Injectable()
export class JwtService {
  private readonly secret?: Uint8Array;
  private readonly jwks?: ReturnType<typeof createRemoteJWKSet>;
  private readonly acceptHs256: boolean;

  constructor(@Inject(ENV) private readonly env: Env) {
    // The secret still signs dev tokens (issue()) whenever it is configured; verify() accepts HS256 only as allowed.
    if (env.SUPABASE_JWT_SECRET) this.secret = new TextEncoder().encode(env.SUPABASE_JWT_SECRET);
    this.acceptHs256 = !!this.secret && (!env.SUPABASE_URL || env.AUTH_ALLOW_HS256);
    if (env.SUPABASE_URL) this.jwks = createRemoteJWKSet(new URL('/auth/v1/.well-known/jwks.json', env.SUPABASE_URL));
  }

  /** Supabase Auth issues tokens as `<project URL>/auth/v1`; the dev issuer uses its own name. */
  private get issuer(): string {
    return this.env.SUPABASE_URL ? `${this.env.SUPABASE_URL.replace(/\/$/, '')}/auth/v1` : 'resuto-dev-auth';
  }

  async verify(token: string): Promise<JWTPayload & { sub: string; email?: string }> {
    const header = JSON.parse(Buffer.from(token.split('.')[0] ?? '', 'base64url').toString() || '{}');
    const options = { audience: this.env.SUPABASE_JWT_AUDIENCE, issuer: this.issuer };
    const { payload } = header.alg === 'HS256' && this.acceptHs256
      ? await jwtVerify(token, this.secret!, { ...options, algorithms: ['HS256'] })
      : this.jwks
        ? await jwtVerify(token, this.jwks, { ...options, algorithms: ['RS256', 'ES256'] })
        : (() => { throw new Error('No verification key for this token'); })();
    if (typeof payload.sub !== 'string' || payload.role !== 'authenticated') throw new Error('Not an authenticated user token');
    if (payload.is_anonymous === true) throw new Error('Anonymous sessions cannot use the API');
    return payload as JWTPayload & { sub: string; email?: string };
  }

  /**
   * Mints a Supabase-compatible HS256 access token (dev auth and tests only). The dev issuer has no second factor, so
   * its sessions are aal1; tests pass `aal: 'aal2'` to stand in for a Supabase session that verified a TOTP code.
   */
  async issue(userId: string, email: string | null, ttlSeconds = 3600, opts: { aal?: 'aal1' | 'aal2' } = {}): Promise<string> {
    if (!this.secret) throw new Error('SUPABASE_JWT_SECRET is required to issue tokens');
    return new SignJWT({ email, role: 'authenticated', aal: opts.aal ?? 'aal1', session_id: crypto.randomUUID() })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setSubject(userId)
      .setAudience(this.env.SUPABASE_JWT_AUDIENCE)
      .setIssuer(this.issuer)
      .setIssuedAt()
      .setExpirationTime(`${ttlSeconds}s`)
      .sign(this.secret);
  }
}
