// Public sales inquiry form (/pricing "Let’s shape your setup.", audit VP-09): validated, rate limited, stored,
// idempotent, and readable only by platform staff.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auth, bootTestApp, createTenant, signup, sql, type TestApp, type TestUser } from './helpers';

let t: TestApp;
let support: TestUser;
let n = 0;
// Each request comes from its own address so the per-IP limiter only bites where a test means it to.
const from = () => `10.66.${Math.floor(++n / 250)}.${n % 250}`;
const form = (over: Record<string, unknown> = {}) => ({
  restaurant: 'Koshary Lab (test)', email: `owner-${randomUUID().slice(0, 8)}@example.test`, branches: 4,
  requirements: 'Four branches, Foodics today, want QR ordering and the kitchen board.', planId: 'pro', locale: 'en', key: randomUUID(), ...over,
});

beforeAll(async () => {
  t = await bootTestApp();
  support = await signup(t, 'pa-sales-support');
  await sql(`insert into platform_admins(user_id, role) values ($1, 'support')`, [support.userId]);
});
afterAll(async () => { await t.close(); });

describe('public sales inquiries', () => {
  it('stores a valid inquiry and returns its reference', async () => {
    const body = form();
    const res = await t.http.post('/v1/public/sales-inquiries').set('X-Forwarded-For', from()).send(body);
    expect(res.status).toBe(201);
    expect(res.body.reference).toMatch(/^SI-[0-9A-F]{6}$/);
    const [row] = await sql(`select * from sales_inquiries where id = $1`, [res.body.id]);
    expect(row).toMatchObject({ restaurant: body.restaurant, email: body.email, branches: 4, plan_id: 'pro', locale: 'en', status: 'new' });
  });

  it('returns the same inquiry when the form is resubmitted with the same key', async () => {
    const body = form();
    const a = await t.http.post('/v1/public/sales-inquiries').set('X-Forwarded-For', from()).send(body);
    const b = await t.http.post('/v1/public/sales-inquiries').set('X-Forwarded-For', from()).send(body);
    expect(b.status).toBe(201);
    expect(b.body.id).toBe(a.body.id);
    expect((await sql(`select count(*)::int as n from sales_inquiries where idempotency_key = $1`, [body.key]))[0].n).toBe(1);
    const reused = await t.http.post('/v1/public/sales-inquiries').set('X-Forwarded-For', from()).send({ ...body, email: 'someone-else@example.test' });
    expect(reused.status).toBe(409);
    // Email case is not a change.
    const sameish = await t.http.post('/v1/public/sales-inquiries').set('X-Forwarded-For', from()).send({ ...body, email: body.email.toUpperCase() });
    expect(sameish.status).toBe(201);
    expect(sameish.body.id).toBe(a.body.id);
  });

  it('refuses a reused key whose form was edited instead of silently keeping the old text', async () => {
    const body = form();
    const a = await t.http.post('/v1/public/sales-inquiries').set('X-Forwarded-For', from()).send(body);
    expect(a.status).toBe(201);
    for (const edit of [{ branches: 40 }, { requirements: 'second, changed' }, { planId: 'growth' }, { planId: null }, { locale: 'ar' }]) {
      const res = await t.http.post('/v1/public/sales-inquiries').set('X-Forwarded-For', from()).send({ ...body, ...edit });
      expect(res.status, JSON.stringify(edit)).toBe(409);
    }
    const [row] = await sql(`select branches, requirements, plan_id from sales_inquiries where id = $1`, [a.body.id]);
    expect(row).toEqual({ branches: 4, requirements: body.requirements, plan_id: 'pro' });
    expect((await sql(`select count(*)::int as n from sales_inquiries where idempotency_key = $1`, [body.key]))[0].n).toBe(1);
  });

  it('rejects invalid input, including a filled honeypot', async () => {
    for (const bad of [{ email: 'not-an-email' }, { branches: 0 }, { branches: 501 }, { restaurant: '' }, { requirements: 'x'.repeat(1001) }, { key: 'short' }, { website: 'http://spam.test' }]) {
      const res = await t.http.post('/v1/public/sales-inquiries').set('X-Forwarded-For', from()).send(form(bad));
      expect(res.status, JSON.stringify(bad)).toBe(400);
    }
  });

  it('caps inquiries per email per day across addresses, and per IP', async () => {
    const email = `cap-${randomUUID().slice(0, 8)}@example.test`;
    for (let i = 0; i < 3; i++) expect((await t.http.post('/v1/public/sales-inquiries').set('X-Forwarded-For', from()).send(form({ email }))).status).toBe(201);
    const fourth = await t.http.post('/v1/public/sales-inquiries').set('X-Forwarded-For', from()).send(form({ email: email.toUpperCase() }));
    expect(fourth.status).toBe(429);
    const ip = from();
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) statuses.push((await t.http.post('/v1/public/sales-inquiries').set('X-Forwarded-For', ip).send(form())).status);
    expect(statuses.slice(0, 5)).toEqual([201, 201, 201, 201, 201]);
    expect(statuses[5]).toBe(429);
  });

  it('lists inquiries for platform staff only', async () => {
    const tenant = await createTenant(t);
    const body = form();
    await t.http.post('/v1/public/sales-inquiries').set('X-Forwarded-For', from()).send(body);
    expect((await t.http.get('/v1/admin/sales-inquiries')).status).toBe(401);
    expect((await t.http.get('/v1/admin/sales-inquiries').set(auth(tenant.owner))).status).toBe(403);
    const list = await t.http.get('/v1/admin/sales-inquiries?limit=200').set(auth(support));
    expect(list.status).toBe(200);
    const mine = list.body.items.find((x: any) => x.email === body.email);
    expect(mine).toMatchObject({ restaurant: body.restaurant, branches: 4, status: 'new', planId: 'pro' });
    expect(mine.reference).toMatch(/^SI-/);
  });
});
