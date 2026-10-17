// Starts the API for end-to-end tests: (re)creates and migrates the e2e database,
// builds the API and serves it on E2E_API_PORT with the local dev auth issuer.
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const url = process.env.E2E_DATABASE_URL ?? 'postgres://postgres@127.0.0.1:54329/resuto_e2e_f';
const port = process.env.E2E_API_PORT ?? '4109';
const web = process.env.E2E_WEB_ORIGIN ?? 'http://localhost:3109';

const { ensureDatabase } = await import(path.join(root, 'scripts/db/ensure-db.mjs'));
const { migrate } = await import(path.join(root, 'scripts/db/migrate.mjs'));
await ensureDatabase(url);
await migrate({ url, reset: true, log: () => {} });

const build = spawnSync('npx', ['tsc', '-p', 'tsconfig.build.json'], { cwd: path.join(root, 'apps/api'), stdio: 'inherit' });
if (build.status !== 0) process.exit(build.status ?? 1);

const child = spawn(process.execPath, ['dist/main.js'], {
  cwd: path.join(root, 'apps/api'),
  stdio: 'inherit',
  env: {
    ...process.env,
    NODE_ENV: 'development',
    PORT: port,
    DATABASE_URL: url,
    AUTH_DEV_MODE: 'true',
    SUPABASE_JWT_SECRET: 'e2e-jwt-secret-that-is-at-least-32-characters-long',
    API_ORIGIN: `http://localhost:${port}`,
    APP_ORIGIN: web,
    CORS_ORIGINS: `${web},http://127.0.0.1:3109`,
    STORAGE_LOCAL_DIR: path.join(root, '.local/e2e-storage'),
    PAYMENT_MODE: 'sandbox',
  },
});
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { child.kill(sig); process.exit(0); });
child.on('exit', (code) => process.exit(code ?? 0));
