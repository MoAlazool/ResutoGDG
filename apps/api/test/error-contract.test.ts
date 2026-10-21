import 'reflect-metadata';
import { BadRequestException, PayloadTooLargeException } from '@nestjs/common';
import { HTTP_ERROR_CODES, isKnownErrorCode } from '@resuto/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DomainError } from '../src/common/errors/domain-error';
import { ApiExceptionFilter } from '../src/common/errors/exception.filter';
import { auth, bootTestApp, createTenant, type TestApp, type TestTenant } from './helpers';

// Audit PS-20: unknown routes, malformed JSON and bad UUIDs answered the catch-all code "http_error"; some errors had
// no requestId; a 429 without retry details had no Retry-After; unique/foreign-key violations leaked constraint names.

let t: TestApp;
let a: TestTenant;

beforeAll(async () => {
  t = await bootTestApp();
  a = await createTenant(t, { name: 'Error House' });
});
afterAll(async () => { await t?.close(); });

/** Every error body: { error: { code, message, requestId } } with the X-Request-Id header's value. */
function expectEnvelope(res: { status: number; body: any; headers: Record<string, string> }, status: number, code: string) {
  expect(res.status, JSON.stringify(res.body)).toBe(status);
  expect(res.body.error.code).toBe(code);
  expect(typeof res.body.error.message).toBe('string');
  expect(res.body.error.requestId).toBeTruthy();
  expect(res.body.error.requestId).toBe(res.headers['x-request-id']);
  expect(isKnownErrorCode(res.body.error.code), `${res.body.error.code} is registered`).toBe(true);
}

describe('stable codes for framework errors (PS-20)', () => {
  it('an unknown route is 404 not_found', async () => {
    expectEnvelope(await t.http.get('/v1/no-such-route'), 404, 'not_found');
    expectEnvelope(await t.http.post('/v1/o/x/no-such-route').send({}), 404, 'not_found');
  });

  it('a malformed JSON body is 400 invalid_json', async () => {
    const res = await t.http.post('/v1/orgs').set(auth(a.owner)).set('Content-Type', 'application/json').send('{"name": ');
    expectEnvelope(res, 400, 'invalid_json');
  });

  it('a malformed UUID in the path is 400 invalid_uuid', async () => {
    expectEnvelope(await t.http.get(`/v1/o/${a.orgId}/orders/not-a-uuid`).set(auth(a.owner)), 400, 'invalid_uuid');
  });

  it('schema validation is 400 validation_failed with a field path for each issue', async () => {
    const res = await t.http.post('/v1/orgs').set(auth(a.owner)).send({ name: '', slug: 'Bad Slug!' });
    expectEnvelope(res, 400, 'validation_failed');
    expect(res.body.error.details.map((d: { path: string }) => d.path)).toEqual(expect.arrayContaining(['slug']));
  });

  it('a missing Idempotency-Key is a malformed request (400), not a business rule (422)', async () => {
    const res = await t.http.post(`/v1/o/${a.orgId}/orders`).set(auth(a.owner))
      .send({ branchId: a.branchId, channel: 'pos', fulfillment: 'pickup', lines: [] });
    expect([400]).toContain(res.status);
    expect(['idempotency_key_required', 'validation_failed']).toContain(res.body.error.code);
    expect(res.body.error.requestId).toBe(res.headers['x-request-id']);
  });

  it('webhook verification failures and missing media carry the request id', async () => {
    expectEnvelope(await t.http.get('/v1/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=1'), 403, 'forbidden');
    expectEnvelope(await t.http.get('/v1/media/nothing/here.png?exp=1&sig=x'), 404, 'not_found');
  });
});

describe('exception filter details (PS-20)', () => {
  const filter = new ApiExceptionFilter();
  function run(exception: unknown) {
    const out: { status?: number; body?: any; headers: Record<string, string> } = { headers: {} };
    const res = {
      status(s: number) { out.status = s; return this; },
      json(b: unknown) { out.body = b; return this; },
      setHeader(k: string, v: string) { out.headers[k.toLowerCase()] = v; },
    };
    const req = { id: 'req-filter-test', method: 'POST', originalUrl: '/v1/x' };
    filter.catch(exception, { switchToHttp: () => ({ getResponse: () => res, getRequest: () => req }) } as any);
    return out;
  }

  it('every 429 has Retry-After, even when the thrower gave no retry hint', () => {
    const r = run(new DomainError('rate_limited', 'slow down', 429));
    expect(r.status).toBe(429);
    expect(Number(r.headers['retry-after'])).toBeGreaterThan(0);
    expect(r.body.error.requestId).toBe('req-filter-test');
    const hinted = run(new DomainError('rate_limited', 'slow down', 429, { retryAfterMs: 4200, limit: 5 }));
    expect(hinted.headers['retry-after']).toBe('5');
    expect(hinted.headers['ratelimit-limit']).toBe('5');
  });

  it('never returns constraint, table or column names or SQL text', () => {
    const pgError = Object.assign(new Error('duplicate key value violates unique constraint "branches_org_id_code_key"'), {
      code: '23505', constraint: 'branches_org_id_code_key', table: 'branches', column: 'code', schema: 'public',
      detail: 'Key (org_id, code)=(…) already exists.',
    });
    const r = run(pgError);
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('duplicate');
    const text = JSON.stringify(r.body);
    for (const leak of ['branches_org_id_code_key', 'branches', 'Key (', 'public', 'constraint']) expect(text).not.toContain(leak);
    const fk = run(Object.assign(new Error('insert or update on table "orders" violates foreign key constraint "orders_table_id_fkey"'),
      { code: '23503', constraint: 'orders_table_id_fkey', table: 'orders' }));
    expect(fk.body.error.code).toBe('reference_invalid');
    expect(JSON.stringify(fk.body)).not.toMatch(/orders|fkey/);
    const unknownPg = run(Object.assign(new Error('relation "secret_table" does not exist'), { code: '42P01' }));
    expect(unknownPg.status).toBe(500);
    expect(JSON.stringify(unknownPg.body)).not.toContain('secret_table');
  });

  it('maps Nest HTTP exceptions to registered codes', () => {
    expect(run(new PayloadTooLargeException()).body.error.code).toBe('payload_too_large');
    expect(run(new BadRequestException('Validation failed (uuid is expected)')).body.error.code).toBe('invalid_uuid');
    expect(run(new BadRequestException('something odd')).body.error.code).toBe('bad_request');
    for (const code of Object.keys(HTTP_ERROR_CODES)) expect(isKnownErrorCode(code)).toBe(true);
  });

  it('the error-code registry in @resuto/contracts lists every code the API source raises', async () => {
    // @ts-expect-error -- plain ESM script without types
    const { check, registry } = await import('../../../scripts/openapi/error-codes.mjs');
    expect(check(), 'run: node scripts/openapi/error-codes.mjs').toBe(true);
    for (const code of registry() as string[]) expect(isKnownErrorCode(code), code).toBe(true);
  });

  it('a 503 always carries Retry-After', () => {
    expect(run(new DomainError('provider_app_not_configured', 'x', 503)).headers['retry-after']).toBeTruthy();
    expect(run(Object.assign(new Error('timeout'), { code: '57014' })).headers['retry-after']).toBe('2');
  });
});
