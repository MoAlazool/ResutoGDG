-- Direct Supabase clients (roles anon and authenticated: the Data API / PostgREST, Realtime and Storage with a user's
-- JWT) get no access to tenant data (audit PS-01, PCL-02, PS-02).
--
-- Before: app.enable_realtime_read() granted table-wide SELECT to authenticated with a policy of "member of the org",
-- so any staff JWT (a branch-scoped driver or kitchen account) read every branch's orders, order lines, messages,
-- reservations (guest phone/email), dining table QR tokens and delivery jobs straight from PostgREST, bypassing the
-- API's role permissions, branch scope and PII rules. The storage policy let any member read compliance documents,
-- expense receipts and delivery proofs. Nothing uses these paths: the web app uses supabase-js for Auth only, no client
-- subscribes to Realtime, and the API serves files through short-lived signed URLs with the service role.
--
-- Live updates, if needed later, must be published by the API (e.g. Realtime Broadcast on per-branch channels or an
-- SSE stream) carrying change ticks (ids/cursors), never row data.
--
-- Reversible: re-create the dropped policies and grants from 20261017000100 (enable_realtime_read) and 20261017000700.

-- 1. Policies that admitted authenticated.
do $$
declare r record;
begin
  for r in select schemaname, tablename, policyname from pg_policies
            where schemaname = 'public' and policyname in ('realtime_member_read', 'org_realtime_read', 'membership_self_read') loop
    execute format('drop policy %I on %I.%I', r.policyname, r.schemaname, r.tablename);
  end loop;
end $$;
-- Shared policies keep their API roles and drop authenticated.
alter policy profile_self on public.profiles to resuto_member;
alter policy plans_read on public.plans to resuto_member, resuto_tenant;
alter policy plan_modules_read on public.plan_modules to resuto_member, resuto_tenant;
alter policy plan_prices_read on public.plan_prices to resuto_member, resuto_tenant;
alter policy module_prices_read on public.module_prices to resuto_member, resuto_tenant;

-- 2. Grants: nothing in public for client roles, now and for objects created later by this role.
revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
alter default privileges in schema public revoke all on tables from anon, authenticated;
alter default privileges in schema public revoke all on sequences from anon, authenticated;
alter default privileges in schema public revoke all on functions from anon, authenticated;
-- The app schema holds RLS helpers and DDL helpers; client roles have no business there.
revoke usage on schema app from anon, authenticated;

-- 3. Later migrations call lockdown_public_grants() at the end: it now strips every client privilege, not only writes.
create or replace function app.lockdown_public_grants() returns void
language plpgsql set search_path = public, pg_temp as $$
declare r record;
begin
  for r in select c.oid::regclass as t from pg_class c join pg_namespace n on n.oid = c.relnamespace
            where n.nspname = 'public' and c.relkind in ('r', 'v', 'm', 'p', 'f') loop
    execute format('revoke all on %s from anon, authenticated', r.t);
  end loop;
end $$;

-- enable_realtime_read() must never re-open a table to client roles; fail loudly if a migration still calls it.
create or replace function app.enable_realtime_read(p_table regclass) returns void
language plpgsql set search_path = public, pg_temp as $$
begin
  raise exception 'direct client reads are disabled (audit PS-01): % stays API-only; publish change ticks from the API instead', p_table;
end $$;

-- 4. Storage: objects are read through API-issued signed URLs only (service role); members get no direct read.
do $$
begin
  if exists (select 1 from information_schema.tables where table_schema = 'storage' and table_name = 'objects') then
    execute 'drop policy if exists tenant_media_member_read on storage.objects';
  end if;
end $$;
