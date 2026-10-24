// Creates the database named in a connection URL if it does not exist: on a local server, or on a disposable server
// that opts in with RESUTO_DISPOSABLE_DB=1 (a CI job's service container reached by its service name). Never set that
// for a Supabase project or any shared database.
import pg from 'pg';

const isLocalHost = (host) => ['127.0.0.1', 'localhost', '::1'].includes(host);
export const isDisposableDatabase = (url, env = process.env) => isLocalHost(new URL(url).hostname) || env.RESUTO_DISPOSABLE_DB === '1';

export async function ensureDatabase(url) {
  const target = new URL(url);
  if (!isDisposableDatabase(url)) return;
  const name = target.pathname.slice(1);
  if (!/^[a-z0-9_]+$/.test(name)) throw new Error(`Unsupported database name: ${name}`);
  const admin = new URL(url);
  admin.pathname = '/postgres';
  const client = new pg.Client({ connectionString: admin.toString() });
  await client.connect();
  try {
    const exists = await client.query('select 1 from pg_database where datname = $1', [name]);
    if (!exists.rowCount) await client.query(`create database ${name}`);
  } finally {
    await client.end();
  }
}
