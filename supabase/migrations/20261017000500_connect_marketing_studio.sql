-- Resuto Connect (WhatsApp/inbox), Resuto Marketing and ResutoStudio.

-- ---------------------------------------------------------------------------
-- Connect
-- ---------------------------------------------------------------------------
create table public.messaging_channels (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  branch_id uuid references public.branches(id) on delete set null,
  kind text not null check (kind in ('whatsapp', 'instagram', 'messenger', 'sms', 'web_chat')),
  -- 'sandbox' transport stores and "delivers" messages locally; it never reaches Meta.
  transport text not null check (transport in ('meta_cloud', 'sandbox')),
  connection_id uuid references public.integration_connections(id) on delete set null,
  display_name text not null,
  display_phone text,
  phone_number_id text,              -- Meta Cloud API phone number id
  waba_id text,
  status text not null default 'sandbox' check (status in ('sandbox', 'pending', 'connected', 'error', 'disabled')),
  ordering_enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index messaging_channels_phone_idx on public.messaging_channels(phone_number_id) where phone_number_id is not null;
create trigger messaging_channels_updated before update on public.messaging_channels for each row execute function app.set_updated_at();

create table public.conversations (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  branch_id uuid references public.branches(id) on delete set null,
  channel_id uuid not null references public.messaging_channels(id) on delete cascade,
  customer_id uuid references public.customers(id) on delete set null,
  external_contact text not null,          -- wa_id / phone / handle
  contact_name text,
  status text not null default 'bot' check (status in ('bot', 'open', 'handoff', 'closed')),
  assigned_to uuid references auth.users(id),
  last_message_at timestamptz,
  last_inbound_at timestamptz,             -- WhatsApp 24h customer-service window
  unread_count integer not null default 0 check (unread_count >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (channel_id, external_contact)
);
create index conversations_org_last_idx on public.conversations(org_id, last_message_at desc);
create trigger conversations_updated before update on public.conversations for each row execute function app.set_updated_at();
alter table public.orders add constraint orders_conversation_fk foreign key (conversation_id) references public.conversations(id) on delete set null;

create table public.messages (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  direction text not null check (direction in ('inbound', 'outbound')),
  kind text not null check (kind in ('text', 'interactive', 'button_reply', 'list_reply', 'template', 'image', 'location', 'system', 'note')),
  body text,
  payload jsonb not null default '{}'::jsonb,
  provider_message_id text,
  status text not null default 'queued' check (status in ('received', 'queued', 'sent', 'delivered', 'read', 'failed')),
  error text,
  attempts integer not null default 0,
  next_attempt_at timestamptz,
  sent_by uuid references auth.users(id),
  is_automated boolean not null default false,
  created_at timestamptz not null default now()
);
create unique index messages_provider_idx on public.messages(provider_message_id) where provider_message_id is not null;
create index messages_conversation_idx on public.messages(conversation_id, created_at);
create index messages_retry_idx on public.messages(next_attempt_at) where status = 'queued';

-- Structured (OFB-style) ordering session. The server owns prices and totals;
-- nothing the customer types can change them.
create table public.ordering_sessions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  conversation_id uuid references public.conversations(id) on delete cascade,
  customer_id uuid references public.customers(id) on delete set null,
  branch_id uuid references public.branches(id),
  channel text not null default 'whatsapp' check (channel in ('whatsapp', 'web', 'instagram')),
  step text not null default 'start' check (step in ('start', 'branch', 'fulfillment', 'customer', 'address', 'menu', 'review', 'payment', 'awaiting_payment', 'completed', 'cancelled', 'expired')),
  state jsonb not null default '{}'::jsonb,   -- collected answers + cart of {product_id, qty, modifiers}
  token_hash text not null unique,            -- hosted ordering page credential
  order_id uuid references public.orders(id),
  checkout_session_id uuid references public.checkout_sessions(id),
  expires_at timestamptz not null,
  version integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index ordering_sessions_one_live on public.ordering_sessions(conversation_id)
  where step not in ('completed', 'cancelled', 'expired') and conversation_id is not null;
create trigger ordering_sessions_updated before update on public.ordering_sessions for each row execute function app.set_updated_at();

create table public.message_templates (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  name text not null check (name ~ '^[a-z0-9_]{1,512}$'),
  language text not null default 'en' check (language in ('en', 'ar')),
  category text not null check (category in ('utility', 'marketing', 'authentication')),
  body text not null check (length(body) <= 1024),
  variables text[] not null default '{}',
  buttons jsonb not null default '[]'::jsonb,
  provider_status text not null default 'draft' check (provider_status in ('draft', 'sandbox', 'submitted', 'approved', 'rejected', 'paused')),
  provider_template_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, name, language)
);
create trigger message_templates_updated before update on public.message_templates for each row execute function app.set_updated_at();

create table public.handoffs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  reason text not null,
  status text not null default 'requested' check (status in ('requested', 'accepted', 'resolved')),
  requested_at timestamptz not null default now(),
  accepted_by uuid references auth.users(id),
  accepted_at timestamptz,
  resolved_at timestamptz
);
create unique index handoffs_one_open on public.handoffs(conversation_id) where status <> 'resolved';

