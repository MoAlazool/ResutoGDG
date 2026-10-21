import { randomBytes } from 'node:crypto';
import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

/**
 * The whole API suite with the API connected as the restricted runtime role (audit PS-16):
 *
 *   TEST_DATABASE_URL=postgres://postgres@127.0.0.1:54329/resuto_x npx vitest run -c vitest.restricted.config.ts
 *
 * TEST_DATABASE_URL is the owner connection: migrations and test fixtures (test/helpers.ts sql()) use it. The API under
 * test connects as `resuto_api` (NOLOGIN in migrations; test/global-setup.restricted.ts gives it a per-run random
 * password on this disposable database's cluster), which is NOINHERIT and NOBYPASSRLS: every request must go through
 * DbService's member, tenant or platform role, so anything that silently relied on the owner fails here.
 */
const owner = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@127.0.0.1:54329/resuto_test';
process.env.RESTRICTED_DB_PASSWORD ??= randomBytes(18).toString('base64url');
const runtime = new URL(owner);
runtime.username = 'resuto_api';
runtime.password = process.env.RESTRICTED_DB_PASSWORD;

export default defineConfig({
  plugins: [swc.vite({ module: { type: 'es6' } })],
  test: {
    globals: true,
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    globalSetup: ['test/global-setup.restricted.ts'],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
    env: {
      NODE_ENV: 'test',
      DATABASE_URL: runtime.toString(),
      TEST_FIXTURE_DATABASE_URL: owner,
      RESTRICTED_DB: '1',
      SUPABASE_JWT_SECRET: 'test-jwt-secret-that-is-at-least-32-characters-long',
      AUTH_DEV_MODE: 'true',
      API_ORIGIN: 'http://api.test',
      APP_ORIGIN: 'http://app.test',
      STORAGE_LOCAL_DIR: '../../.local/test-storage',
      PAYMENT_MODE: 'sandbox',
    },
  },
});
