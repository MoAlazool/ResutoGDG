-- Sales inquiries from the public /pricing page (audit VP-09: the legacy "Let’s shape your setup." form posted to
-- /api/sales-inquiry and saved to the manager inbox). Platform data, not tenant data: written by the public endpoint
-- and read by platform admins through the API in platform mode. RLS is on with no policies, and neither the API's
-- tenant/member roles nor direct Supabase clients get any privilege, so the table is reachable only through the API.
-- No IP address or user agent is stored; abuse is damped by the API's rate limits and a per-email daily cap.
-- Down: drop table public.sales_inquiries;

create table public.sales_inquiries (
  id uuid primary key default gen_random_uuid(),
  restaurant text not null check (length(restaurant) between 1 and 120),
  email text not null check (length(email) between 3 and 200),
  branches integer not null check (branches between 1 and 500),
  requirements text not null check (length(requirements) between 1 and 1000),
  plan_id text check (plan_id ~ '^[a-z0-9_-]{2,40}$'),
  locale text check (locale in ('en', 'ar')),
  idempotency_key text not null unique check (length(idempotency_key) between 8 and 200),
  status text not null default 'new' check (status in ('new', 'contacted', 'closed')),
  created_at timestamptz not null default now()
);
create index sales_inquiries_created_idx on public.sales_inquiries (created_at desc);
create index sales_inquiries_email_idx on public.sales_inquiries (lower(email), created_at desc);

alter table public.sales_inquiries enable row level security; -- no policies: platform-only
revoke all on public.sales_inquiries from resuto_member, resuto_tenant;

select app.lockdown_public_grants();
