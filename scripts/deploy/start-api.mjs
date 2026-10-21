#!/usr/bin/env node
// Container entrypoint for hosted API services (Render staging):
//   1. applies pending migrations from supabase/migrations (scripts/db/migrate.mjs),
//   2. starts the API (dist/main.js) and forwards stop signals to it,
//   3. with DEMO_SEED_ON_BOOT=1, runs scripts/demo/load-demo-data.mjs once the API is healthy
//      (the loader refuses production; a completed tenant is refreshed relative to the boot time, see
//      scripts/demo/README.md). A staging database is shared, so DEMO_TARGET=staging runs it with --demo-tenant-only:
//      only the demo tenant is created or updated, nothing is ever deleted.
// Run from the image's /app directory.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from '../db/migrate.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const port = process.env.PORT ?? '4000';

await migrate({ log: (m) => console.log(`[migrate] ${m}`) });

const api = spawn(process.execPath, ['dist/main.js'], { cwd: root, stdio: 'inherit', env: process.env });
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => api.kill(sig));
api.on('exit', (code, signal) => process.exit(code ?? (signal ? 0 : 1)));

if (process.env.DEMO_SEED_ON_BOOT === '1') {
  const healthy = async () => {
    for (let i = 0; i < 120; i++) {
      try { if ((await fetch(`http://127.0.0.1:${port}/v1/health`)).ok) return true; } catch { /* starting */ }
      await new Promise((r) => setTimeout(r, 1000));
    }
    return false;
  };
  if (await healthy()) {
    const args = ['scripts/demo/load-demo-data.mjs', ...(process.env.DEMO_TARGET === 'staging' ? ['--demo-tenant-only'] : [])];
    const loader = spawn(process.execPath, args, {
      cwd: root, stdio: 'inherit', env: { ...process.env, API_URL: `http://127.0.0.1:${port}` },
    });
    loader.on('exit', (code) => console.log(`[demo] loader finished with code ${code}${code === 3 ? ' (another loader run holds the lease; this boot skipped it)' : ''}`));
  } else {
    console.error('[demo] API did not become healthy; demo data not loaded');
  }
}
