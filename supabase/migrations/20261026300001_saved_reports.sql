-- 21-INSIGHTS (plan §5, Analytics + Intelligence → one Insights area): saved report views. A member saves the view
-- they are looking at (section + period + comparison + branch + page filters) under a name and reopens it later.
--
-- Why a table and not user_preferences (21-HOME): user_preferences holds one small value per user, restaurant and
-- scope, readable only by that user. A member keeps many named reports, and may share one with colleagues who can
-- read analytics, which user_preferences' self-only policy rightly does not allow.
--
-- Access (resuto_member only; tenant and platform contexts and client roles have none):
--   read    own reports, plus colleagues' reports marked shared when the caller's role may read analytics
--           (app.can_read_analytics: owner, admin, manager, marketing, accountant, the roles with analytics:read in
--           packages/contracts/src/permissions.ts; apps/api/test/reports.test.ts checks the two lists agree). A
--           report pinned to a branch is visible only to staff who can access that branch.
--   write   only the author's own rows (insert, update, delete), inside the current restaurant, with an active
--           membership, and never pinned to a branch outside the author's scope.
--
-- Reverse: drop table public.saved_reports; drop function app.can_read_analytics(uuid), app.saved_report_same_org().

create table public.saved_reports (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  -- null: every branch the viewer can see. A deleted branch removes its reports instead of widening them.
  branch_id uuid references public.branches(id) on delete cascade,
  name text not null check (length(name) between 1 and 80 and name = btrim(name)),
  -- An Insights view key (REPORT_SECTIONS in packages/contracts/src/report-sections.ts; the API validates the list).
  section text not null check (section ~ '^[a-z][a-z0-9_]{1,31}$'),
  -- { period, from?, to?, compare, filters }: validated by the API (reportViewInput), bounded here.
  view jsonb not null default '{}'::jsonb check (jsonb_typeof(view) = 'object' and pg_column_size(view) <= 4096),
  shared boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index saved_reports_name_idx on public.saved_reports(org_id, user_id, lower(name));
create index saved_reports_list_idx on public.saved_reports(org_id, updated_at desc, id);
create trigger saved_reports_updated before update on public.saved_reports for each row execute function app.set_updated_at();

create or replace function app.saved_report_same_org() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  if new.branch_id is not null and not exists (select 1 from public.branches b where b.id = new.branch_id and b.org_id = new.org_id) then
    raise exception 'branch % does not belong to organization %', new.branch_id, new.org_id using errcode = '23514';
  end if;
  return new;
end $$;
revoke all on function app.saved_report_same_org() from public;
create trigger saved_reports_same_org before insert or update of org_id, branch_id on public.saved_reports
  for each row execute function app.saved_report_same_org();

-- Whether the signed-in user's active membership in p_org has a role with analytics:read (security definer: it reads
-- memberships without their own RLS, like app.is_member).
create or replace function app.can_read_analytics(p_org uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select p_org is not null and exists (
    select 1 from public.memberships m
     where m.org_id = p_org and m.user_id = auth.uid() and m.status = 'active'
       and m.role in ('owner', 'admin', 'manager', 'marketing', 'accountant'))
$$;
revoke all on function app.can_read_analytics(uuid) from public;
grant execute on function app.can_read_analytics(uuid) to resuto_member;

alter table public.saved_reports enable row level security;
create policy saved_reports_read on public.saved_reports for select to resuto_member
  using (org_id = (select app.current_org_id()) and (select app.is_member(app.current_org_id()))
    and (user_id = (select auth.uid()) or (shared and (select app.can_read_analytics(app.current_org_id()))))
    and ((select app.branch_scope()) is null or branch_id is null or array[branch_id] <@ (select app.branch_scope())));
create policy saved_reports_insert on public.saved_reports for insert to resuto_member
  with check (org_id = (select app.current_org_id()) and user_id = (select auth.uid()) and (select app.is_member(app.current_org_id()))
    and ((select app.branch_scope()) is null or branch_id is null or array[branch_id] <@ (select app.branch_scope())));
create policy saved_reports_update on public.saved_reports for update to resuto_member
  using (org_id = (select app.current_org_id()) and user_id = (select auth.uid()) and (select app.is_member(app.current_org_id())))
  with check (org_id = (select app.current_org_id()) and user_id = (select auth.uid()) and (select app.is_member(app.current_org_id()))
    and ((select app.branch_scope()) is null or branch_id is null or array[branch_id] <@ (select app.branch_scope())));
create policy saved_reports_delete on public.saved_reports for delete to resuto_member
  using (org_id = (select app.current_org_id()) and user_id = (select auth.uid()) and (select app.is_member(app.current_org_id())));
revoke all on public.saved_reports from resuto_tenant, resuto_platform;
grant select, insert, update, delete on public.saved_reports to resuto_member;

select app.lockdown_public_grants();
