// scripts/openapi/additive.mjs: what counts as a breaking change between two OpenAPI documents.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { breakingChanges } from '../additive.mjs';

const op = (extra = {}) => ({
  responses: { 200: { description: 'Success' }, default: { $ref: '#/components/responses/Error' } },
  parameters: [{ name: 'orgId', in: 'path', required: true }, { name: 'limit', in: 'query', required: false }],
  requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { a: {}, b: {} }, required: ['a'] } } } },
  ...extra,
});
const doc = (paths) => ({ openapi: '3.1.0', paths });
const base = doc({ '/v1/o/{orgId}/x': { post: op() }, '/v1/old': { get: op({ deprecated: true }) } });

test('new routes, new optional parameters and new optional body properties are additive', () => {
  const now = structuredClone(base);
  now.paths['/v1/pos/new'] = { get: op() };
  now.paths['/v1/o/{orgId}/x'].post.parameters.push({ name: 'cursor', in: 'query', required: false });
  now.paths['/v1/o/{orgId}/x'].post.requestBody.content['application/json'].schema.properties.c = {};
  assert.deepEqual(breakingChanges(base, now), []);
});

test('the committed document is additive against itself', async () => {
  const { readFileSync } = await import('node:fs');
  const current = JSON.parse(readFileSync(new URL('../../../docs/api/openapi.json', import.meta.url), 'utf8'));
  assert.deepEqual(breakingChanges(current, current), []);
});

test('removals, status changes and new requirements are breaking', () => {
  const now = structuredClone(base);
  delete now.paths['/v1/old']; // deprecated first: allowed
  const x = now.paths['/v1/o/{orgId}/x'].post;
  x.responses = { 201: { description: 'Created' }, default: x.responses.default };
  x.parameters = [{ name: 'orgId', in: 'path', required: true }, { name: 'limit', in: 'query', required: true }, { name: 'q', in: 'query', required: true }];
  const schema = x.requestBody.content['application/json'].schema;
  delete schema.properties.b;
  schema.required = ['a', 'c'];
  schema.properties.c = {};
  assert.deepEqual(breakingChanges(base, now), [
    'POST /v1/o/{orgId}/x: success status 200 → 201',
    'POST /v1/o/{orgId}/x: parameter query:limit is now required',
    'POST /v1/o/{orgId}/x: new required parameter query:q',
    'POST /v1/o/{orgId}/x: body property b removed',
    'POST /v1/o/{orgId}/x: body property c is now required',
  ]);
  const gone = structuredClone(base);
  delete gone.paths['/v1/o/{orgId}/x'];
  assert.deepEqual(breakingChanges(base, gone), ['POST /v1/o/{orgId}/x: removed (deprecate it first and keep it until clients moved)']);
});
