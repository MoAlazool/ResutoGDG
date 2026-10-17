-- ResutoStudio (Agent F): immutable publish revisions and hosting-provider
-- details for custom domains. The public website is always served from the
-- latest row in website_revisions, so draft edits never leak before publish.

create table public.website_revisions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  website_id uuid not null references public.websites(id) on delete cascade,
  revision integer not null check (revision > 0),
  -- { template, theme, seo, sections: [{ id, kind, sortOrder, content }] } (visible sections only)
  snapshot jsonb not null,
  note text check (note is null or length(note) <= 200),
  published_by uuid references auth.users(id),
  published_at timestamptz not null default now(),
  unique (website_id, revision)
);
create index website_revisions_site_idx on public.website_revisions(website_id, revision desc);

-- Revisions are history: never rewritten by application roles.
create or replace function app.website_revisions_immutable() returns trigger language plpgsql as $$
begin
  raise exception 'website revisions are immutable' using errcode = '42501';
end $$;
create trigger website_revisions_no_update before update on public.website_revisions
  for each row execute function app.website_revisions_immutable();

alter table public.custom_domains
  add column provider text not null default 'manual' check (provider in ('manual', 'vercel')),
  add column provider_details jsonb not null default '{}'::jsonb,
  add column activated_at timestamptz;

create index custom_domains_org_idx on public.custom_domains(org_id);
create index creative_assets_org_idx on public.creative_assets(org_id, created_at desc);

select app.enable_tenant_rls('public.website_revisions');
select app.lockdown_public_grants();
