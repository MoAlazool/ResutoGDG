-- Outbox consumers: per-handler delivery records give exactly-once handler
-- effects on top of at-least-once event delivery.
create table public.event_handlings (
  event_id uuid not null references public.outbox_events(id) on delete cascade,
  handler text not null,
  status text not null check (status in ('succeeded', 'failed', 'dead')),
  attempts integer not null default 1,
  last_error text,
  next_attempt_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (event_id, handler)
);
create index event_handlings_retry_idx on public.event_handlings(next_attempt_at) where status = 'failed';
alter table public.event_handlings enable row level security;  -- worker (platform context) only

-- Scheduled job runs (single-runner via advisory locks; history for ops).
create table public.job_runs (
  id bigint generated always as identity primary key,
  job text not null,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  status text not null default 'running' check (status in ('running', 'succeeded', 'failed')),
  stats jsonb not null default '{}'::jsonb,
  error text
);
create index job_runs_job_idx on public.job_runs(job, started_at desc);
alter table public.job_runs enable row level security;

select app.lockdown_public_grants();
