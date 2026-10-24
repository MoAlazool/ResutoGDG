import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { listQuery } from './api';
import { jsonSchemaOf, lintOpenApi, stableJson, type OpenApiDoc, type SchemaDefs } from './openapi';

const op = (status: string, extra: Record<string, unknown> = {}) => ({
  operationId: `op${Math.random()}`, parameters: [], responses: { [status]: { description: 'ok' }, default: { $ref: '#/components/responses/Error' } }, ...extra,
});

describe('OpenAPI helpers (PS-19, PS-23)', () => {
  it('converts request schemas as clients send them, without examples', () => {
    const s = jsonSchemaOf(listQuery) as any;
    expect(s.properties.limit).toMatchObject({ maximum: 200, minimum: 1 });
    expect(JSON.stringify(jsonSchemaOf(z.object({ a: z.string().meta({ examples: ['secret'] }) })))).not.toContain('secret');
  });

  it('moves a recursive schema\'s definitions to components/schemas and rewrites its references', () => {
    type Rule = { type: 'and'; rules: Rule[] } | { type: 'leaf'; n: number };
    const rule: z.ZodType<Rule> = z.lazy(() => z.discriminatedUnion('type', [
      z.object({ type: z.literal('and'), rules: z.array(rule) }), z.object({ type: z.literal('leaf'), n: z.number() })]));
    const defs: SchemaDefs = {};
    const a = jsonSchemaOf(z.object({ rule }), defs);
    const b = jsonSchemaOf(z.object({ filter: rule }), defs);
    const text = JSON.stringify([a, b, defs]);
    expect(text).not.toContain('#/$defs/');
    expect(a.$defs).toBeUndefined();
    const refs = [...text.matchAll(/"\$ref":"#\/components\/schemas\/([^"]+)"/g)].map((m) => m[1]);
    expect(refs.length).toBeGreaterThan(0);
    for (const name of refs) expect(defs[name!]).toBeDefined();
    // The same schema used by two routes is published once.
    expect(Object.keys(defs).length).toBe(new Set(refs).size);
    // A schema that is itself recursive (`$ref: "#"`) is published as a component too.
    expect(() => jsonSchemaOf(rule)).toThrow(/defs map/);
    const root = jsonSchemaOf(rule, defs);
    expect(root.$ref).toMatch(/^#\/components\/schemas\/Recursive_[0-9a-f]{8}$/);
    expect(JSON.stringify(defs)).not.toMatch(/"\$ref":"#"/);
  });

  it('flags a $ref that does not resolve in the document', () => {
    const doc = { openapi: '3.1.0', paths: { '/v1/x': { get: op('200', { requestBody: { content: { 'application/json': { schema: { $ref: '#/$defs/__schema0' } } } } }) } } } as unknown as OpenApiDoc;
    expect(lintOpenApi(doc).join('\n')).toContain('$ref #/$defs/__schema0 does not resolve');
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
    const doc = { openapi: '3.1.0', paths: { '/v1/invitations/accept': { post: op('201') } },
      components: { responses: { Error: { description: 'Error envelope' } } } } as unknown as OpenApiDoc;
    expect(lintOpenApi(doc)).toEqual([]);
    expect(stableJson({ b: 1, a: { d: 1, c: 2 } })).toBe('{\n  "a": {\n    "c": 2,\n    "d": 1\n  },\n  "b": 1\n}\n');
  });
});
