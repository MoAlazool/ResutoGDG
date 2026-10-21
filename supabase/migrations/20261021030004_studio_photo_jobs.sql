-- FT-04: food-photo enhancement as a durable job: upload -> queued -> processing -> review -> approved | rejected ->
-- published (to a menu item or a website section), or failed. The original is kept untouched (source_media_id);
-- the enhanced master is a separate media asset (output_media_id, source 'studio_enhanced') with WebP derivatives
-- (media_assets.variants) and an AVIF copy (formats). Publishing happens only from 'approved' and is idempotent per key.
-- mode 'deterministic' = local tonal/geometric adjustments (sharp), the default and only mode offered; 'generative' is
-- reserved for a restaurant-configured provider and is refused while none is configured.
-- Reverse: drop table public.studio_photo_jobs; restore media_assets_source_check without 'studio_enhanced'.
alter table public.media_assets drop constraint if exists media_assets_source_check;
alter table public.media_assets add constraint media_assets_source_check
  check (source in ('upload', 'ai_generated', 'import', 'legacy', 'studio_enhanced'));

create table if not exists public.studio_photo_jobs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  status text not null default 'queued'
    check (status in ('queued', 'processing', 'review', 'approved', 'rejected', 'published', 'failed')),
  mode text not null default 'deterministic' check (mode in ('deterministic', 'generative')),
  provider text not null default 'resuto_sharp' check (length(provider) <= 60),
  model text check (model is null or length(model) <= 80),
  params jsonb not null default '{}'::jsonb,
  -- Suggested target chosen at upload (the menu item the photo is of); publishing still names its target.
  product_id uuid references public.products(id) on delete set null,
  source_media_id uuid not null references public.media_assets(id) on delete restrict,
  output_media_id uuid references public.media_assets(id) on delete set null,
  formats jsonb not null default '[]'::jsonb check (jsonb_typeof(formats) = 'array'),
  provenance jsonb,
  error text check (error is null or length(error) <= 1000),
  attempts integer not null default 0 check (attempts between 0 and 10),
  lease uuid,
  leased_until timestamptz,
  reviewed_by uuid references auth.users(id) on delete set null,
  reviewed_at timestamptz,
  review_note text check (review_note is null or length(review_note) <= 500),
  published_target text check (published_target is null or published_target in ('product', 'website_section')),
  published_id uuid,
  published_key text check (published_key is null or length(published_key) <= 200),
  published_by uuid references auth.users(id) on delete set null,
  published_at timestamptz,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (status <> 'published' or (published_target is not null and published_id is not null))
);
create index if not exists studio_photo_jobs_org_idx on public.studio_photo_jobs(org_id, created_at desc);
create index if not exists studio_photo_jobs_due_idx on public.studio_photo_jobs(created_at) where status in ('queued', 'processing');
select app.enable_tenant_rls('public.studio_photo_jobs');

select app.lockdown_public_grants();
