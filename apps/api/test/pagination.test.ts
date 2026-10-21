import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { decodeCursor, encodeCursor, keyset, pageOf } from '../src/common/http/pagination';
import { addMember, auth, bootTestApp, createTenant, sql, type TestApp, type TestTenant } from './helpers';

// Audit PS-21 / PS-22: a negative limit was a 500 (studio media), limits were parsed by hand, lists returned a
// hard-coded nextCursor: null, branch filters ran in JavaScript after the SQL LIMIT (short pages), and four cursor
// formats were in use. This file reproduces each finding and pins the shared contract (docs/API_STYLE.md).

let t: TestApp;
let a: TestTenant;

beforeAll(async () => {
  t = await bootTestApp();
  a = await createTenant(t, { name: 'Paging House' });
});
afterAll(async () => { await t?.close(); });

const get = (path: string) => t.http.get(`/v1/o/${a.orgId}${path}`).set(auth(a.owner));

describe('list queries are validated (PS-21)', () => {
  it('a negative, zero, fractional, non-numeric or too large limit is 400 validation_failed on "limit", never a 500', async () => {
    for (const path of ['/studio/media', '/studio/creative', '/inventory/items', '/marketing/campaigns', '/audit', '/integrations/logs',
      '/payments/alerts', '/menu-import/jobs', '/connect/channels']) {
      for (const limit of ['-5', '0', '1.5', 'abc', '201', '99999999999']) {
        const res = await get(`${path}?limit=${limit}`);
        expect(res.status, `${path}?limit=${limit} ${JSON.stringify(res.body)}`).toBe(400);
        expect(res.body.error.code).toBe('validation_failed');
        expect(res.body.error.details.map((d: { path: string }) => d.path)).toContain('limit');
      }
    }
  });

  it('a tampered or foreign cursor is 400 invalid_cursor', async () => {
    const bad = [
      'not base64 !',
      Buffer.from('{"at":"x"}').toString('base64url'),
      encodeCursor({ at: 'not-a-date', id: '00000000-0000-0000-0000-000000000000' }),
      encodeCursor({ at: new Date().toISOString(), id: "1' or '1'='1" }),
    ];
    for (const c of bad) {
      const res = await get(`/marketing/campaigns?cursor=${encodeURIComponent(c)}`);
      expect(res.status, c).toBe(400);
      expect(['invalid_cursor', 'validation_failed']).toContain(res.body.error.code);
    }
  });

  it('hand-parsed filters name their field (kitchen prep-times days, setup branchId)', async () => {
    const days = await get(`/kitchen/${a.branchId}/prep-times?days=0`);
    expect(days.status).toBe(400);
    expect(days.body.error.details.map((d: { path: string }) => d.path)).toContain('days');
    const setup = await get('/setup?branchId=nope');
    expect(setup.status).toBe(400);
    expect(setup.body.error.details.map((d: { path: string }) => d.path)).toContain('branchId');
  });

  it('manual refund completion validates its body', async () => {
    const res = await t.http.post(`/v1/o/${a.orgId}/payments/refunds/00000000-0000-4000-8000-000000000000/complete`).set(auth(a.owner))
      .send({ note: 42 });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('validation_failed');
    const extra = await t.http.post(`/v1/o/${a.orgId}/payments/refunds/00000000-0000-4000-8000-000000000000/complete`).set(auth(a.owner))
      .send({ note: 'ok', amountMinor: 1 });
    expect(extra.status).toBe(400);
  });
});

