-- Integration framework: connections, encrypted credentials, sync cursors,
-- conflicts, health, and a single deduplicating webhook inbox for all providers.

create type public.integration_status as enum ('not_configured', 'sandbox', 'pending', 'connected', 'error', 'revoked');

create table public.integration_connections (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  branch_id uuid references public.branches(id) on delete cascade,
  provider text not null check (provider ~ '^[a-z0-9_]{2,40}$'),
  category text not null check (category in ('pos', 'payments', 'accounting', 'messaging', 'ads', 'delivery', 'tax', 'billing', 'ai')),
  auth_type text not null check (auth_type in ('oauth', 'api_key', 'webhook_secret', 'none')),
  environment text not null default 'sandbox' check (environment in ('sandbox', 'live')),
  status public.integration_status not null default 'not_configured',
  -- AES-256-GCM envelope "v1:<key_id>:<iv>:<tag>:<ciphertext>" produced by the API.
  -- The database never sees plaintext secrets; clients never see this column.
  credentials_encrypted text,
  credentials_hint text,               -- e.g. "sk_test_…4242"
  config jsonb not null default '{}'::jsonb,
  scopes text[] not null default '{}',
  -- Which system owns each resource when connected, e.g. {"menu":"provider","orders":"resuto"}.
  source_of_truth jsonb not null default '{}'::jsonb,
  webhook_secret_hash text,
  health jsonb not null default '{}'::jsonb,
  last_health_check_at timestamptz,
  last_error text,
  rate_limit jsonb not null default '{}'::jsonb,
  connected_by uuid references auth.users(id),
  connected_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index integration_connections_unique on public.integration_connections(org_id, provider, coalesce(branch_id, '00000000-0000-0000-0000-000000000000'::uuid));
create trigger integration_connections_updated before update on public.integration_connections for each row execute function app.set_updated_at();

create table public.integration_sync_cursors (
  org_id uuid not null references public.organizations(id) on delete cascade,
  connection_id uuid not null references public.integration_connections(id) on delete cascade,
  resource text not null,
  cursor text,
  last_synced_at timestamptz,
  primary key (connection_id, resource)
);

create table public.integration_sync_runs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  connection_id uuid not null references public.integration_connections(id) on delete cascade,
  resource text not null,
  direction text not null check (direction in ('pull', 'push')),
  status text not null default 'running' check (status in ('running', 'succeeded', 'failed', 'partial')),
  stats jsonb not null default '{}'::jsonb,
  error text,
  attempt integer not null default 1,
  started_at timestamptz not null default now(),
  finished_at timestamptz
);
create index integration_sync_runs_conn_idx on public.integration_sync_runs(connection_id, started_at desc);

create table public.integration_conflicts (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  connection_id uuid not null references public.integration_connections(id) on delete cascade,
  resource text not null,
  local_id text,
  external_id text,
  local_snapshot jsonb,
  external_snapshot jsonb,
  resolution text not null default 'pending' check (resolution in ('pending', 'kept_local', 'kept_external', 'merged', 'ignored')),
  resolved_by uuid references auth.users(id),
  resolved_at timestamptz,
  created_at timestamptz not null default now()
);

create table public.integration_logs (
  id bigint generated always as identity primary key,
  org_id uuid not null references public.organizations(id) on delete cascade,
  connection_id uuid references public.integration_connections(id) on delete cascade,
  level text not null check (level in ('debug', 'info', 'warn', 'error')),
  message text not null,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index integration_logs_conn_idx on public.integration_logs(connection_id, created_at desc);

-- Every inbound webhook (payments, WhatsApp, ads, accounting) lands here first.
-- (provider, event_key) dedupes provider retries; processing is idempotent.
create table public.webhook_inbox (
  id uuid primary key default gen_random_uuid(),
  provider text not null,
  event_key text not null,
  org_id uuid references public.organizations(id) on delete cascade,
  signature_valid boolean not null,
  headers jsonb not null default '{}'::jsonb,
  payload jsonb not null,
  status text not null default 'received' check (status in ('received', 'processed', 'ignored', 'failed', 'rejected')),
  attempts integer not null default 0,
  error text,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  unique (provider, event_key)
);
create index webhook_inbox_pending_idx on public.webhook_inbox(received_at) where status in ('received', 'failed');

select app.enable_tenant_rls('public.integration_connections', 'branch_id');
-- Encrypted credentials are never readable by member sessions.
revoke select on public.integration_connections from resuto_member;
grant select (id, org_id, branch_id, provider, category, auth_type, environment, status, credentials_hint, config, scopes,
              source_of_truth, health, last_health_check_at, last_error, rate_limit, connected_by, connected_at, created_at, updated_at)
  on public.integration_connections to resuto_member;
select app.enable_tenant_rls('public.integration_sync_cursors');
select app.enable_tenant_rls('public.integration_sync_runs');
select app.enable_tenant_rls('public.integration_conflicts');
select app.enable_tenant_rls('public.integration_logs');
alter table public.webhook_inbox enable row level security;   -- platform (webhook receiver) only

select app.lockdown_public_grants();
