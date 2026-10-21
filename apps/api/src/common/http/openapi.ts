import { Injectable, RequestMethod } from '@nestjs/common';
import { HEADERS_METADATA, HTTP_CODE_METADATA, METHOD_METADATA, PATH_METADATA, ROUTE_ARGS_METADATA } from '@nestjs/common/constants';
import { RouteParamtypes } from '@nestjs/common/enums/route-paramtypes.enum';
import { ModulesContainer } from '@nestjs/core';
import { baseComponents, jsonSchemaOf, type JsonSchema, type OpenApiDoc, type OpenApiOperation } from '@resuto/contracts/openapi';
import { z } from 'zod';
import { IS_PUBLIC, MODULE, PERMISSION, PLATFORM_ROLE } from '../auth/decorators';
import { ZodPipe } from './zod.pipe';

/**
 * OpenAPI 3.1 description of the API (audit PS-19), generated from what the router actually serves: every controller
 * method Nest registered (path, method, status from @HttpCode, @Public / permission / module metadata) and, where the
 * handler validates with zod(...), the request body and query schemas from @resuto/contracts. Served at
 * GET /v1/openapi.json; test/openapi.test.ts fails when a registered route is missing, when the committed copy
 * (docs/api/openapi.json) drifts, or when a route breaks the style rules (lintOpenApi, docs/API_STYLE.md).
 *
 * No examples, no server URLs, no build ids: the document is the same on every machine and never carries data.
 */

const METHODS: Record<number, string> = {
  [RequestMethod.GET]: 'get', [RequestMethod.POST]: 'post', [RequestMethod.PUT]: 'put', [RequestMethod.PATCH]: 'patch',
  [RequestMethod.DELETE]: 'delete', [RequestMethod.OPTIONS]: 'options', [RequestMethod.HEAD]: 'head', [RequestMethod.ALL]: 'all',
};

export const GLOBAL_PREFIX = 'v1';

interface RouteArg { index: number; data?: unknown; pipes?: unknown[] }

const asArray = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : v === undefined || v === null ? [''] : [String(v)]);

/** Nest path syntax to OpenAPI: `:id` → `{id}`, `*path` → `{path}`; one leading slash, no trailing one. */
export function toOpenApiPath(...parts: string[]): string {
  const joined = `/${parts.filter((p) => p !== '').join('/')}`.replace(/\/+/g, '/').replace(/(.)\/$/, '$1');
  return joined.replace(/:([A-Za-z0-9_]+)/g, '{$1}').replace(/\*([A-Za-z0-9_]+)/g, '{$1}');
}

const zodOf = (pipes: unknown[] | undefined): z.ZodType | null => {
  for (const p of pipes ?? []) if (p instanceof ZodPipe) return p.schema as z.ZodType;
  return null;
};

/** Splits an object schema into query parameters; anything else is one `query` object parameter. */
function queryParameters(schema: z.ZodType) {
  const json = jsonSchemaOf(schema) as { properties?: Record<string, JsonSchema>; required?: string[] };
  if (!json.properties) return [{ name: 'query', in: 'query', required: false, schema: json }];
  return Object.entries(json.properties).map(([name, s]) => ({ name, in: 'query', required: (json.required ?? []).includes(name), schema: s }));
}

export interface RouteInfo { method: string; path: string; operationId: string }

@Injectable()
export class OpenApiService {
  private cached: OpenApiDoc | null = null;

  constructor(private readonly modules: ModulesContainer) {}

  document(): OpenApiDoc {
    return (this.cached ??= this.build());
  }

  /** Every (method, path) the controllers register, independent of the document (used by the drift check). */
  routes(): RouteInfo[] {
    const doc = this.document();
    return Object.entries(doc.paths).flatMap(([path, ops]) => Object.entries(ops).map(([method, op]) => ({ method, path, operationId: op.operationId! })));
  }