describe('keyset pagination (PS-22)', () => {
  it('walks every row exactly once, with ties on the sort key broken by id, and ends with nextCursor null', async () => {
    // Ten suppliers, five of them sharing one name (equal sort keys).
    for (let i = 0; i < 10; i++) {
      await sql(`insert into suppliers(org_id, name) values ($1, $2)`, [a.orgId, i < 5 ? 'Same Name' : `Supplier ${String(i).padStart(2, '0')}`]);
    }
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const res = await get(`/inventory/suppliers?limit=3${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.items.length).toBeLessThanOrEqual(3);
      seen.push(...res.body.items.map((s: { id: string }) => s.id));
      cursor = res.body.nextCursor;
      pages++;
    } while (cursor && pages < 10);
    expect(pages).toBe(4);
    expect(seen.length).toBe(10);
    expect(new Set(seen).size).toBe(10);
    // The default (full) page still returns everything in one response, as before pagination existed.
    const full = await get('/inventory/suppliers');
    expect(full.headers['x-resuto-list']).toBe('full');
    expect(full.body.items.map((s: { id: string }) => s.id)).toEqual(seen);
    expect(full.body.nextCursor).toBeNull();
  });

  it('timestamps keep microsecond precision in the cursor (rows inside one millisecond are not skipped)', async () => {
    const base = '2026-01-01T10:00:00.123';
    for (let i = 1; i <= 4; i++) {
      await sql(`insert into promotions(org_id, name, kind, value, created_at) values ($1, $2, 'percent', 10, $3::timestamptz)`,
        [a.orgId, `Promo ${i}`, `${base}${i}00+00`]).catch(async (e) => {
        throw new Error(`fixture: ${e.message}`);
      });
    }
    const ids: string[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 6; i++) {
      const res = await get(`/marketing/promotions?limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      ids.push(...res.body.items.map((p: { id: string }) => p.id));
      cursor = res.body.nextCursor;
      if (!cursor) break;
    }
    expect(new Set(ids).size).toBe(4);
  });

  it('the audit log pages with real cursors (new opaque and the old numeric "before") and answers camelCase fields', async () => {
    for (let i = 0; i < 4; i++) {
      const r = await t.http.post(`/v1/o/${a.orgId}/inventory/suppliers`).set(auth(a.owner)).send({ name: `Audited ${i}` });
      expect(r.status, JSON.stringify(r.body)).toBe(201);
    }
    const first = await get('/audit?limit=2');
    expect(first.status).toBe(200);
    expect(first.body.items).toHaveLength(2);
    const row = first.body.items[0];
    expect(row).toMatchObject({ id: expect.any(Number), entityType: row.entity_type, actorType: row.actor_type, createdAt: expect.any(String) });
    expect(typeof first.body.nextCursor).toBe('string');
    const next = await get(`/audit?limit=2&before=${encodeURIComponent(first.body.nextCursor)}`);
    expect(next.status).toBe(200);
    expect(next.body.items[0].id).toBeLessThan(first.body.items[1].id);
    const legacy = await get(`/audit?limit=2&before=${first.body.items[1].id}`);
    expect(legacy.body.items.map((r: { id: number }) => r.id)).toEqual(next.body.items.map((r: { id: number }) => r.id));
  });

  it('branch scope is part of the SQL: a branch manager gets full pages of their branch, never a short page', async () => {
    const [east] = await sql<{ id: string }>(`insert into branches(org_id, code, name) values ($1, 'east-pg', 'East') returning id`, [a.orgId]);
    // Newest rows belong to the other branch: filtering after the LIMIT returned an empty first page.
    for (let i = 0; i < 3; i++) {
      await sql(`insert into payment_alerts(org_id, branch_id, kind, created_at) values ($1, $2, 'unmatched_event', now() - make_interval(mins => $3))`,
        [a.orgId, a.branchId, 10 + i]);
    }
    for (let i = 0; i < 5; i++) {
      await sql(`insert into payment_alerts(org_id, branch_id, kind, created_at) values ($1, $2, 'unmatched_event', now() - make_interval(secs => $3))`,
        [a.orgId, east!.id, i]);
    }
    const manager = await addMember(t, a, 'manager', [a.branchId]);
    const res = await t.http.get(`/v1/o/${a.orgId}/payments/alerts?limit=2`).set(auth(manager));
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.items).toHaveLength(2);
    expect(res.body.items.every((x: { branchId: string }) => x.branchId === a.branchId)).toBe(true);
    const rest = await t.http.get(`/v1/o/${a.orgId}/payments/alerts?limit=2&cursor=${encodeURIComponent(res.body.nextCursor)}`).set(auth(manager));
    expect(rest.body.items).toHaveLength(1);
    expect(rest.body.nextCursor).toBeNull();
  });
});

describe('cursor helper', () => {
  it('round-trips and rejects tampering', () => {
    const c = encodeCursor({ at: '2026-01-01T00:00:00.000001Z', id: '00000000-0000-4000-8000-000000000001' });
    expect(decodeCursor(c)).toEqual({ at: '2026-01-01T00:00:00.000001Z', id: '00000000-0000-4000-8000-000000000001' });
    expect(() => decodeCursor(`${c}=`)).toThrow();
    expect(() => keyset(encodeCursor({ at: 5, id: 'x' }))).toThrow();
    expect(() => keyset(encodeCursor({ at: 'x', id: '1' }), { atType: 'int', idType: 'text' })).toThrow();
  });

  it('pageOf only emits nextCursor when an extra row was fetched', () => {
    expect(pageOf([{ id: 'a', k: 1 }], 1, (r) => ({ at: r.k, id: r.id }), (r) => r.id)).toEqual({ items: ['a'], nextCursor: null });
    const p = pageOf([{ id: 'a', k: 1 }, { id: 'b', k: 2 }], 1, (r) => ({ at: r.k, id: r.id }), (r) => r.id);
    expect(p.items).toEqual(['a']);
    expect(decodeCursor(p.nextCursor!)).toEqual({ at: 1, id: 'a' });
  });
});
