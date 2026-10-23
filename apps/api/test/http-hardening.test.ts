import 'reflect-metadata';
import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { DiscoveryService, MetadataScanner, Reflector } from '@nestjs/core';
import express from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { IS_PUBLIC } from '../src/common/auth/decorators';
import { hardeningMiddleware, trustProxySetting } from '../src/common/http/http-hardening';
import { RateLimiter } from '../src/common/http/rate-limiter';
import { installOutboundRequestId, requestContext } from '../src/common/http/request-context';
import { auth, bootTestApp, createTenant, signup, sql, type TestApp, type TestTenant } from './helpers';

// PCL-04: authenticated JSON carried no Cache-Control and no Vary: Authorization, so a CDN, proxy or shared browser
// cache could keep tenant data. PS-17: no HSTS. PS-15: request ids were not stored or propagated. PS-13: 429s had
// no Retry-After header; org creation had no limit.

let t: TestApp;
let a: TestTenant;

/** Every GET route under /v1/o/:orgId, from Nest's controller metadata. */
function tenantGetRoutes(app: TestApp['app']): string[] {
  const discovery = app.get(DiscoveryService);
  const scanner = app.get(MetadataScanner);
  const reflector = app.get(Reflector);
  const join = (...parts: string[]) => `/${parts.map((p) => p.replace(/^\/+|\/+$/g, '')).filter(Boolean).join('/')}`;
  const out = new Set<string>();
  for (const wrapper of discovery.getControllers()) {
    const cls = wrapper.metatype as any;
    if (!cls) continue;
    for (const name of scanner.getAllMethodNames(cls.prototype)) {
      const handler = cls.prototype[name];
      if (Reflect.getMetadata(METHOD_METADATA, handler) !== RequestMethod.GET) continue;
      if (reflector.getAllAndOverride<boolean>(IS_PUBLIC, [handler, cls])) continue;
      for (const b of [Reflect.getMetadata(PATH_METADATA, cls) ?? ''].flat() as string[]) {
        for (const p of [Reflect.getMetadata(PATH_METADATA, handler) ?? ''].flat() as string[]) {
          const path = join('v1', b, p);
          if (path.startsWith('/v1/o/:orgId')) out.add(path);
        }
      }
    }
  }
  return [...out];
}

beforeAll(async () => {
  t = await bootTestApp();
  a = await createTenant(t, { name: 'Header House' });
});
afterAll(async () => { await t?.close(); });

