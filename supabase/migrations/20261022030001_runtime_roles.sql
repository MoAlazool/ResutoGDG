-- Least-privilege runtime roles (audit PS-16).
--
-- Until now the API connected as the schema owner (on Supabase: `postgres`, which bypasses RLS) and ran its
-- cross-tenant "platform" work (tenant lookup by QR/slug/host/token, webhook inbox, outbox claim, memberships,
-- platform administration, scheduled jobs) with no RLS and every privilege of the owner. This migration adds:
--
--   * resuto_platform — NOLOGIN, NOBYPASSRLS, owns nothing. DbService.withPlatform() runs `set local role
--     resuto_platform`, so platform work reaches only the tables granted below, through explicit `platform_*`
--     policies, and can never run DDL, change policies, read auth secrets or touch tables it was not granted.
--     The grant list is what the platform code paths use, measured by running the whole API suite with every
--     platform statement EXPLAINed (relations and operations) and then re-running it under this role.
--   * resuto_api — NOLOGIN, NOINHERIT, NOBYPASSRLS, owns nothing: the runtime identity. It is a member of
--     resuto_member, resuto_tenant and resuto_platform but inherits none of their privileges, so a session as
--     resuto_api can do nothing until DbService picks an execution context with SET LOCAL ROLE.
--
-- No LOGIN and no password here: the owner turns resuto_api into a login role (or creates a login role in it)
-- outside migrations, then points DATABASE_URL at it and keeps the owner connection in MIGRATION_DATABASE_URL.
-- Exact steps: docs/STAGING_DEPLOYMENT.md, "Least-privilege database role (PS-16)". With the current single owner
-- DATABASE_URL the owner is granted resuto_platform below and platform transactions SET LOCAL ROLE to it, so a
-- statement it was not granted fails. That is a guard against mistakes, not a security boundary: the owner session
-- can SET ROLE back to itself, so SQL injected into a platform path still has owner rights. Only the resuto_api
-- login (owner kept in MIGRATION_DATABASE_URL) makes the restriction enforceable. The API's opt-in
-- DATABASE_PLATFORM_FALLBACK=log-and-retry (off by default) re-runs a denied transaction as the owner.
--
-- New tables that platform code reads or writes need `select app.grant_platform('public.<table>', array[...])`
-- (supabase/tests/runtime-roles.test.mjs fails when a granted table has no matching platform policy).
--
-- Reverse: drop policy platform_* on each table, revoke all on all tables in schema public from resuto_platform,
-- drop function app.grant_platform(regclass, text[]), app.notification_recipient_emails(uuid, uuid, text[], uuid),
-- then drop role resuto_api, resuto_platform.

do $$
declare r record;
begin
  if not exists (select 1 from pg_roles where rolname = 'resuto_platform') then create role resuto_platform nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'resuto_api') then create role resuto_api nologin noinherit; end if;
  -- Never run on top of a role someone created with more power than this design gives it.
  for r in select rolname from pg_roles
            where rolname in ('resuto_api', 'resuto_platform', 'resuto_member', 'resuto_tenant')
              and (rolsuper or rolbypassrls or rolcreaterole or rolcreatedb or rolreplication) loop
    raise exception 'role % must not be SUPERUSER, BYPASSRLS, CREATEROLE, CREATEDB or REPLICATION', r.rolname;
  end loop;
end $$;

