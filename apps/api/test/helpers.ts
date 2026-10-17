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
