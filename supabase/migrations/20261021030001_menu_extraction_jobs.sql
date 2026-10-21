-- FT-08 / VS-26: menu extraction as a durable job with an editable review draft.
--
-- upload or paste -> job (queued | processing) -> review (the draft rows are edited here, versioned) -> committing ->
-- committed (through the existing menu import, MenuService.importCommit) | failed | discarded.
-- Text and CSV are read by Resuto's own parser (provider 'resuto_parser', no model). Photos and PDFs are read only with
-- the restaurant's own model key (integration 'gemini_byok'); without it they are refused before anything is stored.
-- Nothing reaches the menu before a reviewer commits approved rows.
-- Reverse: drop table public.menu_extraction_jobs;
create table if not exists public.menu_extraction_jobs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  status text not null default 'queued'
    check (status in ('queued', 'processing', 'review', 'committing', 'committed', 'failed', 'discarded')),
  mode text not null check (mode in ('heuristic_text', 'csv_columns', 'vision_model')),
  source_kind text not null check (source_kind in ('text', 'csv', 'image', 'pdf')),
  source_name text check (source_name is null or length(source_name) <= 120),
  -- Photos/PDFs: the uploaded original (private "imports" folder, never served on guest pages).
  source_media_id uuid references public.media_assets(id) on delete set null,
  -- Pasted text / CSV as received (bounded), so a draft can be traced back to its source.
  source_text text check (source_text is null or length(source_text) <= 200000),
  provider text not null check (provider in ('resuto_parser', 'gemini_byok')),
  model text check (model is null or length(model) <= 80),
  rows jsonb not null default '[]'::jsonb check (jsonb_typeof(rows) = 'array'),
  uncertainties jsonb not null default '[]'::jsonb check (jsonb_typeof(uncertainties) = 'array'),
  -- Optimistic concurrency for review edits: every draft change increments it; a stale edit is refused.
  version integer not null default 0 check (version >= 0),
  attempts integer not null default 0 check (attempts between 0 and 10),
  lease uuid,
  leased_until timestamptz,
  error text check (error is null or length(error) <= 1000),
  commit_result jsonb,
  created_by uuid references auth.users(id) on delete set null,
  committed_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  committed_at timestamptz
);
create index if not exists menu_extraction_jobs_org_idx on public.menu_extraction_jobs(org_id, created_at desc);
create index if not exists menu_extraction_jobs_due_idx on public.menu_extraction_jobs(created_at) where status in ('queued', 'processing');
select app.enable_tenant_rls('public.menu_extraction_jobs');

select app.lockdown_public_grants();
