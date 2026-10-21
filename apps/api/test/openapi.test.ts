import 'reflect-metadata';
import { lintOpenApi, stableJson } from '@resuto/contracts/openapi';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OpenApiService } from '../src/common/http/openapi';
import { bootTestApp, type TestApp } from './helpers';

// Audit PS-19 / PS-23: there was no API description (GET /v1/openapi.json was a 404) and no check that routes follow
// the style rules. The document is generated from the router; this file is the CI gate (docs/API_STYLE.md):
//   - every route Express actually serves is in the document,
//   - the committed copy docs/api/openapi.json matches (regenerate: UPDATE_OPENAPI=1 npx vitest run test/openapi.test.ts),
//   - the style lint passes (action POSTs answer 200, lists take a bounded limit and a cursor, no example data …).

const COMMITTED = path.resolve(__dirname, '../../../docs/api/openapi.json');
let t: TestApp;

beforeAll(async () => { t = await bootTestApp(); });
afterAll(async () => { await t?.close(); });

/** (METHOD path) of every route layer in the Express router, in OpenAPI path syntax. */
function expressRoutes(): string[] {
  const app = t.app.getHttpAdapter().getInstance() as { router?: { stack: unknown[] }; _router?: { stack: unknown[] } };
  const stack = (app.router ?? app._router)?.stack ?? [];
  const out: string[] = [];
  for (const layer of stack as Array<{ route?: { path: string; methods: Record<string, boolean> } }>) {
    if (!layer.route) continue;
    const p = layer.route.path.replace(/\{\*([A-Za-z0-9_]+)\}/g, '{$1}').replace(/\*([A-Za-z0-9_]+)/g, '{$1}').replace(/:([A-Za-z0-9_]+)/g, '{$1}')
      .replace(/(.)\/$/, '$1');
    for (const [m, on] of Object.entries(layer.route.methods)) if (on && m !== '_all') out.push(`${m.toUpperCase()} ${p}`);
  }
  return out;
}

describe('OpenAPI document (PS-19)', () => {
  it('is served publicly at /v1/openapi.json as OpenAPI 3.1', async () => {
    const res = await t.http.get('/v1/openapi.json');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/json/);
    expect(res.body.openapi).toBe('3.1.0');
    expect(res.body).toEqual(JSON.parse(JSON.stringify(t.app.get(OpenApiService).document())));
  });

  it('describes every route the router serves (a new controller route cannot be missing)', () => {
    const doc = t.app.get(OpenApiService).document();
    const documented = new Set(Object.entries(doc.paths).flatMap(([p, ops]) => Object.keys(ops).map((m) => `${m.toUpperCase()} ${p}`)));
    const served = expressRoutes();
    expect(served.length).toBeGreaterThan(300);
    expect(served.filter((r) => !documented.has(r))).toEqual([]);
    expect([...documented].filter((r) => !served.includes(r))).toEqual([]);
  });

  it('follows the API style rules (docs/API_STYLE.md)', () => {
    expect(lintOpenApi(t.app.get(OpenApiService).document())).toEqual([]);
  });

  it('carries request schemas from @resuto/contracts and no secrets', () => {
    const doc = t.app.get(OpenApiService).document();
    const createOrg = doc.paths['/v1/orgs']!.post!;
    expect((createOrg.requestBody as any).content['application/json'].schema.properties).toHaveProperty('name');
    const list = doc.paths['/v1/o/{orgId}/marketing/campaigns']!.get!;
    expect(list.parameters!.find((p) => p.name === 'limit')!.schema).toMatchObject({ maximum: 200 });
    expect(list.responses!['200']!.content!['application/json']!.schema).toEqual({ $ref: '#/components/schemas/Page' });
    expect(doc.paths['/v1/health']!.get!.security).toEqual([]);
    expect(doc.paths['/v1/o/{orgId}/orders/{id}/cancel']!.post!.responses).toHaveProperty('200');
    const text = JSON.stringify(doc);
    for (const secret of [process.env.SUPABASE_JWT_SECRET, process.env.DATABASE_URL]) if (secret) expect(text).not.toContain(secret);
  });

  it('matches the committed docs/api/openapi.json (no drift)', () => {
    const current = stableJson(t.app.get(OpenApiService).document());
    if (process.env.UPDATE_OPENAPI === '1') {
      fs.mkdirSync(path.dirname(COMMITTED), { recursive: true });
      fs.writeFileSync(COMMITTED, current);
    }
    const committed = fs.existsSync(COMMITTED) ? fs.readFileSync(COMMITTED, 'utf8') : '';
    expect(committed === current, 'docs/api/openapi.json is stale: run UPDATE_OPENAPI=1 npx vitest run test/openapi.test.ts in apps/api and commit it').toBe(true);
  });
});
