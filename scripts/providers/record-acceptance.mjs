#!/usr/bin/env node
// Records a provider acceptance report (scripts/providers/acceptance.mjs output) in integration_verifications, so the
// integrations catalog can show "Official provider test verified" / "Live capability verified" per capability
// (INT-15, INT-16). Only results the runner produced are recorded; evidence is already redacted by the runner.
//
//   DATABASE_URL=postgres://… node scripts/providers/record-acceptance.mjs reports/provider-acceptance/<file>.json [--commit <sha>]
//
// Re-recording the same report is a no-op (unique check_id × environment × ran_at).
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import pg from 'pg';

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--'));
const commitArg = args.includes('--commit') ? args[args.indexOf('--commit') + 1] : null;
if (!file || !process.env.DATABASE_URL) {
  console.error('usage: DATABASE_URL=… node scripts/providers/record-acceptance.mjs <report.json> [--commit <sha>]');
  process.exit(2);
}
const report = JSON.parse(readFileSync(file, 'utf8'));
if (!Array.isArray(report.results) || !['official_test', 'live'].includes(report.mode)) throw new Error('not an acceptance report');
let commit = commitArg;
try { commit ??= execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim(); } catch { commit = null; }

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
let recorded = 0;
try {
  for (const r of report.results) {
    const res = await pool.query(
      `insert into integration_verifications(provider, capability, check_id, environment, status, reason, commit_sha, evidence, ran_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9) on conflict (check_id, environment, ran_at) do nothing`,
      [r.provider, r.capability, r.id, r.mode, r.status, r.reason?.slice(0, 500) ?? null, commit, JSON.stringify(r.evidence ?? []), r.startedAt]);
    recorded += res.rowCount ?? 0;
  }
} finally {
  await pool.end();
}
const counts = report.results.reduce((m, r) => ({ ...m, [r.status]: (m[r.status] ?? 0) + 1 }), {});
console.log(`recorded ${recorded} of ${report.results.length} result(s) ${JSON.stringify(counts)} (${report.mode}, commit ${commit ?? 'unknown'})`);
