#!/usr/bin/env node
// Applies supabase/migrations/*.sql in order and records them in
// supabase_migrations.schema_migrations (the same table the Supabase CLI uses),
// so a database migrated here is recognised by `supabase db push` later.
//
//   node scripts/db/migrate.mjs            apply pending migrations
//   node scripts/db/migrate.mjs --reset    LOCAL ONLY: drop everything first
//
// DATABASE_URL defaults to the local cluster started by scripts/db/local-up.sh.
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const defaultUrl = 'postgres://postgres@127.0.0.1:54329/resuto';

const isLocal = (url) => ['127.0.0.1', 'localhost', '::1'].includes(new URL(url).hostname);

export async function migrate({ url = process.env.DATABASE_URL || defaultUrl, reset = false, log = console.log } = {}) {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    if (reset) {
      if (!isLocal(url)) throw new Error('Refusing --reset on a non-local database.');
      await client.query(`drop schema if exists public cascade; drop schema if exists app cascade;
        drop schema if exists auth cascade; drop schema if exists supabase_migrations cascade;
        create schema public; grant all on schema public to public;`);
    }
    const hasAuth = (await client.query(`select 1 from information_schema.schemata where schema_name='auth'`)).rowCount > 0;
    if (!hasAuth) {
      if (!isLocal(url)) throw new Error('auth schema missing on a non-local database: is this really a Supabase project?');
      log('auth schema missing — applying local Supabase auth shim (development only)');
      await client.query(readFileSync(path.join(root, 'supabase/local/auth-shim.sql'), 'utf8'));
    }
    await client.query(`create schema if not exists supabase_migrations;
      create table if not exists supabase_migrations.schema_migrations (version text primary key, statements text[], name text)`);
    const applied = new Set((await client.query('select version from supabase_migrations.schema_migrations')).rows.map((r) => r.version));
    const dir = path.join(root, 'supabase/migrations');
    const files = readdirSync(dir).filter((f) => /^\d{14}_.+\.sql$/.test(f)).sort();
    let count = 0;
    for (const file of files) {
      const [version, ...rest] = file.replace(/\.sql$/, '').split('_');
      if (applied.has(version)) continue;
      const sql = readFileSync(path.join(dir, file), 'utf8');
      await client.query('begin');
      try {
        await client.query(sql);
        await client.query('insert into supabase_migrations.schema_migrations(version, name, statements) values ($1, $2, $3)', [version, rest.join('_'), [sql]]);
        await client.query('commit');
        log(`applied ${file}`);
        count++;
      } catch (error) {
        await client.query('rollback');
        throw new Error(`${file}: ${error.message}${error.position ? ` (at char ${error.position})` : ''}`);
      }
    }
    log(count ? `${count} migration(s) applied` : 'database is up to date');
  } finally {
    await client.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  migrate({ reset: process.argv.includes('--reset') }).catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
