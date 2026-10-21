import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { readBuildInfo, buildHeaderValue } from '../src/common/observability/build-info';
import { buildEvent, ErrorReporter, framesOf, parseDsn, scrub } from '../src/common/observability/error-tracking';
import { logFormat, setLogSink, writeAccessLog } from '../src/common/observability/log';
import { auth, bootTestApp, signup, sql, type TestApp } from './helpers';

// CR-07: /v1/health returned a static version, so a QA result could not name the deployed commit.
// CR-14: no error tracking, no structured access log, no view of the outbox, jobs or webhook failures.

const TOKEN = 'health-details-token-for-tests-0123456789';
let t: TestApp;

beforeAll(async () => {
  process.env.HEALTH_DETAILS_TOKEN = TOKEN;
  t = await bootTestApp();
});
afterAll(async () => {
  await t?.close();
  delete process.env.HEALTH_DETAILS_TOKEN;
});

describe('build identity (CR-07)', () => {
  it('reads the deployed commit from the hosting platform and the build time from the compiled code', () => {
    const b = readBuildInfo({ RENDER_GIT_COMMIT: 'ABCDEF0123456789abcdef0123456789abcdef01', RENDER_GIT_BRANCH: 'claude/relaxed-mayer-omkl3f' }, __filename);
    expect(b.commit).toBe('abcdef0123456789abcdef0123456789abcdef01');
    expect(b.shortCommit).toBe('abcdef012345');
    expect(b.branch).toBe('claude/relaxed-mayer-omkl3f');
    expect(Date.parse(b.builtAt!)).not.toBeNaN();
    expect(buildHeaderValue(b)).toBe('api@abcdef012345');
    expect(readBuildInfo({ BUILD_TIME: '2026-10-21T10:00:00Z' }, __filename).builtAt).toBe('2026-10-21T10:00:00.000Z');
  });

  it('ignores values that are not commit hashes and reports a local build honestly', () => {
    const b = readBuildInfo({ RENDER_GIT_COMMIT: '<script>', GIT_BRANCH: 'x y' }, '/no/such/file');
    expect(b.commit).toBeNull();
    expect(b.branch).toBeNull();
    expect(b.builtAt).toBeNull();
    expect(buildHeaderValue(b)).toBe('api@local');
  });

  it('/v1/health names the build, and every response (errors too) carries X-Build', async () => {
    const res = await t.http.get('/v1/health');
    expect(res.status).toBe(200);
    expect(res.body.build).toEqual(expect.objectContaining({ startedAt: expect.any(String) }));
    expect(Object.keys(res.body.build).sort()).toEqual(['branch', 'builtAt', 'commit', 'startedAt']);
    expect(res.headers['x-build']).toMatch(/^api@([0-9a-f]{12}|local)$/);
    const missing = await t.http.get('/v1/no-such-route');
    expect(missing.status).toBe(404);
    expect(missing.headers['x-build']).toBe(res.headers['x-build']);
    const cors = await t.http.options('/v1/health').set('Origin', 'http://localhost:3000').set('Access-Control-Request-Method', 'GET');
    expect(cors.status).toBeLessThan(500);
  });
});

