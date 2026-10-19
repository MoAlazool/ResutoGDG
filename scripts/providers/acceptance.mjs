#!/usr/bin/env node
// Runs provider acceptance checks (packages/integrations/src/acceptance) against official test environments
// once credentials are configured. Not part of CI: it calls real providers.
//
//   node scripts/providers/acceptance.mjs [--provider paymob] [--capability checkout] [--list]
//        [--mode official_test|live] [--allow-live] [--allow spend,message,publish,fiscal] [--out reports/provider-acceptance]
//
// Credentials are read from environment variables named by each check (`--list` prints them). Values are never
// printed. Without credentials every check reports "not_run" with the missing variable names. Build first:
//   pnpm --filter @resuto/contracts build && pnpm --filter @resuto/integrations build
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(import.meta.url);
const integrations = require(path.join(root, 'packages/integrations/dist/index.js'));
try { require(path.join(root, 'packages/integrations/dist/acceptance/registry.js')); } catch { /* no provider checks registered yet */ }

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const opt = (name, def) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : def; };
const mode = opt('mode', 'official_test');
if (!['official_test', 'live'].includes(mode)) { console.error('--mode must be official_test or live'); process.exit(2); }

let checks = integrations.ACCEPTANCE_CHECKS;
if (opt('provider')) checks = checks.filter((c) => c.provider === opt('provider'));
if (opt('capability')) checks = checks.filter((c) => c.capability === opt('capability'));

if (flag('list')) {
  for (const c of checks) {
    console.log(`${c.id}  [${c.provider} / ${c.capability}]  effect=${c.effect}  modes=${c.modes.join(',')}`);
    console.log(`    env: ${c.requires.join(', ') || '(none)'}`);
    for (const p of c.prerequisites ?? []) console.log(`    before: ${p}`);
  }
  console.log(`\n${checks.length} check(s)`);
  process.exit(0);
}

const results = await integrations.runAcceptance(checks, {
  mode, env: process.env, allowLive: flag('allow-live'),
  allow: (opt('allow', '') || '').split(',').filter(Boolean),
});
const icon = { passed: '✓', failed: '✗', not_run: '·', blocked: '⊘' };
for (const r of results) console.log(`${icon[r.status]} ${r.id} — ${r.status}${r.reason ? ` (${r.reason})` : ''}`);
const counts = results.reduce((m, r) => ({ ...m, [r.status]: (m[r.status] ?? 0) + 1 }), {});
console.log(`\n${JSON.stringify(counts)}`);

const out = path.resolve(root, opt('out', 'reports/provider-acceptance'));
mkdirSync(out, { recursive: true });
const file = path.join(out, `${new Date().toISOString().replace(/[:.]/g, '-')}-${opt('provider', 'all')}-${mode}.json`);
writeFileSync(file, JSON.stringify({ mode, ranAt: new Date().toISOString(), results }, null, 2));
console.log(`report: ${path.relative(root, file)}`);
process.exit(results.some((r) => r.status === 'failed') ? 1 : 0);
