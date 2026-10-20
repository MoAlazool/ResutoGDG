-- Branch storefront branding (audit VP-05). A branch can trade under its own brand (the demo's Smash & Co is a
-- burger concept run by The Olive Room's company): its own name, colours, logo, hero photo and storefront copy,
-- published at /r/<org slug>/<storefront slug> and linked from the restaurant website. Menu, prices, stock and
-- ordering stay the branch's own data (the storefront only brands them), so nothing about the brand is hard-coded.
--
-- Tenant data with branch scope: the API's tenant/member roles see their own organization's rows (branch-scoped staff
-- only their branches, like every branch table); direct Supabase clients get nothing (lockdown).
-- Down: drop table public.branch_storefronts;

create table public.branch_storefronts (
  branch_id uuid primary key references public.branches(id) on delete cascade,
  org_id uuid not null references public.organizations(id) on delete cascade,
  slug text not null check (slug ~ '^[a-z0-9](?:[a-z0-9-]{1,46}[a-z0-9])$' and slug not in ('revalidate', 'order', 'reserve', 'menu', 'pay', 'admin', 'api')),
  brand_name text not null check (length(brand_name) between 1 and 80),
  brand_name_ar text check (brand_name_ar is null or length(brand_name_ar) <= 80),
  tagline jsonb not null default '{}'::jsonb,       -- { en, ar }
  theme jsonb not null default '{}'::jsonb,         -- { primaryColor, accentColor, inkColor, paperColor } (#rrggbb)
  logo_media_id uuid references public.media_assets(id) on delete set null,
  hero_media_id uuid references public.media_assets(id) on delete set null,
  content jsonb not null default '{}'::jsonb,       -- headline, body, heroNote, promo, per-category section copy
  is_published boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, slug)
);
create index branch_storefronts_org_idx on public.branch_storefronts (org_id);
create trigger branch_storefronts_updated before update on public.branch_storefronts for each row execute function app.set_updated_at();

-- The branch must belong to the same organization as the row (RLS checks org_id; this keeps the pair consistent).
create or replace function app.branch_storefront_same_org() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  if not exists (select 1 from public.branches b where b.id = new.branch_id and b.org_id = new.org_id) then
    raise exception 'branch % does not belong to organization %', new.branch_id, new.org_id using errcode = '23514';
  end if;
  return new;
end $$;
revoke all on function app.branch_storefront_same_org() from public;
create trigger branch_storefronts_same_org before insert or update of branch_id, org_id on public.branch_storefronts
  for each row execute function app.branch_storefront_same_org();

select app.enable_tenant_rls('public.branch_storefronts', 'branch_id');
select app.lockdown_public_grants();
