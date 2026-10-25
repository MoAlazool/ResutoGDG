-- 21-HOME (plan §6.1): per-user, per-restaurant preferences. The first scope is 'overview': which sections of the
-- overview command centre a staff member shows, and in which order ({"sections": [{"id": "now", "visible": true}, …]}).
--
-- Only the user themself reads or writes their rows: a staff session (resuto_member) sees a row only for its own
-- auth.uid() inside the current restaurant with an active membership. No other execution role has any access (tenant
-- and platform contexts, colleagues, owners included), and client roles have none (lockdown below).
--
-- Reverse: drop table public.user_preferences.

create table public.user_preferences (
  org_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  scope text not null check (scope in ('overview')),
  value jsonb not null default '{}'::jsonb check (jsonb_typeof(value) = 'object' and pg_column_size(value) <= 8192),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (org_id, user_id, scope)
);
create trigger user_preferences_updated before update on public.user_preferences for each row execute function app.set_updated_at();

alter table public.user_preferences enable row level security;
create policy user_preferences_self on public.user_preferences for all to resuto_member
  using (org_id = (select app.current_org_id()) and user_id = (select auth.uid()) and (select app.is_member(app.current_org_id())))
  with check (org_id = (select app.current_org_id()) and user_id = (select auth.uid()) and (select app.is_member(app.current_org_id())));
revoke all on public.user_preferences from resuto_tenant, resuto_platform;
grant select, insert, update, delete on public.user_preferences to resuto_member;

select app.lockdown_public_grants();
