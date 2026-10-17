// Migrates a clean test database once per run. Requires the local Postgres
// cluster (pnpm db:up) or TEST_DATABASE_URL pointing at a disposable database.
// Parallel workers/agents must each use their own TEST_DATABASE_URL.
export default async function setup() {
  const url = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@127.0.0.1:54329/resuto_test';
  // @ts-expect-error -- plain ESM scripts without types
  const { ensureDatabase } = await import('../../../scripts/db/ensure-db.mjs');
  // @ts-expect-error -- plain ESM scripts without types
  const { migrate } = await import('../../../scripts/db/migrate.mjs');
  await ensureDatabase(url);
  await migrate({ url, reset: true, log: () => {} });
}