-- ---------------------------------------------------------------------------
-- Marketing
-- ---------------------------------------------------------------------------
create table public.segments (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  name text not null,
  description text,
  kind text not null default 'dynamic' check (kind in ('dynamic', 'static')),
  definition jsonb not null default '{}'::jsonb,  -- validated rule DSL (see packages/contracts marketing.ts)
  source text not null default 'manual' check (source in ('manual', 'ai', 'mcp', 'system')),
  member_count integer not null default 0,
  last_computed_at timestamptz,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, name)
);
create trigger segments_updated before update on public.segments for each row execute function app.set_updated_at();

create table public.segment_members (
  org_id uuid not null references public.organizations(id) on delete cascade,
  segment_id uuid not null references public.segments(id) on delete cascade,
  customer_id uuid not null references public.customers(id) on delete cascade,
  added_at timestamptz not null default now(),
  primary key (segment_id, customer_id)
);

create table public.promotions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  code citext,
  name text not null,
  name_ar text,
  kind text not null check (kind in ('percent', 'fixed', 'free_delivery')),
  value integer not null check (value >= 0),       -- basis points for percent, minor units for fixed
  max_discount_minor bigint,
  min_order_minor bigint not null default 0,
  branch_ids uuid[],
  channels public.order_channel[],
  starts_at timestamptz,
  ends_at timestamptz,
  max_redemptions integer,
  per_customer_limit integer,
  redemption_count integer not null default 0,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  check (kind <> 'percent' or value <= 10000),
  check (ends_at is null or starts_at is null or ends_at > starts_at)
);
create unique index promotions_code_idx on public.promotions(org_id, code) where code is not null;
alter table public.orders add constraint orders_promotion_fk foreign key (promotion_id) references public.promotions(id) on delete set null;

create table public.promotion_redemptions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  promotion_id uuid not null references public.promotions(id) on delete cascade,
  order_id uuid not null unique references public.orders(id) on delete cascade,
  customer_id uuid references public.customers(id) on delete set null,
  discount_minor bigint not null check (discount_minor >= 0),
  created_at timestamptz not null default now()
);

create type public.campaign_status as enum ('draft', 'pending_approval', 'approved', 'scheduled', 'sending', 'sent', 'cancelled', 'failed');

create table public.campaigns (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  name text not null,
  objective text not null default 'retention' check (objective in ('retention', 'reactivation', 'acquisition', 'upsell', 'awareness', 'reservations')),
  channel text not null check (channel in ('whatsapp', 'sms', 'email', 'meta_ads', 'tiktok_ads', 'snapchat_ads', 'organic')),
  status public.campaign_status not null default 'draft',
  segment_id uuid references public.segments(id) on delete set null,
  template_id uuid references public.message_templates(id) on delete set null,
  promotion_id uuid references public.promotions(id) on delete set null,
  content jsonb not null default '{}'::jsonb,
  utm_campaign text not null,
  budget_minor bigint check (budget_minor is null or budget_minor >= 0),
  currency public.currency_code,
  scheduled_at timestamptz,
  approved_by uuid references auth.users(id),
  approved_at timestamptz,
  sent_at timestamptz,
  is_sandbox boolean not null default true,
  source text not null default 'manual' check (source in ('manual', 'ai', 'mcp')),
  external_campaign_id text,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, utm_campaign)
);
create trigger campaigns_updated before update on public.campaigns for each row execute function app.set_updated_at();
alter table public.orders add constraint orders_campaign_fk foreign key (campaign_id) references public.campaigns(id) on delete set null;

create table public.campaign_deliveries (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  campaign_id uuid not null references public.campaigns(id) on delete cascade,
  customer_id uuid not null references public.customers(id) on delete cascade,
  message_id uuid references public.messages(id) on delete set null,
  status text not null default 'queued' check (status in ('queued', 'sent', 'delivered', 'read', 'failed', 'skipped_no_consent')),
  error text,
  sent_at timestamptz,
  unique (campaign_id, customer_id)
);

create table public.tracking_links (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  campaign_id uuid references public.campaigns(id) on delete cascade,
  code text not null unique check (code ~ '^[A-Za-z0-9_-]{6,32}$'),
  destination_path text not null check (destination_path like '/%'),
  utm jsonb not null default '{}'::jsonb,
  click_count integer not null default 0,
  created_at timestamptz not null default now()
);

