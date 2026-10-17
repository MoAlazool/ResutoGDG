import { Inject, Injectable } from '@nestjs/common';
import { createRemoteJWKSet, jwtVerify, SignJWT, type JWTPayload } from 'jose';
import { ENV, type Env } from '../../config/env';

/**
 * Verifies Supabase Auth access tokens. Supports both legacy HS256 projects
 * (shared JWT secret) and asymmetric signing keys via the project's JWKS.
 */
@Injectable()
export class JwtService {
  private readonly secret?: Uint8Array;
  private readonly jwks?: ReturnType<typeof createRemoteJWKSet>;

  constructor(@Inject(ENV) private readonly env: Env) {
    if (env.SUPABASE_JWT_SECRET) this.secret = new TextEncoder().encode(env.SUPABASE_JWT_SECRET);
    if (env.SUPABASE_URL) this.jwks = createRemoteJWKSet(new URL('/auth/v1/.well-known/jwks.json', env.SUPABASE_URL));
  }

  async verify(token: string): Promise<JWTPayload & { sub: string; email?: string }> {
    const header = JSON.parse(Buffer.from(token.split('.')[0] ?? '', 'base64url').toString() || '{}');
    const options = { audience: this.env.SUPABASE_JWT_AUDIENCE };
    const { payload } = header.alg === 'HS256' && this.secret
      ? await jwtVerify(token, this.secret, { ...options, algorithms: ['HS256'] })
      : this.jwks
        ? await jwtVerify(token, this.jwks, { ...options, algorithms: ['RS256', 'ES256'] })
        : (() => { throw new Error('No verification key for this token'); })();
    if (typeof payload.sub !== 'string' || payload.role !== 'authenticated') throw new Error('Not an authenticated user token');
    return payload as JWTPayload & { sub: string; email?: string };
  }

  /** Mints a Supabase-compatible HS256 access token (dev auth and tests only). */
  async issue(userId: string, email: string | null, ttlSeconds = 3600): Promise<string> {
    if (!this.secret) throw new Error('SUPABASE_JWT_SECRET is required to issue tokens');
    return new SignJWT({ email, role: 'authenticated', aal: 'aal1', session_id: crypto.randomUUID() })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setSubject(userId)
      .setAudience(this.env.SUPABASE_JWT_AUDIENCE)
      .setIssuer(this.env.SUPABASE_URL ? `${this.env.SUPABASE_URL}/auth/v1` : 'resuto-dev-auth')
      .setIssuedAt()
      .setExpirationTime(`${ttlSeconds}s`)
      .sign(this.secret);
  }
}
