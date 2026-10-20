-- Guest ratings after payment (legacy /api/rating; audit VP-21, FT-21, VS-27).
--
-- A guest who has paid (the table bill, a split share, or a web order) can leave one rating: overall 1-5, optional
-- food / service / speed / value scores and a comment. No guest identity is stored with a rating; the visit, share or
-- order it belongs to is kept only to allow one rating each and to scope it to a branch. Staff read aggregates through
-- the API (analytics:read); direct Supabase clients have no access (lockdown below, as for every public table).
--
-- Reversal: drop table public.guest_ratings;

create table public.guest_ratings (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  branch_id uuid not null references public.branches(id) on delete cascade,
  source text not null check (source in ('table', 'share', 'web')),
  visit_id uuid references public.visits(id) on delete cascade,
  share_id uuid references public.bill_shares(id) on delete cascade,
  order_id uuid references public.orders(id) on delete cascade,
  overall smallint not null check (overall between 1 and 5),
  food smallint check (food between 1 and 5),
  service smallint check (service between 1 and 5),
  speed smallint check (speed between 1 and 5),
  value smallint check (value between 1 and 5),
  comment text check (comment is null or length(comment) between 1 and 1000),
  created_at timestamptz not null default now(),
  -- Every rating belongs to exactly what was paid for.
  check ((source = 'table' and visit_id is not null and share_id is null and order_id is null)
      or (source = 'share' and share_id is not null and order_id is null)
      or (source = 'web' and order_id is not null and visit_id is null and share_id is null))
);
create unique index guest_ratings_one_per_visit on public.guest_ratings(visit_id) where source = 'table';
create unique index guest_ratings_one_per_share on public.guest_ratings(share_id) where source = 'share';
create unique index guest_ratings_one_per_order on public.guest_ratings(order_id) where source = 'web';
create index guest_ratings_org_created_idx on public.guest_ratings(org_id, created_at desc);
create index guest_ratings_branch_created_idx on public.guest_ratings(branch_id, created_at desc);

select app.enable_tenant_rls('public.guest_ratings', 'branch_id');
-- A rating is what the guest said: staff sessions only read it, and nobody edits it afterwards.
revoke insert, update, delete on public.guest_ratings from resuto_member;
revoke update on public.guest_ratings from resuto_tenant;
select app.lockdown_public_grants();
