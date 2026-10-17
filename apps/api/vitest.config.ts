import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [swc.vite({ module: { type: 'es6' } })],
  test: {
    globals: true,
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    globalSetup: ['test/global-setup.ts'],
    // Integration tests share one migrated database; files run sequentially.
    fileParallelism: false,
    testTimeout: 30_000,
    env: {
      NODE_ENV: 'test',
      DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://postgres@127.0.0.1:54329/resuto_test',
      SUPABASE_JWT_SECRET: 'test-jwt-secret-that-is-at-least-32-characters-long',
      AUTH_DEV_MODE: 'true',
      API_ORIGIN: 'http://api.test',
      APP_ORIGIN: 'http://app.test',
      STORAGE_LOCAL_DIR: '../../.local/test-storage',
      PAYMENT_MODE: 'sandbox',
    },
    hookTimeout: 60_000,
  },
});