  private build(): OpenApiDoc {
    const paths: Record<string, Record<string, OpenApiOperation>> = {};
    const seen = new Set<unknown>();
    for (const mod of this.modules.values()) {
      for (const wrapper of mod.controllers.values()) {
        const ctrl = wrapper.metatype as (new (...a: unknown[]) => unknown) | null;
        if (!ctrl || seen.has(ctrl)) continue;
        seen.add(ctrl);
        const ctrlPaths = asArray(Reflect.getMetadata(PATH_METADATA, ctrl));
        const proto = ctrl.prototype as Record<string, unknown>;
        for (const name of Object.getOwnPropertyNames(proto)) {
          const handler = proto[name];
          if (name === 'constructor' || typeof handler !== 'function') continue;
          const methodCode = Reflect.getMetadata(METHOD_METADATA, handler) as number | undefined;
          const routePath = Reflect.getMetadata(PATH_METADATA, handler);
          if (methodCode === undefined || routePath === undefined) continue;
          const method = METHODS[methodCode] ?? 'get';
          for (const cp of ctrlPaths) {
            for (const rp of asArray(routePath)) {
              const path = toOpenApiPath(GLOBAL_PREFIX, cp, rp);
              (paths[path] ??= {})[method] = this.operation(ctrl, name, handler as (...a: unknown[]) => unknown, method, path);
            }
          }
        }
      }
    }
    const sorted = Object.fromEntries(Object.keys(paths).sort().map((p) => [p, paths[p]!]));
    const components = baseComponents();
    return {
      openapi: '3.1.0',
      info: {
        title: 'Resuto API',
        version: '1',
        description: 'Generated from the Nest router and the @resuto/contracts schemas (docs/API_STYLE.md). '
          + 'Errors use the Error envelope; lists answer { items, nextCursor } and take limit (1-200) and an opaque cursor.',
      },
      security: [{ bearerAuth: [] }],
      paths: sorted,
      components: {
        ...components,
        responses: { Error: { description: 'Error envelope (code, message, details, requestId).', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } } },
      },
    };
  }

  private operation(ctrl: { name: string }, name: string, handler: (...a: unknown[]) => unknown, method: string, path: string): OpenApiOperation {
    const meta = <T>(key: string): T | undefined => (Reflect.getMetadata(key, handler) ?? Reflect.getMetadata(key, ctrl)) as T | undefined;
    const isPublic = meta<boolean>(IS_PUBLIC) === true;
    const status = (Reflect.getMetadata(HTTP_CODE_METADATA, handler) as number | undefined) ?? (method === 'post' ? 201 : 200);
    const args = (Reflect.getMetadata(ROUTE_ARGS_METADATA, ctrl, name) ?? {}) as Record<string, RouteArg>;
    const parameters: NonNullable<OpenApiOperation['parameters']> = [];
    let body: JsonSchema | null = null;
    let multipart = false;
    let usesResponse = false;
    let isList = false;
    for (const [key, arg] of Object.entries(args)) {
      const type = Number(key.split(':')[0]);
      if (Number.isNaN(type)) continue; // custom decorators (@Tenant, @Principal)
      if (type === RouteParamtypes.PARAM && typeof arg.data === 'string') {
        const uuid = (arg.pipes ?? []).some((p) => (p as { constructor?: { name?: string } })?.constructor?.name === 'ParseUUIDPipe');
        const int = (arg.pipes ?? []).some((p) => (p as { constructor?: { name?: string } })?.constructor?.name === 'ParseIntPipe');
        const zs = zodOf(arg.pipes);
        parameters.push({ name: arg.data, in: 'path', required: true,
          schema: zs ? jsonSchemaOf(zs) : uuid ? { type: 'string', format: 'uuid' } : int ? { type: 'integer' } : { type: 'string' } });
      } else if (type === RouteParamtypes.QUERY) {
        const zs = zodOf(arg.pipes);
        if (typeof arg.data === 'string') parameters.push({ name: arg.data, in: 'query', required: false, schema: zs ? jsonSchemaOf(zs) : { type: 'string' } });
        else if (zs) {
          const q = queryParameters(zs);
          isList ||= q.some((p) => p.name === 'limit') && q.some((p) => p.name === 'cursor');
          parameters.push(...q);
        }
      } else if (type === RouteParamtypes.HEADERS && typeof arg.data === 'string') {
        parameters.push({ name: arg.data, in: 'header', required: false, schema: { type: 'string' } });
      } else if (type === RouteParamtypes.BODY) {
        const zs = zodOf(arg.pipes);
        body = zs ? jsonSchemaOf(zs) : typeof arg.data === 'string' ? { type: 'object', properties: { [arg.data]: {} } } : { type: 'object' };
      } else if (type === RouteParamtypes.FILE || type === RouteParamtypes.FILES) {
        multipart = true;
      } else if (type === RouteParamtypes.RESPONSE) {
        usesResponse = true;
      }
    }
    // Path parameters Nest matches without a @Param (guards read :orgId) are still part of the contract.
    for (const m of path.matchAll(/\{([^}]+)\}/g)) {
      if (!parameters.some((p) => p.in === 'path' && p.name === m[1])) {
        parameters.push({ name: m[1]!, in: 'path', required: true, schema: m[1] === 'orgId' ? { type: 'string', format: 'uuid' } : { type: 'string' } });
      }
    }
    // Stable order: path, query, header; then by name.
    const rank: Record<string, number> = { path: 0, query: 1, header: 2 };
    parameters.sort((a, b) => (rank[a.in]! - rank[b.in]!) || a.name.localeCompare(b.name));
    const unique = parameters.filter((p, i) => parameters.findIndex((q) => q.in === p.in && q.name === p.name) === i);

    const headers = (Reflect.getMetadata(HEADERS_METADATA, handler) ?? []) as Array<{ name: string; value: string }>;
    const fullList = headers.some((h) => h.name.toLowerCase() === 'x-resuto-list' && h.value === 'full');
    const success = status === 204
      ? { description: 'No content' }
      : { description: usesResponse ? 'Response written by the handler (see the route\'s documentation).' : 'Success',
          content: { 'application/json': { schema: isList ? { $ref: '#/components/schemas/Page' } : {} } } };
    const op: OpenApiOperation = {
      operationId: `${ctrl.name.replace(/Controller$/, '')}_${name}`,
      tags: [path.split('/')[2] === 'o' ? (path.split('/')[4] ?? 'org') : (path.split('/')[2] ?? 'root')],
      parameters: unique,
      responses: { [String(status)]: success, default: { $ref: '#/components/responses/Error' } },
    };
    if (body || multipart) {
      op.requestBody = multipart
        ? { required: true, content: { 'multipart/form-data': { schema: { type: 'object', properties: { file: { type: 'string', contentMediaType: 'application/octet-stream' } } } } } }
        : { required: true, content: { 'application/json': { schema: body } } };
    }
    if (isPublic) op.security = [];
    const permissions = meta<string[]>(PERMISSION);
    if (permissions?.length) op['x-resuto-permissions'] = permissions;
    const module = meta<string>(MODULE);
    if (module) op['x-resuto-module'] = module;
    const platform = meta<string[]>(PLATFORM_ROLE);
    if (platform?.length) op['x-resuto-platform-admin'] = platform;
    if (fullList) op['x-resuto-full-list'] = true;
    return op;
  }
}
