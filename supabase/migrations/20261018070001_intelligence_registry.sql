-- Resuto Intelligence (Agent E1): model registry keys and query indexes.
--
-- Platform baseline models (org_id null) are registered by the API at start-up from the
-- committed research results (apps/api/src/modules/intelligence/registry). The unique keys
-- below make that registration an idempotent upsert; NULL org ids would otherwise never
-- collide under the table's (task, name, version, org_id) constraint.

create unique index ai_models_platform_key on public.ai_models(task, name, version) where org_id is null;
create unique index ai_evaluations_run_key on public.ai_evaluations(model_id, run_id, split);

create index ai_insights_org_status_idx on public.ai_insights(org_id, status, created_at desc);
create index ai_predictions_subject_idx on public.ai_predictions(org_id, kind, subject_type, subject_id, created_at desc);
create index assistant_threads_user_idx on public.assistant_threads(org_id, user_id, created_at desc);

-- Insight status changes are recorded with their time for the dashboard feed.
alter table public.ai_insights add column status_changed_at timestamptz;
alter table public.ai_insights add column status_changed_by uuid references auth.users(id) on delete set null;

select app.lockdown_public_grants();
