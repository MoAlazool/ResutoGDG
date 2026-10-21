#!/usr/bin/env node
// Legacy (ResutoGDG 1.x) → Resuto 2.0 data migration. Read-only toward legacy:
// it reads an exported state JSON document and never connects to Firestore or
// the legacy SQLite file directly. See docs/architecture/MIGRATION_PLAN.md.
//
//   node tools/legacy-migration/migrate.mjs --input <state.json> [options]
//   node tools/legacy-migration/migrate.mjs --rollback <orgId> [--force]
//
// Options:
//   --restaurant-id <id>   legacy tenant id (Firestore restaurants/{id}); used in deterministic ids
//   --slug <slug>          2.0 web address (default: from the document or the restaurant name)
//   --plan <planId>        subscription plan (default: document plan or "free")
//   --status <s>           trialing | active (default: trialing for paid plans)
//   --owner-email <email>  existing account to make the owner
//   --media-dir <dir>      exported legacy media store (files named by media key, e.g. data/media of a SQLite install)
//   --assets-dir <dir>     the legacy public/ folder (assets/… photos, incl. the Smash & Co storefront photos)
//   --storage-dir <dir>    local tenant storage to copy photos into (the API's STORAGE_LOCAL_DIR); without it photos
//                          are uploaded to Supabase Storage when SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are set
//   --no-storefront-photos do not carry the legacy storefront photos over to burger-branch items
//   --dry-run              run everything inside a transaction, report, then roll back
//   --report <file>        also write the JSON report to a file
//   --confirm-remote       allow a non-local DATABASE_URL
//
// Every legacy photo must be copied and every venue QR token mapped, or the reconciliation fails (CR-13).
// Exit codes: 0 ok · 1 reconciliation mismatch (nothing committed) · 2 usage · 3 error
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { buildPlan } from './lib/transform.mjs';
import { loadPlan, rollbackTenant } from './lib/load.mjs';

export { buildPlan } from './lib/transform.mjs';
export { loadPlan, reconcile, rollbackTenant } from './lib/load.mjs';

const isLocal = (url) => ['127.0.0.1', 'localhost', '::1'].includes(new URL(url).hostname);

/** Library entry point used by scripts/db/seed.mjs and the tests. */
export async function migrateLegacy({ url, document, options = {}, dryRun = false, log = () => {}, media = {} }) {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    let ownerUserId = options.ownerUserId ?? null;
    if (!ownerUserId && options.ownerEmail) {
      const { rows: [u] } = await client.query('select id from auth.users where lower(email) = lower($1)', [options.ownerEmail]);
      if (!u) throw new Error(`no account with email ${options.ownerEmail}`);
      ownerUserId = u.id;
    }
    const plan = buildPlan(document, { ...options, ownerUserId });
    return await loadPlan(client, plan, { dryRun, ownerUserId, ownerEmail: options.ownerEmail ?? null, log, media });
  } finally {
    await client.end();
  }
}

export async function rollbackLegacy({ url, orgId, force = false }) {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return await rollbackTenant(client, orgId, { force });
  } finally {
    await client.end();
  }
}

function parseArgs(argv) {
  const out = { flags: new Set() };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (['--dry-run', '--force', '--confirm-remote', '--help', '--no-storefront-photos'].includes(a)) out.flags.add(a);
    else if (a.startsWith('--')) { out[a.slice(2)] = argv[++i]; if (out[a.slice(2)] === undefined) throw new Error(`${a} needs a value`); }
    else throw new Error(`unexpected argument ${a}`);
  }
  return out;
}

export function formatReport(report) {
  const lines = [];
  lines.push(`${report.dryRun ? 'DRY RUN — ' : ''}${report.restaurantId} → organization ${report.orgId} (${report.slug})${report.rerun ? ' [re-run]' : ''}`);
  lines.push('');
  lines.push('entity                        legacy     migrated   ok');
  for (const m of report.reconciliation.metrics) {
    lines.push(`${m.name.padEnd(28)}  ${String(m.legacy).padStart(9)}  ${String(m.migrated).padStart(9)}   ${m.match ? '✓' : '✗ MISMATCH'}`);
  }
  lines.push('');
  if (report.warnings.length) {
    lines.push(`warnings (${report.warnings.length}):`);
    for (const w of report.warnings) lines.push(`  - ${w}`);
    lines.push('');
  }
  lines.push(report.committed ? 'committed.' : report.dryRun ? 'rolled back (dry run).' : `NOT committed: ${report.reconciliation.mismatches} reconciliation mismatch(es).`);
  return lines.join('\n');
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(e.message);
    process.exit(2);
  }
  if (args.flags.has('--help') || (!args.input && !args.rollback)) {
    console.error(readFileSync(new URL(import.meta.url)).toString().split('\n').filter((l) => l.startsWith('//')).map((l) => l.slice(3)).join('\n'));
    process.exit(args.flags.has('--help') ? 0 : 2);
  }
  const url = process.env.DATABASE_URL || 'postgres://postgres@127.0.0.1:54329/resuto';
  if (!isLocal(url) && !args.flags.has('--confirm-remote')) {
    console.error(`Refusing to write to non-local database host "${new URL(url).hostname}" without --confirm-remote.`);
    process.exit(2);
  }
  try {
    if (args.rollback) {
      const r = await rollbackLegacy({ url, orgId: args.rollback, force: args.flags.has('--force') });
      console.log(JSON.stringify(r, null, 2));
      return;
    }
    const document = JSON.parse(readFileSync(args.input, 'utf8'));
    const report = await migrateLegacy({
      url, document, dryRun: args.flags.has('--dry-run'), log: (m) => console.error(m),
      options: { restaurantId: args['restaurant-id'], slug: args.slug, planId: args.plan, subscriptionStatus: args.status, ownerEmail: args['owner-email'],
        storefrontPhotos: !args.flags.has('--no-storefront-photos') },
      media: {
        mediaDir: args['media-dir'] ?? null, assetsDir: args['assets-dir'] ?? null, storageDir: args['storage-dir'] ?? null,
        supabase: !args['storage-dir'] && process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY
          ? { url: process.env.SUPABASE_URL, key: process.env.SUPABASE_SERVICE_ROLE_KEY } : null,
      },
    });
    if (args.report) writeFileSync(args.report, `${JSON.stringify(report, null, 2)}\n`);
    console.log(formatReport(report));
    process.exitCode = report.reconciliation.ok ? 0 : 1;
  } catch (e) {
    console.error(`migration failed: ${e.message}`);
    process.exitCode = 3;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) await main();
