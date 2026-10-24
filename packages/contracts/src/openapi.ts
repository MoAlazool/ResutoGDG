import { z } from 'zod';
import { apiErrorSchema, MAX_LIST_LIMIT } from './api';

/**
 * OpenAPI 3.1 helpers (subpath export '@resuto/contracts/openapi', kept out of the main entry so browser bundles never
 * carry them) shared by the API (which generates GET /v1/openapi.json from its router metadata), its test
 * suite and scripts/openapi/check.mjs (audit PS-19, PS-23; docs/API_STYLE.md). Pure functions over JSON: no Nest here.
 */

export type JsonSchema = Record<string, unknown>;

/**
 * JSON Schema (draft 2020-12, the dialect of OpenAPI 3.1) for a zod schema as a client sends it (`io: 'input'`:
 * coerced numbers are strings on the wire, defaults are optional). Transforms and refinements that JSON Schema cannot
 * express become `{}` instead of failing, so a route always gets a document.
 */
export function jsonSchemaOf(schema: z.ZodType, defs?: SchemaDefs): JsonSchema {
  const out = stripExamples(z.toJSONSchema(schema, { target: 'draft-2020-12', io: 'input', unrepresentable: 'any', reused: 'inline' })) as JsonSchema;
  delete out.$schema;
  const local = (out.$defs ?? {}) as Record<string, JsonSchema>;
  delete out.$defs;
  const selfRef = JSON.stringify(out).includes('"$ref":"#"');
  if (!Object.keys(local).length && !selfRef) return out;
  // A recursive schema (e.g. a segment rule that nests and/or rules) cannot be inlined: zod refers to it as
  // `#/$defs/<name>`, or as `#` when the schema itself is the recursive one. Inside an OpenAPI document `#` is the
  // document root, so those definitions move to components/schemas under a name derived from their content (stable,
  // shared by every route that uses the same schema) and the references are rewritten to point there.
  if (!defs) throw new Error('jsonSchemaOf: a recursive schema needs a defs map to collect its definitions');
  const ref = (name: string) => `#/components/schemas/${name}`;
  const names = new Map(Object.entries(local).map(([k, v]) => [k, `Recursive_${fnv1a(stableJson(v))}`]));
  const rootName = selfRef ? `Recursive_${fnv1a(stableJson(out))}` : null;
  const rewrite = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(rewrite);
    if (!v || typeof v !== 'object') return v;
    const o: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v)) {
      if (k === '$ref' && val === '#' && rootName) { o[k] = ref(rootName); continue; }
      const m = k === '$ref' && typeof val === 'string' ? /^#\/\$defs\/(.+)$/.exec(val) : null;
      o[k] = m && names.has(m[1]!) ? ref(names.get(m[1]!)!) : rewrite(val);
    }
    return o;
  };
  for (const [k, v] of Object.entries(local)) defs[names.get(k)!] = rewrite(v) as JsonSchema;
  if (!rootName) return rewrite(out) as JsonSchema;
  defs[rootName] = rewrite(out) as JsonSchema;
  return { $ref: ref(rootName) };
}

/** Definitions collected from recursive schemas, published as components/schemas. */
export type SchemaDefs = Record<string, JsonSchema>;

/** 32-bit FNV-1a as 8 hex digits: a short, deterministic component name (no Node crypto in this browser-safe module). */
function fnv1a(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193) >>> 0;
  return h.toString(16).padStart(8, '0');
}

/** Removes `example`/`examples` recursively: the published document never carries sample data (PS-19). */
function stripExamples(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stripExamples);
  if (!v || typeof v !== 'object') return v;
  const o: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(v)) if (k !== 'example' && k !== 'examples') o[k] = stripExamples(val);
  return o;
}

/** Components every document carries: the error envelope and the list page. */
export function baseComponents() {
  return {
    schemas: {
      Error: jsonSchemaOf(apiErrorSchema),
      Page: {
        type: 'object',
        required: ['items', 'nextCursor'],
        properties: {
          items: { type: 'array', items: {} },
          nextCursor: { anyOf: [{ type: 'string' }, { type: 'null' }], description: 'Opaque cursor of the next page; null on the last page.' },
        },
      },
    },
    securitySchemes: {
      bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT', description: 'Supabase Auth access token (staff), or an MCP key on /mcp routes.' },
      posDeviceAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'rpos_ device credential',
        description: 'Paired POS device credential (POST /v1/pos/pair). Accepted only on the POS device routes (/v1/pos/...).' },
    },
  };
}

// ---------------------------------------------------------------------------
// Lint (docs/API_STYLE.md, machine-checkable rules)
// ---------------------------------------------------------------------------

/**
 * Last path segments that name an action rather than a collection. A POST ending in one of them answers 200 (or
 * 202/204), never 201, unless it is listed in CREATING_ACTIONS (PS-23).
 */
export const ACTION_SEGMENTS = new Set([
  'accept', 'account', 'anonymise', 'apply', 'approve', 'assign', 'availability', 'bump', 'cancel', 'cart', 'check', 'check-in',
  'checkout', 'clean', 'close', 'collect', 'commit', 'complete', 'compliance-checks', 'compliance-csid', 'consent', 'deny', 'details',
  'disable', 'discard', 'dry-run', 'enable', 'generate-copy', 'handoff', 'health', 'image', 'inbound', 'issue', 'launch', 'merge',
  'no-show', 'plan', 'preview', 'production-csid', 'publish', 'push', 'read', 'read-all', 'refresh', 'refund', 'reject', 'reopen',
  'reorder', 'reply', 'resend', 'reset', 'resolve', 'restore', 'resubmit', 'retry', 'review', 'revoke', 'schedule', 'send', 'start',
  'submit', 'sync', 'test', 'test-event', 'transition', 'undo', 'verify', 'file',
]);

