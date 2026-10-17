import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addMember, auth, bootTestApp, createTenant, sql, type TestApp, type TestTenant } from './helpers';
import { key, layout, qrTokenFor, saveFloor, table } from './ops-fixtures';

let t: TestApp;
let tenant: TestTenant;

beforeAll(async () => {
  t = await bootTestApp();
  tenant = await createTenant(t);
});
afterAll(async () => { await t.close(); });

const floorUrl = () => `/v1/o/${tenant.orgId}/floor/${tenant.branchId}`;

describe('floor layout (§8)', () => {
  it('returns the schema-v2 shape and saves tables with server-issued ids and QR tokens', async () => {
    const empty = await t.http.get(floorUrl()).set(auth(tenant.owner));
    expect(empty.status).toBe(200);
    expect(empty.body).toMatchObject({ branchId: tenant.branchId, revision: 0, schemaVersion: 2, width: 1200, height: 800, tables: [] });

    const saved = await t.http.put(floorUrl()).set(auth(tenant.owner)).send({
      baseRevision: 0, key: key('floor'),
      layout: layout([table('T1', 200, 200), { ...table('T2', 400, 200), id: 'new-draft-2', shape: 'rectangle', width: 160, height: 90 }]),
    });
    expect(saved.status).toBe(200);
    expect(saved.body.revision).toBe(1);
    expect(saved.body.tables).toHaveLength(2);
    const t2 = saved.body.tables.find((x: any) => x.label === 'T2');
    expect(t2).toMatchObject({ shape: 'rect', width: 160, height: 90, status: 'available', reservable: true, features: ['Non-smoking', 'Center'] });
    expect(t2.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(saved.body.created.find((c: any) => c.clientId === 'new-draft-2').id).toBe(t2.id);
    expect(JSON.stringify(saved.body)).not.toMatch(/qr/i);
    expect(saved.body.zones[0]).toMatchObject({ id: 'zone-main', color: '#e9efe5' });
  });

  it('rejects stale revisions and invalid geometry, and keeps QR tokens stable across saves', async () => {
    const current = (await t.http.get(floorUrl()).set(auth(tenant.owner))).body;
    const t1 = current.tables.find((x: any) => x.label === 'T1');
    const before = await qrTokenFor(t, tenant, t1.id);
    const stale = await t.http.put(floorUrl()).set(auth(tenant.owner)).send({ baseRevision: current.revision - 1, key: key(), layout: layout([]) });
    expect(stale.status).toBe(409);
    expect(stale.body.error).toMatchObject({ code: 'stale_layout', details: { currentRevision: current.revision } });

    const outside = await t.http.put(floorUrl()).set(auth(tenant.owner)).send({
      baseRevision: current.revision, key: key(), layout: layout([{ ...table('T1', 1180, 200), id: t1.id }]),
    });
    expect(outside.status).toBe(422);
    expect(outside.body.error).toMatchObject({ code: 'invalid_geometry', details: { path: 'layout.tables.0' } });
    const rotated = await t.http.put(floorUrl()).set(auth(tenant.owner)).send({
      baseRevision: current.revision, key: key(), layout: layout([{ ...table('T9', 1120, 200), shape: 'rect', width: 200, height: 60, rotation: 0 }, { ...table('T8', 1150, 200), shape: 'rect', width: 60, height: 200, rotation: 90 }]),
    });
    expect(rotated.status).toBe(422);
    const roundBad = await t.http.put(floorUrl()).set(auth(tenant.owner)).send({
      baseRevision: current.revision, key: key(), layout: layout([{ ...table('R1', 300, 300), shape: 'round', width: 100, height: 80 }]),
    });
    expect(roundBad.status).toBe(422);
    const unknown = await t.http.put(floorUrl()).set(auth(tenant.owner)).send({
      baseRevision: current.revision, key: key(), layout: layout([{ ...table('T1', 200, 200), id: '00000000-0000-4000-8000-000000000000' }]),
    });
    expect(unknown.body.error.code).toBe('unknown_table');
    const badFeature = await t.http.put(floorUrl()).set(auth(tenant.owner)).send({
      baseRevision: current.revision, key: key(), layout: layout([{ ...table('T1', 200, 200), features: ['Jacuzzi'] }]),
    });
    expect(badFeature.status).toBe(400);

    // Swap labels and move T1: allowed, and the QR token is unchanged.
    const t2 = current.tables.find((x: any) => x.label === 'T2');
    const swapped = await saveFloor(t, tenant, [{ ...table('T2', 250, 250), id: t1.id }, { ...t2, label: 'T1' }], current.revision);
    expect(swapped.tables.find((x: any) => x.id === t1.id)).toMatchObject({ label: 'T2', cx: 250, version: 1 });
    expect(await qrTokenFor(t, tenant, t1.id)).toBe(before);
  });

  it('blocks archiving a table with an open visit or future reservation (409 table_in_use)', async () => {
    const f = await saveFloor(t, tenant, [table('A1', 200, 500), table('A2', 400, 500)]);
    const [a1, a2] = ['A1', 'A2'].map((l) => f.tables.find((x: any) => x.label === l));
    const seat = await t.http.post(`/v1/o/${tenant.orgId}/visits`).set(auth(tenant.owner)).send({ tableId: a1.id, partySize: 2 });
    expect(seat.status).toBe(201);
    const blocked = await t.http.put(floorUrl()).set(auth(tenant.owner)).send({ baseRevision: f.revision, key: key(), layout: layout([a2]) });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error).toMatchObject({ code: 'table_in_use', details: { tableId: a1.id } });

    await sql(`insert into reservations(org_id, branch_id, table_id, guest_name, party_size, starts_at, ends_at, blocked_until, status)
               values ($1, $2, $3, 'Future', 2, now() + interval '2 days', now() + interval '2 days 90 minutes', now() + interval '2 days 105 minutes', 'confirmed')`,
      [tenant.orgId, tenant.branchId, a2.id]);
    const blocked2 = await t.http.put(floorUrl()).set(auth(tenant.owner)).send({ baseRevision: f.revision, key: key(), layout: layout([a1]) });
    expect(blocked2.body.error).toMatchObject({ code: 'table_in_use', details: { tableId: a2.id } });

    // Close the visit; removing A1 now archives it, and a stale draft cannot restore it.
    await t.http.post(`/v1/o/${tenant.orgId}/visits/${seat.body.id}/close`).set(auth(tenant.owner)).send({});
    const ok = await saveFloor(t, tenant, [a2], f.revision);
    expect(ok.tables.map((x: any) => x.id)).toEqual([a2.id]);
    const restore = await t.http.put(floorUrl()).set(auth(tenant.owner)).send({ baseRevision: ok.revision, key: key(), layout: layout([a1, a2]) });
    expect(restore.status).toBe(409);
    expect(restore.body.error.code).toBe('table_archived');
  });

  it('is idempotent per key and enforces permissions and tenancy', async () => {
    const f = (await t.http.get(floorUrl()).set(auth(tenant.owner))).body;
    const body = { baseRevision: f.revision, key: key('same'), layout: layout([...f.tables, table('N1', 900, 500)]) };
    const a = await t.http.put(floorUrl()).set(auth(tenant.owner)).send(body);
    const b = await t.http.put(floorUrl()).set(auth(tenant.owner)).send(body);
    expect(a.status).toBe(200);
    expect(b.body.revision).toBe(a.body.revision);
    expect(b.body.tables).toHaveLength(a.body.tables.length);

    const waiter = await addMember(t, tenant, 'waiter');
    expect((await t.http.get(floorUrl()).set(auth(waiter))).status).toBe(200);
    expect((await t.http.put(floorUrl()).set(auth(waiter)).send(body)).status).toBe(403);
    expect((await t.http.get(`${floorUrl()}/qr`).set(auth(waiter))).status).toBe(403);
    const other = await createTenant(t);
    expect((await t.http.get(floorUrl()).set(auth(other.owner))).status).toBe(404);
    expect((await t.http.get(`/v1/o/${other.orgId}/floor/${tenant.branchId}`).set(auth(other.owner))).status).toBe(404);
  });

  it('prints QR codes only on the sheet; public geometry never contains QR tokens or notes', async () => {
    const f = await saveFloor(t, tenant, [
      ...(await t.http.get(floorUrl()).set(auth(tenant.owner))).body.tables,
      table('VIP', 700, 300, { internalNotes: 'Owner table — keep free', premium: true, minSpendMinor: 200000 }),
    ]);
    const sheet = await t.http.get(`${floorUrl()}/qr`).set(auth(tenant.owner));
    expect(sheet.status).toBe(200);
    expect(sheet.body.items).toHaveLength(f.tables.length);
    expect(sheet.body.items[0].url).toMatch(/^http:\/\/app\.test\/t\/[A-Za-z0-9_-]{16,}$/);
    expect(sheet.body.items[0].svg).toContain('<svg');
    const tokens: string[] = sheet.body.items.map((i: any) => i.url.split('/t/')[1]);

    const pub = await t.http.get(`/v1/public/floor/${tenant.slug}/main-branch`);
    expect(pub.status).toBe(200);
    const vip = pub.body.tables.find((x: any) => x.label === 'VIP');
    expect(vip).toMatchObject({ premium: true, minSpendMinor: 200000, reservable: true });
    expect(vip).not.toHaveProperty('internalNotes');
    expect(vip).not.toHaveProperty('status');
    const publicResponses = [
      JSON.stringify(pub.body),
      JSON.stringify((await t.http.get(`/v1/public/menu/${tenant.slug}`)).body),
      JSON.stringify((await t.http.get(floorUrl()).set(auth(tenant.owner))).body),
      JSON.stringify((await t.http.get(`${floorUrl()}/live`).set(auth(tenant.owner))).body),
    ];
    for (const body of publicResponses) for (const tok of tokens) expect(body).not.toContain(tok);
    expect(JSON.stringify(pub.body)).not.toContain('Owner table');
    expect((await t.http.get(`/v1/public/floor/${tenant.slug}/nope`)).status).toBe(404);
  });

  it('serves the live floor with visit, bill and next reservation', async () => {
    const f = (await t.http.get(floorUrl()).set(auth(tenant.owner))).body;
    const live = await t.http.get(`${floorUrl()}/live`).set(auth(tenant.owner));
    expect(live.status).toBe(200);
    expect(live.body.revision).toBe(f.revision);
    const a2 = live.body.tables.find((x: any) => x.label === 'A2');
    expect(a2.visit).toBeNull();
    expect(a2.nextReservation).toMatchObject({ guestName: 'Future', partySize: 2 });
  });
});
