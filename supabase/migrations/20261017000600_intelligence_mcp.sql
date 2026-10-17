-- Resuto Intelligence (native AI) and ResutoMCP (external AI clients).
-- Both reach restaurant data only through the API's authorized business
-- capabilities; neither has direct database credentials.

create table public.ai_models (
  id uuid primary key default gen_random_uuid(),
  org_id uuid references public.organizations(id) on delete cascade,   -- null = platform-wide baseline
  task text not null check (task in ('demand_forecast', 'customer_segmentation', 'churn', 'recommendation', 'routing', 'anomaly', 'assistant')),
  name text not null,
  version text not null,
  algorithm text not null,
  params jsonb not null default '{}'::jsonb,
  dataset jsonb not null default '{}'::jsonb,    -- {name, kind: "real"|"synthetic", rows, period, checksum}
  is_synthetic_data boolean not null,
  artifact_uri text,
  status text not null default 'trained' check (status in ('training', 'trained', 'deployed', 'retired', 'failed')),
  created_at timestamptz not null default now(),
  unique (task, name, version, org_id)
);

create table public.ai_evaluations (
  id uuid primary key default gen_random_uuid(),
  model_id uuid not null references public.ai_models(id) on delete cascade,
  org_id uuid references public.organizations(id) on delete cascade,
  run_id text not null,
  split text not null check (split in ('validation', 'test', 'backtest')),
  metrics jsonb not null,                 -- e.g. {"mae":..,"rmse":..,"wape":..}
  baseline_metrics jsonb,                 -- naive comparison on the same split
  is_synthetic_data boolean not null,
  notes text,
  created_at timestamptz not null default now()
);

create table public.ai_predictions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  branch_id uuid references public.branches(id) on delete cascade,
  model_id uuid references public.ai_models(id) on delete set null,
  kind text not null check (kind in ('demand_forecast', 'segment_assignment', 'churn_risk', 'recommendation', 'route_plan', 'anomaly')),
  subject_type text,                       -- product, customer, branch, delivery_batch
  subject_id text,
  horizon_start timestamptz,
  horizon_end timestamptz,
  payload jsonb not null,
  created_at timestamptz not null default now()
);
create index ai_predictions_org_kind_idx on public.ai_predictions(org_id, kind, created_at desc);

create table public.ai_insights (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  branch_id uuid references public.branches(id) on delete cascade,
  kind text not null,                      -- sales, inventory, marketing, operations, anomaly
  severity text not null default 'info' check (severity in ('info', 'opportunity', 'warning', 'critical')),
  title text not null,
  body text not null,
  evidence jsonb not null default '{}'::jsonb,
  method text not null check (method in ('deterministic', 'model', 'llm')),
  status text not null default 'new' check (status in ('new', 'seen', 'dismissed', 'acted')),
  dedupe_key text,
  created_at timestamptz not null default now()
);
create unique index ai_insights_dedupe_idx on public.ai_insights(org_id, dedupe_key) where dedupe_key is not null;

create table public.assistant_threads (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  title text,
  created_at timestamptz not null default now()
);

create table public.assistant_messages (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  thread_id uuid not null references public.assistant_threads(id) on delete cascade,
  role text not null check (role in ('user', 'assistant', 'tool')),
  content text not null,
  tool_calls jsonb not null default '[]'::jsonb,
  provider text,
  created_at timestamptz not null default now()
);
create index assistant_messages_thread_idx on public.assistant_messages(thread_id, created_at);

-- ---------------------------------------------------------------------------
-- MCP
-- ---------------------------------------------------------------------------
create table public.mcp_clients (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  name text not null,
  key_prefix text not null unique,        -- shown to humans ("rmcp_3f9a…")
  key_hash text not null unique,          -- sha256 of the full key; plaintext shown once
  acting_role public.member_role not null default 'manager' check (acting_role <> 'owner'),
  branch_ids uuid[],
  allowed_tools text[] not null,
  rate_limit_per_min integer not null default 60 check (rate_limit_per_min between 1 and 600),
  status text not null default 'active' check (status in ('active', 'revoked')),
  expires_at timestamptz,
  last_used_at timestamptz,
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);

create table public.mcp_approvals (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  client_id uuid not null references public.mcp_clients(id) on delete cascade,
  tool text not null,
  input jsonb not null,
  input_hash text not null,
  summary text not null,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'expired', 'executed', 'failed')),
  requested_at timestamptz not null default now(),
  expires_at timestamptz not null,
  decided_by uuid references auth.users(id),
  decided_at timestamptz,
  executed_at timestamptz,
  result jsonb,
  unique (client_id, tool, input_hash, requested_at)
);
create index mcp_approvals_pending_idx on public.mcp_approvals(org_id, status) where status = 'pending';

create table public.mcp_tool_calls (
  id bigint generated always as identity primary key,
  org_id uuid not null references public.organizations(id) on delete cascade,
  client_id uuid not null references public.mcp_clients(id) on delete cascade,
  tool text not null,
  input_hash text not null,
  outcome text not null check (outcome in ('ok', 'denied', 'invalid_input', 'rate_limited', 'approval_required', 'error')),
  approval_id uuid references public.mcp_approvals(id),
  duration_ms integer,
  error text,
  created_at timestamptz not null default now()
);
create index mcp_tool_calls_client_idx on public.mcp_tool_calls(client_id, created_at desc);

-- Platform baselines (org_id null) are readable by all tenants via the API;
-- tenant rows get standard isolation.
alter table public.ai_models enable row level security;
create policy ai_models_read on public.ai_models for select to resuto_member, resuto_tenant
  using (org_id is null or org_id = (select app.current_org_id()));
grant select on public.ai_models to resuto_member, resuto_tenant;
alter table public.ai_evaluations enable row level security;
create policy ai_evaluations_read on public.ai_evaluations for select to resuto_member, resuto_tenant
  using (org_id is null or org_id = (select app.current_org_id()));
grant select on public.ai_evaluations to resuto_member, resuto_tenant;

select app.enable_tenant_rls('public.ai_predictions', 'branch_id');
select app.enable_tenant_rls('public.ai_insights', 'branch_id');
select app.enable_tenant_rls('public.assistant_threads');
select app.enable_tenant_rls('public.assistant_messages');
select app.enable_tenant_rls('public.mcp_clients');
-- key hashes are not readable by member sessions
revoke select on public.mcp_clients from resuto_member;
grant select (id, org_id, name, key_prefix, acting_role, branch_ids, allowed_tools, rate_limit_per_min, status, expires_at,
              last_used_at, created_by, created_at, revoked_at) on public.mcp_clients to resuto_member;
select app.enable_tenant_rls('public.mcp_approvals');
select app.enable_tenant_rls('public.mcp_tool_calls');

select app.lockdown_public_grants();
