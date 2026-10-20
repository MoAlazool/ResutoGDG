import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ENV, envSchema, type Env } from '../src/config/env';
import { auth, bootTestApp, createTenant, type TestApp, type TestTenant } from './helpers';

// Audit PS-27: the Connect sandbox transport was not environment-gated. In production a tenant admin could create a
// simulated WhatsApp channel and inject "customer" messages that the ordering bot turned into real orders.

const production = {
  NODE_ENV: 'production', SUPABASE_URL: 'https://example-ref.supabase.co', CREDENTIALS_KEYS: 'k1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
  PAYMENT_MODE: 'live', STORAGE_DRIVER: 'supabase', SUPABASE_SERVICE_ROLE_KEY: 'sb_secret_test',
};

describe('CONNECT_SANDBOX setting', () => {
  it('is off in production and cannot be switched on there; on elsewhere', () => {
    expect(envSchema.parse(production).CONNECT_SANDBOX).toBe(false);
    expect(envSchema.safeParse({ ...production, CONNECT_SANDBOX: 'true' }).success).toBe(false);
    expect(envSchema.parse({ ...production, NODE_ENV: 'staging', PAYMENT_MODE: 'sandbox' }).CONNECT_SANDBOX).toBe(true);
    expect(envSchema.parse({ SUPABASE_JWT_SECRET: 'x'.repeat(40) }).CONNECT_SANDBOX).toBe(true);
    expect(envSchema.parse({ SUPABASE_JWT_SECRET: 'x'.repeat(40), CONNECT_SANDBOX: 'false' }).CONNECT_SANDBOX).toBe(false);
  });
});

describe('sandbox channels and the simulator when CONNECT_SANDBOX is off', () => {
  let t: TestApp;
  let tenant: TestTenant;
  let env: Env;
  let existing: string;
  beforeAll(async () => {
    t = await bootTestApp();
    env = t.app.get(ENV);
    tenant = await createTenant(t);
    const ch = await t.http.post(`/v1/o/${tenant.orgId}/connect/channels`).set(auth(tenant.owner)).send({ transport: 'sandbox', displayName: 'Before' });
    expect(ch.status).toBe(201);
    existing = ch.body.id;
  });
  afterAll(async () => { env.CONNECT_SANDBOX = true; await t.close(); });

  it('refuses new sandbox channels and simulated inbound messages; lists what exists', async () => {
    env.CONNECT_SANDBOX = false;
    const create = await t.http.post(`/v1/o/${tenant.orgId}/connect/channels`).set(auth(tenant.owner)).send({ transport: 'sandbox', displayName: 'Prod sandbox' });
    expect([create.status, create.body.error?.code]).toEqual([403, 'sandbox_disabled']);
    const sim = await t.http.post(`/v1/o/${tenant.orgId}/connect/sandbox/inbound`).set(auth(tenant.owner)).send({ channelId: existing, from: '+201009900001', text: 'menu' });
    expect([sim.status, sim.body.error?.code]).toEqual([403, 'sandbox_disabled']);
    const list = await t.http.get(`/v1/o/${tenant.orgId}/connect/channels`).set(auth(tenant.owner));
    expect(list.body.items.map((c: any) => c.id)).toContain(existing);

    env.CONNECT_SANDBOX = true; // development/test/staging behaviour is unchanged
    const again = await t.http.post(`/v1/o/${tenant.orgId}/connect/sandbox/inbound`).set(auth(tenant.owner)).send({ channelId: existing, from: '+201009900001', text: 'menu' });
    expect(again.status).toBe(201);
    expect(again.body.sandbox).toBe(true);
  });
});
