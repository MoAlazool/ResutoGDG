-- FT-06: owner/staff notifications. Domain events (licence expiry, low stock, MCP approvals, invitations, payment
-- alerts) become in-app notifications addressed to everyone who holds a permission (optionally within a branch,
-- or one user). Read state is per user. External channels (email) go through a provider abstraction and every
-- attempt is recorded with its real outcome: 'not_configured' until a provider is set up, 'sent' only when the
-- provider accepted the message. Compliance reminders gain the status 'raised' (in-app notification created,
-- nothing sent externally) so the product never claims a reminder was "sent" when it was not.
--
-- Reversal: drop table public.notification_deliveries, public.notification_reads, public.notifications;
--   update compliance_reminders set status = 'sent' where status = 'raised'; restore the old status check.

create table public.notifications (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  branch_id uuid references public.branches(id) on delete cascade,
  -- Audience: members holding this permission (within branch_id when set), or exactly one user.
  audience_permission text,
  audience_user_id uuid references auth.users(id) on delete cascade,
  kind text not null check (kind in ('licence_expiring', 'stock_low', 'mcp_approval_requested', 'member_invited', 'payment_alert', 'payment_failed')),
  severity text not null default 'info' check (severity in ('info', 'warning', 'critical')),
  template_key text not null,
  params jsonb not null default '{}'::jsonb,
  entity_type text,
  entity_id text,
  link text check (link is null or link ~ '^/[A-Za-z0-9/_\-?=&.]*$'),
  -- One notification per source fact (event id, alert id, reminder id): redelivered events change nothing.
  dedupe_key text not null,
  created_at timestamptz not null default now(),
  check (audience_permission is not null or audience_user_id is not null)
);
create unique index notifications_dedupe_idx on public.notifications(org_id, dedupe_key);
create index notifications_org_created_idx on public.notifications(org_id, created_at desc);

create table public.notification_reads (
  notification_id uuid not null references public.notifications(id) on delete cascade,
  org_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  read_at timestamptz not null default now(),
  primary key (notification_id, user_id)
);
create index notification_reads_user_idx on public.notification_reads(user_id, org_id);

create table public.notification_deliveries (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  notification_id uuid not null references public.notifications(id) on delete cascade,
  channel text not null check (channel in ('email', 'whatsapp')),
  recipient_hint text,                     -- masked address for display (never the full address)
  provider text,
  status text not null check (status in ('not_configured', 'sent', 'failed', 'skipped')),
  error text,
  provider_message_id text,
  attempted_at timestamptz not null default now(),
  unique (notification_id, channel)
);

select app.enable_tenant_rls('public.notifications', 'branch_id');
select app.enable_tenant_rls('public.notification_reads');
select app.enable_tenant_rls('public.notification_deliveries');
-- Notifications are created by the worker; staff sessions only read them and mark them read.
revoke insert, update, delete on public.notifications from resuto_member;
revoke update, delete on public.notification_deliveries from resuto_member;
revoke insert on public.notification_deliveries from resuto_member;
select app.lockdown_public_grants();

alter table public.compliance_reminders drop constraint if exists compliance_reminders_status_check;
alter table public.compliance_reminders add constraint compliance_reminders_status_check
  check (status in ('scheduled', 'raised', 'sent', 'dismissed'));
-- Reminders marked 'sent' before this migration were never delivered anywhere (no notification consumer existed).
update public.compliance_reminders set status = 'raised' where status = 'sent';
