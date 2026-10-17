-- Integration framework (Agent C): explicit enable/disable switch, OAuth state
-- for provider authorisation, and one pending conflict per external record.

-- status keeps provider health (pending/connected/error/revoked); enabled is the
-- restaurant's on/off switch and never changes credentials.
alter table public.integration_connections add column enabled boolean not null default true;
-- integration_connections uses column-level SELECT for member sessions (credentials are hidden).
grant select (enabled) on public.integration_connections to resuto_member;

create table public.integration_oauth_states (
  state_hash text primary key,                 -- sha256 of the random state sent to the provider
  org_id uuid not null references public.organizations(id) on delete cascade,
  provider text not null check (provider ~ '^[a-z0-9_]{2,40}$'),
  environment text not null default 'live' check (environment in ('sandbox', 'live')),
  redirect_after text check (redirect_after is null or redirect_after ~ '^/[^/]'),
  created_by uuid references auth.users(id),
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);
select app.enable_tenant_rls('public.integration_oauth_states');

create unique index integration_conflicts_pending_idx on public.integration_conflicts(connection_id, resource, external_id)
  where resolution = 'pending';

select app.lockdown_public_grants();
