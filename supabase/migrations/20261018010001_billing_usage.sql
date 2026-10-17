-- Agent A — billing: usage metering dedupe, scheduled plan changes, invoice
-- numbering and indexes for the subscription lifecycle job and admin console.

-- Usage rows produced by event handlers carry the id of what they meter
-- (e.g. the order id) so a redelivered event can never double count.
alter table public.usage_events add column source_ref text;
create unique index usage_events_source_ref_idx on public.usage_events(org_id, metric, source_ref) where source_ref is not null;

-- A downgrade (cheaper plan, fewer add-ons or month ← year) is scheduled for
-- the end of the current period: pending_plan_id (existing column) plus the
-- interval and add-on set that will apply then.
alter table public.subscriptions add column pending_interval text check (pending_interval is null or pending_interval in ('month', 'year'));
alter table public.subscriptions add column pending_addons public.module_key[];
alter table public.subscriptions add constraint subscriptions_pending_consistent
  check (pending_plan_id is not null or (pending_interval is null and pending_addons is null));

create index subscriptions_lifecycle_idx on public.subscriptions(status, current_period_end);
create index subscriptions_trial_idx on public.subscriptions(trial_ends_at) where status = 'trialing';
create index subscriptions_grace_idx on public.subscriptions(grace_until) where status = 'past_due';

-- Draft invoice numbers: RS-<yyyymm>-<seq>. Invoices are drafts until a billing
-- provider integration collects them; nothing in Resuto marks them paid.
create sequence public.platform_invoice_number_seq;
grant usage on sequence public.platform_invoice_number_seq to resuto_member, resuto_tenant;
create unique index platform_invoices_period_idx on public.platform_invoices(subscription_id, period_start)
  where status <> 'void';

-- Platform admin console: tenant search and recency.
create index organizations_name_trgm on public.organizations using gin (name gin_trgm_ops);
create index organizations_created_idx on public.organizations(created_at desc, id desc);

select app.lockdown_public_grants();