describe('cache policy on authenticated responses (PCL-04)', () => {
  it('every tenant GET route answers private, no-store and varies on the credential headers', async () => {
    const routes = tenantGetRoutes(t.app);
    expect(routes.length).toBeGreaterThan(60);
    const fill = (path: string) => path.replace(':orgId', a.orgId).replace(/\*\w+/g, 'x/y.png').replace(/:(\w+)/g, '6f1c2a40-0000-4000-8000-0000000000ff');
    const bad: string[] = [];
    for (const r of routes) {
      const res = await t.http.get(fill(r)).set(auth(a.owner)).set('Origin', 'http://app.test');
      const vary = String(res.headers.vary ?? '').toLowerCase();
      // 'private, no-store' by default; a CSV export's own 'no-store' is equally strict.
      if (!/(^|,\s*)no-store(\s*,|$)/.test(String(res.headers['cache-control'] ?? '')) || !['authorization', 'x-visit-token', 'origin'].every((h) => vary.includes(h))) {
        bad.push(`${r} -> ${res.status} cache-control=${res.headers['cache-control']} vary=${res.headers.vary}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('applies to /me, errors and unauthenticated refusals too; public sites keep their own policy', async () => {
    const me = await t.http.get('/v1/me').set(auth(a.owner));
    expect(me.status).toBe(200);
    expect(me.headers['cache-control']).toBe('private, no-store');
    const anon = await t.http.get(`/v1/o/${a.orgId}/orders`);
    expect(anon.status).toBe(401);
    expect(anon.headers['cache-control']).toBe('private, no-store');
    const site = await t.http.get(`/v1/public/sites/${a.slug}`);
    if (site.status === 200) expect(site.headers['cache-control']).toMatch(/^public/);
    expect(me.headers['x-content-type-options']).toBe('nosniff');
    expect(me.headers['x-frame-options']).toBe('DENY');
    expect(me.headers['strict-transport-security']).toBeUndefined(); // test env: HSTS only when deployed
  });
});

describe('deployed-environment headers (PS-17)', () => {
  const mini = (NODE_ENV: 'staging' | 'production' | 'development') => {
    const app = express();
    app.use(hardeningMiddleware({ NODE_ENV }));
    app.get('/x', (_req, res) => { res.json({ ok: true }); });
    app.get('/public', (_req, res) => { res.setHeader('Cache-Control', 'public, max-age=30'); res.json({ ok: true }); });
    return request(app);
  };
  it('sends HSTS in staging and production only', async () => {
    for (const env of ['staging', 'production'] as const) {
      expect((await mini(env).get('/x')).headers['strict-transport-security']).toBe('max-age=31536000; includeSubDomains');
    }
    expect((await mini('development').get('/x')).headers['strict-transport-security']).toBeUndefined();
  });
  it('lets a handler choose a public policy', async () => {
    expect((await mini('production').get('/public')).headers['cache-control']).toBe('public, max-age=30');
  });
});

describe('request ids (PS-15)', () => {
  it('echoes a well-formed caller id, replaces anything else', async () => {
    const ok = await t.http.get('/v1/health').set('X-Request-Id', 'web-req-12345678');
    expect(ok.headers['x-request-id']).toBe('web-req-12345678');
    const evil = await t.http.get('/v1/health').set('X-Request-Id', 'attacker-controlled-<script>');
    expect(evil.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('records the request id on audit rows and outbox events written by the request', async () => {
    const id = `it-${Date.now().toString(36)}-audit`;
    const invitee = await signup(t, 'rid');
    const inv = await t.http.post(`/v1/o/${a.orgId}/invitations`).set(auth(a.owner)).set('X-Request-Id', id).send({ email: invitee.email, role: 'kitchen' });
    expect(inv.status).toBe(201);
    const rows = await sql(`select action from audit_logs where org_id = $1 and request_id = $2`, [a.orgId, id]);
    expect(rows.length).toBeGreaterThan(0);
  });

  it('adds X-Request-Id to outbound calls made inside a request context', async () => {
    const seen: Array<string | null> = [];
    const original = globalThis.fetch;
    const stub = vi.fn(async (_input: unknown, init?: RequestInit) => { seen.push(new Headers(init?.headers).get('x-request-id')); return new Response('{}'); });
    globalThis.fetch = stub as unknown as typeof fetch;
    try {
      installOutboundRequestIdForTest();
      await requestContext.run({ requestId: 'req-outbound-0001', source: 'api' }, () => globalThis.fetch('https://provider.example/x'));
      await requestContext.run({ requestId: 'req-outbound-0002', source: 'api' }, () => globalThis.fetch('https://provider.example/x', { headers: { 'X-Request-Id': 'caller-set-0003' } }));
      await globalThis.fetch('https://provider.example/no-context');
    } finally {
      globalThis.fetch = original;
    }
    expect(seen).toEqual(['req-outbound-0001', 'caller-set-0003', null]);
  });
});

/** installOutboundRequestId() patches once per process; wrap the stub for this test. */
const installOutboundRequestIdForTest = () => installOutboundRequestId({ force: true });

describe('rate limits (PS-13)', () => {
  it('answers 429 with Retry-After and RateLimit headers', async () => {
    const limiter = t.app.get(RateLimiter);
    const owner = await signup(t, 'ratelimited');
    for (let i = 0; i < 5; i++) limiter.hit(`org-create:user:${owner.userId}`, 5, 3_600_000);
    const res = await t.http.post('/v1/orgs').set(auth(owner)).send({ name: 'Too many', slug: `too-many-${Date.now()}`, country: 'EG', planId: 'pro', branch: { name: 'Main' } });
    expect(res.status).toBe(429);
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
    expect(res.headers['ratelimit-limit']).toBe('5');
    expect(res.headers['ratelimit-remaining']).toBe('0');
  });

  it('chooses the client address from TRUST_PROXY', () => {
    expect(trustProxySetting({ NODE_ENV: 'production', TRUST_PROXY: undefined })).toBe(1);
    expect(trustProxySetting({ NODE_ENV: 'staging', TRUST_PROXY: '' })).toBe(1);
    expect(trustProxySetting({ NODE_ENV: 'development', TRUST_PROXY: undefined })).toBe('loopback');
    expect(trustProxySetting({ NODE_ENV: 'production', TRUST_PROXY: 'false' })).toBe(false);
    expect(trustProxySetting({ NODE_ENV: 'production', TRUST_PROXY: '0' })).toBe(false);
    expect(trustProxySetting({ NODE_ENV: 'production', TRUST_PROXY: '2' })).toBe(2);
    expect(trustProxySetting({ NODE_ENV: 'production', TRUST_PROXY: '10.0.0.0/8, loopback' })).toBe('10.0.0.0/8, loopback');
    expect(() => trustProxySetting({ NODE_ENV: 'production', TRUST_PROXY: 'true' })).toThrow(/X-Forwarded-For/);
  });

  it('with one trusted hop, a client cannot choose its address with X-Forwarded-For', async () => {
    const app = express();
    app.set('trust proxy', trustProxySetting({ NODE_ENV: 'production', TRUST_PROXY: undefined }));
    app.get('/ip', (req, res) => { res.json({ ip: req.ip }); });
    // The load balancer appends the real client (203.0.113.7) after whatever the client sent.
    const res = await request(app).get('/ip').set('X-Forwarded-For', '1.2.3.4, 203.0.113.7');
    expect(res.body.ip).toBe('203.0.113.7');
  });
});

describe('cross-origin conditional GET from the web app (PCL-24 / REM-W02)', () => {
  // vitest env leaves CORS_ORIGINS at its default, the local web origin.
  const origin = 'http://localhost:3000';

  it('lets the web origin send If-None-Match and Cache-Control in a preflight', async () => {
    const pre = await t.http.options('/v1/me').set('Origin', origin)
      .set('Access-Control-Request-Method', 'GET').set('Access-Control-Request-Headers', 'authorization,if-none-match,cache-control');
    expect(pre.status).toBe(204);
    expect(pre.headers['access-control-allow-origin']).toBe(origin);
    const allowed = String(pre.headers['access-control-allow-headers'] ?? '').toLowerCase().split(/\s*,\s*/);
    expect(allowed).toEqual(expect.arrayContaining(['authorization', 'if-none-match', 'cache-control']));
  });

  it('exposes ETag to the web origin, and the revalidation the web sends gets a 304', async () => {
    const first = await t.http.get('/v1/me').set(auth(a.owner)).set('Origin', origin);
    expect(first.status).toBe(200);
    const exposed = String(first.headers['access-control-expose-headers'] ?? '').toLowerCase().split(/\s*,\s*/);
    expect(exposed).toContain('etag');
    expect(first.headers.etag).toBeTruthy();
    // What lib/api-conditional.ts sends: the remembered validator plus Cache-Control: max-age=0.
    const again = await t.http.get('/v1/me').set(auth(a.owner)).set('Origin', origin)
      .set('If-None-Match', first.headers.etag).set('Cache-Control', 'max-age=0');
    expect(again.status).toBe(304);
    expect(again.headers['access-control-expose-headers']).toBe(first.headers['access-control-expose-headers']);
    // Authenticated answers stay no-store (PCL-04): a 304 is a revalidation, not a stored copy.
    expect(again.headers['cache-control']).toBe('private, no-store');
  });
});