describe('/v1/health/details (CR-14)', () => {
  it('is hidden from anonymous callers, wrong tokens and ordinary users', async () => {
    expect((await t.http.get('/v1/health/details')).status).toBe(404);
    expect((await t.http.get('/v1/health/details').set('Authorization', `Bearer ${TOKEN}x`)).status).toBe(404);
    const user = await signup(t, 'not-admin');
    expect((await t.http.get('/v1/health/details').set(auth(user))).status).toBe(404);
  });

  it('shows outbox backlog and age, dead handlers, last run per job and webhook failures to the uptime token', async () => {
    await sql(`insert into outbox_events(aggregate_type, aggregate_id, event_type, payload, created_at) values ('test', 'obs', 'test.observability', '{}', now() - interval '10 minutes')`);
    await sql(`insert into webhook_inbox(provider, event_key, signature_valid, headers, payload, status, received_at)
               values ('observability-test', 'obs-' || gen_random_uuid(), true, '{}', '{"secret":"never shown"}', 'failed', now())`);
    try {
      const res = await t.http.get('/v1/health/details').set('Authorization', `Bearer ${TOKEN}`);
      expect(res.status).toBe(200);
      expect(res.body.outbox.pending).toBeGreaterThanOrEqual(1);
      expect(res.body.outbox.oldestPendingSeconds).toBeGreaterThanOrEqual(600);
      expect(res.body.status).toBe('degraded');
      expect(res.body.reasons.join(' ')).toMatch(/outbox/);
      expect(res.body.webhooks.last24h).toEqual(expect.arrayContaining([expect.objectContaining({ provider: 'observability-test', failed: 1 })]));
      expect(Array.isArray(res.body.jobs)).toBe(true);
      expect(res.body.errorTracking).toBe('off');
      expect(res.body.build).toEqual(expect.objectContaining({ service: 'api' }));
      expect(JSON.stringify(res.body)).not.toContain('never shown');
      expect(res.headers['cache-control']).toContain('no-store');
    } finally {
      await sql(`delete from outbox_events where aggregate_id = 'obs' and event_type = 'test.observability'`);
      await sql(`delete from webhook_inbox where provider = 'observability-test'`);
    }
  });

  it('is readable by a platform admin', async () => {
    const admin = await signup(t, 'health-admin');
    await sql(`insert into platform_admins(user_id, role) values ($1, 'support')`, [admin.userId]);
    const res = await t.http.get('/v1/health/details').set(auth(admin));
    expect(res.status).toBe(200);
    expect(['ok', 'degraded']).toContain(res.body.status);
  });
});

describe('structured access log (CR-14)', () => {
  const lines: string[] = [];
  afterEach(() => { setLogSink(null); lines.length = 0; });

  it('defaults to JSON lines in deployed environments and text locally', () => {
    expect(logFormat({ NODE_ENV: 'staging' })).toBe('json');
    expect(logFormat({ NODE_ENV: 'production' })).toBe('json');
    expect(logFormat({ NODE_ENV: 'development' })).toBe('text');
    expect(logFormat({ NODE_ENV: 'development', LOG_FORMAT: 'json' })).toBe('json');
  });

  it('writes one parseable JSON object per response with the validated request id and the route pattern only', async () => {
    setLogSink((l) => lines.push(l));
    writeAccessLog({ requestId: 'req-12345678', method: 'GET', route: '/v1/public/tables/:qr', status: 200, ms: 3, orgId: null, actor: null, ip: '10.0.0.1' }, 'json');
    const entry = JSON.parse(lines[0]);
    expect(entry).toEqual(expect.objectContaining({ type: 'access', level: 'info', service: 'api', requestId: 'req-12345678', route: '/v1/public/tables/:qr', status: 200 }));
    expect(typeof entry.ts).toBe('string');
  });

  it('is what the API writes for a real request when LOG_FORMAT=json', async () => {
    process.env.LOG_FORMAT = 'json';
    setLogSink((l) => lines.push(l));
    try {
      await t.http.get('/v1/public/tables/not-a-real-qr-token-000000').set('X-Request-Id', 'obs-req-87654321');
      await new Promise((r) => setTimeout(r, 20));
    } finally { delete process.env.LOG_FORMAT; }
    const entry = lines.map((l) => JSON.parse(l)).find((e) => e.requestId === 'obs-req-87654321');
    expect(entry).toBeDefined();
    expect(entry.type).toBe('access');
    expect(entry.route).toBe('/v1/public/tables/:qrToken');
    expect(JSON.stringify(entry)).not.toContain('not-a-real-qr-token');
  });
});

