-- Outbox, handler and job leases plus operations support (audit PCL-01, PS-10, PCL-13, PS-26).
--
-- * outbox_events.claim_token: a claim moves available_at forward (the lease) and stamps a token; only the holder of
--   the current token may publish the event or schedule its retry, so a stale worker cannot overwrite a newer claim.
-- * event_handlings 'running': a handler is recorded as running (with a lease) before it starts, so two workers can
--   never run the same handler for the same event at the same time; an expired lease (dead worker) is taken over.
-- * event_effects: consumers record a side effect (e.g. a customer message) in the same transaction that performs it,
--   so a retried delivery never repeats it.
-- * job_leases: scheduled jobs are claimed with a row lease instead of session advisory locks (works through the
--   Supabase transaction pooler, survives lost connections) and their cadence is shared by every process.
-- * job_runs 'abandoned': runs left 'running' by a dead process are closed by the maintenance job.
-- * request_id on outbox_events and audit_logs: the HTTP request (or worker run) that caused the event or the change
--   (PS-15). It defaults from the transaction setting app.request_id, which DbService sets for every transaction, so
--   every writer records it without code changes.
-- Reversible: drop the added columns/tables and restore the previous check constraints.

alter table public.outbox_events
  add column claim_token uuid,
  add column claimed_at timestamptz,
  add column request_id text default nullif(current_setting('app.request_id', true), '')
    check (request_id is null or length(request_id) <= 64);
create index outbox_published_idx on public.outbox_events(published_at) where published_at is not null;

alter table public.event_handlings drop constraint event_handlings_status_check;
alter table public.event_handlings add constraint event_handlings_status_check
  check (status in ('running', 'succeeded', 'failed', 'dead'));
alter table public.event_handlings
  add column claim_token uuid,
  add column started_at timestamptz,
  add column lease_until timestamptz;
create index event_handlings_attention_idx on public.event_handlings(status, updated_at desc) where status in ('running', 'failed', 'dead');

create table public.event_effects (
  event_id uuid not null references public.outbox_events(id) on delete cascade,
  handler text not null,
  effect text not null check (length(effect) between 1 and 120),
  org_id uuid references public.organizations(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (event_id, handler, effect)
);
select app.enable_tenant_rls('public.event_effects');

alter table public.job_runs drop constraint job_runs_status_check;
alter table public.job_runs add constraint job_runs_status_check
  check (status in ('running', 'succeeded', 'failed', 'abandoned'));
create index job_runs_started_idx on public.job_runs(started_at);
create index job_runs_running_idx on public.job_runs(started_at) where status = 'running';

create table public.job_leases (
  job text primary key,
  owner text,
  locked_until timestamptz not null default '-infinity',
  last_started_at timestamptz,
  last_finished_at timestamptz,
  last_status text check (last_status is null or last_status in ('succeeded', 'failed', 'timed_out')),
  run_id bigint
);
alter table public.job_leases enable row level security; -- worker (platform context) only

alter table public.audit_logs add column request_id text default nullif(current_setting('app.request_id', true), '')
  check (request_id is null or length(request_id) <= 64);

create index idempotency_keys_created_idx on public.idempotency_keys(created_at);
create index webhook_inbox_done_idx on public.webhook_inbox(received_at) where status in ('processed', 'ignored', 'rejected');

select app.lockdown_public_grants();
