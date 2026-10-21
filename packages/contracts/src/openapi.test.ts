import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { listQuery } from './api';
import { jsonSchemaOf, lintOpenApi, stableJson, type OpenApiDoc } from './openapi';

const op = (status: string, extra: Record<string, unknown> = {}) => ({
  operationId: `op${Math.random()}`, parameters: [], responses: { [status]: { description: 'ok' }, default: { $ref: '#/components/responses/Error' } }, ...extra,
});

describe('OpenAPI helpers (PS-19, PS-23)', () => {
  it('converts request schemas as clients send them, without examples', () => {
    const s = jsonSchemaOf(listQuery) as any;
    expect(s.properties.limit).toMatchObject({ maximum: 200, minimum: 1 });
    expect(JSON.stringify(jsonSchemaOf(z.object({ a: z.string().meta({ examples: ['secret'] }) })))).not.toContain('secret');
  });

  it('flags a 201 on an action, a list without cursor, an unbounded limit and a missing error response', () => {
    const doc: OpenApiDoc = {
      openapi: '3.1.0',
      paths: {
        '/v1/o/{orgId}/orders/{id}/cancel': { post: { ...op('201'), parameters: [{ name: 'orgId', in: 'path' }, { name: 'id', in: 'path' }] } },
        '/v1/o/{orgId}/things': { get: { ...op('200'), parameters: [{ name: 'orgId', in: 'path' }, { name: 'limit', in: 'query', schema: { maximum: 1000 } }] } },
        '/v1/health': { get: { operationId: 'h', responses: { 200: {} } } as any },
      },
    };
    const problems = lintOpenApi(doc);
    expect(problems.some((p) => p.includes('cancel') && p.includes('200'))).toBe(true);
    expect(problems.some((p) => p.includes('things') && p.includes('cursor'))).toBe(true);
    expect(problems.some((p) => p.includes('things') && p.includes('maximum'))).toBe(true);
    expect(problems.some((p) => p.includes('/v1/health') && p.includes('Error envelope'))).toBe(true);
  });

  it('accepts a creating action on the allow-list and serialises stably', () => {
    const doc: OpenApiDoc = { openapi: '3.1.0', paths: { '/v1/invitations/accept': { post: op('201') } } };
    expect(lintOpenApi(doc)).toEqual([]);
    expect(stableJson({ b: 1, a: { d: 1, c: 2 } })).toBe('{\n  "a": {\n    "c": 2,\n    "d": 1\n  },\n  "b": 1\n}\n');
  });
});
