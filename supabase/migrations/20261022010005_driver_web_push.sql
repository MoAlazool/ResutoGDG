-- FT-22: Web Push for the driver PWA. A device's push subscription (endpoint + keys) is sealed (SecretBox, aad
-- "push:<org>:<device id>"); only a hash of the endpoint is readable. driver_push_events records every notification
-- per device with its true outcome and makes redelivered domain events no-ops (unique per device and event).
alter table public.driver_devices
  add column push_subscription_sealed text,
  add column push_endpoint_hash text check (push_endpoint_hash is null or push_endpoint_hash ~ '^[0-9a-f]{64}$'),
  add column push_subscribed_at timestamptz,
  add column push_last_success_at timestamptz,
  add column push_last_error text check (push_last_error is null or length(push_last_error) <= 200);

create table public.driver_push_events (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  driver_id uuid not null references public.drivers(id) on delete cascade,
  device_id uuid not null references public.driver_devices(id) on delete cascade,
  job_id uuid references public.delivery_jobs(id) on delete cascade,
  kind text not null check (kind in ('offer', 'assigned', 'cancelled', 'unassigned', 'test')),
  event_key text not null check (length(event_key) between 1 and 200),
  status text not null default 'pending' check (status in ('pending', 'accepted', 'gone', 'failed')),
  error text check (error is null or length(error) <= 200),
  created_at timestamptz not null default now(),
  sent_at timestamptz,
  unique (device_id, event_key)
);
create index driver_push_events_driver_idx on public.driver_push_events(driver_id, created_at desc);
select app.enable_tenant_rls('public.driver_push_events');
select app.lockdown_public_grants();

-- Reversal:
--   drop table public.driver_push_events;
--   alter table public.driver_devices drop column push_subscription_sealed, drop column push_endpoint_hash, drop column push_subscribed_at,
--     drop column push_last_success_at, drop column push_last_error;
