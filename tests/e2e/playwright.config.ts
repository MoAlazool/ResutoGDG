import { defineConfig, devices } from '@playwright/test';

// Run with: PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers pnpm e2e
// The API (port 4109, database resuto_e2e_f, AUTH_DEV_MODE) and the built web app
// (port 3109) are started by the webServer entries below.
const API_PORT = process.env.E2E_API_PORT ?? '4109';
const WEB_PORT = process.env.E2E_WEB_PORT ?? '3109';
export const API_URL = `http://localhost:${API_PORT}`;
export const WEB_URL = `http://localhost:${WEB_PORT}`;
process.env.PLAYWRIGHT_BROWSERS_PATH ??= '/opt/pw-browsers';

export default defineConfig({
  testDir: '.',
  testMatch: /.*\.spec\.ts$/,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 10_000, toHaveScreenshot: { maxDiffPixelRatio: 0.02, animations: 'disabled', caret: 'hide' } },
  reporter: [['list']],
  snapshotPathTemplate: '{testDir}/__screenshots__/{testFilePath}/{arg}{ext}',
  use: {
    baseURL: WEB_URL,
    trace: 'retain-on-failure',
    // Visual snapshots and assertions run with motion reduced (the demos then show their still state).
    contextOptions: { reducedMotion: 'reduce' },
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } },
  ],
  webServer: [
    {
      command: 'node tests/e2e/start-api.mjs',
      cwd: '../..',
      url: `${API_URL}/v1/health`,
      timeout: 180_000,
      reuseExistingServer: !!process.env.E2E_REUSE_SERVERS,
      env: { E2E_API_PORT: API_PORT, E2E_WEB_ORIGIN: WEB_URL },
    },
    {
      command: `pnpm --filter @resuto/web exec next build && pnpm --filter @resuto/web exec next start -p ${WEB_PORT}`,
      cwd: '../..',
      url: WEB_URL,
      timeout: 420_000,
      reuseExistingServer: !!process.env.E2E_REUSE_SERVERS,
      env: { NEXT_PUBLIC_API_URL: API_URL, NEXT_PUBLIC_APP_ORIGIN: WEB_URL, NEXT_TELEMETRY_DISABLED: '1', APP_HOSTS: 'localhost,127.0.0.1' },
    },
  ],
});
