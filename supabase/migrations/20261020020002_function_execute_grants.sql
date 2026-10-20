-- Function hardening, second half of advisor B-15 (audit PS-07; the fixed search_path is 20261020010001).
-- Every app-schema function was executable by PUBLIC (the Postgres default). Now only the API roles may call the
-- helpers that RLS policies and services use; the DDL helpers are owner-only; trigger functions need no EXECUTE grant
-- for the roles that fire them (Postgres checks EXECUTE when the trigger is created, by its owner).
-- New app functions must follow suit: `revoke execute on function app.<fn> from public` (enforced by
-- supabase/tests/rls.test.mjs). A per-schema default cannot revoke the global PUBLIC grant, hence the explicit rule.
--
-- Extensions btree_gist, citext and pg_trgm stay in public for now: moving them to an extensions schema changes how
-- unqualified citext operators resolve for any session or function whose search_path lacks that schema (citext
-- comparisons would silently fall back to case-sensitive text equality), and the API casts to ::citext by name.
-- See docs/STAGING_DEPLOYMENT.md (B-15) for the evaluation and the conditions for moving them.
--
-- Reversible: grant execute on all functions in schema app to public.

revoke execute on all functions in schema app from public, anon, authenticated;

grant execute on function
  app.current_org_id(),
  app.current_actor(),
  app.is_member(uuid),
  app.branch_scope(),
  app.member_org_ids(),
  app.module_enabled(uuid, public.module_key, timestamptz)
to resuto_member, resuto_tenant;

-- DDL helpers run only inside migrations (as the owner); trigger functions need no grant.
revoke execute on function
  app.enable_tenant_rls(regclass, text),
  app.enable_realtime_read(regclass),
  app.lockdown_public_grants(),
  app.set_updated_at()
from resuto_member, resuto_tenant;
