-- Resuto 2.0 — foundation: extensions, execution roles, tenancy helpers,
-- organizations, branches, users, memberships, audit log, outbox, idempotency.
--
-- Execution model (see docs/architecture/SECURITY_MODEL.md):
--   * resuto_member  — API acting for a signed-in staff user. RLS requires the
--                      tenant in app.org_id AND an active membership of auth.uid().
--   * resuto_tenant  — API acting for a guest/webhook/worker inside ONE tenant.
--                      RLS restricts every row to app.org_id.
--   * authenticated  — direct Supabase client (Realtime). SELECT-only on a
--                      curated set of tables; never writes.
--   * anon           — nothing.
--   * connection owner (postgres) — platform operations only (tenant lookup by
--                      QR/slug/domain, platform admin), wrapped in audited code.

create extension if not exists pgcrypto;
create extension if not exists btree_gist;
create extension if not exists citext;
create extension if not exists pg_trgm;

create schema if not exists app;

do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'resuto_member') then create role resuto_member nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'resuto_tenant') then create role resuto_tenant nologin; end if;
end $$;
grant resuto_member, resuto_tenant to current_user;
grant usage on schema app, public to resuto_member, resuto_tenant, authenticated;
grant usage on schema auth to resuto_member, resuto_tenant;

-- ---------------------------------------------------------------------------
-- Enumerations shared across modules
-- ---------------------------------------------------------------------------
create type public.country_code as enum ('EG', 'SA');
create type public.currency_code as enum ('EGP', 'SAR', 'USD');
create type public.member_role as enum (
  'owner', 'admin', 'manager', 'cashier', 'waiter', 'kitchen', 'host', 'marketing', 'accountant', 'driver'
);
create type public.member_status as enum ('invited', 'active', 'suspended', 'removed');
create type public.module_key as enum (
  'core', 'connect', 'pay', 'marketing', 'driver', 'studio', 'finance', 'compliance', 'intelligence', 'mcp'
);

-- ---------------------------------------------------------------------------
-- Generic helpers
-- ---------------------------------------------------------------------------
create or replace function app.set_updated_at() returns trigger language plpgsql as $$
begin new.updated_at := now(); return new; end $$;

create or replace function app.current_org_id() returns uuid language sql stable as $$
  select nullif(current_setting('app.org_id', true), '')::uuid
$$;

create or replace function app.current_actor() returns text language sql stable as $$
  select coalesce(nullif(current_setting('app.actor', true), ''), 'system')
$$;

-- ---------------------------------------------------------------------------
-- Tenancy
-- ---------------------------------------------------------------------------
create table public.organizations (
  id uuid primary key default gen_random_uuid(),
  slug citext not null unique check (slug ~ '^[a-z0-9](?:[a-z0-9-]{1,46}[a-z0-9])$'),
  name text not null check (length(trim(name)) between 1 and 120),
  name_ar text check (name_ar is null or length(name_ar) <= 120),
  country public.country_code not null default 'EG',
  currency public.currency_code not null default 'EGP',
  timezone text not null default 'Africa/Cairo',
  default_locale text not null default 'en' check (default_locale in ('en', 'ar')),
  legal_name text,
  tax_registration_number text,
  commercial_registration text,
  status text not null default 'active' check (status in ('onboarding', 'active', 'suspended', 'closed')),
  onboarding jsonb not null default '{}'::jsonb,
  legacy_id text unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- country/currency pairing is enforced: EG→EGP, SA→SAR (USD reserved for platform billing)
  constraint org_currency_matches_country check ((country = 'EG' and currency = 'EGP') or (country = 'SA' and currency = 'SAR'))
);
create trigger organizations_updated before update on public.organizations for each row execute function app.set_updated_at();

create table public.branches (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  code text not null check (code ~ '^[a-z0-9-]{1,40}$'),
  name text not null check (length(trim(name)) between 1 and 120),
  name_ar text,
  address text,
  city text,
  phone text,
  latitude numeric(9, 6) check (latitude between -90 and 90),
  longitude numeric(9, 6) check (longitude between -180 and 180),
  timezone text,
  is_active boolean not null default true,
  accepts_dine_in boolean not null default true,
  accepts_pickup boolean not null default true,
  accepts_delivery boolean not null default false,
  accepts_reservations boolean not null default true,
  delivery_fee_minor bigint not null default 0 check (delivery_fee_minor >= 0),
  delivery_radius_m integer check (delivery_radius_m is null or delivery_radius_m > 0),
  min_order_minor bigint not null default 0 check (min_order_minor >= 0),
  reservation_duration_min integer not null default 90 check (reservation_duration_min between 15 and 600),
  reservation_buffer_min integer not null default 15 check (reservation_buffer_min between 0 and 240),
  reservation_deposit_minor bigint not null default 0 check (reservation_deposit_minor >= 0),
  opening_hours jsonb not null default '[]'::jsonb,
  legacy_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, code),
  unique (org_id, id)
);
create index branches_org_idx on public.branches(org_id);
create trigger branches_updated before update on public.branches for each row execute function app.set_updated_at();

