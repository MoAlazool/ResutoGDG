#!/usr/bin/env node
// Applies supabase/migrations/*.sql in order and records them in
// supabase_migrations.schema_migrations (the same table the Supabase CLI uses),
// so a database migrated here is recognised by `supabase db push` later.
//
//   node scripts/db/migrate.mjs            apply pending migrations
//   node scripts/db/migrate.mjs --reset    LOCAL ONLY: drop everything first
//
// Connection: MIGRATION_DATABASE_URL when set, else DATABASE_URL, else the local cluster started by
// scripts/db/local-up.sh. Migrations always run as the schema owner: once the API runs as the restricted runtime role
// (resuto_api, audit PS-16; docs/STAGING_DEPLOYMENT.md), DATABASE_URL is that role and MIGRATION_DATABASE_URL keeps the
// owner connection. With a single owner DATABASE_URL (today's default) nothing changes.
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { isDisposableDatabase } from './ensure-db.mjs';
import { pgClientConfig } from './pg-tls.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const defaultUrl = 'postgres://postgres@127.0.0.1:54329/resuto';

const isLocal = (url) => ['127.0.0.1', 'localhost', '::1'].includes(new URL(url).hostname);

export const migrationUrl = (env = process.env) => env.MIGRATION_DATABASE_URL || env.DATABASE_URL || defaultUrl;

// Roles are cluster-wide, so two databases migrated at once on one server (parallel test files, CI) can both pass a
// migration's `if not exists (select from pg_roles …)` check and race on `create role`. The loser fails with a
// duplicate in pg_authid (or "role already exists"); by then the role exists, so the step is retried (a few times, as
// another role in the same block may still be in flight).
export const isRoleCreationRace = (error) =>
  (error?.code === '23505' && /pg_authid_rolname_index/.test(error?.message ?? '')) || (error?.code === '42710' && /role .* already exists/.test(error?.message ?? ''));

async function retryRoleRace(step, attempts = 3) {
  for (let i = 1; ; i++) {
    try {
      return await step();
    } catch (error) {
      if (i >= attempts || !isRoleCreationRace(error)) throw error;
    }
  }
}

export async function migrate({ url = migrationUrl(), reset = false, log = console.log } = {}) {
  const client = new pg.Client(pgClientConfig(url));
  await client.connect();
  try {
    if (reset) {
      // A CI service container is not on localhost but is disposable; it opts in with RESUTO_DISPOSABLE_DB=1.
      if (!isDisposableDatabase(url)) throw new Error('Refusing --reset on a non-local database (set RESUTO_DISPOSABLE_DB=1 only for a throwaway CI database).');
      await client.query(`drop schema if exists public cascade; drop schema if exists app cascade;
        drop schema if exists auth cascade; drop schema if exists supabase_migrations cascade;
        create schema public; grant all on schema public to public;`);
    }
    const hasAuth = (await client.query(`select 1 from information_schema.schemata where schema_name='auth'`)).rowCount > 0;
    if (!hasAuth) {
      // Docker Compose / CI databases are not on localhost but are still disposable;
      // they opt in explicitly. Never set this for a Supabase project.
      if (!isLocal(url) && process.env.RESUTO_ALLOW_AUTH_SHIM !== '1') {
        throw new Error('auth schema missing on a non-local database: is this really a Supabase project?');
      }
      log('auth schema missing — applying local Supabase auth shim (development only)');
      const shim = readFileSync(path.join(root, 'supabase/local/auth-shim.sql'), 'utf8');
      await retryRoleRace(async () => {
        await client.query('begin');
        try { await client.query(shim); await client.query('commit'); } catch (error) { await client.query('rollback'); throw error; }
      });
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
      try {
        await retryRoleRace(async () => {
          await client.query('begin');
          try {
            await client.query(sql);
            await client.query('insert into supabase_migrations.schema_migrations(version, name, statements) values ($1, $2, $3)', [version, rest.join('_'), [sql]]);
            await client.query('commit');
          } catch (error) {
            await client.query('rollback');
            throw error;
          }
        });
        log(`applied ${file}`);
        count++;
      } catch (error) {
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
