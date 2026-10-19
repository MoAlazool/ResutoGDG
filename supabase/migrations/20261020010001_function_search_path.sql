-- Hardening (Supabase advisor "function_search_path_mutable", OPEN_BLOCKERS B-15): every function in the app schema
-- runs with a fixed search_path, so a caller cannot shadow the objects it uses. Bodies already schema-qualify
-- application objects (app.*, public.*) and only use pg_catalog built-ins otherwise. Additive and reversible
-- (ALTER FUNCTION ... RESET search_path).
alter function app.audit_append_only() set search_path = public, pg_temp;
alter function app.consent_append_only() set search_path = public, pg_temp;
alter function app.current_actor() set search_path = public, pg_temp;
alter function app.current_org_id() set search_path = public, pg_temp;
alter function app.enable_realtime_read(regclass) set search_path = public, pg_temp;
alter function app.enable_tenant_rls(regclass, text) set search_path = public, pg_temp;
alter function app.fiscal_document_immutable() set search_path = public, pg_temp;
alter function app.lockdown_public_grants() set search_path = public, pg_temp;
alter function app.record_customer_consent() set search_path = public, pg_temp;
alter function app.set_updated_at() set search_path = public, pg_temp;
alter function app.website_revisions_immutable() set search_path = public, pg_temp;
