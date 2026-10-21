#!/usr/bin/env node
// OpenAPI check against a running API (audit PS-19, docs/API_STYLE.md).
//
// Fetches GET <API_URL>/v1/openapi.json, runs the style lint from @resuto/contracts (lintOpenApi) and compares the
// document with the committed copy docs/api/openapi.json. The API suite runs the same checks in-process
// (apps/api/test/openapi.test.ts, also a CI step); this script is for a deployed or locally started API.
//
//   API_URL=http://127.0.0.1:4000 node scripts/openapi/check.mjs            lint + drift, exit 1 on a problem
//   API_URL=http://127.0.0.1:4000 node scripts/openapi/check.mjs --write    lint, then rewrite docs/api/openapi.json
//
// Needs the contracts package built (pnpm --filter @resuto/contracts build).
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(path.join(root, 'packages/contracts/package.json'));
const { lintOpenApi, stableJson } = require('./dist/openapi.js');
const committedPath = path.join(root, 'docs/api/openapi.json');

const base = (process.env.API_URL ?? 'http://127.0.0.1:4000').replace(/\/$/, '');
const res = await fetch(`${base}/v1/openapi.json`, { headers: { Accept: 'application/json' } });
if (!res.ok) {
  console.error(`GET ${base}/v1/openapi.json answered ${res.status}`);
  process.exit(1);
}
const doc = await res.json();
const problems = lintOpenApi(doc);
for (const p of problems) console.error(`lint: ${p}`);

const current = stableJson(doc);
let drift = false;
if (process.argv.includes('--write')) {
  writeFileSync(committedPath, current);
  console.log(`wrote ${path.relative(root, committedPath)}`);
} else {
  let committed = '';
  try { committed = readFileSync(committedPath, 'utf8'); } catch { /* missing counts as drift */ }
  drift = committed !== current;
  if (drift) console.error('drift: docs/api/openapi.json differs from the served document (regenerate with --write and commit it)');
}
const operations = Object.values(doc.paths).reduce((n, ops) => n + Object.keys(ops).length, 0);
console.log(`${operations} operations, ${problems.length} lint problem(s)${drift ? ', document drifted' : ''}`);
process.exit(problems.length || drift ? 1 : 0);
