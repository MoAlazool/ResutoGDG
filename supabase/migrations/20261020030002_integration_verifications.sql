-- Provider acceptance results (INT-15, INT-16): one row per executed acceptance
-- check (provider × capability × environment), written by
-- scripts/providers/record-acceptance.mjs from a scripts/providers/acceptance.mjs
-- report. Platform-level facts about Resuto's integration code (no tenant data);
-- the readiness shown in the integrations catalog is computed from them. Member
-- and direct Supabase sessions cannot read or write them.
create table public.integration_verifications (
  id uuid primary key default gen_random_uuid(),
  provider text not null check (provider ~ '^[a-z0-9_]{2,40}$'),
  capability text not null check (length(capability) between 1 and 60),
  check_id text not null check (length(check_id) between 1 and 120),
  environment text not null check (environment in ('official_test', 'live')),
  status text not null check (status in ('passed', 'failed', 'not_run', 'blocked')),
  reason text check (length(reason) <= 500),
  commit_sha text check (commit_sha ~ '^[0-9a-f]{7,40}$'),
  -- Redacted observations only (ids, statuses, HTTP codes); the runner never records credential values.
  evidence jsonb not null default '[]'::jsonb,
  ran_at timestamptz not null,
  recorded_at timestamptz not null default now(),
  unique (check_id, environment, ran_at)
);
create index integration_verifications_lookup_idx on public.integration_verifications(provider, capability, environment, ran_at desc);
alter table public.integration_verifications enable row level security;
revoke all on public.integration_verifications from resuto_member;

select app.lockdown_public_grants();

-- Reversal: drop table public.integration_verifications;
