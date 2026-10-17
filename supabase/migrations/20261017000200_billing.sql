-- Billing, plans, module entitlements and usage.
-- Prices are DATA (plan_prices rows editable by platform admins), never code.
-- Recurring collection needs a billing-provider integration; this schema
-- models the subscription lifecycle and entitlement decisions.

create table public.plans (
  id text primary key check (id ~ '^[a-z0-9_-]{2,40}$'),
  name text not null,
  name_ar text,
  description text,
  is_custom boolean not null default false,   -- "Build Your Resuto"
  is_public boolean not null default true,
  sort_order integer not null default 0,
  limits jsonb not null default '{}'::jsonb,    -- e.g. {"branches":1,"staff":2,"orders_per_month":300}
  created_at timestamptz not null default now()
);

create table public.plan_modules (
  plan_id text not null references public.plans(id) on delete cascade,
  module public.module_key not null,
  limits jsonb not null default '{}'::jsonb,
  primary key (plan_id, module)
);

create table public.plan_prices (
  id uuid primary key default gen_random_uuid(),
  plan_id text not null references public.plans(id) on delete cascade,
  country public.country_code not null,
  currency public.currency_code not null,
  billing_interval text not null check (billing_interval in ('month', 'year')),
  amount_minor bigint not null check (amount_minor >= 0),
  active boolean not null default true,
  valid_from timestamptz not null default now(),
  unique (plan_id, country, billing_interval, valid_from)
);

-- Per-module prices used by "Build Your Resuto" and add-ons.
create table public.module_prices (
  id uuid primary key default gen_random_uuid(),
  module public.module_key not null,
  country public.country_code not null,
  currency public.currency_code not null,
  billing_interval text not null check (billing_interval in ('month', 'year')),
  amount_minor bigint not null check (amount_minor >= 0),
  active boolean not null default true,
  valid_from timestamptz not null default now(),
  unique (module, country, billing_interval, valid_from)
);

create type public.subscription_status as enum ('trialing', 'active', 'past_due', 'unpaid', 'canceled', 'paused');

create table public.subscriptions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  plan_id text not null references public.plans(id),
  status public.subscription_status not null default 'trialing',
  billing_interval text not null default 'month' check (billing_interval in ('month', 'year')),
  country public.country_code not null,
  currency public.currency_code not null,
  current_period_start timestamptz not null default now(),
  current_period_end timestamptz not null,
  trial_ends_at timestamptz,
  grace_until timestamptz,
  cancel_at_period_end boolean not null default false,
  pending_plan_id text references public.plans(id),  -- scheduled downgrade
  provider text,             -- billing provider (null until one is connected)
  provider_subscription_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- exactly one live subscription per organization
create unique index subscriptions_one_live on public.subscriptions(org_id) where status <> 'canceled';
create trigger subscriptions_updated before update on public.subscriptions for each row execute function app.set_updated_at();

create table public.subscription_modules (
  subscription_id uuid not null references public.subscriptions(id) on delete cascade,
  org_id uuid not null references public.organizations(id) on delete cascade,
  module public.module_key not null,
  source text not null default 'addon' check (source in ('addon', 'custom_plan', 'grant')),
  created_at timestamptz not null default now(),
  primary key (subscription_id, module)
);

-- Explicit platform grants/overrides (e.g. competition demo, support credit).
create table public.entitlement_overrides (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  module public.module_key not null,
  enabled boolean not null,
  reason text not null,
  expires_at timestamptz,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);
create index entitlement_overrides_org_idx on public.entitlement_overrides(org_id, module);

create table public.subscription_events (
  id bigint generated always as identity primary key,
  org_id uuid not null references public.organizations(id) on delete cascade,
  subscription_id uuid references public.subscriptions(id) on delete cascade,
  event_type text not null,
  from_plan_id text,
  to_plan_id text,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

-- Platform invoices for Resuto's own subscription fees. External costs
-- (payment-provider fees, WhatsApp conversation fees, ad spend) are recorded
-- separately in usage_events with cost_owner='merchant' and never billed here.
create table public.platform_invoices (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  subscription_id uuid references public.subscriptions(id),
  number text not null unique,
  currency public.currency_code not null,
  subtotal_minor bigint not null check (subtotal_minor >= 0),
  tax_minor bigint not null default 0 check (tax_minor >= 0),
  total_minor bigint generated always as (subtotal_minor + tax_minor) stored,
  status text not null default 'draft' check (status in ('draft', 'open', 'paid', 'void', 'uncollectible')),
  period_start timestamptz not null,
  period_end timestamptz not null,
  lines jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);

create table public.usage_events (
  id bigint generated always as identity primary key,
  org_id uuid not null references public.organizations(id) on delete cascade,
  metric text not null,               -- orders, whatsapp_messages, ai_requests, mcp_calls, sms...
  quantity integer not null default 1 check (quantity > 0),
  cost_owner text not null default 'resuto' check (cost_owner in ('resuto', 'merchant')),
  external_cost_minor bigint check (external_cost_minor is null or external_cost_minor >= 0),
  currency public.currency_code,
  occurred_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb
);
create index usage_events_org_metric_idx on public.usage_events(org_id, metric, occurred_at);

-- Reference data is public-read through the API; tenant tables get RLS.
alter table public.plans enable row level security;
alter table public.plan_modules enable row level security;
alter table public.plan_prices enable row level security;
alter table public.module_prices enable row level security;
create policy plans_read on public.plans for select to resuto_member, resuto_tenant, authenticated using (true);
create policy plan_modules_read on public.plan_modules for select to resuto_member, resuto_tenant, authenticated using (true);
create policy plan_prices_read on public.plan_prices for select to resuto_member, resuto_tenant, authenticated using (true);
create policy module_prices_read on public.module_prices for select to resuto_member, resuto_tenant, authenticated using (true);
grant select on public.plans, public.plan_modules, public.plan_prices, public.module_prices to resuto_member, resuto_tenant, authenticated;

select app.enable_tenant_rls('public.subscriptions');
select app.enable_tenant_rls('public.subscription_modules');
select app.enable_tenant_rls('public.entitlement_overrides');
select app.enable_tenant_rls('public.subscription_events');
select app.enable_tenant_rls('public.platform_invoices');
select app.enable_tenant_rls('public.usage_events');

-- Entitlement decision used by both the API guard and SQL reporting.
create or replace function app.module_enabled(p_org uuid, p_module public.module_key, p_at timestamptz default now())
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  with ov as (
    select enabled from public.entitlement_overrides
     where org_id = p_org and module = p_module and (expires_at is null or expires_at > p_at)
     order by created_at desc limit 1),
  sub as (
    select s.* from public.subscriptions s where s.org_id = p_org and s.status <> 'canceled' limit 1),
  live as (
    select sub.* from sub
     where sub.status in ('trialing', 'active')
        or (sub.status = 'past_due' and sub.grace_until is not null and sub.grace_until > p_at))
  select coalesce(
    (select enabled from ov),
    exists (select 1 from live join public.plan_modules pm on pm.plan_id = live.plan_id and pm.module = p_module)
    or exists (select 1 from live join public.subscription_modules sm on sm.subscription_id = live.id and sm.module = p_module))
$$;
grant execute on function app.module_enabled(uuid, public.module_key, timestamptz) to resuto_member, resuto_tenant;

select app.lockdown_public_grants();
