import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootTestApp, createTenant, sql, type TestApp } from './helpers';

// CR-13: legacy counter restaurants printed their venue QR as <origin>/t/<venueQr>. The migration records the token
// (legacy_id_map, entity venue_qr → branch); GET /v1/public/venue/:token resolves it to the FT-07 venue route.
let t: TestApp;
beforeAll(async () => { t = await bootTestApp(); });
afterAll(async () => { await t?.close(); });

const token = () => `${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`.padEnd(32, '0').slice(0, 32);

describe('legacy venue QR resolution (CR-13)', () => {
  it('resolves a migrated venue token to the branch ordering page', async () => {
    const a = await createTenant(t);
    const venue = token();
    await sql(`insert into legacy_id_map(org_id, entity_type, legacy_id, new_id) values ($1, 'venue_qr', $2, $3)`, [a.orgId, venue, a.branchId]);
    const [b] = await sql<{ code: string }>(`select code from branches where id = $1`, [a.branchId]);
    const res = await t.http.get(`/v1/public/venue/${venue}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ slug: a.slug, branchCode: b.code, path: `/order/${a.slug}?branch=${b.code}` });
  });

  it('answers 404 for unknown, malformed, ambiguous or closed venues', async () => {
    expect((await t.http.get(`/v1/public/venue/${token()}`)).status).toBe(404);
    expect((await t.http.get('/v1/public/venue/short')).status).toBe(404);
    expect((await t.http.get(`/v1/public/venue/${'x'.repeat(20)}%27%20or%201=1`)).status).toBe(404);
    const a = await createTenant(t), b = await createTenant(t);
    const shared = token();
    await sql(`insert into legacy_id_map(org_id, entity_type, legacy_id, new_id) values ($1, 'venue_qr', $3, $2)`, [a.orgId, a.branchId, shared]);
    await sql(`insert into legacy_id_map(org_id, entity_type, legacy_id, new_id) values ($1, 'venue_qr', $3, $2)`, [b.orgId, b.branchId, shared]);
    expect((await t.http.get(`/v1/public/venue/${shared}`)).status).toBe(404);
    const c = await createTenant(t);
    const closed = token();
    await sql(`insert into legacy_id_map(org_id, entity_type, legacy_id, new_id) values ($1, 'venue_qr', $2, $3)`, [c.orgId, closed, c.branchId]);
    await sql(`update organizations set status = 'suspended' where id = $1`, [c.orgId]);
    expect((await t.http.get(`/v1/public/venue/${closed}`)).status).toBe(404);
  });

  it('does not resolve a table QR or any other legacy id', async () => {
    const a = await createTenant(t);
    const other = token();
    await sql(`insert into legacy_id_map(org_id, entity_type, legacy_id, new_id) values ($1, 'table', $2, $3)`, [a.orgId, other, a.branchId]);
    expect((await t.http.get(`/v1/public/venue/${other}`)).status).toBe(404);
  });
});