create table public.attribution_events (
  id bigint generated always as identity primary key,
  org_id uuid not null references public.organizations(id) on delete cascade,
  kind text not null check (kind in ('link_click', 'page_view', 'add_to_cart', 'checkout_started', 'order_placed', 'order_paid', 'reservation_made', 'message_sent', 'message_read')),
  campaign_id uuid references public.campaigns(id) on delete set null,
  customer_id uuid references public.customers(id) on delete set null,
  order_id uuid references public.orders(id) on delete set null,
  session_key text,
  utm jsonb not null default '{}'::jsonb,
  value_minor bigint,
  occurred_at timestamptz not null default now()
);
create index attribution_events_campaign_idx on public.attribution_events(campaign_id, kind);
create index attribution_events_org_time_idx on public.attribution_events(org_id, occurred_at);

-- Imported ad-platform reporting. is_sandbox rows are fixtures from a sandbox
-- account/adapter and MUST be excluded from any "achieved" ROI reporting.
create table public.ad_campaign_reports (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  connection_id uuid references public.integration_connections(id) on delete cascade,
  campaign_id uuid references public.campaigns(id) on delete set null,
  provider text not null check (provider in ('meta_ads', 'tiktok_ads', 'snapchat_ads')),
  external_campaign_id text not null,
  report_date date not null,
  impressions bigint not null default 0,
  clicks bigint not null default 0,
  spend_minor bigint not null default 0,
  currency public.currency_code not null,
  conversions integer not null default 0,
  is_sandbox boolean not null,
  imported_at timestamptz not null default now(),
  unique (provider, external_campaign_id, report_date)
);

-- ---------------------------------------------------------------------------
-- Studio (restaurant websites)
-- ---------------------------------------------------------------------------
create table public.websites (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null unique references public.organizations(id) on delete cascade,
  template text not null default 'olive' check (template in ('olive', 'smash', 'minimal')),
  theme jsonb not null default '{}'::jsonb,       -- colors, fonts, logo media id
  seo jsonb not null default '{}'::jsonb,         -- title, description, og image (per locale)
  status text not null default 'draft' check (status in ('draft', 'published')),
  published_revision integer not null default 0,
  draft_revision integer not null default 0,
  published_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger websites_updated before update on public.websites for each row execute function app.set_updated_at();

create table public.website_sections (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  website_id uuid not null references public.websites(id) on delete cascade,
  kind text not null check (kind in ('hero', 'about', 'menu_highlights', 'gallery', 'reservations', 'ordering', 'location', 'hours', 'testimonials', 'contact', 'custom')),
  sort_order integer not null default 0,
  is_visible boolean not null default true,
  content jsonb not null default '{}'::jsonb,     -- per-locale copy, media ids
  updated_at timestamptz not null default now()
);
create index website_sections_site_idx on public.website_sections(website_id, sort_order);

create table public.custom_domains (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  website_id uuid not null references public.websites(id) on delete cascade,
  hostname citext not null unique check (hostname ~ '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$'),
  verification_token text not null,
  -- DNS verification is checked by Resuto; certificate issuance and routing at the
  -- hosting provider is a separate step ("active") that requires provider configuration.
  status text not null default 'pending_verification' check (status in ('pending_verification', 'verified', 'provisioning', 'active', 'failed', 'removed')),
  ssl_status text not null default 'pending' check (ssl_status in ('pending', 'issued', 'failed', 'not_applicable')),
  last_checked_at timestamptz,
  verified_at timestamptz,
  last_error text,
  created_at timestamptz not null default now()
);

create table public.creative_assets (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  kind text not null check (kind in ('caption', 'post', 'menu_description', 'campaign_copy', 'image', 'website_copy')),
  locale text not null default 'en' check (locale in ('en', 'ar')),
  prompt text not null,
  output jsonb not null,
  media_id uuid references public.media_assets(id) on delete set null,
  provider text not null,              -- 'gemini', 'template_rules' (deterministic fallback)
  model text,
  is_fallback boolean not null default false,
  status text not null default 'draft' check (status in ('draft', 'approved', 'rejected', 'used')),
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
select app.enable_tenant_rls('public.messaging_channels', 'branch_id');
select app.enable_tenant_rls('public.conversations', 'branch_id');
select app.enable_tenant_rls('public.messages');
select app.enable_tenant_rls('public.ordering_sessions', 'branch_id');
select app.enable_tenant_rls('public.message_templates');
select app.enable_tenant_rls('public.handoffs');
select app.enable_tenant_rls('public.segments');
select app.enable_tenant_rls('public.segment_members');
select app.enable_tenant_rls('public.promotions');
select app.enable_tenant_rls('public.promotion_redemptions');
select app.enable_tenant_rls('public.campaigns');
select app.enable_tenant_rls('public.campaign_deliveries');
select app.enable_tenant_rls('public.tracking_links');
select app.enable_tenant_rls('public.attribution_events');
select app.enable_tenant_rls('public.ad_campaign_reports');
select app.enable_tenant_rls('public.websites');
select app.enable_tenant_rls('public.website_sections');
select app.enable_tenant_rls('public.custom_domains');
select app.enable_tenant_rls('public.creative_assets');

select app.enable_realtime_read('public.conversations');
select app.enable_realtime_read('public.messages');

select app.lockdown_public_grants();
