-- INT-28 / FT-27: email and SMS through the restaurant's own provider (Resend, Twilio).
--
-- outbound_messages is the delivery queue: one row per recipient and logical message, written in the transaction
-- that decided to send (campaign chunk, staff notification), delivered after commit by the sender job with retries
-- and backoff, and updated by signed provider status webhooks. The address is sealed (SecretBox, aad
-- "outbound:<org>:<id>"); only a masked hint is readable. Statuses only move forward (see the API's STATUS_RANK).
create table public.outbound_messages (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  channel text not null check (channel in ('email', 'sms')),
  purpose text not null check (purpose in ('marketing', 'transactional', 'staff')),
  provider text not null check (provider in ('resend', 'twilio_sms')),
  connection_id uuid references public.integration_connections(id) on delete set null,
  sandbox boolean not null default false,
  customer_id uuid references public.customers(id) on delete set null,
  campaign_id uuid references public.campaigns(id) on delete set null,
  notification_id uuid references public.notifications(id) on delete set null,
  recipient_sealed text not null,
  recipient_hint text not null check (length(recipient_hint) <= 80),
  -- HMAC of the normalised address (unsubscribe matching without decrypting).
  address_hash text not null check (address_hash ~ '^[0-9a-f]{64}$'),
  subject text check (subject is null or length(subject) <= 250),
  body_text text not null check (length(body_text) between 1 and 5000),
  body_html text check (body_html is null or length(body_html) <= 100000),
  status text not null default 'queued' check (status in (
    'queued', 'deferred', 'sending', 'accepted', 'sent', 'delivered', 'failed', 'bounced', 'complained', 'undelivered', 'unknown')),
  attempts int not null default 0 check (attempts between 0 and 20),
  next_attempt_at timestamptz not null default now(),
  lease_until timestamptz,
  defer_reason text check (defer_reason is null or defer_reason in ('quiet_hours', 'retry', 'rate_limited')),
  last_error text check (last_error is null or length(last_error) <= 300),
  provider_message_id text check (provider_message_id is null or length(provider_message_id) <= 200),
  idempotency_key text not null check (length(idempotency_key) between 8 and 200),
  accepted_at timestamptz,
  delivered_at timestamptz,
  status_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, idempotency_key)
);
create index outbound_messages_due_idx on public.outbound_messages(next_attempt_at) where status in ('queued', 'deferred', 'sending');
create unique index outbound_messages_provider_id_idx on public.outbound_messages(org_id, provider, provider_message_id) where provider_message_id is not null;
create index outbound_messages_campaign_idx on public.outbound_messages(campaign_id) where campaign_id is not null;
create index outbound_messages_notification_idx on public.outbound_messages(notification_id) where notification_id is not null;
create index outbound_messages_org_idx on public.outbound_messages(org_id, created_at desc);
create trigger outbound_messages_updated before update on public.outbound_messages for each row execute function app.set_updated_at();
select app.enable_tenant_rls('public.outbound_messages');

-- Per-channel opt-outs (unsubscribe link, RFC 8058 one-click, STOP handled by the provider). Matched by address
-- hash so an opt-out also covers a re-created customer with the same address.
create table public.channel_unsubscribes (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  channel text not null check (channel in ('email', 'sms')),
  address_hash text not null check (address_hash ~ '^[0-9a-f]{64}$'),
  customer_id uuid references public.customers(id) on delete set null,
  source text not null check (source in ('link', 'one_click', 'provider_complaint', 'staff')),
  created_at timestamptz not null default now(),
  unique (org_id, channel, address_hash)
);
select app.enable_tenant_rls('public.channel_unsubscribes');

-- Quiet hours for marketing messages, in the organisation's time zone (null start = no quiet hours).
create table public.messaging_policies (
  org_id uuid primary key references public.organizations(id) on delete cascade,
  quiet_hours_start time default '22:00',
  quiet_hours_end time default '09:00',
  updated_at timestamptz not null default now(),
  check ((quiet_hours_start is null) = (quiet_hours_end is null))
);
create trigger messaging_policies_updated before update on public.messaging_policies for each row execute function app.set_updated_at();
select app.enable_tenant_rls('public.messaging_policies');

-- Campaign deliveries through email/SMS point at their queue row; opted-out recipients are recorded as such.
alter table public.campaign_deliveries add column outbound_id uuid references public.outbound_messages(id) on delete set null;
alter table public.campaign_deliveries drop constraint campaign_deliveries_status_check;
alter table public.campaign_deliveries add constraint campaign_deliveries_status_check
  check (status in ('queued', 'sent', 'delivered', 'read', 'failed', 'skipped_no_consent', 'skipped_unsubscribed'));

-- Staff notification email through the restaurant's Resend connection is queued first, then sent or failed.
alter table public.notification_deliveries drop constraint notification_deliveries_status_check;
alter table public.notification_deliveries add constraint notification_deliveries_status_check
  check (status in ('not_configured', 'queued', 'sent', 'delivered', 'failed', 'skipped'));

select app.lockdown_public_grants();

-- Reversal:
--   alter table public.notification_deliveries drop constraint notification_deliveries_status_check;
--   alter table public.notification_deliveries add constraint notification_deliveries_status_check check (status in ('not_configured', 'sent', 'failed', 'skipped'));
--   alter table public.campaign_deliveries drop constraint campaign_deliveries_status_check;
--   alter table public.campaign_deliveries add constraint campaign_deliveries_status_check check (status in ('queued', 'sent', 'delivered', 'read', 'failed', 'skipped_no_consent'));
--   alter table public.campaign_deliveries drop column outbound_id;
--   drop table public.messaging_policies; drop table public.channel_unsubscribes; drop table public.outbound_messages;
