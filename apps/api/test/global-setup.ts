// Migrates a clean test database once per run. Requires the local Postgres
// cluster (pnpm db:up) or TEST_DATABASE_URL pointing at a disposable database.
export default async function setup() {
  // @ts-expect-error -- plain ESM script without types
  const { migrate } = await import('../../../scripts/db/migrate.mjs');
  await migrate({ url: process.env.TEST_DATABASE_URL ?? 'postgres://postgres@127.0.0.1:54329/resuto_test', reset: true, log: () => {} });
}
