-- Meta Pixel + Conversions API (INT-20).
--
-- meta_tracking_contexts: what the guest's browser agreed to share for ONE web order, written only after the guest
-- accepted the restaurant's ad-measurement prompt: Meta browser ids (_fbp / _fbc), the page URL, and the user agent and
-- IP address the API saw (Meta requires both for website events). Without a row nothing about that order is sent to
-- Meta. Rows are deleted 8 days after the order (Meta accepts server events up to 7 days old).
create table public.meta_tracking_contexts (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  order_id uuid not null references public.orders(id) on delete cascade,
  consent_version text not null check (consent_version ~ '^[a-z0-9.-]{1,20}$'),
  consented_at timestamptz not null default now(),
  fbp text check (fbp is null or fbp ~ '^fb\.[0-2]\.[0-9]{10,13}\.[0-9]{1,20}$'),
  fbc text check (fbc is null or (fbc ~ '^fb\.[0-2]\.[0-9]{10,13}\.[A-Za-z0-9_-]{8,}$' and length(fbc) <= 600)),
  client_ip text check (client_ip is null or client_ip ~ '^[0-9a-fA-F:.]{3,45}$'),
  client_user_agent text check (client_user_agent is null or length(client_user_agent) <= 500),
  event_source_url text check (event_source_url is null or (event_source_url ~ '^https?://' and length(event_source_url) <= 1000)),
  created_at timestamptz not null default now(),
  unique (order_id)
);
create index meta_tracking_contexts_created_idx on public.meta_tracking_contexts(created_at);

-- One row per (event name, event id): the server send is idempotent and retried through the outbox; the browser Pixel
-- uses the same event id so Meta deduplicates the pair. Raw customer identifiers are never stored here (summary only
-- lists which match keys were sent).
create table public.meta_capi_events (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  connection_id uuid references public.integration_connections(id) on delete set null,
  order_id uuid references public.orders(id) on delete set null,
  event_name text not null check (event_name ~ '^[A-Za-z]{2,40}$'),
  event_id text not null check (event_id ~ '^[A-Za-z0-9._:-]{1,100}$'),
  source text not null check (source in ('order', 'test')),
  status text not null default 'pending' check (status in ('pending', 'sent', 'failed', 'skipped')),
  skip_reason text check (skip_reason is null or skip_reason ~ '^[a-z_]{2,60}$'),
  test_mode boolean not null default false,
  summary jsonb not null default '{}'::jsonb,
  attempts integer not null default 0 check (attempts >= 0),
  events_received integer,
  fbtrace_id text check (fbtrace_id is null or length(fbtrace_id) <= 100),
  error text check (error is null or length(error) <= 500),
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, event_name, event_id)
);
create index meta_capi_events_org_created_idx on public.meta_capi_events(org_id, created_at desc);
create trigger meta_capi_events_updated before update on public.meta_capi_events for each row execute function app.set_updated_at();

select app.enable_tenant_rls('public.meta_tracking_contexts');
select app.enable_tenant_rls('public.meta_capi_events');
select app.lockdown_public_grants();

-- Reversal: drop table public.meta_capi_events; drop table public.meta_tracking_contexts;
