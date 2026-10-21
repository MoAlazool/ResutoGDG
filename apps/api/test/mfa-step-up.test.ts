import 'reflect-metadata';
import { GUARDS_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { DiscoveryService, MetadataScanner, Reflector } from '@nestjs/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PLATFORM_ROLE } from '../src/common/auth/decorators';
import { JwtService } from '../src/common/auth/jwt.service';
import { aalOf, MfaGuard } from '../src/common/auth/mfa.guard';
import { DomainError } from '../src/common/errors/domain-error';
import { addMember, auth, bootTestApp, createTenant, signup, sql, type TestApp, type TestTenant, type TestUser } from './helpers';

// AUTH-02: Supabase Auth TOTP MFA (all plans). Sensitive routes need an aal2 session from users who enrolled a factor;
// users without a verified factor (and the demo accounts) keep working with aal1. The web turns 403 mfa_required into
// the authenticator-code step.

let t: TestApp;
let jwt: JwtService;
let a: TestTenant;
let ownerAal2: { token: string };

const verifiedFactor = (userId: string, status: 'verified' | 'unverified' = 'verified') =>
  sql(`insert into auth.mfa_factors(user_id, friendly_name, factor_type, status) values ($1, 'Authenticator app', 'totp', $2)`, [userId, status]);
const aal2 = async (u: TestUser) => ({ token: await jwt.issue(u.userId, u.email, 600, { aal: 'aal2' }) });
const inviteBody = () => ({ email: `invitee-${Math.random().toString(36).slice(2)}@example.test`, role: 'waiter', branchIds: null });

beforeAll(async () => {
  t = await bootTestApp();
  jwt = t.app.get(JwtService);
  a = await createTenant(t, { name: 'Step-up Bistro' });
  ownerAal2 = await aal2(a.owner);
});
afterAll(async () => { await t?.close(); });

describe('owners without a verified factor are not locked out', () => {
  it('aal1 sessions create invitations, MCP keys and change roles as before', async () => {
    expect((await t.http.post(`/v1/o/${a.orgId}/invitations`).set(auth(a.owner)).send(inviteBody())).status).toBe(201);
    const key = await t.http.post(`/v1/o/${a.orgId}/mcp/clients`).set(auth(a.owner))
      .send({ name: 'Assistant', actingRole: 'manager', allowedTools: ['list_orders'], rateLimitPerMin: 60 });
    expect(key.status, JSON.stringify(key.body)).toBe(201);
  });

  it('an enrolled-but-never-verified factor does not count', async () => {
    const u = await createTenant(t, { name: 'Half Enrolled' });
    await verifiedFactor(u.owner.userId, 'unverified');
    expect((await t.http.post(`/v1/o/${u.orgId}/invitations`).set(auth(u.owner)).send(inviteBody())).status).toBe(201);
  });
});

describe('users with a verified factor need aal2 on sensitive routes', () => {
  let b: TestTenant;
  let bAal2: { token: string };
  beforeAll(async () => {
    b = await createTenant(t, { name: 'Factor Grill' });
    await verifiedFactor(b.owner.userId);
    bAal2 = await aal2(b.owner);
  });

  it('refuses an aal1 session with 403 mfa_required in the standard error envelope', async () => {
    const res = await t.http.post(`/v1/o/${b.orgId}/invitations`).set(auth(b.owner)).send(inviteBody());
    expect(res.status).toBe(403);
    expect(res.body.error).toMatchObject({ code: 'mfa_required', details: { requiredAal: 'aal2' } });
    expect(res.body.error.requestId).toBeTruthy();
    expect(res.body.error.requestId).toBe(res.headers['x-request-id']);
    const pending = await sql(`select count(*)::int as n from invitations where org_id = $1`, [b.orgId]);
    expect(pending[0].n).toBe(0);   // nothing was created
  });

  it('accepts the same request from an aal2 session of the same user', async () => {
    expect((await t.http.post(`/v1/o/${b.orgId}/invitations`).set(auth(bAal2)).send(inviteBody())).status).toBe(201);
  });

  it('covers MCP keys, MCP OAuth grants, integration credentials and role changes (checked before the body is validated)', async () => {
    const fake = '00000000-0000-4000-8000-000000000001';
    const routes: Array<[string, string]> = [
      ['post', `/v1/o/${b.orgId}/mcp/clients`],
      ['patch', `/v1/o/${b.orgId}/mcp/clients/${fake}`],
      ['post', `/v1/o/${b.orgId}/mcp/oauth/requests/${fake}/approve`],
      ['post', `/v1/o/${b.orgId}/integrations/connections`],
      ['patch', `/v1/o/${b.orgId}/integrations/connections/${fake}`],
      ['post', `/v1/o/${b.orgId}/integrations/oauth/meta/start`],
      ['post', `/v1/o/${b.orgId}/integrations/oauth/meta/complete`],
      ['post', `/v1/o/${b.orgId}/integrations/connections/${fake}/account`],
      ['patch', `/v1/o/${b.orgId}/members/${fake}`],
    ];
    for (const [verb, path] of routes) {
      const weak = await (t.http as any)[verb](path).set(auth(b.owner)).send({});
      expect(weak.status, `${verb} ${path}`).toBe(403);
      expect(weak.body.error.code, `${verb} ${path}`).toBe('mfa_required');
      const strong = await (t.http as any)[verb](path).set(auth(bAal2)).send({});
      expect(strong.body.error?.code, `${verb} ${path} with aal2`).not.toBe('mfa_required');
    }
  });

  it('leaves everyday routes on aal1 (the web asks for the code at sign-in; see docs/SECURITY_AUTH.md)', async () => {
    expect((await t.http.get('/v1/me').set(auth(b.owner))).status).toBe(200);
    expect((await t.http.get(`/v1/o/${b.orgId}/members`).set(auth(b.owner))).status).toBe(200);
  });

  it('runs after access control: a member without the permission gets forbidden, not a code prompt', async () => {
    // The owner (who has a factor) invites with an aal2 session.
    const waiter = await addMember(t, { ...b, owner: { ...b.owner, token: bAal2.token } }, 'waiter');
    await verifiedFactor(waiter.userId);
    const res = await t.http.post(`/v1/o/${b.orgId}/invitations`).set(auth(waiter)).send(inviteBody());
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('forbidden');
    // And a stranger to the restaurant still gets not-found (no tenant enumeration through the MFA check).
    const stranger = await signup(t, 'stranger');
    await verifiedFactor(stranger.userId);
    expect((await t.http.post(`/v1/o/${b.orgId}/invitations`).set(auth(stranger)).send(inviteBody())).status).toBe(404);
  });
});

describe('platform administration', () => {
  it('needs aal2 from an administrator with a verified factor, and not from one without', async () => {
    const withFactor = await signup(t, 'pa-mfa');
    const without = await signup(t, 'pa-plain');
    await sql(`insert into platform_admins(user_id, role) values ($1, 'support'), ($2, 'support')`, [withFactor.userId, without.userId]);
    await verifiedFactor(withFactor.userId);
    const weak = await t.http.get('/v1/admin/me').set(auth(withFactor));
    expect(weak.status).toBe(403);
    expect(weak.body.error.code).toBe('mfa_required');
    expect((await t.http.get('/v1/admin/sales-inquiries').set(auth(withFactor))).body.error.code).toBe('mfa_required');
    expect((await t.http.get('/v1/admin/me').set(auth(await aal2(withFactor)))).status).toBe(200);
    expect((await t.http.get('/v1/admin/me').set(auth(without))).status).toBe(200);
    // A non-admin with aal2 is still refused by the platform role check.
    const nobody = await signup(t, 'not-admin');
    expect((await t.http.get('/v1/admin/me').set(auth(await aal2(nobody)))).body.error.code).toBe('forbidden');
  });

  it('every platform-admin route carries the MFA step-up guard (regression: a new admin route cannot miss it)', () => {
    const discovery = t.app.get(DiscoveryService);
    const scanner = t.app.get(MetadataScanner);
    const reflector = t.app.get(Reflector);
    const missing: string[] = [];
    let checked = 0;
    for (const wrapper of discovery.getControllers()) {
      const cls = wrapper.metatype as any;
      if (!cls) continue;
      for (const name of scanner.getAllMethodNames(cls.prototype)) {
        const handler = cls.prototype[name];
        if (Reflect.getMetadata(METHOD_METADATA, handler) === undefined) continue;
        if (!reflector.getAllAndOverride(PLATFORM_ROLE, [handler, cls])) continue;
        checked++;
        const guards = [...(Reflect.getMetadata(GUARDS_METADATA, cls) ?? []), ...(Reflect.getMetadata(GUARDS_METADATA, handler) ?? [])];
        if (!guards.includes(MfaGuard)) missing.push(`${cls.name}.${name} ${Reflect.getMetadata(PATH_METADATA, handler) ?? ''}`);
      }
    }
    expect(checked).toBeGreaterThan(5);
    expect(missing).toEqual([]);
  });
});

describe('MfaGuard details', () => {
  it('reads aal from the token claims (anything but aal2 is aal1)', () => {
    expect(aalOf({ aal: 'aal2' })).toBe('aal2');
    expect(aalOf({ aal: 'aal1' })).toBe('aal1');
    expect(aalOf({})).toBe('aal1');
    expect(aalOf(undefined)).toBe('aal1');
  });

  it('without auth.mfa_factors: "no factors" for the dev issuer, fail closed when Supabase Auth is configured', async () => {
    const db = { withPlatform: (fn: any) => fn({ one: async () => ({ present: false }), maybeOne: async () => { throw new Error('not reached'); } }) };
    await expect(new MfaGuard(db as any, { SUPABASE_URL: undefined } as any).hasVerifiedFactor('u')).resolves.toBe(false);
    const err = await new MfaGuard(db as any, { SUPABASE_URL: 'https://ref.supabase.co' } as any).hasVerifiedFactor('u').catch((e) => e);
    expect(err).toBeInstanceOf(DomainError);
    expect(err).toMatchObject({ code: 'mfa_check_unavailable', status: 503 });
  });

  it('dev-issued tokens are aal1 unless a test asks for aal2', async () => {
    const decode = (tok: string) => JSON.parse(Buffer.from(tok.split('.')[1]!, 'base64url').toString());
    expect(decode(a.owner.token).aal).toBe('aal1');
    expect(decode(ownerAal2.token).aal).toBe('aal2');
  });
});
