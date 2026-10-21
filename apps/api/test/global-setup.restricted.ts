// Global setup for vitest.restricted.config.ts (PS-16): migrate the disposable test database as the owner, then let
// the restricted runtime role log in for this run only. The password is random per run (never stored) and the role
// stays NOINHERIT/NOBYPASSRLS as the migration created it; production does the same step by hand
// (docs/STAGING_DEPLOYMENT.md).
import pg from 'pg';
import setup from './global-setup';

export default async function restrictedSetup() {
  const url = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@127.0.0.1:54329/resuto_test';
  const host = new URL(url).hostname;
  if (!['127.0.0.1', 'localhost', '::1', 'postgres'].includes(host) && process.env.RESUTO_ALLOW_AUTH_SHIM !== '1' && !process.env.CI) {
    throw new Error('The restricted-role suite changes a cluster role; run it only against a local or CI database.');
  }
  await setup();
  const password = process.env.RESTRICTED_DB_PASSWORD;
  if (!password || !/^[A-Za-z0-9_-]{16,}$/.test(password)) throw new Error('RESTRICTED_DB_PASSWORD missing (set by vitest.restricted.config.ts)');
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query(`alter role resuto_api with login password '${password}'`);
    const { rows } = await client.query(`select rolsuper, rolbypassrls, rolinherit from pg_roles where rolname = 'resuto_api'`);
    if (rows[0]?.rolsuper || rows[0]?.rolbypassrls || rows[0]?.rolinherit) throw new Error('resuto_api must be NOSUPERUSER, NOBYPASSRLS and NOINHERIT');
  } finally {
    await client.end();
  }
}