/** Action-named POSTs that do create a resource, so 201 is right (`METHOD path` as in the document). */
export const CREATING_ACTIONS = new Set([
  'POST /v1/invitations/accept', // creates the membership
  'POST /v1/o/{orgId}/connect/conversations/{id}/reply', // creates the outbound message
  'POST /v1/o/{orgId}/connect/conversations/{id}/handoff', // creates the handoff request
  'POST /v1/public/connect/ordering/{token}/checkout', // creates the order
  'POST /v1/o/{orgId}/payments/alerts/{alertId}/refund', // creates the refund
  'POST /v1/o/{orgId}/compliance/fiscal-documents/issue', // creates the fiscal document
  'POST /v1/o/{orgId}/marketing/recommendations/{key}/apply', // creates the campaign draft
  'POST /v1/o/{orgId}/payments/collect', // records the payment
  'POST /v1/o/{orgId}/driver/me/push', // creates the push subscription
  'POST /v1/o/{orgId}/menu-import/jobs/file', // creates the extraction job
]);

/**
 * GETs whose `limit` is a "top N" of a ranking rather than a page size, so they take no cursor: the churn list is
 * ordered by a score computed per request, and the next "page" of a ranking is not a stable concept.
 */
export const TOP_N_LISTS = new Set(['GET /v1/o/{orgId}/intelligence/churn']);

export interface OpenApiDoc {
  openapi: string;
  paths: Record<string, Record<string, OpenApiOperation>>;
  components?: { schemas?: Record<string, unknown>; responses?: Record<string, unknown>; securitySchemes?: Record<string, unknown> };
  [k: string]: unknown;
}
export interface OpenApiOperation {
  operationId?: string;
  parameters?: Array<{ name: string; in: string; required?: boolean; schema?: JsonSchema }>;
  responses?: Record<string, { $ref?: string; content?: Record<string, { schema?: JsonSchema }> }>;
  [k: string]: unknown;
}

/** Returns one message per broken rule (empty = clean). */
export function lintOpenApi(doc: OpenApiDoc): string[] {
  const problems: string[] = [];
  if (!/^3\.1\./.test(doc.openapi)) problems.push(`openapi must be 3.1.x (got ${doc.openapi})`);
  const ids = new Map<string, string>();
  const text = JSON.stringify(doc);
  if (/"examples?"\s*:/.test(text)) problems.push('the document must not carry example data');
  // Every reference must resolve inside this document (a schema-local `#/$defs/...` would point at the document root).
  for (const ref of new Set([...text.matchAll(/"\$ref":"([^"]*)"/g)].map((m) => m[1]!))) {
    const target = ref.startsWith('#/') ? ref.slice(2).split('/').reduce<unknown>((node, key) =>
      (node && typeof node === 'object' ? (node as Record<string, unknown>)[key.replace(/~1/g, '/').replace(/~0/g, '~')] : undefined), doc) : undefined;
    if (target === undefined) problems.push(`$ref ${ref} does not resolve in the document`);
  }
  for (const [path, ops] of Object.entries(doc.paths)) {
    if (!path.startsWith('/v1/')) problems.push(`${path}: every route lives under /v1`);
    const pathParams = [...path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]);
    for (const [method, op] of Object.entries(ops)) {
      const where = `${method.toUpperCase()} ${path}`;
      if (!op.operationId) problems.push(`${where}: missing operationId`);
      else if (ids.has(op.operationId)) problems.push(`${where}: operationId ${op.operationId} repeats ${ids.get(op.operationId)}`);
      else ids.set(op.operationId, where);
      const declared = new Set((op.parameters ?? []).filter((p) => p.in === 'path').map((p) => p.name));
      for (const p of pathParams) if (!declared.has(p!)) problems.push(`${where}: path parameter {${p}} is not declared`);
      const responses = op.responses ?? {};
      const success = Object.keys(responses).filter((s) => /^2\d\d$/.test(s));
      if (success.length !== 1) problems.push(`${where}: exactly one success status expected (got ${success.join(', ') || 'none'})`);
      if (responses.default?.$ref !== '#/components/responses/Error') problems.push(`${where}: the default response must be the Error envelope`);
      if (method === 'post' && success[0] === '201') {
        const last = path.split('/').filter((s) => s && !s.startsWith('{')).pop() ?? '';
        if (ACTION_SEGMENTS.has(last) && !CREATING_ACTIONS.has(where)) {
          problems.push(`${where}: an action that creates nothing answers 200 (@HttpCode(200)), not 201`);
        }
      }
      if (method === 'get') {
        const query = new Map((op.parameters ?? []).filter((p) => p.in === 'query').map((p) => [p.name, p]));
        const limit = query.get('limit');
        if (limit) {
          if (!query.has('cursor') && !TOP_N_LISTS.has(where)) problems.push(`${where}: a list with limit must also take cursor (keyset pagination)`);
          const max = (limit.schema as { maximum?: number } | undefined)?.maximum;
          if (typeof max !== 'number' || max > MAX_LIST_LIMIT) problems.push(`${where}: limit needs a maximum <= ${MAX_LIST_LIMIT}`);
        }
      }
    }
  }
  return problems;
}

/** Stable serialisation of a document (sorted keys), so the committed copy diffs cleanly. */
export function stableJson(value: unknown): string {
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sort);
    if (!v || typeof v !== 'object') return v;
    return Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, sort((v as Record<string, unknown>)[k])]));
  };
  return `${JSON.stringify(sort(value), null, 2)}\n`;
}