describe('error tracking (CR-14)', () => {
  it('parses Sentry-compatible DSNs and refuses anything else', () => {
    expect(parseDsn('https://abc123@o1.ingest.example.io/42')).toEqual({ endpoint: 'https://o1.ingest.example.io/api/42/envelope/', publicKey: 'abc123', raw: 'https://abc123@o1.ingest.example.io/42' });
    expect(parseDsn('https://key@glitchtip.example.com/sub/7')?.endpoint).toBe('https://glitchtip.example.com/sub/api/7/envelope/');
    expect(parseDsn(undefined)).toBeNull();
    expect(parseDsn('https://o1.ingest.example.io/42')).toBeNull();   // no key
    expect(parseDsn('https://k@host/not-a-project')).toBeNull();
    expect(parseDsn('not a url')).toBeNull();
  });

  it('scrubs emails, phone numbers, tokens, keys, query strings and connection strings from messages', () => {
    const text = scrub('owner@olive-room.demo.test called +201090001001 with Bearer abc.def.ghi, key rmcp_abcdefgh123, '
      + 'jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig, token 3f0c2a9e8b7d6c5f4e3d2c1b0a9f8e7d, /pay/x?token=secret and postgres://u:p@h/db');
    expect(text).not.toMatch(/olive-room|1090001001|abc\.def|rmcp_abcd|eyJhbG|3f0c2a9e8b7d|secret|u:p@h/);
    expect(text).toContain('[email]');
  });

  it('builds an event with the route pattern, request id and release, and nothing from the request', () => {
    const err = Object.assign(new Error('insert failed for mona@example.com'), { code: '23505' });
    const event = buildEvent(err, { requestId: 'req-abcdef12', route: '/v1/o/:orgId/orders' }, 'staging');
    expect(event.tags).toEqual(expect.objectContaining({ route: '/v1/o/:orgId/orders', request_id: 'req-abcdef12', pg_code: '23505', service: 'api' }));
    expect(event.exception.values[0].value).toBe('insert failed for [email]');
    expect(event.environment).toBe('staging');
    expect(JSON.stringify(event)).not.toMatch(/user|cookie|headers|body/i);
    const frames = framesOf('Error: x\n    at Foo.bar (/srv/app/apps/api/dist/modules/orders/orders.service.js:10:5)\n    at node:internal/process:1:1');
    expect(frames.at(-1)).toEqual(expect.objectContaining({ filename: 'apps/api/dist/modules/orders/orders.service.js', function: 'Foo.bar', lineno: 10, in_app: true }));
  });

  it('is off without a DSN and posts one envelope per distinct error when configured (never throwing)', async () => {
    expect(await new ErrorReporter(undefined, 'test').capture(new Error('x'))).toBe('skipped');
    const sent: Array<{ url: string; init: RequestInit }> = [];
    const fake = (async (url: string, init: RequestInit) => { sent.push({ url, init }); return new Response('{}', { status: 200 }); }) as unknown as typeof fetch;
    const r = new ErrorReporter('https://pubkey@errors.example.test/9', 'staging', fake);
    expect(r.enabled).toBe(true);
    expect(await r.capture(new Error('boom for +201090001001'), { route: '/v1/health' })).toBe('sent');
    expect(await r.capture(new Error('boom for +201090001001'), { route: '/v1/health' })).toBe('skipped');   // same error within a minute
    expect(sent).toHaveLength(1);
    expect(sent[0].url).toBe('https://errors.example.test/api/9/envelope/');
    expect(String((sent[0].init.headers as Record<string, string>)['X-Sentry-Auth'])).toContain('sentry_key=pubkey');
    const [head, item, payload] = String(sent[0].init.body).split('\n').map((l) => JSON.parse(l));
    expect(head.event_id).toBe(payload.event_id);
    expect(item.type).toBe('event');
    expect(JSON.stringify(payload)).not.toContain('1090001001');
    const failing = new ErrorReporter('https://pubkey@errors.example.test/9', 'staging', (async () => { throw new Error('network'); }) as unknown as typeof fetch);
    expect(await failing.capture(new Error('y'))).toBe('failed');
  });
});
