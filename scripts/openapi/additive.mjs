#!/usr/bin/env node
// Additive-only check for /v1 (21-POSAPI, docs/api/IPAD_COMPATIBILITY.md "Breaking-change policy").
//
// Compares two OpenAPI documents (the base branch's docs/api/openapi.json and this one) and fails on a change that
// can break an existing client: an operation removed (unless the base already marked it deprecated), its success
// status changed, a parameter removed or newly required, a request body property removed or newly required, or the
// request body made required. New routes, new optional parameters and properties are fine.
//
//   node scripts/openapi/additive.mjs <base.json> <current.json>
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const successOf = (op) => Object.keys(op.responses ?? {}).filter((s) => /^2\d\d$/.test(s)).sort().join(',');
const bodyOf = (op) => op.requestBody?.content?.['application/json']?.schema ?? null;
const params = (op) => new Map((op.parameters ?? []).map((p) => [`${p.in}:${p.name}`, p]));

/** Breaking changes from `base` to `current` (empty = additive). */
export function breakingChanges(base, current) {
  const problems = [];
  for (const [path, ops] of Object.entries(base.paths ?? {})) {
    for (const [method, op] of Object.entries(ops)) {
      const where = `${method.toUpperCase()} ${path}`;
      const now = current.paths?.[path]?.[method];
      if (!now) {
        if (!op.deprecated) problems.push(`${where}: removed (deprecate it first and keep it until clients moved)`);
        continue;
      }
      if (successOf(op) !== successOf(now)) problems.push(`${where}: success status ${successOf(op)} → ${successOf(now)}`);
      const before = params(op);
      const after = params(now);
      for (const [key, p] of before) {
        if (!after.has(key)) problems.push(`${where}: parameter ${key} removed`);
        else if (!p.required && after.get(key).required) problems.push(`${where}: parameter ${key} is now required`);
      }
      for (const [key, p] of after) if (!before.has(key) && p.required && p.in !== 'path') problems.push(`${where}: new required parameter ${key}`);
      const b0 = bodyOf(op);
      const b1 = bodyOf(now);
      if (!op.requestBody?.required && now.requestBody?.required) problems.push(`${where}: request body is now required`);
      if (b0?.properties && b1?.properties) {
        for (const k of Object.keys(b0.properties)) if (!(k in b1.properties)) problems.push(`${where}: body property ${k} removed`);
        const req0 = new Set(b0.required ?? []);
        for (const k of b1.required ?? []) if (!req0.has(k)) problems.push(`${where}: body property ${k} is now required`);
      }
    }
  }
  return problems;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [basePath, currentPath] = process.argv.slice(2);
  if (!basePath || !currentPath) {
    console.error('usage: node scripts/openapi/additive.mjs <base.json> <current.json>');
    process.exit(2);
  }
  const problems = breakingChanges(JSON.parse(readFileSync(basePath, 'utf8')), JSON.parse(readFileSync(currentPath, 'utf8')));
  if (problems.length) {
    console.error(`Breaking API changes (docs/api/IPAD_COMPATIBILITY.md: add a new route and deprecate the old one):\n- ${problems.join('\n- ')}`);
    process.exit(1);
  }
  console.log('OpenAPI change is additive');
}