-- The owner connection may act as the platform role (DbService on today's single DATABASE_URL).
grant resuto_platform to current_user;
-- The runtime login switches into one execution context per transaction (resuto_api is NOINHERIT).
grant resuto_member, resuto_tenant, resuto_platform to resuto_api;

grant usage on schema app, public, auth to resuto_platform;
-- No application role creates objects. Plain Postgres before 15 (and the local reset) grants CREATE on public to
-- PUBLIC, which would let any execution role add tables or functions to the API's search_path.
revoke create on schema public from public;
revoke create on schema public, app from resuto_member, resuto_tenant, resuto_platform, resuto_api;
grant usage on all sequences in schema public to resuto_platform;
grant execute on function
  app.current_org_id(),
  app.current_actor(),
  app.module_enabled(uuid, public.module_key, timestamptz)
to resuto_platform;
-- Scheduled jobs (analytics rollups, customer-stats reconcile) call these owner-defined SECURITY DEFINER functions
-- (fixed search_path, EXECUTE revoked from PUBLIC in their own migrations): only the platform role may call them.
grant execute on function
  app.analytics_discover_days(interval),
  app.analytics_refresh_day(uuid, uuid, date),
  app.reconcile_customer_stats(timestamptz)
to resuto_platform;

-- Grants a table to the platform role together with one permissive policy per granted command, so a grant never
-- turns into silently empty results under RLS. Owner-only (migrations).
create or replace function app.grant_platform(p_table regclass, p_privileges text[]) returns void
language plpgsql set search_path = pg_catalog, public as $$
declare
  p text;
begin
  foreach p in array p_privileges loop
    if p not in ('select', 'insert', 'update', 'delete') then raise exception 'unsupported privilege %', p; end if;
    execute format('grant %s on %s to resuto_platform', p, p_table);
    execute format('drop policy if exists %I on %s', 'platform_' || p, p_table);
    execute case p
      when 'insert' then format('create policy %I on %s for insert to resuto_platform with check (true)', 'platform_' || p, p_table)
      when 'update' then format('create policy %I on %s for update to resuto_platform using (true) with check (true)', 'platform_' || p, p_table)
      else format('create policy %I on %s for %s to resuto_platform using (true)', 'platform_' || p, p_table, p)
    end;
  end loop;
end $$;
revoke execute on function app.grant_platform(regclass, text[]) from public, resuto_member, resuto_tenant, resuto_platform;

do $$
declare
  t record;
begin
  for t in select * from (values
  ('accounting_pushes', array['select']),
  ('ai_evaluations', array['select', 'insert', 'update']),
  ('ai_models', array['select', 'insert', 'update']),
  ('analytics_days', array['select', 'update']),
  ('analytics_order_rollups', array['select']),
  ('audit_logs', array['select', 'insert']),
  ('bill_shares', array['select']),
  ('bill_splits', array['select']),
  ('branches', array['select', 'insert']),
  ('campaigns', array['select']),
  ('checkout_sessions', array['select']),
  ('compliance_reminders', array['select']),
  ('conversations', array['select']),
  ('custom_domains', array['select']),
  ('customer_stats', array['select', 'insert']),
  ('customers', array['select']),
  ('delivery_offers', array['select']),
  ('dining_tables', array['select']),
  ('drivers', array['select', 'insert', 'update']),
  ('entitlement_overrides', array['select', 'insert', 'update']),
  ('event_effects', array['select', 'insert']),
  ('event_handlings', array['select', 'insert', 'update']),
  ('expense_categories', array['select', 'insert']),
  ('floor_layouts', array['select', 'insert']),
  ('government_submissions', array['select']),
  ('idempotency_keys', array['select', 'delete']),
  ('integration_connections', array['select']),
  ('integration_verifications', array['select']),
  ('invitations', array['select', 'update']),
  ('job_leases', array['select', 'insert', 'update']),
  ('job_runs', array['select', 'insert', 'update', 'delete']),
  ('legacy_id_map', array['select']),
  ('loyalty_ledger', array['select']),
  ('mcp_approvals', array['select']),
  ('mcp_clients', array['select', 'update']),
  ('mcp_oauth_clients', array['select', 'insert', 'update']),
  ('mcp_oauth_codes', array['select', 'insert', 'update']),
  ('mcp_oauth_requests', array['select', 'insert', 'update']),
  ('mcp_oauth_tokens', array['select', 'insert', 'update']),
  ('media_assets', array['select', 'update']),
  ('memberships', array['select', 'insert', 'update']),
  ('menu_extraction_jobs', array['select', 'update']),
  ('menu_versions', array['select']),
  ('menus', array['select', 'insert']),
  ('messages', array['select', 'update']),
  ('messaging_channels', array['select', 'update']),
  ('meta_tracking_contexts', array['select', 'delete']),
  ('module_prices', array['select', 'insert']),
  ('notifications', array['select']),
  ('order_counters', array['select', 'insert']),
  ('ordering_sessions', array['select', 'update']),
  ('orders', array['select']),
  ('organizations', array['select', 'insert', 'update']),
  ('outbound_messages', array['select', 'update']),
  ('outbox_events', array['select', 'insert', 'update', 'delete']),
  ('payment_alerts', array['select']),
  ('payment_attempt_refs', array['select']),
  ('payments', array['select']),
  ('plan_modules', array['select']),
  ('plan_prices', array['select', 'insert']),
  ('plans', array['select']),
  ('platform_admins', array['select']),
  ('platform_invoices', array['select']),
  ('product_branch_settings', array['select', 'update']),
  ('profiles', array['select', 'insert', 'update']),
  ('refunds', array['select']),
  ('reservations', array['select']),
  ('sales_inquiries', array['select', 'insert']),
  ('service_requests', array['select']),
  ('studio_photo_jobs', array['select', 'update']),
  ('subscription_events', array['select', 'insert']),
  ('subscription_modules', array['select']),
  ('subscriptions', array['select', 'insert']),
  ('tax_profiles', array['select', 'insert']),
  ('tracking_links', array['select']),
  ('usage_events', array['select']),
  ('visits', array['select']),
  ('webhook_inbox', array['select', 'insert', 'update', 'delete']),
  ('website_sections', array['select', 'insert']),
  ('websites', array['select', 'insert']),
  ('zatca_egs_units', array['select'])
  ) as g(tbl, privs) loop
    perform app.grant_platform(format('public.%I', t.tbl)::regclass, t.privs);
  end loop;
end $$;

-- Staff e-mail recipients of a notification (FT-06 / INT-28). auth.users belongs to Supabase Auth: rather than a
-- table grant there, this owner-defined function returns only the sign-in e-mails of the org's active members that
-- the notification addresses. Callable by the platform role only.
create or replace function app.notification_recipient_emails(p_org uuid, p_user uuid, p_roles text[], p_branch uuid)
returns setof text language sql stable security definer set search_path = pg_catalog, public, auth as $$
  select distinct u.email::text from public.memberships m join auth.users u on u.id = m.user_id
   where m.org_id = p_org and m.status = 'active' and u.email is not null
     and ((p_user is not null and m.user_id = p_user) or (p_user is null and m.role::text = any(p_roles)))
     and (p_branch is null or m.branch_ids is null or p_branch = any(m.branch_ids))
$$;
revoke execute on function app.notification_recipient_emails(uuid, uuid, text[], uuid) from public, anon, authenticated, resuto_member, resuto_tenant;
grant execute on function app.notification_recipient_emails(uuid, uuid, text[], uuid) to resuto_platform;

-- The local development issuer (AUTH_DEV_MODE: dev signup/login/password) keeps its users in the auth shim's
-- auth.users. Hosted Supabase projects own auth.users through Supabase Auth and refuse the dev issuer, so the grant
-- exists only where the shim is in use (no supabase_auth_admin role).
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'supabase_auth_admin') then
    grant select, insert, update on auth.users to resuto_platform;
  end if;
end $$;

select app.lockdown_public_grants();
