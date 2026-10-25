import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ROLES, can } from '@resuto/contracts';
import { SAVED_REPORT_LIMIT_PER_USER } from '@resuto/contracts/reports';
import { RateLimiter } from '../src/common/http/rate-limiter';
import { REPORT_WRITES_PER_MINUTE } from '../src/modules/analytics/reports.controller';
import { addMember, auth, bootTestApp, createTenant, sql, type TestApp, type TestTenant, type TestUser } from './helpers';
import { addBranch } from './insights-fixtures';

// 21-INSIGHTS: saved Insights reports (GET/POST /o/:orgId/reports, GET/PATCH/DELETE /o/:orgId/reports/:id). Private by
// default; a shared report is visible to colleagues who may read analytics; only its author changes or deletes it;
// branch-scoped staff never see or save a report pinned to another branch; other restaurants see nothing.

let t: TestApp;
beforeAll(async () => { t = await bootTestApp(); });
afterAll(async () => { await t.close(); });

const view = { period: '7d', compare: 'last_year' };

describe('saved reports', () => {
  let tenant: TestTenant;
  let north: string;
  let manager: TestUser;
  let accountant: TestUser;
  let cashier: TestUser;
  let scoped: TestUser;
  let url: string;
  const create = (u: TestUser, body: Record<string, unknown>) => t.http.post(url).set(auth(u)).send(body);
  const list = (u: TestUser, query = '') => t.http.get(`${url}${query}`).set(auth(u));

  beforeAll(async () => {
    tenant = await createTenant(t, { country: 'EG' });
    north = await addBranch(t, tenant, 'North');
    manager = await addMember(t, tenant, 'manager');
    accountant = await addMember(t, tenant, 'accountant');
    cashier = await addMember(t, tenant, 'cashier');
    scoped = await addMember(t, tenant, 'manager', [tenant.branchId]);
    url = `/v1/o/${tenant.orgId}/reports`;
  });

  it('saves a view privately by default and reopens it', async () => {
    const res = await create(tenant.owner, { name: 'Weekend sales', section: 'sales', view });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ name: 'Weekend sales', section: 'sales', view: { period: '7d', compare: 'last_year', filters: {} },
      branchId: null, shared: false, mine: true, authorName: null });
    const one = await t.http.get(`${url}/${res.body.id}`).set(auth(tenant.owner));
    expect(one.status).toBe(200);
    expect(one.body).toEqual(res.body);
    const mine = await list(tenant.owner);
    expect(mine.body.items.map((r: any) => r.name)).toContain('Weekend sales');
    expect(mine.body.nextCursor).toBeNull();
    // Private: a colleague neither lists nor opens it.
    expect((await list(manager)).body.items).toEqual([]);
    expect((await t.http.get(`${url}/${res.body.id}`).set(auth(manager))).status).toBe(404);
    const [row] = await sql(`select user_id, shared from saved_reports where id = $1`, [res.body.id]);
    expect(row).toEqual({ user_id: tenant.owner.userId, shared: false });
    const [log] = await sql(`select action, metadata from audit_logs where entity_id = $1`, [res.body.id]);
    expect(log).toMatchObject({ action: 'insights.report_saved', metadata: { section: 'sales', shared: false } });
  });

  it('a shared report is visible to colleagues who may read analytics, read-only for them', async () => {
    const res = await create(tenant.owner, { name: 'Team forecast', section: 'forecast', view: { period: '30d', filters: { horizon: '14' } }, shared: true });
    expect(res.status).toBe(201);
    const id = res.body.id;
    for (const u of [manager, accountant]) {
      const seen = (await list(u)).body.items.find((r: any) => r.id === id);
      expect(seen).toMatchObject({ name: 'Team forecast', shared: true, mine: false, view: { filters: { horizon: '14' } } });
      expect(typeof seen.authorName).toBe('string');
      // Only the author changes or deletes it.
      expect((await t.http.patch(`${url}/${id}`).set(auth(u)).send({ name: 'Mine now' })).status).toBe(404);
      expect((await t.http.delete(`${url}/${id}`).set(auth(u))).status).toBe(404);
    }
    // A role without analytics:read is refused outright.
    expect((await list(cashier)).status).toBe(403);
    expect((await t.http.get(`${url}/${id}`).set(auth(cashier))).status).toBe(403);
    expect((await create(cashier, { name: 'x', section: 'sales', view })).status).toBe(403);
    // Filters: own vs colleagues'.
    expect((await list(manager, '?owner=mine')).body.items).toEqual([]);
    expect((await list(manager, '?owner=shared')).body.items.map((r: any) => r.id)).toEqual([id]);
    expect((await list(tenant.owner, '?section=forecast')).body.items.map((r: any) => r.id)).toEqual([id]);
    // Unsharing hides it again.
    const unshared = await t.http.patch(`${url}/${id}`).set(auth(tenant.owner)).send({ shared: false });
    expect(unshared.status).toBe(200);
    expect(unshared.body.shared).toBe(false);
    expect((await list(manager)).body.items.find((r: any) => r.id === id)).toBeUndefined();
  });

  it('the author renames, re-saves the view and deletes; names are unique per member', async () => {
    const a = await create(manager, { name: 'Lunch', section: 'menu', view: { period: 'today' } });
    expect((await create(manager, { name: 'lunch', section: 'sales', view })).status).toBe(409);
    expect((await create(manager, { name: 'lunch', section: 'sales', view })).body.error.code).toBe('saved_report_name_taken');
    // Another member may use the same name.
    expect((await create(accountant, { name: 'Lunch', section: 'menu', view: { period: 'today' } })).status).toBe(201);
    const b = await create(manager, { name: 'Dinner', section: 'menu', view: { period: 'today' } });
    expect((await t.http.patch(`${url}/${b.body.id}`).set(auth(manager)).send({ name: 'LUNCH' })).status).toBe(409);
    const custom = { period: 'custom', from: '2026-09-01', to: '2026-09-30', compare: 'none' };
    const upd = await t.http.patch(`${url}/${a.body.id}`).set(auth(manager)).send({ name: 'Lunch (Sept)', view: custom });
    expect(upd.status).toBe(200);
    expect(upd.body).toMatchObject({ name: 'Lunch (Sept)', section: 'menu', view: { ...custom, filters: {} } });
    // A filter the section does not keep is refused on update too.
    expect((await t.http.patch(`${url}/${a.body.id}`).set(auth(manager)).send({ view: { period: '7d', filters: { horizon: '7' } } })).status).toBe(400);
    expect((await t.http.patch(`${url}/${a.body.id}`).set(auth(manager)).send({ section: 'sales' })).status).toBe(400);
    const del = await t.http.delete(`${url}/${a.body.id}`).set(auth(manager));
    expect(del.status).toBe(200);
    expect(del.body).toEqual({ id: a.body.id, deleted: true });
    expect((await t.http.get(`${url}/${a.body.id}`).set(auth(manager))).status).toBe(404);
    expect((await t.http.delete(`${url}/${a.body.id}`).set(auth(manager))).status).toBe(404);
  });

  it('branch scope: a report pinned to another branch is never visible or savable for branch-scoped staff', async () => {
    const pinned = await create(tenant.owner, { name: 'North weekly', section: 'sales', view, branchId: north, shared: true });
    expect(pinned.status).toBe(201);
    expect(pinned.body.branchId).toBe(north);
    const everywhere = await create(tenant.owner, { name: 'All branches weekly', section: 'sales', view, shared: true });
    const seen = (await list(scoped)).body.items.map((r: any) => r.id);
    expect(seen).toContain(everywhere.body.id);
    expect(seen).not.toContain(pinned.body.id);
    expect((await t.http.get(`${url}/${pinned.body.id}`).set(auth(scoped))).status).toBe(404);
    expect((await create(scoped, { name: 'North', section: 'sales', view, branchId: north })).status).toBe(403);
    const own = await create(scoped, { name: 'Main', section: 'sales', view, branchId: tenant.branchId });
    expect(own.status).toBe(201);
    expect((await t.http.patch(`${url}/${own.body.id}`).set(auth(scoped)).send({ branchId: north })).status).toBe(403);
    // A branch of another restaurant or a made-up one.
    const other = await createTenant(t, { country: 'EG' });
    const res = await create(tenant.owner, { name: 'Foreign', section: 'sales', view, branchId: other.branchId });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('unknown_branch');
  });

  it('other restaurants, signed-out callers and invalid bodies are refused', async () => {
    const other = await createTenant(t, { country: 'EG' });
    const mine = await create(tenant.owner, { name: 'Secret', section: 'sales', view, shared: true });
    expect([403, 404]).toContain((await list(other.owner)).status);
    expect([403, 404]).toContain((await t.http.get(`${url}/${mine.body.id}`).set(auth(other.owner))).status);
    expect([403, 404]).toContain((await t.http.patch(`${url}/${mine.body.id}`).set(auth(other.owner)).send({ name: 'x' })).status);
    expect([403, 404]).toContain((await t.http.delete(`${url}/${mine.body.id}`).set(auth(other.owner))).status);
    // Their own restaurant's list does not contain it (the id is not reachable through their org either).
    const own = await t.http.get(`/v1/o/${other.orgId}/reports`).set(auth(other.owner));
    expect(own.status).toBe(200);
    expect(own.body.items).toEqual([]);
    expect((await t.http.get(`/v1/o/${other.orgId}/reports/${mine.body.id}`).set(auth(other.owner))).status).toBe(404);
    expect((await t.http.get(url)).status).toBe(401);
    expect((await t.http.post(url).send({ name: 'x', section: 'sales', view })).status).toBe(401);
    expect((await t.http.get(`${url}/not-a-uuid`).set(auth(tenant.owner))).status).toBe(400);
    for (const body of [
      {}, { name: 'x', section: 'roi', view }, { name: 'x', section: 'sales', view: { period: 'custom' } },
      { name: 'x', section: 'sales', view: { period: '7d', filters: { gramsPerSheet: '4' } } }, { name: 'x', section: 'sales', view, userId: other.owner.userId },
      { name: '   ', section: 'sales', view }, { name: 'x', section: 'sales', view: { period: '7d', from: '2026-01-01', to: '2026-01-02' } },
    ]) expect((await create(tenant.owner, body)).status, JSON.stringify(body)).toBe(400);
  });

  it('limits reports per member and writes per minute', async () => {
    const member = await addMember(t, tenant, 'marketing');
    await sql(`insert into saved_reports(org_id, user_id, name, section, view) select $1, $2, 'r' || g, 'sales', '{}' from generate_series(1, $3) g`,
      [tenant.orgId, member.userId, SAVED_REPORT_LIMIT_PER_USER]);
    const res = await create(member, { name: 'One more', section: 'sales', view });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('saved_report_limit_reached');
    // Colleagues are not affected by someone else's count.
    expect((await create(accountant, { name: 'Still fine', section: 'sales', view })).status).toBe(201);
    const fast = await addMember(t, tenant, 'manager');
    const limiter = t.app.get(RateLimiter);
    for (let i = 0; i < REPORT_WRITES_PER_MINUTE; i++) limiter.hit(`reports:${tenant.orgId}:${fast.userId}`, REPORT_WRITES_PER_MINUTE);
    expect((await create(fast, { name: 'Too fast', section: 'sales', view })).status).toBe(429);
    expect((await list(fast)).status).toBe(200);
  });

  it('the database\'s analytics readers are exactly the roles with analytics:read', async () => {
    const [{ src }] = await sql(`select prosrc as src from pg_proc where proname = 'can_read_analytics'`);
    const listed = [...String(src).match(/role in \(([^)]*)\)/)![1]!.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort();
    expect(listed).toEqual(ROLES.filter((r) => can(r, 'analytics:read')).sort());
  });
});
