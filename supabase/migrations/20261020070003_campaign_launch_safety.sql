-- Ad campaign launch safety (INT-14 / PS-14).
--
-- Launch is two-phase: under the campaign's row lock the API moves it to 'launching' with a launch attempt (id, short
-- token that is also written into the provider-side campaign name, chosen connection, Idempotency-Key) and commits;
-- only then is the provider called; the result is applied only to that attempt. Concurrent launches and client
-- retries therefore cannot create two external campaigns, and an interrupted attempt is recoverable by its token.
alter type public.campaign_status add value if not exists 'launching';

alter table public.campaigns add column launch_attempt_id uuid;
alter table public.campaigns add column launch_token text check (launch_token is null or launch_token ~ '^[a-z0-9]{6,16}$');
alter table public.campaigns add column launch_started_at timestamptz;
alter table public.campaigns add column launch_connection_id uuid references public.integration_connections(id) on delete set null;
alter table public.campaigns add column launch_mode text check (launch_mode is null or launch_mode in ('live', 'sandbox'));
alter table public.campaigns add column launch_idempotency_key text check (launch_idempotency_key is null or length(launch_idempotency_key) between 8 and 200);
alter table public.campaigns add column launch_error text check (launch_error is null or length(launch_error) <= 500);
create index campaigns_launching_idx on public.campaigns(launch_started_at) where launch_attempt_id is not null;

select app.lockdown_public_grants();

-- Reversal (the enum value stays): drop index campaigns_launching_idx;
--   alter table campaigns drop column launch_attempt_id, drop column launch_token, drop column launch_started_at,
--     drop column launch_connection_id, drop column launch_mode, drop column launch_idempotency_key, drop column launch_error;
