// Client-role lockdown on a database shaped like a Supabase project (audit PS-01, PCL-02, PS-02).
// Supabase grants ALL on every new public table to anon and authenticated through default privileges and ships a
// storage schema; plain local Postgres has neither. This test builds a throwaway database with both, applies every
// migration and checks that client roles end with nothing: no table privilege (old or new tables), no storage read
// policy on tenant media. Uses its own database (<TEST_DATABASE_URL name>_supabase_sim) so it can run next to
// rls.test.mjs.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { migrate } from '../../scripts/db/migrate.mjs';

const base = new URL(process.env.TEST_DATABASE_URL || 'postgres://postgres@127.0.0.1:54329/resuto_test');
const name = `${base.pathname.slice(1)}_supabase_sim`;
const url = new URL(base); url.pathname = `/${name}`;
const admin = new URL(base); admin.pathname = '/postgres';
let pool;

before(async () => {
  if (!['127.0.0.1', 'localhost', '::1'].includes(base.hostname)) throw new Error('local databases only');
  if (!/^[a-z0-9_]+$/.test(name)) throw new Error(`unsupported database name ${name}`);
  const c = new pg.Client({ connectionString: admin.toString() });
  await c.connect();
  try {
    await c.query(`drop database if exists ${name} with (force)`);
    await c.query(`create database ${name}`);
  } finally { await c.end(); }
  pool = new pg.Pool({ connectionString: url.toString(), max: 2 });
  // Supabase-like platform objects that exist before any project migration runs.
  await pool.query(`
    do $$ begin
      if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin noinherit; end if;
      if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin noinherit; end if;
      if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin noinherit bypassrls; end if;
    end $$;
    alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
    alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
    alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
    create schema storage;
    create table storage.buckets (id text primary key, name text not null, public boolean not null default false);
    create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text references storage.buckets(id), name text not null);
    alter table storage.objects enable row level security;
    create function storage.foldername(name text) returns text[] language sql immutable as $f$ select (string_to_array(name, '/'))[1:array_length(string_to_array(name, '/'), 1) - 1] $f$;
    grant usage on schema storage to anon, authenticated;
    grant select on storage.objects to authenticated;
  `);
  await migrate({ url: url.toString(), log: () => {} });
});

after(async () => {
  await pool?.end();
  const c = new pg.Client({ connectionString: admin.toString() });
  await c.connect();
  try { await c.query(`drop database if exists ${name} with (force)`); } finally { await c.end(); }
});

test('client roles keep no privilege on any public table despite Supabase default privileges', async () => {
  const { rows } = await pool.query(`select c.relname, r.rolname from pg_class c join pg_namespace n on n.oid = c.relnamespace
      cross join (values ('anon'), ('authenticated')) as r(rolname)
     where n.nspname = 'public' and c.relkind in ('r', 'v', 'm', 'p')
       and (has_table_privilege(r.rolname, c.oid, 'select') or has_table_privilege(r.rolname, c.oid, 'insert')
         or has_table_privilege(r.rolname, c.oid, 'update') or has_table_privilege(r.rolname, c.oid, 'delete'))
     order by 1, 2`);
  assert.deepEqual(rows, []);
});

test('tables created after the lockdown get no client privileges by default', async () => {
  const c = await pool.connect();
  try {
    await c.query('begin');
    await c.query('create table public.created_later (id serial primary key, v text)');
    const { rows } = await c.query(`select has_table_privilege('authenticated', 'public.created_later', 'select') as auth_select,
        has_table_privilege('anon', 'public.created_later', 'select') as anon_select,
        has_sequence_privilege('authenticated', 'public.created_later_id_seq', 'usage') as auth_seq`);
    assert.deepEqual(rows[0], { auth_select: false, anon_select: false, auth_seq: false });
  } finally {
    await c.query('rollback');
    c.release();
  }
});

test('tenant media has a private bucket and no direct member read policy', async () => {
  const bucket = (await pool.query(`select public from storage.buckets where id = 'tenant-media'`)).rows;
  assert.deepEqual(bucket, [{ public: false }]);
  const policies = (await pool.query(`select policyname from pg_policies where schemaname = 'storage' and tablename = 'objects'`)).rows;
  assert.deepEqual(policies, []);
  // With RLS on and no policy, a signed-in member's JWT lists nothing even with table SELECT.
  const c = await pool.connect();
  try {
    await c.query('begin');
    await c.query(`insert into storage.objects(bucket_id, name) values ('tenant-media', $1)`, [`${'6f1c2a40-0000-4000-8000-000000000001'}/compliance-documents/licence.pdf`]);
    await c.query(`select set_config('request.jwt.claims', '{"sub":"6f1c2a40-0000-4000-8000-0000000000aa","role":"authenticated"}', true)`);
    await c.query('set local role authenticated');
    const { rows } = await c.query('select name from storage.objects');
    assert.equal(rows.length, 0);
  } finally {
    await c.query('rollback');
    c.release();
  }
});
