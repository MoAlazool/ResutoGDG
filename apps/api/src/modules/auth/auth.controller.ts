import { Body, Controller, Get, HttpCode, Inject, Post } from '@nestjs/common';
import type { MeResponse } from '@resuto/contracts';
import { z } from 'zod';
import { ENV, type Env } from '../../config/env';
import type { AuthPrincipal } from '../../common/auth/context';
import { Principal, Public } from '../../common/auth/decorators';
import { JwtService } from '../../common/auth/jwt.service';
import { hashPassword, verifyPassword } from '../../common/crypto/hash';
import { DbService } from '../../common/db/db.service';
import { DomainError, forbidden } from '../../common/errors/domain-error';
import { RateLimiter } from '../../common/http/rate-limiter';
import { zod } from '../../common/http/zod.pipe';

const credentials = z.object({
  email: z.email().transform((e) => e.toLowerCase()),
  password: z.string().min(10, 'Use at least 10 characters').max(200),
  fullName: z.string().trim().max(120).optional(),
});

const passwordChange = z.object({
  currentPassword: z.string().min(1).max(200),
  newPassword: z.string().min(10, 'Use at least 10 characters').max(200),
}).strict();

@Controller()
export class AuthController {
  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly db: DbService,
    private readonly jwt: JwtService,
    private readonly limiter: RateLimiter,
  ) {}

  /** Current user, memberships and platform role. Works for any valid Supabase token. */
  @Get('me')
  async me(@Principal() principal: AuthPrincipal): Promise<MeResponse> {
    if (principal.kind !== 'user') throw forbidden();
    return this.db.withPlatform(async (tx) => {
      const profile = await tx.maybeOne<any>(
        `insert into profiles(id, email) values ($1, $2) on conflict (id) do update set email = coalesce(profiles.email, excluded.email)
         returning full_name, locale`, [principal.userId, principal.email]);
      const memberships = await tx.query<any>(
        `select m.org_id, o.slug, o.name, m.role, m.branch_ids from memberships m join organizations o on o.id = m.org_id
          where m.user_id = $1 and m.status = 'active' and o.status not in ('closed', 'suspended') order by o.name`, [principal.userId]);
      const admin = await tx.maybeOne<{ role: string }>('select role from platform_admins where user_id = $1', [principal.userId]);
      return {
        user: { id: principal.userId, email: principal.email, fullName: profile?.full_name ?? null, locale: profile?.locale ?? 'en' },
        memberships: memberships.map((m) => ({ orgId: m.org_id, orgSlug: m.slug, orgName: m.name, role: m.role, branchIds: m.branch_ids })),
        platformRole: admin?.role ?? null,
      };
    });
  }

  // ---------------------------------------------------------------------------
  // Development-only issuer. Mints the same JWT shape Supabase Auth issues so the
  // whole stack runs locally without the Supabase platform. Disabled unless
  // AUTH_DEV_MODE=true, which env validation forbids in production.
  // ---------------------------------------------------------------------------
  @Public()
  @Post('auth/dev/signup')
  async devSignup(@Body(zod(credentials)) body: z.infer<typeof credentials>) {
    this.assertDevMode();
    this.limiter.hit(`dev-signup:${body.email}`, 10);
    const hash = await hashPassword(body.password);
    const user = await this.db.withPlatform(async (tx) => {
      const existing = await tx.maybeOne('select id from auth.users where email = $1', [body.email]);
      if (existing) throw new DomainError('email_taken', 'An account with this email already exists', 409);
      const u = await tx.one<{ id: string }>(
        `insert into auth.users(email, encrypted_password, email_confirmed_at, raw_user_meta_data) values ($1, $2, now(), $3) returning id`,
        [body.email, hash, { full_name: body.fullName ?? null }]);
      await tx.query('insert into profiles(id, full_name, email) values ($1, $2, $3)', [u.id, body.fullName ?? null, body.email]);
      return u;
    });
    return this.session(user.id, body.email);
  }

  @Public()
  @Post('auth/dev/login')
  @HttpCode(200)
  async devLogin(@Body(zod(credentials.pick({ email: true, password: true }))) body: { email: string; password: string }) {
    this.assertDevMode();
    this.limiter.hit(`dev-login:${body.email}`, 20);
    const user = await this.db.withPlatform((tx) =>
      tx.maybeOne<{ id: string; encrypted_password: string }>('select id, encrypted_password from auth.users where email = $1', [body.email]));
    if (!user || !(await verifyPassword(body.password, user.encrypted_password))) {
      throw new DomainError('invalid_credentials', 'Email or password is incorrect', 401);
    }
    return this.session(user.id, body.email);
  }

  /**
   * CR-05 change password for the development issuer (Supabase deployments change it through Supabase Auth
   * updateUser). Requires the current password. Passwords are never logged or returned.
   */
  @Post('auth/dev/password')
  @HttpCode(200)
  async devChangePassword(@Principal() principal: AuthPrincipal, @Body(zod(passwordChange)) body: z.infer<typeof passwordChange>) {
    this.assertDevMode();
    if (principal.kind !== 'user') throw forbidden();
    this.limiter.hit(`dev-password:${principal.userId}`, 10);
    await this.db.withPlatform(async (tx) => {
      const user = await tx.maybeOne<{ encrypted_password: string }>('select encrypted_password from auth.users where id = $1 for update', [principal.userId]);
      if (!user || !(await verifyPassword(body.currentPassword, user.encrypted_password))) {
        throw new DomainError('invalid_credentials', 'Current password is incorrect', 401);
      }
      if (body.currentPassword === body.newPassword) throw new DomainError('password_unchanged', 'Choose a password different from the current one', 400);
      await tx.query('update auth.users set encrypted_password = $2, updated_at = now() where id = $1', [principal.userId, await hashPassword(body.newPassword)]);
    });
    return { ok: true };
  }

  private async session(userId: string, email: string) {
    return { accessToken: await this.jwt.issue(userId, email, 8 * 3600), tokenType: 'bearer', expiresIn: 8 * 3600, user: { id: userId, email } };
  }

  private assertDevMode() {
    if (!this.env.AUTH_DEV_MODE) throw new DomainError('not_found', 'Not found', 404);
  }
}
