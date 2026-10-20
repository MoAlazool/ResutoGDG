import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addMember, auth, bootTestApp, createTenant, signup, sql, type TestApp } from './helpers';

let t: TestApp;
beforeAll(async () => { t = await bootTestApp(); });
afterAll(async () => { await t.close(); });

describe('auth', () => {
  it('rejects missing and forged tokens', async () => {
    expect((await t.http.get('/v1/me')).status).toBe(401);
    const forged = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIiwicm9sZSI6ImF1dGhlbnRpY2F0ZWQifQ.c2lnbmF0dXJl';
    expect((await t.http.get('/v1/me').set('Authorization', `Bearer ${forged}`)).status).toBe(401);
  });

  it('signs up, logs in and returns the profile', async () => {
    const u = await signup(t, 'alice');
    const login = await t.http.post('/v1/auth/dev/login').send({ email: u.email, password: 'correct-horse-battery' });
    expect(login.status).toBe(200);
    const me = await t.http.get('/v1/me').set(auth({ token: login.body.accessToken }));
    expect(me.status).toBe(200);
    expect(me.body.user.email).toBe(u.email);
    expect(me.body.memberships).toEqual([]);
    expect((await t.http.post('/v1/auth/dev/login').send({ email: u.email, password: 'wrong-password-123' })).status).toBe(401);
  });

  it('serves a health check', async () => {
    const res = await t.http.get('/v1/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body).toMatchObject({ environment: 'test', paymentMode: 'sandbox' });
  });
});

describe('restaurant onboarding', () => {
  it('creates an organization with branch, subscription, tax profile, menu and website atomically', async () => {
    const tenant = await createTenant(t, { name: 'Olive Room', country: 'SA' });
    const org = await t.http.get(`/v1/o/${tenant.orgId}`).set(auth(tenant.owner));
    expect(org.status).toBe(200);
    expect(org.body).toMatchObject({ name: 'Olive Room', country: 'SA', currency: 'SAR', timezone: 'Asia/Riyadh', role: 'owner', status: 'onboarding' });
    expect(org.body.branches).toHaveLength(1);
    const me = await t.http.get('/v1/me').set(auth(tenant.owner));
    expect(me.body.memberships[0]).toMatchObject({ orgId: tenant.orgId, role: 'owner' });
  });

  it('rejects duplicate slugs', async () => {
    const tenant = await createTenant(t);
    const res = await t.http.post('/v1/orgs').set(auth(tenant.owner)).send({ name: 'Copy', slug: tenant.slug, country: 'EG', branch: { name: 'Main' } });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('slug_taken');
  });

  it('validates input with shared contracts', async () => {
    const u = await signup(t);
    const res = await t.http.post('/v1/orgs').set(auth(u)).send({ name: '', slug: 'Bad Slug!', country: 'FR', branch: {} });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('validation_failed');
  });

  it('enforces plan branch limits on the backend', async () => {
    const tenant = await createTenant(t, { planId: 'starter' });
    const res = await t.http.post(`/v1/o/${tenant.orgId}/branches`).set(auth(tenant.owner)).send({ name: 'Second' });
    expect(res.status).toBe(402);
    expect(res.body.error.code).toBe('plan_limit_reached');
  });
});

describe('tenant isolation and RBAC', () => {
  it('hides other tenants behind 404', async () => {
    const a = await createTenant(t);
    const b = await createTenant(t);
    const res = await t.http.get(`/v1/o/${b.orgId}`).set(auth(a.owner));
    expect(res.status).toBe(404);
    expect((await t.http.get(`/v1/o/not-a-uuid`).set(auth(a.owner))).status).toBe(404);
  });

  it('applies role permissions and branch scope', async () => {
    const tenant = await createTenant(t);
    const second = await t.http.post(`/v1/o/${tenant.orgId}/branches`).set(auth(tenant.owner)).send({ name: 'North' });
    expect(second.status).toBe(201);
    const kitchen = await addMember(t, tenant, 'kitchen', [tenant.branchId]);
    expect((await t.http.get(`/v1/o/${tenant.orgId}/members`).set(auth(kitchen))).status).toBe(403);
    const org = await t.http.get(`/v1/o/${tenant.orgId}`).set(auth(kitchen));
    expect(org.body.branches.map((b: any) => b.id)).toEqual([tenant.branchId]);
    const patch = await t.http.patch(`/v1/o/${tenant.orgId}/branches/${second.body.id}`).set(auth(tenant.owner)).send({ name: 'North Coast' });
    expect(patch.body.name).toBe('North Coast');
  });

  it('prevents privilege escalation through invitations and member updates', async () => {
    const tenant = await createTenant(t);
    const manager = await addMember(t, tenant, 'manager');
    expect((await t.http.post(`/v1/o/${tenant.orgId}/invitations`).set(auth(manager)).send({ email: 'x@example.test', role: 'admin' })).status).toBe(403);
    const admin = await addMember(t, tenant, 'admin');
    expect((await t.http.post(`/v1/o/${tenant.orgId}/invitations`).set(auth(admin)).send({ email: 'y@example.test', role: 'admin' })).status).toBe(403);
    expect((await t.http.post(`/v1/o/${tenant.orgId}/invitations`).set(auth(admin)).send({ email: 'y@example.test', role: 'owner' })).status).toBe(400);
    const members = await t.http.get(`/v1/o/${tenant.orgId}/members`).set(auth(tenant.owner));
    const ownerRow = members.body.members.find((m: any) => m.role === 'owner');
    expect((await t.http.patch(`/v1/o/${tenant.orgId}/members/${ownerRow.id}`).set(auth(admin)).send({ status: 'suspended' })).status).toBe(403);
  });

  // Audit PS-09: invite and updateMember only checked that branch ids existed, so an admin restricted to one branch
  // could invite or promote people with all-branch (null) or other-branch access.
  it('keeps a branch-restricted admin inside their own branches', async () => {
    const tenant = await createTenant(t);
    const north = (await t.http.post(`/v1/o/${tenant.orgId}/branches`).set(auth(tenant.owner)).send({ name: 'North' })).body.id as string;
    const admin = await addMember(t, tenant, 'admin', [tenant.branchId]);
    const invite = (body: Record<string, unknown>) => t.http.post(`/v1/o/${tenant.orgId}/invitations`).set(auth(admin)).send({ role: 'waiter', ...body });

    expect((await invite({ email: 'n1@example.test', branchIds: [north] })).status).toBe(403);
    expect((await invite({ email: 'n2@example.test', branchIds: [tenant.branchId, north] })).status).toBe(403);
    const all = await invite({ email: 'n3@example.test', branchIds: null });
    expect(all.status).toBe(201); // "all branches" narrows to the admin's own branches
    const own = await invite({ email: 'n4@example.test', branchIds: [tenant.branchId] });
    expect(own.status).toBe(201);
    const invs = await sql(`select email, branch_ids from invitations where org_id = $1 and email like 'n%@example.test' order by email`, [tenant.orgId]);
    expect(invs).toEqual([{ email: 'n3@example.test', branch_ids: [tenant.branchId] }, { email: 'n4@example.test', branch_ids: [tenant.branchId] }]);

    // members: one inside the admin's branch, one with all-branch access, one in another branch
    const inside = await addMember(t, tenant, 'waiter', [tenant.branchId]);
    const everywhere = await addMember(t, tenant, 'waiter', null);
    const elsewhere = await addMember(t, tenant, 'waiter', [north]);
    const members = (await t.http.get(`/v1/o/${tenant.orgId}/members`).set(auth(tenant.owner))).body.members as any[];
    const idOf = (u: { userId: string }) => members.find((m) => m.userId === u.userId).id as string;
    const patch = (u: { userId: string }, body: Record<string, unknown>) => t.http.patch(`/v1/o/${tenant.orgId}/members/${idOf(u)}`).set(auth(admin)).send(body);

    expect((await patch(inside, { branchIds: [north] })).status).toBe(403); // cannot widen to a branch they lack
    expect((await patch(inside, { branchIds: null })).body.branchIds).toEqual([tenant.branchId]); // narrows, never all
    expect((await patch(everywhere, { status: 'suspended' })).status).toBe(403); // all-branch member is out of scope
    expect((await patch(elsewhere, { role: 'cashier' })).status).toBe(403);
    expect((await t.http.delete(`/v1/o/${tenant.orgId}/members/${idOf(elsewhere)}`).set(auth(admin))).status).toBe(403);
    expect((await patch(inside, { role: 'cashier' })).body.role).toBe('cashier');
    const after = await sql(`select user_id, branch_ids, status from memberships where org_id = $1 and user_id = any($2)`, [tenant.orgId, [everywhere.userId, elsewhere.userId]]);
    expect(after.every((m) => m.status === 'active')).toBe(true);

    // an owner (all branches) still grants anything
    expect((await t.http.patch(`/v1/o/${tenant.orgId}/members/${idOf(inside)}`).set(auth(tenant.owner)).send({ branchIds: null })).body.branchIds).toBeNull();
    // invitations outside the admin's scope cannot be revoked by them
    const ownerInv = await t.http.post(`/v1/o/${tenant.orgId}/invitations`).set(auth(tenant.owner)).send({ email: 'north@example.test', role: 'waiter', branchIds: [north] });
    expect((await t.http.delete(`/v1/o/${tenant.orgId}/invitations/${ownerInv.body.id}`).set(auth(admin))).status).toBe(403);
  });

  it('rejects invitation tokens for a different email', async () => {
    const tenant = await createTenant(t);
    const inv = await t.http.post(`/v1/o/${tenant.orgId}/invitations`).set(auth(tenant.owner)).send({ email: 'someone@example.test', role: 'waiter' });
    const other = await signup(t, 'mallory');
    expect((await t.http.post('/v1/invitations/accept').set(auth(other)).send({ token: inv.body.token })).status).toBe(403);
  });

  it('records an audit trail readable only with audit permission', async () => {
    const tenant = await createTenant(t);
    await t.http.patch(`/v1/o/${tenant.orgId}`).set(auth(tenant.owner)).send({ legalName: 'Olive Room LLC' });
    const log = await t.http.get(`/v1/o/${tenant.orgId}/audit`).set(auth(tenant.owner));
    expect(log.body.items.map((e: any) => e.action)).toEqual(expect.arrayContaining(['organization.created', 'organization.updated']));
    const waiter = await addMember(t, tenant, 'waiter');
    expect((await t.http.get(`/v1/o/${tenant.orgId}/audit`).set(auth(waiter))).status).toBe(403);
  });
});

describe('invitations', () => {
  it('revokes a pending invitation so its token no longer works', async () => {
    const tenant = await createTenant(t);
    const invitee = await signup(t, 'invitee');
    const inv = await t.http.post(`/v1/o/${tenant.orgId}/invitations`).set(auth(tenant.owner)).send({ email: invitee.email, role: 'waiter' });
    const revoke = await t.http.delete(`/v1/o/${tenant.orgId}/invitations/${inv.body.id}`).set(auth(tenant.owner));
    expect(revoke.body).toEqual({ id: inv.body.id, status: 'revoked' });
    expect((await t.http.delete(`/v1/o/${tenant.orgId}/invitations/${inv.body.id}`).set(auth(tenant.owner))).status).toBe(409);
    expect((await t.http.post('/v1/invitations/accept').set(auth(invitee)).send({ token: inv.body.token })).status).toBe(422);
  });
});
