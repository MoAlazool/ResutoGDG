// Creates the database named in a connection URL if it does not exist (local only).
import pg from 'pg';

export async function ensureDatabase(url) {
  const target = new URL(url);
  if (!['127.0.0.1', 'localhost', '::1'].includes(target.hostname)) return;
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
