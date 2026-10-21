import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createApp } from '../src/bootstrap';

export interface TestApp {
  app: INestApplication;
  http: ReturnType<typeof request>;
  close(): Promise<void>;
}

let counter = 0;
export const unique = (prefix: string) => `${prefix}-${process.pid}-${Date.now().toString(36)}-${++counter}`;

export async function bootTestApp(): Promise<TestApp> {
  const app = await createApp();
  await app.init();
  return { app, http: request(app.getHttpServer()), close: () => app.close() };
}

export interface TestUser { token: string; userId: string; email: string }

export async function signup(t: TestApp, name = 'user'): Promise<TestUser> {
  const email = `${unique(name)}@example.test`.toLowerCase();
  const res = await t.http.post('/v1/auth/dev/signup').send({ email, password: 'correct-horse-battery', fullName: name });
  if (res.status !== 201) throw new Error(`signup failed: ${res.status} ${JSON.stringify(res.body)}`);
  return { token: res.body.accessToken, userId: res.body.user.id, email };
}

export interface TestTenant { owner: TestUser; orgId: string; branchId: string; slug: string }

export async function createTenant(t: TestApp, opts: { name?: string; country?: 'EG' | 'SA'; planId?: string } = {}): Promise<TestTenant> {
  const owner = await signup(t, 'owner');
  const slug = unique('r').toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 40);
  const res = await t.http.post('/v1/orgs').set(auth(owner)).send({
    name: opts.name ?? 'Test Restaurant', slug, country: opts.country ?? 'EG', planId: opts.planId ?? 'pro',
    branch: { name: 'Main branch', acceptsDelivery: true, deliveryFeeMinor: 2500 },
  });
  if (res.status !== 201) throw new Error(`create org failed: ${res.status} ${JSON.stringify(res.body)}`);
  return { owner, orgId: res.body.id, branchId: res.body.branchId, slug };
}

/** Invites a staff member with a role and returns their signed-in user. */
export async function addMember(t: TestApp, tenant: TestTenant, role: string, branchIds: string[] | null = null): Promise<TestUser> {
  const member = await signup(t, role);
  const inv = await t.http.post(`/v1/o/${tenant.orgId}/invitations`).set(auth(tenant.owner)).send({ email: member.email, role, branchIds });
  if (inv.status !== 201) throw new Error(`invite failed: ${inv.status} ${JSON.stringify(inv.body)}`);
  const acc = await t.http.post('/v1/invitations/accept').set(auth(member)).send({ token: inv.body.token });
  if (acc.status !== 201) throw new Error(`accept failed: ${acc.status} ${JSON.stringify(acc.body)}`);
  return member;
}

export const auth = (u: { token: string }) => ({ Authorization: `Bearer ${u.token}` });

// ---------------------------------------------------------------------------
// Direct database fixtures (platform connection). Use only to arrange data that
// another module's API would normally create; assert through the API.
// ---------------------------------------------------------------------------
import pg from 'pg';
let pool: pg.Pool | null = null;
// Fixtures use the owner connection; under vitest.restricted.config.ts the API itself connects as resuto_api (PS-16).
export const testDb = () => (pool ??= new pg.Pool({ connectionString: process.env.TEST_FIXTURE_DATABASE_URL ?? process.env.DATABASE_URL, max: 3 }));
export async function sql<T = any>(text: string, params: unknown[] = []): Promise<T[]> {
  return (await testDb().query(text, params as any[])).rows;
}

export interface SeededMenu {
  menuId: string; categoryId: string;
  products: { burger: string; fries: string; soda: string; limited: string };
  groups: { size: string; extras: string };
  options: { regular: string; large: string; cheese: string; bacon: string };
  tableId: string; qrToken: string;
}

/** Minimal menu + table for order/payment tests. Prices in minor units. */
export async function seedMenu(tenant: TestTenant): Promise<SeededMenu> {
  const { orgId, branchId } = tenant;
  const [menu] = await sql(`select id from menus where org_id = $1 limit 1`, [orgId]);
  const [cat] = await sql(`insert into menu_categories(org_id, menu_id, name) values ($1, $2, 'Mains') returning id`, [orgId, menu.id]);
  const currency = (await sql(`select currency from organizations where id = $1`, [orgId]))[0].currency;
  const product = async (name: string, price: number, extra = '') =>
    (await sql(`insert into products(org_id, category_id, name, price_minor, cost_minor, currency, station${extra ? ', track_stock' : ''})
                values ($1, $2, $3, $4, $5, $6, 'Grill'${extra ? ', true' : ''}) returning id`, [orgId, cat.id, name, price, Math.round(price * 0.3), currency]))[0].id;
  const burger = await product('Smash burger', 18500);
  const fries = await product('Fries', 4500);
  const soda = await product('Soda', 2500);
  const limited = await product('Limited special', 30000, 'stock');
  await sql(`insert into product_branch_settings(org_id, product_id, branch_id, stock_qty) values ($1, $2, $3, 2)`, [orgId, limited, branchId]);
  const [size] = await sql(`insert into modifier_groups(org_id, name, min_select, max_select) values ($1, 'Size', 1, 1) returning id`, [orgId]);
  const [extras] = await sql(`insert into modifier_groups(org_id, name, min_select, max_select) values ($1, 'Extras', 0, 2) returning id`, [orgId]);
  const opt = async (g: string, name: string, delta: number) =>
    (await sql(`insert into modifier_options(org_id, group_id, name, price_delta_minor) values ($1, $2, $3, $4) returning id`, [orgId, g, name, delta]))[0].id;
  const regular = await opt(size.id, 'Regular', 0);
  const large = await opt(size.id, 'Large', 3000);
  const cheese = await opt(extras.id, 'Cheese', 1500);
  const bacon = await opt(extras.id, 'Bacon', 2500);
  await sql(`insert into product_modifier_groups(org_id, product_id, group_id) values ($1, $2, $3), ($1, $2, $4)`, [orgId, burger, size.id, extras.id]);
  const qrToken = `qr-${unique('t')}`.padEnd(20, 'x');
  const [table] = await sql(`insert into dining_tables(org_id, branch_id, label, capacity, qr_token) values ($1, $2, 'T1', 4, $3) returning id`, [orgId, branchId, qrToken]);
  return { menuId: menu.id, categoryId: cat.id, products: { burger, fries, soda, limited }, groups: { size: size.id, extras: extras.id },
    options: { regular, large, cheese, bacon }, tableId: table.id, qrToken };
}