-- Application profile for every Supabase Auth user.
create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text,
  email citext,              -- copy of auth.users.email (auth schema is not readable by app roles)
  phone text,
  locale text not null default 'en' check (locale in ('en', 'ar')),
  avatar_url text,
  last_org_id uuid references public.organizations(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger profiles_updated before update on public.profiles for each row execute function app.set_updated_at();

create table public.memberships (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role public.member_role not null,
  -- NULL = every branch of the organization; otherwise the explicit allow-list.
  branch_ids uuid[],
  status public.member_status not null default 'active',
  invited_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, user_id),
  constraint owner_all_branches check (role <> 'owner' or branch_ids is null)
);
create index memberships_user_idx on public.memberships(user_id) where status = 'active';
create trigger memberships_updated before update on public.memberships for each row execute function app.set_updated_at();

create table public.invitations (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  email citext,
  phone text,
  role public.member_role not null,
  branch_ids uuid[],
  token_hash text not null unique,
  status text not null default 'pending' check (status in ('pending', 'accepted', 'revoked', 'expired')),
  expires_at timestamptz not null,
  invited_by uuid references auth.users(id),
  accepted_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  check (email is not null or phone is not null)
);
create index invitations_org_idx on public.invitations(org_id, status);

-- Platform staff are NOT restaurant members; they never get tenant RLS access
-- through memberships and act only through audited platform endpoints.
create table public.platform_admins (
  user_id uuid primary key references auth.users(id) on delete cascade,
  role text not null default 'support' check (role in ('superadmin', 'support', 'finance')),
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Membership helpers (security definer: they read memberships without
-- triggering memberships' own RLS, avoiding recursion).
-- ---------------------------------------------------------------------------
create or replace function app.is_member(p_org uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select p_org is not null and exists (
    select 1 from public.memberships m
    where m.org_id = p_org and m.user_id = auth.uid() and m.status = 'active')
$$;

-- NULL means every branch; an array is the allow-list for the current tenant.
create or replace function app.branch_scope() returns uuid[]
language sql stable security definer set search_path = public, pg_temp as $$
  -- Only meaningful together with app.is_member(): a missing membership also
  -- yields NULL here, but is_member() has already rejected that caller.
  select m.branch_ids from public.memberships m
   where m.org_id = app.current_org_id() and m.user_id = auth.uid() and m.status = 'active'
$$;

create or replace function app.member_org_ids() returns setof uuid
language sql stable security definer set search_path = public, pg_temp as $$
  select m.org_id from public.memberships m where m.user_id = auth.uid() and m.status = 'active'
$$;

grant execute on all functions in schema app to resuto_member, resuto_tenant, authenticated;

-- Applies the standard tenant policies to a table with an org_id column.
-- p_branch_column: optional column used for branch-scoped staff access.
create or replace function app.enable_tenant_rls(p_table regclass, p_branch_column text default null)
returns void language plpgsql as $$
declare
  branch_pred text := 'true';
begin
  if p_branch_column is not null then
    branch_pred := format(
      '((select app.branch_scope()) is null or %1$I is null or array[%1$I] <@ (select app.branch_scope()))',
      p_branch_column);
  end if;
  execute format('alter table %s enable row level security', p_table);
  execute format('drop policy if exists tenant_system on %s', p_table);
  execute format('drop policy if exists tenant_member on %s', p_table);
  execute format($p$create policy tenant_system on %s for all to resuto_tenant
    using (org_id = (select app.current_org_id()))
    with check (org_id = (select app.current_org_id()))$p$, p_table);
  execute format($p$create policy tenant_member on %1$s for all to resuto_member
    using (org_id = (select app.current_org_id()) and (select app.is_member(app.current_org_id())) and %2$s)
    with check (org_id = (select app.current_org_id()) and (select app.is_member(app.current_org_id())) and %2$s)$p$,
    p_table, branch_pred);
  execute format('grant select, insert, update, delete on %s to resuto_member, resuto_tenant', p_table);
end $$;

-- Read-only access for Supabase Realtime subscribers (signed-in staff).
create or replace function app.enable_realtime_read(p_table regclass) returns void language plpgsql as $$
begin
  execute format('drop policy if exists realtime_member_read on %s', p_table);
  execute format($p$create policy realtime_member_read on %s for select to authenticated
    using (org_id in (select app.member_org_ids()))$p$, p_table);
  execute format('grant select on %s to authenticated', p_table);
end $$;

-- Supabase grants broad default privileges to anon/authenticated on public.
-- Resuto clients never write through PostgREST, so strip them after each migration.
create or replace function app.lockdown_public_grants() returns void language plpgsql as $$
declare r record;
begin
  for r in select c.oid::regclass as t from pg_class c join pg_namespace n on n.oid = c.relnamespace
            where n.nspname = 'public' and c.relkind in ('r', 'v', 'm', 'p') loop
    execute format('revoke all on %s from anon', r.t);
    execute format('revoke insert, update, delete, truncate, references, trigger on %s from authenticated', r.t);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Cross-cutting infrastructure
-- ---------------------------------------------------------------------------
create table public.audit_logs (
  id bigint generated always as identity primary key,
  org_id uuid references public.organizations(id) on delete cascade,
  branch_id uuid,
  actor_type text not null check (actor_type in ('user', 'guest', 'system', 'platform_admin', 'mcp_client', 'integration', 'driver')),
  actor_id text,
  action text not null,
  entity_type text,
  entity_id text,
  source text not null default 'api' check (source in ('api', 'web', 'mcp', 'ai', 'worker', 'webhook', 'migration')),
  metadata jsonb not null default '{}'::jsonb,
  ip inet,
  created_at timestamptz not null default now()
);
create index audit_logs_org_time_idx on public.audit_logs(org_id, created_at desc);
create index audit_logs_entity_idx on public.audit_logs(org_id, entity_type, entity_id);

-- Transactional outbox: events are written in the same transaction as the
-- state change, then published by the worker (at-least-once; consumers dedupe by id).
create table public.outbox_events (
  id uuid primary key default gen_random_uuid(),
  org_id uuid references public.organizations(id) on delete cascade,
  aggregate_type text not null,
  aggregate_id text not null,
  event_type text not null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  available_at timestamptz not null default now(),
  published_at timestamptz,
  attempts integer not null default 0,
  last_error text
);
create index outbox_unpublished_idx on public.outbox_events(available_at) where published_at is null;
create index outbox_org_idx on public.outbox_events(org_id, created_at desc);

-- Idempotency for client retries and provider webhooks.
create table public.idempotency_keys (
  org_id uuid not null references public.organizations(id) on delete cascade,
  scope text not null,
  key text not null check (length(key) between 8 and 200),
  request_hash text not null,
  response jsonb,
  status_code integer,
  created_at timestamptz not null default now(),
  primary key (org_id, scope, key)
);

-- Deterministic legacy → 2.0 identifier mapping used by the migration tool.
create table public.legacy_id_map (
  org_id uuid not null references public.organizations(id) on delete cascade,
  entity_type text not null,
  legacy_id text not null,
  new_id uuid not null,
  migrated_at timestamptz not null default now(),
  primary key (org_id, entity_type, legacy_id)
);

-- ---------------------------------------------------------------------------
-- RLS for the tables above
-- ---------------------------------------------------------------------------
alter table public.organizations enable row level security;
create policy org_tenant_system on public.organizations for select to resuto_tenant using (id = (select app.current_org_id()));
create policy org_member_read on public.organizations for select to resuto_member using (id = (select app.current_org_id()) and (select app.is_member(app.current_org_id())));
create policy org_member_update on public.organizations for update to resuto_member
  using (id = (select app.current_org_id()) and (select app.is_member(app.current_org_id())))
  with check (id = (select app.current_org_id()));
create policy org_realtime_read on public.organizations for select to authenticated using (id in (select app.member_org_ids()));
grant select, update on public.organizations to resuto_member;
grant select on public.organizations to resuto_tenant, authenticated;

select app.enable_tenant_rls('public.branches', 'id');
select app.enable_realtime_read('public.branches');

alter table public.profiles enable row level security;
create policy profile_self on public.profiles for all to resuto_member, authenticated
  using (id = auth.uid()) with check (id = auth.uid());
-- staff can see colleagues' profiles inside the current tenant
create policy profile_colleagues on public.profiles for select to resuto_member
  using (exists (select 1 from public.memberships m where m.user_id = profiles.id and m.org_id = (select app.current_org_id()))
         and (select app.is_member(app.current_org_id())));
grant select, insert, update on public.profiles to resuto_member;
grant select, update on public.profiles to authenticated;

select app.enable_tenant_rls('public.memberships');
create policy membership_self_read on public.memberships for select to authenticated using (user_id = auth.uid());
grant select on public.memberships to authenticated;
select app.enable_tenant_rls('public.invitations');

alter table public.platform_admins enable row level security; -- no policies: platform-only

select app.enable_tenant_rls('public.audit_logs', 'branch_id');
-- audit entries are append-only for every non-owner role
create or replace function app.audit_append_only() returns trigger language plpgsql as $$
begin raise exception 'audit_logs is append-only'; end $$;
create trigger audit_logs_no_update before update or delete on public.audit_logs
  for each row when (current_user in ('resuto_member', 'resuto_tenant')) execute function app.audit_append_only();
grant usage on all sequences in schema public to resuto_member, resuto_tenant;

select app.enable_tenant_rls('public.outbox_events');
select app.enable_tenant_rls('public.idempotency_keys');
alter table public.legacy_id_map enable row level security; -- migration tool only

select app.lockdown_public_grants();
